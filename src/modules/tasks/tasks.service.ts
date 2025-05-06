// src/modules/tasks/tasks.service.ts

import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Inject, // <-- Added for CACHE_MANAGER
  Logger, // <-- Added for logging
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { CACHE_MANAGER , Cache} from '@nestjs/cache-manager'; // <-- Added
// import { Cache } from 'cache-manager'; // <-- Added
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, FindManyOptions, FindOptionsWhere, In, Repository } from 'typeorm';
import { Task } from './entities/task.entity';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { PaginatedResponse } from '../../types/pagination.interface'; // <-- Correct path
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { TaskStatus } from './enums/task-status.enum';
import { TaskPriority } from './enums/task-priority.enum';
import { ConfigService } from '@nestjs/config'; // <-- Added for TTL
import { QueryTaskDto } from './dto/task-filter.dto';

// Define UserPayload or import
interface UserPayload { id: string; email: string; role: string; }

@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name); // <-- Added logger

  constructor(
    @InjectRepository(Task)
    private tasksRepository: Repository<Task>,
    @InjectQueue('task-processing')
    private taskQueue: Queue,
    private dataSource: DataSource,
    @Inject(CACHE_MANAGER) private cacheManager: Cache, // <-- Injected Cache Manager
    private configService: ConfigService // <-- Injected ConfigService
  ) {}

  // --- GET STATS (Optimized - No caching applied here usually) ---
  async getStats(user: UserPayload) {
    const qb = this.tasksRepository.createQueryBuilder("task");
    if (user.role !== 'admin') {
      qb.where("task.userId = :userId", { userId: user.id });
    }
    qb.select("COUNT(*)", "total")
      .addSelect(`SUM(CASE WHEN task.status = :completed THEN 1 ELSE 0 END)`, "completed")
      .addSelect(`SUM(CASE WHEN task.status = :inProgress THEN 1 ELSE 0 END)`, "inProgress")
      .addSelect(`SUM(CASE WHEN task.status = :pending THEN 1 ELSE 0 END)`, "pending")
      .addSelect(`SUM(CASE WHEN task.priority = :high THEN 1 ELSE 0 END)`, "highPriority")
      .addSelect(`SUM(CASE WHEN task.priority = :medium THEN 1 ELSE 0 END)`, "mediumPriority")
      .addSelect(`SUM(CASE WHEN task.priority = :low THEN 1 ELSE 0 END)`, "lowPriority")
      .setParameters({
        completed: TaskStatus.COMPLETED,
        inProgress: TaskStatus.IN_PROGRESS,
        pending: TaskStatus.PENDING,
        high: TaskPriority.HIGH,
        medium: TaskPriority.MEDIUM,
        low: TaskPriority.LOW,
        ...(user.role !== 'admin' && { userId: user.id })
      });
    const statsResult = await qb.getRawOne();
    const statistics = {
      total: parseInt(statsResult?.total || '0', 10),
      completed: parseInt(statsResult?.completed || '0', 10),
      inProgress: parseInt(statsResult?.inProgress || '0', 10),
      pending: parseInt(statsResult?.pending || '0', 10),
      highPriority: parseInt(statsResult?.highPriority || '0', 10),
      mediumPriority: parseInt(statsResult?.mediumPriority || '0', 10),
      lowPriority: parseInt(statsResult?.lowPriority || '0', 10),
    };
    return statistics;
  }

  // --- CREATE (With Transaction) ---
  async create(createTaskDto: CreateTaskDto, user: UserPayload): Promise<Task> {
    // Caching Note: Create operations usually invalidate list caches, but we don't cache lists here yet.
    return this.dataSource.transaction(async (transactionalEntityManager) => {
      const task = transactionalEntityManager.create(Task, {
        ...createTaskDto,
        user: { id: user.id }
      });
      const savedTask = await transactionalEntityManager.save(Task, task);
      try {
        await this.taskQueue.add('task-status-update', {
             taskId: savedTask.id,
             status: savedTask.status,
         });
      } catch (queueError) {
        if (queueError instanceof Error) {
          this.logger.error(
            `Failed to add task ${savedTask.id} to queue (TX WILL ROLLBACK): ${queueError.message}`,
            queueError.stack
          );
        } else {
          this.logger.error(
            `Failed to add task ${savedTask.id} to queue (TX WILL ROLLBACK): Unknown error`,
            String(queueError)
          );
        }
        throw new Error(`Failed to queue task update for ${savedTask.id}.`);
      }
      // Fetch again to return entity with relations possibly needed by client
      const result = await transactionalEntityManager.findOne(Task, { // Use TX manager to read within TX
           where: { id: savedTask.id },
           relations: { user: true },
       });
       if (!result) throw new NotFoundException('Failed to retrieve created task after save.');
       return result;
    });
  }

  // --- FINDALLPAGINATED (Optimized - No Caching) ---
  async findAllPaginated( queryDto: QueryTaskDto, user: UserPayload ): Promise<PaginatedResponse<Task>> {
    const { page = 1, limit = 10, status, priority } = queryDto;
    const skip = (page - 1) * limit;
    const whereClause: FindOptionsWhere<Task> = {};
    if (user.role !== 'admin') { whereClause.user = { id: user.id }; }
    if (status) { whereClause.status = status; }
    if (priority) { whereClause.priority = priority; }
    const findOptions: FindManyOptions<Task> = {
        where: whereClause,
        relations: { user: true }, // Eager load user - adjust if needed
        take: limit,
        skip: skip,
        order: { createdAt: 'DESC' }
    };
    const [tasks, totalItems] = await this.tasksRepository.findAndCount(findOptions);
    const totalPages = Math.ceil(totalItems / limit);
    return {
        data: tasks,
        meta: { total: totalItems, page, limit, totalPages }
    };
  }

  // --- FINDONE (Optimized Fetch & Added Caching) ---
  async findOne(id: string, user: UserPayload): Promise<Task> {
    const cacheKey = `task:${id}`;
    this.logger.debug(`findOne: Checking cache for key: ${cacheKey}`);

    try {
      // 1. Check Cache
      const cachedTaskData = await this.cacheManager.get<any>(cacheKey);
      if (cachedTaskData) {
        this.logger.debug(`findOne: Cache HIT for key: ${cacheKey}`);
        // Ensure cached data has necessary info for auth check
        const cachedUserId = cachedTaskData.userId || cachedTaskData.user?.id;
        if (!cachedUserId) {
             this.logger.warn(`findOne: Cached data for ${cacheKey} missing user ID.`);
             // Treat as cache miss if essential data is missing
        } else {
             // IMPORTANT: Re-validate authorization on cached data
             if (user.role !== 'admin' && cachedUserId !== user.id) {
                 throw new ForbiddenException('You do not have permission to access this task (cache).');
             }
             // Return cached data (potentially rehydrated if needed)
             return cachedTaskData as Task; // Be cautious with casting
        }
      }

      this.logger.debug(`findOne: Cache MISS for key: ${cacheKey}`);

      // 2. Cache Miss -> Fetch from DB
      const task = await this.tasksRepository.findOne({
          where: { id },
          relations: { user: true }, // Need user relation for auth check
      });

      if (!task) {
          throw new NotFoundException(`Task with ID ${id} not found`);
      }

      // 3. Authorization Check (on DB data)
      if (user.role !== 'admin' && task.user?.id !== user.id) {
          throw new ForbiddenException('You do not have permission to access this task.');
      }

      // 4. Store fetched data in Cache before returning
      const ttlSeconds = this.configService.get<number>('CACHE_TTL', 300); // Get TTL in seconds
      await this.cacheManager.set(cacheKey, task, ttlSeconds * 1000); // Set cache with TTL in ms
      this.logger.debug(`findOne: Stored data in cache for key: ${cacheKey} with TTL: ${ttlSeconds * 1000}ms`);

      return task;

    } catch (error) {
      if (error instanceof NotFoundException || error instanceof ForbiddenException) {
        throw error; // Re-throw specific HTTP exceptions
      }
    
      if (error instanceof Error) {
        this.logger.error(`Error in findOne for task ${id}: ${error.message}`, error.stack);
      } else {
        this.logger.error(`Unknown error in findOne for task ${id}: ${String(error)}`);
      }
    
      throw new HttpException('Failed to retrieve task', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
  // --- END UPDATED findOne ---


  // --- UPDATE (Optimized Fetch, Transaction, Added Cache Invalidation) ---
  async update(id: string, updateTaskDto: UpdateTaskDto, user: UserPayload): Promise<Task> {
    const cacheKey = `task:${id}`;

    const updatedTaskResult = await this.dataSource.transaction(async (transactionalEntityManager) => {
        // Fetch using the transactional entity manager
        const task = await transactionalEntityManager.findOne(Task, {
             where: { id },
             relations: { user: true }, // Needed for auth check
         });

        if (!task) throw new NotFoundException(`Task with ID ${id} not found`);

        // Authorization Check
        if (user.role !== 'admin' && task.user?.id !== user.id) {
            throw new ForbiddenException('You do not have permission to update this task.');
        }

        const originalStatus = task.status;
        // Apply updates using merge (safer than Object.assign for entities)
        transactionalEntityManager.merge(Task, task, updateTaskDto);
        const savedTask = await transactionalEntityManager.save(Task, task); // Save updated entity

        // Add to queue if status changed
        if (updateTaskDto.status && originalStatus !== savedTask.status) {
            try {
                await this.taskQueue.add('task-status-update', { taskId: savedTask.id, status: savedTask.status });
            } catch (queueError) {
              if (queueError instanceof Error) {
                this.logger.error(
                  `Failed to add updated task ${savedTask.id} to queue (TX WILL ROLLBACK): ${queueError.message}`,
                  queueError.stack
                );
              } else {
                this.logger.error(
                  `Failed to add updated task ${savedTask.id} to queue (TX WILL ROLLBACK): Unknown error`,
                  String(queueError)
                );
              }
            
              throw new Error(`Failed to queue task update for ${savedTask.id}.`);
            }
        }
        // Return the updated task from transaction scope
        return savedTask;
    });

     // --- Invalidate Cache AFTER successful transaction ---
     try {
        await this.cacheManager.del(cacheKey);
        this.logger.debug(`update: Cache invalidated for key: ${cacheKey}`);
     } catch (cacheError) {
      if (cacheError instanceof Error) {
        this.logger.error(
          `Failed to invalidate cache for key ${cacheKey} after update: ${cacheError.message}`,
          cacheError.stack
        );
      } else {
        this.logger.error(
          `Failed to invalidate cache for key ${cacheKey} after update: Unknown error`,
          String(cacheError)
        );
      }
      // Don't fail the request if only cache invalidation fails
     }
     // --------------------------------------------------

     // Return the result (might lack relations if not eagerly loaded by save)
     // Re-fetch if necessary, or ensure client doesn't strictly need relations on update response
      const result = await this.tasksRepository.findOne({
           where: { id: updatedTaskResult.id },
           relations: { user: true }, // Re-fetch with relations
       });
       if (!result) throw new NotFoundException('Failed to retrieve updated task post-cache invalidation');
       return result;

     // return updatedTaskResult; // Alternative: return result from TX (might lack relations)
  }
  // --- END UPDATED update ---


  // --- REMOVE (Optimized Fetch, Auth Check, Added Cache Invalidation) ---
  async remove(id: string, user: UserPayload): Promise<void> {
     const cacheKey = `task:${id}`;

     // 1. Check existence and authorization first using findOne (which is now cached)
     // This ensures task exists and user is authorized before attempting delete
     await this.findOne(id, user); // We don't need the return value here, just the checks

     // 2. Perform deletion using the main repository
     const deleteResult = await this.tasksRepository.delete({ id }); // Use criteria directly

     if (deleteResult.affected === 0) {
         // This case should technically be caught by findOne, but check again
         throw new NotFoundException(`Task with ID ${id} not found for deletion.`);
     }

     // --- Invalidate Cache AFTER successful deletion ---
     try {
       await this.cacheManager.del(cacheKey);
       this.logger.debug(`remove: Cache invalidated for key: ${cacheKey}`);
     } catch (cacheError) {
      if (cacheError instanceof Error) {
        this.logger.error(
          `Failed to invalidate cache for key ${cacheKey} after delete: ${cacheError.message}`,
          cacheError.stack
        );
      } else {
        this.logger.error(
          `Failed to invalidate cache for key ${cacheKey} after delete: Unknown error`,
          String(cacheError)
        );
      }
      // Don't fail the request if only cache invalidation fails
     }
     // --------------------------------------------------
  }
  // --- END UPDATED remove ---


  // --- findByStatus (Refactored - No Caching) ---
  async findByStatus(status: TaskStatus, user: UserPayload): Promise<Task[]> {
    const whereClause: FindOptionsWhere<Task> = { status: status };
    if (user.role !== 'admin') { whereClause.user = { id: user.id }; }
    return this.tasksRepository.find({
        where: whereClause,
        relations: { user: true },
        order: { createdAt: 'DESC' }
    });
  }

  // --- updateStatus (Optimized - No Caching/Auth yet) ---
  async updateStatus(id: string, status: string): Promise<Task> {
    // Auth still TODO based on processor context
    const result = await this.tasksRepository.update(id, { status: status as TaskStatus });
    if (result.affected === 0) { throw new NotFoundException(`Task with ID ${id} not found`); }
    const updatedTask = await this.tasksRepository.findOneBy({ id });
    if (!updatedTask) { throw new NotFoundException(`Task with ID ${id} not found after update attempt`);}
    return updatedTask;
  }

  // --- Batch Methods (Optimized + Added Cache Invalidation) ---
  async batchUpdateStatus(taskIds: string[], status: TaskStatus, user: UserPayload): Promise<{ affected: number }> {
      // ... (Bulk auth check logic remains the same) ...
       if (user.role !== 'admin') {
          const ownedCount = await this.tasksRepository.count({ where: { id: In(taskIds), user: { id: user.id } }});
          if (ownedCount !== taskIds.length) { throw new ForbiddenException(/*...*/); }
       }

      const updateCriteria: FindOptionsWhere<Task> = { id: In(taskIds) };
      if (user.role !== 'admin') { updateCriteria.user = { id: user.id }; }

      const result = await this.tasksRepository.update(updateCriteria, { status });
      const affectedCount = result.affected ?? 0;

      // Invalidate Cache AFTER successful update (best effort)
      if (affectedCount > 0) {
          // Invalidate only the keys that were likely updated (based on initial IDs)
          const cacheKeys = taskIds.map(tid => `task:${tid}`);
          this.logger.debug(`batchUpdateStatus: Invalidating ${cacheKeys.length} cache keys...`);
          Promise.allSettled(cacheKeys.map(key => this.cacheManager.del(key)))
            .then(results => { /* ... logging for failed invalidations ... */ });
      }

      return { affected: affectedCount };
  }

  async batchDelete(taskIds: string[], user: UserPayload): Promise<{ affected: number }> {
       // ... (Bulk auth check logic remains the same) ...
        if (user.role !== 'admin') {
           const ownedCount = await this.tasksRepository.count({ where: { id: In(taskIds), user: { id: user.id } }});
           if (ownedCount !== taskIds.length) { throw new ForbiddenException(/*...*/); }
        }

       const deleteCriteria: FindOptionsWhere<Task> = { id: In(taskIds) };
       if (user.role !== 'admin') { deleteCriteria.user = { id: user.id }; }

       const result = await this.tasksRepository.delete(deleteCriteria);
       const affectedCount = result.affected ?? 0;

       // Invalidate Cache AFTER successful delete (best effort)
       if (affectedCount > 0) {
            const cacheKeys = taskIds.map(tid => `task:${tid}`);
            this.logger.debug(`batchDelete: Invalidating ${cacheKeys.length} cache keys...`);
            Promise.allSettled(cacheKeys.map(key => this.cacheManager.del(key)))
              .then(results => { /* ... logging for failed invalidations ... */ });
       }

       return { affected: affectedCount };
  }
  // --- END BATCH METHODS ---

}