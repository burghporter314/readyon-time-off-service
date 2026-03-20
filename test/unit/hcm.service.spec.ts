import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { of, throwError } from 'rxjs';
import { HcmService } from '../../src/hcm/hcm.service';

function makeAxiosResponse(data: any, status = 200) {
  return { data, status, headers: {}, config: {}, statusText: 'OK' };
}

function makeAxiosError(status: number, data: any = {}) {
  const err: any = new Error('AxiosError');
  err.response = { status, data };
  err.isAxiosError = true;
  return err;
}

describe('HcmService', () => {
  let service: HcmService;
  let httpService: jest.Mocked<HttpService>;

  beforeEach(async () => {
    httpService = {
      get: jest.fn(),
      post: jest.fn(),
    } as any;

    const configService = { get: jest.fn().mockReturnValue('http://localhost:3001') };

    const module = await Test.createTestingModule({
      providers: [
        HcmService,
        { provide: HttpService, useValue: httpService },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get(HcmService);
  });

  // T-U-36
  it('getBalance makes GET to correct URL and returns numeric balance', async () => {
    httpService.get.mockReturnValue(of(makeAxiosResponse({ availableDays: 10 }) as any));
    const result = await service.getBalance('emp001', 'loc001');
    expect(result).toBe(10);
    expect(httpService.get).toHaveBeenCalledWith(
      'http://localhost:3001/hcm/balances/emp001/loc001',
      expect.objectContaining({ timeout: 5000 }),
    );
  });

  // T-U-37
  it('getBalance parses string balance "10.5" as numeric 10.5', async () => {
    httpService.get.mockReturnValue(of(makeAxiosResponse({ availableDays: '10.5' }) as any));
    const result = await service.getBalance('emp001', 'loc001');
    expect(result).toBe(10.5);
  });

  // T-U-38
  it('getBalance throws ServiceUnavailableException on 503', async () => {
    httpService.get.mockReturnValue(throwError(() => makeAxiosError(503)));
    await expect(service.getBalance('emp001', 'loc001')).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  // T-U-39
  it('getBalance throws ServiceUnavailableException on timeout', async () => {
    const timeoutErr: any = new Error('timeout');
    timeoutErr.code = 'ECONNABORTED';
    httpService.get.mockReturnValue(throwError(() => timeoutErr));
    await expect(service.getBalance('emp001', 'loc001')).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  // T-U-40
  it('getBalance throws ServiceUnavailableException when response contains NaN balance', async () => {
    httpService.get.mockReturnValue(of(makeAxiosResponse({ availableDays: 'invalid' }) as any));
    await expect(service.getBalance('emp001', 'loc001')).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  // T-U-41
  it('submitRequest makes POST to correct URL with correct body', async () => {
    httpService.post.mockReturnValue(
      of(makeAxiosResponse({ transactionId: 'txn-1', approved: true }) as any),
    );
    const payload = { employeeId: 'emp001', locationId: 'loc001', daysRequested: 3, requestId: 'req-1' };
    const result = await service.submitRequest(payload);
    expect(result).toEqual({ transactionId: 'txn-1', approved: true });
    expect(httpService.post).toHaveBeenCalledWith(
      'http://localhost:3001/hcm/requests',
      payload,
      expect.objectContaining({ timeout: 5000 }),
    );
  });

  // T-U-42
  it('submitRequest returns { approved: false } without throwing on 422', async () => {
    httpService.post.mockReturnValue(
      throwError(() => makeAxiosError(422, { error: 'Insufficient balance' })),
    );
    const result = await service.submitRequest({
      employeeId: 'emp001',
      locationId: 'loc001',
      daysRequested: 99,
      requestId: 'req-1',
    });
    expect(result).toMatchObject({ approved: false, transactionId: null });
  });

  // T-U-43
  it('submitRequest throws ServiceUnavailableException on 503', async () => {
    httpService.post.mockReturnValue(throwError(() => makeAxiosError(503)));
    await expect(
      service.submitRequest({ employeeId: 'emp001', locationId: 'loc001', daysRequested: 3, requestId: 'req-1' }),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  // T-U-44
  it('getBalance throws NotFoundException on 404', async () => {
    httpService.get.mockReturnValue(throwError(() => makeAxiosError(404)));
    await expect(service.getBalance('emp001', 'loc001')).rejects.toThrow(NotFoundException);
  });

  // T-U-45
  it('getBalance throws ServiceUnavailableException on unexpected error (not 404/5xx)', async () => {
    httpService.get.mockReturnValue(throwError(() => makeAxiosError(400)));
    await expect(service.getBalance('emp001', 'loc001')).rejects.toThrow(ServiceUnavailableException);
  });

  // T-U-46
  it('submitRequest throws NotFoundException on 404', async () => {
    httpService.post.mockReturnValue(throwError(() => makeAxiosError(404)));
    await expect(
      service.submitRequest({ employeeId: 'emp001', locationId: 'loc001', daysRequested: 3, requestId: 'req-1' }),
    ).rejects.toThrow(NotFoundException);
  });

  // T-U-47
  it('submitRequest throws ServiceUnavailableException on unexpected error (not 422/404/5xx)', async () => {
    httpService.post.mockReturnValue(throwError(() => makeAxiosError(400)));
    await expect(
      service.submitRequest({ employeeId: 'emp001', locationId: 'loc001', daysRequested: 3, requestId: 'req-1' }),
    ).rejects.toThrow(ServiceUnavailableException);
  });
});
