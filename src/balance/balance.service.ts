import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryRunner, Repository } from 'typeorm';
import { OptimisticLockVersionMismatchError } from 'typeorm';
import { LeaveBalance } from './leave-balance.entity';
import { InsufficientBalanceException } from '../common/exceptions/insufficient-balance.exception';
import { round4 } from '../common/utils/balance.util';

@Injectable()
export class BalanceService {
  constructor(
    @InjectRepository(LeaveBalance)
    private readonly balanceRepo: Repository<LeaveBalance>,
  ) {}

  async getBalance(employeeId: string, locationId: string): Promise<LeaveBalance> {
    const balance = await this.balanceRepo.findOne({
      where: { employeeId, locationId },
    });
    if (!balance) {
      throw new NotFoundException({
        statusCode: 404,
        error: 'BALANCE_NOT_FOUND',
        message: `No balance record found for employee ${employeeId} at location ${locationId}`,
      });
    }
    return balance;
  }

  async deductPending(
    employeeId: string,
    locationId: string,
    days: number,
    queryRunner: QueryRunner,
  ): Promise<LeaveBalance> {
    const MAX_RETRIES = 3;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const balance = await queryRunner.manager.findOne(LeaveBalance, {
          where: { employeeId, locationId },
          lock: { mode: 'optimistic', version: undefined as any },
        });

        if (!balance) {
          throw new NotFoundException({
            statusCode: 404,
            error: 'BALANCE_NOT_FOUND',
            message: `No balance record found for employee ${employeeId} at location ${locationId}`,
          });
        }

        if (Number(balance.availableDays) < days) {
          throw new InsufficientBalanceException(
            Number(balance.availableDays),
            days,
          );
        }

        balance.availableDays = round4(Number(balance.availableDays) - days);
        balance.pendingDays = round4(Number(balance.pendingDays) + days);

        return await queryRunner.manager.save(LeaveBalance, balance);
      } catch (err) {
        if (err instanceof OptimisticLockVersionMismatchError) {
          if (attempt === MAX_RETRIES - 1) {
            throw new ConflictException(
              'Balance is being updated concurrently. Please retry.',
            );
          }
          continue;
        }
        throw err;
      }
    }

    // Should never reach here, but satisfies TypeScript
    throw new ConflictException('Balance is being updated concurrently. Please retry.');
  }

  async reconcile(
    employeeId: string,
    locationId: string,
    days: number,
    outcome: 'CONFIRMED' | 'REJECTED',
  ): Promise<void> {
    const balance = await this.balanceRepo.findOne({
      where: { employeeId, locationId },
    });
    if (!balance) return;

    if (outcome === 'CONFIRMED') {
      balance.pendingDays = round4(Number(balance.pendingDays) - days);
    } else {
      balance.availableDays = round4(Number(balance.availableDays) + days);
      balance.pendingDays = round4(Number(balance.pendingDays) - days);
    }

    await this.balanceRepo.save(balance);
  }

  async upsertFromHcm(
    employeeId: string,
    locationId: string,
    availableDays: number,
    syncTimestamp: Date,
  ): Promise<{ updated: boolean }> {
    const existing = await this.balanceRepo.findOne({
      where: { employeeId, locationId },
    });

    if (!existing) {
      const record = this.balanceRepo.create({
        employeeId,
        locationId,
        availableDays: round4(availableDays),
        pendingDays: 0,
        lastHcmSyncAt: syncTimestamp,
      });
      await this.balanceRepo.save(record);
      return { updated: true };
    }

    if (existing.lastHcmSyncAt && syncTimestamp <= existing.lastHcmSyncAt) {
      return { updated: false };
    }

    existing.availableDays = round4(availableDays);
    existing.lastHcmSyncAt = syncTimestamp;
    await this.balanceRepo.save(existing);
    return { updated: true };
  }
}
