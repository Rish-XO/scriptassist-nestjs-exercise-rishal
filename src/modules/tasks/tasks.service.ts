import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, FindManyOptions, FindOptionsWhere, In, Repository } from 'typeorm';
import { Task } from './entities/task.entity';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { TaskStatus } from './enums/task-status.enum';
import { TaskPriority } from './enums/task-priority.enum';
import { PaginatedResponse } from '../../types/pagination.interface';
import { QueryTaskDto } from './dto/task-filter.dto';

interface UserPayload {
  id: string;
  email: string;
  role: string;
}

@Injectable()
export class TasksService {
  constructor(
    @InjectRepository(Task)
    private tasksRepository: Repository<Task>,
    @InjectQueue('task-processing')
    private taskQueue: Queue,
    private dataSource: DataSource,
  ) {}

  async getStats(user: UserPayload) {
    const qb = this.tasksRepository.createQueryBuilder("task");

    // Apply user filtering ONLY if the user is not an admin
    if (user.role !== 'admin') {
      qb.where("task.userId = :userId", { userId: user.id });
      // Note: Ensure your Task entity has a "userId" column if using this directly,
      // or use the relation `task.user.id` if appropriate for your setup,
      // but filtering on the foreign key column `userId` is usually more efficient.
      // Let's assume `userId` column exists on `task` table based on schema script.
    }

    // Use conditional aggregation to count different statuses and priorities in one query
    qb.select("COUNT(*)", "total")
      .addSelect(`SUM(CASE WHEN task.status = :completed THEN 1 ELSE 0 END)`, "completed")
      .addSelect(`SUM(CASE WHEN task.status = :inProgress THEN 1 ELSE 0 END)`, "inProgress")
      .addSelect(`SUM(CASE WHEN task.status = :pending THEN 1 ELSE 0 END)`, "pending")
      .addSelect(`SUM(CASE WHEN task.priority = :high THEN 1 ELSE 0 END)`, "highPriority")
      .addSelect(`SUM(CASE WHEN task.priority = :medium THEN 1 ELSE 0 END)`, "mediumPriority")
      .addSelect(`SUM(CASE WHEN task.priority = :low THEN 1 ELSE 0 END)`, "lowPriority")
      .setParameters({ // Set parameters for status/priority values
        completed: TaskStatus.COMPLETED,
        inProgress: TaskStatus.IN_PROGRESS,
        pending: TaskStatus.PENDING,
        high: TaskPriority.HIGH,
        medium: TaskPriority.MEDIUM,
        low: TaskPriority.LOW,
        // userId parameter is added conditionally above if needed
        ...(user.role !== 'admin' && { userId: user.id })
      });

    // Execute the query and get the raw results
    const statsResult = await qb.getRawOne();

    // Parse the raw results (which might be strings) into numbers
    const statistics = {
      total: parseInt(statsResult.total, 10) || 0,
      completed: parseInt(statsResult.completed, 10) || 0,
      inProgress: parseInt(statsResult.inProgress, 10) || 0,
      pending: parseInt(statsResult.pending, 10) || 0,
      highPriority: parseInt(statsResult.highPriority, 10) || 0,
      mediumPriority: parseInt(statsResult.mediumPriority, 10) || 0,
      lowPriority: parseInt(statsResult.lowPriority, 10) || 0,
    };

    return statistics;
  }

  async create(createTaskDto: CreateTaskDto, user: UserPayload): Promise<Task> {
    // Wrap operations in a transaction
    return this.dataSource.transaction(async (transactionalEntityManager) => {
      const task = transactionalEntityManager.create(Task, { // Use manager.create
        ...createTaskDto,
        user: { id: user.id }
      });
      const savedTask = await transactionalEntityManager.save(Task, task); // Use manager.save

      // Add to queue WITHIN the transaction block
      // Note: Potential distributed transaction issue if queue add fails AFTER commit starts
      // or DB commit fails AFTER queue add succeeds. Simpler approach for now.
      try {
        await this.taskQueue.add('task-status-update', {
          taskId: savedTask.id,
          status: savedTask.status,
        });
      } catch (queueError) {
          console.error("Failed to add task to queue, rolling back transaction", queueError);
          // Throwing error here will cause the transaction manager to rollback
          throw new Error(`Failed to add task ${savedTask.id} to queue.`);
      }

      // Fetch and return the task with relation (using original repository or manager)
      // Fetching outside might be safer if queue interaction inside TX is problematic
      const result = await this.tasksRepository.findOne({ // Use main repo here is fine
           where: { id: savedTask.id },
           relations: { user: true },
       });
       if (!result) throw new NotFoundException('Failed to retrieve created task');
       return result;

    }); // End transaction block
}

// --- NEW METHOD for Paginated/Filtered FindAll ---
  /**
   * Finds tasks with pagination, filtering, and user-based access control.
   * @param queryDto DTO containing pagination and filter parameters.
   * @param user The authenticated user payload.
   * @returns A paginated result set of tasks.
   */
  async findAllPaginated(
    queryDto: QueryTaskDto,
    user: UserPayload,
  ): Promise<PaginatedResponse<Task>> {
    // Destructure DTO, applying defaults if necessary (defaults are set in DTO)
    const { page = 1, limit = 10, status, priority /*, sortBy, sortOrder, search */ } = queryDto;
    const skip = (page - 1) * limit;

    // Start building the WHERE clause for the query
    const whereClause: FindOptionsWhere<Task> = {};

    // Filter by user ID ONLY if the user is NOT an admin
    if (user.role !== 'admin') {
      whereClause.user = { id: user.id };
    }

    // Add status filter if provided
    if (status) {
      whereClause.status = status;
    }

    // Add priority filter if provided
    if (priority) {
      whereClause.priority = priority;
    }

    // TODO: Add search filter if implementing search (e.g., using ILIKE on title/description)
    // if (search) {
    //   whereClause.title = ILike(`%${search}%`); // Example, may need array for multiple conditions
    // }

    // Build the main options object for TypeORM's findAndCount
    const findOptions: FindManyOptions<Task> = {
      where: whereClause,
      relations: { user: true }, // Eager load user details (consider if always needed)
      take: limit, // Apply limit (items per page)
      skip: skip, // Apply offset (for pagination)
      order: {
        createdAt: 'DESC', // Default sort order (newest first)
        // TODO: Add dynamic sorting based on DTO params `sortBy`, `sortOrder` if implemented
        // ...(sortBy && sortOrder && { [sortBy]: sortOrder }),
      },
    };

    // Execute the query using findAndCount to get tasks and total count efficiently
    const [tasks, totalItems] = await this.tasksRepository.findAndCount(findOptions);

    // Calculate pagination metadata
    const totalPages = Math.ceil(totalItems / limit);

    // Structure the response according to your PaginatedResponse<T> interface
    return {
      data: tasks,
      meta: {
        total: totalItems,    // Use 'total' as per your interface
        page: page,         // Use 'page' as per your interface
        limit: limit,       // Use 'limit' as per your interface
        totalPages: totalPages, // Use 'totalPages' as per your interface
      },
    };
  }

  // --- FINDONE (Optimize fetch & Add Auth Check) ---
  async findOne(id: string, user: UserPayload): Promise<Task> { // <-- Accept UserPayload
    // Optimized: Fetch in one go using findOne
    const task = await this.tasksRepository.findOne({
        where: { id },
        relations: { user: true }, // Need user relation for auth check
    });

    if (!task) {
        throw new NotFoundException(`Task with ID ${id} not found`);
    }

    // --- Authorization Check ---
    if (user.role !== 'admin' && task.user?.id !== user.id) {
        throw new ForbiddenException('You do not have permission to access this task.');
    }
    // --------------------------

    return task;
  }


  async update(id: string, updateTaskDto: UpdateTaskDto, user: UserPayload): Promise<Task> {
    // 1. Check existence and authorization first (using the already fixed findOne)
    const task = await this.findOne(id, user);
    const originalStatus = task.status;

    // 2. Wrap the update and queue logic in a transaction
    return this.dataSource.transaction(async (transactionalEntityManager) => {
      // Apply updates using merge within the transaction
      // Note: 'task' object is already loaded, merge applies dto changes onto it
      transactionalEntityManager.merge(Task, task, updateTaskDto);

      // Save using the transactional entity manager
      const updatedTask = await transactionalEntityManager.save(Task, task); // Pass class and entity

      // Add to queue if status changed, WITHIN the transaction block
      if (updateTaskDto.status && originalStatus !== updatedTask.status) {
        try {
          await this.taskQueue.add('task-status-update', {
            taskId: updatedTask.id,
            status: updatedTask.status,
          });
        } catch (queueError) {
          console.error("Failed to add updated task to queue, rolling back transaction", queueError);
          // Throwing error here will cause the transaction manager to rollback
          throw new Error(`Failed to add updated task ${updatedTask.id} to queue.`);
        }
      }
      // Important: Return the task *after* potentially fetching relations again
      // if the caller needs them and `save` doesn't return them eagerly with the manager.
      // Fetching using the manager ensures it's part of the transaction snapshot.
      const result = await transactionalEntityManager.findOne(Task, {
           where: { id: updatedTask.id },
           relations: { user: true }, // Re-fetch with relations if needed by client
       });
       if (!result) throw new NotFoundException('Failed to retrieve updated task'); // Should not happen
       return result;

      // Or if relations aren't needed, simply: return updatedTask; (less safe if save result differs)

    }); // End transaction block
  }
  
// --- REMOVE (Optimize fetch & Add Auth Check) ---
async remove(id: string, user: UserPayload): Promise<void> { // <-- Accept UserPayload
  // Fetch the task first, ensuring it exists and checking auth in one go
 const task = await this.findOne(id, user); // Re-use findOne logic including auth check

 // task is guaranteed to exist and be accessible by the user here

 await this.tasksRepository.remove(task);
 // No return value needed for remove
}

  // --- FIND BY STATUS (Add Auth Check - Needs further refactor later) ---
  async findByStatus(status: TaskStatus, user: UserPayload): Promise<Task[]> { // <-- Accept UserPayload
    // TODO: Refactor to use QueryBuilder or find options
    const baseQuery = 'SELECT * FROM tasks WHERE status = $1';
    let finalQuery = baseQuery;
    const queryParams: any[] = [status];

    if (user.role !== 'admin') {
      finalQuery += ' AND user_id = $2';
      queryParams.push(user.id);
    }

    return this.tasksRepository.query(finalQuery, queryParams);
  }

  // --- UPDATE STATUS (Needs Auth Consideration) ---
  async updateStatus(id: string, status: string): Promise<Task> {
    // TODO: Determine authorization strategy for task processor calls
    // This method might be called by a system process, not a logged-in user.
    // For now, we optimize the update but skip user auth check here.
    const result = await this.tasksRepository.update(id, { status: status as TaskStatus });
    if (result.affected === 0) {
        throw new NotFoundException(`Task with ID ${id} not found`);
    }
    const updatedTask = await this.tasksRepository.findOneBy({ id });
    if (!updatedTask) {
      throw new NotFoundException(`Task with ID ${id} not found after update attempt`);
    }
    // Re-attach user relation if needed by caller? Be careful.
    // Fetching again without relation is safer if caller doesn't need user.
    return updatedTask;
  }

  // --- ADD BATCH METHODS ---

async batchUpdateStatus(taskIds: string[], status: TaskStatus, user: UserPayload): Promise<{ affected: number }> {
  // 1. Authorization Check (if not admin)
  if (user.role !== 'admin') {
      // Find how many of the requested IDs actually belong to the user
      const ownedCount = await this.tasksRepository.count({
          where: {
              id: In(taskIds), // Check only within the requested IDs
              user: { id: user.id }
          }
      });
      // If the count doesn't match, the user tried to update tasks they don't own
      if (ownedCount !== taskIds.length) {
          // For simplicity, deny the whole operation. Could also filter IDs.
          throw new ForbiddenException('You do not have permission to update one or more of the specified tasks.');
      }
  }

  // 2. Perform Bulk Update
  // Add user filter again for non-admins as an extra safety layer in the update itself
  const updateCriteria: FindOptionsWhere<Task> = { id: In(taskIds) };
  if (user.role !== 'admin') {
      updateCriteria.user = { id: user.id };
  }

  const result = await this.tasksRepository.update(updateCriteria, { status });

  // TODO: Consider adding a single batch job to the queue if needed

  return { affected: result.affected ?? 0 };
}

async batchDelete(taskIds: string[], user: UserPayload): Promise<{ affected: number }> {
  // 1. Authorization Check (if not admin)
  if (user.role !== 'admin') {
      const ownedCount = await this.tasksRepository.count({
          where: {
              id: In(taskIds),
              user: { id: user.id }
          }
      });
      if (ownedCount !== taskIds.length) {
          throw new ForbiddenException('You do not have permission to delete one or more of the specified tasks.');
      }
  }

  // 2. Perform Bulk Delete
  const deleteCriteria: FindOptionsWhere<Task> = { id: In(taskIds) };
   if (user.role !== 'admin') {
       deleteCriteria.user = { id: user.id };
   }
  const result = await this.tasksRepository.delete(deleteCriteria);

  return { affected: result.affected ?? 0 };
}
}