import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { HttpModule } from '@nestjs/axios';
import { ThrottlerModule } from '@nestjs/throttler';
import { appConfig } from './config/app.config';
import { databaseConfig } from './config/database.config';
import { hcmConfig } from './config/hcm.config';
import { BalancesModule } from './modules/balances/balances.module';
import { TimeOffRequestsModule } from './modules/time-off-requests/time-off-requests.module';
import { HcmSyncModule } from './modules/hcm-sync/hcm-sync.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
import { Employee } from './database/entities/employee.entity';
import { Location } from './database/entities/location.entity';
import { LeaveType } from './database/entities/leave-type.entity';
import { Balance } from './database/entities/balance.entity';
import { TimeOffRequest } from './database/entities/time-off-request.entity';
import { SyncLog } from './database/entities/sync-log.entity';

@Module({
  imports: [
    // Config (validated)
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, databaseConfig, hcmConfig],
      envFilePath: ['.env', '.env.local'],
    }),

    // Database
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        type: 'better-sqlite3',
        database: cfg.get<string>('database.path', 'data/time-off.db'),
        entities: [Employee, Location, LeaveType, Balance, TimeOffRequest, SyncLog],
        migrations: [__dirname + '/database/migrations/*{.ts,.js}'],
        migrationsRun: true,
        synchronize: cfg.get<boolean>('database.synchronize', false),
        logging: cfg.get<string>('NODE_ENV') === 'development',
      }),
    }),

    // Scheduling (reconciliation jobs)
    ScheduleModule.forRoot(),

    // HTTP (for HCM calls)
    HttpModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        baseURL: cfg.get<string>('hcm.baseUrl'),
        timeout: cfg.get<number>('hcm.timeout', 10000),
        headers: {
          'X-API-Key': cfg.get<string>('hcm.apiKey', ''),
          'Content-Type': 'application/json',
        },
      }),
    }),

    // Rate limiting
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),

    // Feature modules
    AuthModule,
    BalancesModule,
    TimeOffRequestsModule,
    HcmSyncModule,
    WebhooksModule,
    HealthModule,
  ],
})
export class AppModule {}
