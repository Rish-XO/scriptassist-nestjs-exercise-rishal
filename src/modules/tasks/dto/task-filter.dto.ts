
import { IsOptional, IsEnum, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer'; // Required for validation of transformed types
import { TaskStatus } from '../enums/task-status.enum';
import { TaskPriority } from '../enums/task-priority.enum';
import { ApiPropertyOptional } from '@nestjs/swagger'; // For Swagger documentation

// Renamed from TaskFilterDto to align with general query parameter handling
export class QueryTaskDto {

  @ApiPropertyOptional({
    description: 'Filter tasks by status',
    enum: TaskStatus,
  })
  @IsOptional() // This field is not required
  @IsEnum(TaskStatus, { message: 'Status must be a valid TaskStatus enum value' }) // Validate against the enum
  status?: TaskStatus; // Property to filter by status

  @ApiPropertyOptional({
    description: 'Filter tasks by priority',
    enum: TaskPriority,
  })
  @IsOptional() // This field is not required
  @IsEnum(TaskPriority, { message: 'Priority must be a valid TaskPriority enum value' }) // Validate against the enum
  priority?: TaskPriority; // Property to filter by priority

  @ApiPropertyOptional({
    description: 'Page number for pagination',
    type: Number,
    minimum: 1,
    default: 1,
  })
  @IsOptional()
  @Type(() => Number) // Transform query string param ("1", "2") to number (1, 2)
  @IsInt({ message: 'Page must be an integer number' })
  @Min(1, { message: 'Page must not be less than 1' })
  page?: number = 1; // Default to page 1 if not provided

  @ApiPropertyOptional({
    description: 'Number of items per page',
    type: Number,
    minimum: 1,
    maximum: 100, // Set a reasonable maximum limit
    default: 10,
  })
  @IsOptional()
  @Type(() => Number) // Transform query string param to number
  @IsInt({ message: 'Limit must be an integer number' })
  @Min(1, { message: 'Limit must not be less than 1' })
  @Max(100, { message: 'Limit must not be greater than 100' })
  limit?: number = 10; // Default to 10 items per page if not provided

  // --- Optional: Add Sorting ---
  // @ApiPropertyOptional({ description: 'Field to sort by (e.g., createdAt, dueDate)'})
  // @IsOptional()
  // @IsString()
  // sortBy?: string;

  // @ApiPropertyOptional({ description: 'Sort order', enum: ['ASC', 'DESC'], default: 'DESC' })
  // @IsOptional()
  // @IsEnum(['ASC', 'DESC'])
  // sortOrder?: 'ASC' | 'DESC' = 'DESC';
  // --------------------------

  // --- Optional: Add Search Term ---
  // @ApiPropertyOptional({ description: 'Search term for task title or description'})
  // @IsOptional()
  // @IsString()
  // @MinLength(3) // Example validation
  // search?: string;
  // --------------------------
}