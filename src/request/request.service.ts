import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { TimeOffRequest } from './time-off-request.entity';
import { CreateRequestDto } from './create-request.dto';
import { BalanceService } from '../balance/balance.service';
import { HcmService } from '../hcm/hcm.service';

@Injectable()
export class RequestService {
  constructor(
    @InjectRepository(TimeOffRequest)
    private readonly requestRepo: Repository<TimeOffRequest>,
    private readonly balanceService: BalanceService,
    private readonly hcmService: HcmService,
    private readonly dataSource: DataSource,
  ) {}

  async submit(
    dto: CreateRequestDto,
    idempotencyKey?: string,
  ): Promise<TimeOffRequest> {
    // Phase 1 — Idempotency check
    if (idempotencyKey) {
      const existing = await this.requestRepo.findOne({
        where: { idempotencyKey },
      });
      if (existing) return existing;
    }

    // Phase 2 — Atomic local write
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let request: TimeOffRequest;
    try {
      await this.balanceService.deductPending(
        dto.employeeId,
        dto.locationId,
        dto.daysRequested,
        queryRunner,
      );

      request = queryRunner.manager.create(TimeOffRequest, {
        employeeId: dto.employeeId,
        locationId: dto.locationId,
        startDate: dto.startDate,
        endDate: dto.endDate,
        daysRequested: dto.daysRequested,
        status: 'PENDING',
        retryCount: 0,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });

      request = await queryRunner.manager.save(TimeOffRequest, request);
      await queryRunner.commitTransaction();
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }

    // Phase 3 — HCM call (after commit)
    try {
      const hcmResult = await this.hcmService.submitRequest({
        employeeId: dto.employeeId,
        locationId: dto.locationId,
        daysRequested: dto.daysRequested,
        requestId: request.id,
      });

      if (hcmResult.approved) {
        request.status = 'APPROVED';
        request.hcmTransactionId = hcmResult.transactionId;
        await this.balanceService.reconcile(
          dto.employeeId,
          dto.locationId,
          dto.daysRequested,
          'CONFIRMED',
        );
      } else {
        request.status = 'REJECTED';
        await this.balanceService.reconcile(
          dto.employeeId,
          dto.locationId,
          dto.daysRequested,
          'REJECTED',
        );
      }
    } catch (err) {
      if (err instanceof ServiceUnavailableException) {
        request.status = 'PENDING_HCM_CONFIRMATION';
        request.retryCount = 0;
        request.nextRetryAt = new Date(Date.now() + 60_000);
      } else {
        throw err;
      }
    }

    return this.requestRepo.save(request);
  }

  async approve(id: string): Promise<TimeOffRequest> {
    const request = await this.findById(id);
    if (request.status !== 'PENDING') {
      throw new ConflictException(
        `Cannot approve request in status ${request.status}`,
      );
    }
    request.status = 'APPROVED';
    await this.balanceService.reconcile(
      request.employeeId,
      request.locationId,
      Number(request.daysRequested),
      'CONFIRMED',
    );
    return this.requestRepo.save(request);
  }

  async reject(id: string): Promise<TimeOffRequest> {
    const request = await this.findById(id);
    if (request.status !== 'PENDING') {
      throw new ConflictException(
        `Cannot reject request in status ${request.status}`,
      );
    }
    request.status = 'REJECTED';
    await this.balanceService.reconcile(
      request.employeeId,
      request.locationId,
      Number(request.daysRequested),
      'REJECTED',
    );
    return this.requestRepo.save(request);
  }

  async cancel(id: string): Promise<TimeOffRequest> {
    const request = await this.findById(id);
    if (request.status !== 'PENDING') {
      throw new ConflictException(
        `Cannot cancel request in status ${request.status}`,
      );
    }
    request.status = 'CANCELLED';
    await this.balanceService.reconcile(
      request.employeeId,
      request.locationId,
      Number(request.daysRequested),
      'REJECTED',
    );
    return this.requestRepo.save(request);
  }

  async findById(id: string): Promise<TimeOffRequest> {
    const request = await this.requestRepo.findOne({ where: { id } });
    if (!request) {
      throw new NotFoundException(`Request ${id} not found`);
    }
    return request;
  }
}
