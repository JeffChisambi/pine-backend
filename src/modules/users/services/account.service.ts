import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { SessionService } from '../../auth/services/session.service';
import { AuditLogService } from '../../audit/services/audit-log.service';
import {
  StorageService,
  type StorageBucket,
} from '../../../infrastructure/storage/storage.service';
import { ResourceNotFoundException } from '../../../core/exceptions/app.exception';

/**
 * AccountService — self-service account closure.
 *
 * A regulated brokerage cannot simply erase a customer: transaction, ledger,
 * order and audit history must be retained. So "delete my account" performs a
 * DEACTIVATE + ANONYMIZE:
 *   - login is permanently disabled (isActive=false, credentials cleared),
 *   - every session is revoked,
 *   - personal data (name, contact, KYC fields + document images, avatar) is
 *     scrubbed / tombstoned,
 *   - financial records remain intact, now linked to an anonymized user.
 *
 * The action is irreversible from the app; only support can reinstate.
 */
@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionService: SessionService,
    private readonly auditLogService: AuditLogService,
    private readonly storage: StorageService,
  ) {}

  async deleteOwnAccount(
    userId: string,
    meta?: { ipAddress?: string; userAgent?: string },
  ): Promise<{ message: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.isActive) {
      throw new ResourceNotFoundException('User', userId);
    }

    // 1) Audit BEFORE mutating (the audit row survives via SET NULL actor).
    await this.auditLogService.log({
      actorId: userId,
      actorRole: user.role,
      action: 'USER_SELF_DELETED',
      resourceType: 'USER',
      resourceId: userId,
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
      metadata: { deletedEmail: user.email, deletedPhone: user.phone },
    });

    // 2) Collect storage keys to purge (best-effort, done after the DB commit).
    const objects: Array<{ bucket: StorageBucket; key: string }> = [];
    if (user.avatarKey) objects.push({ bucket: 'avatars', key: user.avatarKey });
    const documents = await this.prisma.kycDocument.findMany({
      where: { kycApplication: { userId } },
      select: {
        storageBucket: true,
        storageKey: true,
        enhancedStorageKey: true,
        thumbnailStorageKey: true,
      },
    });
    for (const doc of documents) {
      const bucket = (doc.storageBucket as StorageBucket) ?? 'kyc';
      if (doc.storageKey) objects.push({ bucket, key: doc.storageKey });
      if (doc.enhancedStorageKey) objects.push({ bucket, key: doc.enhancedStorageKey });
      if (doc.thumbnailStorageKey) objects.push({ bucket, key: doc.thumbnailStorageKey });
    }

    // 3) Revoke every session so existing tokens can't be refreshed.
    const sessions = await this.prisma.session.findMany({
      where: { userId, isRevoked: false },
      select: { id: true },
    });
    for (const s of sessions) {
      await this.sessionService.revokeSession(s.id, userId, 'account_deletion');
    }

    // 4) Anonymize in one transaction. Unique columns get tombstoned (they can't
    //    be nulled while keeping the row), credentials are made unusable.
    const tombstone = randomUUID();
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: {
          isActive: false,
          deactivatedAt: new Date(),
          deletedAt: new Date(),
          phone: `deleted:${tombstone}`,
          email: null,
          firstName: 'Deleted',
          lastName: 'User',
          dateOfBirth: null,
          gender: null,
          avatarKey: null,
          passwordHash: `disabled:${randomUUID()}`,
          pinHash: null,
        },
      }),
      this.prisma.kycApplication.updateMany({
        where: { userId },
        data: {
          nationalIdNumber: null,
          dateOfBirth: null,
          addressLine1: null,
          addressLine2: null,
          city: null,
          district: null,
          ocrExtractedData: Prisma.JsonNull,
          reviewNotes: null,
        },
      }),
      this.prisma.linkedBank.deleteMany({ where: { userId } }),
    ]);

    // 5) Purge object storage (outside the DB transaction; failures are logged,
    //    never fatal — the account is already anonymized in the database).
    for (const obj of objects) {
      try {
        await this.storage.delete(obj.bucket, obj.key);
      } catch (err) {
        this.logger.warn({ userId, ...obj, err }, 'Failed to delete storage object during account deletion');
      }
    }

    this.logger.log({ userId }, 'Account self-deleted (deactivated + anonymized)');
    return { message: 'Your account has been closed and your personal data removed.' };
  }
}
