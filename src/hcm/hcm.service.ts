import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { parseHcmBalance } from '../common/utils/balance.util';

@Injectable()
export class HcmService {
  private readonly baseUrl: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.baseUrl = this.configService.get<string>(
      'HCM_BASE_URL',
      'http://localhost:3001',
    );
  }

  async getBalance(employeeId: string, locationId: string): Promise<number> {
    try {
      const response = await firstValueFrom(
        this.httpService.get(
          `${this.baseUrl}/hcm/balances/${employeeId}/${locationId}`,
          { timeout: 5000 },
        ),
      );
      return parseHcmBalance(response.data.availableDays);
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      if (err?.response?.status === 404)
        throw new NotFoundException('Employee/location not found in HCM');
      if (err?.response?.status >= 500 || err?.code === 'ECONNABORTED') {
        throw new ServiceUnavailableException('HCM unavailable');
      }
      throw new ServiceUnavailableException('HCM unavailable');
    }
  }

  async submitRequest(payload: {
    employeeId: string;
    locationId: string;
    daysRequested: number;
    requestId: string;
  }): Promise<{ transactionId: string | null; approved: boolean; message?: string }> {
    try {
      const response = await firstValueFrom(
        this.httpService.post(`${this.baseUrl}/hcm/requests`, payload, {
          timeout: 5000,
        }),
      );
      return {
        transactionId: response.data.transactionId,
        approved: response.data.approved,
      };
    } catch (err) {
      if (err?.response?.status === 422) {
        return {
          transactionId: null,
          approved: false,
          message: err.response.data?.error,
        };
      }
      if (err?.response?.status === 404) {
        throw new NotFoundException('Employee/location not found in HCM');
      }
      if (err?.response?.status >= 500 || err?.code === 'ECONNABORTED') {
        throw new ServiceUnavailableException('HCM unavailable');
      }
      throw new ServiceUnavailableException('HCM unavailable');
    }
  }
}
