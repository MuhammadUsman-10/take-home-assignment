import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { BalancesModule } from '../balances/balances.module';

@Module({
  imports: [BalancesModule],
  controllers: [WebhooksController],
})
export class WebhooksModule {}
