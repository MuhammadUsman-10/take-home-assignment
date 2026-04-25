import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index,
} from 'typeorm';

@Entity('locations')
@Index(['hcmLocationId'], { unique: true })
export class Location {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 255 })
  name: string;

  @Column({ length: 100 })
  hcmLocationId: string;

  @Column({ length: 10, default: 'UTC' })
  timezone: string;

  @Column({ length: 10, default: 'US' })
  country: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
