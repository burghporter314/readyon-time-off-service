import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { SyncLog } from './sync-log.entity';
import { BalanceService } from '../balance/balance.service';
import { HcmService } from '../hcm/hcm.service';
import { LeaveBalance } from '../balance/leave-balance.entity';
import { TimeOffRequest } from '../request/time-off-request.entity';
import { BatchSyncRecordDto } from '../common/dto/batch-sync-record.dto';
import { round4 } from '../common/utils/balance.util';

@Injectable()
export class SyncService implements OnModuleInit {
  private readonly logger = new Logger(SyncService.name);

  // Backoff schedule: 1m, 5m, 15m, 30m, 60m
  private readonly backoffMs = [60_000, 300_000, 900_000, 1_800_000, 3_600_000];

  constructor(
    @InjectRepository(SyncLog)
    private readonly syncLogRepo: Repository<SyncLog>,
    @InjectRepository(TimeOffRequest)
    private readonly requestRepo: Repository<TimeOffRequest>,
    @InjectRepository(LeaveBalance)
    private readonly balanceRepo: Repository<LeaveBalance>,
    private readonly balanceService: BalanceService,
    private readonly hcmService: HcmService,
    private readonly dataSource: DataSource,
  ) {}

  async onModuleInit() {
    await this.reEnqueuePendingHcmConfirmations();
  }

  async batchSync(
    records: BatchSyncRecordDto[],
  ): Promise<{ updated: number; autoCancelled: number; skipped: number }> {
    // Phase 1 — Validate all records before any write
    for (const record of records) {
      const n = Number(record.availableDays);
      if (!isFinite(n) || n < 0) {
        throw new BadRequestException(
          `Invalid availableDays for employee ${record.employeeId} at location ${record.locationId}: ${record.availableDays}`,
        );
      }
    }

    if (records.length === 0) {
      return { updated: 0, autoCancelled: 0, skipped: 0 };
    }

    let updated = 0;
    let skipped = 0;
    let autoCancelled = 0;
    const updatedPairs: Array<{ employeeId: string; locationId: string; syncTimestamp: Date }> = [];

    // Phase 2 — Single atomic transaction
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      for (const record of records) {
        const syncTimestamp = new Date(record.syncTimestamp);

        const existing = await queryRunner.manager.findOne(LeaveBalance, {
          where: { employeeId: record.employeeId, locationId: record.locationId },
        });

        if (existing && existing.lastHcmSyncAt && syncTimestamp <= existing.lastHcmSyncAt) {
          skipped++;
          continue;
        }

        if (existing) {
          existing.availableDays = round4(Number(record.availableDays));
          existing.lastHcmSyncAt = syncTimestamp;
          await queryRunner.manager.save(LeaveBalance, existing);
        } else {
          const newBalance = queryRunner.manager.create(LeaveBalance, {
            employeeId: record.employeeId,
            locationId: record.locationId,
            availableDays: round4(Number(record.availableDays)),
            pendingDays: 0,
            lastHcmSyncAt: syncTimestamp,
          });
          await queryRunner.manager.save(LeaveBalance, newBalance);
        }

        updated++;
        updatedPairs.push({
          employeeId: record.employeeId,
          locationId: record.locationId,
          syncTimestamp,
        });
      }

      await queryRunner.commitTransaction();
    } catch (err) {
      await queryRunner.rollbackTransaction();
      await this.writeSyncLog('BATCH', 'batch-endpoint', 'ERROR', 0, 0, String(err));
      throw err;
    } finally {
      await queryRunner.release();
    }

    // Phase 3 — Post-commit auto-cancel
    for (const pair of updatedPairs) {
      const balance = await this.balanceRepo.findOne({
        where: { employeeId: pair.employeeId, locationId: pair.locationId },
      });
      if (!balance) continue;

      const pendingRequests = await this.requestRepo
        .createQueryBuilder('r')
        .where('r.employeeId = :emp', { emp: pair.employeeId })
        .andWhere('r.locationId = :loc', { loc: pair.locationId })
        .andWhere("r.status = 'PENDING'")
        .andWhere('r.createdAt <= :ts', { ts: pair.syncTimestamp })
        .orderBy('r.createdAt', 'ASC')
        .getMany();

      let runningAvailable = Number(balance.availableDays);

      for (const req of pendingRequests) {
        if (runningAvailable < Number(req.daysRequested)) {
          req.status = 'CANCELLED';
          await this.requestRepo.save(req);
          await this.balanceService.reconcile(
            req.employeeId,
            req.locationId,
            Number(req.daysRequested),
            'REJECTED',
          );
          autoCancelled++;
        } else {
          runningAvailable -= Number(req.daysRequested);
        }
      }
    }

    // Phase 4 — Write SyncLog
    await this.writeSyncLog('BATCH', 'batch-endpoint', 'SUCCESS', updated, skipped);

    return { updated, autoCancelled, skipped };
  }

  async refreshOne(employeeId: string, locationId: string): Promise<LeaveBalance> {
    try {
      const availableDays = await this.hcmService.getBalance(employeeId, locationId);
      await this.balanceService.upsertFromHcm(
        employeeId,
        locationId,
        availableDays,
        new Date(),
      );
      await this.writeSyncLog('REAL_TIME', `refresh:${employeeId}:${locationId}`, 'SUCCESS', 1, 0);
      const balance = await this.balanceRepo.findOne({ where: { employeeId, locationId } });
      return balance!;
    } catch (err) {
      await this.writeSyncLog(
        'REAL_TIME',
        `refresh:${employeeId}:${locationId}`,
        'ERROR',
        0,
        0,
        String(err),
      );
      throw err;
    }
  }

  async reEnqueuePendingHcmConfirmations(): Promise<void> {
    const pending = await this.requestRepo.find({
      where: { status: 'PENDING_HCM_CONFIRMATION' },
    });

    for (const req of pending) {
      if (req.retryCount >= 5) {
        req.status = 'REJECTED';
        await this.requestRepo.save(req);
        await this.balanceService.reconcile(
          req.employeeId,
          req.locationId,
          Number(req.daysRequested),
          'REJECTED',
        );
        await this.writeSyncLog(
          'REAL_TIME',
          `retry-exhausted:${req.id}`,
          'ERROR',
          0,
          0,
          `Retry count exhausted for request ${req.id}`,
        );
        this.logger.warn(`Request ${req.id} rejected after retry exhaustion`);
        continue;
      }

      const elapsed = Date.now() - new Date(req.updatedAt).getTime();
      const scheduled = this.backoffMs[req.retryCount] ?? this.backoffMs[this.backoffMs.length - 1];
      const delay = Math.max(scheduled - elapsed, 0);

      setTimeout(() => this.retryHcmSubmission(req.id), delay);
      this.logger.log(`Request ${req.id} re-enqueued with delay ${delay}ms`);
    }
  }

  private async retryHcmSubmission(requestId: string): Promise<void> {
    const req = await this.requestRepo.findOne({ where: { id: requestId } });
    if (!req || req.status !== 'PENDING_HCM_CONFIRMATION') return;

    try {
      const result = await this.hcmService.submitRequest({
        employeeId: req.employeeId,
        locationId: req.locationId,
        daysRequested: Number(req.daysRequested),
        requestId: req.id,
      });

      if (result.approved) {
        req.status = 'APPROVED';
        req.hcmTransactionId = result.transactionId!;
        await this.balanceService.reconcile(
          req.employeeId,
          req.locationId,
          Number(req.daysRequested),
          'CONFIRMED',
        );
      } else {
        req.status = 'REJECTED';
        await this.balanceService.reconcile(
          req.employeeId,
          req.locationId,
          Number(req.daysRequested),
          'REJECTED',
        );
      }

      await this.requestRepo.save(req);
      await this.writeSyncLog(
        'REAL_TIME',
        `hcm-retry:${req.id}`,
        'SUCCESS',
        1,
        0,
      );
    } catch {
      req.retryCount += 1;
      req.nextRetryAt = new Date(
        Date.now() + (this.backoffMs[req.retryCount] ?? this.backoffMs[this.backoffMs.length - 1]),
      );
      await this.requestRepo.save(req);

      await this.writeSyncLog(
        'REAL_TIME',
        `hcm-retry:${req.id}`,
        'ERROR',
        0,
        0,
        `Retry ${req.retryCount} failed for request ${req.id}`,
      );

      if (req.retryCount >= 5) {
        req.status = 'REJECTED';
        await this.requestRepo.save(req);
        await this.balanceService.reconcile(
          req.employeeId,
          req.locationId,
          Number(req.daysRequested),
          'REJECTED',
        );
        this.logger.warn(`Request ${req.id} rejected after retry exhaustion`);
        return;
      }

      const nextDelay = this.backoffMs[req.retryCount];
      setTimeout(() => this.retryHcmSubmission(req.id), nextDelay);
    }
  }

  private async writeSyncLog(
    type: string,
    triggeredBy: string,
    status: string,
    recordsAffected: number,
    recordsSkipped: number,
    errorDetails?: string,
  ): Promise<void> {
    const log = this.syncLogRepo.create({
      type,
      triggeredBy,
      status,
      recordsAffected,
      recordsSkipped,
      errorDetails: errorDetails ?? null,
    });
    await this.syncLogRepo.save(log);
  }
}
