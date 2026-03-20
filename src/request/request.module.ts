import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TimeOffRequest } from './time-off-request.entity';
import { RequestService } from './request.service';
import { RequestController } from './request.controller';
import { BalanceModule } from '../balance/balance.module';
import { HcmModule } from '../hcm/hcm.module';

@Module({
  imports: [TypeOrmModule.forFeature([TimeOffRequest]), BalanceModule, HcmModule],
  providers: [RequestService],
  controllers: [RequestController],
  exports: [RequestService],
})
export class RequestModule {}
