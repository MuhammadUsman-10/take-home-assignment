import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
} from 'typeorm';

export enum SyncType {
  REALTIME = 'REALTIME',
  BATCH = 'BATCH',
  WEBHOOK = 'WEBHOOK',
  RECONCILIATION = 'RECONCILIATION',
}

export enum SyncStatus {
  SUCCESS = 'SUCCESS',
  FAILURE = 'FAILURE',
  PARTIAL = 'PARTIAL',
}

@Entity('sync_logs')
export class SyncLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  type: SyncType;

  @Column({ type: 'varchar' })
  status: SyncStatus;

  @Column({ length: 100, nullable: true })
  employeeId: string | null;

  @Column({ length: 100, nullable: true })
  locationId: string | null;

  @Column({ type: 'text', nullable: true })
  payload: string | null; // JSON stringified

  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;

  @Column({ type: 'integer', default: 0 })
  recordsProcessed: number;

  @Column({ type: 'integer', default: 0 })
  recordsConflicted: number;

  @CreateDateColumn()
  processedAt: Date;
}
