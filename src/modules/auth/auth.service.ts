// src/modules/auth/auth.service.ts

import {
  ConflictException,
  ForbiddenException, // Make sure this is imported
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import * as bcrypt from 'bcrypt';
import { User } from '../users/entities/user.entity';
import { ConfigService } from '@nestjs/config'; // Make sure this is imported

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService, // Configured in AuthModule for ACCESS tokens
    private readonly configService: ConfigService, // Injected to get REFRESH token config
  ) {}

  // --- Token Generation Helpers ---

  /**
   * Generates a JWT access token.
   * Uses configuration loaded via ConfigModule ('jwt.accessSecret', 'jwt.accessExpiresIn').
   */
  private generateAccessToken(user: User): string {
    const payload = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };
    // Sign using the default secret/expiry configured for JwtService in AuthModule
    // Assumes JwtModule.registerAsync in AuthModule uses 'jwt.accessSecret' and 'jwt.accessExpiresIn'
    return this.jwtService.sign(payload);
  }

  /**
   * Generates a JWT refresh token.
   * Uses specific refresh token configuration from ConfigService.
   */
  private generateRefreshToken(user: User): string {
    const payload = { sub: user.id }; // Refresh token payload often just needs user ID
    return this.jwtService.sign(payload, {
      secret: this.configService.get<string>('jwt.refreshSecret'), // Use REFRESH secret
      expiresIn: this.configService.get<string>('jwt.refreshExpiresIn'), // Use REFRESH expiry
    });
  }

  /**
   * Hashes and stores the refresh token for a user.
   */
  private async updateRefreshTokenHash(userId: string, refreshToken: string | null): Promise<void> {
      // If refreshToken is null (logout), store null. Otherwise, hash it.
      const hashedRefreshToken = refreshToken ? await bcrypt.hash(refreshToken, 10) : null;
      // Assumes usersService.updateRefreshToken correctly updates the DB field
      await this.usersService.updateRefreshToken(userId, hashedRefreshToken);
  }

  // --- Core Auth Methods ---

  /**
   * Authenticates a user, generates tokens, and stores refresh token hash.
   */
  async login(loginDto: LoginDto): Promise<{ access_token: string, refresh_token: string, user: Partial<User> }> {
    const { email, password } = loginDto;
    const user = await this.usersService.findByEmail(email);

    let passwordValid = false;
    if (user) {
      passwordValid = await bcrypt.compare(password, user.password);
    }

    if (!user || !passwordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Generate tokens
    const accessToken = this.generateAccessToken(user);
    const refreshToken = this.generateRefreshToken(user);

    // Store hashed refresh token
    await this.updateRefreshTokenHash(user.id, refreshToken);

    return {
      access_token: accessToken,
      refresh_token: refreshToken, // Return plain refresh token to client
      user: { // Return filtered user data
        id: user.id,
        email: user.email,
        role: user.role,
      },
    };
  }

  /**
   * Registers a new user. Returns user data but NO tokens (user must login separately).
   */
  async register(registerDto: RegisterDto): Promise<{ user: Partial<User> }> {
    const existingUser = await this.usersService.findByEmail(registerDto.email);
    if (existingUser) {
      throw new ConflictException('Email already exists');
    }

    // usersService.create handles hashing and saves the user
    const user = await this.usersService.create(registerDto);

    // Return filtered user data (NO token here)
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name, // Ensure name is included if available on user object
        role: user.role,
      },
    };
  }

  /**
   * Logs out a user by clearing their stored refresh token hash.
   */
  async logout(userId: string): Promise<void> {
    // Set the stored hash to null by passing null to the helper
    await this.updateRefreshTokenHash(userId, null);
  }

  /**
   * Validates a refresh token, issues new tokens (rotation), and updates stored hash.
   */
  async refreshTokens(userId: string, rt: string): Promise<{ access_token: string, refresh_token: string }> {
      const user = await this.usersService.findOne(userId); // Fetch user by ID from token payload

      // Check user exists and has a stored token hash
      if (!user || !user.hashedRefreshToken) {
          // If no hash stored, user is effectively logged out or never logged in with RT
          throw new ForbiddenException('Access Denied: No active session found or user logged out.');
      }

      // Compare the provided RT with the stored hash
      const rtMatches = await bcrypt.compare(rt, user.hashedRefreshToken);
      if (!rtMatches) {
          // SECURITY: If tokens don't match, potentially compromised - clear stored token for safety
          await this.logout(userId); // Force logout this user session/device
          throw new ForbiddenException('Access Denied: Refresh token mismatch or invalidated.');
      }

      // Token is valid - Issue a new pair (Rotation)
      const newAccessToken = this.generateAccessToken(user);
      const newRefreshToken = this.generateRefreshToken(user);

      // Update the stored hash with the *new* refresh token's hash
      await this.updateRefreshTokenHash(user.id, newRefreshToken);

      return {
          access_token: newAccessToken,
          refresh_token: newRefreshToken, // Return the new plain refresh token
      };
  }

  // --- Validation Helpers (Used by Strategies/Guards) ---

  // validateUser is likely used by JwtStrategy (Access Token)
  async validateUser(userId: string): Promise<User | null> {
     try {
        const user = await this.usersService.findOne(userId);
        // Optional: Add checks here if user is active/not banned
        // if (!user.isActive) return null;
        return user;
     } catch (error) {
        if (error instanceof NotFoundException) {
           return null; // User associated with token doesn't exist anymore
        }
        throw error; // Re-throw other errors
      }
  }

  // validateUserRoles is used by RolesGuard (checks role from validated user payload)
  async validateUserRoles(userId: string, requiredRoles: string[]): Promise<boolean> {
    if (!requiredRoles || requiredRoles.length === 0) return true;
    const user = await this.usersService.findOne(userId); // findOne throws if not found
    if (!user || !user.role) return false;
    return requiredRoles.includes(user.role);
  }

}
