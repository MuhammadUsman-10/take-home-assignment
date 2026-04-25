import {
  Controller, Post, Body, Headers, UnauthorizedException, HttpCode, HttpStatus, Logger,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsNumber, IsString, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { createHmac } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { BalancesService } from '../balances/balances.service';

class HcmBalanceUpdateDto {
  @ApiProperty({ example: 'emp-001' })
  @IsString()
  employeeId: string;

  @ApiProperty({ example: 'loc-nyc' })
  @IsString()
  locationId: string;

  @ApiProperty({ example: 'VACATION' })
  @IsString()
  leaveTypeId: string;

  @ApiProperty({ example: 15 })
  @IsNumber()
  @Min(0)
  totalDays: number;

  @ApiProperty({ example: 3 })
  @IsNumber()
  @Min(0)
  usedDays: number;

  @ApiProperty({ example: 'ANNIVERSARY_BONUS', description: 'Reason for balance change' })
  @IsString()
  reason: string;
}

@ApiTags('webhooks')
@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly balancesService: BalancesService,
    private readonly configService: ConfigService,
  ) {}

  @Post('hcm/balance-update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Inbound HCM balance update webhook (HMAC verified)',
    description:
      'HCM pushes balance changes (e.g. anniversary bonus, yearly refresh). ' +
      'Requires X-HCM-Signature header with HMAC-SHA256 of the raw request body.',
  })
  async handleBalanceUpdate(
    @Body() dto: HcmBalanceUpdateDto,
    @Headers('x-hcm-signature') signature: string,
  ) {
    this.verifyHmacSignature(JSON.stringify(dto), signature);

    this.logger.log(
      `HCM webhook: balance update for employee=${dto.employeeId} ` +
      `location=${dto.locationId} leaveType=${dto.leaveTypeId} reason=${dto.reason}`,
    );

    const updated = await this.balancesService.applyWebhookUpdate(
      dto.employeeId,
      dto.locationId,
      dto.leaveTypeId,
      dto.totalDays,
      dto.usedDays,
    );

    return { message: 'Balance updated', balance: updated };
  }

  private verifyHmacSignature(rawBody: string, signature: string): void {
    const secret = this.configService.get<string>('app.webhookHmacSecret', '');

    // In test/dev mode, skip verification if no secret configured
    if (!secret || secret === 'change-me-in-production') {
      this.logger.warn('Webhook HMAC secret not configured — skipping signature verification (dev mode)');
      return;
    }

    if (!signature) {
      throw new UnauthorizedException('Missing X-HCM-Signature header');
    }

    const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
    if (signature !== expected) {
      throw new UnauthorizedException('Invalid webhook signature');
    }
  }
}
