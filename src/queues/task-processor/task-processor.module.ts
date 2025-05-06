import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TaskProcessorService } from './task-processor.service';
import { TasksModule } from '../../modules/tasks/tasks.module';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'task-processing',
      defaultJobOptions: { // Optional: Set default options for jobs ADDED to this queue elsewhere
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
        removeOnFail: 1000, // Keep failed jobs for history
      },
    }),
    TasksModule,
  ],
  providers: [TaskProcessorService],
  exports: [TaskProcessorService],
})
export class TaskProcessorModule {} 