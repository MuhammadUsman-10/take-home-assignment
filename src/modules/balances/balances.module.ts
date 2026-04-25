import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HttpModule } from '@nestjs/axios';
import { Balance } from '../../database/entities/balance.entity';
import { Employee } from '../../database/entities/employee.entity';
import { SyncLog } from '../../database/entities/sync-log.entity';
import { BalancesService } from './balances.service';
import { BalancesController } from './balances.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Balance, Employee, SyncLog]), HttpModule],
  providers: [BalancesService],
  controllers: [BalancesController],
  exports: [BalancesService],
})
export class BalancesModule {}
