import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn,
  ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { Employee } from './employee.entity';

export enum RequestStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
  NEEDS_REVALIDATION = 'NEEDS_REVALIDATION',
}

/**
 * TimeOffRequest — the full lifecycle of a single leave request.
 *
 * State machine:
 *   PENDING → APPROVED      (HCM accepts the request)
 *   PENDING → REJECTED      (HCM rejects, or local defensive check fails)
 *   PENDING → CANCELLED     (employee cancels before HCM call or while still PENDING)
 *   APPROVED → CANCELLED    (not allowed — business rule)
 *   * → NEEDS_REVALIDATION  (batch sync reveals HCM balance < local reserved)
 */
@Entity('time_off_requests')
@Index(['idempotencyKey'], { unique: true })
@Index(['employeeId', 'status'])
export class TimeOffRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  employeeId: string;

  @Column({ length: 100 })
  locationId: string;

  @Column({ length: 100 })
  leaveTypeId: string;

  @Column({ type: 'date' })
  startDate: string; // ISO date string YYYY-MM-DD

  @Column({ type: 'date' })
  endDate: string;

  @Column({ type: 'real' })
  days: number; // number of business days requested

  @Column({ type: 'varchar', default: RequestStatus.PENDING })
  status: RequestStatus;

  /**
   * Client-supplied idempotency key — same key returns same response.
   * Must be unique per (employeeId, leaveTypeId, locationId, startDate, endDate).
   */
  @Column({ length: 255 })
  idempotencyKey: string;

  /** Reference ID returned by HCM on successful filing */
  @Column({ length: 255, nullable: true })
  hcmRefId: string | null;

  /** Human-readable reason for rejection or revalidation */
  @Column({ type: 'text', nullable: true })
  rejectionReason: string | null;

  /** Notes added by manager on approve/reject */
  @Column({ type: 'text', nullable: true })
  managerNotes: string | null;

  /** ID of the manager who approved or rejected */
  @Column({ length: 255, nullable: true })
  reviewedBy: string | null;

  @Column({ type: 'datetime', nullable: true })
  reviewedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => Employee, (e) => e.timeOffRequests, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'employeeId' })
  employee: Employee;
}
