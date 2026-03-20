import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { HcmService } from './hcm.service';

@Module({
  imports: [HttpModule],
  providers: [HcmService],
  exports: [HcmService],
})
export class HcmModule {}
