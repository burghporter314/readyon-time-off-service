import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity()
export class TimeOffRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  employeeId: string;

  @Column()
  locationId: string;

  @Column({ type: 'date' })
  startDate: string;

  @Column({ type: 'date' })
  endDate: string;

  @Column({ type: 'decimal', precision: 10, scale: 4 })
  daysRequested: number;

  @Column({ default: 'PENDING' })
  status: string;

  @Column({ type: 'varchar', nullable: true })
  hcmTransactionId: string | null;

  @Column({ nullable: true, unique: true })
  idempotencyKey: string;

  @Column({ default: 0 })
  retryCount: number;

  @Column({ nullable: true })
  nextRetryAt: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
