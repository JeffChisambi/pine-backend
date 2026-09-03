import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import * as crypto from 'crypto';
import { MigratedInvestorStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { MailService } from '../../../infrastructure/mail/mail.service';
import { AppConfigService } from '../../../config/app-config.service';
import { ValidationException } from '../../../core/exceptions/app.exception';
import { normalizeMalawiPhoneNumber } from '../../../shared/phone/malawi-phone';

/** How long an investor has to accept before the link stops working. */
const INVITE_TTL_DAYS = 30;

export interface MigrationRowInput {
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  dateOfBirth?: string;
  gender?: string;
  /** Anything else the broker's sheet carried, kept verbatim for reference. */
  extra?: Record<string, unknown>;
}

/** The subset of columns an import writes — never status or token fields. */
type ParsedRow = {
  firstName: string;
  lastName: string;
  phone: string;
  email: string | null;
  dateOfBirth: Date | null;
  gender: string | null;
  extra?: Prisma.InputJsonValue;
};

export interface MigrationRowResult {
  /** 1-based row number in the uploaded sheet, so errors point at a line. */
  row: number;
  name: string;
  phone: string | null;
  outcome: 'imported' | 'updated' | 'skipped';
  reason?: string;
}

/**
 * Investor migration — carrying a broker's existing client book onto Pine.
 *
 * Imported people are NOT user accounts. They have not agreed to Pine's terms,
 * chosen a password, or passed KYC here, and none of those can be done on their
 * behalf. What the import preserves is the broker's own record of them, so that
 * when they accept the invitation their registration is already filled in and
 * they only have to confirm it and complete KYC.
 *
 * Everything is scoped to the calling broker: one broker can never import,
 * list, or invite another's clients.
 */
@Injectable()
export class InvestorMigrationService {
  private readonly logger = new Logger(InvestorMigrationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly config: AppConfigService,
  ) {}

  // ── Import ────────────────────────────────────────────────────────────────

  /**
   * Validate and store a parsed sheet.
   *
   * Rows are independent: one bad line is reported and skipped rather than
   * failing the upload, because a broker re-uploading a 2,000-row export to
   * fix a single typo is a worse outcome than importing 1,999 and listing one.
   */
  async import(
    brokerId: string,
    importedById: string,
    rows: MigrationRowInput[],
  ): Promise<{
    batchId: string;
    imported: number;
    updated: number;
    skipped: number;
    results: MigrationRowResult[];
  }> {
    if (rows.length === 0) {
      throw new ValidationException('The sheet contained no rows.');
    }
    if (rows.length > 5000) {
      throw new ValidationException(
        `The sheet has ${rows.length} rows; import at most 5,000 at a time.`,
      );
    }

    const batchId = crypto.randomUUID();
    const results: MigrationRowResult[] = [];
    // Phones already seen in THIS sheet — a duplicate inside one file would
    // otherwise silently overwrite the earlier row.
    const seen = new Set<string>();

    for (const [index, raw] of rows.entries()) {
      const row = index + 1;
      const parsed = this.parseRow(raw);

      if ('error' in parsed) {
        results.push({ row, name: this.displayName(raw), phone: null, outcome: 'skipped', reason: parsed.error });
        continue;
      }

      const { data } = parsed;

      if (seen.has(data.phone)) {
        results.push({ row, name: this.displayName(raw), phone: data.phone, outcome: 'skipped', reason: 'Duplicate phone number in this sheet' });
        continue;
      }
      seen.add(data.phone);

      // Someone already trading on Pine must not be turned back into an
      // invitation — they would be asked to register an account they have.
      const existingUser = await this.prisma.user.findUnique({
        where: { phone: data.phone },
        select: { id: true },
      });
      if (existingUser) {
        results.push({ row, name: this.displayName(raw), phone: data.phone, outcome: 'skipped', reason: 'Already has a Pine account' });
        continue;
      }

      const existing = await this.prisma.migratedInvestor.findUnique({
        where: { brokerId_phone: { brokerId, phone: data.phone } },
        select: { id: true, status: true },
      });

      if (existing?.status === MigratedInvestorStatus.CLAIMED) {
        results.push({ row, name: this.displayName(raw), phone: data.phone, outcome: 'skipped', reason: 'Already registered from an earlier invitation' });
        continue;
      }

      await this.prisma.migratedInvestor.upsert({
        where: { brokerId_phone: { brokerId, phone: data.phone } },
        create: { brokerId, batchId, importedById, ...data },
        // Re-uploading a corrected sheet refreshes the details but never
        // resets an invitation that is already out.
        update: { ...data, batchId },
      });

      results.push({
        row,
        name: `${data.firstName} ${data.lastName}`,
        phone: data.phone,
        outcome: existing ? 'updated' : 'imported',
      });
    }

    const imported = results.filter((r) => r.outcome === 'imported').length;
    const updated = results.filter((r) => r.outcome === 'updated').length;
    const skipped = results.filter((r) => r.outcome === 'skipped').length;

    this.logger.log({ brokerId, batchId, imported, updated, skipped }, 'Investor migration import');
    return { batchId, imported, updated, skipped, results };
  }

  /**
   * One row → storable fields, or the reason it cannot be stored.
   *
   * Only name and phone are required: the phone is the person's identity on
   * Pine, and everything else is a convenience that KYC will verify anyway.
   */
  private parseRow(
    raw: MigrationRowInput,
  ): { data: ParsedRow } | { error: string } {
    const firstName = (raw.firstName ?? '').trim();
    const lastName = (raw.lastName ?? '').trim();
    if (!firstName || !lastName) return { error: 'Missing first or last name' };

    const rawPhone = (raw.phone ?? '').trim();
    if (!rawPhone) return { error: 'Missing phone number' };
    const phone = normalizeMalawiPhoneNumber(rawPhone);
    if (!/^\+265\d{9}$/.test(phone)) {
      return { error: `"${rawPhone}" is not a valid Malawi phone number` };
    }

    const email = (raw.email ?? '').trim().toLowerCase() || null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { error: `"${email}" is not a valid email address` };
    }

    let dateOfBirth: Date | null = null;
    if (raw.dateOfBirth) {
      const d = new Date(raw.dateOfBirth);
      if (Number.isNaN(d.getTime())) return { error: `"${raw.dateOfBirth}" is not a valid date of birth` };
      if (d > new Date()) return { error: 'Date of birth is in the future' };
      dateOfBirth = d;
    }

    let gender: string | null = null;
    if (raw.gender) {
      const g = raw.gender.trim().toUpperCase();
      const mapped = g === 'MALE' ? 'M' : g === 'FEMALE' ? 'F' : g;
      if (mapped !== 'M' && mapped !== 'F') return { error: `"${raw.gender}" is not a recognised gender (M or F)` };
      gender = mapped;
    }

    const extra =
      raw.extra && Object.keys(raw.extra).length > 0
        ? (raw.extra as Prisma.InputJsonValue)
        : undefined;

    return { data: { firstName, lastName, phone, email, dateOfBirth, gender, extra } };
  }

  private displayName(raw: MigrationRowInput): string {
    return [raw.firstName, raw.lastName].filter(Boolean).join(' ').trim() || '(unnamed)';
  }

  // ── Listing ───────────────────────────────────────────────────────────────

  async list(
    brokerId: string,
    filters: { status?: MigratedInvestorStatus; page?: number; limit?: number },
  ) {
    const page = Math.max(1, filters.page ?? 1);
    const limit = Math.min(200, Math.max(1, filters.limit ?? 50));
    const where: Prisma.MigratedInvestorWhereInput = {
      brokerId,
      ...(filters.status ? { status: filters.status } : {}),
    };

    const [rows, total, counts] = await Promise.all([
      this.prisma.migratedInvestor.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true, firstName: true, lastName: true, phone: true, email: true,
          dateOfBirth: true, gender: true, status: true, invitedAt: true,
          inviteCount: true, claimedAt: true, createdAt: true,
        },
      }),
      this.prisma.migratedInvestor.count({ where }),
      this.prisma.migratedInvestor.groupBy({
        by: ['status'],
        where: { brokerId },
        _count: { _all: true },
      }),
    ]);

    const byStatus = Object.fromEntries(
      counts.map((c) => [c.status, c._count._all]),
    ) as Record<MigratedInvestorStatus, number>;

    return {
      investors: rows,
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      counts: {
        pending: byStatus.PENDING ?? 0,
        invited: byStatus.INVITED ?? 0,
        claimed: byStatus.CLAIMED ?? 0,
        cancelled: byStatus.CANCELLED ?? 0,
      },
    };
  }

  // ── Invitations ───────────────────────────────────────────────────────────

  /**
   * Email the selected investors (or every uninvited one) an invitation to
   * claim their account.
   *
   * Only people with an email address can be reached; the rest are reported
   * back so the broker knows who still needs contacting another way.
   */
  async invite(
    brokerId: string,
    ids?: string[],
  ): Promise<{ sent: number; failed: number; skippedNoEmail: number; details: Array<{ id: string; name: string; outcome: string }> }> {
    const broker = await this.prisma.broker.findUnique({
      where: { id: brokerId },
      select: { name: true },
    });

    const targets = await this.prisma.migratedInvestor.findMany({
      where: {
        brokerId,
        ...(ids?.length ? { id: { in: ids } } : {}),
        status: { in: [MigratedInvestorStatus.PENDING, MigratedInvestorStatus.INVITED] },
      },
      select: { id: true, firstName: true, lastName: true, email: true },
    });

    let sent = 0;
    let failed = 0;
    let skippedNoEmail = 0;
    const details: Array<{ id: string; name: string; outcome: string }> = [];

    for (const target of targets) {
      const name = `${target.firstName} ${target.lastName}`;
      if (!target.email) {
        skippedNoEmail++;
        details.push({ id: target.id, name, outcome: 'no email address on file' });
        continue;
      }

      // A fresh token per send, so an earlier email cannot be replayed after
      // the broker re-invites someone.
      const rawToken = crypto.randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

      await this.prisma.migratedInvestor.update({
        where: { id: target.id },
        data: {
          tokenHash: this.hashToken(rawToken),
          tokenExpiresAt: expiresAt,
          status: MigratedInvestorStatus.INVITED,
          invitedAt: new Date(),
          inviteCount: { increment: 1 },
        },
      });

      const ok = await this.mail.sendInvestorMigrationInvite({
        to: target.email,
        firstName: target.firstName,
        brokerName: broker?.name ?? 'your broker',
        claimUrl: this.claimUrl(rawToken),
        expiresAt,
      });

      if (ok) {
        sent++;
        details.push({ id: target.id, name, outcome: 'invitation sent' });
      } else {
        failed++;
        details.push({ id: target.id, name, outcome: 'email could not be sent' });
      }
    }

    this.logger.log({ brokerId, sent, failed, skippedNoEmail }, 'Investor migration invitations');
    return { sent, failed, skippedNoEmail, details };
  }

  async cancel(brokerId: string, id: string): Promise<void> {
    const existing = await this.prisma.migratedInvestor.findFirst({
      where: { id, brokerId },
      select: { id: true, status: true },
    });
    if (!existing) throw new ValidationException('That imported investor does not exist.');
    if (existing.status === MigratedInvestorStatus.CLAIMED) {
      throw new ValidationException(
        'That person has already registered — cancelling the invitation would not remove their account.',
      );
    }
    // The token is cleared as well, so any invitation already in their inbox
    // stops working the moment it is cancelled.
    await this.prisma.migratedInvestor.update({
      where: { id },
      data: { status: MigratedInvestorStatus.CANCELLED, tokenHash: null, tokenExpiresAt: null },
    });
  }

  // ── Claiming (public, called by the mobile app) ───────────────────────────

  /**
   * Resolve an invitation token to the details registration should pre-fill.
   *
   * Returns null for anything unusable — unknown, expired, cancelled or
   * already claimed — so the app shows one honest message rather than
   * distinguishing cases an attacker could probe.
   */
  async resolveToken(token: string) {
    const record = await this.prisma.migratedInvestor.findUnique({
      where: { tokenHash: this.hashToken(token) },
      select: {
        id: true, firstName: true, lastName: true, phone: true, email: true,
        dateOfBirth: true, gender: true, status: true, tokenExpiresAt: true,
        broker: { select: { id: true, name: true } },
      },
    });

    if (!record) return null;
    if (record.status !== MigratedInvestorStatus.INVITED) return null;
    if (record.tokenExpiresAt && record.tokenExpiresAt < new Date()) return null;

    return {
      firstName: record.firstName,
      lastName: record.lastName,
      phone: record.phone,
      email: record.email,
      dateOfBirth: record.dateOfBirth ? record.dateOfBirth.toISOString().slice(0, 10) : null,
      gender: record.gender,
      broker: record.broker,
    };
  }

  /**
   * Bind a freshly registered user to the invitation they came from.
   *
   * Runs off the registration event so the brokers module never has to be
   * imported by auth (which would be a cycle). Failure here must never fail
   * the registration — the account is real either way; only the broker's
   * migration bookkeeping would be out of date.
   */
  @OnEvent('auth.user.registered')
  async onUserRegistered(payload: { userId: string; migrationToken?: string }): Promise<void> {
    if (!payload.migrationToken) return;

    try {
      const record = await this.prisma.migratedInvestor.findUnique({
        where: { tokenHash: this.hashToken(payload.migrationToken) },
        select: { id: true, status: true, brokerId: true, tokenExpiresAt: true },
      });
      if (!record || record.status !== MigratedInvestorStatus.INVITED) return;
      if (record.tokenExpiresAt && record.tokenExpiresAt < new Date()) return;

      await this.prisma.$transaction([
        this.prisma.migratedInvestor.update({
          where: { id: record.id },
          data: {
            status: MigratedInvestorStatus.CLAIMED,
            claimedAt: new Date(),
            userId: payload.userId,
            // Burn the token: an invitation is good for exactly one account.
            tokenHash: null,
            tokenExpiresAt: null,
          },
        }),
        // Put them with the broker who invited them, so they do not have to
        // pick one they were already a client of.
        this.prisma.user.update({
          where: { id: payload.userId },
          data: { brokerId: record.brokerId, brokerSelectedAt: new Date() },
        }),
      ]);

      this.logger.log(
        { userId: payload.userId, brokerId: record.brokerId },
        'Migrated investor claimed their account',
      );
    } catch (error) {
      this.logger.error(
        { err: error, userId: payload.userId },
        'Failed to link registration to its migration invitation',
      );
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /**
   * Where the invitation email points. A web landing page rather than a deep
   * link, so an investor who opens it on a laptop still gets somewhere useful;
   * it hands the token to the app when opened on a phone.
   */
  private claimUrl(token: string): string {
    const base = this.config.app.url.replace(/\/$/, '');
    return `${base}/claim?token=${encodeURIComponent(token)}`;
  }
}
