import { registerAs } from '@nestjs/config';

export default registerAs('jwt', () => ({
  secret: process.env.JWT_SECRET || 'your-secret-key',
  expiresIn: process.env.JWT_EXPIRATION || '1d',

  refreshSecret: process.env.JWT_REFRESH_TOKEN_SECRET || 'default_refresh_secret',
  refreshExpiresIn: process.env.JWT_REFRESH_TOKEN_EXPIRATION || '7d', 
})); 