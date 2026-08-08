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
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../../core/decorators/require-permissions.decorator';
import { Permission } from '../../auth/constants/permissions.constant';
import { CurrentUser } from '../../../core/decorators/current-user.decorator';
import type { AuthenticatedUser, RequestWithUser } from '../../../core/types/request-context.types';
import { AuditLogService } from '../../audit/services/audit-log.service';
import { SupportService } from '../services/support.service';
import {
  ListSupportTicketsQueryDto,
  ReplySupportTicketDto,
  UpdateSupportStatusDto,
} from '../dto/support.dto';

/**
 * AdminSupportController — the staff support inbox (Kusata dashboard).
 *
 *   GET   /v1/admin/support           → list tickets (filter by status / awaiting)
 *   GET   /v1/admin/support/stats     → inbox counts (badge)
 *   GET   /v1/admin/support/:id       → a ticket thread + customer info
 *   POST  /v1/admin/support/:id/messages → reply
 *   PATCH /v1/admin/support/:id/status   → change status
 */
@ApiTags('admin', 'support')
@ApiBearerAuth()
@Controller('admin/support')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class AdminSupportController {
  constructor(
    private readonly supportService: SupportService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @Get()
  @RequirePermissions(Permission.ADMIN_ACCESS)
  @ApiOperation({ summary: 'List support tickets' })
  async list(@Query() query: ListSupportTicketsQueryDto) {
    return this.supportService.listAdmin(query);
  }

  @Get('stats')
  @RequirePermissions(Permission.ADMIN_ACCESS)
  @ApiOperation({ summary: 'Support inbox counts' })
  async stats() {
    return this.supportService.stats();
  }

  @Get(':id')
  @RequirePermissions(Permission.ADMIN_ACCESS)
  @ApiOperation({ summary: 'Get a support ticket thread' })
  async thread(@Param('id') id: string) {
    return this.supportService.getAdminThread(id);
  }

  @Post(':id/messages')
  @RequirePermissions(Permission.ADMIN_ACCESS)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Reply to a support ticket' })
  async reply(
    @Param('id') id: string,
    @Body() dto: ReplySupportTicketDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Req() req: RequestWithUser,
  ) {
    const thread = await this.supportService.adminReply(admin.id, id, dto);
    await this.auditLogService.log({
      actorId: admin.id,
      actorRole: admin.role,
      action: 'SUPPORT_REPLIED',
      resourceType: 'SUPPORT_TICKET',
      resourceId: id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      metadata: { reference: thread.reference },
    });
    return thread;
  }

  @Patch(':id/status')
  @RequirePermissions(Permission.ADMIN_ACCESS)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Change a support ticket status' })
  async setStatus(
    @Param('id') id: string,
    @Body() dto: UpdateSupportStatusDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Req() req: RequestWithUser,
  ) {
    const thread = await this.supportService.updateStatus(admin.id, id, dto.status);
    await this.auditLogService.log({
      actorId: admin.id,
      actorRole: admin.role,
      action: 'SUPPORT_STATUS_CHANGED',
      resourceType: 'SUPPORT_TICKET',
      resourceId: id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      metadata: { reference: thread.reference, status: dto.status },
    });
    return thread;
  }
}
