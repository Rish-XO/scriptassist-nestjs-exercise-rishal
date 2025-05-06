// src/modules/auth/strategies/jwt-refresh.strategy.ts
import { Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, ExtractJwt } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express'; // Import Request type
import { UsersService } from '../../users/users.service'; // Import UsersService
import * as bcrypt from 'bcrypt'; // Import bcrypt

// Define payload structure expected from refresh token
interface JwtRefreshPayload {
  sub: string; // User ID
  // Refresh tokens usually don't contain email/role, just the subject
}

// Define structure of validated user object attached to request
// Include the refresh token itself for the service layer
interface ValidatedUserPayload {
  id: string; // User ID from sub
  refreshToken: string; // The validated refresh token string
}

@Injectable()
export class JwtRefreshStrategy extends PassportStrategy(Strategy, 'jwt-refresh') { // Unique strategy name 'jwt-refresh'
  constructor(
    private readonly configService: ConfigService,
    private readonly usersService: UsersService, // Inject UsersService to check stored hash
  ) {
    super({
      // Extract token from Authorization header as Bearer token
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      // DO NOT ignore expiration for refresh tokens
      ignoreExpiration: false,
      // Use the REFRESH token secret from config
      secretOrKey: configService.get<string>('jwt.refreshSecret'),
      // Pass the request object to the validate method so we can access the token
      passReqToCallback: true,
    });
  }

  /**
   * Validate the refresh token payload and compare token against stored hash.
   * @param req The incoming request object.
   * @param payload The decoded JWT payload ({ sub: userId }).
   * @returns The validated user payload to attach to the request, including the refresh token.
   */
  async validate(req: Request, payload: JwtRefreshPayload): Promise<ValidatedUserPayload> {
    const userId = payload.sub;
    // Extract the raw refresh token string from the header
    const refreshToken = req?.get('authorization')?.replace('Bearer', '').trim();

    if (!refreshToken || !userId) {
        // This should ideally be caught by Passport before validate runs if token is missing/malformed
        throw new UnauthorizedException('Invalid refresh token or payload');
    }

    const user = await this.usersService.findOne(userId); // Fetch user

    // Check user exists and has a stored refresh token hash
    if (!user || !user.hashedRefreshToken) {
        throw new ForbiddenException('Access Denied: User not found or session invalidated.');
    }

    // Compare the incoming refresh token with the stored hash
    const rtMatches = await bcrypt.compare(refreshToken, user.hashedRefreshToken);
    if (!rtMatches) {
        // If tokens don't match, deny access (don't auto-logout here, let service handle it)
        throw new ForbiddenException('Access Denied: Refresh token mismatch or revoked.');
    }

    // Token is valid and matches stored hash
    // Return an object containing essential info + the validated refresh token
    // This object will be attached to req.user by the guard
    return {
        id: userId,
        refreshToken: refreshToken, // Pass the validated token string
    };
  }
}
