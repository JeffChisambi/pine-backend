import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { PasswordService } from './password.service';
import {
  ConflictException,
  UnauthorizedException,
  ResourceNotFoundException,
} from '../../../core/exceptions/app.exception';
import { ErrorCode } from '../../../core/constants/error-codes.constant';
import { normalizeMalawiPhoneNumber } from '../../../shared/phone/malawi-phone';

/**
 * Identity service — pure user identity management.
 * Answers "Who is this user?" without touching sessions,
 * tokens, devices, or any business domain.
 *
 * Responsibilities:
 *   - User creation (registration)
 *   - Credential validation (login)
 *   - Password changes
 *   - Account status checks
 *   - Profile retrieval
 */
@Injectable()
export class IdentityService {
  private readonly logger = new Logger(IdentityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
  ) {}

  /**
   * Create a new user account. Hashes the password and creates
   * default preferences. Throws ConflictException if phone or
   * email is already registered.
   */
  async createUser(data: {
    phone: string;
    firstName: string;
    lastName: string;
    password: string;
    email?: string;
  }): Promise<{
    id: string;
    phone: string;
    email: string | null;
    firstName: string;
    lastName: string;
    role: string;
    kycStatus: string;
  }> {
    const phone = normalizeMalawiPhoneNumber(data.phone);

    // Check for existing phone
    const existingByPhone = await this.prisma.user.findUnique({
      where: { phone },
    });
    if (existingByPhone) {
      throw new ConflictException(
        'An account with this phone number already exists',
        ErrorCode.CONFLICT,
      );
    }

    // Check for existing email
    if (data.email) {
      const existingByEmail = await this.prisma.user.findUnique({
        where: { email: data.email },
      });
      if (existingByEmail) {
        throw new ConflictException(
          'An account with this email already exists',
          ErrorCode.CONFLICT,
        );
      }
    }

    // Hash password
    const passwordHash = await this.passwordService.hash(data.password);

    // Create user + default preferences in a transaction
    const user = await this.prisma.user.create({
      data: {
        phone,
        firstName: data.firstName,
        lastName: data.lastName,
        passwordHash,
        email: data.email,
        preferences: {
          create: {}, // defaults defined in schema
        },
      },
      select: {
        id: true,
        phone: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        kycStatus: true,
      },
    });

    this.logger.log({ userId: user.id, phone }, 'User created');
    return user;
  }

  /**
   * Validate credentials for login. Returns the user if the
   * password matches, throws if not.
   * Supports lookup by phone OR email.
   */
  async validateCredentials(
    identifier: string,
    password: string,
    identifierType: 'phone' | 'email' = 'phone',
  ): Promise<{
    id: string;
    phone: string;
    email: string | null;
    firstName: string;
    lastName: string;
    role: string;
    kycStatus: string;
    pinHash: string | null;
    isActive: boolean;
  }> {
    const normalizedIdentifier =
      identifierType === 'phone' ? normalizeMalawiPhoneNumber(identifier) : identifier;
    const whereClause =
      identifierType === 'email'
        ? { email: normalizedIdentifier }
        : { phone: normalizedIdentifier };

    const user = await this.prisma.user.findUnique({
      where: whereClause,
      select: {
        id: true,
        phone: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        kycStatus: true,
        passwordHash: true,
        pinHash: true,
        isActive: true,
        deactivatedAt: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException(
        'Invalid phone number or password',
        ErrorCode.INVALID_CREDENTIALS,
      );
    }

    // Check account status
    if (!user.isActive) {
      throw new UnauthorizedException('Account is deactivated', ErrorCode.ACCOUNT_LOCKED);
    }

    // Verify password
    const isValid = await this.passwordService.verify(password, user.passwordHash);

    if (!isValid) {
      throw new UnauthorizedException(
        'Invalid phone number or password',
        ErrorCode.INVALID_CREDENTIALS,
      );
    }

    return {
      id: user.id,
      phone: user.phone,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      kycStatus: user.kycStatus,
      pinHash: user.pinHash,
      isActive: user.isActive,
    };
  }

  /**
   * Get a user by ID (for token verification, profile display).
   */
  async getUserById(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        phone: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        kycStatus: true,
        pinHash: true,
        pinFailedAttempts: true,
        pinLockedUntil: true,
        avatarKey: true,
        isActive: true,
        createdAt: true,
      },
    });

    if (!user) {
      throw new ResourceNotFoundException('User', userId);
    }

    return user;
  }

  /**
   * Change password. Validates the old password first, checks
   * that the new password hasn't been used recently, then updates.
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    });

    if (!user) {
      throw new ResourceNotFoundException('User', userId);
    }

    // Verify current password
    const isValid = await this.passwordService.verify(currentPassword, user.passwordHash);

    if (!isValid) {
      throw new UnauthorizedException(
        'Current password is incorrect',
        ErrorCode.INVALID_CREDENTIALS,
      );
    }

    // Hash new password
    const newHash = await this.passwordService.hash(newPassword);

    // Update password
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: newHash },
    });

    this.logger.log({ userId }, 'Password changed');
  }

  /**
   * Reset password (after OTP verification — OTP verification
   * is handled by the AuthService orchestrator before calling this).
   */
  async resetPassword(phone: string, newPassword: string): Promise<void> {
    const normalizedPhone = normalizeMalawiPhoneNumber(phone);
    const newHash = await this.passwordService.hash(newPassword);

    await this.prisma.user.update({
      where: { phone: normalizedPhone },
      data: { passwordHash: newHash },
    });

    this.logger.log({ phone: normalizedPhone }, 'Password reset');
  }

  /**
   * Create or change transaction PIN.
   */
  async setPin(userId: string, pinHash: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        pinHash,
        pinFailedAttempts: 0,
        pinLockedUntil: null,
      },
    });
  }

  /**
   * Update PIN failed attempts and lockout.
   */
  async updatePinAttempts(
    userId: string,
    failedAttempts: number,
    lockedUntil: Date | null,
  ): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        pinFailedAttempts: failedAttempts,
        pinLockedUntil: lockedUntil,
      },
    });
  }

  /**
   * Reset PIN attempts after successful verification.
   */
  async resetPinAttempts(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        pinFailedAttempts: 0,
        pinLockedUntil: null,
      },
    });
  }
}
