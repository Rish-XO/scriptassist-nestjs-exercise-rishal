// src/modules/tasks/tasks.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { TasksService } from './tasks.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
// import { Cache } from 'cache-manager';
import { ConfigService } from '@nestjs/config';
import { Task } from './entities/task.entity';
import { User } from '../users/entities/user.entity'; // Assuming needed for relations/types
import { NotFoundException, ForbiddenException } from '@nestjs/common';
import { TaskStatus } from './enums/task-status.enum';
import { TaskPriority } from './enums/task-priority.enum';
import { QueryTaskDto } from './dto/task-filter.dto';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';

// Define UserPayload or import if defined globally
interface UserPayload { id: string; email: string; role: string; }

// --- Mock Definitions ---
// Mock TypeORM Repository methods used by TasksService
const mockTasksRepository = {
  findAndCount: jest.fn(),
  findOne: jest.fn(),
  find: jest.fn(), // Added as it might be used internally or by findByStatus
  create: jest.fn(),
  save: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  count: jest.fn(),
  merge: jest.fn(),
  remove: jest.fn(),
  // Mock the query builder chain used in getStats
  createQueryBuilder: jest.fn(() => ({ // Use function to return object
    where: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    setParameters: jest.fn().mockReturnThis(),
    getRawOne: jest.fn(),
  })),
};

// Mock BullMQ Queue methods used
const mockTaskQueue = {
  add: jest.fn(),
  addBulk: jest.fn(),
};

// Mock DataSource transaction method
const mockDataSource = {
  // Mock the transaction method to immediately execute the callback
  // and provide a mock transactionalEntityManager
  transaction: jest.fn().mockImplementation(async (callback) => {
     // Basic mock manager that routes calls back to the main mock repo
     // More sophisticated mocking might be needed for complex TX tests
     const mockTransactionalEntityManager = {
         create: mockTasksRepository.create,
         save: mockTasksRepository.save,
         findOne: mockTasksRepository.findOne,
         merge: mockTasksRepository.merge,
         // Add other manager methods if needed
     };
     return callback(mockTransactionalEntityManager);
  }),
};


// Mock Cache Manager methods used
const mockCacheManager = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
};

// Mock ConfigService methods used
const mockConfigService = {
  get: jest.fn(),
};
// -----------------------


// --- Test Suite ---
describe('TasksService', () => {
  let service: TasksService;
  let repository: Repository<Task>; // Type helps with mock typing
  let queue: Queue;
  let cacheManager: Cache;
  let dataSource: DataSource;
  let configService: ConfigService;

  // Set up the testing module before each test
  beforeEach(async () => {
    // Reset mocks before each test
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TasksService,
        { provide: getRepositoryToken(Task), useValue: mockTasksRepository },
        { provide: getQueueToken('task-processing'), useValue: mockTaskQueue },
        { provide: DataSource, useValue: mockDataSource },
        { provide: CACHE_MANAGER, useValue: mockCacheManager },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    // Get instances of the service and mocks from the testing module
    service = module.get<TasksService>(TasksService);
    repository = module.get<Repository<Task>>(getRepositoryToken(Task));
    queue = module.get<Queue>(getQueueToken('task-processing'));
    cacheManager = module.get<Cache>(CACHE_MANAGER);
    dataSource = module.get<DataSource>(DataSource);
    configService = module.get<ConfigService>(ConfigService);

    // Default mock for configService.get('CACHE_TTL')
    mockConfigService.get.mockImplementation((key: string, defaultValue?: any) => {
        if (key === 'CACHE_TTL') {
            return 300; // Default TTL for tests
        }
        return defaultValue;
    });
  });

  // Test suite for the service itself
  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // --- Test Suites for each method will go here ---

  describe('findOne', () => {
    const taskId = 'task-uuid-123';
    const ownerUser: UserPayload = { id: 'user-uuid-456', email: 'owner@test.com', role: 'user' };
    const otherUser: UserPayload = { id: 'user-uuid-789', email: 'other@test.com', role: 'user' };
    const adminUser: UserPayload = { id: 'admin-uuid-111', email: 'admin@test.com', role: 'admin' };
    const mockTask: Task = {
      id: taskId,
      title: 'Test Task',
      description: '',
      status: TaskStatus.PENDING,
      priority: TaskPriority.MEDIUM,
      dueDate: null,
      userId: ownerUser.id, // Task owned by ownerUser
      user: ownerUser as any, // Mock relation - cast needed if full User type differs
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const cacheKey = `task:${taskId}`;

    it('should return task from DB if cache miss and user is owner', async () => {
      // Arrange
      mockCacheManager.get.mockResolvedValue(null); // Cache miss
      mockTasksRepository.findOne.mockResolvedValue(mockTask); // DB hit
      mockConfigService.get.mockReturnValue(300); // Mock TTL lookup

      // Act
      const result = await service.findOne(taskId, ownerUser);

      // Assert
      expect(mockCacheManager.get).toHaveBeenCalledWith(cacheKey);
      expect(mockTasksRepository.findOne).toHaveBeenCalledWith({ where: { id: taskId }, relations: { user: true } });
      expect(mockCacheManager.set).toHaveBeenCalledWith(cacheKey, mockTask, 300 * 1000); // TTL in ms
      expect(result).toEqual(mockTask);
    });

    it('should return task from cache if cache hit and user is owner', async () => {
      // Arrange
      const cachedTask = { ...mockTask }; // Simulate plain object from cache
      mockCacheManager.get.mockResolvedValue(cachedTask); // Cache hit

      // Act
      const result = await service.findOne(taskId, ownerUser);

      // Assert
      expect(mockCacheManager.get).toHaveBeenCalledWith(cacheKey);
      expect(mockTasksRepository.findOne).not.toHaveBeenCalled(); // DB not called
      expect(mockCacheManager.set).not.toHaveBeenCalled(); // Cache not set again
      expect(result).toEqual(cachedTask);
    });

     it('should throw ForbiddenException if user is not owner (cache hit)', async () => {
       // Arrange
       const cachedTask = { ...mockTask }; // Task owned by ownerUser
       mockCacheManager.get.mockResolvedValue(cachedTask); // Cache hit

       // Act & Assert
       await expect(service.findOne(taskId, otherUser)).rejects.toThrow(ForbiddenException); // otherUser tries to access ownerUser's task
       expect(mockCacheManager.get).toHaveBeenCalledWith(cacheKey);
       expect(mockTasksRepository.findOne).not.toHaveBeenCalled();
     });

     it('should throw ForbiddenException if user is not owner (cache miss)', async () => {
       // Arrange
       mockCacheManager.get.mockResolvedValue(null); // Cache miss
       mockTasksRepository.findOne.mockResolvedValue(mockTask); // DB returns task owned by ownerUser

       // Act & Assert
       await expect(service.findOne(taskId, otherUser)).rejects.toThrow(ForbiddenException); // otherUser tries to access
       expect(mockCacheManager.get).toHaveBeenCalledWith(cacheKey);
       expect(mockTasksRepository.findOne).toHaveBeenCalledWith({ where: { id: taskId }, relations: { user: true } });
       expect(mockCacheManager.set).not.toHaveBeenCalled(); // Cache not set because of error
     });

     it('should return task if user is admin (cache miss)', async () => {
        // Arrange
        mockCacheManager.get.mockResolvedValue(null);
        mockTasksRepository.findOne.mockResolvedValue(mockTask); // Task owned by ownerUser
        mockConfigService.get.mockReturnValue(300);

        // Act
        const result = await service.findOne(taskId, adminUser); // Admin accesses ownerUser's task

        // Assert
        expect(mockCacheManager.get).toHaveBeenCalledWith(cacheKey);
        expect(mockTasksRepository.findOne).toHaveBeenCalledWith({ where: { id: taskId }, relations: { user: true } });
        expect(mockCacheManager.set).toHaveBeenCalledWith(cacheKey, mockTask, 300 * 1000);
        expect(result).toEqual(mockTask);
     });

      it('should return task if user is admin (cache hit)', async () => {
        // Arrange
        const cachedTask = { ...mockTask }; // Task owned by ownerUser
        mockCacheManager.get.mockResolvedValue(cachedTask); // Cache hit

        // Act
        const result = await service.findOne(taskId, adminUser); // Admin accesses ownerUser's task

        // Assert
        expect(mockCacheManager.get).toHaveBeenCalledWith(cacheKey);
        expect(mockTasksRepository.findOne).not.toHaveBeenCalled();
        expect(result).toEqual(cachedTask); // Admin gets the cached task
      });


     it('should throw NotFoundException if task not found in DB (cache miss)', async () => {
       // Arrange
       mockCacheManager.get.mockResolvedValue(null); // Cache miss
       mockTasksRepository.findOne.mockResolvedValue(null); // DB miss

       // Act & Assert
       await expect(service.findOne(taskId, ownerUser)).rejects.toThrow(NotFoundException);
       expect(mockCacheManager.get).toHaveBeenCalledWith(cacheKey);
       expect(mockTasksRepository.findOne).toHaveBeenCalledWith({ where: { id: taskId }, relations: { user: true } });
       expect(mockCacheManager.set).not.toHaveBeenCalled();
     });

  });

  describe('findAllPaginated', () => {
    // Mock users
    const regularUser: UserPayload = { id: 'user-uuid-regular', email: 'user@test.com', role: 'user' };
    const adminUser: UserPayload = { id: 'user-uuid-admin', email: 'admin@test.com', role: 'admin' };

    // Mock tasks (ensure they have necessary fields including userId)
    const mockTask1: Task = { id: 'task-1', title: 'Task 1', status: TaskStatus.PENDING, priority: TaskPriority.MEDIUM, userId: regularUser.id, createdAt: new Date('2023-01-01'), updatedAt: new Date(), description: '', dueDate: null, user: regularUser as any };
    const mockTask2: Task = { id: 'task-2', title: 'Task 2', status: TaskStatus.COMPLETED, priority: TaskPriority.HIGH, userId: regularUser.id, createdAt: new Date('2023-01-02'), updatedAt: new Date(), description: '', dueDate: null, user: regularUser as any };
    const mockTask3: Task = { id: 'task-3', title: 'Task 3 Admin', status: TaskStatus.PENDING, priority: TaskPriority.LOW, userId: adminUser.id, createdAt: new Date('2023-01-03'), updatedAt: new Date(), description: '', dueDate: null, user: adminUser as any };

    const mockTasks = [mockTask1, mockTask2];
    const mockAllTasks = [mockTask1, mockTask2, mockTask3];

    it('should return paginated tasks for a regular user with default options', async () => {
      // Arrange
      const queryDto: QueryTaskDto = { page: 1, limit: 10 }; // Use defaults
      const expectedTotal = mockTasks.length; // Regular user only sees their tasks
      mockTasksRepository.findAndCount.mockResolvedValue([mockTasks, expectedTotal]); // Mock DB response

      // Expected options passed to findAndCount
      const expectedFindOptions = {
        where: { user: { id: regularUser.id } }, // Filter by user
        relations: { user: true },
        take: 10,
        skip: 0,
        order: { createdAt: 'DESC' },
      };
      const expectedMeta = { total: expectedTotal, page: 1, limit: 10, totalPages: 1 };

      // Act
      const result = await service.findAllPaginated(queryDto, regularUser);

      // Assert
      expect(mockTasksRepository.findAndCount).toHaveBeenCalledWith(expectedFindOptions);
      expect(result.data).toEqual(mockTasks);
      expect(result.meta).toEqual(expectedMeta);
    });

    it('should return paginated tasks for an admin user with default options', async () => {
      // Arrange
      const queryDto: QueryTaskDto = { page: 1, limit: 10 };
      const expectedTotal = mockAllTasks.length; // Admin sees all tasks
      mockTasksRepository.findAndCount.mockResolvedValue([mockAllTasks, expectedTotal]);

      const expectedFindOptions = {
        where: {}, // No user filter for admin
        relations: { user: true },
        take: 10,
        skip: 0,
        order: { createdAt: 'DESC' },
      };
      const expectedMeta = { total: expectedTotal, page: 1, limit: 10, totalPages: 1 };

      // Act
      const result = await service.findAllPaginated(queryDto, adminUser);

      // Assert
      expect(mockTasksRepository.findAndCount).toHaveBeenCalledWith(expectedFindOptions);
      expect(result.data).toEqual(mockAllTasks);
      expect(result.meta).toEqual(expectedMeta);
    });

    it('should apply status filter for a regular user', async () => {
      // Arrange
      const queryDto: QueryTaskDto = { page: 1, limit: 10, status: TaskStatus.PENDING };
      const filteredTasks = [mockTask1]; // Only pending task for regularUser
      const expectedTotal = filteredTasks.length;
      mockTasksRepository.findAndCount.mockResolvedValue([filteredTasks, expectedTotal]);

      const expectedFindOptions = {
        where: { user: { id: regularUser.id }, status: TaskStatus.PENDING }, // User and status filter
        relations: { user: true },
        take: 10,
        skip: 0,
        order: { createdAt: 'DESC' },
      };
      const expectedMeta = { total: expectedTotal, page: 1, limit: 10, totalPages: 1 };

      // Act
      const result = await service.findAllPaginated(queryDto, regularUser);

      // Assert
      expect(mockTasksRepository.findAndCount).toHaveBeenCalledWith(expectedFindOptions);
      expect(result.data).toEqual(filteredTasks);
      expect(result.meta).toEqual(expectedMeta);
    });

     it('should apply priority filter for an admin user', async () => {
       // Arrange
       const queryDto: QueryTaskDto = { page: 1, limit: 10, priority: TaskPriority.HIGH };
       const filteredTasks = [mockTask2]; // Only high priority task overall
       const expectedTotal = filteredTasks.length;
       mockTasksRepository.findAndCount.mockResolvedValue([filteredTasks, expectedTotal]);

       const expectedFindOptions = {
         where: { priority: TaskPriority.HIGH }, // Only priority filter for admin
         relations: { user: true },
         take: 10,
         skip: 0,
         order: { createdAt: 'DESC' },
       };
       const expectedMeta = { total: expectedTotal, page: 1, limit: 10, totalPages: 1 };

       // Act
       const result = await service.findAllPaginated(queryDto, adminUser);

       // Assert
       expect(mockTasksRepository.findAndCount).toHaveBeenCalledWith(expectedFindOptions);
       expect(result.data).toEqual(filteredTasks);
       expect(result.meta).toEqual(expectedMeta);
     });

     it('should handle pagination correctly (page 2)', async () => {
       // Arrange
       const queryDto: QueryTaskDto = { page: 2, limit: 1 }; // Page 2, 1 item per page
       // Assume DB has 2 tasks for this user, findAndCount returns the 2nd task and total of 2
       const tasksOnPage2 = [mockTask2];
       const expectedTotal = mockTasks.length; // Total tasks for regularUser
       mockTasksRepository.findAndCount.mockResolvedValue([tasksOnPage2, expectedTotal]);

       const expectedFindOptions = {
         where: { user: { id: regularUser.id } },
         relations: { user: true },
         take: 1, // limit = 1
         skip: 1, // skip = (page - 1) * limit = (2 - 1) * 1 = 1
         order: { createdAt: 'DESC' },
       };
       // Total pages = ceil(totalItems / limit) = ceil(2 / 1) = 2
       const expectedMeta = { total: expectedTotal, page: 2, limit: 1, totalPages: 2 };

       // Act
       const result = await service.findAllPaginated(queryDto, regularUser);

       // Assert
       expect(mockTasksRepository.findAndCount).toHaveBeenCalledWith(expectedFindOptions);
       expect(result.data).toEqual(tasksOnPage2);
       expect(result.meta).toEqual(expectedMeta);
     });

     it('should return empty data array and correct meta if no tasks match', async () => {
        // Arrange
        const queryDto: QueryTaskDto = { page: 1, limit: 10, status: TaskStatus.IN_PROGRESS }; // No IN_PROGRESS tasks for regularUser
        const expectedTotal = 0;
        mockTasksRepository.findAndCount.mockResolvedValue([[], expectedTotal]); // DB returns empty array, count 0

        const expectedFindOptions = {
          where: { user: { id: regularUser.id }, status: TaskStatus.IN_PROGRESS },
          relations: { user: true },
          take: 10,
          skip: 0,
          order: { createdAt: 'DESC' },
        };
        const expectedMeta = { total: 0, page: 1, limit: 10, totalPages: 0 };

        // Act
        const result = await service.findAllPaginated(queryDto, regularUser);

        // Assert
        expect(mockTasksRepository.findAndCount).toHaveBeenCalledWith(expectedFindOptions);
        expect(result.data).toEqual([]);
        expect(result.meta).toEqual(expectedMeta);
     });


     describe('create', () => {
        const userPayload: UserPayload = { id: 'user-uuid-creator', email: 'creator@test.com', role: 'user' };
        const createTaskDto: CreateTaskDto = {
          title: 'New Test Task',
          description: 'Description for test',
          priority: TaskPriority.LOW,
          // status and dueDate might be optional with defaults
        };
    
        // Mock what the repository.create returns (doesn't have ID/timestamps yet)
        const mockCreatedTaskPartial = {
            ...createTaskDto,
            user: { id: userPayload.id },
            status: TaskStatus.PENDING, // Assume default or from DTO
            priority: createTaskDto.priority || TaskPriority.MEDIUM, // Assume default or from DTO
        };
    
        // Mock what repository.save returns (has ID/timestamps)
        const mockSavedTask = {
            ...mockCreatedTaskPartial,
            id: 'new-task-uuid-123',
            createdAt: new Date(),
            updatedAt: new Date(),
        };
    
         // Mock what the final findOne returns (includes full user relation if needed)
         const mockFinalTaskResult = {
             ...mockSavedTask,
             user: { id: userPayload.id, email: userPayload.email, name: 'Test Creator', role: userPayload.role } as User // Cast for typing
         };
    
    
         it('should create a task, save it, add to queue within a transaction, and return the saved task', async () => {
            // Arrange
            const mockTransactionalEntityManager = {
              create: jest.fn().mockReturnValue(mockCreatedTaskPartial),
              save: jest.fn().mockResolvedValue(mockSavedTask), // save returns the saved task
            };
            // Mock the transaction - return result of callback
            (dataSource.transaction as jest.Mock).mockImplementationOnce(async (callback) => {
               return callback(mockTransactionalEntityManager); // Executes callback and returns its result
            });
            // Mock queue add
            mockTaskQueue.add.mockResolvedValue({ id: 'job-123' });
            // NO mock needed for the final tasksRepository.findOne
  
            // Act
            const result = await service.create(createTaskDto, userPayload);
  
            // Assert
            expect(mockDataSource.transaction).toHaveBeenCalledTimes(1);
            expect(mockTransactionalEntityManager.create).toHaveBeenCalledWith(Task, expect.any(Object));
            expect(mockTransactionalEntityManager.save).toHaveBeenCalledWith(Task, mockCreatedTaskPartial);
            expect(mockTaskQueue.add).toHaveBeenCalledWith('task-status-update', expect.any(Object));
            // Verify the findOne call using the main repository mock is NOT called
            expect(mockTasksRepository.findOne).not.toHaveBeenCalled();
            // Verify the final result IS the saved task from the transaction
            expect(result).toEqual(mockSavedTask); // <-- Check against mockSavedTask
          });
    
        it('should throw error and rollback transaction if queue add fails', async () => {
           // Arrange
           const queueError = new Error('Redis connection failed');
           const mockTransactionalEntityManager = {
             create: jest.fn().mockReturnValue(mockCreatedTaskPartial),
             save: jest.fn().mockResolvedValue(mockSavedTask),
           };
            (dataSource.transaction as jest.Mock).mockImplementationOnce(async (callback) => {
                // Need to simulate the TX manager behaviour of rolling back on error
                try {
                    await callback(mockTransactionalEntityManager);
                } catch (error) {
                    // Simulate rollback would happen here
                    throw error; // Re-throw the error caught by the TX manager
                }
            });
    
           // Mock queue add to reject
           mockTaskQueue.add.mockRejectedValue(queueError);
    
           // Act & Assert
           // Expect the service call to throw the wrapped error from the catch block
           await expect(service.create(createTaskDto, userPayload))
           .rejects.toThrow('Redis connection failed');
    
           // Verify transaction, create, save were called, but final findOne was not
           expect(mockDataSource.transaction).toHaveBeenCalledTimes(1);
           expect(mockTransactionalEntityManager.create).toHaveBeenCalled();
           expect(mockTransactionalEntityManager.save).toHaveBeenCalled();
           expect(mockTaskQueue.add).toHaveBeenCalled(); // Queue add was attempted
           expect(mockTasksRepository.findOne).not.toHaveBeenCalled(); // Final fetch shouldn't happen
    
         });
    
         it('should throw error and rollback transaction if db save fails', async () => {
           // Arrange
           const dbError = new Error('Database constraint violation');
           const mockTransactionalEntityManager = {
             create: jest.fn().mockReturnValue(mockCreatedTaskPartial),
             save: jest.fn().mockRejectedValue(dbError), // Simulate save failing
           };
            (dataSource.transaction as jest.Mock).mockImplementationOnce(async (callback) => {
                try {
                    await callback(mockTransactionalEntityManager);
                } catch (error) {
                    throw error;
                }
            });
    
    
           // Act & Assert
           // Expect the service call to reject with the original DB error
           await expect(service.create(createTaskDto, userPayload))
             .rejects.toThrow(dbError);
    
           // Verify transaction, create, save attempted, queue/final findOne not called
           expect(mockDataSource.transaction).toHaveBeenCalledTimes(1);
           expect(mockTransactionalEntityManager.create).toHaveBeenCalled();
           expect(mockTransactionalEntityManager.save).toHaveBeenCalled();
           expect(mockTaskQueue.add).not.toHaveBeenCalled();
           expect(mockTasksRepository.findOne).not.toHaveBeenCalled();
         });
    
      });
        

  });

  describe('update', () => {
    // --- Mock Data ---
    const taskId = 'task-uuid-for-update';
    const ownerUser: UserPayload = { id: 'user-uuid-owner', email: 'owner@test.com', role: 'user' };
    const adminUser: UserPayload = { id: 'user-uuid-admin', email: 'admin@test.com', role: 'admin' };
    const otherUser: UserPayload = { id: 'user-uuid-other', email: 'other@test.com', role: 'user' };

    const updateDtoWithStatusChange: UpdateTaskDto = { title: 'Updated Title', status: TaskStatus.IN_PROGRESS };
    const updateDtoWithoutStatusChange: UpdateTaskDto = { description: 'Updated description' };

    // Represents the task fetched initially AND inside TX
    const existingTask: Task = {
        id: taskId, title: 'Original Title', description: '', status: TaskStatus.PENDING,
        priority: TaskPriority.MEDIUM, dueDate: null, userId: ownerUser.id,
        user: ownerUser as any, createdAt: new Date('2024-01-01T10:00:00Z'),
        updatedAt: new Date('2024-01-01T10:00:00Z'),
    };

    // Represents the state returned by entityManager.save inside the transaction
    const savedTaskState = {
        ...existingTask,
        ...updateDtoWithStatusChange, // Apply changes from DTO
        updatedAt: new Date('2024-01-01T11:00:00Z'), // Simulate updated timestamp
    };

     // Represents the final result after the re-fetch (includes relations)
     const finalTaskResult = {
         ...savedTaskState,
         user: ownerUser as any, // Ensure relation is present
     };

    const cacheKey = `task:${taskId}`;

    // --- Mock References ---
    // Note: We don't need to spy on service.findOne anymore because the version
    // of update being tested doesn't call it internally.
    let transactionMock: jest.Mock;
    let cacheDelMock: jest.Mock;
    let queueAddMock: jest.Mock;
    let repoFindOneMock: jest.Mock; // Mock for the final repository findOne

    // --- CORRECTED Mock Transactional Entity Manager ---
    // It MUST have all methods called within the transaction block
    const mockTransactionalEntityManager = {
        findOne: jest.fn(), // <-- ADDED THIS MOCK
        merge: jest.fn(),
        save: jest.fn(),
    };
    // -------------------------------------------------

    beforeEach(() => {
        // Reset mocks before each test
        jest.clearAllMocks();

        // Reset mock references
        transactionMock = dataSource.transaction as jest.Mock;
        cacheDelMock = cacheManager.del as jest.Mock;
        queueAddMock = queue.add as jest.Mock;
        repoFindOneMock = mockTasksRepository.findOne;

        // Default transaction mock implementation
        transactionMock.mockImplementation(async (callback) => callback(mockTransactionalEntityManager));
    });

    // No afterEach needed for spy cleanup anymore


    it('should successfully update task for owner, add job, invalidate cache, and return final task', async () => {
      // Arrange
      // Mock the findOne call *inside* the transaction
      mockTransactionalEntityManager.findOne.mockResolvedValueOnce(existingTask);
      mockTransactionalEntityManager.save.mockResolvedValueOnce(savedTaskState); // Save inside TX succeeds
      queueAddMock.mockResolvedValueOnce({ id: 'job-update-123' }); // Queue add succeeds
      cacheDelMock.mockResolvedValueOnce(undefined); // Cache del succeeds
      repoFindOneMock.mockResolvedValueOnce(finalTaskResult); // Final repo findOne succeeds

      // Act
      const result = await service.update(taskId, updateDtoWithStatusChange, ownerUser);

      // Assert
      expect(transactionMock).toHaveBeenCalledTimes(1); // Transaction used
      expect(mockTransactionalEntityManager.findOne).toHaveBeenCalledWith(Task, { where: { id: taskId }, relations: { user: true } }); // Check findOne inside TX
      expect(mockTransactionalEntityManager.merge).toHaveBeenCalledWith(Task, existingTask, updateDtoWithStatusChange); // Check merge called
      expect(mockTransactionalEntityManager.save).toHaveBeenCalledWith(Task, existingTask); // Check save called
      expect(queueAddMock).toHaveBeenCalledWith('task-status-update', { taskId: savedTaskState.id, status: savedTaskState.status }); // Check queue add
      expect(cacheDelMock).toHaveBeenCalledWith(cacheKey); // Check cache invalidated
      expect(repoFindOneMock).toHaveBeenCalledWith({ where: { id: savedTaskState.id }, relations: { user: true } }); // Check final fetch called
      expect(result).toEqual(finalTaskResult); // Check final result returned
    });

    it('should update task as admin (no status change), invalidate cache, skip queue', async () => {
      // Arrange
      const taskOwnedByOther = { ...existingTask, id: 'other-task-id', userId: otherUser.id, user: otherUser as any };
      const savedAdminUpdateState = { ...taskOwnedByOther, ...updateDtoWithoutStatusChange };
      const finalAdminResult = { ...savedAdminUpdateState, user: otherUser as any };

      mockTransactionalEntityManager.findOne.mockResolvedValueOnce(taskOwnedByOther); // findOne inside TX succeeds for admin
      mockTransactionalEntityManager.save.mockResolvedValueOnce(savedAdminUpdateState);
      cacheDelMock.mockResolvedValueOnce(undefined);
      repoFindOneMock.mockResolvedValueOnce(finalAdminResult);

      // Act
      const result = await service.update('other-task-id', updateDtoWithoutStatusChange, adminUser);

      // Assert
      expect(transactionMock).toHaveBeenCalledTimes(1);
      expect(mockTransactionalEntityManager.findOne).toHaveBeenCalledWith(Task, { where: { id: 'other-task-id' }, relations: { user: true } });
      expect(mockTransactionalEntityManager.merge).toHaveBeenCalledWith(Task, taskOwnedByOther, updateDtoWithoutStatusChange);
      expect(mockTransactionalEntityManager.save).toHaveBeenCalledWith(Task, taskOwnedByOther);
      expect(queueAddMock).not.toHaveBeenCalled(); // Queue NOT called
      expect(cacheDelMock).toHaveBeenCalledWith(`task:other-task-id`);
      expect(repoFindOneMock).toHaveBeenCalledWith({ where: { id: savedAdminUpdateState.id }, relations: { user: true } });
      expect(result).toEqual(finalAdminResult);
    });


    it('should throw ForbiddenException if non-owner tries to update', async () => {
       // Arrange
       // Mock findOne *inside the transaction* to return the task owned by someone else
       mockTransactionalEntityManager.findOne.mockResolvedValueOnce(existingTask); // Task owned by ownerUser

       // Act & Assert
       // The ForbiddenException should be thrown from *within* the transaction callback
       await expect(service.update(taskId, updateDtoWithStatusChange, otherUser)) // otherUser tries update
           .rejects.toThrow(ForbiddenException);

       expect(transactionMock).toHaveBeenCalledTimes(1); // Transaction was called
       expect(mockTransactionalEntityManager.findOne).toHaveBeenCalledTimes(1); // findOne inside TX was called
       expect(mockTransactionalEntityManager.merge).not.toHaveBeenCalled(); // Merge/Save not called
       expect(mockTransactionalEntityManager.save).not.toHaveBeenCalled();
       expect(queueAddMock).not.toHaveBeenCalled();
       expect(cacheDelMock).not.toHaveBeenCalled(); // Cache not invalidated on failure
       expect(repoFindOneMock).not.toHaveBeenCalled(); // Final findOne not called
    });

     it('should throw NotFoundException if task does not exist', async () => {
       // Arrange
       // Mock findOne *inside the transaction* to return null
       mockTransactionalEntityManager.findOne.mockResolvedValueOnce(null);

       // Act & Assert
       await expect(service.update(taskId, updateDtoWithStatusChange, ownerUser))
           .rejects.toThrow(NotFoundException);

       expect(transactionMock).toHaveBeenCalledTimes(1);
       expect(mockTransactionalEntityManager.findOne).toHaveBeenCalledTimes(1);
       expect(mockTransactionalEntityManager.merge).not.toHaveBeenCalled();
       expect(mockTransactionalEntityManager.save).not.toHaveBeenCalled();
       expect(queueAddMock).not.toHaveBeenCalled();
       expect(cacheDelMock).not.toHaveBeenCalled();
       expect(repoFindOneMock).not.toHaveBeenCalled();
     });

     it('should rollback transaction and throw if queue add fails', async () => {
        // Arrange
        const queueError = new Error("Queue unavailable");
        mockTransactionalEntityManager.findOne.mockResolvedValueOnce(existingTask); // findOne inside TX succeeds
        mockTransactionalEntityManager.save.mockResolvedValueOnce(savedTaskState); // Save inside TX succeeds
        queueAddMock.mockRejectedValueOnce(queueError); // Queue add fails

        // Act & Assert
        await expect(service.update(taskId, updateDtoWithStatusChange, ownerUser))
            .rejects.toThrow(`Failed to queue task update for ${savedTaskState.id}.`); // Expect wrapped error

        expect(transactionMock).toHaveBeenCalledTimes(1);
        expect(mockTransactionalEntityManager.findOne).toHaveBeenCalledTimes(1);
        expect(mockTransactionalEntityManager.save).toHaveBeenCalledTimes(1);
        expect(queueAddMock).toHaveBeenCalledTimes(1); // Queue add was attempted
        expect(cacheDelMock).not.toHaveBeenCalled(); // Cache should NOT be invalidated
        expect(repoFindOneMock).not.toHaveBeenCalled(); // Final findOne should NOT be called
     });

     it('should rollback transaction and throw if db save fails', async () => {
        // Arrange
        const dbError = new Error("DB Save Failed");
        mockTransactionalEntityManager.findOne.mockResolvedValueOnce(existingTask); // findOne inside TX succeeds
        mockTransactionalEntityManager.save.mockRejectedValueOnce(dbError); // Save inside TX fails

        // Act & Assert
        await expect(service.update(taskId, updateDtoWithStatusChange, ownerUser))
            .rejects.toThrow(dbError); // Expect original DB error

        expect(transactionMock).toHaveBeenCalledTimes(1);
        expect(mockTransactionalEntityManager.findOne).toHaveBeenCalledTimes(1);
        expect(mockTransactionalEntityManager.save).toHaveBeenCalledTimes(1); // Save was attempted
        expect(queueAddMock).not.toHaveBeenCalled(); // Queue add NOT attempted
        expect(cacheDelMock).not.toHaveBeenCalled();
        expect(repoFindOneMock).not.toHaveBeenCalled();
     });

    it('should complete update and invalidate cache even if cache deletion fails', async () => {
       // Arrange
       mockTransactionalEntityManager.findOne.mockResolvedValueOnce(existingTask);
       mockTransactionalEntityManager.save.mockResolvedValueOnce(savedTaskState);
       queueAddMock.mockResolvedValueOnce({ id: 'job-abc' });
       cacheDelMock.mockRejectedValueOnce(new Error("Cache DEL failed")); // Cache invalidation fails
       repoFindOneMock.mockResolvedValueOnce(finalTaskResult); // Final findOne still succeeds

       // Act
       const result = await service.update(taskId, updateDtoWithStatusChange, ownerUser);

       // Assert
       expect(result).toEqual(finalTaskResult); // Update still returns successfully
       expect(transactionMock).toHaveBeenCalledTimes(1);
       expect(mockTransactionalEntityManager.findOne).toHaveBeenCalledTimes(1);
       expect(mockTransactionalEntityManager.save).toHaveBeenCalledTimes(1);
       expect(queueAddMock).toHaveBeenCalledTimes(1);
       expect(cacheDelMock).toHaveBeenCalledWith(cacheKey); // Invalidation was attempted
       expect(repoFindOneMock).toHaveBeenCalledTimes(1); // Final fetch was called
       // We expect logger.error for cache failure
    });

});
  // --- Add describe blocks for other methods (create, findAllPaginated, update, remove, getStats, etc.) ---


});