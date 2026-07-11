import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../../core/decorators/require-permissions.decorator';
import { Permission } from '../../auth/constants/permissions.constant';
import { AuditRepository, type AuditSearchFilters } from '../repositories/audit.repository';

@ApiTags('admin', 'audit')
@ApiBearerAuth()
@Controller('admin/audit')
export class AuditController {
  constructor(private readonly repository: AuditRepository) {}

  @Get()
  @RequirePermissions(Permission.AUDIT_VIEW)
  @ApiOperation({
    summary: 'Search audit logs',
    description: 'Paginated, filterable audit log search for compliance and review.',
  })
  @ApiQuery({ name: 'actorId', required: false, type: String })
  @ApiQuery({ name: 'action', required: false, type: String })
  @ApiQuery({ name: 'resourceType', required: false, type: String })
  @ApiQuery({ name: 'resourceId', required: false, type: String })
  @ApiQuery({ name: 'dateFrom', required: false, type: String })
  @ApiQuery({ name: 'dateTo', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Paginated audit logs' })
  async search(
    @Query('actorId') actorId?: string,
    @Query('action') action?: string,
    @Query('resourceType') resourceType?: string,
    @Query('resourceId') resourceId?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const filters: AuditSearchFilters = {
      actorId,
      action,
      resourceType,
      resourceId,
      dateFrom: dateFrom ? new Date(dateFrom) : undefined,
      dateTo: dateTo ? new Date(dateTo) : undefined,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 50,
    };

    return this.repository.search(filters);
  }

  @Get('resource')
  @RequirePermissions(Permission.AUDIT_VIEW)
  @ApiOperation({
    summary: 'Get audit trail for a specific resource',
    description: 'Returns all audit entries for a given resource type and ID.',
  })
  @ApiQuery({ name: 'type', required: true, type: String })
  @ApiQuery({ name: 'id', required: true, type: String })
  @ApiResponse({ status: 200, description: 'Resource audit trail' })
  async getResourceAuditTrail(
    @Query('type') resourceType: string,
    @Query('id') resourceId: string,
  ) {
    const logs = await this.repository.findByResource(resourceType, resourceId);
    return { logs, count: logs.length };
  }
}
