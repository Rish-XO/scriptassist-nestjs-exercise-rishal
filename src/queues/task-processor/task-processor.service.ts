// src/queues/task-processor/task-processor.service.ts
import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common'; // Import relevant exceptions
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq'; // Import OnWorkerEvent if needed for listeners
import { Job } from 'bullmq';
import { TasksService } from '../../modules/tasks/tasks.service';
import { TaskStatus } from '../../modules/tasks/enums/task-status.enum'; // Import Enum for validation

@Injectable()
@Processor('task-processing') // Ensure this matches the queue name used in services
export class TaskProcessorService extends WorkerHost {
  private readonly logger = new Logger(TaskProcessorService.name);

  constructor(private readonly tasksService: TasksService) {
    super();
    // Note: Concurrency is typically set in the module definition where BullMQ worker options are configured, not here.
    // Example in TaskProcessorModule: BullModule.registerQueue({ name: 'task-processing', workerOptions: { concurrency: 5 } })
  }

  // Improved error handling strategy in the main process method
  async process(job: Job<any, any, string>): Promise<any> { // Added type generics for Job
    this.logger.debug(`Processing job ${job.id} of type ${job.name} with data:`, job.data);

    try {
      let result: any;
      switch (job.name) {
        case 'task-status-update':
          result = await this.handleStatusUpdate(job);
          break;
        case 'overdue-task-notification': // Corrected job name based on previous step
          result = await this.handleOverdueTaskNotification(job); // Renamed handler for clarity
          break;
        default:
          this.logger.warn(`[Job ${job.id}] Unknown job type: ${job.name}`);
          // Fail permanently for unknown job types
          throw new Error(`Unknown job type: ${job.name}`);
      }
      this.logger.debug(`[Job ${job.id}] Completed successfully.`);
      return result; // Return result from handler on success

    } catch (error) {
      this.logger.error(
        `[Job ${job.id}] Failed processing job (Name: ${job.name}): ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined
      );

      // Re-throw the error to let BullMQ handle retries based on job options
      // BullMQ will catch this and manage attempts/backoff as configured when the job was added.
      // If the error indicates a non-retryable state (e.g., invalid input),
      // specific handling could be added here or in the handler to prevent retries explicitly if needed,
      // but often relying on the configured attempts is sufficient.
      throw error;
    }
  }

  // --- Handler for Task Status Updates ---
  private async handleStatusUpdate(job: Job<{ taskId: string; status: string }>) {
    const { taskId, status } = job.data;

    // Validate required data
    if (!taskId || !status) {
      this.logger.error(`[Job ${job.id}] ('task-status-update') missing required data.`);
      // Throw error for non-retryable failure
      throw new Error('Missing required data (taskId or status)');
    }

    // Validate status against enum values
    if (!Object.values(TaskStatus).includes(status as TaskStatus)) {
      this.logger.error(`[Job ${job.id}] ('task-status-update') received invalid status: ${status}`);
      // Throw error for non-retryable failure
      throw new Error(`Invalid status value provided: ${status}`);
    }

    // Call the service to update status
    // tasksService.updateStatus will throw NotFoundException if task doesn't exist
    // Let the main process method catch and handle retry logic
    const task = await this.tasksService.updateStatus(taskId, status);

    this.logger.log(`[Job ${job.id}] Successfully updated task ${taskId} to status ${status}`);
    return {
      success: true,
      taskId: task.id,
      newStatus: task.status,
    };
  }

  // --- Handler for Overdue Task Notifications ---
  // Renamed from handleOverdueTasks for clarity based on job name
  private async handleOverdueTaskNotification(job: Job<{ taskId: string; userId: string }>) {
    const { taskId, userId } = job.data;
    this.logger.debug(`[Job ${job.id}] Handling overdue notification for task ${taskId}, user ${userId}`);

    if (!taskId || !userId) {
        this.logger.error(`[Job ${job.id}] ('overdue-task-notification') missing required data.`);
        throw new Error('Missing required data (taskId or userId)'); // Fail non-retryable
    }

    try {
        // --- Placeholder Logic: ---
        // Fetching data would go here if needed for the notification content
        // const task = await this.tasksService.findOne(taskId, ???); // Problem: Need user context or system context for findOne
        // const user = await this.usersService.findOne(userId);

        // Log the action instead of sending a real notification
        this.logger.log(`[Job ${job.id}] Notification simulated for overdue task ${taskId} for user ${userId}.`);

        // --- Optionally update status ---
        // If TaskStatus.OVERDUE exists:
        // try {
        //    await this.tasksService.updateStatus(taskId, TaskStatus.OVERDUE);
        //    this.logger.log(`[Job ${job.id}] Updated task ${taskId} status to OVERDUE.`);
        // } catch (error) { ... handle not found etc ... }
        // -----------------------------

        return { success: true, message: `Overdue notification processed for task ${taskId}` };

    } catch (error) {
      let errorMessage = 'An unknown error occurred while processing overdue task';
        let errorStack: string | undefined = undefined; // Explicitly define type for stack

        // Check if the caught object is an instance of Error
        if (error instanceof Error) {
            errorMessage = error.message; // Safely access message
            errorStack = error.stack;     // Safely access stack
        } else if (typeof error === 'string') {
            // Handle cases where a string was thrown
            errorMessage = error;
        } else {
            // Try to stringify other types for logging, but don't assume message/stack
             try {
                 errorMessage = `Non-error value thrown: ${JSON.stringify(error)}`;
             } catch {
                 errorMessage = 'Non-error value thrown, and it could not be stringified.';
             }
        }

        // Log using the safely extracted message and stack
        this.logger.error(
            `[Job ${job.id}] Failed processing overdue task ${taskId}: ${errorMessage}`,
            errorStack // Pass stack to logger (it handles undefined)
        );

        // IMPORTANT: Re-throw the *original* error object.
        // This allows BullMQ's retry logic (attempts, backoff configured in job opts)
        // to work correctly based on the error it receives.
        throw error;
    }
  }

   // --- Optional: Add BullMQ Worker Event Listeners ---
   // Useful for logging progress, completion, or final failure after retries
   @OnWorkerEvent('completed')
   onCompleted(job: Job, result: any) {
     this.logger.log(`[Job ${job.id}] Completed. Result: ${JSON.stringify(result)}`);
   }

   @OnWorkerEvent('failed')
   onFailed(job: Job<any, any, string> | undefined, error: Error, prev: string) {
     if (job) {
       this.logger.error(`[Job ${job.id}] Failed after ${job.attemptsMade} attempts with error: ${error.message}`, error.stack);
     } else {
       this.logger.error(`A job failed with error: ${error.message}`, error.stack); // Job might be undefined in some failure scenarios
     }
   }
   // ---------------------------------------------------
}