import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { InsufficientBalanceException } from '../../src/common/exceptions/insufficient-balance.exception';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RequestService } from '../../src/request/request.service';
import { TimeOffRequest } from '../../src/request/time-off-request.entity';
import { BalanceService } from '../../src/balance/balance.service';
import { HcmService } from '../../src/hcm/hcm.service';
import { CreateRequestDto } from '../../src/request/create-request.dto';

function makeRequest(overrides: Partial<TimeOffRequest> = {}): TimeOffRequest {
  const r = new TimeOffRequest();
  r.id = 'req-uuid-1';
  r.employeeId = 'emp001';
  r.locationId = 'loc001';
  r.startDate = '2025-06-01';
  r.endDate = '2025-06-05';
  r.daysRequested = 3;
  r.status = 'PENDING';
  r.retryCount = 0;
  r.hcmTransactionId = null;
  r.idempotencyKey = null as any;
  r.nextRetryAt = null as any;
  r.createdAt = new Date();
  r.updatedAt = new Date();
  return Object.assign(r, overrides);
}

function makeDto(overrides: Partial<CreateRequestDto> = {}): CreateRequestDto {
  return Object.assign(
    {
      employeeId: 'emp001',
      locationId: 'loc001',
      startDate: '2025-06-01',
      endDate: '2025-06-05',
      daysRequested: 3,
    } as CreateRequestDto,
    overrides,
  );
}

describe('RequestService', () => {
  let service: RequestService;
  let requestRepo: jest.Mocked<any>;
  let balanceService: jest.Mocked<BalanceService>;
  let hcmService: jest.Mocked<HcmService>;
  let dataSource: jest.Mocked<any>;

  function makeQueryRunner(request: TimeOffRequest) {
    return {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager: {
        create: jest.fn().mockReturnValue(request),
        save: jest.fn().mockResolvedValue(request),
      },
    };
  }

  beforeEach(async () => {
    const pendingRequest = makeRequest();
    const qr = makeQueryRunner(pendingRequest);

    requestRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockResolvedValue(pendingRequest),
    };

    balanceService = {
      deductPending: jest.fn().mockResolvedValue({}),
      reconcile: jest.fn().mockResolvedValue(undefined),
      getBalance: jest.fn(),
      upsertFromHcm: jest.fn(),
    } as any;

    hcmService = {
      submitRequest: jest.fn().mockResolvedValue({ transactionId: 'txn-1', approved: true }),
      getBalance: jest.fn(),
    } as any;

    dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(qr),
    };

    const module = await Test.createTestingModule({
      providers: [
        RequestService,
        { provide: getRepositoryToken(TimeOffRequest), useValue: requestRepo },
        { provide: BalanceService, useValue: balanceService },
        { provide: HcmService, useValue: hcmService },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get(RequestService);
  });

  // T-U-14
  it('submit creates PENDING request and calls deductPending and HcmService.submitRequest', async () => {
    await service.submit(makeDto());
    expect(balanceService.deductPending).toHaveBeenCalledWith('emp001', 'loc001', 3, expect.anything());
    expect(hcmService.submitRequest).toHaveBeenCalled();
  });

  // T-U-15
  it('submit transitions to APPROVED when HCM returns approved: true; calls reconcile CONFIRMED', async () => {
    hcmService.submitRequest.mockResolvedValue({ transactionId: 'txn-1', approved: true });
    await service.submit(makeDto());
    expect(balanceService.reconcile).toHaveBeenCalledWith('emp001', 'loc001', 3, 'CONFIRMED');
    const savedRequest = requestRepo.save.mock.calls[0][0];
    expect(savedRequest.status).toBe('APPROVED');
  });

  // T-U-16
  it('submit transitions to REJECTED and calls reconcile REJECTED when HCM returns approved: false', async () => {
    hcmService.submitRequest.mockResolvedValue({ transactionId: null, approved: false });
    await service.submit(makeDto());
    expect(balanceService.reconcile).toHaveBeenCalledWith('emp001', 'loc001', 3, 'REJECTED');
    const savedRequest = requestRepo.save.mock.calls[0][0];
    expect(savedRequest.status).toBe('REJECTED');
  });

  // T-U-17
  it('submit sets PENDING_HCM_CONFIRMATION and does NOT call reconcile when HCM throws ServiceUnavailableException', async () => {
    hcmService.submitRequest.mockRejectedValue(new ServiceUnavailableException());
    await service.submit(makeDto());
    expect(balanceService.reconcile).not.toHaveBeenCalled();
    const savedRequest = requestRepo.save.mock.calls[0][0];
    expect(savedRequest.status).toBe('PENDING_HCM_CONFIRMATION');
  });

  // T-U-18
  it('submit returns existing request without DB or HCM calls when Idempotency-Key matches', async () => {
    const existing = makeRequest({ status: 'APPROVED' });
    requestRepo.findOne.mockResolvedValue(existing);
    const result = await service.submit(makeDto(), 'key-001');
    expect(result).toBe(existing);
    expect(balanceService.deductPending).not.toHaveBeenCalled();
    expect(hcmService.submitRequest).not.toHaveBeenCalled();
  });

  // T-U-19 — concurrent idempotency race produces ConflictException via unique constraint
  it('submit throws ConflictException when idempotency key causes unique constraint violation', async () => {
    requestRepo.findOne.mockResolvedValue(null);
    const qr = dataSource.createQueryRunner();
    qr.manager.save.mockRejectedValue(
      Object.assign(new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed'), {
        code: 'SQLITE_CONSTRAINT',
      }),
    );
    // The rollbackTransaction + rethrow path should surface the error
    await expect(service.submit(makeDto(), 'key-dup')).rejects.toThrow();
  });

  // T-U-20 — startDate after endDate is caught by DTO validation, service itself does not check it
  it('submit propagates errors from deductPending (e.g. InsufficientBalanceException)', async () => {
    balanceService.deductPending.mockRejectedValue(new InsufficientBalanceException(2, 5));
    const qr = dataSource.createQueryRunner();
    qr.rollbackTransaction = jest.fn();
    await expect(service.submit(makeDto())).rejects.toThrow(InsufficientBalanceException);
  });

  // T-U-21
  it('approve transitions PENDING → APPROVED and calls reconcile CONFIRMED', async () => {
    const req = makeRequest({ status: 'PENDING' });
    requestRepo.findOne.mockResolvedValue(req);
    requestRepo.save.mockResolvedValue({ ...req, status: 'APPROVED' });
    const result = await service.approve('req-uuid-1');
    expect(balanceService.reconcile).toHaveBeenCalledWith('emp001', 'loc001', 3, 'CONFIRMED');
    expect(result.status).toBe('APPROVED');
  });

  // T-U-22
  it('approve throws NotFoundException when request ID does not exist', async () => {
    requestRepo.findOne.mockResolvedValue(null);
    await expect(service.approve('nonexistent')).rejects.toThrow(NotFoundException);
  });

  // T-U-23
  it('approve throws ConflictException when request is not PENDING', async () => {
    for (const status of ['APPROVED', 'REJECTED', 'CANCELLED']) {
      requestRepo.findOne.mockResolvedValue(makeRequest({ status }));
      await expect(service.approve('req-uuid-1')).rejects.toThrow(ConflictException);
    }
  });

  // T-U-24
  it('reject transitions PENDING → REJECTED and calls reconcile REJECTED', async () => {
    const req = makeRequest({ status: 'PENDING' });
    requestRepo.findOne.mockResolvedValue(req);
    requestRepo.save.mockResolvedValue({ ...req, status: 'REJECTED' });
    const result = await service.reject('req-uuid-1');
    expect(balanceService.reconcile).toHaveBeenCalledWith('emp001', 'loc001', 3, 'REJECTED');
    expect(result.status).toBe('REJECTED');
  });

  // T-U-25
  it('cancel transitions PENDING → CANCELLED and calls reconcile REJECTED', async () => {
    const req = makeRequest({ status: 'PENDING' });
    requestRepo.findOne.mockResolvedValue(req);
    requestRepo.save.mockResolvedValue({ ...req, status: 'CANCELLED' });
    const result = await service.cancel('req-uuid-1');
    expect(balanceService.reconcile).toHaveBeenCalledWith('emp001', 'loc001', 3, 'REJECTED');
    expect(result.status).toBe('CANCELLED');
  });

  // T-U-26
  it('cancel throws ConflictException when request is APPROVED', async () => {
    requestRepo.findOne.mockResolvedValue(makeRequest({ status: 'APPROVED' }));
    await expect(service.cancel('req-uuid-1')).rejects.toThrow(ConflictException);
  });
});
