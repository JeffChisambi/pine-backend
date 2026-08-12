import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Put,
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
import { MobileThemeService } from '../services/mobile-theme.service';
import { UpdateMobileThemeDto } from '../dto/mobile-theme.dto';

/**
 * Admin (dashboard) "Mobile Themes" management.
 *
 *   GET   /v1/admin/mobile-theme        → active overrides + Pine defaults
 *   PUT   /v1/admin/mobile-theme        → set brand colors
 *   POST  /v1/admin/mobile-theme/reset  → reset to the Pine default
 */
@ApiTags('admin', 'mobile-theme')
@ApiBearerAuth()
@Controller('admin/mobile-theme')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class AdminMobileThemeController {
  constructor(
    private readonly service: MobileThemeService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @Get()
  @RequirePermissions(Permission.PLATFORM_ADMIN)
  @ApiOperation({ summary: 'Get the mobile theme (active + defaults)' })
  async get() {
    return this.service.getForAdmin();
  }

  @Put()
  @RequirePermissions(Permission.PLATFORM_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update the mobile brand theme' })
  async update(
    @Body() dto: UpdateMobileThemeDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Req() req: RequestWithUser,
  ) {
    const result = await this.service.update(dto, admin.id);
    await this.auditLogService.log({
      actorId: admin.id,
      actorRole: admin.role,
      action: 'MOBILE_THEME_UPDATED',
      resourceType: 'MOBILE_THEME',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      metadata: { colors: result.colors },
    });
    return result;
  }

  @Post('reset')
  @RequirePermissions(Permission.PLATFORM_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset the mobile theme to the Pine default' })
  async reset(
    @CurrentUser() admin: AuthenticatedUser,
    @Req() req: RequestWithUser,
  ) {
    const result = await this.service.reset();
    await this.auditLogService.log({
      actorId: admin.id,
      actorRole: admin.role,
      action: 'MOBILE_THEME_RESET',
      resourceType: 'MOBILE_THEME',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    return result;
  }
}
