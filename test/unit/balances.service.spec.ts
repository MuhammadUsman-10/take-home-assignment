import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { BalancesService } from '../../../src/modules/balances/balances.service';
import { Balance } from '../../../src/database/entities/balance.entity';
import { SyncLog } from '../../../src/database/entities/sync-log.entity';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { AxiosResponse } from 'axios';

const makeBalance = (overrides: Partial<Balance> = {}): Balance => ({
  id: 'balance-1',
  employeeId: 'emp-001',
  locationId: 'loc-nyc',
  leaveTypeId: 'VACATION',
  totalDays: 15,
  usedDays: 3,
  reservedDays: 0,
  version: 1,
  lastSyncedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  get availableDays() { return this.totalDays - this.usedDays - this.reservedDays; },
  employee: null as never,
  ...overrides,
} as Balance);

describe('BalancesService', () => {
  let service: BalancesService;
  let balanceRepo: jest.Mocked<Repository<Balance>>;
  let syncLogRepo: jest.Mocked<Repository<SyncLog>>;
  let httpService: jest.Mocked<HttpService>;
  let dataSource: jest.Mocked<DataSource>;

  beforeEach(async () => {
    const mockRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      save: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };

    const mockDataSource = {
      transaction: jest.fn((fn: (manager: typeof mockRepo) => Promise<unknown>) => fn(mockRepo as unknown as typeof mockRepo)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BalancesService,
        { provide: getRepositoryToken(Balance), useValue: mockRepo },
        { provide: getRepositoryToken(SyncLog), useValue: { save: jest.fn() } },
        { provide: HttpService, useValue: { get: jest.fn(), post: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue('http://localhost:4000') } },
        { provide: DataSource, useValue: mockDataSource },
      ],
    }).compile();

    service = module.get(BalancesService);
    balanceRepo = module.get(getRepositoryToken(Balance)) as jest.Mocked<Repository<Balance>>;
    syncLogRepo = module.get(getRepositoryToken(SyncLog)) as jest.Mocked<Repository<SyncLog>>;
    httpService = module.get(HttpService) as jest.Mocked<HttpService>;
    dataSource = module.get(DataSource) as jest.Mocked<DataSource>;
  });

  // ─────────────────────────────────────────────────────────────
  // getBalance
  // ─────────────────────────────────────────────────────────────

  describe('getBalance', () => {
    it('should return balance summary when found', async () => {
      const balance = makeBalance();
      balanceRepo.findOne.mockResolvedValue(balance);

      const result = await service.getBalance('emp-001', 'loc-nyc', 'VACATION');

      expect(result.availableDays).toBe(12); // 15 - 3 - 0
      expect(result.reservedDays).toBe(0);
      expect(balanceRepo.findOne).toHaveBeenCalledTimes(1);
    });

    it('should throw NotFoundException when balance not found', async () => {
      balanceRepo.findOne.mockResolvedValue(null);

      await expect(service.getBalance('emp-999', 'loc-nyc', 'VACATION')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should trigger HCM sync when forceRefresh=true', async () => {
      const balance = makeBalance();
      balanceRepo.findOne.mockResolvedValue(balance);
      (httpService.get as jest.Mock).mockReturnValue(
        of({ data: { totalDays: 20, usedDays: 5 } } as AxiosResponse),
      );
      balanceRepo.save.mockResolvedValue({ ...balance, totalDays: 20 });
      syncLogRepo.save = jest.fn().mockResolvedValue({});

      await service.getBalance('emp-001', 'loc-nyc', 'VACATION', true);

      expect(httpService.get).toHaveBeenCalledWith(
        '/hcm/balances/emp-001/loc-nyc',
        expect.objectContaining({ params: { leaveTypeId: 'VACATION' } }),
      );
    });
  });

  // ─────────────────────────────────────────────────────────────
  // reserveDays
  // ─────────────────────────────────────────────────────────────

  describe('reserveDays', () => {
    it('should reserve days when balance is sufficient', async () => {
      const balance = makeBalance({ totalDays: 15, usedDays: 3, reservedDays: 0 });
      balanceRepo.findOne.mockResolvedValue(balance);
      balanceRepo.save.mockResolvedValue({ ...balance, reservedDays: 5 });

      const result = await service.reserveDays('emp-001', 'loc-nyc', 'VACATION', 5);

      expect(balanceRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ reservedDays: 5 }),
      );
    });

    it('should throw ConflictException when balance is insufficient', async () => {
      // available = 15 - 3 - 0 = 12, requesting 13
      const balance = makeBalance({ totalDays: 15, usedDays: 3, reservedDays: 0 });
      balanceRepo.findOne.mockResolvedValue(balance);

      await expect(service.reserveDays('emp-001', 'loc-nyc', 'VACATION', 13)).rejects.toThrow(
        ConflictException,
      );
      expect(balanceRepo.save).not.toHaveBeenCalled();
    });

    it('should throw ConflictException when existing reservations exhaust balance', async () => {
      // total=10 used=5 reserved=4 → available=1, requesting 2
      const balance = makeBalance({ totalDays: 10, usedDays: 5, reservedDays: 4 });
      balanceRepo.findOne.mockResolvedValue(balance);

      await expect(service.reserveDays('emp-001', 'loc-nyc', 'VACATION', 2)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should throw NotFoundException when balance record missing', async () => {
      balanceRepo.findOne.mockResolvedValue(null);

      await expect(service.reserveDays('emp-999', 'loc-nyc', 'VACATION', 1)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should correctly handle fractional days (half-day requests)', async () => {
      const balance = makeBalance({ totalDays: 5, usedDays: 0, reservedDays: 0 });
      balanceRepo.findOne.mockResolvedValue(balance);
      balanceRepo.save.mockResolvedValue({ ...balance, reservedDays: 0.5 });

      await service.reserveDays('emp-001', 'loc-nyc', 'VACATION', 0.5);

      expect(balanceRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ reservedDays: 0.5 }),
      );
    });
  });

  // ─────────────────────────────────────────────────────────────
  // availableDays formula invariant
  // ─────────────────────────────────────────────────────────────

  describe('availableDays formula', () => {
    it('should compute availableDays = totalDays - usedDays - reservedDays', () => {
      const balance = makeBalance({ totalDays: 20, usedDays: 5, reservedDays: 3 });
      balanceRepo.findOne.mockResolvedValue(balance);

      // Use the getter
      expect(balance.availableDays).toBe(12); // 20 - 5 - 3
    });

    it('should return 0 available when fully consumed', () => {
      const balance = makeBalance({ totalDays: 10, usedDays: 6, reservedDays: 4 });
      expect(balance.availableDays).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // confirmReservation
  // ─────────────────────────────────────────────────────────────

  describe('confirmReservation', () => {
    it('should move reserved days to used on HCM approval', async () => {
      const balance = makeBalance({ totalDays: 15, usedDays: 3, reservedDays: 5 });

      // Simulate transaction calling findOne then save
      (dataSource.transaction as jest.Mock).mockImplementation(async (fn: (m: unknown) => Promise<unknown>) => {
        return fn({
          findOne: jest.fn().mockResolvedValue(balance),
          save: jest.fn().mockImplementation((b: Balance) => Promise.resolve(b)),
          create: jest.fn(),
        });
      });

      await service.confirmReservation('emp-001', 'loc-nyc', 'VACATION', 5);
      // After: reserved=0, used=8
      expect(balance.reservedDays).toBe(0);
      expect(balance.usedDays).toBe(8);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // releaseReservation
  // ─────────────────────────────────────────────────────────────

  describe('releaseReservation', () => {
    it('should release reserved days on rejection or cancellation', async () => {
      const balance = makeBalance({ totalDays: 15, usedDays: 3, reservedDays: 5 });

      (dataSource.transaction as jest.Mock).mockImplementation(async (fn: (m: unknown) => Promise<unknown>) => {
        return fn({
          findOne: jest.fn().mockResolvedValue(balance),
          save: jest.fn().mockImplementation((b: Balance) => Promise.resolve(b)),
          create: jest.fn(),
        });
      });

      await service.releaseReservation('emp-001', 'loc-nyc', 'VACATION', 5);
      expect(balance.reservedDays).toBe(0);
    });

    it('should not go below 0 reserved days (safety guard)', async () => {
      const balance = makeBalance({ totalDays: 15, usedDays: 3, reservedDays: 2 });

      (dataSource.transaction as jest.Mock).mockImplementation(async (fn: (m: unknown) => Promise<unknown>) => {
        return fn({
          findOne: jest.fn().mockResolvedValue(balance),
          save: jest.fn().mockImplementation((b: Balance) => Promise.resolve(b)),
        });
      });

      await service.releaseReservation('emp-001', 'loc-nyc', 'VACATION', 5);
      expect(balance.reservedDays).toBe(0); // Math.max(0, 2-5) = 0
    });
  });

  // ─────────────────────────────────────────────────────────────
  // HCM real-time sync
  // ─────────────────────────────────────────────────────────────

  describe('syncRealtimeFromHcm', () => {
    it('should update local balance with HCM data on success', async () => {
      const balance = makeBalance({ totalDays: 10 });
      (httpService.get as jest.Mock).mockReturnValue(
        of({ data: { totalDays: 15, usedDays: 2 } } as AxiosResponse),
      );
      balanceRepo.findOne.mockResolvedValue({ ...balance, totalDays: 15 });
      balanceRepo.save.mockResolvedValue({ ...balance, totalDays: 15, usedDays: 2, lastSyncedAt: new Date() });
      syncLogRepo.save = jest.fn().mockResolvedValue({});

      await service.syncRealtimeFromHcm('emp-001', 'loc-nyc', 'VACATION');

      expect(balanceRepo.save).toHaveBeenCalled();
      expect(syncLogRepo.save).toHaveBeenCalled();
    });

    it('should log failure and not throw when HCM is unavailable', async () => {
      (httpService.get as jest.Mock).mockReturnValue(
        throwError(() => new Error('Connection refused')),
      );
      const balance = makeBalance();
      balanceRepo.findOne.mockResolvedValue(balance);
      syncLogRepo.save = jest.fn().mockResolvedValue({});

      // Should not throw — failure is graceful
      await expect(service.syncRealtimeFromHcm('emp-001', 'loc-nyc', 'VACATION')).resolves.toBeDefined();
      expect(syncLogRepo.save).toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Batch sync
  // ─────────────────────────────────────────────────────────────

  describe('processBatchSync', () => {
    it('should process batch and return processed count', async () => {
      (dataSource.transaction as jest.Mock).mockImplementation(async (fn: (m: unknown) => Promise<unknown>) => {
        return fn({
          findOne: jest.fn().mockResolvedValue(makeBalance()),
          save: jest.fn().mockImplementation((b: Balance) => Promise.resolve(b)),
          create: jest.fn(),
          query: jest.fn(),
        });
      });
      syncLogRepo.save = jest.fn().mockResolvedValue({});

      const result = await service.processBatchSync({
        balances: [
          { employeeId: 'emp-001', locationId: 'loc-nyc', leaveTypeId: 'VACATION', totalDays: 15, usedDays: 3 },
        ],
        source: 'test',
      });

      expect(result.processed).toBe(1);
    });

    it('should detect conflicts when HCM available < local reserved', async () => {
      // Local: total=10 used=3 reserved=8 → conflict when HCM says total=5 used=3
      const balance = makeBalance({ totalDays: 10, usedDays: 3, reservedDays: 8 });

      (dataSource.transaction as jest.Mock).mockImplementation(async (fn: (m: unknown) => Promise<unknown>) => {
        return fn({
          findOne: jest.fn().mockResolvedValue(balance),
          save: jest.fn().mockImplementation((b: Balance) => Promise.resolve(b)),
          create: jest.fn(),
          query: jest.fn(),
        });
      });
      syncLogRepo.save = jest.fn().mockResolvedValue({});

      const result = await service.processBatchSync({
        balances: [
          { employeeId: 'emp-001', locationId: 'loc-nyc', leaveTypeId: 'VACATION', totalDays: 5, usedDays: 3 },
        ],
      });

      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].reason).toContain('HCM available');
    });
  });
});
