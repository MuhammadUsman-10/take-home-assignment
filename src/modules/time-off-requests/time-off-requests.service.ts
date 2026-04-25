import {
  Injectable, Logger, ConflictException, NotFoundException, BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { TimeOffRequest, RequestStatus } from '../../database/entities/time-off-request.entity';
import { BalancesService } from '../balances/balances.service';
import { CreateTimeOffRequestDto } from './dto/create-time-off-request.dto';
import { ReviewTimeOffRequestDto } from './dto/review-time-off-request.dto';

interface HcmTimeOffResponse {
  refId: string;
  status: 'APPROVED' | 'REJECTED';
  message?: string;
}

@Injectable()
export class TimeOffRequestsService {
  private readonly logger = new Logger(TimeOffRequestsService.name);

  constructor(
    @InjectRepository(TimeOffRequest)
    private readonly requestRepo: Repository<TimeOffRequest>,
    private readonly balancesService: BalancesService,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  // ─────────────────────────────────────────────────────────────
  // Submit — the main flow
  // ─────────────────────────────────────────────────────────────

  async submit(dto: CreateTimeOffRequestDto): Promise<TimeOffRequest> {
    // 1. Idempotency check — same key returns previous result immediately
    const existing = await this.requestRepo.findOne({
      where: { idempotencyKey: dto.idempotencyKey },
    });
    if (existing) {
      this.logger.log(`Idempotency hit for key=${dto.idempotencyKey} → returning existing request`);
      return existing;
    }

    // 2. Validate dates
    this.validateDates(dto.startDate, dto.endDate);

    // 3. Defensive local balance check — BEFORE calling HCM
    //    This prevents wasting HCM API calls for obviously insufficient balances
    await this.balancesService.reserveDays(
      dto.employeeId,
      dto.locationId,
      dto.leaveTypeId,
      dto.days,
    );

    // 4. Persist as PENDING
    const request = this.requestRepo.create({
      employeeId: dto.employeeId,
      locationId: dto.locationId,
      leaveTypeId: dto.leaveTypeId,
      startDate: dto.startDate,
      endDate: dto.endDate,
      days: dto.days,
      idempotencyKey: dto.idempotencyKey,
      status: RequestStatus.PENDING,
    });
    const saved = await this.requestRepo.save(request);

    // 5. Call HCM asynchronously — fire and update
    this.callHcmAsync(saved).catch((err) => {
      this.logger.error(`Async HCM call failed for request ${saved.id}: ${err.message}`);
    });

    return saved;
  }

  private async callHcmAsync(request: TimeOffRequest): Promise<void> {
    try {
      const response = await firstValueFrom(
        this.httpService.post<HcmTimeOffResponse>('/hcm/time-off', {
          employeeId: request.employeeId,
          locationId: request.locationId,
          leaveTypeId: request.leaveTypeId,
          startDate: request.startDate,
          endDate: request.endDate,
          days: request.days,
          refId: request.id,
        }, {
          headers: { 'X-Idempotency-Key': request.idempotencyKey },
        }),
      );

      const hcmResult = response.data;

      if (hcmResult.status === 'APPROVED') {
        await this.markApproved(request, hcmResult.refId);
      } else {
        await this.markRejected(request, hcmResult.message ?? 'HCM rejected the request');
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      // HCM error response body (e.g. 400 insufficient balance)
      const hcmError = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;

      this.logger.warn(`HCM rejected request ${request.id}: ${hcmError ?? message}`);
      await this.markRejected(request, hcmError ?? message);
    }
  }

  private async markApproved(request: TimeOffRequest, hcmRefId: string): Promise<void> {
    await this.balancesService.confirmReservation(
      request.employeeId,
      request.locationId,
      request.leaveTypeId,
      request.days,
    );

    await this.requestRepo.update(request.id, {
      status: RequestStatus.APPROVED,
      hcmRefId,
      reviewedAt: new Date(),
    });

    this.logger.log(`Request ${request.id} APPROVED by HCM (ref=${hcmRefId})`);
  }

  private async markRejected(request: TimeOffRequest, reason: string): Promise<void> {
    await this.balancesService.releaseReservation(
      request.employeeId,
      request.locationId,
      request.leaveTypeId,
      request.days,
    );

    await this.requestRepo.update(request.id, {
      status: RequestStatus.REJECTED,
      rejectionReason: reason,
      reviewedAt: new Date(),
    });

    this.logger.log(`Request ${request.id} REJECTED: ${reason}`);
  }

  // ─────────────────────────────────────────────────────────────
  // Manager actions
  // ─────────────────────────────────────────────────────────────

  async approve(requestId: string, reviewerId: string, dto: ReviewTimeOffRequestDto): Promise<TimeOffRequest> {
    const request = await this.findOrThrow(requestId);

    if (request.status !== RequestStatus.PENDING) {
      throw new BadRequestException(`Cannot approve a request in status: ${request.status}`);
    }

    // Manager approval triggers HCM call
    await this.callHcmAsync(request);

    return this.requestRepo.findOneOrFail({ where: { id: requestId } });
  }

  async reject(requestId: string, reviewerId: string, dto: ReviewTimeOffRequestDto): Promise<TimeOffRequest> {
    const request = await this.findOrThrow(requestId);

    if (request.status !== RequestStatus.PENDING && request.status !== RequestStatus.NEEDS_REVALIDATION) {
      throw new BadRequestException(`Cannot reject a request in status: ${request.status}`);
    }

    await this.markRejected(request, dto.notes ?? 'Rejected by manager');
    await this.requestRepo.update(requestId, { reviewedBy: reviewerId, managerNotes: dto.notes });

    return this.requestRepo.findOneOrFail({ where: { id: requestId } });
  }

  // ─────────────────────────────────────────────────────────────
  // Cancel
  // ─────────────────────────────────────────────────────────────

  async cancel(requestId: string, employeeId: string): Promise<TimeOffRequest> {
    const request = await this.findOrThrow(requestId);

    if (request.employeeId !== employeeId) {
      throw new BadRequestException('You can only cancel your own requests');
    }

    if (request.status !== RequestStatus.PENDING) {
      throw new BadRequestException(
        `Only PENDING requests can be cancelled. Current status: ${request.status}`,
      );
    }

    await this.balancesService.releaseReservation(
      request.employeeId,
      request.locationId,
      request.leaveTypeId,
      request.days,
    );

    await this.requestRepo.update(requestId, {
      status: RequestStatus.CANCELLED,
    });

    this.logger.log(`Request ${requestId} CANCELLED by employee ${employeeId}`);
    return this.requestRepo.findOneOrFail({ where: { id: requestId } });
  }

  // ─────────────────────────────────────────────────────────────
  // Queries
  // ─────────────────────────────────────────────────────────────

  async findAll(filters: {
    employeeId?: string;
    status?: RequestStatus;
    locationId?: string;
  }): Promise<TimeOffRequest[]> {
    const where: Record<string, unknown> = {};
    if (filters.employeeId) where.employeeId = filters.employeeId;
    if (filters.status) where.status = filters.status;
    if (filters.locationId) where.locationId = filters.locationId;

    return this.requestRepo.find({
      where,
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(id: string): Promise<TimeOffRequest> {
    return this.findOrThrow(id);
  }

  // ─────────────────────────────────────────────────────────────
  // Internal helpers
  // ─────────────────────────────────────────────────────────────

  private async findOrThrow(id: string): Promise<TimeOffRequest> {
    const request = await this.requestRepo.findOne({ where: { id } });
    if (!request) throw new NotFoundException(`Time-off request not found: ${id}`);
    return request;
  }

  private validateDates(startDate: string, endDate: string): void {
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (start > end) {
      throw new BadRequestException('startDate must be before or equal to endDate');
    }
  }
}
