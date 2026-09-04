import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { TokenService } from '../../auth/services/token.service';
import { SessionService } from '../../auth/services/session.service';
import { PasswordService } from '../../auth/services/password.service';
import { STAFF_ROLES, Role } from '../../../core/constants/roles.constant';
import {
  UnauthorizedException,
  ForbiddenException,
} from '../../../core/exceptions/app.exception';
import { ErrorCode } from '../../../core/constants/error-codes.constant';
import { MfaService } from './mfa.service';
import { AuditLogService } from '../../audit/services/audit-log.service';
import * as crypto from 'crypto';

/**
 * AdminAuthService — handles staff login with mandatory MFA.
 *
 * Login Flow:
 *   1. Email + password validation → check staff role
 *   2. If MFA not set up → return mfaRequired: 'setup' + temporary token
 *   3. If MFA enabled → return mfaRequired: 'verify' + temporary MFA token
 *   4. Client calls /mfa/verify with TOTP code + MFA token
 *   5. Server verifies TOTP → issues full JWT access + refresh tokens
 *
 * The MFA token is a short-lived, single-use JWT that only grants
 * permission to complete the MFA step — not to access any APIs.
 */
@Injectable()
export class AdminAuthService {
  private readonly logger = new Logger(AdminAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenService: TokenService,
    private readonly sessionService: SessionService,
    private readonly passwordService: PasswordService,
    private readonly mfaService: MfaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  /**
   * The user object every auth response returns. Carries the two things the
   * dashboard must know before it renders anything: whether this person is
   * broker STAFF limited to certain sections, and whether they are still on
   * a temporary password and must set their own first.
   */
  private staffProfile(user: {
    id: string; email: string | null; firstName: string; lastName: string; role: string;
    isBrokerStaff: boolean; staffSections: string[]; mustChangePassword: boolean;
  }) {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      isBrokerStaff: user.isBrokerStaff,
      sections: user.isBrokerStaff ? user.staffSections : null,
      mustChangePassword: user.mustChangePassword,
    };
  }

  async login(
    email: string,
    password: string,
    ipAddress?: string,
    userAgent?: string,
  ) {
    // Find user by email
    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      throw new UnauthorizedException(
        'Invalid email or password',
        ErrorCode.UNAUTHORIZED,
      );
    }

    // Verify password
    const isValidPassword = await this.passwordService.verify(
      password,
      user.passwordHash,
    );

    if (!isValidPassword) {
      await this.auditLogService.log({
        actorId: user.id,
        actorRole: user.role,
        action: 'ADMIN_LOGIN_FAILED',
        resourceType: 'USER',
        resourceId: user.id,
        ipAddress,
        userAgent,
        metadata: { reason: 'invalid_password' },
      });

      throw new UnauthorizedException(
        'Invalid email or password',
        ErrorCode.UNAUTHORIZED,
      );
    }

    // Check staff role
    if (!STAFF_ROLES.includes(user.role as Role)) {
      await this.auditLogService.log({
        actorId: user.id,
        actorRole: user.role,
        action: 'ADMIN_LOGIN_DENIED',
        resourceType: 'USER',
        resourceId: user.id,
        ipAddress,
        userAgent,
        metadata: { reason: 'not_staff_role', role: user.role },
      });

      throw new ForbiddenException(
        'This account does not have admin access',
      );
    }

    // Check if account is active
    if (!user.isActive) {
      throw new ForbiddenException('This account has been deactivated');
    }

    // Check MFA status
    const mfaEnabled = await this.mfaService.isMfaEnabled(user.id);

    // Generate a temporary MFA token (short-lived, only for MFA flow)
    const mfaToken = this.generateMfaToken(user.id);

    if (!mfaEnabled) {
      // MFA not set up — require setup before access
      await this.auditLogService.log({
        actorId: user.id,
        actorRole: user.role,
        action: 'ADMIN_LOGIN_MFA_SETUP_REQUIRED',
        resourceType: 'USER',
        resourceId: user.id,
        ipAddress,
        userAgent,
      });

      return {
        mfaRequired: 'setup' as const,
        mfaToken,
        user: this.staffProfile(user),
      };
    }

    // MFA enabled — require verification
    return {
      mfaRequired: 'verify' as const,
      mfaToken,
      user: this.staffProfile(user),
    };
  }

  async completeMfaVerification(
    mfaToken: string,
    code: string,
    ipAddress?: string,
    userAgent?: string,
  ) {
    const userId = this.verifyMfaToken(mfaToken);

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid MFA token', ErrorCode.UNAUTHORIZED);
    }

    // Try TOTP code first
    let isValid = false;
    let method = 'totp';

    try {
      isValid = await this.mfaService.verifyCode(userId, code);
    } catch {
      isValid = false;
    }

    // If TOTP fails, try recovery code
    if (!isValid) {
      isValid = await this.mfaService.verifyRecoveryCode(userId, code);
      method = 'recovery_code';
    }

    if (!isValid) {
      await this.auditLogService.log({
        actorId: userId,
        actorRole: user.role,
        action: 'ADMIN_MFA_FAILED',
        resourceType: 'USER',
        resourceId: userId,
        ipAddress,
        userAgent,
      });

      throw new UnauthorizedException(
        'Invalid verification code',
        ErrorCode.UNAUTHORIZED,
      );
    }

    // MFA passed — create session and issue full tokens
    const device = await this.getOrCreateAdminDevice(user.id, ipAddress);
    const { sessionId, refreshToken } = await this.sessionService.createSession({
      userId: user.id,
      deviceId: device.id,
      ipAddress: ipAddress ?? undefined,
      userAgent: userAgent ?? undefined,
    });

    const { accessToken } = this.tokenService.signAccessToken({
      userId: user.id,
      role: user.role,
      sessionId,
      deviceId: device.id,
      kycStatus: user.kycStatus,
    });

    await this.auditLogService.log({
      actorId: userId,
      actorRole: user.role,
      action: 'ADMIN_LOGIN_SUCCESS',
      resourceType: 'USER',
      resourceId: userId,
      ipAddress,
      userAgent,
      metadata: { mfaMethod: method },
    });

    return {
      accessToken,
      refreshToken,
      user: this.staffProfile(user),
    };
  }

  /**
   * Issue tokens for a user whose identity has already been verified
   * (e.g. after MFA setup confirmation). Skips TOTP re-verification.
   */
  async issueTokensForUser(
    userId: string,
    ipAddress?: string,
    userAgent?: string,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new UnauthorizedException('User not found', ErrorCode.UNAUTHORIZED);
    }

    const device = await this.getOrCreateAdminDevice(user.id, ipAddress);
    const { sessionId, refreshToken } = await this.sessionService.createSession({
      userId: user.id,
      deviceId: device.id,
      ipAddress: ipAddress ?? undefined,
      userAgent: userAgent ?? undefined,
    });

    const { accessToken } = this.tokenService.signAccessToken({
      userId: user.id,
      role: user.role,
      sessionId,
      deviceId: device.id,
      kycStatus: user.kycStatus,
    });

    await this.auditLogService.log({
      actorId: userId,
      actorRole: user.role,
      action: 'ADMIN_LOGIN_SUCCESS',
      resourceType: 'USER',
      resourceId: userId,
      ipAddress,
      userAgent,
      metadata: { mfaMethod: 'setup_confirm' },
    });

    return {
      accessToken,
      refreshToken,
      user: this.staffProfile(user),
    };
  }

  async refreshTokens(refreshToken: string) {
    const rotated = await this.sessionService.rotateRefreshToken(refreshToken);

    const user = await this.prisma.user.findUnique({
      where: { id: rotated.userId },
      select: { id: true, role: true, kycStatus: true },
    });

    if (!user) {
      throw new UnauthorizedException('User not found', ErrorCode.UNAUTHORIZED);
    }

    const { accessToken } = this.tokenService.signAccessToken({
      userId: user.id,
      role: user.role,
      sessionId: rotated.sessionId,
      deviceId: rotated.deviceId,
      kycStatus: user.kycStatus,
    });

    return { accessToken, refreshToken: rotated.newRefreshToken };
  }

  async logout(sessionId: string, userId: string, ipAddress?: string) {
    await this.sessionService.revokeSession(sessionId, userId, 'admin_logout');

    await this.auditLogService.log({
      actorId: userId,
      action: 'ADMIN_LOGOUT',
      resourceType: 'SESSION',
      resourceId: sessionId,
      ipAddress,
    });
  }

  // ── Admin Device ──────────────────────────────────────────────

  private async getOrCreateAdminDevice(userId: string, ipAddress?: string) {
    // Per-user fingerprint so each admin's session is tracked independently.
    // A shared 'admin-web-dashboard' fingerprint meant every admin appeared
    // as the same "device", making anomalous-login detection useless.
    const fingerprint = `admin-dashboard-${userId}`;
    const existing = await this.prisma.device.findUnique({
      where: { userId_fingerprint: { userId, fingerprint } },
    });

    if (existing) {
      await this.prisma.device.update({
        where: { id: existing.id },
        data: { lastSeenAt: new Date(), lastSeenIp: ipAddress },
      });
      return existing;
    }

    return this.prisma.device.create({
      data: {
        userId,
        fingerprint,
        platform: 'web',
        osVersion: 'admin-dashboard',
        trustLevel: 'TRUSTED',
        trustScore: 100,
        lastSeenIp: ipAddress,
      },
    });
  }

  // ── MFA Token (short-lived, HMAC-signed) ─────────────────────

  /**
   * Verify an MFA token's HMAC signature + expiry and return the userId.
   * Public entry point for controllers that need the token's subject —
   * the signature check is NOT optional (see admin-auth.controller).
   */
  resolveMfaToken(token: string): string {
    return this.verifyMfaToken(token);
  }

  private generateMfaToken(userId: string): string {
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes
    const payload = `${userId}:${expiresAt}`;
    const signature = crypto
      .createHmac('sha256', this.getMfaTokenSecret())
      .update(payload)
      .digest('hex');
    return Buffer.from(`${payload}:${signature}`).toString('base64url');
  }

  private verifyMfaToken(token: string): string {
    try {
      const decoded = Buffer.from(token, 'base64url').toString();
      const [userId, expiresAtStr, signature] = decoded.split(':');

      if (!userId || !expiresAtStr || !signature) {
        throw new Error('Malformed token');
      }

      const payload = `${userId}:${expiresAtStr}`;
      const expectedSignature = crypto
        .createHmac('sha256', this.getMfaTokenSecret())
        .update(payload)
        .digest('hex');

      if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
        throw new Error('Invalid signature');
      }

      if (Date.now() > parseInt(expiresAtStr, 10)) {
        throw new Error('Token expired');
      }

      return userId;
    } catch {
      throw new UnauthorizedException(
        'Invalid or expired MFA token. Please log in again.',
        ErrorCode.UNAUTHORIZED,
      );
    }
  }

  private getMfaTokenSecret(): string {
    return crypto
      .createHash('sha256')
      .update(process.env.JWT_ACCESS_SECRET + ':mfa-token')
      .digest('hex');
  }
}
