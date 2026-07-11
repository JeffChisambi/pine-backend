import { Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import { AppConfigService } from '../../../config/app-config.service';
import {
  UnauthorizedException,
  ConflictException,
} from '../../../core/exceptions/app.exception';
import { ErrorCode } from '../../../core/constants/error-codes.constant';

const PIN_MAX_ATTEMPTS = 3;
const PIN_LOCKOUT_MINUTES = 15;

/**
 * Transaction PIN management. PINs are separate from account
 * passwords — they gate financial actions (buy, sell, withdraw,
 * change bank, update KYC) while the password gates login.
 *
 * PINs are hashed with Argon2id (same as passwords) and have
 * independent retry limits: 3 failed attempts → 15-minute lockout.
 */
@Injectable()
export class PinService {
  private readonly logger = new Logger(PinService.name);
  private readonly argon2Options: argon2.Options;

  constructor(private readonly config: AppConfigService) {
    this.argon2Options = {
      type: argon2.argon2id,
      memoryCost: config.security.argon2.memoryCost,
      timeCost: config.security.argon2.timeCost,
      parallelism: config.security.argon2.parallelism,
    };
  }

  async hashPin(pin: string): Promise<string> {
    return argon2.hash(pin, this.argon2Options);
  }

  async verifyPin(
    pin: string,
    pinHash: string | null,
    failedAttempts: number,
    lockedUntil: Date | null,
  ): Promise<{ valid: boolean; shouldLock: boolean; attemptsRemaining: number }> {
    // Check lockout
    if (lockedUntil && lockedUntil > new Date()) {
      const remainingMs = lockedUntil.getTime() - Date.now();
      const remainingMin = Math.ceil(remainingMs / 60000);
      throw new UnauthorizedException(
        `PIN locked. Try again in ${remainingMin} minutes`,
        ErrorCode.PIN_LOCKED,
      );
    }

    if (!pinHash) {
      throw new UnauthorizedException('PIN not set', ErrorCode.PIN_NOT_SET);
    }

    try {
      const valid = await argon2.verify(pinHash, pin);

      if (!valid) {
        const newAttempts = failedAttempts + 1;
        const shouldLock = newAttempts >= PIN_MAX_ATTEMPTS;
        const attemptsRemaining = Math.max(0, PIN_MAX_ATTEMPTS - newAttempts);

        return { valid: false, shouldLock, attemptsRemaining };
      }

      return { valid: true, shouldLock: false, attemptsRemaining: PIN_MAX_ATTEMPTS };
    } catch (error) {
      this.logger.warn({ err: error }, 'PIN verification error');
      return { valid: false, shouldLock: false, attemptsRemaining: PIN_MAX_ATTEMPTS - failedAttempts - 1 };
    }
  }

  calculateLockoutExpiry(): Date {
    return new Date(Date.now() + PIN_LOCKOUT_MINUTES * 60 * 1000);
  }

  validateFormat(pin: string): { valid: boolean; reason?: string } {
    if (!/^\d{4,6}$/.test(pin)) {
      return { valid: false, reason: 'PIN must be 4-6 digits' };
    }
    // Reject trivial PINs
    if (/^(\d)\1+$/.test(pin)) {
      return { valid: false, reason: 'PIN must not be all the same digit' };
    }
    if (['1234', '4321', '0000', '1111', '123456'].includes(pin)) {
      return { valid: false, reason: 'PIN is too common' };
    }
    return { valid: true };
  }
}
