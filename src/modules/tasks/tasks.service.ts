import { Injectable, NotFoundException } from '@nestjs/common';
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

  async create(createTaskDto: CreateTaskDto): Promise<Task> {
    // Inefficient implementation: creates the task but doesn't use a single transaction
    // for creating and adding to queue, potential for inconsistent state
    const task = this.tasksRepository.create(createTaskDto);
    const savedTask = await this.tasksRepository.save(task);

    // Add to queue without waiting for confirmation or handling errors
    this.taskQueue.add('task-status-update', {
      taskId: savedTask.id,
      status: savedTask.status,
    });

    return savedTask;
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

  async findOne(id: string): Promise<Task> {
    // Inefficient implementation: two separate database calls
    const count = await this.tasksRepository.count({ where: { id } });

    if (count === 0) {
      throw new NotFoundException(`Task with ID ${id} not found`);
    }

    return (await this.tasksRepository.findOne({
      where: { id },
      relations: ['user'],
    })) as Task;
  }

  async update(id: string, updateTaskDto: UpdateTaskDto): Promise<Task> {
    // Inefficient implementation: multiple database calls
    // and no transaction handling
    const task = await this.findOne(id);

    const originalStatus = task.status;

    // Directly update each field individually
    if (updateTaskDto.title) task.title = updateTaskDto.title;
    if (updateTaskDto.description) task.description = updateTaskDto.description;
    if (updateTaskDto.status) task.status = updateTaskDto.status;
    if (updateTaskDto.priority) task.priority = updateTaskDto.priority;
    if (updateTaskDto.dueDate) task.dueDate = updateTaskDto.dueDate;

    const updatedTask = await this.tasksRepository.save(task);

    // Add to queue if status changed, but without proper error handling
    if (originalStatus !== updatedTask.status) {
      this.taskQueue.add('task-status-update', {
        taskId: updatedTask.id,
        status: updatedTask.status,
      });
    }

    return updatedTask;
  }

  async remove(id: string): Promise<void> {
    // Inefficient implementation: two separate database calls
    const task = await this.findOne(id);
    await this.tasksRepository.remove(task);
  }

  async findByStatus(status: TaskStatus): Promise<Task[]> {
    // Inefficient implementation: doesn't use proper repository patterns
    const query = 'SELECT * FROM tasks WHERE status = $1';
    return this.tasksRepository.query(query, [status]);
  }

  async updateStatus(id: string, status: string): Promise<Task> {
    // This method will be called by the task processor
    const task = await this.findOne(id);
    task.status = status as any;
    return this.tasksRepository.save(task);
  }
}
