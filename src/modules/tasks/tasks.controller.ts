// src/modules/tasks/tasks.controller.ts
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

  // --- BATCH PROCESS ---
  @Post('batch')
  @ApiOperation({ summary: 'Batch process multiple tasks' })
  async batchProcess(
      @Body() operations: { tasks: string[], action: string },
      @Req() req: UserInRequest // <-- Inject Req
  ) {
    const user = req.user;
    if (!user) {
      throw new UnauthorizedException();
    }

    // TODO: Refactor this entire endpoint to use a dedicated service method
    // that performs bulk authorization checks *before* executing bulk DB operations.
    // The current loop performs N+1 authorization checks and N+1 DB operations.

    // --- Keeping placeholder N+1 logic with per-call auth for now ---
    const { tasks: taskIds, action } = operations;
    const results = [];
    for (const taskId of taskIds) {
      try {
        let result;
        switch (action) {
          case 'complete':
             // Pass user - service will check auth for EACH task (N+1 problem remains)
            result = await this.tasksService.update(taskId, { status: TaskStatus.COMPLETED }, user);
            break;
          case 'delete':
             // Pass user - service will check auth for EACH task (N+1 problem remains)
            await this.tasksService.remove(taskId, user); // remove is void
            result = { id: taskId, deleted: true }; // Provide some result indication
            break;
          default:
            throw new HttpException(`Unknown action: ${action}`, HttpStatus.BAD_REQUEST);
        }
        results.push({ taskId, success: true, result });
      } catch (error) {
         results.push({
           taskId,
           success: false,
           error: error instanceof Error ? error.message : 'Unknown error',
           status: error instanceof HttpException ? error.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR // Provide status
         });
      }
    }
    return results;
    // --- End placeholder N+1 logic ---
  }
}