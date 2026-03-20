import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { BalanceService } from './balance.service';

@ApiTags('balances')
@Controller('balances')
export class BalanceController {
  constructor(private readonly balanceService: BalanceService) {}

  @Get(':employeeId/:locationId')
  @ApiOperation({ summary: 'Get leave balance for an employee at a location' })
  @ApiParam({ name: 'employeeId', description: 'Employee identifier' })
  @ApiParam({ name: 'locationId', description: 'Location identifier' })
  @ApiResponse({ status: 200, description: 'Balance found' })
  @ApiResponse({ status: 404, description: 'Balance not found (BALANCE_NOT_FOUND)' })
  getBalance(
    @Param('employeeId') employeeId: string,
    @Param('locationId') locationId: string,
  ) {
    return this.balanceService.getBalance(employeeId, locationId);
  }
}
