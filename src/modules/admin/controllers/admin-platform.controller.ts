import { Body, Controller, Get, HttpCode, HttpStatus, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsNumber, Max, Min } from 'class-validator';
import { RequirePermissions } from '../../../core/decorators/require-permissions.decorator';
import { Permission } from '../../auth/constants/permissions.constant';
import { CurrentUser } from '../../../core/decorators/current-user.decorator';
import type { AuthenticatedUser, RequestWithUser } from '../../../core/types/request-context.types';
import { PlatformFeeService } from '../../brokers/services/platform-fee.service';
import { AdminFinanceService } from '../services/admin-finance.service';
import { AuditLogService } from '../../audit/services/audit-log.service';

class UpdatePlatformCommissionDto {
  /** Percent of each broker's commission that Pine earns (0–100). */
  @IsNumber() @Min(0) @Max(100)
  platformCommissionPct!: number;
}

/**
 * Super Admin → Platform settings & broker earnings.
 *
 * Pine's commission is a percentage of every broker's own commission,
 * frozen per trade at execution. Brokers see what they owe on their own
 * dashboard; Pine sees every broker's earnings and receivables here.
 */
@ApiTags('admin', 'platform')
@ApiBearerAuth()
@Controller('admin/platform')
@RequirePermissions(Permission.PLATFORM_ADMIN)
export class AdminPlatformController {
  constructor(
    private readonly platformFee: PlatformFeeService,
    private readonly finance: AdminFinanceService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @Get('commission')
  @ApiOperation({ summary: "Pine's platform commission rate" })
  getCommission() {
    return this.platformFee.getConfig();
  }

  @Put('commission')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set the platform commission rate (audited)' })
  async setCommission(
    @Body() dto: UpdatePlatformCommissionDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Req() req: RequestWithUser,
  ) {
    const before = await this.platformFee.getConfig();
    const after = await this.platformFee.setRate(dto.platformCommissionPct, admin.id);
    await this.auditLogService.log({
      actorId: admin.id,
      actorRole: admin.role,
      action: 'PLATFORM_COMMISSION_UPDATED',
      resourceType: 'PLATFORM_CONFIG',
      resourceId: 'default',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      metadata: { before: before.platformCommissionPct, after: after.platformCommissionPct },
    });
    return after;
  }

  @Get('brokers/earnings')
  @ApiOperation({ summary: "Every broker's commissions and what each owes Pine" })
  brokerEarnings() {
    return this.finance.brokerEarningsReport();
  }
}
