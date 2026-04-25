import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn,
  ManyToOne, JoinColumn, Index, VersionColumn, Check,
} from 'typeorm';
import { Employee } from './employee.entity';

/**
 * Balance — the local cached view of an employee's leave balance.
 *
 * FORMULA:
 *   availableDays = totalDays - usedDays - reservedDays
 *
 * reservedDays is incremented when a request is submitted (PENDING) and
 * released when the request is APPROVED (usedDays += days) or REJECTED/CANCELLED
 * (reservedDays -= days). This prevents overbooking under concurrent submissions.
 *
 * version is used for optimistic locking to handle concurrent updates safely.
 */
@Entity('balances')
@Index(['employeeId', 'locationId', 'leaveTypeId'], { unique: true })
@Check(`"totalDays" >= 0`)
@Check(`"usedDays" >= 0`)
@Check(`"reservedDays" >= 0`)
export class Balance {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  employeeId: string;

  @Column({ length: 100 })
  locationId: string;       // HCM location ID (dimension)

  @Column({ length: 100 })
  leaveTypeId: string;      // HCM leave type ID (dimension)

  /** Total entitlement received from HCM */
  @Column({ type: 'real', default: 0 })
  totalDays: number;

  /** Days actually consumed (approved + filed with HCM) */
  @Column({ type: 'real', default: 0 })
  usedDays: number;

  /**
   * Days currently held for PENDING requests.
   * Released on approval (→ usedDays) or rejection/cancellation (→ released).
   */
  @Column({ type: 'real', default: 0 })
  reservedDays: number;

  /** Derived: totalDays - usedDays - reservedDays */
  get availableDays(): number {
    return this.totalDays - this.usedDays - this.reservedDays;
  }

  /** Optimistic lock version — incremented on every write */
  @VersionColumn()
  version: number;

  /** Timestamp of last successful HCM sync */
  @Column({ type: 'datetime', nullable: true })
  lastSyncedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => Employee, (e) => e.balances, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'employeeId' })
  employee: Employee;
}
