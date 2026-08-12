import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { PasswordService } from '../../auth/services/password.service';
import { AuditLogService } from '../../audit/services/audit-log.service';
import { Role } from '../../../core/constants/roles.constant';
import {
  ConflictException,
  ResourceNotFoundException,
  UnauthorizedException,
  ValidationException,
} from '../../../core/exceptions/app.exception';
import type { InviteBrokerAdminDto } from '../dto/broker.dto';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * BrokerAdminService — secure broker administrator onboarding.
 *
 * Flow:
 *   1. Super Admin invites a broker admin (email + name) for a broker.
 *   2. A user row is created: role BROKER, brokerId set, INACTIVE, with
 *      an unusable random password hash. Inactive users cannot log in.
 *   3. A one-time invitation token is generated. Only its SHA-256 hash
 *      is stored; the raw token is returned exactly once for delivery
 *      to the invitee. No password ever appears in the Super Admin UI.
 *   4. The invitee activates: sets their own password → account becomes
 *      active. On first login the existing mandatory admin MFA flow
 *      forces TOTP enrollment + verification before any dashboard access.
 */
@Injectable()
export class BrokerAdminService {
  private readonly logger = new Logger(BrokerAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly auditLog: AuditLogService,
  ) {}

  async inviteBrokerAdmin(
    brokerId: string,
    dto: InviteBrokerAdminDto,
    actor: { id: string; role: Role },
    ip?: string,
  ) {
    const broker = await this.prisma.broker.findUnique({ where: { id: brokerId } });
    if (!broker) throw new ResourceNotFoundException('Broker', brokerId);
    if (!broker.isActive) {
      throw new ValidationException('Cannot invite an administrator for a deactivated broker');
    }

    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException('A user with this email already exists');
    }

    // Unusable placeholder password — replaced during activation.
    const placeholderPassword = crypto.randomBytes(32).toString('hex');
    const passwordHash = await this.passwordService.hash(placeholderPassword);

    // Phone is unique+required in the schema; generate a placeholder if
    // none provided (broker admins authenticate by email).
    const phone = dto.phone ?? `broker-admin-${crypto.randomBytes(6).toString('hex')}`;

    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = this.hashToken(rawToken);
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

    const { user, invitation } = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: dto.email,
          firstName: dto.firstName,
          lastName: dto.lastName,
          phone,
          passwordHash,
          role: Role.BROKER,
          brokerId,
          isActive: false, // cannot log in until activated
        },
      });

      const invitation = await tx.brokerAdminInvitation.create({
        data: {
          brokerId,
          userId: user.id,
          email: dto.email,
          tokenHash,
          expiresAt,
          createdById: actor.id,
        },
      });

      return { user, invitation };
    });

    await this.auditLog.log({
      actorId: actor.id,
      actorRole: actor.role,
      action: 'BROKER_ADMIN_INVITED',
      resourceType: 'BROKER_ADMIN',
      resourceId: user.id,
      ipAddress: ip,
      metadata: { brokerId, email: dto.email, invitationId: invitation.id, expiresAt },
    });

    this.logger.log({ brokerId, adminUserId: user.id }, 'Broker admin invited');

    // The raw token is returned ONCE and never stored or logged.
    return {
      adminUserId: user.id,
      email: dto.email,
      invitationId: invitation.id,
      invitationToken: rawToken,
      expiresAt: expiresAt.toISOString(),
      instructions:
        'Share this one-time invitation token securely with the broker administrator. ' +
        'They will set their own password during activation and must enroll in MFA on first login.',
    };
  }

  /** Re-issue an invitation (revokes previous pending ones). */
  async reinviteBrokerAdmin(
    brokerId: string,
    adminUserId: string,
    actor: { id: string; role: Role },
    ip?: string,
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: adminUserId } });
    if (!user || user.brokerId !== brokerId || user.role !== Role.BROKER) {
      throw new ResourceNotFoundException('Broker administrator', adminUserId);
    }
    if (user.isActive) {
      throw new ConflictException('This administrator has already activated their account');
    }

    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = this.hashToken(rawToken);
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

    await this.prisma.$transaction(async (tx) => {
      await tx.brokerAdminInvitation.updateMany({
        where: { userId: adminUserId, acceptedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.brokerAdminInvitation.create({
        data: {
          brokerId,
          userId: adminUserId,
          email: user.email ?? '',
          tokenHash,
          expiresAt,
          createdById: actor.id,
        },
      });
    });

    await this.auditLog.log({
      actorId: actor.id,
      actorRole: actor.role,
      action: 'BROKER_ADMIN_REINVITED',
      resourceType: 'BROKER_ADMIN',
      resourceId: adminUserId,
      ipAddress: ip,
      metadata: { brokerId },
    });

    return { invitationToken: rawToken, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Activate a broker admin account: verify the one-time token, set the
   * new password, activate the user. MFA enrollment is then enforced by
   * the standard admin login flow (mfaRequired: 'setup').
   */
  async activate(token: string, password: string, ip?: string) {
    const tokenHash = this.hashToken(token);

    const invitation = await this.prisma.brokerAdminInvitation.findUnique({
      where: { tokenHash },
      include: { user: { select: { id: true, email: true, isActive: true } } },
    });

    if (!invitation || invitation.revokedAt) {
      throw new UnauthorizedException('Invalid or revoked invitation');
    }
    if (invitation.acceptedAt) {
      throw new UnauthorizedException('This invitation has already been used');
    }
    if (invitation.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('This invitation has expired. Ask for a new one.');
    }

    const passwordHash = await this.passwordService.hash(password);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: invitation.userId },
        data: { passwordHash, isActive: true },
      });
      await tx.brokerAdminInvitation.update({
        where: { id: invitation.id },
        data: { acceptedAt: new Date() },
      });
    });

    await this.auditLog.log({
      actorId: invitation.userId,
      actorRole: Role.BROKER,
      action: 'BROKER_ADMIN_ACTIVATED',
      resourceType: 'BROKER_ADMIN',
      resourceId: invitation.userId,
      ipAddress: ip,
      metadata: { brokerId: invitation.brokerId },
    });

    this.logger.log({ adminUserId: invitation.userId }, 'Broker admin activated');

    return {
      activated: true,
      email: invitation.user.email,
      next: 'Log in with your new password. You will be required to set up MFA before accessing the dashboard.',
    };
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }
}
