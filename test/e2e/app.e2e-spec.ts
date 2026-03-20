import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import supertest from 'supertest';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import { BalanceModule } from '../../src/balance/balance.module';
import { RequestModule } from '../../src/request/request.module';
import { SyncModule } from '../../src/sync/sync.module';
import { HcmModule } from '../../src/hcm/hcm.module';
import { LeaveBalance } from '../../src/balance/leave-balance.entity';
import { TimeOffRequest } from '../../src/request/time-off-request.entity';
import { SyncLog } from '../../src/sync/sync-log.entity';
import { DataSource } from 'typeorm';
import * as http from 'http';

const HCM_PORT = 3099; // use different port to avoid conflicts

async function waitForHcm(retries = 20): Promise<void> {
  for (let i = 0; i < retries; i++) {
    await new Promise(r => setTimeout(r, 300));
    const ok = await new Promise<boolean>(resolve => {
      const req = http.get(`http://localhost:${HCM_PORT}/hcm/balances/emp001/loc001`, (res: any) => resolve(res.statusCode === 200));
      req.on('error', () => resolve(false));
    });
    if (ok) return;
  }
  throw new Error('Mock HCM did not start in time');
}

describe('E2E — ReadyOn Time-Off Service', () => {
  let app: INestApplication;
  let request: supertest.SuperTest<supertest.Test>;
  let hcmProcess: ChildProcess;
  let dataSource: DataSource;

  beforeAll(async () => {
    // Start mock HCM as child process
    hcmProcess = spawn(
      'node',
      [path.join(__dirname, '../../mock-hcm/server.js')],
      {
        env: {
          ...process.env,
          HCM_MOCK_PORT: String(HCM_PORT),
          MOCK_FAILURE_RATE: '0',
        },
        stdio: 'pipe',
      },
    );
    hcmProcess.stderr?.on('data', (d) => process.stderr.write(d));

    await waitForHcm();

    // Set before compile() so ConfigModule caches the correct URL
    process.env.HCM_BASE_URL = `http://localhost:${HCM_PORT}`;

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          entities: [LeaveBalance, TimeOffRequest, SyncLog],
          synchronize: true,
          dropSchema: true,
        }),
        BalanceModule,
        RequestModule,
        SyncModule,
        HcmModule,
      ],
    })
      .overrideProvider('HCM_BASE_URL' as any)
      .useValue(`http://localhost:${HCM_PORT}`)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

    const swaggerConfig = new DocumentBuilder().setTitle('Test').build();
    SwaggerModule.setup('api-docs', app, SwaggerModule.createDocument(app, swaggerConfig));

    await app.init();
    dataSource = moduleRef.get(DataSource);
    request = supertest(app.getHttpServer());
  }, 30000);

  afterAll(async () => {
    await app.close();
    hcmProcess.kill();
  });

  beforeEach(async () => {
    // Reset mock HCM seed data
    await supertest(`http://localhost:${HCM_PORT}`).post('/hcm/admin/reset').expect(200);
    // Clear DB tables
    await dataSource.query('DELETE FROM time_off_request');
    await dataSource.query('DELETE FROM sync_log');
    await dataSource.query('DELETE FROM leave_balance');
    // Seed a balance for emp001/loc001
    await dataSource.query(
      `INSERT INTO leave_balance (id, employeeId, locationId, availableDays, pendingDays, version, createdAt, updatedAt)
       VALUES ('bal-seed-1', 'emp001', 'loc001', 15, 0, 1, datetime('now'), datetime('now'))`,
    );
  });

  // T-E-01
  it('GET /balances/emp001/loc001 → 200 with availableDays=15', async () => {
    const res = await request.get('/balances/emp001/loc001').expect(200);
    expect(Number(res.body.availableDays)).toBe(15);
    expect(Number(res.body.pendingDays)).toBe(0);
  });

  // T-E-02
  it('GET /balances/unknown/loc999 → 404 with BALANCE_NOT_FOUND', async () => {
    const res = await request.get('/balances/unknown/loc999').expect(404);
    expect(res.body.error).toBe('BALANCE_NOT_FOUND');
  });

  // T-E-03
  it('POST /requests valid body → 201 with id and status', async () => {
    const res = await request
      .post('/requests')
      .send({ employeeId: 'emp001', locationId: 'loc001', startDate: '2025-06-01', endDate: '2025-06-03', daysRequested: 3 })
      .expect(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.status).toBeTruthy();
  });

  // T-E-04
  it('POST /requests with daysRequested > availableDays → 422', async () => {
    await request
      .post('/requests')
      .send({ employeeId: 'emp001', locationId: 'loc001', startDate: '2025-06-01', endDate: '2025-06-30', daysRequested: 99 })
      .expect(422);
  });

  // T-E-05
  it('POST /requests missing required field locationId → 400', async () => {
    await request
      .post('/requests')
      .send({ employeeId: 'emp001', startDate: '2025-06-01', endDate: '2025-06-03', daysRequested: 3 })
      .expect(400);
  });

  // T-E-06
  it('POST /requests with startDate after endDate → 400', async () => {
    await request
      .post('/requests')
      .send({ employeeId: 'emp001', locationId: 'loc001', startDate: '2025-06-10', endDate: '2025-06-05', daysRequested: 3 })
      .expect(400);
  });

  // T-E-07
  it('POST /requests with daysRequested = 0 → 400', async () => {
    await request
      .post('/requests')
      .send({ employeeId: 'emp001', locationId: 'loc001', startDate: '2025-06-01', endDate: '2025-06-03', daysRequested: 0 })
      .expect(400);
  });

  // T-E-08
  it('POST /requests with extra field isAdmin=true → 201; stored request has no isAdmin field', async () => {
    const res = await request
      .post('/requests')
      .send({ employeeId: 'emp001', locationId: 'loc001', startDate: '2025-06-01', endDate: '2025-06-03', daysRequested: 3, isAdmin: true })
      .expect(201);
    expect((res.body as any).isAdmin).toBeUndefined();
  });

  // T-E-09
  it('GET /requests/:id → 200 with correct request', async () => {
    const createRes = await request
      .post('/requests')
      .send({ employeeId: 'emp001', locationId: 'loc001', startDate: '2025-06-01', endDate: '2025-06-03', daysRequested: 3 })
      .expect(201);
    const getRes = await request.get(`/requests/${createRes.body.id}`).expect(200);
    expect(getRes.body.id).toBe(createRes.body.id);
  });

  // T-E-10
  it('GET /requests/nonexistent-id → 404', async () => {
    await request.get('/requests/00000000-0000-0000-0000-000000000000').expect(404);
  });

  // T-E-11
  it('full approval workflow: POST → approve → GET → APPROVED; pendingDays=0', async () => {
    // Use HCM outage to freeze in PENDING_HCM_CONFIRMATION so pendingDays stays at 3
    await supertest(`http://localhost:${HCM_PORT}`).post('/hcm/admin/set-failure-rate').send({ rate: 1.0 }).expect(200);
    const createRes = await request
      .post('/requests')
      .send({ employeeId: 'emp001', locationId: 'loc001', startDate: '2025-06-01', endDate: '2025-06-03', daysRequested: 3 })
      .expect(201);
    await supertest(`http://localhost:${HCM_PORT}`).post('/hcm/admin/set-failure-rate').send({ rate: 0 }).expect(200);
    const id = createRes.body.id;

    // Force to PENDING so we can approve it
    await dataSource.query(`UPDATE time_off_request SET status = 'PENDING' WHERE id = '${id}'`);
    await request.patch(`/requests/${id}/approve`).expect(200);

    const getRes = await request.get(`/requests/${id}`).expect(200);
    expect(getRes.body.status).toBe('APPROVED');

    const balRes = await request.get('/balances/emp001/loc001').expect(200);
    expect(Number(balRes.body.pendingDays)).toBe(0);
  });

  // T-E-12
  it('PATCH /approve on already-APPROVED request → 409', async () => {
    const createRes = await request
      .post('/requests')
      .send({ employeeId: 'emp001', locationId: 'loc001', startDate: '2025-06-01', endDate: '2025-06-03', daysRequested: 3 })
      .expect(201);
    const id = createRes.body.id;
    await dataSource.query(`UPDATE time_off_request SET status = 'APPROVED' WHERE id = '${id}'`);
    await request.patch(`/requests/${id}/approve`).expect(409);
  });

  // T-E-13
  it('PATCH /cancel on PENDING → 200; balance restored', async () => {
    const before = await request.get('/balances/emp001/loc001').expect(200);
    const originalAvailable = Number(before.body.availableDays);

    // Use HCM outage to get PENDING_HCM_CONFIRMATION, then force PENDING
    await supertest(`http://localhost:${HCM_PORT}`).post('/hcm/admin/set-failure-rate').send({ rate: 1.0 }).expect(200);
    const createRes = await request
      .post('/requests')
      .send({ employeeId: 'emp001', locationId: 'loc001', startDate: '2025-06-01', endDate: '2025-06-03', daysRequested: 3 })
      .expect(201);
    await supertest(`http://localhost:${HCM_PORT}`).post('/hcm/admin/set-failure-rate').send({ rate: 0 }).expect(200);

    const id = createRes.body.id;
    await dataSource.query(`UPDATE time_off_request SET status = 'PENDING' WHERE id = '${id}'`);
    await request.patch(`/requests/${id}/cancel`).expect(200);

    const after = await request.get('/balances/emp001/loc001').expect(200);
    expect(Number(after.body.availableDays)).toBe(originalAvailable);
  });

  // T-E-14
  it('POST /sync/batch → 200; GET /balances reflects new availableDays', async () => {
    const ts = new Date().toISOString();
    const res = await request
      .post('/sync/batch')
      .send({ records: [{ employeeId: 'emp001', locationId: 'loc001', availableDays: 20, syncTimestamp: ts }] })
      .expect(200);
    expect(res.body.updated).toBe(1);
    const balRes = await request.get('/balances/emp001/loc001').expect(200);
    expect(Number(balRes.body.availableDays)).toBe(20);
  });

  // T-E-15
  it('POST /sync/batch with availableDays = -1 → 400; balance unchanged', async () => {
    await request
      .post('/sync/batch')
      .send({ records: [{ employeeId: 'emp001', locationId: 'loc001', availableDays: -1, syncTimestamp: new Date().toISOString() }] })
      .expect(400);
    const balRes = await request.get('/balances/emp001/loc001').expect(200);
    expect(Number(balRes.body.availableDays)).toBe(15); // unchanged
  });

  // T-E-16
  it('POST /sync/batch with empty records → 200 { updated:0, autoCancelled:0, skipped:0 }', async () => {
    const res = await request.post('/sync/batch').send({ records: [] }).expect(200);
    expect(res.body).toEqual({ updated: 0, autoCancelled: 0, skipped: 0 });
  });

  // T-E-17
  it('POST /sync/refresh/emp001/loc001 → 200; lastHcmSyncAt updated', async () => {
    const res = await request.post('/sync/refresh/emp001/loc001').expect(200);
    expect(res.body.lastHcmSyncAt).toBeTruthy();
    // HCM mock has 15 for emp001/loc001
    expect(Number(res.body.availableDays)).toBe(15);
  });

  // T-E-18
  it('batch auto-cancel: PENDING request with syncTimestamp AFTER createdAt → CANCELLED', async () => {
    // Use HCM outage to freeze in PENDING_HCM_CONFIRMATION
    await supertest(`http://localhost:${HCM_PORT}`).post('/hcm/admin/set-failure-rate').send({ rate: 1.0 });
    const createRes = await request
      .post('/requests')
      .send({ employeeId: 'emp001', locationId: 'loc001', startDate: '2025-06-01', endDate: '2025-06-08', daysRequested: 8 })
      .expect(201);
    await supertest(`http://localhost:${HCM_PORT}`).post('/hcm/admin/set-failure-rate').send({ rate: 0 });
    const id = createRes.body.id;
    // Force to PENDING
    await dataSource.query(`UPDATE time_off_request SET status = 'PENDING' WHERE id = '${id}'`);

    // Send a batch with syncTimestamp in the future relative to createdAt
    const syncTs = new Date(Date.now() + 5000).toISOString();
    await request
      .post('/sync/batch')
      .send({ records: [{ employeeId: 'emp001', locationId: 'loc001', availableDays: 3, syncTimestamp: syncTs }] })
      .expect(200);

    const getRes = await request.get(`/requests/${id}`).expect(200);
    expect(getRes.body.status).toBe('CANCELLED');
  });

  // T-E-19
  it('HCM outage → POST /requests → 201 with status PENDING_HCM_CONFIRMATION', async () => {
    await supertest(`http://localhost:${HCM_PORT}`).post('/hcm/admin/set-failure-rate').send({ rate: 1.0 }).expect(200);
    const res = await request
      .post('/requests')
      .send({ employeeId: 'emp001', locationId: 'loc001', startDate: '2025-06-01', endDate: '2025-06-03', daysRequested: 3 })
      .expect(201);
    expect(res.body.status).toBe('PENDING_HCM_CONFIRMATION');
    await supertest(`http://localhost:${HCM_PORT}`).post('/hcm/admin/set-failure-rate').send({ rate: 0 }).expect(200);
  });

  // T-E-20
  it('scheduling engine simulation: GET /balances after approval < 50ms; availableDays correct', async () => {
    const createRes = await request
      .post('/requests')
      .send({ employeeId: 'emp001', locationId: 'loc001', startDate: '2025-06-01', endDate: '2025-06-03', daysRequested: 3 })
      .expect(201);
    const id = createRes.body.id;
    await dataSource.query(`UPDATE time_off_request SET status = 'PENDING' WHERE id = '${id}'`);
    // Reset available after approve
    await dataSource.query(`UPDATE leave_balance SET availableDays = 12, pendingDays = 3 WHERE employeeId = 'emp001'`);
    await request.patch(`/requests/${id}/approve`).expect(200);

    const start = Date.now();
    const balRes = await request.get('/balances/emp001/loc001').expect(200);
    const elapsed = Date.now() - start;

    expect(Number(balRes.body.availableDays)).toBe(12);
    expect(Number(balRes.body.pendingDays)).toBe(0);
    expect(elapsed).toBeLessThan(50);
  });

  // T-E-21
  it('GET /api-docs → 200 (Swagger UI accessible)', async () => {
    await request.get('/api-docs').expect(200);
  });
});
