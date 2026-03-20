import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SyncService } from '../../src/sync/sync.service';
import { SyncLog } from '../../src/sync/sync-log.entity';
import { LeaveBalance } from '../../src/balance/leave-balance.entity';
import { TimeOffRequest } from '../../src/request/time-off-request.entity';
import { BalanceService } from '../../src/balance/balance.service';
import { HcmService } from '../../src/hcm/hcm.service';
import { BatchSyncRecordDto } from '../../src/common/dto/batch-sync-record.dto';

function makeBalance(overrides: Partial<LeaveBalance> = {}): LeaveBalance {
  const b = new LeaveBalance();
  b.id = 'bal-1';
  b.employeeId = 'emp001';
  b.locationId = 'loc001';
  b.availableDays = 10;
  b.pendingDays = 0;
  b.version = 1;
  b.lastHcmSyncAt = null as any;
  b.createdAt = new Date();
  b.updatedAt = new Date();
  return Object.assign(b, overrides);
}

function makePendingRequest(createdAt: Date, daysRequested = 8): TimeOffRequest {
  const r = new TimeOffRequest();
  r.id = 'req-1';
  r.employeeId = 'emp001';
  r.locationId = 'loc001';
  r.startDate = '2025-06-01';
  r.endDate = '2025-06-08';
  r.daysRequested = daysRequested;
  r.status = 'PENDING';
  r.retryCount = 0;
  r.createdAt = createdAt;
  r.updatedAt = createdAt;
  r.hcmTransactionId = null;
  r.idempotencyKey = null as any;
  r.nextRetryAt = null as any;
  return r;
}

function makeSyncRecord(overrides: Partial<BatchSyncRecordDto> = {}): BatchSyncRecordDto {
  return Object.assign(
    {
      employeeId: 'emp001',
      locationId: 'loc001',
      availableDays: 10,
      syncTimestamp: new Date().toISOString(),
    } as BatchSyncRecordDto,
    overrides,
  );
}

describe('SyncService', () => {
  let service: SyncService;
  let syncLogRepo: jest.Mocked<any>;
  let requestRepo: jest.Mocked<any>;
  let balanceRepo: jest.Mocked<any>;
  let balanceService: jest.Mocked<BalanceService>;
  let hcmService: jest.Mocked<HcmService>;
  let dataSource: jest.Mocked<any>;

  function makeQueryRunner() {
    return {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager: {
        findOne: jest.fn().mockResolvedValue(null),
        save: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockImplementation((_e: any, d: any) => d),
      },
    };
  }

  beforeEach(async () => {
    syncLogRepo = { create: jest.fn().mockImplementation((d: any) => d), save: jest.fn().mockResolvedValue({}) };
    requestRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockResolvedValue({}),
      createQueryBuilder: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      }),
    };
    balanceRepo = { findOne: jest.fn().mockResolvedValue(null), save: jest.fn().mockResolvedValue({}) };
    balanceService = {
      reconcile: jest.fn().mockResolvedValue(undefined),
      upsertFromHcm: jest.fn().mockResolvedValue({ updated: true }),
      deductPending: jest.fn(),
      getBalance: jest.fn(),
    } as any;
    hcmService = {
      getBalance: jest.fn().mockResolvedValue(12),
      submitRequest: jest.fn(),
    } as any;
    dataSource = { createQueryRunner: jest.fn().mockReturnValue(makeQueryRunner()) };

    const module = await Test.createTestingModule({
      providers: [
        SyncService,
        { provide: getRepositoryToken(SyncLog), useValue: syncLogRepo },
        { provide: getRepositoryToken(TimeOffRequest), useValue: requestRepo },
        { provide: getRepositoryToken(LeaveBalance), useValue: balanceRepo },
        { provide: BalanceService, useValue: balanceService },
        { provide: HcmService, useValue: hcmService },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get(SyncService);
  });

  // T-U-27
  it('batchSync calls upsertFromHcm (via transaction) for every record', async () => {
    const qr = makeQueryRunner();
    dataSource.createQueryRunner.mockReturnValue(qr);
    const balance = makeBalance({ lastHcmSyncAt: null as any });
    qr.manager.findOne.mockResolvedValue(null);

    const records = [makeSyncRecord(), makeSyncRecord({ employeeId: 'emp002', locationId: 'loc001' })];
    await service.batchSync(records);

    // Each record should trigger a findOne inside the transaction
    expect(qr.manager.findOne).toHaveBeenCalledTimes(2);
    expect(qr.manager.save).toHaveBeenCalledTimes(2);
  });

  // T-U-28
  it('batchSync throws BadRequestException for record with availableDays < 0; no records written', async () => {
    const records = [makeSyncRecord({ availableDays: -1 })];
    await expect(service.batchSync(records)).rejects.toThrow(BadRequestException);
    // QueryRunner should not even be created before validation passes
    expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
  });

  // T-U-29
  it('batchSync cancels PENDING requests with createdAt <= syncTimestamp when balance becomes insufficient', async () => {
    const syncTs = new Date('2025-01-01T10:00:00Z');
    const reqCreatedAt = new Date('2025-01-01T09:00:00Z');
    const pendingReq = makePendingRequest(reqCreatedAt, 8);

    const qr = makeQueryRunner();
    const balance = makeBalance({ lastHcmSyncAt: null as any });
    qr.manager.findOne.mockResolvedValue(null);
    dataSource.createQueryRunner.mockReturnValue(qr);

    // After sync, balance is now 3 — insufficient for the 8-day request
    balanceRepo.findOne.mockResolvedValue(makeBalance({ availableDays: 3 }));
    requestRepo.createQueryBuilder.mockReturnValue({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([pendingReq]),
    });

    const record = makeSyncRecord({ availableDays: 3, syncTimestamp: syncTs.toISOString() });
    const result = await service.batchSync([record]);

    expect(requestRepo.save).toHaveBeenCalledWith(expect.objectContaining({ status: 'CANCELLED' }));
    expect(balanceService.reconcile).toHaveBeenCalledWith('emp001', 'loc001', 8, 'REJECTED');
    expect(result.autoCancelled).toBe(1);
  });

  // T-U-30
  it('batchSync does NOT cancel PENDING requests with createdAt > syncTimestamp', async () => {
    const syncTs = new Date('2025-01-01T10:00:00Z');
    const reqCreatedAt = new Date('2025-01-01T11:00:00Z'); // after syncTimestamp

    const qr = makeQueryRunner();
    qr.manager.findOne.mockResolvedValue(null);
    dataSource.createQueryRunner.mockReturnValue(qr);

    balanceRepo.findOne.mockResolvedValue(makeBalance({ availableDays: 3 }));
    // queryBuilder returns NO requests because createdAt > syncTimestamp filter excludes them
    requestRepo.createQueryBuilder.mockReturnValue({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    });

    const record = makeSyncRecord({ availableDays: 3, syncTimestamp: syncTs.toISOString() });
    const result = await service.batchSync([record]);

    expect(result.autoCancelled).toBe(0);
    expect(balanceService.reconcile).not.toHaveBeenCalled();
  });

  // T-U-31
  it('batchSync writes a SyncLog entry with type BATCH and correct recordsAffected', async () => {
    const qr = makeQueryRunner();
    qr.manager.findOne.mockResolvedValue(null);
    dataSource.createQueryRunner.mockReturnValue(qr);
    balanceRepo.findOne.mockResolvedValue(makeBalance());

    await service.batchSync([makeSyncRecord()]);

    const logCreated = syncLogRepo.create.mock.calls[0][0];
    expect(logCreated.type).toBe('BATCH');
    expect(logCreated.recordsAffected).toBe(1);
  });

  // T-U-32
  it('refreshOne calls HcmService.getBalance and calls upsertFromHcm with the returned value', async () => {
    hcmService.getBalance.mockResolvedValue(20);
    balanceRepo.findOne.mockResolvedValue(makeBalance({ availableDays: 20 }));
    await service.refreshOne('emp001', 'loc001');
    expect(hcmService.getBalance).toHaveBeenCalledWith('emp001', 'loc001');
    expect(balanceService.upsertFromHcm).toHaveBeenCalledWith(
      'emp001',
      'loc001',
      20,
      expect.any(Date),
    );
  });

  // T-U-33
  it('refreshOne writes a SyncLog entry with type REAL_TIME', async () => {
    balanceRepo.findOne.mockResolvedValue(makeBalance());
    await service.refreshOne('emp001', 'loc001');
    const logCreated = syncLogRepo.create.mock.calls[0][0];
    expect(logCreated.type).toBe('REAL_TIME');
  });

  // T-U-34
  it('reEnqueuePendingHcmConfirmations immediately REJECTs requests with retryCount >= 5', async () => {
    const req = makePendingRequest(new Date(), 3);
    req.status = 'PENDING_HCM_CONFIRMATION';
    req.retryCount = 5;
    req.updatedAt = new Date();
    requestRepo.find.mockResolvedValue([req]);

    await service.reEnqueuePendingHcmConfirmations();

    expect(requestRepo.save).toHaveBeenCalledWith(expect.objectContaining({ status: 'REJECTED' }));
    expect(balanceService.reconcile).toHaveBeenCalledWith('emp001', 'loc001', 3, 'REJECTED');
  });

  // T-U-35
  it('reEnqueuePendingHcmConfirmations re-enqueues requests with retryCount < 5 using setTimeout', async () => {
    jest.useFakeTimers();
    const req = makePendingRequest(new Date(), 3);
    req.status = 'PENDING_HCM_CONFIRMATION';
    req.retryCount = 0;
    req.updatedAt = new Date(Date.now() - 70_000); // 70 seconds ago — past the 1-min backoff
    requestRepo.find.mockResolvedValue([req]);

    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    await service.reEnqueuePendingHcmConfirmations();

    expect(setTimeoutSpy).toHaveBeenCalled();
    jest.useRealTimers();
    setTimeoutSpy.mockRestore();
  });

  // T-U-S01: onModuleInit calls reEnqueuePendingHcmConfirmations
  it('onModuleInit calls reEnqueuePendingHcmConfirmations (no pending requests — no-op)', async () => {
    requestRepo.find.mockResolvedValue([]);
    await (service as any).onModuleInit();
    expect(requestRepo.find).toHaveBeenCalledWith({ where: { status: 'PENDING_HCM_CONFIRMATION' } });
  });

  // T-U-S02: batchSync error path writes ERROR SyncLog and rethrows
  it('batchSync rolls back and writes ERROR SyncLog when transaction commit throws', async () => {
    const qr = makeQueryRunner();
    qr.commitTransaction.mockRejectedValue(new Error('DB error'));
    dataSource.createQueryRunner.mockReturnValue(qr);

    await expect(service.batchSync([makeSyncRecord()])).rejects.toThrow('DB error');
    expect(qr.rollbackTransaction).toHaveBeenCalled();
    const logCreated = syncLogRepo.create.mock.calls[0][0];
    expect(logCreated.status).toBe('ERROR');
  });

  // T-U-S03: batchSync auto-cancel else branch (request fits — not cancelled)
  it('batchSync does NOT cancel PENDING request when runningAvailable >= daysRequested', async () => {
    const qr = makeQueryRunner();
    qr.manager.findOne.mockResolvedValue(null);
    dataSource.createQueryRunner.mockReturnValue(qr);

    const pendingReq = makePendingRequest(new Date('2025-01-01T09:00:00Z'), 3);
    balanceRepo.findOne.mockResolvedValue(makeBalance({ availableDays: 10 }));
    requestRepo.createQueryBuilder.mockReturnValue({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([pendingReq]),
    });

    const record = makeSyncRecord({ availableDays: 10, syncTimestamp: new Date('2025-01-01T10:00:00Z').toISOString() });
    const result = await service.batchSync([record]);

    expect(result.autoCancelled).toBe(0);
    expect(requestRepo.save).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'CANCELLED' }));
  });

  // T-U-S04: retryHcmSubmission — HCM approves → APPROVED + reconcile CONFIRMED
  it('retryHcmSubmission: HCM approves → status APPROVED and reconcile CONFIRMED called', async () => {
    const req = makePendingRequest(new Date(), 3);
    req.id = 'req-retry-1';
    req.status = 'PENDING_HCM_CONFIRMATION';
    req.retryCount = 0;
    req.updatedAt = new Date(Date.now() - 70_000);
    requestRepo.find.mockResolvedValue([req]);
    requestRepo.findOne.mockResolvedValue({ ...req });
    hcmService.submitRequest.mockResolvedValue({ transactionId: 'txn-1', approved: true });

    let capturedCallback: (() => Promise<void>) | undefined;
    const spy = jest.spyOn(global, 'setTimeout').mockImplementation((cb: any) => { capturedCallback = cb; return 0 as any; });

    await service.reEnqueuePendingHcmConfirmations();
    await capturedCallback!();

    expect(requestRepo.save).toHaveBeenCalledWith(expect.objectContaining({ status: 'APPROVED' }));
    expect(balanceService.reconcile).toHaveBeenCalledWith('emp001', 'loc001', 3, 'CONFIRMED');
    spy.mockRestore();
  });

  // T-U-S05: retryHcmSubmission — HCM rejects → REJECTED + reconcile REJECTED
  it('retryHcmSubmission: HCM rejects → status REJECTED and reconcile REJECTED called', async () => {
    const req = makePendingRequest(new Date(), 3);
    req.id = 'req-retry-2';
    req.status = 'PENDING_HCM_CONFIRMATION';
    req.retryCount = 0;
    req.updatedAt = new Date(Date.now() - 70_000);
    requestRepo.find.mockResolvedValue([req]);
    requestRepo.findOne.mockResolvedValue({ ...req });
    hcmService.submitRequest.mockResolvedValue({ transactionId: null, approved: false });

    let capturedCallback: (() => Promise<void>) | undefined;
    const spy = jest.spyOn(global, 'setTimeout').mockImplementation((cb: any) => { capturedCallback = cb; return 0 as any; });

    await service.reEnqueuePendingHcmConfirmations();
    await capturedCallback!();

    expect(requestRepo.save).toHaveBeenCalledWith(expect.objectContaining({ status: 'REJECTED' }));
    expect(balanceService.reconcile).toHaveBeenCalledWith('emp001', 'loc001', 3, 'REJECTED');
    spy.mockRestore();
  });

  // T-U-S06: retryHcmSubmission — HCM throws, retryCount < 4 → retryCount++ and re-scheduled
  it('retryHcmSubmission: HCM throws → retryCount incremented and re-scheduled via setTimeout', async () => {
    const req = makePendingRequest(new Date(), 3);
    req.id = 'req-retry-3';
    req.status = 'PENDING_HCM_CONFIRMATION';
    req.retryCount = 1;
    req.updatedAt = new Date(Date.now() - 70_000);
    requestRepo.find.mockResolvedValue([req]);
    requestRepo.findOne.mockResolvedValue({ ...req });
    hcmService.submitRequest.mockRejectedValue(new Error('HCM down'));

    const timeouts: Array<() => Promise<void>> = [];
    const spy = jest.spyOn(global, 'setTimeout').mockImplementation((cb: any) => { timeouts.push(cb); return 0 as any; });

    await service.reEnqueuePendingHcmConfirmations();
    await timeouts[0]!(); // run retryHcmSubmission

    expect(requestRepo.save).toHaveBeenCalledWith(expect.objectContaining({ retryCount: 2 }));
    expect(timeouts.length).toBe(2); // second setTimeout was scheduled
    spy.mockRestore();
  });

  // T-U-S07: retryHcmSubmission — HCM throws and retryCount hits 5 → REJECTED immediately
  it('retryHcmSubmission: HCM throws and retryCount reaches 5 → request REJECTED, no further retry', async () => {
    const req = makePendingRequest(new Date(), 3);
    req.id = 'req-retry-4';
    req.status = 'PENDING_HCM_CONFIRMATION';
    req.retryCount = 4;
    req.updatedAt = new Date(Date.now() - 70_000);
    requestRepo.find.mockResolvedValue([req]);
    requestRepo.findOne.mockResolvedValue({ ...req });
    hcmService.submitRequest.mockRejectedValue(new Error('HCM down'));

    const timeouts: Array<() => Promise<void>> = [];
    const spy = jest.spyOn(global, 'setTimeout').mockImplementation((cb: any) => { timeouts.push(cb); return 0 as any; });

    await service.reEnqueuePendingHcmConfirmations();
    await timeouts[0]!(); // run retryHcmSubmission

    expect(requestRepo.save).toHaveBeenCalledWith(expect.objectContaining({ status: 'REJECTED' }));
    expect(balanceService.reconcile).toHaveBeenCalledWith('emp001', 'loc001', 3, 'REJECTED');
    expect(timeouts.length).toBe(1); // no second setTimeout scheduled
    spy.mockRestore();
  });
});
