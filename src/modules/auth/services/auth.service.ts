import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { IdentityService } from './identity.service';
import { SessionService } from './session.service';
import { TokenService } from './token.service';
import { OtpService } from './otp.service';
import { DeviceService } from './device.service';
import { PinService } from './pin.service';
import type { RegisterDto } from '../dto/register.dto';
import type { LoginDto } from '../dto/login.dto';
import type { AuthResponseDto, AuthUserDto } from '../dto/auth-response.dto';
import { ValidationException } from '../../../core/exceptions/app.exception';

/**
 * Auth orchestrator — coordinates identity, session, token,
 * OTP, device, and PIN services for every auth flow.
 *
 * This service has ONE responsibility: prove identity and
 * manage trust. It never touches wallets, KYC, trading, or
 * any business domain. Cross-module effects are achieved
 * exclusively through domain events.
 *
 * Flow: Login
 *   1. Validate credentials (IdentityService)
 *   2. Register/update device (DeviceService)
 *   3. Create session (SessionService)
 *   4. Sign access token (TokenService)
 *   5. Emit UserLoggedIn event
 *   6. Return tokens + user profile
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly identity: IdentityService,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
    private readonly otp: OtpService,
    private readonly devices: DeviceService,
    private readonly pins: PinService,
    private readonly events: EventEmitter2,
  ) {}

  // ──────────────────────────────────────────────────────────────
  // Registration
  // ──────────────────────────────────────────────────────────────

  async register(
    dto: RegisterDto,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<AuthResponseDto> {
    // 1. Create user
    const user = await this.identity.createUser({
      phone: dto.phone,
      firstName: dto.firstName,
      lastName: dto.lastName,
      password: dto.password,
      email: dto.email,
    });

    // 2. Register device (if fingerprint provided)
    const deviceResult = dto.deviceFingerprint
      ? await this.devices.registerOrUpdate({
          userId: user.id,
          fingerprint: dto.deviceFingerprint,
          platform: dto.platform ?? 'unknown',
          ipAddress,
        })
      : await this.devices.registerOrUpdate({
          userId: user.id,
          fingerprint: `auto-${Date.now()}`,
          platform: dto.platform ?? 'unknown',
          ipAddress,
        });

    // 3. Create session
    const { sessionId, refreshToken } = await this.sessions.createSession({
      userId: user.id,
      deviceId: deviceResult.deviceId,
      ipAddress,
      userAgent,
    });

    // 4. Sign access token
    const { accessToken, expiresIn } = this.tokens.signAccessToken({
      userId: user.id,
      role: user.role,
      sessionId,
      deviceId: deviceResult.deviceId,
      kycStatus: user.kycStatus,
    });

    // 5. Emit events
    this.events.emit('auth.user.registered', {
      userId: user.id,
      phone: user.phone,
    });
    this.events.emit('auth.session.created', {
      userId: user.id,
      sessionId,
      deviceId: deviceResult.deviceId,
    });

    // 6. Send phone verification OTP
    try {
      await this.otp.generate(dto.phone, 'phone_verification');
    } catch (error) {
      this.logger.warn(
        { err: error },
        'Failed to send phone verification OTP during registration',
      );
    }

    this.logger.log({ userId: user.id }, 'User registered');

    return this.buildAuthResponse(accessToken, refreshToken, expiresIn, {
      id: user.id,
      phone: user.phone,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      kycStatus: this.normalizeKycStatus(user.kycStatus),
      hasPinSet: false,
      avatarUrl: null,
      createdAt: new Date().toISOString(),
    });
  }

  // ──────────────────────────────────────────────────────────────
  // Login
  // ──────────────────────────────────────────────────────────────

  async login(
    dto: LoginDto,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<AuthResponseDto> {
    // 1. Validate credentials (support email or phone login)
    const identifier = dto.email ?? dto.phone!;
    const identifierType = dto.email ? 'email' as const : 'phone' as const;
    const user = await this.identity.validateCredentials(
      identifier,
      dto.password,
      identifierType,
    );

    // 2. Register/update device
    const deviceResult = await this.devices.registerOrUpdate({
      userId: user.id,
      fingerprint: dto.deviceFingerprint ?? `auto-${Date.now()}`,
      platform: dto.platform ?? 'unknown',
      osVersion: dto.osVersion,
      appVersion: dto.appVersion,
      ipAddress,
    });

    // 3. Create session
    const { sessionId, refreshToken } = await this.sessions.createSession({
      userId: user.id,
      deviceId: deviceResult.deviceId,
      ipAddress,
      userAgent,
    });

    // 4. Sign access token
    const { accessToken, expiresIn } = this.tokens.signAccessToken({
      userId: user.id,
      role: user.role,
      sessionId,
      deviceId: deviceResult.deviceId,
      kycStatus: user.kycStatus,
    });

    // 5. Emit events
    this.events.emit('auth.user.loggedin', {
      userId: user.id,
      sessionId,
      deviceId: deviceResult.deviceId,
      isNewDevice: deviceResult.isNewDevice,
      ipAddress,
    });

    this.logger.log(
      { userId: user.id, isNewDevice: deviceResult.isNewDevice },
      'User logged in',
    );

    return this.buildAuthResponse(accessToken, refreshToken, expiresIn, {
      id: user.id,
      phone: user.phone,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      kycStatus: this.normalizeKycStatus(user.kycStatus),
      hasPinSet: !!user.pinHash,
      avatarUrl: null,
      createdAt: new Date().toISOString(),
    });
  }

  // ──────────────────────────────────────────────────────────────
  // Refresh
  // ──────────────────────────────────────────────────────────────

  async refresh(oldRefreshToken: string): Promise<AuthResponseDto> {
    // 1. Rotate refresh token
    const { sessionId, userId, deviceId, newRefreshToken } =
      await this.sessions.rotateRefreshToken(oldRefreshToken);

    // 2. Get user data for token claims
    const user = await this.identity.getUserById(userId);

    // 3. Sign new access token
    const { accessToken, expiresIn } = this.tokens.signAccessToken({
      userId: user.id,
      role: user.role,
      sessionId,
      deviceId,
      kycStatus: user.kycStatus,
    });

    // 4. Emit event
    this.events.emit('auth.token.refreshed', { userId, sessionId });

    return this.buildAuthResponse(accessToken, newRefreshToken, expiresIn, {
      id: user.id,
      phone: user.phone,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      kycStatus: this.normalizeKycStatus(user.kycStatus),
      hasPinSet: !!user.pinHash,
      avatarUrl: null,
      createdAt: user.createdAt.toISOString(),
    });
  }

  // ──────────────────────────────────────────────────────────────
  // Logout
  // ──────────────────────────────────────────────────────────────

  async logout(userId: string, sessionId: string): Promise<void> {
    await this.sessions.revokeSession(sessionId, userId, 'user_logout');

    this.events.emit('auth.user.loggedout', { userId, sessionId });
    this.logger.log({ userId, sessionId }, 'User logged out');
  }

  // ──────────────────────────────────────────────────────────────
  // Password Reset Flow
  // ──────────────────────────────────────────────────────────────

  async forgotPassword(phone: string): Promise<{ message: string }> {
    // Generate OTP — even if the phone doesn't exist, return success
    // (prevents user enumeration)
    try {
      await this.otp.generate(phone, 'password_reset');
    } catch (error) {
      // Rate limit errors should still be thrown
      if (error instanceof Error && error.message.includes('wait')) throw error;
      this.logger.debug('Forgot password for non-existent phone (silent)');
    }

    return { message: 'If this phone is registered, a reset code has been sent' };
  }

  async resetPassword(
    phone: string,
    otp: string,
    newPassword: string,
  ): Promise<{ message: string }> {
    // Verify OTP
    await this.otp.verify(phone, 'password_reset', otp);

    // Reset password
    await this.identity.resetPassword(phone, newPassword);

    // Revoke all sessions for security
    // (user must re-login with new password)
    const user = await this.identity.validateCredentials(phone, newPassword);
    await this.sessions.revokeAllSessions(user.id, undefined, 'password_reset');

    this.events.emit('auth.password.changed', { userId: user.id });

    return { message: 'Password reset successfully. Please log in again.' };
  }

  async changePassword(
    userId: string,
    sessionId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ message: string }> {
    await this.identity.changePassword(userId, currentPassword, newPassword);

    // Revoke all OTHER sessions (keep current session active)
    await this.sessions.revokeAllSessions(userId, sessionId, 'password_change');

    this.events.emit('auth.password.changed', { userId });

    return { message: 'Password changed successfully' };
  }

  // ──────────────────────────────────────────────────────────────
  // PIN
  // ──────────────────────────────────────────────────────────────

  async createPin(userId: string, pin: string): Promise<{ message: string }> {
    const formatCheck = this.pins.validateFormat(pin);
    if (!formatCheck.valid) {
      throw new ValidationException(formatCheck.reason);
    }

    const user = await this.identity.getUserById(userId);
    if (user.pinHash) {
      throw new ValidationException('PIN already set. Use change PIN instead.');
    }

    const pinHash = await this.pins.hashPin(pin);
    await this.identity.setPin(userId, pinHash);

    this.events.emit('auth.pin.created', { userId });
    return { message: 'Transaction PIN created' };
  }

  async verifyPin(
    userId: string,
    sessionId: string,
    pin: string,
  ): Promise<{ pinToken: string }> {
    const user = await this.identity.getUserById(userId);

    const result = await this.pins.verifyPin(
      pin,
      user.pinHash,
      0, // TODO: read pinFailedAttempts from user
      null, // TODO: read pinLockedUntil from user
    );

    if (!result.valid) {
      if (result.shouldLock) {
        const lockExpiry = this.pins.calculateLockoutExpiry();
        await this.identity.updatePinAttempts(userId, 3, lockExpiry);
      } else {
        await this.identity.updatePinAttempts(
          userId,
          3 - result.attemptsRemaining,
          null,
        );
      }

      throw new ValidationException(
        `Invalid PIN. ${result.attemptsRemaining} attempt(s) remaining`,
      );
    }

    // Reset attempts on success
    await this.identity.resetPinAttempts(userId);

    // Issue short-lived PIN verification token
    const pinToken = this.tokens.signPinToken(userId, sessionId);

    return { pinToken };
  }

  async changePin(
    userId: string,
    currentPin: string,
    newPin: string,
  ): Promise<{ message: string }> {
    const formatCheck = this.pins.validateFormat(newPin);
    if (!formatCheck.valid) {
      throw new ValidationException(formatCheck.reason);
    }

    const user = await this.identity.getUserById(userId);

    const result = await this.pins.verifyPin(currentPin, user.pinHash, 0, null);
    if (!result.valid) {
      throw new ValidationException('Current PIN is incorrect');
    }

    const newPinHash = await this.pins.hashPin(newPin);
    await this.identity.setPin(userId, newPinHash);

    this.events.emit('auth.pin.changed', { userId });
    return { message: 'Transaction PIN changed' };
  }

  // ──────────────────────────────────────────────────────────────
  // OTP
  // ──────────────────────────────────────────────────────────────

  async sendOtp(
    destination: string,
    purpose: string,
  ): Promise<{ message: string; expiresInSeconds: number }> {
    const { expiresInSeconds } = await this.otp.generate(destination, purpose);

    this.events.emit('auth.otp.sent', { destination, purpose });
    return { message: 'OTP sent', expiresInSeconds };
  }

  async verifyOtp(
    destination: string,
    purpose: string,
    code: string,
  ): Promise<{ verified: boolean }> {
    await this.otp.verify(destination, purpose, code);

    this.events.emit('auth.otp.verified', { destination, purpose });
    return { verified: true };
  }

  // ──────────────────────────────────────────────────────────────
  // Profile
  // ──────────────────────────────────────────────────────────────

  async getProfile(userId: string): Promise<AuthUserDto> {
    const user = await this.identity.getUserById(userId);
    return {
      id: user.id,
      phone: user.phone,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      kycStatus: this.normalizeKycStatus(user.kycStatus),
      hasPinSet: !!user.pinHash,
      avatarUrl: null,
      isActive: user.isActive,
      createdAt: user.createdAt.toISOString(),
    };
  }

  // ──────────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────────

  /**
   * Normalize Prisma KycStatus enum to lowercase API contract values.
   * Contract: "not_started" | "pending" | "approved" | "rejected" | "manual_review"
   */
  private normalizeKycStatus(status: string): string {
    const map: Record<string, string> = {
      NOT_SUBMITTED: 'not_started',
      PENDING: 'pending',
      APPROVED: 'approved',
      REJECTED: 'rejected',
      MANUAL_REVIEW: 'manual_review',
    };
    return map[status] ?? status.toLowerCase();
  }

  private buildAuthResponse(
    accessToken: string,
    refreshToken: string,
    expiresIn: number,
    user: AuthUserDto,
  ): AuthResponseDto {
    return {
      accessToken,
      refreshToken,
      expiresIn,
      tokenType: 'Bearer',
      user,
    };
  }
}
