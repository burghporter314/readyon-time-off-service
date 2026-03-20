import { DataSource } from 'typeorm';
import { LeaveBalance } from '../../src/balance/leave-balance.entity';
import { TimeOffRequest } from '../../src/request/time-off-request.entity';
import { SyncLog } from '../../src/sync/sync-log.entity';

export async function createTestDataSource(): Promise<DataSource> {
  const ds = new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    entities: [LeaveBalance, TimeOffRequest, SyncLog],
    synchronize: true,
    dropSchema: true,
  });
  await ds.initialize();
  return ds;
}

export async function seedBalance(
  ds: DataSource,
  overrides: Partial<LeaveBalance> = {},
): Promise<LeaveBalance> {
  const repo = ds.getRepository(LeaveBalance);
  const balance = repo.create({
    employeeId: 'emp001',
    locationId: 'loc001',
    availableDays: 10,
    pendingDays: 0,
    ...overrides,
  });
  return repo.save(balance);
}
