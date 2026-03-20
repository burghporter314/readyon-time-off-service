import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { SyncService } from '../../src/sync/sync.service';
import { BalanceService } from '../../src/balance/balance.service';
import { HcmService } from '../../src/hcm/hcm.service';
import { LeaveBalance } from '../../src/balance/leave-balance.entity';
import { TimeOffRequest } from '../../src/request/time-off-request.entity';
import { SyncLog } from '../../src/sync/sync-log.entity';

describe('SyncService integration', () => {
  let module: TestingModule;
  let syncService: SyncService;
  let balanceService: BalanceService;
  let hcmService: jest.Mocked<HcmService>;
  let balanceRepo: Repository<LeaveBalance>;
  let requestRepo: Repository<TimeOffRequest>;
  let syncLogRepo: Repository<SyncLog>;

  beforeAll(async () => {
    hcmService = {
      getBalance: jest.fn().mockResolvedValue(20),
      submitRequest: jest.fn().mockResolvedValue({ transactionId: 'txn-1', approved: true }),
    } as any;

    module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          entities: [LeaveBalance, TimeOffRequest, SyncLog],
          synchronize: true,
          dropSchema: true,
        }),
        TypeOrmModule.forFeature([LeaveBalance, TimeOffRequest, SyncLog]),
      ],
      providers: [
        SyncService,
        BalanceService,
        { provide: HcmService, useValue: hcmService },
      ],
    }).compile();

    syncService = module.get(SyncService);
    balanceService = module.get(BalanceService);
    balanceRepo = module.get(getRepositoryToken(LeaveBalance));
    requestRepo = module.get(getRepositoryToken(TimeOffRequest));
    syncLogRepo = module.get(getRepositoryToken(SyncLog));
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await requestRepo.query('DELETE FROM time_off_request');
    await syncLogRepo.query('DELETE FROM sync_log');
    await balanceRepo.query('DELETE FROM leave_balance');
    await balanceRepo.save(
      balanceRepo.create({ employeeId: 'emp001', locationId: 'loc001', availableDays: 10, pendingDays: 0 }),
    );
  });

  // T-I-10
  it('batchSync with newer syncTimestamp overwrites availableDays and updates lastHcmSyncAt', async () => {
    const ts = new Date('2025-06-01T00:00:00Z').toISOString();
    await syncService.batchSync([{ employeeId: 'emp001', locationId: 'loc001', availableDays: 20, syncTimestamp: ts }]);
    const balance = await balanceRepo.findOne({ where: { employeeId: 'emp001', locationId: 'loc001' } });
    expect(Number(balance!.availableDays)).toBe(20);
    expect(balance!.lastHcmSyncAt).toBeTruthy();
  });

  // T-I-11
  it('batchSync with older syncTimestamp does not update balance', async () => {
    // First sync sets lastHcmSyncAt to Jan 2
    await syncService.batchSync([{ employeeId: 'emp001', locationId: 'loc001', availableDays: 20, syncTimestamp: '2025-01-02T00:00:00.000Z' }]);
    // Second sync with Jan 1 (stale) should not update
    await syncService.batchSync([{ employeeId: 'emp001', locationId: 'loc001', availableDays: 5, syncTimestamp: '2025-01-01T00:00:00.000Z' }]);
    const balance = await balanceRepo.findOne({ where: { employeeId: 'emp001', locationId: 'loc001' } });
    expect(Number(balance!.availableDays)).toBe(20);
  });

  // T-I-12
  it('batchSync with mix of fresh and stale records: only fresh updated; skipped count correct', async () => {
    await balanceRepo.save(
      balanceRepo.create({ employeeId: 'emp002', locationId: 'loc001', availableDays: 5, pendingDays: 0 }),
    );
    // Set emp002 lastHcmSyncAt to Jan 2
    await syncService.batchSync([{ employeeId: 'emp002', locationId: 'loc001', availableDays: 5, syncTimestamp: '2025-01-02T00:00:00.000Z' }]);

    const result = await syncService.batchSync([
      { employeeId: 'emp001', locationId: 'loc001', availableDays: 15, syncTimestamp: '2025-06-01T00:00:00.000Z' }, // fresh
      { employeeId: 'emp002', locationId: 'loc001', availableDays: 99, syncTimestamp: '2025-01-01T00:00:00.000Z' }, // stale
    ]);

    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(1);
    const emp001 = await balanceRepo.findOne({ where: { employeeId: 'emp001', locationId: 'loc001' } });
    expect(Number(emp001!.availableDays)).toBe(15);
    const emp002 = await balanceRepo.findOne({ where: { employeeId: 'emp002', locationId: 'loc001' } });
    expect(Number(emp002!.availableDays)).toBe(5); // unchanged
  });

  // T-I-13
  it('batchSync auto-cancels PENDING request with createdAt <= syncTimestamp when balance is insufficient', async () => {
    // Create request NOW, then use a syncTimestamp slightly in the future so createdAt <= syncTimestamp
    const req = requestRepo.create({
      employeeId: 'emp001',
      locationId: 'loc001',
      startDate: '2025-06-01',
      endDate: '2025-06-08',
      daysRequested: 8,
      status: 'PENDING',
      retryCount: 0,
    });
    const saved = await requestRepo.save(req);

    // syncTimestamp is 10 seconds in the future — so createdAt (now) <= syncTimestamp
    const syncTs = new Date(Date.now() + 10_000).toISOString();
    await syncService.batchSync([{ employeeId: 'emp001', locationId: 'loc001', availableDays: 3, syncTimestamp: syncTs }]);

    const updated = await requestRepo.findOne({ where: { id: saved.id } });
    expect(updated!.status).toBe('CANCELLED');
    const balance = await balanceRepo.findOne({ where: { employeeId: 'emp001', locationId: 'loc001' } });
    expect(Number(balance!.availableDays)).toBeGreaterThanOrEqual(0);
  });

  // T-I-14
  it('batchSync does NOT auto-cancel PENDING request with createdAt > syncTimestamp', async () => {
    // syncTimestamp is 10 seconds in the PAST — so createdAt (now) > syncTimestamp
    const syncTs = new Date(Date.now() - 10_000).toISOString();
    const req = requestRepo.create({
      employeeId: 'emp001',
      locationId: 'loc001',
      startDate: '2025-06-01',
      endDate: '2025-06-08',
      daysRequested: 8,
      status: 'PENDING',
      retryCount: 0,
    });
    const saved = await requestRepo.save(req);

    await syncService.batchSync([{ employeeId: 'emp001', locationId: 'loc001', availableDays: 3, syncTimestamp: syncTs }]);

    const updated = await requestRepo.findOne({ where: { id: saved.id } });
    expect(updated!.status).toBe('PENDING');
  });

  // T-I-15
  it('batchSync with availableDays = -1: BadRequestException; zero records updated', async () => {
    await expect(
      syncService.batchSync([{ employeeId: 'emp001', locationId: 'loc001', availableDays: -1, syncTimestamp: new Date().toISOString() }]),
    ).rejects.toThrow(BadRequestException);
    const balance = await balanceRepo.findOne({ where: { employeeId: 'emp001', locationId: 'loc001' } });
    expect(Number(balance!.availableDays)).toBe(10); // unchanged
  });

  // T-I-16
  it('batchSync with empty records returns { updated:0, autoCancelled:0, skipped:0 }', async () => {
    const result = await syncService.batchSync([]);
    expect(result).toEqual({ updated: 0, autoCancelled: 0, skipped: 0 });
  });

  // T-I-17
  it('refreshOne updates local balance to match mocked HCM value; writes SyncLog', async () => {
    hcmService.getBalance.mockResolvedValue(25);
    await syncService.refreshOne('emp001', 'loc001');
    const balance = await balanceRepo.findOne({ where: { employeeId: 'emp001', locationId: 'loc001' } });
    expect(Number(balance!.availableDays)).toBe(25);
    const log = await syncLogRepo.findOne({ where: { type: 'REAL_TIME' } });
    expect(log).toBeTruthy();
  });

  // T-I-18
  it('reEnqueuePendingHcmConfirmations: retryCount=5 request immediately REJECTED; balance restored; SyncLog written', async () => {
    // Set balance to reflect an optimistic deduction of 3 days
    await balanceRepo.update(
      { employeeId: 'emp001', locationId: 'loc001' },
      { availableDays: 7, pendingDays: 3 },
    );
    const req = requestRepo.create({
      employeeId: 'emp001',
      locationId: 'loc001',
      startDate: '2025-06-01',
      endDate: '2025-06-03',
      daysRequested: 3,
      status: 'PENDING_HCM_CONFIRMATION',
      retryCount: 5,
    });
    await requestRepo.save(req);

    await syncService.reEnqueuePendingHcmConfirmations();

    const updated = await requestRepo.findOne({ where: { id: req.id } });
    expect(updated!.status).toBe('REJECTED');

    const balance = await balanceRepo.findOne({ where: { employeeId: 'emp001', locationId: 'loc001' } });
    expect(Number(balance!.availableDays)).toBe(10);
    expect(Number(balance!.pendingDays)).toBe(0);

    const log = await syncLogRepo.findOne({ where: { status: 'ERROR' } });
    expect(log).toBeTruthy();
  });
});
