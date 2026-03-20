import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { ServiceUnavailableException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { SyncService } from '../../src/sync/sync.service';
import { BalanceService } from '../../src/balance/balance.service';
import { HcmService } from '../../src/hcm/hcm.service';
import { LeaveBalance } from '../../src/balance/leave-balance.entity';
import { TimeOffRequest } from '../../src/request/time-off-request.entity';
import { SyncLog } from '../../src/sync/sync-log.entity';

describe('SyncLog integration', () => {
  let module: TestingModule;
  let syncService: SyncService;
  let hcmService: jest.Mocked<HcmService>;
  let balanceRepo: Repository<LeaveBalance>;
  let requestRepo: Repository<TimeOffRequest>;
  let syncLogRepo: Repository<SyncLog>;

  beforeAll(async () => {
    hcmService = {
      getBalance: jest.fn().mockResolvedValue(20),
      submitRequest: jest.fn(),
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
    hcmService.getBalance.mockResolvedValue(20);
  });

  // T-I-19
  it('every batchSync writes a SyncLog entry with type=BATCH', async () => {
    await syncService.batchSync([{ employeeId: 'emp001', locationId: 'loc001', availableDays: 12, syncTimestamp: new Date().toISOString() }]);
    const logs = await syncLogRepo.find({ where: { type: 'BATCH' } });
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0].type).toBe('BATCH');
  });

  // T-I-20
  it('every refreshOne writes a SyncLog entry with type=REAL_TIME', async () => {
    await syncService.refreshOne('emp001', 'loc001');
    const logs = await syncLogRepo.find({ where: { type: 'REAL_TIME' } });
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0].type).toBe('REAL_TIME');
  });

  // T-I-21
  it('when HCM returns 503 on refreshOne, SyncLog written with status=ERROR and errorDetails populated', async () => {
    hcmService.getBalance.mockRejectedValue(new ServiceUnavailableException('HCM unavailable'));
    await expect(syncService.refreshOne('emp001', 'loc001')).rejects.toThrow();
    const logs = await syncLogRepo.find({ where: { status: 'ERROR', type: 'REAL_TIME' } });
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0].errorDetails).toBeTruthy();
  });

  // T-I-22
  it('when batchSync auto-cancels a PENDING request, SyncLog recordsAffected reflects the updated count', async () => {
    const req = requestRepo.create({
      employeeId: 'emp001',
      locationId: 'loc001',
      startDate: '2025-06-01',
      endDate: '2025-06-08',
      daysRequested: 8,
      status: 'PENDING',
      retryCount: 0,
    });
    await requestRepo.save(req);

    // syncTimestamp in the future so createdAt (now) <= syncTimestamp
    const syncTs = new Date(Date.now() + 10_000).toISOString();
    await syncService.batchSync([{ employeeId: 'emp001', locationId: 'loc001', availableDays: 3, syncTimestamp: syncTs }]);

    const logs = await syncLogRepo.find({ where: { type: 'BATCH', status: 'SUCCESS' } });
    expect(logs.length).toBeGreaterThanOrEqual(1);
    // recordsAffected = number of balance records updated (1 in this case)
    expect(logs[0].recordsAffected).toBe(1);
  });
});
