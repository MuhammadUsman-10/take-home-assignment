import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HttpModule } from '@nestjs/axios';
import { Balance } from '../../database/entities/balance.entity';
import { SyncLog } from '../../database/entities/sync-log.entity';
import { HcmSyncService } from './hcm-sync.service';
import { BalancesModule } from '../balances/balances.module';

@Module({
  imports: [TypeOrmModule.forFeature([Balance, SyncLog]), HttpModule, BalancesModule],
  providers: [HcmSyncService],
  exports: [HcmSyncService],
})
export class HcmSyncModule {}
