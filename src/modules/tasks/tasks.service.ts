import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindManyOptions, FindOptionsWhere, Repository } from 'typeorm';
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
  ) {}

  async getStats(user: UserPayload) {
    // Define query options based on user role
    const findOptions: FindManyOptions<Task> = {};
    if (user.role !== 'admin') {
      // Non-admin users only see their own tasks
      findOptions.where = { user: { id: user.id } }; // Filter by user ID relationship
    }
    // For admins, findOptions remains empty (fetches all tasks)

    // Inefficient approach (fetch all relevant tasks first) - WILL BE OPTIMIZED LATER
    const tasks = await this.tasksRepository.find(findOptions);

    // Inefficient computation (in-memory filtering) - WILL BE OPTIMIZED LATER
    const statistics = {
      total: tasks.length,
      completed: tasks.filter(t => t.status === TaskStatus.COMPLETED).length,
      inProgress: tasks.filter(t => t.status === TaskStatus.IN_PROGRESS).length,
      pending: tasks.filter(t => t.status === TaskStatus.PENDING).length,
      // Add priority stats if needed, requires TaskPriority enum import
      highPriority: tasks.filter(t => t.priority === TaskPriority.HIGH).length,
      mediumPriority: tasks.filter(t => t.priority === TaskPriority.MEDIUM).length,
      lowPriority: tasks.filter(t => t.priority === TaskPriority.LOW).length,
    };

    return statistics;
  }

  async create(createTaskDto: CreateTaskDto, user: UserPayload): Promise<Task> { // <-- Accept UserPayload
    const task = this.tasksRepository.create({
      ...createTaskDto,
      user: { id: user.id } // <-- Associate with logged-in user
    });
    // Note: You might want validation here to ensure required fields like title are present
    const savedTask = await this.tasksRepository.save(task);

    // Consider transaction later
    this.taskQueue.add('task-status-update', { /* ... */ });

    // Ideally return a DTO, but returning entity for now (ensure password isn't exposed)
    // We need to fetch the saved task again to get the user relation populated if needed client-side
     const result = await this.tasksRepository.findOne({
         where: { id: savedTask.id },
         relations: { user: true },
     });
     if (!result) {
         // Should not happen, but safety check
         throw new NotFoundException('Failed to retrieve created task');
     }
     return result;

    // return savedTask; // This won't have the user relation loaded
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


   // --- UPDATE (Optimize fetch & Add Auth Check) ---
   async update(id: string, updateTaskDto: UpdateTaskDto, user: UserPayload): Promise<Task> { // <-- Accept UserPayload
    // Fetch the task directly first, ensuring it exists and checking auth in one go
    const task = await this.findOne(id, user); // Re-use findOne logic including auth check

    // task is guaranteed to exist and be accessible by the user here due to findOne call

    const originalStatus = task.status;

    // Apply updates using TypeORM's merge or Object.assign
    // merge is slightly safer as it only considers properties defined in the entity
    this.tasksRepository.merge(task, updateTaskDto);

    // Save the merged entity
    const updatedTask = await this.tasksRepository.save(task);

    // Consider transaction later
    if (updateTaskDto.status && originalStatus !== updatedTask.status) {
      this.taskQueue.add('task-status-update', { /* ... */ });
    }

    return updatedTask; // Consider returning DTO
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
}