import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../../core/decorators/require-permissions.decorator';
import { Permission } from '../../auth/constants/permissions.constant';
import { CurrentUser } from '../../../core/decorators/current-user.decorator';
import type { AuthenticatedUser, RequestWithUser } from '../../../core/types/request-context.types';
import { AdminRepository } from '../repositories/admin.repository';
import { AuditLogService } from '../../audit/services/audit-log.service';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { SessionService } from '../../auth/services/session.service';
import { ListUsersQueryDto, UpdateUserStatusDto } from '../dto/admin.dto';
import { ResourceNotFoundException, ValidationException } from '../../../core/exceptions/app.exception';
import { BrokerScopeService } from '../../brokers/services/broker-scope.service';
import { AdminFinanceService } from '../services/admin-finance.service';

@ApiTags('admin', 'users')
@ApiBearerAuth()
@Controller('admin/users')
export class AdminUsersController {
  constructor(
    private readonly adminRepo: AdminRepository,
    private readonly auditLogService: AuditLogService,
    private readonly prisma: PrismaService,
    private readonly sessionService: SessionService,
    private readonly brokerScope: BrokerScopeService,
    private readonly finance: AdminFinanceService,
  ) {}

  @Get()
  @RequirePermissions(Permission.USERS_READ)
  @ApiOperation({ summary: 'List users (broker admins see only their own investors)' })
  @ApiResponse({ status: 200, description: 'Paginated user list' })
  async listUsers(@Query() query: ListUsersQueryDto, @CurrentUser() admin: AuthenticatedUser) {
    const scope = await this.brokerScope.resolveScope(admin);
    const result = await this.adminRepo.listUsers(
      {
        search: query.search,
        status: query.status,
        kycStatus: query.kycStatus,
        role: query.role,
        page: query.page,
        limit: query.limit,
      },
      scope,
    );
    // Real AUM per listed investor: wallet cash + market value of holdings,
    // valued at the latest close — the same formula the mobile app uses.
    const portfolios = await this.finance.portfolioValues({
      userIds: result.users.map((u) => u.id),
    });
    return {
      ...result,
      users: result.users.map((u) => {
        const portfolioValue = portfolios.get(u.id)?.toNumber() ?? 0;
        return {
          ...u,
          portfolioValue,
          totalAssets: Number(u.walletBalance) + portfolioValue,
        };
      }),
    };
  }

  @Get(':id')
  @RequirePermissions(Permission.USERS_READ)
  @ApiOperation({
    summary: 'Get full user workspace',
    description: 'Profile + wallet + KYC + devices + sessions + holdings in one call.',
  })
  @ApiResponse({ status: 200, description: 'User workspace' })
  async getUserWorkspace(@Param('id') userId: string, @CurrentUser() admin: AuthenticatedUser) {
    const scope = await this.brokerScope.resolveScope(admin);
    const user = await this.adminRepo.getUserWorkspace(userId, scope);
    if (!user) {
      throw new ResourceNotFoundException('User', userId);
    }
    // Server-computed financial summary — cash breakdown, market-valued
    // portfolio, lifetime fees. The dashboard renders these numbers as-is;
    // it never derives its own.
    const financialSummary = await this.finance.investorSummary(userId);
    // Brokers legitimately need the investor's FULL bank account number —
    // it goes on the CSD trading-account opening form. Expose it explicitly
    // as `accountNumber` instead of leaking the raw storage column.
    return {
      ...user,
      financialSummary,
      linkedBanks: (user.linkedBanks ?? []).map((b: any) => ({
        id: b.id,
        bankName: b.bankName,
        accountName: b.accountName,
        accountNumber: b.accountNumberEncrypted ?? b.accountNumberMasked,
        accountNumberMasked: b.accountNumberMasked,
        isPrimary: b.isPrimary,
        isVerified: b.isVerified,
        createdAt: b.createdAt,
      })),
    };
  }

  @Patch(':id/status')
  @RequirePermissions(Permission.USERS_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update user status (freeze/unfreeze/deactivate)' })
  @ApiResponse({ status: 200, description: 'User status updated' })
  async updateUserStatus(
    @Param('id') userId: string,
    @Body() dto: UpdateUserStatusDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Req() req: RequestWithUser,
  ) {
    const scope = await this.brokerScope.resolveScope(admin);
    await this.brokerScope.assertUserInScope(scope, userId);

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new ResourceNotFoundException('User', userId);
    }

    const updateData: Record<string, unknown> = {};

    if (dto.status === 'active') {
      updateData.isActive = true;
      updateData.deactivatedAt = null;
    } else if (dto.status === 'deactivated') {
      updateData.isActive = false;
      updateData.deactivatedAt = new Date();
    }

    // For freeze, update the wallet
    if (dto.status === 'frozen') {
      await this.prisma.wallet.updateMany({
        where: { userId },
        data: { isFrozen: true },
      });
    } else if (dto.status === 'active') {
      await this.prisma.wallet.updateMany({
        where: { userId },
        data: { isFrozen: false },
      });
    }

    if (Object.keys(updateData).length > 0) {
      await this.prisma.user.update({
        where: { id: userId },
        data: updateData,
      });
    }

    await this.auditLogService.log({
      actorId: admin.id,
      actorRole: admin.role,
      action: `USER_STATUS_${dto.status.toUpperCase()}`,
      resourceType: 'USER',
      resourceId: userId,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      metadata: { reason: dto.reason, previousActive: user.isActive },
    });

    return { message: `User status updated to ${dto.status}`, userId };
  }

  @Get(':id/devices')
  @RequirePermissions(Permission.USERS_READ)
  @ApiOperation({ summary: 'List user devices' })
  async getUserDevices(@Param('id') userId: string, @CurrentUser() admin: AuthenticatedUser) {
    const scope = await this.brokerScope.resolveScope(admin);
    await this.brokerScope.assertUserInScope(scope, userId);
    const devices = await this.prisma.device.findMany({
      where: { userId },
      orderBy: { lastSeenAt: 'desc' },
    });
    return { devices };
  }

  @Get(':id/sessions')
  @RequirePermissions(Permission.USERS_READ)
  @ApiOperation({ summary: 'List user active sessions' })
  async getUserSessions(@Param('id') userId: string, @CurrentUser() admin: AuthenticatedUser) {
    const scope = await this.brokerScope.resolveScope(admin);
    await this.brokerScope.assertUserInScope(scope, userId);
    const sessions = await this.prisma.session.findMany({
      where: { userId, isRevoked: false, expiresAt: { gt: new Date() } },
      orderBy: { lastUsedAt: 'desc' },
    });
    return { sessions };
  }

  @Post(':id/sessions/revoke')
  @RequirePermissions(Permission.USERS_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke all user sessions (force logout)' })
  async revokeUserSessions(
    @Param('id') userId: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Req() req: RequestWithUser,
  ) {
    const scope = await this.brokerScope.resolveScope(admin);
    await this.brokerScope.assertUserInScope(scope, userId);

    const sessions = await this.prisma.session.findMany({
      where: { userId, isRevoked: false },
    });

    for (const session of sessions) {
      await this.sessionService.revokeSession(session.id, userId, 'admin_force_logout');
    }

    await this.auditLogService.log({
      actorId: admin.id,
      actorRole: admin.role,
      action: 'USER_SESSIONS_REVOKED',
      resourceType: 'USER',
      resourceId: userId,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      metadata: { sessionsRevoked: sessions.length },
    });

    return { message: `Revoked ${sessions.length} sessions`, userId };
  }

  @Patch(':id/kyc-status')
  @RequirePermissions(Permission.USERS_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manually override a user KYC status' })
  async updateKycStatus(
    @Param('id') userId: string,
    @Body() body: { status: string; reason?: string },
    @CurrentUser() admin: AuthenticatedUser,
    @Req() req: RequestWithUser,
  ) {
    const scope = await this.brokerScope.resolveScope(admin);
    await this.brokerScope.assertUserInScope(scope, userId);

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new ResourceNotFoundException('User', userId);

    const validStatuses = ['NOT_SUBMITTED', 'PENDING', 'APPROVED', 'REJECTED'];
    if (!validStatuses.includes(body.status)) {
      throw new Error(`Invalid KYC status: ${body.status}`);
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { kycStatus: body.status as any },
    });

    // Also update the KYC application record if it exists
    await this.prisma.kycApplication.updateMany({
      where: { userId },
      data: {
        status: body.status === 'APPROVED' ? 'APPROVED' :
                body.status === 'REJECTED' ? 'REJECTED' :
                body.status === 'PENDING' ? 'PENDING' : 'NOT_SUBMITTED',
        reviewedAt: new Date(),
        reviewedById: admin.id,
      },
    });

    await this.auditLogService.log({
      actorId: admin.id,
      actorRole: admin.role,
      action: `KYC_STATUS_OVERRIDE_${body.status}`,
      resourceType: 'USER',
      resourceId: userId,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      metadata: { status: body.status, reason: body.reason, previousStatus: user.kycStatus },
    });

    return { message: `KYC status updated to ${body.status}`, userId };
  }

  @Delete(':id')
  @RequirePermissions(Permission.USERS_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Permanently delete a user account and all associated data' })
  @ApiResponse({ status: 200, description: 'User deleted' })
  async deleteUser(
    @Param('id') userId: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Req() req: RequestWithUser,
  ) {
    const scope = await this.brokerScope.resolveScope(admin);
    await this.brokerScope.assertUserInScope(scope, userId);

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new ResourceNotFoundException('User', userId);

    // Revoke all sessions first
    const sessions = await this.prisma.session.findMany({ where: { userId } });
    for (const session of sessions) {
      await this.sessionService.revokeSession(session.id, userId, 'admin_account_deletion');
    }

    // Log before deletion (audit record survives)
    await this.auditLogService.log({
      actorId: admin.id,
      actorRole: admin.role,
      action: 'USER_DELETED',
      resourceType: 'USER',
      resourceId: userId,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      metadata: {
        deletedEmail: user.email,
        deletedPhone: user.phone,
        deletedName: `${user.firstName} ${user.lastName}`,
      },
    });

    // Cascade delete (Prisma will handle relations via schema onDelete)
    await this.prisma.user.delete({ where: { id: userId } });

    return { message: 'User account permanently deleted', userId };
  }

  // ── POST /v1/admin/users/:id/notify ────────────────────────────────────────
  // Send a direct in-app message/notification to a single user.

  @Post(':id/notify')
  @RequirePermissions(Permission.USERS_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Send a direct notification/message to a single user' })
  async notifyUser(
    @Param('id') userId: string,
    @Body() body: { title?: string; message: string; channel?: string },
    @CurrentUser() admin: AuthenticatedUser,
    @Req() req: RequestWithUser,
  ) {
    const scope = await this.brokerScope.resolveScope(admin);
    await this.brokerScope.assertUserInScope(scope, userId);

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new ResourceNotFoundException('User', userId);
    if (!body?.message || !body.message.trim()) {
      throw new ValidationException('Message body is required');
    }

    const channel = (body.channel ?? 'IN_APP').toUpperCase();
    const allowed = ['IN_APP', 'PUSH', 'EMAIL', 'SMS'];
    const notification = await this.prisma.notification.create({
      data: {
        userId,
        channel: (allowed.includes(channel) ? channel : 'IN_APP') as any,
        type: 'INFORMATIONAL',
        priority: 2,
        category: 'SYSTEM',
        title: body.title?.trim() || 'Message from Pine',
        body: body.message.trim(),
        status: 'QUEUED',
      },
    });

    await this.auditLogService.log({
      actorId: admin.id,
      actorRole: admin.role,
      action: 'USER_MESSAGED',
      resourceType: 'USER',
      resourceId: userId,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      metadata: { channel, title: notification.title },
    });

    return { message: 'Notification queued', notificationId: notification.id };
  }

  // ── POST /v1/admin/users/:id/devices/:deviceId/revoke ──────────────────────
  // Sign out one device: revoke its active sessions and mark it revoked.

  @Post(':id/devices/:deviceId/revoke')
  @RequirePermissions(Permission.USERS_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign out a single device (revoke its sessions)' })
  async revokeDevice(
    @Param('id') userId: string,
    @Param('deviceId') deviceId: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Req() req: RequestWithUser,
  ) {
    const scope = await this.brokerScope.resolveScope(admin);
    await this.brokerScope.assertUserInScope(scope, userId);

    const device = await this.prisma.device.findFirst({ where: { id: deviceId, userId } });
    if (!device) throw new ResourceNotFoundException('Device', deviceId);

    const sessions = await this.prisma.session.findMany({
      where: { deviceId, userId, isRevoked: false },
    });
    for (const session of sessions) {
      await this.sessionService.revokeSession(session.id, userId, 'admin_device_signout');
    }
    await this.prisma.device.update({
      where: { id: deviceId },
      data: { isRevoked: true, revokedAt: new Date() },
    });

    await this.auditLogService.log({
      actorId: admin.id,
      actorRole: admin.role,
      action: 'USER_DEVICE_REVOKED',
      resourceType: 'USER',
      resourceId: userId,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      metadata: { deviceId, sessionsRevoked: sessions.length },
    });

    return { message: `Signed out device (${sessions.length} sessions)`, deviceId };
  }

  // ── POST /v1/admin/users/:id/devices/:deviceId/untrust ─────────────────────

  @Post(':id/devices/:deviceId/untrust')
  @RequirePermissions(Permission.USERS_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove trust from a device' })
  async untrustDevice(
    @Param('id') userId: string,
    @Param('deviceId') deviceId: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Req() req: RequestWithUser,
  ) {
    const scope = await this.brokerScope.resolveScope(admin);
    await this.brokerScope.assertUserInScope(scope, userId);

    const device = await this.prisma.device.findFirst({ where: { id: deviceId, userId } });
    if (!device) throw new ResourceNotFoundException('Device', deviceId);

    await this.prisma.device.update({
      where: { id: deviceId },
      data: { trustLevel: 'UNKNOWN', trustScore: 50 },
    });

    await this.auditLogService.log({
      actorId: admin.id,
      actorRole: admin.role,
      action: 'USER_DEVICE_UNTRUSTED',
      resourceType: 'USER',
      resourceId: userId,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      metadata: { deviceId },
    });

    return { message: 'Device trust removed', deviceId };
  }
}
