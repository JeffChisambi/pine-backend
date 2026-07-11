import {
  Body,
  Controller,
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
import { ResourceNotFoundException } from '../../../core/exceptions/app.exception';

@ApiTags('admin', 'users')
@ApiBearerAuth()
@Controller('admin/users')
export class AdminUsersController {
  constructor(
    private readonly adminRepo: AdminRepository,
    private readonly auditLogService: AuditLogService,
    private readonly prisma: PrismaService,
    private readonly sessionService: SessionService,
  ) {}

  @Get()
  @RequirePermissions(Permission.USERS_READ)
  @ApiOperation({ summary: 'List all users with filters' })
  @ApiResponse({ status: 200, description: 'Paginated user list' })
  async listUsers(@Query() query: ListUsersQueryDto) {
    return this.adminRepo.listUsers({
      search: query.search,
      status: query.status,
      kycStatus: query.kycStatus,
      role: query.role,
      page: query.page,
      limit: query.limit,
    });
  }

  @Get(':id')
  @RequirePermissions(Permission.USERS_READ)
  @ApiOperation({
    summary: 'Get full user workspace',
    description: 'Profile + wallet + KYC + devices + sessions + holdings in one call.',
  })
  @ApiResponse({ status: 200, description: 'User workspace' })
  async getUserWorkspace(@Param('id') userId: string) {
    const user = await this.adminRepo.getUserWorkspace(userId);
    if (!user) {
      throw new ResourceNotFoundException('User', userId);
    }
    return user;
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
  async getUserDevices(@Param('id') userId: string) {
    const devices = await this.prisma.device.findMany({
      where: { userId },
      orderBy: { lastSeenAt: 'desc' },
    });
    return { devices };
  }

  @Get(':id/sessions')
  @RequirePermissions(Permission.USERS_READ)
  @ApiOperation({ summary: 'List user active sessions' })
  async getUserSessions(@Param('id') userId: string) {
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
}
