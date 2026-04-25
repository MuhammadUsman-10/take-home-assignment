import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TimeOffRequestsService } from '../../../src/modules/time-off-requests/time-off-requests.service';
import { TimeOffRequest, RequestStatus } from '../../../src/database/entities/time-off-request.entity';
import { BalancesService } from '../../../src/modules/balances/balances.service';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { of } from 'rxjs';
import { AxiosResponse } from 'axios';

const makeRequest = (overrides: Partial<TimeOffRequest> = {}): TimeOffRequest => ({
  id: 'req-1',
  employeeId: 'emp-001',
  locationId: 'loc-nyc',
  leaveTypeId: 'VACATION',
  startDate: '2026-06-01',
  endDate: '2026-06-05',
  days: 5,
  status: RequestStatus.PENDING,
  idempotencyKey: 'key-1',
  hcmRefId: null,
  rejectionReason: null,
  managerNotes: null,
  reviewedBy: null,
  reviewedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  employee: null as never,
  ...overrides,
} as TimeOffRequest);

describe('TimeOffRequestsService', () => {
  let service: TimeOffRequestsService;
  let requestRepo: jest.Mocked<Repository<TimeOffRequest>>;
  let balancesService: jest.Mocked<BalancesService>;
  let httpService: jest.Mocked<HttpService>;

  beforeEach(async () => {
    const mockRequestRepo = {
      findOne: jest.fn(),
      findOneOrFail: jest.fn(),
      find: jest.fn(),
      save: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };

    const mockBalancesService = {
      reserveDays: jest.fn(),
      confirmReservation: jest.fn(),
      releaseReservation: jest.fn(),
      getBalance: jest.fn(),
    };

    const mockHttpService = {
      post: jest.fn(),
      get: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TimeOffRequestsService,
        { provide: getRepositoryToken(TimeOffRequest), useValue: mockRequestRepo },
        { provide: BalancesService, useValue: mockBalancesService },
        { provide: HttpService, useValue: mockHttpService },
        { provide: ConfigService, useValue: { get: jest.fn() } },
      ],
    }).compile();

    service = module.get(TimeOffRequestsService);
    requestRepo = module.get(getRepositoryToken(TimeOffRequest)) as jest.Mocked<Repository<TimeOffRequest>>;
    balancesService = module.get(BalancesService) as jest.Mocked<BalancesService>;
    httpService = module.get(HttpService) as jest.Mocked<HttpService>;
  });

  // ─────────────────────────────────────────────────────────────
  // submit
  // ─────────────────────────────────────────────────────────────

  describe('submit', () => {
    const dto = {
      employeeId: 'emp-001',
      locationId: 'loc-nyc',
      leaveTypeId: 'VACATION',
      startDate: '2026-06-01',
      endDate: '2026-06-05',
      days: 5,
      idempotencyKey: 'key-1',
    };

    it('should return existing request on duplicate idempotency key', async () => {
      const existing = makeRequest();
      requestRepo.findOne.mockResolvedValue(existing);

      const result = await service.submit(dto);

      expect(result).toBe(existing);
      expect(balancesService.reserveDays).not.toHaveBeenCalled();
    });

    it('should create a PENDING request after reserving balance', async () => {
      requestRepo.findOne.mockResolvedValue(null); // No existing
      balancesService.reserveDays.mockResolvedValue({} as never);

      const pendingRequest = makeRequest();
      requestRepo.create.mockReturnValue(pendingRequest);
      requestRepo.save.mockResolvedValue(pendingRequest);

      // Mock HCM call to succeed asynchronously
      (httpService.post as jest.Mock).mockReturnValue(
        of({ data: { refId: 'hcm-ref-1', status: 'APPROVED' } } as AxiosResponse),
      );
      requestRepo.update.mockResolvedValue({} as never);
      balancesService.confirmReservation.mockResolvedValue({} as never);

      const result = await service.submit(dto);

      expect(balancesService.reserveDays).toHaveBeenCalledWith(
        'emp-001', 'loc-nyc', 'VACATION', 5,
      );
      expect(result.status).toBe(RequestStatus.PENDING);
    });

    it('should reject immediately when local balance is insufficient', async () => {
      requestRepo.findOne.mockResolvedValue(null);
      balancesService.reserveDays.mockRejectedValue(
        new ConflictException('Insufficient balance: 2 days available, 5 days requested'),
      );

      await expect(service.submit(dto)).rejects.toThrow(ConflictException);
      expect(requestRepo.save).not.toHaveBeenCalled();
    });

    it('should reject when startDate is after endDate', async () => {
      requestRepo.findOne.mockResolvedValue(null);

      await expect(
        service.submit({ ...dto, startDate: '2026-06-10', endDate: '2026-06-01' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should release reservation when HCM rejects the request', async () => {
      requestRepo.findOne.mockResolvedValue(null);
      balancesService.reserveDays.mockResolvedValue({} as never);

      const pendingRequest = makeRequest();
      requestRepo.create.mockReturnValue(pendingRequest);
      requestRepo.save.mockResolvedValue(pendingRequest);

      // HCM returns REJECTED
      (httpService.post as jest.Mock).mockReturnValue(
        of({ data: { refId: 'hcm-ref-1', status: 'REJECTED', message: 'Exceeds policy limit' } } as AxiosResponse),
      );
      requestRepo.update.mockResolvedValue({} as never);
      balancesService.releaseReservation.mockResolvedValue({} as never);

      await service.submit(dto);

      // Give async callHcmAsync time to run
      await new Promise((r) => setTimeout(r, 10));

      expect(balancesService.releaseReservation).toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────
  // cancel
  // ─────────────────────────────────────────────────────────────

  describe('cancel', () => {
    it('should cancel a PENDING request and release reservation', async () => {
      const request = makeRequest({ status: RequestStatus.PENDING });
      requestRepo.findOne.mockResolvedValue(request);
      requestRepo.findOneOrFail.mockResolvedValue({ ...request, status: RequestStatus.CANCELLED });
      balancesService.releaseReservation.mockResolvedValue({} as never);
      requestRepo.update.mockResolvedValue({} as never);

      const result = await service.cancel('req-1', 'emp-001');

      expect(balancesService.releaseReservation).toHaveBeenCalledWith(
        'emp-001', 'loc-nyc', 'VACATION', 5,
      );
    });

    it('should throw BadRequestException when cancelling an APPROVED request', async () => {
      const request = makeRequest({ status: RequestStatus.APPROVED });
      requestRepo.findOne.mockResolvedValue(request);

      await expect(service.cancel('req-1', 'emp-001')).rejects.toThrow(BadRequestException);
      expect(balancesService.releaseReservation).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException when employee cancels another employee\'s request', async () => {
      const request = makeRequest({ status: RequestStatus.PENDING, employeeId: 'emp-999' });
      requestRepo.findOne.mockResolvedValue(request);

      await expect(service.cancel('req-1', 'emp-001')).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException for non-existent request', async () => {
      requestRepo.findOne.mockResolvedValue(null);

      await expect(service.cancel('non-existent', 'emp-001')).rejects.toThrow(NotFoundException);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // reject (manager)
  // ─────────────────────────────────────────────────────────────

  describe('reject', () => {
    it('should reject a PENDING request', async () => {
      const request = makeRequest({ status: RequestStatus.PENDING });
      requestRepo.findOne.mockResolvedValue(request);
      requestRepo.findOneOrFail.mockResolvedValue({ ...request, status: RequestStatus.REJECTED });
      balancesService.releaseReservation.mockResolvedValue({} as never);
      requestRepo.update.mockResolvedValue({} as never);

      await service.reject('req-1', 'manager-1', { notes: 'Policy violation' });

      expect(balancesService.releaseReservation).toHaveBeenCalled();
    });

    it('should reject a NEEDS_REVALIDATION request', async () => {
      const request = makeRequest({ status: RequestStatus.NEEDS_REVALIDATION });
      requestRepo.findOne.mockResolvedValue(request);
      requestRepo.findOneOrFail.mockResolvedValue({ ...request, status: RequestStatus.REJECTED });
      balancesService.releaseReservation.mockResolvedValue({} as never);
      requestRepo.update.mockResolvedValue({} as never);

      await service.reject('req-1', 'manager-1', {});

      expect(balancesService.releaseReservation).toHaveBeenCalled();
    });

    it('should throw BadRequestException when rejecting an already APPROVED request', async () => {
      const request = makeRequest({ status: RequestStatus.APPROVED });
      requestRepo.findOne.mockResolvedValue(request);

      await expect(service.reject('req-1', 'manager-1', {})).rejects.toThrow(BadRequestException);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // State machine invariants
  // ─────────────────────────────────────────────────────────────

  describe('state machine invariants', () => {
    it('should not allow cancelling a CANCELLED request', async () => {
      const request = makeRequest({ status: RequestStatus.CANCELLED });
      requestRepo.findOne.mockResolvedValue(request);

      await expect(service.cancel('req-1', 'emp-001')).rejects.toThrow(BadRequestException);
    });

    it('should not allow rejecting a CANCELLED request', async () => {
      const request = makeRequest({ status: RequestStatus.CANCELLED });
      requestRepo.findOne.mockResolvedValue(request);

      await expect(service.reject('req-1', 'manager-1', {})).rejects.toThrow(BadRequestException);
    });
  });
});
