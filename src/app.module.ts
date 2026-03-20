import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { LeaveBalance } from './balance/leave-balance.entity';
import { TimeOffRequest } from './request/time-off-request.entity';
import { SyncLog } from './sync/sync-log.entity';
import { BalanceModule } from './balance/balance.module';
import { RequestModule } from './request/request.module';
import { SyncModule } from './sync/sync.module';
import { HcmModule } from './hcm/hcm.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'better-sqlite3',
        database: config.get<string>('DB_PATH', './time_off.db'),
        entities: [LeaveBalance, TimeOffRequest, SyncLog],
        synchronize: true,
      }),
      dataSourceFactory: async (options) => {
        const dataSource = new DataSource(options!);
        await dataSource.initialize();

        // Configure SQLite pragmas as required by TRD (C-02)
        await dataSource.query('PRAGMA journal_mode=WAL;');
        await dataSource.query('PRAGMA busy_timeout=5000;');

        return dataSource;
      },
    }),
    BalanceModule,
    RequestModule,
    SyncModule,
    HcmModule,
  ],
})
export class AppModule {}
