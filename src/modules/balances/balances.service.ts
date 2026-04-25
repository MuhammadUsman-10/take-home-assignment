import {
  Injectable, Logger, NotFoundException, ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { Balance } from '../../database/entities/balance.entity';
import { SyncLog, SyncStatus, SyncType } from '../../database/entities/sync-log.entity';
import { BatchSyncDto, BatchSyncItemDto } from './dto/batch-sync.dto';

export interface BalanceSummary {
  employeeId: string;
  locationId: string;
  leaveTypeId: string;
  totalDays: number;
  usedDays: number;
  reservedDays: number;
  availableDays: number;
  lastSyncedAt: Date | null;
  version: number;
}

@Injectable()
export class BalancesService {
  private readonly logger = new Logger(BalancesService.name);
  private readonly hcmBaseUrl: string;

  constructor(
    @InjectRepository(Balance)
    private readonly balanceRepo: Repository<Balance>,
    @InjectRepository(SyncLog)
    private readonly syncLogRepo: Repository<SyncLog>,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly dataSource: DataSource,
  ) {
    this.hcmBaseUrl = this.configService.get<string>('hcm.baseUrl', 'http://localhost:4000');
  }

  // ─────────────────────────────────────────────────────────────
  // Public read
  // ─────────────────────────────────────────────────────────────

  async getBalance(
    employeeId: string,
    locationId: string,
    leaveTypeId: string,
    forceRefresh = false,
  ): Promise<BalanceSummary> {
    if (forceRefresh) {
      await this.syncRealtimeFromHcm(employeeId, locationId, leaveTypeId);
    }

    const balance = await this.balanceRepo.findOne({
      where: { employeeId, locationId, leaveTypeId },
    });

    if (!balance) {
      throw new NotFoundException(
        `No balance found for employee=${employeeId} location=${locationId} leaveType=${leaveTypeId}`,
      );
    }

    return this.toSummary(balance);
  }

  async getAllBalancesForEmployee(employeeId: string): Promise<BalanceSummary[]> {
    const balances = await this.balanceRepo.find({ where: { employeeId } });
    return balances.map(this.toSummary);
  }

  // ─────────────────────────────────────────────────────────────
  // Reservation operations (called by TimeOffRequestsService)
  // ─────────────────────────────────────────────────────────────

  /**
   * Reserve days against an employee's balance (on request submission).
   * Uses optimistic locking — retries on version conflict.
   */
  async reserveDays(
    employeeId: string,
    locationId: string,
    leaveTypeId: string,
    days: number,
    maxRetries = 3,
  ): Promise<Balance> {
    let attempt = 0;

    while (attempt < maxRetries) {
      const balance = await this.balanceRepo.findOne({
        where: { employeeId, locationId, leaveTypeId },
      });

      if (!balance) {
        throw new NotFoundException(
          `Balance not found for employee=${employeeId} location=${locationId} leaveType=${leaveTypeId}`,
        );
      }

      const available = balance.totalDays - balance.usedDays - balance.reservedDays;
      if (available < days) {
        throw new ConflictException(
          `Insufficient balance: ${available} days available, ${days} days requested`,
        );
      }

      try {
        balance.reservedDays = parseFloat((balance.reservedDays + days).toFixed(4));
        const saved = await this.balanceRepo.save(balance); // triggers version increment
        this.logger.log(
          `Reserved ${days} days for employee=${employeeId} location=${locationId} leaveType=${leaveTypeId}. ` +
          `New available: ${saved.totalDays - saved.usedDays - saved.reservedDays}`,
        );
        return saved;
      } catch (err: unknown) {
        // TypeORM optimistic lock throws OptimisticLockVersionMismatchError
        if (this.isOptimisticLockError(err) && attempt < maxRetries - 1) {
          attempt++;
          this.logger.warn(`Optimistic lock conflict on reserveDays (attempt ${attempt}/${maxRetries}). Retrying…`);
          await this.sleep(50 * attempt);
          continue;
        }
        throw err;
      }
    }

    throw new ConflictException('Could not reserve balance after maximum retries — please try again');
  }

  /**
   * Confirm reservation → moves reserved days to used (on HCM approval).
   */
  async confirmReservation(
    employeeId: string,
    locationId: string,
    leaveTypeId: string,
    days: number,
  ): Promise<Balance> {
    return this.dataSource.transaction(async (manager) => {
      const balance = await manager.findOne(Balance, {
        where: { employeeId, locationId, leaveTypeId },
      });

      if (!balance) throw new NotFoundException('Balance not found');

      balance.reservedDays = Math.max(0, parseFloat((balance.reservedDays - days).toFixed(4)));
      balance.usedDays = parseFloat((balance.usedDays + days).toFixed(4));
      return manager.save(balance);
    });
  }

  /**
   * Release reservation → days freed back to available (on rejection/cancellation).
   */
  async releaseReservation(
    employeeId: string,
    locationId: string,
    leaveTypeId: string,
    days: number,
  ): Promise<Balance> {
    return this.dataSource.transaction(async (manager) => {
      const balance = await manager.findOne(Balance, {
        where: { employeeId, locationId, leaveTypeId },
      });

      if (!balance) throw new NotFoundException('Balance not found');

      balance.reservedDays = Math.max(0, parseFloat((balance.reservedDays - days).toFixed(4)));
      return manager.save(balance);
    });
  }

  // ─────────────────────────────────────────────────────────────
  // HCM Sync — Real-time
  // ─────────────────────────────────────────────────────────────

  async syncRealtimeFromHcm(
    employeeId: string,
    locationId: string,
    leaveTypeId: string,
  ): Promise<BalanceSummary> {
    this.logger.log(`Real-time HCM sync: employee=${employeeId} location=${locationId} leaveType=${leaveTypeId}`);

    let hcmData: { totalDays: number; usedDays: number } | null = null;
    let syncStatus = SyncStatus.SUCCESS;
    let errorMessage: string | null = null;

    try {
      const response = await firstValueFrom(
        this.httpService.get(`/hcm/balances/${employeeId}/${locationId}`, {
          params: { leaveTypeId },
        }),
      );
      hcmData = response.data;
    } catch (err: unknown) {
      syncStatus = SyncStatus.FAILURE;
      errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error(`HCM real-time sync failed: ${errorMessage}`);
    }

    if (hcmData) {
      await this.upsertBalance(employeeId, locationId, leaveTypeId, hcmData.totalDays, hcmData.usedDays);
    }

    await this.syncLogRepo.save({
      type: SyncType.REALTIME,
      status: syncStatus,
      employeeId,
      locationId,
      errorMessage,
      recordsProcessed: hcmData ? 1 : 0,
    });

    return this.getBalance(employeeId, locationId, leaveTypeId);
  }

  // ─────────────────────────────────────────────────────────────
  // HCM Sync — Batch
  // ─────────────────────────────────────────────────────────────

  /**
   * Ingest a full HCM batch snapshot.
   * HCM always wins → overwrites local totalDays and usedDays.
   * Detects conflicts where reservedDays > new totalDays (returns conflict list).
   */
  async processBatchSync(dto: BatchSyncDto): Promise<{
    processed: number;
    conflicts: Array<{ employeeId: string; locationId: string; leaveTypeId: string; reason: string }>;
  }> {
    this.logger.log(`Processing batch sync: ${dto.balances.length} records`);

    const conflicts: Array<{ employeeId: string; locationId: string; leaveTypeId: string; reason: string }> = [];
    let processed = 0;

    for (const item of dto.balances) {
      try {
        const conflict = await this.upsertBalanceFromBatch(item);
        if (conflict) conflicts.push(conflict);
        processed++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Batch item failed: ${JSON.stringify(item)} — ${msg}`);
      }
    }

    await this.syncLogRepo.save({
      type: SyncType.BATCH,
      status: conflicts.length > 0 ? SyncStatus.PARTIAL : SyncStatus.SUCCESS,
      payload: JSON.stringify({ source: dto.source, total: dto.balances.length }),
      recordsProcessed: processed,
      recordsConflicted: conflicts.length,
    });

    return { processed, conflicts };
  }

  // ─────────────────────────────────────────────────────────────
  // Webhook balance update (HCM push)
  // ─────────────────────────────────────────────────────────────

  async applyWebhookUpdate(
    employeeId: string,
    locationId: string,
    leaveTypeId: string,
    totalDays: number,
    usedDays: number,
  ): Promise<BalanceSummary> {
    this.logger.log(
      `Webhook balance update: employee=${employeeId} location=${locationId} ` +
      `leaveType=${leaveTypeId} total=${totalDays} used=${usedDays}`,
    );

    const conflict = await this.upsertBalanceFromBatch({
      employeeId, locationId, leaveTypeId, totalDays, usedDays,
    });

    if (conflict) {
      this.logger.warn(`Webhook update caused conflict: ${JSON.stringify(conflict)}`);
    }

    await this.syncLogRepo.save({
      type: SyncType.WEBHOOK,
      status: conflict ? SyncStatus.PARTIAL : SyncStatus.SUCCESS,
      employeeId,
      locationId,
      recordsProcessed: 1,
      recordsConflicted: conflict ? 1 : 0,
    });

    return this.getBalance(employeeId, locationId, leaveTypeId);
  }

  // ─────────────────────────────────────────────────────────────
  // Internal helpers
  // ─────────────────────────────────────────────────────────────

  private async upsertBalance(
    employeeId: string,
    locationId: string,
    leaveTypeId: string,
    totalDays: number,
    usedDays: number,
  ): Promise<Balance> {
    let balance = await this.balanceRepo.findOne({
      where: { employeeId, locationId, leaveTypeId },
    });

    if (!balance) {
      balance = this.balanceRepo.create({
        employeeId, locationId, leaveTypeId,
        totalDays, usedDays, reservedDays: 0,
      });
    } else {
      balance.totalDays = totalDays;
      balance.usedDays = usedDays;
    }

    balance.lastSyncedAt = new Date();
    return this.balanceRepo.save(balance);
  }

  /**
   * Upsert from batch/webhook.
   * Detects conflict: reservedDays > (new totalDays - new usedDays)
   * Returns conflict descriptor if detected, null otherwise.
   */
  private async upsertBalanceFromBatch(
    item: BatchSyncItemDto,
  ): Promise<{ employeeId: string; locationId: string; leaveTypeId: string; reason: string } | null> {
    return this.dataSource.transaction(async (manager) => {
      let balance = await manager.findOne(Balance, {
        where: {
          employeeId: item.employeeId,
          locationId: item.locationId,
          leaveTypeId: item.leaveTypeId,
        },
      });

      if (!balance) {
        balance = manager.create(Balance, {
          employeeId: item.employeeId,
          locationId: item.locationId,
          leaveTypeId: item.leaveTypeId,
          totalDays: item.totalDays,
          usedDays: item.usedDays,
          reservedDays: 0,
          lastSyncedAt: new Date(),
        });
        await manager.save(balance);
        return null;
      }

      const newAvailable = item.totalDays - item.usedDays;
      let conflict: { employeeId: string; locationId: string; leaveTypeId: string; reason: string } | null = null;

      if (balance.reservedDays > newAvailable) {
        conflict = {
          employeeId: item.employeeId,
          locationId: item.locationId,
          leaveTypeId: item.leaveTypeId,
          reason: `HCM available (${newAvailable}) < local reserved (${balance.reservedDays})`,
        };
        // Mark pending requests for this employee/location/leaveType as NEEDS_REVALIDATION
        await manager.query(
          `UPDATE time_off_requests
           SET status = 'NEEDS_REVALIDATION', rejection_reason = ?
           WHERE employee_id = ? AND location_id = ? AND leave_type_id = ? AND status = 'PENDING'`,
          [conflict.reason, item.employeeId, item.locationId, item.leaveTypeId],
        );
      }

      balance.totalDays = item.totalDays;
      balance.usedDays = item.usedDays;
      balance.lastSyncedAt = new Date();
      await manager.save(balance);

      return conflict;
    });
  }

  private toSummary(balance: Balance): BalanceSummary {
    return {
      employeeId: balance.employeeId,
      locationId: balance.locationId,
      leaveTypeId: balance.leaveTypeId,
      totalDays: balance.totalDays,
      usedDays: balance.usedDays,
      reservedDays: balance.reservedDays,
      availableDays: parseFloat(
        (balance.totalDays - balance.usedDays - balance.reservedDays).toFixed(4),
      ),
      lastSyncedAt: balance.lastSyncedAt,
      version: balance.version,
    };
  }

  private isOptimisticLockError(err: unknown): boolean {
    return (
      err instanceof Error &&
      (err.message.includes('OptimisticLockVersionMismatch') ||
        err.constructor.name === 'OptimisticLockVersionMismatchError')
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
