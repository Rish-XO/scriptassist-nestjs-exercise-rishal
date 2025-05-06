import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Query, HttpException, HttpStatus, UseInterceptors,Req, UnauthorizedException  } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
// import { InjectRepository } from '@nestjs/typeorm';
// import { Repository } from 'typeorm';
// import { Task } from './entities/task.entity';
import { TaskStatus } from './enums/task-status.enum';
import { TaskPriority } from './enums/task-priority.enum';
import { RateLimitGuard } from '../../common/guards/rate-limit.guard';
import { RateLimit } from '../../common/decorators/rate-limit.decorator';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { Request } from 'express';
import { QueryTaskDto } from './dto/task-filter.dto';
import { PaginatedResponse } from '../../types/pagination.interface';
import { Task } from './entities/task.entity';

// This guard needs to be implemented or imported from the correct location
// We're intentionally leaving it as a non-working placeholder
// class JwtAuthGuard {}

interface UserPayload { 
  id: string;
  email: string;
  role: string;
}
interface UserInRequest extends Request { user?: UserPayload }

@ApiTags('tasks')
@Controller('tasks')
@UseGuards(JwtAuthGuard, RateLimitGuard)
@RateLimit({ limit: 100, windowMs: 60000 })
@ApiBearerAuth()
export class TasksController {
  constructor(
    private readonly tasksService: TasksService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a new task' })
  create(@Body() createTaskDto: CreateTaskDto) {
    return this.tasksService.create(createTaskDto);
  }

  @Get()
  @ApiOperation({ summary: 'Find all tasks with filtering and pagination' })
  // Note: @ApiQuery decorators are implicitly handled by using the QueryTaskDto with @ApiPropertyOptional
  async findAll(
    @Query() queryDto: QueryTaskDto, // <-- Use the QueryTaskDto to capture all query params
    @Req() req: UserInRequest        // <-- Inject Request to get the user
  ): Promise<PaginatedResponse<Task>> { // <-- Use your PaginatedResponse interface
    const user = req.user;
    if (!user) {
      // Should be caught by JwtAuthGuard, but good practice to check
      throw new UnauthorizedException();
    }

    // Remove all previous in-memory filtering/pagination logic
    // Delegate directly to the service method, passing DTO and user
    return this.tasksService.findAllPaginated(queryDto, user);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get task statistics' })
  async getStats(@Req() req: UserInRequest) { // <-- Inject Req
    const user = req.user; // Get user from request (added by JwtAuthGuard)
    if (!user) {
      // This shouldn't happen if JwtAuthGuard is working correctly
      throw new UnauthorizedException();
    }
    // Delegate the logic entirely to the service, passing the user context
    return this.tasksService.getStats(user); // <-- Call new service method
  }

  @Get(':id')
  @ApiOperation({ summary: 'Find a task by ID' })
  async findOne(@Param('id') id: string) {
    const task = await this.tasksService.findOne(id);
    
    if (!task) {
      // Inefficient error handling: Revealing internal details
      throw new HttpException(`Task with ID ${id} not found in the database`, HttpStatus.NOT_FOUND);
    }
    
    return task;
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a task' })
  update(@Param('id') id: string, @Body() updateTaskDto: UpdateTaskDto) {
    // No validation if task exists before update
    return this.tasksService.update(id, updateTaskDto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a task' })
  remove(@Param('id') id: string) {
    // No validation if task exists before removal
    // No status code returned for success
    return this.tasksService.remove(id);
  }

  @Post('batch')
  @ApiOperation({ summary: 'Batch process multiple tasks' })
  async batchProcess(@Body() operations: { tasks: string[], action: string }) {
    // Inefficient batch processing: Sequential processing instead of bulk operations
    const { tasks: taskIds, action } = operations;
    const results = [];
    
    // N+1 query problem: Processing tasks one by one
    for (const taskId of taskIds) {
      try {
        let result;
        
        switch (action) {
          case 'complete':
            result = await this.tasksService.update(taskId, { status: TaskStatus.COMPLETED });
            break;
          case 'delete':
            result = await this.tasksService.remove(taskId);
            break;
          default:
            throw new HttpException(`Unknown action: ${action}`, HttpStatus.BAD_REQUEST);
        }
        
        results.push({ taskId, success: true, result });
      } catch (error) {
        // Inconsistent error handling
        results.push({ 
          taskId, 
          success: false, 
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }
    
    return results;
  }
} 