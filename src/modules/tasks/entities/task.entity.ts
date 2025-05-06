import {
  Column, CreateDateColumn, Entity, Index, // <-- Import Index
  JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { TaskStatus } from '../enums/task-status.enum';
import { TaskPriority } from '../enums/task-priority.enum';

@Entity('tasks')
// Optional: Define multi-column indexes at the class level if needed later
// @Index(["userId", "status"]) // Example multi-column index
// @Index(["userId", "createdAt"]) // Example multi-column index
export class Task {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Index() // <-- Add index for status filtering/aggregation
  @Column({
    type: 'enum',
    enum: TaskStatus,
    default: TaskStatus.PENDING,
  })
  status: TaskStatus;

  @Index() // <-- Add index for priority filtering/aggregation
  @Column({
    type: 'enum',
    enum: TaskPriority,
    default: TaskPriority.MEDIUM,
  })
  priority: TaskPriority;

  @Index() // <-- Add index for overdue task lookup
  @Column({ name: 'due_date', nullable: true })
  dueDate: Date;

  @Index() // <-- CRITICAL: Add index for filtering/joining by user
  @Column({ name: 'user_id' })
  userId: string;

  @ManyToOne(() => User, (user) => user.tasks)
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Index() // <-- Add index for default sorting
  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}