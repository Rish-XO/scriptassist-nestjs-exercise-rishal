// src/modules/auth/auth.controller.ts
import {
  Body, Controller, Post, UseGuards, Req, HttpCode, HttpStatus, UnauthorizedException // Added HttpCode, HttpStatus, UnauthorizedException
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard'; // Standard access token guard
import { JwtRefreshGuard } from './guards/jwt-refresh.guard'; // <-- Import Refresh Guard
import { Request } from 'express';
// Remove RefreshTokenDto import if passing token via header
// import { RefreshTokenDto } from './dto/refresh-token.dto';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger'; // For Swagger

// Define UserPayload for access token (adjust as needed)
interface AccessTokenPayload { id: string; email: string; role: string; }
interface UserInRequest extends Request { user?: AccessTokenPayload }

// Define UserPayload for refresh token (adjust as needed based on JwtRefreshStrategy.validate return)
interface RefreshTokenPayload { id: string; refreshToken: string; }
interface RefreshRequest extends Request { user?: RefreshTokenPayload }

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
      private readonly authService: AuthService,
      // Remove JwtService injection if not needed for decoding here anymore
      // private readonly jwtService: JwtService
  ) {}

  @Post('login')
  @HttpCode(HttpStatus.OK) // Use 200 OK for login
  @ApiOperation({ summary: 'Log in a user' })
  async login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
  }

  @Post('register')
  @ApiOperation({ summary: 'Register a new user' })
  // Implicitly 201 Created
  async register(@Body() registerDto: RegisterDto) {
    return this.authService.register(registerDto);
  }

  // --- LOGOUT Endpoint ---
  @Post('logout')
  @UseGuards(JwtAuthGuard) // Requires a valid ACCESS token to identify the user
  @HttpCode(HttpStatus.OK) // Return 200 OK
  @ApiOperation({ summary: 'Log out the current user' })
  @ApiBearerAuth() // Indicate access token needed
  async logout(@Req() req: UserInRequest): Promise<{ message: string }> {
    const userId = req.user?.id;
    if (!userId) {
       // Should not happen if JwtAuthGuard works
       throw new UnauthorizedException('User ID not found in token payload');
    }
    await this.authService.logout(userId);
    return { message: 'Logged out successfully' };
  }
  // -----------------------

  // --- REFRESH Endpoint ---
  @Post('refresh')
  @UseGuards(JwtRefreshGuard) // <-- Use the new Refresh Guard
  @HttpCode(HttpStatus.OK) // Return 200 OK
  @ApiOperation({ summary: 'Refresh access and refresh tokens' })
  @ApiBearerAuth() // Indicate REFRESH token needed as Bearer
  async refreshTokens(@Req() req: RefreshRequest) {
    // JwtRefreshGuard uses JwtRefreshStrategy.validate
    // which attaches { id: userId, refreshToken: tokenString } to req.user
    const userId = req.user?.id;
    const refreshToken = req.user?.refreshToken;

    if (!userId || !refreshToken) {
        // Should not happen if JwtRefreshGuard works
        throw new UnauthorizedException('User ID or Refresh Token not found in request');
    }

    // Pass validated userId and token string to the service
    return this.authService.refreshTokens(userId, refreshToken);
  }
  // ------------------------
}
