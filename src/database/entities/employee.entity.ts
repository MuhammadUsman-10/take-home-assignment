import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn,
  OneToMany, Index,
} from 'typeorm';
import { TimeOffRequest } from './time-off-request.entity';
import { Balance } from './balance.entity';

@Entity('employees')
@Index(['hcmEmployeeId'], { unique: true })
export class Employee {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 255 })
  name: string;

  @Column({ length: 255 })
  email: string;

  @Column({ length: 100 })
  hcmEmployeeId: string;

  @Column({ length: 100 })
  locationId: string;

  @Column({ default: 'employee' })
  role: string; // 'employee' | 'manager' | 'system'

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @OneToMany(() => TimeOffRequest, (r) => r.employee)
  timeOffRequests: TimeOffRequest[];

  @OneToMany(() => Balance, (b) => b.employee)
  balances: Balance[];
}
