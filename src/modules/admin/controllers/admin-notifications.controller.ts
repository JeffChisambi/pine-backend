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
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../../core/decorators/require-permissions.decorator';
import { Permission } from '../../auth/constants/permissions.constant';
import { CurrentUser } from '../../../core/decorators/current-user.decorator';
import type { AuthenticatedUser, RequestWithUser } from '../../../core/types/request-context.types';
import { AdminRepository } from '../repositories/admin.repository';
import { AuditLogService } from '../../audit/services/audit-log.service';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { BroadcastNotificationDto } from '../dto/admin.dto';
import { BrokerScopeService } from '../../brokers/services/broker-scope.service';
import { ResourceNotFoundException } from '../../../core/exceptions/app.exception';

@ApiTags('admin', 'notifications')
@ApiBearerAuth()
@Controller('admin/notifications')
export class AdminNotificationsController {
  constructor(
    private readonly adminRepo: AdminRepository,
    private readonly auditLogService: AuditLogService,
    private readonly prisma: PrismaService,
    private readonly brokerScope: BrokerScopeService,
  ) {}

  @Get()
  @RequirePermissions(Permission.ADMIN_ACCESS)
  @ApiOperation({ summary: 'List notifications (broker admins: own broker only)' })
  @ApiQuery({ name: 'status', required: false, type: String })
  @ApiQuery({ name: 'channel', required: false, type: String })
  @ApiQuery({ name: 'category', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Paginated notification list' })
  async listNotifications(
    @CurrentUser() admin: AuthenticatedUser,
    @Query('status') status?: string,
    @Query('channel') channel?: string,
    @Query('category') category?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const scope = await this.brokerScope.resolveScope(admin);
    return this.adminRepo.listNotifications(
      {
        status,
        channel,
        category,
        page: page ? parseInt(page, 10) : 1,
        limit: limit ? parseInt(limit, 10) : 50,
      },
      scope,
    );
  }

  @Get('stats')
  @RequirePermissions(Permission.ADMIN_ACCESS)
  @ApiOperation({ summary: 'Notification delivery statistics' })
  @ApiResponse({ status: 200, description: 'Stats by status and channel' })
  async getStats(@CurrentUser() admin: AuthenticatedUser) {
    const scope = await this.brokerScope.resolveScope(admin);
    return this.adminRepo.getNotificationStats(scope);
  }

  /**
   * Mark every notification in the caller's scope as read. Broker admins only
   * touch rows belonging to their own investors; platform staff see all.
   * Must be declared before `:id/read` so "read-all" is not captured as an id.
   */
  @Patch('read-all')
  @RequirePermissions(Permission.ADMIN_ACCESS)
  @ApiOperation({ summary: 'Mark all notifications in scope as read' })
  @ApiResponse({ status: 200, description: 'Count of notifications updated' })
  async markAllRead(@CurrentUser() admin: AuthenticatedUser) {
    const scope = await this.brokerScope.resolveScope(admin);
    const result = await this.prisma.notification.updateMany({
      where: {
        status: { not: 'READ' },
        ...(scope ? { user: { brokerId: scope } } : {}),
      },
      data: { status: 'READ', readAt: new Date() },
    });
    return { updated: result.count };
  }

  /** Mark one notification as read — 404 when it is outside the caller's scope. */
  @Patch(':id/read')
  @RequirePermissions(Permission.ADMIN_ACCESS)
  @ApiOperation({ summary: 'Mark a notification as read' })
  @ApiParam({ name: 'id', description: 'Notification id' })
  @ApiResponse({ status: 200, description: 'Updated notification' })
  async markRead(@Param('id') id: string, @CurrentUser() admin: AuthenticatedUser) {
    const scope = await this.brokerScope.resolveScope(admin);
    const existing = await this.prisma.notification.findFirst({
      where: { id, ...(scope ? { user: { brokerId: scope } } : {}) },
      select: { id: true, status: true },
    });
    if (!existing) throw new ResourceNotFoundException('Notification', id);
    if (existing.status === 'READ') return { id, status: 'READ' as const };

    const updated = await this.prisma.notification.update({
      where: { id },
      data: { status: 'READ', readAt: new Date() },
      select: { id: true, status: true, readAt: true },
    });
    return updated;
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
    // Find target users. Broker admins may only broadcast to THEIR OWN
    // investors — the scope comes from the server-side broker relationship,
    // never from the request.
    const scope = await this.brokerScope.resolveScope(admin);
    const where: Record<string, unknown> = { isActive: true };
    if (scope) {
      where.brokerId = scope;
      where.role = 'CUSTOMER';
    } else if (dto.targetRole) {
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
