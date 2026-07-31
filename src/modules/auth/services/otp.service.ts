import { Injectable, Logger } from '@nestjs/common';
import { randomInt, createHash } from 'node:crypto';
import Redis from 'ioredis';
import { AppConfigService } from '../../../config/app-config.service';
import {
  UnauthorizedException,
  RateLimitedException,
  ValidationException,
} from '../../../core/exceptions/app.exception';
import { ErrorCode } from '../../../core/constants/error-codes.constant';

/**
 * Redis-backed OTP service. OTPs are NEVER stored in PostgreSQL —
 * they live exclusively in Redis with automatic TTL expiry.
 *
 * Key schema:
 *   otp:{purpose}:{destination}       → hashed code
 *   otp-attempts:{purpose}:{dest}     → attempt counter
 *   otp-cooldown:{purpose}:{dest}     → resend cooldown lock
 *
 * In production, the `send` method emits an event that the
 * Notifications module consumes to dispatch via SMS/email.
 * In development, the OTP is logged to stdout.
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);
  private readonly redis: Redis;
  private readonly codeLength: number;
  private readonly ttlSeconds: number;
  private readonly maxAttempts: number;
  private readonly cooldownSeconds: number;

  constructor(private readonly config: AppConfigService) {
    this.redis = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
      db: config.redis.db,
    });

    this.codeLength = config.otp.length;
    this.ttlSeconds = config.otp.ttlSeconds;
    this.maxAttempts = config.otp.maxAttempts;
    this.cooldownSeconds = config.otp.resendCooldownSeconds;
  }

  /**
   * Generate and store an OTP for the given destination and purpose.
   * Returns the plaintext code (for sending via SMS/email).
   */
  async generate(
    destination: string,
    purpose: string,
  ): Promise<{ code: string; expiresInSeconds: number }> {
    const cooldownKey = `otp-cooldown:${purpose}:${destination}`;

    // Check resend cooldown
    const cooldownTtl = await this.redis.ttl(cooldownKey);
    if (cooldownTtl > 0) {
      throw new RateLimitedException(
        `Please wait ${cooldownTtl} seconds before requesting another OTP`,
        cooldownTtl,
      );
    }

    // Generate a numeric code
    const code = this.generateCode();

    // Hash the code before storing (defence in depth — even a Redis
    // compromise doesn't leak usable OTPs)
    const hashedCode = this.hashCode(code);

    const otpKey = `otp:${purpose}:${destination}`;
    const attemptsKey = `otp-attempts:${purpose}:${destination}`;

    // Store hashed code with TTL
    await this.redis.setex(otpKey, this.ttlSeconds, hashedCode);

    // Reset attempt counter
    await this.redis.del(attemptsKey);

    // Set resend cooldown
    await this.redis.setex(cooldownKey, this.cooldownSeconds, '1');

    // In development, log the code for testing
    if (this.config.app.isDevelopment) {
      this.logger.warn(
        { destination, purpose, code },
        '⚠️  DEV ONLY — OTP code (never log in production)',
      );
    }

    return { code, expiresInSeconds: this.ttlSeconds };
  }

  /**
   * Verify an OTP code. Consumes the OTP on success (one-time use).
   * Tracks attempts and rejects after max attempts exceeded.
   *
   * Race-condition fix: the attempt counter is incremented atomically with
   * Redis INCR (a single server-side command) before the hash comparison.
   * The previous GET → check → INCR pattern was non-atomic: two concurrent
   * wrong-code requests could both read attempts=N, both pass the < maxAttempts
   * guard, and both increment — effectively each burning only half an attempt,
   * making it possible to exhaust a 6-digit OTP with far fewer than maxAttempts
   * true failed attempts before the counter blocked them.
   */
  async verify(
    destination: string,
    purpose: string,
    code: string,
  ): Promise<boolean> {
    const otpKey = `otp:${purpose}:${destination}`;
    const attemptsKey = `otp-attempts:${purpose}:${destination}`;

    // Early exit for expired / never-generated OTPs.
    // Use a generic message to avoid confirming whether an OTP exists
    // for the given destination (information leakage).
    const storedHash = await this.redis.get(otpKey);
    if (!storedHash) {
      throw new UnauthorizedException(
        'Invalid or expired code',
        ErrorCode.OTP_EXPIRED,
      );
    }

    // Atomically increment the attempt counter. INCR returns the new value
    // as a single round-trip — no race between two concurrent requests.
    const newAttempts = await this.redis.incr(attemptsKey);

    // Bind the attempt counter TTL to the OTP TTL on the first attempt
    // so stale counters don't outlive their OTP.
    if (newAttempts === 1) {
      const otpTtl = await this.redis.ttl(otpKey);
      if (otpTtl > 0) await this.redis.expire(attemptsKey, otpTtl);
    }

    if (newAttempts > this.maxAttempts) {
      // Exceeded the limit — invalidate the OTP so the user must request a new one.
      await this.redis.del(otpKey, attemptsKey);
      throw new UnauthorizedException(
        'Maximum OTP verification attempts exceeded',
        ErrorCode.OTP_MAX_ATTEMPTS_EXCEEDED,
      );
    }

    // Verify
    const hashedInput = this.hashCode(code);
    if (hashedInput !== storedHash) {
      const remaining = this.maxAttempts - newAttempts;
      throw new UnauthorizedException(
        remaining > 0
          ? `Invalid or expired code. ${remaining} attempt(s) remaining`
          : 'Invalid or expired code',
        ErrorCode.OTP_INVALID,
      );
    }

    // Consume — delete all related keys
    await this.redis.del(otpKey, attemptsKey);

    this.logger.log({ destination, purpose }, 'OTP verified successfully');
    return true;
  }

  private generateCode(): string {
    const max = Math.pow(10, this.codeLength);
    const min = Math.pow(10, this.codeLength - 1);
    return randomInt(min, max).toString();
  }

  private hashCode(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }
}
