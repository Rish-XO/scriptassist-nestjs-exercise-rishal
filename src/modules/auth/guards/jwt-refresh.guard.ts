// src/modules/auth/guards/jwt-refresh.guard.ts
import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtRefreshGuard extends AuthGuard('jwt-refresh') { // Use the unique strategy name
  // No need to override handleRequest unless custom error handling is needed
}
