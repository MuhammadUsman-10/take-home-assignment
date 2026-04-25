import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { HcmSyncService } from '../../../src/modules/hcm-sync/hcm-sync.service';
import { BalancesService } from '../../../src/modules/balances/balances.service';
import { Balance } from '../../../src/database/entities/balance.entity';
import { SyncLog, SyncStatus, SyncType } from '../../../src/database/entities/sync-log.entity';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { of, throwError } from 'rxjs';
import { AxiosResponse } from 'axios';

describe('HcmSyncService', () => {
  let service: HcmSyncService;
  let syncLogRepo: jest.Mocked<Repository<SyncLog>>;
  let balancesService: jest.Mocked<BalancesService>;
  let httpService: jest.Mocked<HttpService>;

  beforeEach(async () => {
    const mockSyncLogRepo = {
      save: jest.fn().mockResolvedValue({}),
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
    };

    const mockBalancesService = { processBatchSync: jest.fn() };
    const mockHttpService = { post: jest.fn(), get: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HcmSyncService,
        { provide: getRepositoryToken(Balance), useValue: { findOne: jest.fn(), find: jest.fn() } },
        { provide: getRepositoryToken(SyncLog), useValue: mockSyncLogRepo },
        { provide: BalancesService, useValue: mockBalancesService },
        { provide: HttpService, useValue: mockHttpService },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              const cfg: Record<string, string | number> = {
                'hcm.baseUrl': 'http://localhost:4000',
                'hcm.apiKey': 'test-key',
                'hcm.timeout': 10000,
              };
              return cfg[key];
            }),
          },
        },
      ],
    }).compile();

    service = module.get(HcmSyncService);
    syncLogRepo = module.get(getRepositoryToken(SyncLog)) as jest.Mocked<Repository<SyncLog>>;
    balancesService = module.get(BalancesService) as jest.Mocked<BalancesService>;
    httpService = module.get(HttpService) as jest.Mocked<HttpService>;
  });

  // ─────────────────────────────────────────────────────────────
  // scheduledReconciliation
  // ─────────────────────────────────────────────────────────────

  describe('scheduledReconciliation', () => {
    it('should fetch batch from HCM and call processBatchSync on success', async () => {
      const hcmBatch = {
        balances: [
          { employeeId: 'emp-001', locationId: 'loc-nyc', leaveTypeId: 'VACATION', totalDays: 15, usedDays: 3 },
          { employeeId: 'emp-002', locationId: 'loc-sf', leaveTypeId: 'VACATION', totalDays: 20, usedDays: 5 },
        ],
      };

      (httpService.post as jest.Mock).mockReturnValue(of({ data: hcmBatch } as AxiosResponse));
      balancesService.processBatchSync.mockResolvedValue({ processed: 2, conflicts: [], errors: [] });

      await service.scheduledReconciliation();

      expect(httpService.post).toHaveBeenCalledWith('/hcm/balances/batch', {});
      expect(balancesService.processBatchSync).toHaveBeenCalledWith(
        expect.objectContaining({ balances: hcmBatch.balances }),
      );
      expect(syncLogRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ type: SyncType.RECONCILIATION, status: SyncStatus.SUCCESS }),
      );
    });

    it('should log FAILURE and not throw when HCM batch endpoint is unavailable', async () => {
      (httpService.post as jest.Mock).mockReturnValue(throwError(() => new Error('ECONNREFUSED')));

      await expect(service.scheduledReconciliation()).resolves.not.toThrow();

      expect(syncLogRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: SyncStatus.FAILURE }),
      );
      expect(balancesService.processBatchSync).not.toHaveBeenCalled();
    });

    it('should log PARTIAL when processBatchSync returns conflicts', async () => {
      (httpService.post as jest.Mock).mockReturnValue(
        of({ data: { balances: [{ employeeId: 'emp-001', locationId: 'loc-nyc', leaveTypeId: 'VACATION', totalDays: 5, usedDays: 0 }] } } as AxiosResponse),
      );
      balancesService.processBatchSync.mockResolvedValue({
        processed: 1,
        conflicts: [{ employeeId: 'emp-001', locationId: 'loc-nyc', leaveTypeId: 'VACATION', reason: 'HCM available (5) < local reserved (8)' }],
        errors: [],
      });

      await service.scheduledReconciliation();

      expect(syncLogRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: SyncStatus.PARTIAL }),
      );
    });

    it('should log FAILURE and not throw when processBatchSync throws internally', async () => {
      (httpService.post as jest.Mock).mockReturnValue(of({ data: { balances: [] } } as AxiosResponse));
      balancesService.processBatchSync.mockRejectedValue(new Error('DB write failed'));

      await expect(service.scheduledReconciliation()).resolves.not.toThrow();

      expect(syncLogRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: SyncStatus.FAILURE }),
      );
    });

    it('should allow re-entry after previous run completes (isReconciling resets in finally)', async () => {
      (httpService.post as jest.Mock).mockReturnValue(of({ data: { balances: [] } } as AxiosResponse));
      balancesService.processBatchSync.mockResolvedValue({ processed: 0, conflicts: [], errors: [] });

      await service.scheduledReconciliation();
      await service.scheduledReconciliation();

      expect(httpService.post).toHaveBeenCalledTimes(2);
    });
  });
});
