// src/modules/auth/auth.module.ts
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy'; // Access token strategy
import { JwtRefreshStrategy } from './strategies/jwt-refresh.strategy'; // <-- Import Refresh Strategy
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    UsersModule,
    PassportModule.register({ defaultStrategy: 'jwt' }), // Default is still JWT (access token)
    JwtModule.registerAsync({ // This configures JwtService primarily for ACCESS tokens
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        // Use ACCESS token secret and expiry by default for jwtService.sign()
        secret: configService.get<string>('jwt.accessSecret'),
        signOptions: {
          expiresIn: configService.get<string>('jwt.accessExpiresIn'),
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy, // Provide Access Token Strategy
    JwtRefreshStrategy, // <-- Provide Refresh Token Strategy
    // Guards are typically not listed here unless they have complex dependencies
  ],
  exports: [AuthService], // Export AuthService if other modules need it
})
export class AuthModule {}
