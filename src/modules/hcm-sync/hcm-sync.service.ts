import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { Balance } from '../../database/entities/balance.entity';
import { SyncLog, SyncStatus, SyncType } from '../../database/entities/sync-log.entity';
import { BalancesService } from '../balances/balances.service';

@Injectable()
export class HcmSyncService {
  private readonly logger = new Logger(HcmSyncService.name);
  private isReconciling = false;

  constructor(
    @InjectRepository(Balance)
    private readonly balanceRepo: Repository<Balance>,
    @InjectRepository(SyncLog)
    private readonly syncLogRepo: Repository<SyncLog>,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly balancesService: BalancesService,
  ) {}

  /**
   * Scheduled reconciliation — runs every 15 minutes.
   * Pulls the full batch from HCM and processes it as a batch sync.
   * Acts as the eventual consistency correction layer.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async scheduledReconciliation(): Promise<void> {
    if (this.isReconciling) {
      this.logger.warn('Reconciliation already in progress — skipping this cycle');
      return;
    }

    this.isReconciling = true;
    this.logger.log('Starting scheduled HCM reconciliation…');
    const startTime = Date.now();

    try {
      const response = await firstValueFrom(
        this.httpService.post('/hcm/balances/batch', {}),
      );

      const batchData = response.data as {
        balances: Array<{
          employeeId: string;
          locationId: string;
          leaveTypeId: string;
          totalDays: number;
          usedDays: number;
        }>;
      };

      const result = await this.balancesService.processBatchSync({
        balances: batchData.balances,
        source: 'scheduled-reconciliation',
      });

      const durationMs = Date.now() - startTime;
      this.logger.log(
        `Reconciliation complete: ${result.processed} records, ` +
        `${result.conflicts.length} conflicts in ${durationMs}ms`,
      );

      if (result.conflicts.length > 0) {
        this.logger.warn(
          `Conflicts detected:\n${JSON.stringify(result.conflicts, null, 2)}`,
        );
      }

      await this.syncLogRepo.save({
        type: SyncType.RECONCILIATION,
        status: result.conflicts.length > 0 ? SyncStatus.PARTIAL : SyncStatus.SUCCESS,
        recordsProcessed: result.processed,
        recordsConflicted: result.conflicts.length,
        payload: JSON.stringify({ durationMs }),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Scheduled reconciliation failed: ${message}`);

      await this.syncLogRepo.save({
        type: SyncType.RECONCILIATION,
        status: SyncStatus.FAILURE,
        errorMessage: message,
        recordsProcessed: 0,
      });
    } finally {
      this.isReconciling = false;
    }
  }

  /**
   * Get the latest reconciliation log for health reporting.
   */
  async getLastReconciliationLog(): Promise<SyncLog | null> {
    return this.syncLogRepo.findOne({
      where: { type: SyncType.RECONCILIATION },
      order: { processedAt: 'DESC' },
    });
  }
}
