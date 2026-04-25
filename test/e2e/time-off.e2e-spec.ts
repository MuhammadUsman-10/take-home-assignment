import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { HttpModule } from '@nestjs/axios';
import { ThrottlerModule } from '@nestjs/throttler';
import * as http from 'http';

// Import mock HCM app
import { app as mockHcmApp } from '../../mock-hcm/src/index';

import { AppModule } from '../../src/app.module';
import { Employee } from '../../src/database/entities/employee.entity';
import { Balance } from '../../src/database/entities/balance.entity';
import { TimeOffRequest } from '../../src/database/entities/time-off-request.entity';
import { SyncLog } from '../../src/database/entities/sync-log.entity';
import { LeaveType } from '../../src/database/entities/leave-type.entity';
import { Location } from '../../src/database/entities/location.entity';
import { JwtService } from '@nestjs/jwt';
import { BalancesModule } from '../../src/modules/balances/balances.module';
import { TimeOffRequestsModule } from '../../src/modules/time-off-requests/time-off-requests.module';
import { HcmSyncModule } from '../../src/modules/hcm-sync/hcm-sync.module';
import { WebhooksModule } from '../../src/modules/webhooks/webhooks.module';
import { AuthModule } from '../../src/modules/auth/auth.module';
import { HealthModule } from '../../src/modules/health/health.module';
import { HttpExceptionFilter } from '../../src/common/filters/http-exception.filter';
import { LoggingInterceptor } from '../../src/common/interceptors/logging.interceptor';
import { TransformInterceptor } from '../../src/common/interceptors/transform.interceptor';

const HCM_PORT = 4099; // Use a unique port for tests

describe('Time-Off Microservice E2E', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;
  let mockHcmServer: http.Server;

  // Test employee data
  let employeeToken: string;
  let managerToken: string;
  let employee: Employee;
  let manager: Employee;

  beforeAll(async () => {
    // Start mock HCM server
    mockHcmServer = mockHcmApp.listen(HCM_PORT);

    // Reset HCM state
    await request(mockHcmApp).post('/hcm/admin/reset');

    // Build NestJS app with in-memory SQLite
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [
            () => ({ app: { jwtSecret: 'test-secret', jwtExpiresIn: '1h', webhookHmacSecret: '' } }),
            () => ({ database: { path: ':memory:', synchronize: true } }),
            () => ({ hcm: { baseUrl: `http://localhost:${HCM_PORT}`, apiKey: 'test', timeout: 5000, maxRetries: 1 } }),
          ],
        }),
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          entities: [Employee, Balance, TimeOffRequest, SyncLog, LeaveType, Location],
          synchronize: true,
        }),
        ScheduleModule.forRoot(),
        HttpModule.register({ baseURL: `http://localhost:${HCM_PORT}` }),
        ThrottlerModule.forRoot([{ ttl: 60000, limit: 1000 }]),
        AuthModule,
        BalancesModule,
        TimeOffRequestsModule,
        HcmSyncModule,
        WebhooksModule,
        HealthModule,
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(new LoggingInterceptor(), new TransformInterceptor());
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    jwtService = moduleFixture.get(JwtService);

    // Seed test employees
    const employeeRepo = dataSource.getRepository(Employee);
    employee = await employeeRepo.save({
      name: 'Alice Employee',
      email: 'alice@test.com',
      hcmEmployeeId: 'emp-001',
      locationId: 'loc-nyc',
      role: 'employee',
    });
    manager = await employeeRepo.save({
      name: 'Bob Manager',
      email: 'bob@test.com',
      hcmEmployeeId: 'emp-mgr',
      locationId: 'loc-nyc',
      role: 'manager',
    });

    // Seed initial balance
    const balanceRepo = dataSource.getRepository(Balance);
    await balanceRepo.save({
      employeeId: employee.id,
      locationId: 'loc-nyc',
      leaveTypeId: 'VACATION',
      totalDays: 15,
      usedDays: 3,
      reservedDays: 0,
    });

    // Generate tokens
    employeeToken = jwtService.sign({
      sub: employee.id, email: employee.email, role: 'employee',
      hcmEmployeeId: employee.hcmEmployeeId, locationId: employee.locationId,
    });
    managerToken = jwtService.sign({
      sub: manager.id, email: manager.email, role: 'manager',
      hcmEmployeeId: manager.hcmEmployeeId, locationId: manager.locationId,
    });
  });

  afterAll(async () => {
    await app.close();
    mockHcmServer.close();
  });

  // ─────────────────────────────────────────────────────────────
  // Health
  // ─────────────────────────────────────────────────────────────

  describe('GET /api/v1/health', () => {
    it('should return 200 with status ok', () => {
      return request(app.getHttpServer())
        .get('/api/v1/health')
        .expect(200)
        .expect((res) => {
          expect(res.body.data.status).toBe('ok');
        });
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Balances
  // ─────────────────────────────────────────────────────────────

  describe('GET /api/v1/balances/:employeeId/:locationId/:leaveTypeId', () => {
    it('should return current balance with availableDays', () => {
      return request(app.getHttpServer())
        .get(`/api/v1/balances/${employee.id}/loc-nyc/VACATION`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(200)
        .expect((res) => {
          expect(res.body.data.totalDays).toBe(15);
          expect(res.body.data.usedDays).toBe(3);
          expect(res.body.data.availableDays).toBe(12);
          expect(res.body.data.reservedDays).toBe(0);
        });
    });

    it('should return 404 for unknown employee', () => {
      return request(app.getHttpServer())
        .get('/api/v1/balances/unknown-emp/loc-nyc/VACATION')
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(404);
    });

    it('should return 401 without auth token', () => {
      return request(app.getHttpServer())
        .get(`/api/v1/balances/${employee.id}/loc-nyc/VACATION`)
        .expect(401);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Happy path: submit → HCM approves → balance deducted
  // ─────────────────────────────────────────────────────────────

  describe('POST /api/v1/time-off-requests — happy path', () => {
    it('should create PENDING request and eventually reach APPROVED via HCM', async () => {
      // Set HCM balance for this employee
      await request(mockHcmApp)
        .post('/hcm/admin/set-balance')
        .send({ employeeId: 'emp-001', locationId: 'loc-nyc', leaveTypeId: 'VACATION', totalDays: 15, usedDays: 3 });

      const res = await request(app.getHttpServer())
        .post('/api/v1/time-off-requests')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          employeeId: employee.id,
          locationId: 'loc-nyc',
          leaveTypeId: 'VACATION',
          startDate: '2026-07-01',
          endDate: '2026-07-05',
          days: 5,
          idempotencyKey: 'e2e-happy-path-001',
        })
        .expect(201);

      expect(res.body.data.status).toBe('PENDING');
      expect(res.body.data.idempotencyKey).toBe('e2e-happy-path-001');

      // Allow async HCM call to complete
      await new Promise((r) => setTimeout(r, 200));

      // Check the request was approved
      const requestId = res.body.data.id;
      const updated = await request(app.getHttpServer())
        .get(`/api/v1/time-off-requests/${requestId}`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(200);

      expect(updated.body.data.status).toBe('APPROVED');
      expect(updated.body.data.hcmRefId).toBeTruthy();

      // Verify local balance updated
      const balance = await request(app.getHttpServer())
        .get(`/api/v1/balances/${employee.id}/loc-nyc/VACATION`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(200);

      expect(balance.body.data.usedDays).toBe(8); // 3 + 5
      expect(balance.body.data.reservedDays).toBe(0);
      expect(balance.body.data.availableDays).toBe(7); // 15 - 8 - 0
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Idempotency: same key returns same result
  // ─────────────────────────────────────────────────────────────

  describe('Idempotency key', () => {
    it('should return the same request for duplicate idempotency key', async () => {
      const dto = {
        employeeId: employee.id,
        locationId: 'loc-nyc',
        leaveTypeId: 'VACATION',
        startDate: '2026-08-01',
        endDate: '2026-08-01',
        days: 1,
        idempotencyKey: 'idempotency-test-key-unique',
      };

      const first = await request(app.getHttpServer())
        .post('/api/v1/time-off-requests')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send(dto);

      const second = await request(app.getHttpServer())
        .post('/api/v1/time-off-requests')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send(dto);

      expect(first.body.data.id).toBe(second.body.data.id);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Insufficient balance — local defensive check
  // ─────────────────────────────────────────────────────────────

  describe('Insufficient balance', () => {
    it('should reject with 409 before calling HCM when balance is insufficient', async () => {
      // Employee has ~7 available days (15 - 8 - 0 after happy path)
      await request(app.getHttpServer())
        .post('/api/v1/time-off-requests')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          employeeId: employee.id,
          locationId: 'loc-nyc',
          leaveTypeId: 'VACATION',
          startDate: '2026-09-01',
          endDate: '2026-09-15',
          days: 100, // Clearly excessive
          idempotencyKey: 'insufficient-balance-test',
        })
        .expect(409);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Cancel flow
  // ─────────────────────────────────────────────────────────────

  describe('Cancel flow', () => {
    it('should cancel a PENDING request and restore reserved balance', async () => {
      // First reset balance so we have headroom
      const balanceRepo = dataSource.getRepository(Balance);
      await balanceRepo.update(
        { employeeId: employee.id, locationId: 'loc-nyc', leaveTypeId: 'VACATION' },
        { totalDays: 20, usedDays: 0, reservedDays: 0 },
      );

      // Temporarily break HCM so the request stays PENDING
      // (We'll submit with a leaveType that HCM doesn't know about)
      await request(app.getHttpServer())
        .post('/hcm/admin/set-balance')
        .send({ employeeId: 'emp-001', locationId: 'loc-nyc', leaveTypeId: 'PERSONAL', totalDays: 5, usedDays: 0 });

      await balanceRepo.save({
        employeeId: employee.id,
        locationId: 'loc-nyc',
        leaveTypeId: 'PERSONAL',
        totalDays: 5,
        usedDays: 0,
        reservedDays: 0,
      });

      const submitRes = await request(app.getHttpServer())
        .post('/api/v1/time-off-requests')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          employeeId: employee.id,
          locationId: 'loc-nyc',
          leaveTypeId: 'PERSONAL',
          startDate: '2026-10-01',
          endDate: '2026-10-02',
          days: 2,
          idempotencyKey: 'cancel-test-001',
        })
        .expect(201);

      const requestId = submitRes.body.data.id;

      // Cancel it
      await request(app.getHttpServer())
        .delete(`/api/v1/time-off-requests/${requestId}`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(200);

      // Verify cancelled
      const cancelled = await request(app.getHttpServer())
        .get(`/api/v1/time-off-requests/${requestId}`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(200);

      expect(cancelled.body.data.status).toBe('CANCELLED');

      // Verify reserved days restored
      const balance = await request(app.getHttpServer())
        .get(`/api/v1/balances/${employee.id}/loc-nyc/PERSONAL`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(200);

      expect(balance.body.data.reservedDays).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Batch sync
  // ─────────────────────────────────────────────────────────────

  describe('POST /api/v1/balances/sync/batch', () => {
    it('should ingest batch and update local balances', async () => {
      // Seed a new employee balance via batch
      const res = await request(app.getHttpServer())
        .post('/api/v1/balances/sync/batch')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          balances: [
            {
              employeeId: employee.id,
              locationId: 'loc-nyc',
              leaveTypeId: 'SICK',
              totalDays: 10,
              usedDays: 1,
            },
          ],
          source: 'e2e-test',
        })
        .expect(200);

      expect(res.body.data.processed).toBe(1);
      expect(res.body.data.conflicts).toHaveLength(0);
    });

    it('should detect and report conflicts (NEEDS_REVALIDATION)', async () => {
      // Setup: employee has 5 reserved days locally
      const balanceRepo = dataSource.getRepository(Balance);
      await balanceRepo.update(
        { employeeId: employee.id, locationId: 'loc-nyc', leaveTypeId: 'VACATION' },
        { totalDays: 15, usedDays: 0, reservedDays: 10 },
      );

      // Batch sync says only 3 days total
      const res = await request(app.getHttpServer())
        .post('/api/v1/balances/sync/batch')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          balances: [
            {
              employeeId: employee.id,
              locationId: 'loc-nyc',
              leaveTypeId: 'VACATION',
              totalDays: 3,
              usedDays: 0,
            },
          ],
        })
        .expect(200);

      expect(res.body.data.conflicts.length).toBeGreaterThan(0);
      expect(res.body.data.conflicts[0].reason).toContain('HCM available');
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Webhook — anniversary bonus
  // ─────────────────────────────────────────────────────────────

  describe('POST /api/v1/webhooks/hcm/balance-update — anniversary bonus', () => {
    it('should update local balance when HCM pushes an anniversary bonus', async () => {
      // Reset balance
      const balanceRepo = dataSource.getRepository(Balance);
      await balanceRepo.update(
        { employeeId: employee.id, locationId: 'loc-nyc', leaveTypeId: 'VACATION' },
        { totalDays: 15, usedDays: 0, reservedDays: 0 },
      );

      // Webhook push
      const res = await request(app.getHttpServer())
        .post('/api/v1/webhooks/hcm/balance-update')
        .send({
          employeeId: employee.id,
          locationId: 'loc-nyc',
          leaveTypeId: 'VACATION',
          totalDays: 20, // 5 bonus days added by HCM
          usedDays: 0,
          reason: 'ANNIVERSARY_BONUS',
        })
        .expect(200);

      expect(res.body.data.balance.totalDays).toBe(20);

      // Verify via balance endpoint
      const balance = await request(app.getHttpServer())
        .get(`/api/v1/balances/${employee.id}/loc-nyc/VACATION`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(200);

      expect(balance.body.data.totalDays).toBe(20);
      expect(balance.body.data.availableDays).toBe(20);
    });

    it('should be idempotent — same webhook payload applied twice yields same result', async () => {
      const payload = {
        employeeId: employee.id,
        locationId: 'loc-nyc',
        leaveTypeId: 'VACATION',
        totalDays: 18,
        usedDays: 2,
        reason: 'YEAR_START_REFRESH',
      };

      await request(app.getHttpServer())
        .post('/api/v1/webhooks/hcm/balance-update')
        .send(payload)
        .expect(200);

      await request(app.getHttpServer())
        .post('/api/v1/webhooks/hcm/balance-update')
        .send(payload)
        .expect(200);

      const balance = await request(app.getHttpServer())
        .get(`/api/v1/balances/${employee.id}/loc-nyc/VACATION`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(200);

      expect(balance.body.data.totalDays).toBe(18);
      expect(balance.body.data.usedDays).toBe(2);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Input validation
  // ─────────────────────────────────────────────────────────────

  describe('Input validation', () => {
    it('should return 400 for missing required fields', async () => {
      return request(app.getHttpServer())
        .post('/api/v1/time-off-requests')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ employeeId: employee.id }) // missing most fields
        .expect(400);
    });

    it('should return 400 for negative days', async () => {
      return request(app.getHttpServer())
        .post('/api/v1/time-off-requests')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          employeeId: employee.id,
          locationId: 'loc-nyc',
          leaveTypeId: 'VACATION',
          startDate: '2026-06-01',
          endDate: '2026-06-05',
          days: -1,
          idempotencyKey: 'neg-days-test',
        })
        .expect(400);
    });

    it('should return 403 when employee tries to approve (manager-only action)', async () => {
      return request(app.getHttpServer())
        .patch('/api/v1/time-off-requests/some-id/approve')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({})
        .expect(403);
    });
  });
});
