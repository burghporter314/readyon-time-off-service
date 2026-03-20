import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ServiceUnavailableException } from '@nestjs/common';
import { InsufficientBalanceException } from '../../src/common/exceptions/insufficient-balance.exception';
import { DataSource, Repository } from 'typeorm';
import { BalanceService } from '../../src/balance/balance.service';
import { RequestService } from '../../src/request/request.service';
import { HcmService } from '../../src/hcm/hcm.service';
import { LeaveBalance } from '../../src/balance/leave-balance.entity';
import { TimeOffRequest } from '../../src/request/time-off-request.entity';
import { SyncLog } from '../../src/sync/sync-log.entity';
import { createTestDataSource } from './helpers';

describe('Balance & Request Lifecycle (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let balanceService: BalanceService;
  let requestService: RequestService;
  let hcmService: jest.Mocked<HcmService>;
  let balanceRepo: Repository<LeaveBalance>;
  let requestRepo: Repository<TimeOffRequest>;

  beforeAll(async () => {
    dataSource = await createTestDataSource();

    hcmService = {
      submitRequest: jest.fn().mockResolvedValue({ transactionId: 'txn-1', approved: true }),
      getBalance: jest.fn().mockResolvedValue(10),
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
        BalanceService,
        RequestService,
        { provide: HcmService, useValue: hcmService },
      ],
    }).compile();

    balanceService = module.get(BalanceService);
    requestService = module.get(RequestService);
    balanceRepo = module.get(getRepositoryToken(LeaveBalance));
    requestRepo = module.get(getRepositoryToken(TimeOffRequest));
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await requestRepo.query('DELETE FROM time_off_request');
    await balanceRepo.query('DELETE FROM leave_balance');
    jest.clearAllMocks();
    hcmService.submitRequest.mockResolvedValue({ transactionId: 'txn-1', approved: true });

    await balanceRepo.save(
      balanceRepo.create({ employeeId: 'emp001', locationId: 'loc001', availableDays: 10, pendingDays: 0 }),
    );
  });

  // T-I-01
  it('submitting a 3-day request deducts from availableDays and adds to pendingDays', async () => {
    // HCM returns pending (no immediate approval for this test) — override
    hcmService.submitRequest.mockResolvedValue({ transactionId: null, approved: false });
    // We need PENDING status: make HCM unavailable to get a PENDING_HCM_CONFIRMATION
    // Actually use approved: false to get REJECTED then check intermediate state is correct
    // Better: intercept just the DB state right after commit but before HCM
    // Use ServiceUnavailable to freeze in PENDING_HCM_CONFIRMATION
    hcmService.submitRequest.mockRejectedValue(new ServiceUnavailableException());
    await requestService.submit({ employeeId: 'emp001', locationId: 'loc001', startDate: '2025-06-01', endDate: '2025-06-03', daysRequested: 3 });
    const balance = await balanceRepo.findOne({ where: { employeeId: 'emp001', locationId: 'loc001' } });
    // After deduction (availableDays=7) but before reconcile (pendingDays still=3 since HCM failed)
    expect(Number(balance!.availableDays)).toBe(7);
    expect(Number(balance!.pendingDays)).toBe(3);
  });

  // T-I-02
  it('after HCM approves: availableDays=7, pendingDays=0', async () => {
    hcmService.submitRequest.mockResolvedValue({ transactionId: 'txn-1', approved: true });
    await requestService.submit({ employeeId: 'emp001', locationId: 'loc001', startDate: '2025-06-01', endDate: '2025-06-03', daysRequested: 3 });
    const balance = await balanceRepo.findOne({ where: { employeeId: 'emp001', locationId: 'loc001' } });
    expect(Number(balance!.availableDays)).toBe(7);
    expect(Number(balance!.pendingDays)).toBe(0);
  });

  // T-I-03
  it('after HCM rejects: availableDays restored to 10, pendingDays=0', async () => {
    hcmService.submitRequest.mockResolvedValue({ transactionId: null, approved: false });
    await requestService.submit({ employeeId: 'emp001', locationId: 'loc001', startDate: '2025-06-01', endDate: '2025-06-03', daysRequested: 3 });
    const balance = await balanceRepo.findOne({ where: { employeeId: 'emp001', locationId: 'loc001' } });
    expect(Number(balance!.availableDays)).toBe(10);
    expect(Number(balance!.pendingDays)).toBe(0);
  });

  // T-I-04
  it('two concurrent requests for 8 days: exactly one succeeds; availableDays never below 0', async () => {
    hcmService.submitRequest.mockRejectedValue(new ServiceUnavailableException());
    const results = await Promise.allSettled([
      requestService.submit({ employeeId: 'emp001', locationId: 'loc001', startDate: '2025-06-01', endDate: '2025-06-08', daysRequested: 8 }),
      requestService.submit({ employeeId: 'emp001', locationId: 'loc001', startDate: '2025-06-01', endDate: '2025-06-08', daysRequested: 8 }),
    ]);
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    const balance = await balanceRepo.findOne({ where: { employeeId: 'emp001', locationId: 'loc001' } });
    expect(Number(balance!.availableDays)).toBeGreaterThanOrEqual(0);
  });

  // T-I-05
  it('submitting a request exceeding balance returns 422 before HcmService is called', async () => {
    await expect(
      requestService.submit({ employeeId: 'emp001', locationId: 'loc001', startDate: '2025-06-01', endDate: '2025-06-15', daysRequested: 15 }),
    ).rejects.toThrow(InsufficientBalanceException);
    expect(hcmService.submitRequest).not.toHaveBeenCalled();
  });

  // T-I-06
  it('cancelling a PENDING request restores availableDays', async () => {
    hcmService.submitRequest.mockRejectedValue(new ServiceUnavailableException());
    const req = await requestService.submit({ employeeId: 'emp001', locationId: 'loc001', startDate: '2025-06-01', endDate: '2025-06-03', daysRequested: 3 });
    // Re-set status to PENDING so we can cancel (it's actually PENDING_HCM_CONFIRMATION)
    await requestRepo.update(req.id, { status: 'PENDING' });
    await requestService.cancel(req.id);
    const balance = await balanceRepo.findOne({ where: { employeeId: 'emp001', locationId: 'loc001' } });
    expect(Number(balance!.availableDays)).toBe(10);
  });

  // T-I-07
  it('duplicate Idempotency-Key: second call returns original; DB has one request; balance deducted once', async () => {
    hcmService.submitRequest.mockResolvedValue({ transactionId: 'txn-1', approved: true });
    const first = await requestService.submit(
      { employeeId: 'emp001', locationId: 'loc001', startDate: '2025-06-01', endDate: '2025-06-03', daysRequested: 3 },
      'idem-key-001',
    );
    const second = await requestService.submit(
      { employeeId: 'emp001', locationId: 'loc001', startDate: '2025-06-01', endDate: '2025-06-03', daysRequested: 3 },
      'idem-key-001',
    );
    expect(second.id).toBe(first.id);
    const count = await requestRepo.count({ where: { idempotencyKey: 'idem-key-001' } });
    expect(count).toBe(1);
    const balance = await balanceRepo.findOne({ where: { employeeId: 'emp001', locationId: 'loc001' } });
    expect(Number(balance!.availableDays)).toBe(7); // deducted once
  });

  // T-I-08
  it('manager approves PENDING request: status=APPROVED, pendingDays=0', async () => {
    hcmService.submitRequest.mockRejectedValue(new ServiceUnavailableException());
    const req = await requestService.submit({ employeeId: 'emp001', locationId: 'loc001', startDate: '2025-06-01', endDate: '2025-06-03', daysRequested: 3 });
    await requestRepo.update(req.id, { status: 'PENDING' });
    await requestService.approve(req.id);
    const updated = await requestRepo.findOne({ where: { id: req.id } });
    expect(updated!.status).toBe('APPROVED');
    const balance = await balanceRepo.findOne({ where: { employeeId: 'emp001', locationId: 'loc001' } });
    expect(Number(balance!.pendingDays)).toBe(0);
  });

  // T-I-09
  it('manager rejects PENDING request: status=REJECTED, availableDays restored', async () => {
    hcmService.submitRequest.mockRejectedValue(new ServiceUnavailableException());
    const req = await requestService.submit({ employeeId: 'emp001', locationId: 'loc001', startDate: '2025-06-01', endDate: '2025-06-03', daysRequested: 3 });
    await requestRepo.update(req.id, { status: 'PENDING' });
    await requestService.reject(req.id);
    const updated = await requestRepo.findOne({ where: { id: req.id } });
    expect(updated!.status).toBe('REJECTED');
    const balance = await balanceRepo.findOne({ where: { employeeId: 'emp001', locationId: 'loc001' } });
    expect(Number(balance!.availableDays)).toBe(10);
  });
});
