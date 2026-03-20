import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SyncService } from './sync.service';
import { BatchSyncDto } from './batch-sync.dto';

@ApiTags('sync')
@Controller('sync')
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @Post('batch')
  @HttpCode(200)
  @ApiOperation({
    summary: 'HCM-initiated batch balance sync',
    description:
      'Accepts a corpus of balance records from the HCM. All upserts are atomic — any invalid record rejects the entire batch.',
  })
  @ApiResponse({ status: 200, description: 'Batch processed' })
  @ApiResponse({ status: 400, description: 'Invalid record in batch — zero writes performed' })
  batchSync(@Body() dto: BatchSyncDto) {
    return this.syncService.batchSync(dto.records);
  }

  @Post('refresh/:employeeId/:locationId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Pull current balance from HCM for one employee/location' })
  @ApiParam({ name: 'employeeId' })
  @ApiParam({ name: 'locationId' })
  @ApiResponse({ status: 200, description: 'Balance refreshed' })
  @ApiResponse({ status: 503, description: 'HCM unreachable' })
  refreshOne(
    @Param('employeeId') employeeId: string,
    @Param('locationId') locationId: string,
  ) {
    return this.syncService.refreshOne(employeeId, locationId);
  }
}
