import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';

@Entity()
@Unique(['employeeId', 'locationId'])
export class LeaveBalance {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  employeeId: string;

  @Column()
  locationId: string;

  @Column({ type: 'decimal', precision: 10, scale: 4 })
  availableDays: number;

  @Column({ type: 'decimal', precision: 10, scale: 4, default: 0 })
  pendingDays: number;

  @Column({ nullable: true })
  lastHcmSyncAt: Date;

  @VersionColumn()
  version: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
