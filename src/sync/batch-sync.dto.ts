import { IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { BatchSyncRecordDto } from '../common/dto/batch-sync-record.dto';

export class BatchSyncDto {
  @ApiProperty({ type: [BatchSyncRecordDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BatchSyncRecordDto)
  records: BatchSyncRecordDto[];
}
