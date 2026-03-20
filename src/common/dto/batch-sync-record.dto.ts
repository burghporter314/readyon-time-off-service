import { IsISO8601, IsNumber, IsString, Min } from 'class-validator';

export class BatchSyncRecordDto {
  @IsString()
  employeeId: string;

  @IsString()
  locationId: string;

  @IsNumber()
  @Min(0)
  availableDays: number;

  @IsISO8601()
  syncTimestamp: string;
}
