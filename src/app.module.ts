// src/app.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { CacheModule } from '@nestjs/cache-manager'; // <-- Import CacheModule
import { redisStore } from 'cache-manager-ioredis-yet';

// Your application modules
import { UsersModule } from './modules/users/users.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { AuthModule } from './modules/auth/auth.module';
import { TaskProcessorModule } from './queues/task-processor/task-processor.module';
import { ScheduledTasksModule } from './queues/scheduled-tasks/scheduled-tasks.module';

// Your configurations
import jwtConfig from '@config/jwt.config'; // Assuming path is correct, maybe './config/jwt.config'

// --- Remove the import for the old CacheService ---
// import { CacheService } from './common/services/cache.service';
// ----------------------------------------------------

@Module({
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      load: [jwtConfig],
    }),

    // --- Add CacheModule Configuration ---
    CacheModule.registerAsync({
      isGlobal: true, // Make cache manager available globally via injection
      imports: [ConfigModule], // Import ConfigModule to use ConfigService
      inject: [ConfigService], // Inject ConfigService
      useFactory: async (configService: ConfigService) => {
        // Configure Redis store using environment variables
        const store = await redisStore({
          host: configService.get<string>('REDIS_HOST', 'localhost'), // Get Redis host
          port: configService.get<number>('REDIS_PORT', 6379),       // Get Redis port
          // password: configService.get<string>('REDIS_PASSWORD'), // Uncomment if needed
          ttl: configService.get<number>('CACHE_TTL', 60 * 5), // Default TTL 5 minutes (300 seconds) - Add CACHE_TTL to .env or use default
        });
        return {
          store: () => store, // Return the configured store
        };
      },
    }),
    // ---------------------------------------

    // Database
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get('DB_HOST'),
        port: configService.get('DB_PORT'),
        username: configService.get('DB_USERNAME'),
        password: configService.get('DB_PASSWORD'),
        database: configService.get('DB_DATABASE'),
        entities: [__dirname + '/**/*.entity{.ts,.js}'],
        synchronize: configService.get('NODE_ENV') === 'development', // Be cautious with synchronize in prod
        logging: configService.get('NODE_ENV') === 'development',
      }),
    }),

    // Scheduling
    ScheduleModule.forRoot(),

    // Queue - BullMQ setup looks fine
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        connection: {
          host: configService.get('REDIS_HOST'),
          port: configService.get('REDIS_PORT'),
          // password: configService.get<string>('REDIS_PASSWORD'), // Add if needed
        },
      }),
    }),

    // Rate limiting - Throttler setup looks fine
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      // Note: The factory should return ThrottlerModuleOptions[], not just the array directly sometimes. Check docs if issues arise.
      useFactory: (configService: ConfigService) => ([
        {
          ttl: 60000, // ttl in milliseconds (consistent with RateLimit decorator)
          limit: 100,  // Consistent with RateLimit decorator
        },
      ]),
    }),

    // Feature modules
    UsersModule,
    TasksModule,
    AuthModule,

    // Queue processing modules
    TaskProcessorModule,
    ScheduledTasksModule,
  ],
  providers: [
    // --- CacheService is REMOVED from providers ---
  ],
  exports: [
    // --- CacheService is REMOVED from exports ---
  ],
})
export class AppModule {}