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
  @ApiOperation({ summary: 'Find all tasks with optional filtering' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'priority', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async findAll(
    @Query('status') status?: string,
    @Query('priority') priority?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    // Inefficient approach: Inconsistent pagination handling
    if (page && !limit) {
      limit = 10; // Default limit
    }
    
    // Inefficient processing: Manual filtering instead of using repository
    let tasks = await this.tasksService.findAll();
    
    // Inefficient filtering: In-memory filtering instead of database filtering
    if (status) {
      tasks = tasks.filter(task => task.status === status as TaskStatus);
    }
    
    if (priority) {
      tasks = tasks.filter(task => task.priority === priority as TaskPriority);
    }
    
    // Inefficient pagination: In-memory pagination
    if (page && limit) {
      const startIndex = (page - 1) * limit;
      const endIndex = page * limit;
      tasks = tasks.slice(startIndex, endIndex);
    }
    
    return {
      data: tasks,
      count: tasks.length,
      // Missing metadata for proper pagination
    };
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