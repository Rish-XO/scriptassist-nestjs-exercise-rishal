// src/queues/scheduled-tasks/overdue-tasks.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
// Import necessary TypeORM operators/helpers
import { LessThan, Repository, Not, IsNull } from 'typeorm'; // Keep Not and IsNull imports even if not used here, for consistency
import { Task } from '../../modules/tasks/entities/task.entity';
import { TaskStatus } from '../../modules/tasks/enums/task-status.enum';

@Injectable()
export class OverdueTasksService {
  private readonly logger = new Logger(OverdueTasksService.name);

  constructor(
    @InjectQueue('task-processing') // Ensure queue name matches processor
    private taskQueue: Queue,
    @InjectRepository(Task)
    private tasksRepository: Repository<Task>,
  ) {}

  @Cron(CronExpression.EVERY_HOUR) // Runs every hour
  async checkOverdueTasks() {
    this.logger.debug('Checking for overdue tasks...');

    try {
      const now = new Date();

      // 1. Find all tasks that are overdue
      //    - Due date is in the past (implicitly NOT NULL)
      //    - Status is PENDING
      const overdueTasks = await this.tasksRepository.find({
        select: {
            id: true,     // Select only the task ID
            userId: true, // Select the user ID (foreign key) directly
        },
        where: {
          // dueDate: Not(IsNull()), // This check is redundant with LessThan
          dueDate: LessThan(now),     // Correct: Due date must be before now
          status: TaskStatus.PENDING, // Task must be pending
        },
        // Consider adding take/limit if expecting massive amounts,
        // though processing all overdue is typical for a cron job.
      });

      if (overdueTasks.length === 0) {
        this.logger.debug('No overdue tasks found.');
        return; // Exit early if no tasks found
      }

      this.logger.log(`Found ${overdueTasks.length} overdue tasks.`);

      // 2. Prepare jobs to be added to the queue
      const jobs = overdueTasks.map(task => ({
        name: 'overdue-task-notification', // Job name for the processor
        data: {
          taskId: task.id,
          userId: task.userId, // Pass necessary IDs
        },
        opts: { // Example job options (customize as needed)
          removeOnComplete: true, // Clean up successful jobs
          removeOnFail: 1000,   // Keep history of failed jobs
          attempts: 3,          // Retry up to 3 times on failure
          backoff: {            // Exponential backoff strategy
            type: 'exponential',
            delay: 5000,        // Wait 5s before first retry
          }
        }
      }));

      // 3. Add jobs to the queue in bulk
      await this.taskQueue.addBulk(jobs);

      this.logger.log(`Successfully added ${jobs.length} overdue task jobs to the queue.`);

    } catch (error) {
      // Check if it's an Error instance to safely access message and stack
        if (error instanceof Error) {
            this.logger.error(
                `Error checking or queuing overdue tasks: ${error.message}`, // Safe to access .message
                error.stack // Safe to access .stack
            );
        } else {
            // Handle cases where something other than an Error was thrown
            this.logger.error(
                `An unexpected error occurred during overdue tasks check: ${JSON.stringify(error)}` // Log the unknown error
            );
        }
    } finally {
      this.logger.debug('Overdue tasks check completed.');
    }
  }
}