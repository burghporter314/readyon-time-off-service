import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity()
export class SyncLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  type: string; // REAL_TIME | BATCH

  @Column()
  triggeredBy: string;

  @Column()
  status: string; // SUCCESS | PARTIAL | ERROR

  @Column({ default: 0 })
  recordsAffected: number;

  @Column({ default: 0 })
  recordsSkipped: number;

  @Column({ type: 'text', nullable: true })
  errorDetails: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
