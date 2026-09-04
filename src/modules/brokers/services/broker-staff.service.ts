import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { MailService } from '../../../infrastructure/mail/mail.service';
import { AppConfigService } from '../../../config/app-config.service';
import { PasswordService } from '../../auth/services/password.service';
import { AuditLogService } from '../../audit/services/audit-log.service';
import { Role } from '../../../core/constants/roles.constant';
import {
  ConflictException,
  ResourceNotFoundException,
  ValidationException,
  ForbiddenException,
} from '../../../core/exceptions/app.exception';
import { DashboardSection, isDashboardSection } from '../staff/dashboard-sections';
import { StaffSectionGuard } from '../guards/staff-section.guard';

/**
 * Broker staff — people a broker administrator lets into their dashboard
 * with access to chosen sections only.
 *
 * Staff are User rows with role BROKER (so every existing broker-scoping rule
 * applies to them unchanged), flagged isBrokerStaff with a staffSections list.
 * StaffSectionGuard reads that list on every admin request; the dashboard
 * reads it to decide what to show. Neither trusts the other.
 *
 * Passwords: a temporary one is generated, hashed, and emailed exactly once.
 * It is never stored in the clear and never returned by any API after the
 * email is sent. mustChangePassword forces a new one at first sign-in.
 */
@Injectable()
export class BrokerStaffService {
  private readonly logger = new Logger(BrokerStaffService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly config: AppConfigService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditLogService,
    private readonly sectionGuard: StaffSectionGuard,
  ) {}

  /** Only a broker ADMINISTRATOR (not staff) may manage staff. */
  async requireManager(userId: string, brokerId: string): Promise<void> {
    const me = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isBrokerStaff: true, brokerId: true },
    });
    if (!me || me.brokerId !== brokerId || me.isBrokerStaff) {
      throw new ForbiddenException('Only a broker administrator can manage staff accounts.');
    }
  }

  async list(brokerId: string) {
    const rows = await this.prisma.user.findMany({
      where: { brokerId, role: Role.BROKER, isBrokerStaff: true, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, email: true, firstName: true, lastName: true, isActive: true,
        staffSections: true, mustChangePassword: true, createdAt: true,
        sessions: { where: { revokedAt: null }, orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true } },
      },
    });
    return {
      staff: rows.map((r) => ({
        id: r.id,
        email: r.email,
        firstName: r.firstName,
        lastName: r.lastName,
        isActive: r.isActive,
        sections: r.staffSections as DashboardSection[],
        mustChangePassword: r.mustChangePassword,
        lastSignInAt: r.sessions[0]?.createdAt ?? null,
        createdAt: r.createdAt,
      })),
    };
  }

  async invite(
    brokerId: string,
    actor: { id: string; role: Role },
    dto: { email: string; firstName: string; lastName: string; sections: string[] },
    ip?: string,
  ) {
    const sections = this.validateSections(dto.sections);
    const email = dto.email.trim().toLowerCase();

    const broker = await this.prisma.broker.findUnique({ where: { id: brokerId }, select: { name: true, isActive: true } });
    if (!broker) throw new ResourceNotFoundException('Broker', brokerId);
    if (!broker.isActive) throw new ValidationException('This broker is deactivated.');

    const existing = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) throw new ConflictException('A user with this email address already exists.');

    // Temporary password: emailed once, hashed here, then gone.
    const tempPassword = this.temporaryPassword();
    const passwordHash = await this.passwords.hash(tempPassword);

    const user = await this.prisma.user.create({
      data: {
        email,
        firstName: dto.firstName.trim(),
        lastName: dto.lastName.trim(),
        // Phone is required and unique; staff sign in by email.
        phone: `broker-staff-${crypto.randomBytes(6).toString('hex')}`,
        passwordHash,
        role: Role.BROKER,
        brokerId,
        isBrokerStaff: true,
        staffSections: sections,
        mustChangePassword: true,
        isActive: true,
      },
      select: { id: true, email: true, firstName: true, lastName: true },
    });

    const emailSent = await this.mail.sendStaffInvitation({
      to: email,
      firstName: user.firstName,
      brokerName: broker.name,
      temporaryPassword: tempPassword,
      loginUrl: `${this.config.app.dashboardUrl.replace(/\/$/, '')}/login`,
      sections,
    });

    await this.audit.log({
      actorId: actor.id,
      actorRole: actor.role,
      action: 'BROKER_STAFF_INVITED',
      resourceType: 'USER',
      resourceId: user.id,
      ipAddress: ip,
      // The password is never logged, only the fact that one was issued.
      metadata: { brokerId, email, sections, emailSent },
    });

    this.logger.log({ brokerId, staffId: user.id, emailSent }, 'Broker staff invited');

    return {
      staffId: user.id,
      email,
      sections,
      emailSent,
      // If mail is down the broker still needs a way to hand over the
      // credential. Shown once in the dashboard, never retrievable again.
      temporaryPassword: emailSent ? undefined : tempPassword,
    };
  }

  async updateSections(
    brokerId: string,
    actor: { id: string; role: Role },
    staffId: string,
    rawSections: string[],
    ip?: string,
  ) {
    const sections = this.validateSections(rawSections);
    const staff = await this.staffInBroker(brokerId, staffId);

    await this.prisma.user.update({
      where: { id: staff.id },
      data: { staffSections: sections },
    });
    this.sectionGuard.invalidate(staff.id);

    await this.audit.log({
      actorId: actor.id,
      actorRole: actor.role,
      action: 'BROKER_STAFF_SECTIONS_UPDATED',
      resourceType: 'USER',
      resourceId: staff.id,
      ipAddress: ip,
      metadata: { brokerId, before: staff.staffSections, after: sections },
    });

    return { staffId: staff.id, sections };
  }

  async setActive(
    brokerId: string,
    actor: { id: string; role: Role },
    staffId: string,
    isActive: boolean,
    ip?: string,
  ) {
    const staff = await this.staffInBroker(brokerId, staffId);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: staff.id },
        data: { isActive, deactivatedAt: isActive ? null : new Date() },
      }),
      // Deactivating must end their current sessions, not just block the
      // next sign-in.
      ...(isActive
        ? []
        : [this.prisma.session.updateMany({ where: { userId: staff.id, revokedAt: null }, data: { revokedAt: new Date() } })]),
    ]);
    this.sectionGuard.invalidate(staff.id);

    await this.audit.log({
      actorId: actor.id,
      actorRole: actor.role,
      action: isActive ? 'BROKER_STAFF_REACTIVATED' : 'BROKER_STAFF_DEACTIVATED',
      resourceType: 'USER',
      resourceId: staff.id,
      ipAddress: ip,
      metadata: { brokerId },
    });

    return { staffId: staff.id, isActive };
  }

  /** Issue a fresh temporary password (they lost the email, or it expired). */
  async resetPassword(
    brokerId: string,
    actor: { id: string; role: Role },
    staffId: string,
    ip?: string,
  ) {
    const staff = await this.staffInBroker(brokerId, staffId);
    const broker = await this.prisma.broker.findUnique({ where: { id: brokerId }, select: { name: true } });

    const tempPassword = this.temporaryPassword();
    const passwordHash = await this.passwords.hash(tempPassword);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: staff.id },
        data: { passwordHash, mustChangePassword: true },
      }),
      // A password reset invalidates whatever was signed in with the old one.
      this.prisma.session.updateMany({ where: { userId: staff.id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);

    const emailSent = await this.mail.sendStaffInvitation({
      to: staff.email!,
      firstName: staff.firstName,
      brokerName: broker?.name ?? 'your broker',
      temporaryPassword: tempPassword,
      loginUrl: `${this.config.app.dashboardUrl.replace(/\/$/, '')}/login`,
      sections: staff.staffSections as DashboardSection[],
      isReset: true,
    });

    await this.audit.log({
      actorId: actor.id,
      actorRole: actor.role,
      action: 'BROKER_STAFF_PASSWORD_RESET',
      resourceType: 'USER',
      resourceId: staff.id,
      ipAddress: ip,
      metadata: { brokerId, emailSent },
    });

    return { staffId: staff.id, emailSent, temporaryPassword: emailSent ? undefined : tempPassword };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async staffInBroker(brokerId: string, staffId: string) {
    const staff = await this.prisma.user.findFirst({
      where: { id: staffId, brokerId, role: Role.BROKER, isBrokerStaff: true, deletedAt: null },
      select: { id: true, email: true, firstName: true, staffSections: true },
    });
    // Indistinguishable from "does not exist" so ids from other brokers leak
    // nothing.
    if (!staff) throw new ResourceNotFoundException('Staff member', staffId);
    return staff;
  }

  private validateSections(raw: string[]): DashboardSection[] {
    const sections = Array.from(new Set(raw)).filter(isDashboardSection);
    if (sections.length !== new Set(raw).size) {
      throw new ValidationException('One or more sections are not recognised.');
    }
    if (sections.length === 0) {
      throw new ValidationException('Grant access to at least one section.');
    }
    return sections;
  }

  /**
   * 14 characters from an alphabet without look-alikes (no 0/O, 1/l/I), so a
   * password read off a phone screen is typed correctly first time. It also
   * satisfies the app's password policy (upper, lower, digit, symbol) so the
   * staff member is not refused before they can even change it.
   */
  private temporaryPassword(): string {
    const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const lower = 'abcdefghijkmnpqrstuvwxyz';
    const digits = '23456789';
    const symbols = '!@#$%&*';
    const all = upper + lower + digits + symbols;
    const pick = (set: string) => set[crypto.randomInt(set.length)];
    const chars = [pick(upper), pick(lower), pick(digits), pick(symbols)];
    while (chars.length < 14) chars.push(pick(all));
    // Fisher–Yates with a CSPRNG so the guaranteed classes are not always first.
    for (let i = chars.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join('');
  }
}
