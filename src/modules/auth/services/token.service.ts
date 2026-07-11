import { Injectable, Logger } from '@nestjs/common';
import { randomBytes, createHash } from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import Redis from 'ioredis';
import { AppConfigService } from '../../../config/app-config.service';
import { UnauthorizedException } from '../../../core/exceptions/app.exception';
import { ErrorCode } from '../../../core/constants/error-codes.constant';
import type { AuthenticatedUser } from '../../../core/types/request-context.types';

/**
 * JWT access token payload — minimal claims to reduce token size.
 */
export interface AccessTokenPayload {
  sub: string;         // userId
  role: string;
  sid: string;         // sessionId
  did: string;         // deviceId
  kyc: string;         // kycStatus
  jti: string;         // unique token ID for blacklisting
}

/**
 * Token service — handles JWT access token signing/verification
 * and opaque refresh token generation with rotation.
 *
 * Access tokens:
 *   - Short-lived (15min default), never stored server-side
 *   - Contains minimal claims (user ID, role, session, device, KYC status)
 *   - Can be blacklisted via Redis (for forced logout)
 *
 * Refresh tokens:
 *   - Opaque random 64-byte hex strings (NOT JWTs)
 *   - Stored hashed (SHA-256) in the `sessions` table
 *   - Rotated on every use — old token immediately invalidated
 *   - Family-based theft detection: all tokens in a rotation chain
 *     share a `familyId`; reuse of an old token revokes the entire family
 */
@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);
  private readonly redis: Redis;

  private readonly accessSecret: string;
  private readonly accessExpiresIn: string;
  private readonly refreshSecret: string;
  private readonly issuer: string;
  private readonly audience: string;

  constructor(private readonly config: AppConfigService) {
    this.accessSecret = config.jwt.accessSecret;
    this.accessExpiresIn = config.jwt.accessExpiresIn;
    this.refreshSecret = config.jwt.refreshSecret;
    this.issuer = config.jwt.issuer;
    this.audience = config.jwt.audience;

    this.redis = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
      db: config.redis.db,
    });
  }

  /**
   * Sign a new JWT access token with minimal claims.
   */
  signAccessToken(payload: {
    userId: string;
    role: string;
    sessionId: string;
    deviceId: string;
    kycStatus: string;
  }): { accessToken: string; expiresIn: number } {
    const jti = randomBytes(16).toString('hex');

    const tokenPayload: AccessTokenPayload = {
      sub: payload.userId,
      role: payload.role,
      sid: payload.sessionId,
      did: payload.deviceId,
      kyc: payload.kycStatus,
      jti,
    };

    const accessToken = jwt.sign(tokenPayload, this.accessSecret, {
      expiresIn: this.accessExpiresIn as any,
      issuer: this.issuer,
      audience: this.audience,
    });

    // Parse expiry in seconds
    const expiresIn = this.parseExpiresIn(this.accessExpiresIn);

    return { accessToken, expiresIn };
  }

  /**
   * Verify and decode a JWT access token. Also checks the Redis
   * blacklist for forced-logout tokens.
   */
  async verifyAccessToken(token: string): Promise<AccessTokenPayload> {
    try {
      const payload = jwt.verify(token, this.accessSecret, {
        issuer: this.issuer,
        audience: this.audience,
      }) as AccessTokenPayload;

      // Check blacklist
      const isBlacklisted = await this.redis.exists(`blacklist:${payload.jti}`);
      if (isBlacklisted) {
        throw new UnauthorizedException(
          'Token has been revoked',
          ErrorCode.SESSION_REVOKED,
        );
      }

      return payload;
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;

      if (error instanceof jwt.TokenExpiredError) {
        throw new UnauthorizedException(
          'Access token expired',
          ErrorCode.TOKEN_EXPIRED,
        );
      }

      throw new UnauthorizedException(
        'Invalid access token',
        ErrorCode.TOKEN_INVALID,
      );
    }
  }

  /**
   * Generate an opaque refresh token (64-byte random hex).
   * The caller is responsible for hashing and storing it.
   */
  generateRefreshToken(): string {
    return randomBytes(64).toString('hex');
  }

  /**
   * Hash a refresh token with SHA-256 for storage in the DB.
   * We never store raw refresh tokens — only their hashes.
   */
  hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Blacklist a JWT access token (by its `jti`) in Redis.
   * Used during forced logout — the token remains invalid
   * until its natural expiry.
   */
  async blacklistAccessToken(jti: string, expiresIn: number): Promise<void> {
    await this.redis.setex(`blacklist:${jti}`, expiresIn, '1');
  }

  /**
   * Generate a short-lived PIN verification token.
   * This is returned after successful PIN verification and
   * must be included in the `x-pin-token` header for
   * financial actions.
   */
  signPinToken(userId: string, sessionId: string): string {
    return jwt.sign(
      { sub: userId, sid: sessionId, purpose: 'pin-verify' },
      this.refreshSecret,
      { expiresIn: '5m' },
    );
  }

  /**
   * Verify a PIN verification token from the `x-pin-token` header.
   */
  verifyPinToken(
    token: string,
    userId: string,
  ): boolean {
    try {
      const payload = jwt.verify(token, this.refreshSecret) as {
        sub: string;
        purpose: string;
      };
      return payload.sub === userId && payload.purpose === 'pin-verify';
    } catch {
      return false;
    }
  }

  /**
   * Map JWT payload to the AuthenticatedUser shape that request.user expects.
   */
  payloadToUser(
    payload: AccessTokenPayload,
    phone: string,
    email: string | null,
  ): AuthenticatedUser {
    return {
      id: payload.sub,
      phone,
      email,
      role: payload.role as any,
      sessionId: payload.sid,
      deviceId: payload.did,
      kycStatus: payload.kyc as any,
    };
  }

  private parseExpiresIn(value: string): number {
    const match = /^(\d+)(s|m|h|d)$/.exec(value);
    if (!match) return 900; // default 15min

    const num = parseInt(match[1], 10);
    switch (match[2]) {
      case 's': return num;
      case 'm': return num * 60;
      case 'h': return num * 3600;
      case 'd': return num * 86400;
      default: return 900;
    }
  }
}
