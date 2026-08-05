import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../../core/decorators/require-permissions.decorator';
import { Permission } from '../../auth/constants/permissions.constant';
import { CurrentUser } from '../../../core/decorators/current-user.decorator';
import type { AuthenticatedUser, RequestWithUser } from '../../../core/types/request-context.types';
import { AdminRepository } from '../repositories/admin.repository';
import { AuditLogService } from '../../audit/services/audit-log.service';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { BroadcastNotificationDto } from '../dto/admin.dto';

@ApiTags('admin', 'notifications')
@ApiBearerAuth()
@Controller('admin/notifications')
export class AdminNotificationsController {
  constructor(
    private readonly adminRepo: AdminRepository,
    private readonly auditLogService: AuditLogService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @RequirePermissions(Permission.ADMIN_ACCESS)
  @ApiOperation({ summary: 'List all notifications with filters' })
  @ApiQuery({ name: 'status', required: false, type: String })
  @ApiQuery({ name: 'channel', required: false, type: String })
  @ApiQuery({ name: 'category', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Paginated notification list' })
  async listNotifications(
    @Query('status') status?: string,
    @Query('channel') channel?: string,
    @Query('category') category?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.adminRepo.listNotifications({
      status,
      channel,
      category,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 50,
    });
  }

  @Get('stats')
  @RequirePermissions(Permission.ADMIN_ACCESS)
  @ApiOperation({ summary: 'Notification delivery statistics' })
  @ApiResponse({ status: 200, description: 'Stats by status and channel' })
  async getStats() {
    return this.adminRepo.getNotificationStats();
  }

  @Post('broadcast')
  @RequirePermissions(Permission.ADMIN_ACCESS)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Broadcast notification to users',
    description: 'Send a notification to all users or a filtered subset by role.',
  })
  @ApiResponse({ status: 201, description: 'Broadcast queued' })
  async broadcast(
    @Body() dto: BroadcastNotificationDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Req() req: RequestWithUser,
  ) {
    // Find target users
    const where: Record<string, unknown> = { isActive: true };
    if (dto.targetRole) {
      where.role = dto.targetRole;
    }

    const users = await this.prisma.user.findMany({
      where,
      select: { id: true },
    });

    const channel = (dto.channel ?? 'IN_APP') as 'PUSH' | 'EMAIL' | 'SMS' | 'IN_APP';
    // Broker-authored broadcasts default to ANNOUNCEMENT so the dashboard can
    // distinguish them from platform-generated SYSTEM notifications.
    const category = dto.category ?? 'ANNOUNCEMENT';

    // ALWAYS create the IN_APP inbox row — the mobile app's notification list
    // reads channel IN_APP only, so PUSH/EMAIL/SMS-channel broadcasts written
    // without one were invisible in the app (root cause of "dashboard
    // notifications never reach the mobile app"). The chosen channel is
    // recorded as an additional delivery row when it isn't IN_APP.
    const inAppRows = users.map((u) => ({
      userId: u.id,
      channel: 'IN_APP' as const,
      title: dto.title,
      body: dto.body,
      type: 'INFORMATIONAL' as const,
      priority: 2,
      category,
      status: 'SENT' as const,
      sentAt: new Date(),
    }));

    const result = await this.prisma.notification.createMany({ data: inAppRows });

    if (channel !== 'IN_APP') {
      // Secondary delivery-channel rows (push/email/sms pipelines pick these up)
      await this.prisma.notification.createMany({
        data: users.map((u) => ({
          userId: u.id,
          channel,
          title: dto.title,
          body: dto.body,
          type: 'INFORMATIONAL' as const,
          priority: 2,
          category,
          status: 'QUEUED' as const,
        })),
      });
    }

    await this.auditLogService.log({
      actorId: admin.id,
      actorRole: admin.role,
      action: 'NOTIFICATION_BROADCAST',
      resourceType: 'NOTIFICATION',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      metadata: {
        title: dto.title,
        channel,
        category,
        targetRole: dto.targetRole ?? 'ALL',
        recipientCount: result.count,
      },
    });

    return {
      message: 'Broadcast queued',
      recipientCount: result.count,
    };
  }
}
