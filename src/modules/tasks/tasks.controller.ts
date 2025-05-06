import {
  Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Query,
  HttpException, HttpStatus, UseInterceptors, Req, UnauthorizedException, // <-- Added UnauthorizedException
  ForbiddenException, // <-- Added ForbiddenException (though likely handled by service)
  HttpCode, // <-- Added HttpCode
  NotFoundException // <-- Added NotFoundException (though likely handled by service)
} from '@nestjs/common';
import { TasksService } from './tasks.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { Task } from './entities/task.entity';
import { PaginatedResponse } from '../../types/pagination.interface'; // <-- Ensure correct path
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { TaskStatus } from './enums/task-status.enum';
import { TaskPriority } from './enums/task-priority.enum';
import { RateLimitGuard } from '../../common/guards/rate-limit.guard';
import { RateLimit } from '../../common/decorators/rate-limit.decorator';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard'; // <-- Ensure correct path
import { Request } from 'express';
import { QueryTaskDto } from './dto/task-filter.dto';

// Define UserPayload or import if defined globally
interface UserPayload {
  id: string;
  email: string;
  role: string;
}
interface UserInRequest extends Request { user?: UserPayload }

@ApiTags('tasks')
@Controller('tasks')
@UseGuards(JwtAuthGuard, RateLimitGuard) // Apply guards globally to this controller
@RateLimit({ limit: 100, windowMs: 60000 }) // Example Rate Limit
@ApiBearerAuth() // Indicate in Swagger that Bearer Auth is needed
export class TasksController {
  constructor(
    private readonly tasksService: TasksService,
    // Repository injection was correctly removed previously
  ) {}

  // --- CREATE ---
  @Post()
  @ApiOperation({ summary: 'Create a new task' })
  async create( // <-- Add async
    @Body() createTaskDto: CreateTaskDto,
    @Req() req: UserInRequest // <-- Inject Req
  ) {
    const user = req.user; // Get user from request (populated by JwtAuthGuard)
    if (!user) {
        // This check is redundant if JwtAuthGuard works correctly, but safe to keep
        throw new UnauthorizedException('User not found on request');
    }
    // Pass DTO and the user payload to the service
    return this.tasksService.create(createTaskDto, user); // Pass user object
  }

  // --- FIND ALL (Paginated & Filtered) ---
  @Get()
  @ApiOperation({ summary: 'Find all tasks with filtering and pagination' })
  // Swagger params are now inferred from QueryTaskDto
  async findAll(
    @Query() queryDto: QueryTaskDto,   // <-- Use the QueryTaskDto
    @Req() req: UserInRequest         // <-- Inject Req
  ): Promise<PaginatedResponse<Task>> { // <-- Correct return type
    const user = req.user;
    if (!user) {
      throw new UnauthorizedException();
    }
    // Delegate fetching, filtering, pagination, and user-based access control to the service
    return this.tasksService.findAllPaginated(queryDto, user);
  }

  // --- GET STATS ---
  @Get('stats')
  @ApiOperation({ summary: 'Get task statistics' })
  async getStats(@Req() req: UserInRequest) { // <-- Inject Req
    const user = req.user;
    if (!user) {
      throw new UnauthorizedException();
    }
    // Delegate the logic entirely to the service, passing the user context
    return this.tasksService.getStats(user); // <-- Call service method
  }

  // --- FIND ONE ---
  @Get(':id')
  @ApiOperation({ summary: 'Find a task by ID' })
  async findOne(
    @Param('id') id: string,
    @Req() req: UserInRequest // <-- Inject Req
  ) {
    const user = req.user;
    if (!user) {
      throw new UnauthorizedException();
    }
    // Service method handles NotFound and Forbidden checks
    return this.tasksService.findOne(id, user); // <-- Pass user object
    // Remove previous controller-level check and custom HttpException
  }

  // --- UPDATE ---
  @Patch(':id')
  @ApiOperation({ summary: 'Update a task' })
  async update( // <-- Add async
    @Param('id') id: string,
    @Body() updateTaskDto: UpdateTaskDto,
    @Req() req: UserInRequest // <-- Inject Req
  ) {
    const user = req.user;
    if (!user) {
      throw new UnauthorizedException();
    }
    // Service method handles NotFound and Forbidden checks
    return this.tasksService.update(id, updateTaskDto, user); // <-- Pass user object
  }

  // --- REMOVE ---
  @Delete(':id')
  @ApiOperation({ summary: 'Delete a task' })
  @HttpCode(HttpStatus.NO_CONTENT) // <-- Set success status code to 204 No Content
  async remove( // <-- Add async
    @Param('id') id: string,
    @Req() req: UserInRequest // <-- Inject Req
  ) {
    const user = req.user;
    if (!user) {
      throw new UnauthorizedException();
    }
    // Service method handles NotFound and Forbidden checks
    await this.tasksService.remove(id, user); // <-- Pass user object, await the promise
    // No content is returned for 204
  }

// --- REFACTORED BATCH PROCESS ---
@Post('batch')
@ApiOperation({ summary: 'Batch process multiple tasks (update status or delete)' })
async batchProcess(
    @Body() operations: { tasks: string[], action: string; status?: TaskStatus }, // Allow passing status for 'complete' etc.
    @Req() req: UserInRequest
) {
    const user = req.user;
    if (!user) throw new UnauthorizedException();

    const { tasks: taskIds, action } = operations;

    if (!taskIds || taskIds.length === 0) {
        throw new HttpException('No task IDs provided for batch operation', HttpStatus.BAD_REQUEST);
    }

    try {
        let result: { affected: number };
        switch (action.toLowerCase()) { // Use lowercase for case-insensitivity
            case 'complete':
                // You might want specific DTO validation to ensure status is COMPLETED here
                result = await this.tasksService.batchUpdateStatus(taskIds, TaskStatus.COMPLETED, user);
                break;
             case 'set_status': // Example for setting arbitrary status
                 if (!operations.status || !Object.values(TaskStatus).includes(operations.status)) {
                     throw new HttpException(`Invalid or missing status provided for action: ${action}`, HttpStatus.BAD_REQUEST);
                 }
                 result = await this.tasksService.batchUpdateStatus(taskIds, operations.status, user);
                 break;
            case 'delete':
                result = await this.tasksService.batchDelete(taskIds, user);
                break;
            default:
                throw new HttpException(`Unknown batch action: ${action}`, HttpStatus.BAD_REQUEST);
        }
        // Return a summary response
        return {
            action: action,
            success: true,
            affectedCount: result.affected,
            requestedCount: taskIds.length,
        };
    } catch (error) {
        // Catch errors thrown by the service (e.g., ForbiddenException) or others
        if (error instanceof HttpException) {
            throw error; // Re-throw known HTTP exceptions
        }
        console.error("Batch processing error:", error); // Log unexpected errors
        throw new HttpException('Batch operation failed', HttpStatus.INTERNAL_SERVER_ERROR);
    }
}
}