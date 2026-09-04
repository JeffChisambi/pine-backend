import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';
import { CurrentUser } from '../../../core/decorators/current-user.decorator';
import { STAFF_ROLES, Role } from '../../../core/constants/roles.constant';
import type { AuthenticatedUser } from '../../../core/types/request-context.types';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { SessionService } from '../../auth/services/session.service';
import { PasswordService } from '../../auth/services/password.service';
import { MfaService } from '../services/mfa.service';
import { AuditLogService } from '../../audit/services/audit-log.service';
import {
  ValidationException,
  ForbiddenException,
  UnauthorizedException,
} from '../../../core/exceptions/app.exception';
import { ErrorCode } from '../../../core/constants/error-codes.constant';

// ── DTOs ──────────────────────────────────────────────────────────────────────

class UpdateProfileDto {
  @IsString() @IsNotEmpty() firstName: string;
  @IsString() @IsNotEmpty() lastName: string;
  @IsOptional() @IsString() phone?: string;
}

class ChangePasswordDto {
  @IsString() @IsNotEmpty() currentPassword: string;
  @IsString() @IsNotEmpty() @MinLength(8) newPassword: string;
}

class MfaCodeDto {
  @IsString() @IsNotEmpty() code: string;
}

class UpdateNotifPrefsDto {
  @IsOptional() order_filled?: boolean;
  @IsOptional() order_failed?: boolean;
  @IsOptional() kyc_update?: boolean;
  @IsOptional() login_alert?: boolean;
  @IsOptional() daily_summary?: boolean;
}

// ── Controller ────────────────────────────────────────────────────────────────

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/me')
export class AdminMeController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionService: SessionService,
    private readonly passwordService: PasswordService,
    private readonly mfaService: MfaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  // ── Profile ─────────────────────────────────────────────────────

  @Get()
  async getProfile(@CurrentUser() user: AuthenticatedUser) {
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        role: true,
        createdAt: true,
        isBrokerStaff: true,
        staffSections: true,
        mustChangePassword: true,
      },
    });

    const mfaEnabled = await this.mfaService.isMfaEnabled(user.id);
    const { staffSections, ...rest } = u;

    return {
      ...rest,
      sections: u.isBrokerStaff ? staffSections : null,
      mfaEnabled,
    };
  }

  @Patch()
  async updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
  ) {
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { firstName: dto.firstName, lastName: dto.lastName, phone: dto.phone },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        role: true,
        createdAt: true,
      },
    });

    const mfaEnabled = await this.mfaService.isMfaEnabled(user.id);
    return { ...updated, mfaEnabled };
  }

  // ── Password ────────────────────────────────────────────────────

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
  ) {
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { passwordHash: true },
    });

    const valid = await this.passwordService.verify(dto.currentPassword, u.passwordHash);
    if (!valid) {
      throw new ValidationException('Current password is incorrect.');
    }

    if (dto.newPassword === dto.currentPassword) {
      throw new ValidationException('Choose a password different from the current one.');
    }

    const hash = await this.passwordService.hash(dto.newPassword);
    await this.prisma.user.update({
      where: { id: user.id },
      // A staff member on a temporary password has now set their own.
      data: { passwordHash: hash, mustChangePassword: false },
    });

    return { message: 'Password changed successfully.' };
  }

  // ── MFA ─────────────────────────────────────────────────────────

  @Post('mfa/setup')
  @HttpCode(HttpStatus.OK)
  async setupMfa(@CurrentUser() user: AuthenticatedUser) {
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { email: true },
    });
    return this.mfaService.generateSetup(user.id, u.email!);
  }

  @Post('mfa/confirm')
  @HttpCode(HttpStatus.OK)
  async confirmMfa(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: MfaCodeDto,
  ) {
    return this.mfaService.confirmSetup(user.id, dto.code);
  }

  @Post('mfa/disable')
  @HttpCode(HttpStatus.OK)
  async disableMfa(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { code?: string },
  ) {
    // Re-authentication required: a stolen session token alone must not
    // be enough to strip MFA from an account. Verify a current TOTP code
    // (or recovery code) before disabling.
    const code = body?.code?.trim();
    if (!code) {
      throw new UnauthorizedException(
        'Enter your current authenticator code to disable MFA.',
        ErrorCode.UNAUTHORIZED,
      );
    }
    let valid = false;
    try {
      valid = await this.mfaService.verifyCode(user.id, code);
    } catch {
      valid = false;
    }
    if (!valid) {
      valid = await this.mfaService.verifyRecoveryCode(user.id, code);
    }
    if (!valid) {
      throw new UnauthorizedException('Invalid verification code', ErrorCode.UNAUTHORIZED);
    }

    await this.mfaService.resetMfa(user.id);

    await this.auditLogService.log({
      actorId: user.id,
      actorRole: user.role,
      action: 'MFA_DISABLED',
      resourceType: 'USER',
      resourceId: user.id,
    });

    return { message: 'MFA has been disabled.' };
  }

  // ── Sessions ────────────────────────────────────────────────────

  @Get('sessions')
  async listSessions(@CurrentUser() user: AuthenticatedUser) {
    const sessions = await this.sessionService.listActiveSessions(user.id);

    return sessions.map((s) => ({
      id: s.id,
      deviceInfo: s.userAgent ?? 'Unknown device',
      ipAddress: s.ipAddress ?? 'Unknown',
      lastSeenAt: s.lastUsedAt.toISOString(),
      createdAt: s.createdAt.toISOString(),
      current: s.id === user.sessionId,
    }));
  }

  @Post('sessions/:sessionId/revoke')
  @HttpCode(HttpStatus.OK)
  async revokeSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('sessionId') sessionId: string,
  ) {
    if (sessionId === user.sessionId) {
      throw new ValidationException('Cannot revoke your current session. Use logout instead.');
    }
    await this.sessionService.revokeSession(sessionId, user.id, 'admin_revoked');
    return { message: 'Session revoked.' };
  }

  @Post('sessions/revoke-all')
  @HttpCode(HttpStatus.OK)
  async revokeAllSessions(@CurrentUser() user: AuthenticatedUser) {
    const count = await this.sessionService.revokeAllSessions(
      user.id,
      user.sessionId,
      'admin_revoked_all',
    );
    return { message: `${count} session(s) revoked.` };
  }

  // ── Notification preferences ────────────────────────────────────

  @Get('notification-preferences')
  async getNotifPrefs(@CurrentUser() user: AuthenticatedUser) {
    const prefs = await this.prisma.notificationPreference.findMany({
      where: { userId: user.id },
    });

    const map: Record<string, boolean> = {
      order_filled: true,
      order_failed: true,
      kyc_update: true,
      login_alert: true,
      daily_summary: true,
    };

    for (const p of prefs) {
      const key = this.categoryToKey(p.category);
      if (key) map[key] = p.pushEnabled;
    }

    return map;
  }

  @Patch('notification-preferences')
  @HttpCode(HttpStatus.OK)
  async updateNotifPrefs(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateNotifPrefsDto,
  ) {
    const entries: [string, string, boolean][] = [
      ['order_filled', 'TRADING', dto.order_filled],
      ['order_failed', 'TRADING', dto.order_failed],
      ['kyc_update', 'KYC', dto.kyc_update],
      ['login_alert', 'SECURITY', dto.login_alert],
      ['daily_summary', 'SYSTEM', dto.daily_summary],
    ].filter(([, , v]) => v !== undefined) as [string, string, boolean][];

    for (const [, category, enabled] of entries) {
      await this.prisma.notificationPreference.upsert({
        where: { userId_category: { userId: user.id, category } },
        update: { pushEnabled: enabled, emailEnabled: enabled },
        create: {
          userId: user.id,
          category,
          pushEnabled: enabled,
          emailEnabled: enabled,
        },
      });
    }

    return this.getNotifPrefs({ ...user } as AuthenticatedUser);
  }

  private categoryToKey(category: string): string | null {
    switch (category) {
      case 'TRADING': return 'order_filled';
      case 'KYC': return 'kyc_update';
      case 'SECURITY': return 'login_alert';
      case 'SYSTEM': return 'daily_summary';
      default: return null;
    }
  }
}
