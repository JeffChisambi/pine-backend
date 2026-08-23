import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { AppConfigService } from '../../../config/app-config.service';

/**
 * BankAccountCryptoService — the single authority for encrypting and
 * decrypting linked-bank account numbers (AES-256-GCM, `iv:tag:cipher`
 * hex format, key derived from the PIN encryption key).
 *
 * Decryption is exposed ONLY to the broker admin surface: the broker
 * legitimately needs the investor's full account number to open their
 * CSD trading account. Mobile/customer surfaces get the masked form.
 */
@Injectable()
export class BankAccountCryptoService {
  private readonly logger = new Logger(BankAccountCryptoService.name);
  private readonly key: Buffer;

  constructor(private readonly appConfig: AppConfigService) {
    this.key = crypto
      .createHash('sha256')
      .update(this.appConfig.security.pinEncryptionKey + ':bank')
      .digest();
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag().toString('hex');
    return `${iv.toString('hex')}:${tag}:${encrypted}`;
  }

  /**
   * Decrypt an `iv:tag:cipher` payload. Returns null (never throws) when
   * the value is missing or malformed — callers fall back to the masked
   * account number rather than breaking the whole user payload.
   */
  decrypt(payload: string | null | undefined): string | null {
    if (!payload) return null;
    const parts = payload.split(':');
    if (parts.length !== 3) return null;
    try {
      const [ivHex, tagHex, cipherHex] = parts;
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivHex, 'hex'));
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
      let plain = decipher.update(cipherHex, 'hex', 'utf8');
      plain += decipher.final('utf8');
      return plain;
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, 'Bank account decryption failed');
      return null;
    }
  }
}
