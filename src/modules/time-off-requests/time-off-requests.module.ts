import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HttpModule } from '@nestjs/axios';
import { TimeOffRequest } from '../../database/entities/time-off-request.entity';
import { TimeOffRequestsService } from './time-off-requests.service';
import { TimeOffRequestsController } from './time-off-requests.controller';
import { BalancesModule } from '../balances/balances.module';

@Module({
  imports: [TypeOrmModule.forFeature([TimeOffRequest]), HttpModule, BalancesModule],
  providers: [TimeOffRequestsService],
  controllers: [TimeOffRequestsController],
  exports: [TimeOffRequestsService],
})
export class TimeOffRequestsModule {}
