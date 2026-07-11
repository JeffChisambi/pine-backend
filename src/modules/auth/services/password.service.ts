import { Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import { AppConfigService } from '../../../config/app-config.service';

/**
 * Password hashing and verification using Argon2id — the recommended
 * algorithm for financial applications (memory-hard, side-channel
 * resistant, winner of the Password Hashing Competition).
 *
 * Never use bcrypt for a new financial system. Argon2id provides
 * better security properties with configurable memory/time costs.
 */
@Injectable()
export class PasswordService {
  private readonly logger = new Logger(PasswordService.name);
  private readonly argon2Options: argon2.Options;

  constructor(private readonly config: AppConfigService) {
    this.argon2Options = {
      type: argon2.argon2id,
      memoryCost: config.security.argon2.memoryCost,
      timeCost: config.security.argon2.timeCost,
      parallelism: config.security.argon2.parallelism,
    };
  }

  /**
   * Hash a password with Argon2id. The salt is generated automatically
   * and embedded in the output string.
   */
  async hash(password: string): Promise<string> {
    return argon2.hash(password, this.argon2Options);
  }

  /**
   * Verify a password against a stored Argon2id hash.
   * Returns true if the password matches.
   */
  async verify(password: string, hash: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch (error) {
      this.logger.warn({ err: error }, 'Password verification error');
      return false;
    }
  }

  /**
   * Check if a password meets the minimum complexity requirements.
   * This runs before hashing to fail fast on weak passwords.
   */
  validateComplexity(password: string): { valid: boolean; reason?: string } {
    if (password.length < 8) {
      return { valid: false, reason: 'Password must be at least 8 characters' };
    }
    if (!/[a-z]/.test(password)) {
      return { valid: false, reason: 'Password must contain a lowercase letter' };
    }
    if (!/[A-Z]/.test(password)) {
      return { valid: false, reason: 'Password must contain an uppercase letter' };
    }
    if (!/\d/.test(password)) {
      return { valid: false, reason: 'Password must contain a digit' };
    }
    if (!/[^a-zA-Z\d]/.test(password)) {
      return { valid: false, reason: 'Password must contain a special character' };
    }
    return { valid: true };
  }

  /**
   * Check if a new password has been used recently.
   * Prevents reuse of the last N passwords.
   */
  async isInHistory(
    newPassword: string,
    passwordHashes: string[],
  ): Promise<boolean> {
    for (const hash of passwordHashes) {
      if (await this.verify(newPassword, hash)) {
        return true;
      }
    }
    return false;
  }
}
