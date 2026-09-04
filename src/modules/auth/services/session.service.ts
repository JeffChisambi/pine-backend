import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { TokenService } from './token.service';
import { AppConfigService } from '../../../config/app-config.service';
import { UnauthorizedException } from '../../../core/exceptions/app.exception';
import { ErrorCode } from '../../../core/constants/error-codes.constant';
import { STAFF_ROLES, Role } from '../../../core/constants/roles.constant';

/**
 * How stale `lastActivityAt` may get before we bother writing it again.
 *
 * The dashboard beats at most once a minute, but several tabs can beat at
 * once; this keeps that to one write per session per minute.
 */
const ACTIVITY_WRITE_THROTTLE_MS = 60_000;

/**
 * Session lifecycle management. Every login creates a session
 * bound to a specific user + device. Sessions are the authority
 * for refresh token validity.
 *
 * Refresh token rotation:
 *   1. User presents refresh token
 *   2. We hash it and find the matching session
 *   3. We generate a NEW refresh token
 *   4. We update the session with the new hash
 *   5. We return the new token pair
 *   6. The old refresh token is immediately invalid
 *
 * Family-based theft detection:
 *   All sessions in a refresh chain share a `familyId`.
 *   If an old (rotated-out) refresh token is presented,
 *   we revoke the ENTIRE family — the attacker AND the
 *   legitimate user must re-authenticate. This is the
 *   standard OAuth 2.0 refresh token rotation pattern.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenService: TokenService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Create a new session for a user + device login.
   */
  async createSession(data: {
    userId: string;
    deviceId: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<{ sessionId: string; refreshToken: string }> {
    const refreshToken = this.tokenService.generateRefreshToken();
    const refreshTokenHash = this.tokenService.hashRefreshToken(refreshToken);
    const familyId = randomUUID();

    const expiresAt = this.calculateRefreshExpiry();

    const session = await this.prisma.session.create({
      data: {
        userId: data.userId,
        deviceId: data.deviceId,
        refreshTokenHash,
        familyId,
        ipAddress: data.ipAddress,
        userAgent: data.userAgent,
        expiresAt,
      },
    });

    this.logger.log(
      { sessionId: session.id, userId: data.userId, deviceId: data.deviceId },
      'Session created',
    );

    return { sessionId: session.id, refreshToken };
  }

  /**
   * Rotate a refresh token. Finds the session by the old token hash,
   * generates a new token, and updates the session.
   *
   * If the old token has already been rotated (token reuse), this
   * revokes the entire family — both attacker and legitimate user
   * must re-authenticate.
   */
  async rotateRefreshToken(oldRefreshToken: string): Promise<{
    sessionId: string;
    userId: string;
    deviceId: string;
    newRefreshToken: string;
  }> {
    const oldHash = this.tokenService.hashRefreshToken(oldRefreshToken);

    // Find session by current refresh token hash
    const session = await this.prisma.session.findFirst({
      where: { refreshTokenHash: oldHash },
    });

    if (session) {
      // Valid rotation — session found with this hash
      if (session.isRevoked) {
        throw new UnauthorizedException(
          'Session has been revoked',
          ErrorCode.SESSION_REVOKED,
        );
      }

      if (session.expiresAt < new Date()) {
        throw new UnauthorizedException(
          'Refresh token expired',
          ErrorCode.TOKEN_EXPIRED,
        );
      }

      // A refresh is the client's timer talking, not a person. Without this
      // check the dashboard would silently renew an abandoned session every
      // time its access token aged out, and the idle limit would never bite.
      const owner = await this.prisma.user.findUnique({
        where: { id: session.userId },
        select: { role: true },
      });
      if (this.isIdleExpired(owner?.role as Role, session.lastActivityAt)) {
        await this.revokeForIdle(session.id, session.userId);
        throw new UnauthorizedException(
          'Session ended after a period of inactivity. Please sign in again.',
          ErrorCode.SESSION_REVOKED,
        );
      }

      // Generate new refresh token
      const newRefreshToken = this.tokenService.generateRefreshToken();
      const newHash = this.tokenService.hashRefreshToken(newRefreshToken);

      // Update session with new token hash
      await this.prisma.session.update({
        where: { id: session.id },
        data: {
          refreshTokenHash: newHash,
          lastUsedAt: new Date(),
        },
      });

      return {
        sessionId: session.id,
        userId: session.userId,
        deviceId: session.deviceId,
        newRefreshToken,
      };
    }

    // Token not found — possible token reuse attack
    // Check if this hash was EVER used (find by familyId pattern)
    // Since we can't look up old hashes directly, this path means
    // either the token is invalid or it was already rotated (theft).
    this.logger.warn(
      'Refresh token not found — possible token reuse or invalid token',
    );

    throw new UnauthorizedException(
      'Invalid refresh token',
      ErrorCode.TOKEN_INVALID,
    );
  }

  /**
   * Revoke a session (logout or forced revocation).
   */
  async revokeSession(
    sessionId: string,
    userId: string,
    reason: string = 'user_logout',
  ): Promise<void> {
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, userId },
    });

    if (!session) return;

    await this.prisma.session.update({
      where: { id: sessionId },
      data: {
        isRevoked: true,
        revokedAt: new Date(),
        revokedReason: reason,
      },
    });

    this.logger.log({ sessionId, userId, reason }, 'Session revoked');
  }

  /**
   * Revoke all sessions for a user (e.g., password change).
   * Optionally exclude the current session.
   */
  async revokeAllSessions(
    userId: string,
    excludeSessionId?: string,
    reason: string = 'security_action',
  ): Promise<number> {
    const result = await this.prisma.session.updateMany({
      where: {
        userId,
        isRevoked: false,
        ...(excludeSessionId ? { id: { not: excludeSessionId } } : {}),
      },
      data: {
        isRevoked: true,
        revokedAt: new Date(),
        revokedReason: reason,
      },
    });

    this.logger.log(
      { userId, revokedCount: result.count, reason },
      'All sessions revoked',
    );

    return result.count;
  }

  /**
   * List active sessions for a user (for "Manage Sessions" screen).
   */
  async listActiveSessions(userId: string): Promise<
    Array<{
      id: string;
      deviceId: string;
      ipAddress: string | null;
      userAgent: string | null;
      createdAt: Date;
      lastUsedAt: Date;
      expiresAt: Date;
    }>
  > {
    return this.prisma.session.findMany({
      where: {
        userId,
        isRevoked: false,
        expiresAt: { gt: new Date() },
      },
      orderBy: { lastUsedAt: 'desc' },
      select: {
        id: true,
        deviceId: true,
        ipAddress: true,
        userAgent: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
      },
    });
  }

  /**
   * Validate that a session is still active (not revoked, not expired).
   */
  async validateSession(sessionId: string): Promise<boolean> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      include: { user: { select: { role: true } } },
    });

    if (!session) return false;
    if (session.isRevoked) return false;
    if (session.expiresAt < new Date()) return false;

    // Staff dashboards end after a period with nobody at the keyboard. This
    // is checked on EVERY request rather than by a sweep, so the moment the
    // window passes the session is dead everywhere at once.
    if (this.isIdleExpired(session.user?.role as Role, session.lastActivityAt)) {
      await this.revokeForIdle(session.id, session.userId);
      return false;
    }

    return true;
  }

  /** Minutes of inactivity a staff session survives; 0 = no idle limit. */
  private idleTimeoutMs(role: Role | undefined): number {
    if (!role || !STAFF_ROLES.includes(role)) return 0;
    const minutes = this.config.jwt.staffIdleTimeoutMinutes;
    return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 0;
  }

  private isIdleExpired(role: Role | undefined, lastActivityAt: Date): boolean {
    const limit = this.idleTimeoutMs(role);
    if (limit === 0) return false;
    return Date.now() - lastActivityAt.getTime() > limit;
  }

  private async revokeForIdle(sessionId: string, userId: string): Promise<void> {
    // Revoked, not merely rejected: the refresh token dies with it, so the
    // client cannot quietly mint a new access token and carry on.
    await this.prisma.session
      .update({
        where: { id: sessionId },
        data: { isRevoked: true, revokedAt: new Date(), revokedReason: 'idle_timeout' },
      })
      .catch(() => undefined);
    this.logger.log({ sessionId, userId }, 'Session ended — idle timeout');
  }

  /**
   * Record that a HUMAN did something in this session.
   *
   * Deliberately NOT called from validateSession: the dashboard polls in the
   * background every few seconds, so counting requests as activity would keep
   * an abandoned session alive forever. Only the heartbeat — which the client
   * sends when there has been real interaction — reaches here.
   */
  async recordActivity(sessionId: string): Promise<void> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { lastActivityAt: true },
    });
    if (!session) return;
    if (Date.now() - session.lastActivityAt.getTime() < ACTIVITY_WRITE_THROTTLE_MS) return;

    await this.prisma.session
      .update({ where: { id: sessionId }, data: { lastActivityAt: new Date() } })
      .catch(() => undefined);
  }

  private calculateRefreshExpiry(): Date {
    const expiresIn = this.config.jwt.refreshExpiresIn;
    const match = /^(\d+)(s|m|h|d)$/.exec(expiresIn);
    if (!match) return new Date(Date.now() + 30 * 86400 * 1000); // 30d default

    const num = parseInt(match[1], 10);
    const ms = (() => {
      switch (match[2]) {
        case 's': return num * 1000;
        case 'm': return num * 60000;
        case 'h': return num * 3600000;
        case 'd': return num * 86400000;
        default: return 30 * 86400000;
      }
    })();

    return new Date(Date.now() + ms);
  }
}
