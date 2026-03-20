import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SyncLog } from './sync-log.entity';
import { SyncService } from './sync.service';
import { SyncController } from './sync.controller';
import { BalanceModule } from '../balance/balance.module';
import { HcmModule } from '../hcm/hcm.module';
import { LeaveBalance } from '../balance/leave-balance.entity';
import { TimeOffRequest } from '../request/time-off-request.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([SyncLog, LeaveBalance, TimeOffRequest]),
    BalanceModule,
    HcmModule,
  ],
  providers: [SyncService],
  controllers: [SyncController],
  exports: [SyncService],
})
export class SyncModule {}
