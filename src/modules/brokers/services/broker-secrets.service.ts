import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import { AppConfigService } from '../../../config/app-config.service';

/**
 * BrokerSecretsService — AES-256-GCM encryption for broker integration
 * secrets (gateway API passwords, settlement account numbers, API
 * credentials). Same envelope convention as MfaService/CardEncryption:
 * separate enc/iv/tag hex columns, key derived from PIN_ENCRYPTION_KEY
 * with a purpose-specific salt so key material is never shared between
 * domains.
 *
 * Secrets encrypted here are NEVER returned to any frontend and NEVER
 * logged. Decryption happens only server-side at the moment a gateway
 * call is constructed.
 */
@Injectable()
export class BrokerSecretsService {
  private readonly encryptionKey: Buffer;

  constructor(private readonly config: AppConfigService) {
    const rawKey = this.config.security.pinEncryptionKey;
    this.encryptionKey = crypto
      .createHash('sha256')
      .update(rawKey + ':broker-secrets')
      .digest();
  }

  encrypt(plaintext: string): { enc: string; iv: string; tag: string } {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag().toString('hex');
    return { enc: encrypted, iv: iv.toString('hex'), tag };
  }

  decrypt(enc: string, ivHex: string, tagHex: string): string {
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(enc, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  /** Mask an account/credential for display: keep last 4, e.g. "••••1234". */
  mask(value: string): string {
    const last4 = value.slice(-4);
    return `••••${last4}`;
  }
}
