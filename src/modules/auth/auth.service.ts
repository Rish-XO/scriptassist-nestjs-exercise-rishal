import {
  ConflictException,
  Injectable,
  NotFoundException, // Import NotFoundException if needed for validateUser logic refinement
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import * as bcrypt from 'bcrypt';
import { User } from '../users/entities/user.entity'; // Import the User entity type
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService, // This service uses config from AuthModule (access token secret/expiry)
    private readonly configService: ConfigService,
  ) {}

  /**
   * Generates a JWT access token with a consistent payload.
   * @param user The user object containing id, email, and role.
   * @returns The signed JWT access token string.
   */
  private generateAccessToken(user: User): string {
    const payload = {
      sub: user.id,       // User ID as the subject
      email: user.email,  // User email
      role: user.role     // User role
    };
    // Uses the secret and expiration defined in JwtModule registration within AuthModule
    return this.jwtService.sign(payload);
  }

  

  /**
   * Authenticates a user based on email and password.
   * @param loginDto DTO containing email and password.
   * @returns An object containing the access token and filtered user details.
   */
  async login(loginDto: LoginDto): Promise<{ access_token: string, user: Partial<User> }> {
    const { email, password } = loginDto;
    const user = await this.usersService.findByEmail(email);

    // Avoid user enumeration: check user existence and password validity before throwing.
    let passwordValid = false;
    if (user) {
      // Only compare password if user exists
      passwordValid = await bcrypt.compare(password, user.password);
    }

    // Throw generic error if user doesn't exist OR password doesn't match
    if (!user || !passwordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Generate the access token using the common method
    const accessToken = this.generateAccessToken(user);

    return {
      access_token: accessToken,
      user: { // Return filtered public user data
        id: user.id,
        email: user.email,
        role: user.role,
      },
    };
  }

  /**
   * Registers a new user and automatically logs them in.
   * @param registerDto DTO containing registration details.
   * @returns An object containing the access token and filtered user details.
   */
  async register(registerDto: RegisterDto): Promise<{ access_token: string, user: Partial<User> }> {
    const existingUser = await this.usersService.findByEmail(registerDto.email);

    if (existingUser) {
      // Use ConflictException for duplicate email
      throw new ConflictException('Email already exists');
    }

    // usersService.create handles hashing and returns the full user object
    const user = await this.usersService.create(registerDto);

    // Generate the access token using the common method
    const accessToken = this.generateAccessToken(user);

    return {
      access_token: accessToken, // Return token with consistent key
      user: { // Return filtered public user data
        id: user.id,
        email: user.email,
        name: user.name, // Include name as it's often useful info
        role: user.role,
      },
    };
  }

  /**
   * Validates if a user exists based on ID.
   * (Note: This method might not be directly used by the provided JwtStrategy,
   * which calls usersService.findOne itself, but kept for potential other uses).
   * @param userId The ID of the user to validate.
   * @returns The User object if found, otherwise null (or handle NotFoundException).
   */
   async validateUser(userId: string): Promise<User | null> {
    try {
       const user = await this.usersService.findOne(userId);
       return user; // findOne throws if not found based on UsersService code
    } catch (error) {
       // If findOne throws NotFoundException specifically, treat as null user for validation
       if (error instanceof NotFoundException) {
          return null;
       }
       // Re-throw any other unexpected errors
       throw error;
     }
   }


  /**
   * Validates if a user has one of the required roles.
   * @param userId The ID of the user.
   * @param requiredRoles An array of role strings required for access.
   * @returns True if the user has one of the required roles, false otherwise.
   */
  async validateUserRoles(userId: string, requiredRoles: string[]): Promise<boolean> {
    // If no specific roles are required by the route/guard, allow access.
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    // Fetch the user details
    const user = await this.usersService.findOne(userId); // findOne throws if not found

    // If user not found (should have thrown) or doesn't have a role property, deny access
    // Added explicit check for user existence although findOne should throw.
    if (!user || !user.role) {
      return false;
    }

    // Check if the user's role string is included in the list of required roles
    return requiredRoles.includes(user.role);
  }
}