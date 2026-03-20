import { ConflictException, NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { OptimisticLockVersionMismatchError } from 'typeorm';
import { BalanceService } from '../../src/balance/balance.service';
import { LeaveBalance } from '../../src/balance/leave-balance.entity';
import { InsufficientBalanceException } from '../../src/common/exceptions/insufficient-balance.exception';
import { round4 } from '../../src/common/utils/balance.util';

function makeBalance(overrides: Partial<LeaveBalance> = {}): LeaveBalance {
  const b = new LeaveBalance();
  b.id = 'uuid-1';
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

function makeQueryRunner(balance: LeaveBalance | null, saveResult?: LeaveBalance) {
  const saved = saveResult ?? balance;
  return {
    manager: {
      findOne: jest.fn().mockResolvedValue(balance),
      save: jest.fn().mockResolvedValue(saved),
      create: jest.fn().mockImplementation((_entity: any, data: any) => Object.assign(new LeaveBalance(), data)),
    },
  } as any;
}

describe('BalanceService', () => {
  let service: BalanceService;
  let repo: jest.Mocked<any>;

  beforeEach(async () => {
    repo = {
      findOne: jest.fn(),
      save: jest.fn(),
      create: jest.fn().mockImplementation((data: any) => Object.assign(new LeaveBalance(), data)),
    };

    const module = await Test.createTestingModule({
      providers: [
        BalanceService,
        { provide: getRepositoryToken(LeaveBalance), useValue: repo },
      ],
    }).compile();

    service = module.get(BalanceService);
  });

  // T-U-01
  it('getBalance returns the balance when found', async () => {
    const balance = makeBalance();
    repo.findOne.mockResolvedValue(balance);
    const result = await service.getBalance('emp001', 'loc001');
    expect(result).toBe(balance);
  });

  // T-U-02
  it('getBalance throws NotFoundException with BALANCE_NOT_FOUND when not found', async () => {
    repo.findOne.mockResolvedValue(null);
    await expect(service.getBalance('emp001', 'loc001')).rejects.toThrow(NotFoundException);
    await expect(service.getBalance('emp001', 'loc001')).rejects.toMatchObject({
      response: expect.objectContaining({ error: 'BALANCE_NOT_FOUND' }),
    });
  });

  // T-U-03
  it('deductPending reduces availableDays and increases pendingDays', async () => {
    const balance = makeBalance({ availableDays: 10, pendingDays: 0, version: 1 });
    const qr = makeQueryRunner(balance);
    const result = await service.deductPending('emp001', 'loc001', 3, qr);
    expect(qr.manager.save).toHaveBeenCalled();
    const saved = qr.manager.save.mock.calls[0][1];
    expect(Number(saved.availableDays)).toBe(7);
    expect(Number(saved.pendingDays)).toBe(3);
  });

  // T-U-04
  it('deductPending throws InsufficientBalanceException when availableDays < days', async () => {
    const balance = makeBalance({ availableDays: 2 });
    const qr = makeQueryRunner(balance);
    await expect(service.deductPending('emp001', 'loc001', 3, qr)).rejects.toThrow(
      InsufficientBalanceException,
    );
    expect(qr.manager.save).not.toHaveBeenCalled();
  });

  // T-U-05
  it('deductPending retries on OptimisticLockVersionMismatchError; succeeds on 3rd attempt', async () => {
    const balance = makeBalance({ availableDays: 10, pendingDays: 0 });
    const saved = makeBalance({ availableDays: 7, pendingDays: 3 });
    const lockErr = new OptimisticLockVersionMismatchError('LeaveBalance', 1, 2);
    const qr = {
      manager: {
        findOne: jest.fn().mockResolvedValue(balance),
        save: jest
          .fn()
          .mockRejectedValueOnce(lockErr)
          .mockRejectedValueOnce(lockErr)
          .mockResolvedValueOnce(saved),
      },
    } as any;
    const result = await service.deductPending('emp001', 'loc001', 3, qr);
    expect(qr.manager.save).toHaveBeenCalledTimes(3);
    expect(result).toBe(saved);
  });

  // T-U-06
  it('deductPending throws ConflictException after 3 consecutive optimistic lock failures', async () => {
    const balance = makeBalance({ availableDays: 10 });
    const lockErr = new OptimisticLockVersionMismatchError('LeaveBalance', 1, 2);
    const qr = {
      manager: {
        findOne: jest.fn().mockResolvedValue(balance),
        save: jest.fn().mockRejectedValue(lockErr),
      },
    } as any;
    await expect(service.deductPending('emp001', 'loc001', 3, qr)).rejects.toThrow(
      ConflictException,
    );
    expect(qr.manager.save).toHaveBeenCalledTimes(3);
  });

  // T-U-07
  it('reconcile CONFIRMED reduces pendingDays; availableDays unchanged', async () => {
    const balance = makeBalance({ availableDays: 7, pendingDays: 3 });
    repo.findOne.mockResolvedValue(balance);
    repo.save.mockResolvedValue(balance);
    await service.reconcile('emp001', 'loc001', 3, 'CONFIRMED');
    const saved = repo.save.mock.calls[0][0];
    expect(Number(saved.availableDays)).toBe(7);
    expect(Number(saved.pendingDays)).toBe(0);
  });

  // T-U-08
  it('reconcile REJECTED restores availableDays and reduces pendingDays', async () => {
    const balance = makeBalance({ availableDays: 7, pendingDays: 3 });
    repo.findOne.mockResolvedValue(balance);
    repo.save.mockResolvedValue(balance);
    await service.reconcile('emp001', 'loc001', 3, 'REJECTED');
    const saved = repo.save.mock.calls[0][0];
    expect(Number(saved.availableDays)).toBe(10);
    expect(Number(saved.pendingDays)).toBe(0);
  });

  // T-U-09
  it('upsertFromHcm creates a new record when none exists', async () => {
    repo.findOne.mockResolvedValue(null);
    repo.create.mockImplementation((data: any) => Object.assign(new LeaveBalance(), data));
    repo.save.mockResolvedValue({});
    const result = await service.upsertFromHcm('emp001', 'loc001', 10, new Date());
    expect(result).toEqual({ updated: true });
    expect(repo.save).toHaveBeenCalled();
  });

  // T-U-10
  it('upsertFromHcm updates when incoming syncTimestamp is newer', async () => {
    const old = makeBalance({
      availableDays: 10,
      lastHcmSyncAt: new Date('2025-01-01T00:00:00Z'),
    });
    repo.findOne.mockResolvedValue(old);
    repo.save.mockResolvedValue(old);
    const result = await service.upsertFromHcm(
      'emp001',
      'loc001',
      15,
      new Date('2025-01-02T00:00:00Z'),
    );
    expect(result).toEqual({ updated: true });
    expect(Number(old.availableDays)).toBe(15);
  });

  // T-U-11
  it('upsertFromHcm does NOT update when incoming syncTimestamp <= lastHcmSyncAt', async () => {
    const old = makeBalance({
      availableDays: 15,
      lastHcmSyncAt: new Date('2025-01-02T00:00:00Z'),
    });
    repo.findOne.mockResolvedValue(old);
    const result = await service.upsertFromHcm(
      'emp001',
      'loc001',
      10,
      new Date('2025-01-01T00:00:00Z'),
    );
    expect(result).toEqual({ updated: false });
    expect(repo.save).not.toHaveBeenCalled();
  });

  // T-U-12
  it('round4 truncates 7.3333333333 to 7.3333', () => {
    expect(round4(7.3333333333)).toBe(7.3333);
  });

  // T-U-13
  it('round4: three deductions of 0.3333 from 1.0000 result in 0.0001, never negative', () => {
    let val = 1.0;
    val = round4(val - 0.3333);
    val = round4(val - 0.3333);
    val = round4(val - 0.3333);
    expect(val).toBe(0.0001);
    expect(val).toBeGreaterThanOrEqual(0);
  });
});
