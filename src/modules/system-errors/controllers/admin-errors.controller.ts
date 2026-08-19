import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../../core/decorators/require-permissions.decorator';
import { Permission } from '../../auth/constants/permissions.constant';
import { CurrentUser } from '../../../core/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../../core/types/request-context.types';
import { SystemErrorService } from '../services/system-error.service';

/**
 * Admin System Errors console — platform admins see errors from every
 * surface (mobile / broker dashboard / admin dashboard / backend), sorted
 * open-first by recency, so issues are addressed before they're reported.
 * PLATFORM_ADMIN permission = SUPER_ADMIN only; broker admins never see
 * other surfaces' failures.
 */
@ApiTags('admin', 'errors')
@ApiBearerAuth()
@Controller('admin/errors')
@RequirePermissions(Permission.PLATFORM_ADMIN)
export class AdminErrorsController {
  constructor(private readonly errors: SystemErrorService) {}

  @Get()
  @ApiOperation({ summary: 'List system errors with filters' })
  @ApiResponse({ status: 200, description: 'Paginated error events' })
  async list(
    @Query('source') source?: string,
    @Query('severity') severity?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.errors.list({
      source: source?.toUpperCase(),
      severity: severity?.toUpperCase(),
      status: status?.toUpperCase(),
      page: parseInt(page ?? '1', 10) || 1,
      limit: parseInt(limit ?? '50', 10) || 50,
    });
  }

  @Get('stats')
  @ApiOperation({ summary: 'Open-error counts by severity and source' })
  async stats() {
    return this.errors.stats();
  }

  @Patch(':id/resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark an error as resolved' })
  async resolve(@Param('id') id: string, @CurrentUser() admin: AuthenticatedUser) {
    return this.errors.resolve(id, admin.id);
  }
}
