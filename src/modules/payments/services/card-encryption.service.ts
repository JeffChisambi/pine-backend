import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import { AppConfigService } from '../../../config/app-config.service';

/**
 * CardEncryptionService — AES-256-GCM encryption for stored card numbers.
 *
 * Key derivation mirrors the pattern in MfaService: SHA-256 of the raw
 * PIN_ENCRYPTION_KEY with a domain separator (`:card`) so each service
 * derives a unique key from the same root secret.
 *
 * Storage format: "iv:tag:ciphertext" (all hex, colon-separated).
 */
@Injectable()
export class CardEncryptionService {
  private readonly encryptionKey: Buffer;

  constructor(private readonly config: AppConfigService) {
    const rawKey = this.config.security.pinEncryptionKey;
    this.encryptionKey = crypto
      .createHash('sha256')
      .update(rawKey + ':card')
      .digest();
  }

  /**
   * AAD binds each ciphertext to its owning user: a saved_cards row copied
   * to another user's row (SQL injection, a compromised backup, an insider
   * edit) fails GCM authentication on decrypt instead of yielding the PAN.
   */
  private aad(userId: string): Buffer {
    return Buffer.from(`pine-card:${userId}`, 'utf8');
  }

  /**
   * Encrypt a raw card number (PAN), bound to its owning user, and return a
   * compact "iv:tag:ciphertext" string suitable for database storage.
   */
  encrypt(cardNumber: string, userId: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    cipher.setAAD(this.aad(userId));
    let encrypted = cipher.update(cardNumber, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag().toString('hex');
    return `${iv.toString('hex')}:${tag}:${encrypted}`;
  }

  /**
   * Decrypt a stored "iv:tag:ciphertext" string back to the raw PAN.
   * Throws if the ciphertext was tampered with or belongs to another user.
   */
  decrypt(stored: string, userId: string): string {
    const [ivHex, tagHex, encrypted] = stored.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      this.encryptionKey,
      iv,
    );
    decipher.setAAD(this.aad(userId));
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }
}
