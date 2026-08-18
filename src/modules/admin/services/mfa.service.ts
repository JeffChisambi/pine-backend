import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { AppConfigService } from '../../../config/app-config.service';
import { ValidationException, ResourceNotFoundException } from '../../../core/exceptions/app.exception';
import * as crypto from 'crypto';
import * as argon2 from 'argon2';

/**
 * MfaService — production-grade TOTP MFA for admin accounts.
 *
 * Implements RFC 6238 TOTP with:
 *   - AES-256-GCM encrypted secret storage
 *   - Bcrypt-hashed recovery codes
 *   - QR code provisioning URI generation
 *   - Time-window tolerance (±1 step = ±30s)
 *
 * Compatible with Google Authenticator, Microsoft Authenticator, Authy, etc.
 *
 * The architecture is designed so customer MFA can be enabled
 * without changing the login flow or database schema — the
 * MfaConfig model is user-generic, not staff-specific.
 */
@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);
  private readonly encryptionKey: Buffer;
  private readonly issuer = 'Pine Admin';
  private readonly TOTP_PERIOD = 30; // seconds
  private readonly TOTP_DIGITS = 6;
  private readonly TOTP_WINDOW = 1; // ±1 step tolerance
  private readonly RECOVERY_CODE_COUNT = 10;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {
    // Derive a 32-byte key from the PIN_ENCRYPTION_KEY config
    const rawKey = this.config.security.pinEncryptionKey;
    this.encryptionKey = crypto
      .createHash('sha256')
      .update(rawKey + ':mfa')
      .digest();
  }

  // ── Setup ────────────────────────────────────────────────────

  /**
   * Generate a new TOTP secret for a user. Does NOT enable MFA yet —
   * the user must verify the first code via `confirmSetup()`.
   *
   * Returns the provisioning URI for QR code display and the
   * base32-encoded secret for manual entry.
   */
  async generateSetup(userId: string, userEmail: string): Promise<{
    secret: string;
    otpauthUri: string;
    qrDataUrl: string;
  }> {
    // Check if MFA is already enabled
    const existing = await this.prisma.mfaConfig.findUnique({
      where: { userId },
    });

    if (existing?.isEnabled) {
      throw new ValidationException('MFA is already enabled. Reset it first before re-configuring.');
    }

    // Generate a random 20-byte secret, encode as base32
    const secretBytes = crypto.randomBytes(20);
    const secret = this.encodeBase32(secretBytes);

    // Build otpauth URI
    const otpauthUri = `otpauth://totp/${encodeURIComponent(this.issuer)}:${encodeURIComponent(userEmail)}?secret=${secret}&issuer=${encodeURIComponent(this.issuer)}&algorithm=SHA1&digits=${this.TOTP_DIGITS}&period=${this.TOTP_PERIOD}`;

    // Generate QR code as data URL (simple SVG-based approach)
    const qrDataUrl = await this.generateQrDataUrl(otpauthUri);

    // Encrypt and store (or update if setup was started but not confirmed)
    const { encrypted, iv, tag } = this.encrypt(secret);

    await this.prisma.mfaConfig.upsert({
      where: { userId },
      update: {
        totpSecretEnc: encrypted,
        totpSecretIv: iv,
        totpSecretTag: tag,
        isEnabled: false,
        enabledAt: null,
        recoveryCodes: [],
        recoveryCodesUsedCount: 0,
      },
      create: {
        userId,
        totpSecretEnc: encrypted,
        totpSecretIv: iv,
        totpSecretTag: tag,
        isEnabled: false,
      },
    });

    return { secret, otpauthUri, qrDataUrl };
  }

  /**
   * Confirm MFA setup by verifying the first TOTP code.
   * Generates and returns recovery codes (shown once only).
   */
  async confirmSetup(
    userId: string,
    code: string,
  ): Promise<{ recoveryCodes: string[] }> {
    const config = await this.prisma.mfaConfig.findUnique({
      where: { userId },
    });

    if (!config) {
      throw new ResourceNotFoundException('MfaConfig', userId);
    }

    if (config.isEnabled) {
      throw new ValidationException('MFA is already enabled.');
    }

    // Verify the TOTP code
    const secret = this.decrypt(config.totpSecretEnc, config.totpSecretIv, config.totpSecretTag);
    const isValid = this.verifyTotp(secret, code);

    if (!isValid) {
      throw new ValidationException(
        'Invalid verification code. Please check your authenticator app and try again.',
      );
    }

    // Generate recovery codes
    const recoveryCodes = this.generateRecoveryCodes();
    const hashedCodes = await Promise.all(
      recoveryCodes.map((c) => argon2.hash(c)),
    );

    // Enable MFA
    await this.prisma.mfaConfig.update({
      where: { userId },
      data: {
        isEnabled: true,
        enabledAt: new Date(),
        recoveryCodes: hashedCodes,
        recoveryCodesGeneratedAt: new Date(),
      },
    });

    return { recoveryCodes };
  }

  // ── Verification ─────────────────────────────────────────────

  /**
   * Verify a TOTP code for an authenticated user.
   * Returns true if the code is valid.
   */
  async verifyCode(userId: string, code: string): Promise<boolean> {
    const config = await this.prisma.mfaConfig.findUnique({
      where: { userId },
    });

    if (!config?.isEnabled) {
      throw new ValidationException('MFA is not enabled for this account.');
    }

    const secret = this.decrypt(
      config.totpSecretEnc,
      config.totpSecretIv,
      config.totpSecretTag,
    );

    return this.verifyTotp(secret, code);
  }

  /**
   * Verify a recovery code. Each code can only be used once.
   */
  async verifyRecoveryCode(userId: string, code: string): Promise<boolean> {
    const config = await this.prisma.mfaConfig.findUnique({
      where: { userId },
    });

    if (!config?.isEnabled) {
      throw new ValidationException('MFA is not enabled for this account.');
    }

    // Try each hashed recovery code
    for (let i = 0; i < config.recoveryCodes.length; i++) {
      const hash = config.recoveryCodes[i];
      if (!hash) continue; // already used (empty string)

      const matches = await argon2.verify(hash, code);
      if (matches) {
        // Mark this code as used by replacing with empty string
        const updatedCodes = [...config.recoveryCodes];
        updatedCodes[i] = '';

        await this.prisma.mfaConfig.update({
          where: { userId },
          data: {
            recoveryCodes: updatedCodes,
            recoveryCodesUsedCount: config.recoveryCodesUsedCount + 1,
          },
        });

        return true;
      }
    }

    return false;
  }

  // ── Status ───────────────────────────────────────────────────

  async isMfaEnabled(userId: string): Promise<boolean> {
    const config = await this.prisma.mfaConfig.findUnique({
      where: { userId },
      select: { isEnabled: true },
    });
    return config?.isEnabled ?? false;
  }

  async getMfaStatus(userId: string): Promise<{
    isEnabled: boolean;
    enabledAt: Date | null;
    recoveryCodesRemaining: number;
  }> {
    const config = await this.prisma.mfaConfig.findUnique({
      where: { userId },
    });

    if (!config) {
      return { isEnabled: false, enabledAt: null, recoveryCodesRemaining: 0 };
    }

    const usedCount = config.recoveryCodes.filter((c) => c === '').length;

    return {
      isEnabled: config.isEnabled,
      enabledAt: config.enabledAt,
      recoveryCodesRemaining: config.recoveryCodes.length - usedCount,
    };
  }

  // ── Admin Reset ──────────────────────────────────────────────

  /**
   * Super Admin resets another admin's MFA. Fully audited.
   * Removes the MFA config so the user must set up again on next login.
   */
  async resetMfa(userId: string): Promise<void> {
    const config = await this.prisma.mfaConfig.findUnique({
      where: { userId },
    });

    if (!config) {
      throw new ResourceNotFoundException('MfaConfig', userId);
    }

    await this.prisma.mfaConfig.delete({ where: { userId } });
  }

  // ── TOTP Implementation (RFC 6238) ───────────────────────────

  private verifyTotp(secret: string, code: string): boolean {
    const now = Math.floor(Date.now() / 1000);

    // Check current time step and ±window steps
    for (let offset = -this.TOTP_WINDOW; offset <= this.TOTP_WINDOW; offset++) {
      const timeStep = Math.floor((now + offset * this.TOTP_PERIOD) / this.TOTP_PERIOD);
      const expected = this.generateTotpCode(secret, timeStep);
      if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(code))) {
        return true;
      }
    }
    return false;
  }

  private generateTotpCode(secret: string, timeStep: number): string {
    const secretBytes = this.decodeBase32(secret);

    // Time step as 8-byte big-endian buffer
    const timeBuffer = Buffer.alloc(8);
    timeBuffer.writeUInt32BE(0, 0);
    timeBuffer.writeUInt32BE(timeStep, 4);

    // HMAC-SHA1
    const hmac = crypto.createHmac('sha1', secretBytes);
    hmac.update(timeBuffer);
    const hash = hmac.digest();

    // Dynamic truncation (RFC 4226 section 5.4)
    const offset = hash[hash.length - 1]! & 0x0f;
    const binary =
      ((hash[offset]! & 0x7f) << 24) |
      ((hash[offset + 1]! & 0xff) << 16) |
      ((hash[offset + 2]! & 0xff) << 8) |
      (hash[offset + 3]! & 0xff);

    const otp = binary % 10 ** this.TOTP_DIGITS;
    return otp.toString().padStart(this.TOTP_DIGITS, '0');
  }

  // ── Encryption (AES-256-GCM) ─────────────────────────────────

  private encrypt(plaintext: string): {
    encrypted: string;
    iv: string;
    tag: string;
  } {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag().toString('hex');
    return {
      encrypted,
      iv: iv.toString('hex'),
      tag,
    };
  }

  private decrypt(encrypted: string, ivHex: string, tagHex: string): string {
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  // ── Base32 ───────────────────────────────────────────────────

  private encodeBase32(buffer: Buffer): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0;
    let value = 0;
    let result = '';

    for (const byte of buffer) {
      value = (value << 8) | byte;
      bits += 8;
      while (bits >= 5) {
        result += alphabet[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }

    if (bits > 0) {
      result += alphabet[(value << (5 - bits)) & 31];
    }

    return result;
  }

  private decodeBase32(input: string): Buffer {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const lookup = new Map<string, number>();
    for (let i = 0; i < alphabet.length; i++) {
      lookup.set(alphabet[i]!, i);
    }

    let bits = 0;
    let value = 0;
    const output: number[] = [];

    for (const char of input.toUpperCase()) {
      const val = lookup.get(char);
      if (val === undefined) continue;
      value = (value << 5) | val;
      bits += 5;
      if (bits >= 8) {
        output.push((value >>> (bits - 8)) & 0xff);
        bits -= 8;
      }
    }

    return Buffer.from(output);
  }

  // ── Recovery Codes ───────────────────────────────────────────

  private generateRecoveryCodes(): string[] {
    const codes: string[] = [];
    for (let i = 0; i < this.RECOVERY_CODE_COUNT; i++) {
      // Format: XXXX-XXXX (8 hex chars with dash)
      const bytes = crypto.randomBytes(4);
      const hex = bytes.toString('hex').toUpperCase();
      codes.push(`${hex.slice(0, 4)}-${hex.slice(4, 8)}`);
    }
    return codes;
  }

  // ── QR Code ──────────────────────────────────────────────────

  /**
   * Render the otpauth URI as a PNG data URL, generated fully server-side
   * so the OTP secret never leaves our infrastructure. The dashboard puts
   * this straight into an <img src>.
   */
  private async generateQrDataUrl(otpauthUri: string): Promise<string> {
    const QRCode = await import('qrcode');
    return QRCode.toDataURL(otpauthUri, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 240,
    });
  }
}
