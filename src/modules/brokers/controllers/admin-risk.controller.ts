import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Put,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { RequirePermissions } from '../../../core/decorators/require-permissions.decorator';
import { Permission } from '../../auth/constants/permissions.constant';
import { CurrentUser } from '../../../core/decorators/current-user.decorator';
import type { AuthenticatedUser, RequestWithUser } from '../../../core/types/request-context.types';
import { BrokerScopeService } from '../services/broker-scope.service';
import { RiskPolicyService } from '../services/risk-policy.service';
import { AuditLogService } from '../../audit/services/audit-log.service';
import { ValidationException } from '../../../core/exceptions/app.exception';

class DepositRuleDto {
  @IsString() @MaxLength(60)
  id!: string;

  @IsOptional() @IsString() @MaxLength(120)
  label?: string;

  @IsBoolean()
  enabled!: boolean;

  @IsOptional() @IsIn(['CARD', 'BANK', 'MOBILE_MONEY', null] as any)
  method?: 'CARD' | 'BANK' | 'MOBILE_MONEY' | null;

  @IsOptional() @IsIn(['APPROVED', 'PENDING', 'NOT_SUBMITTED', 'REJECTED', null] as any)
  kycStatus?: string | null;

  @IsOptional() @IsNumber() @Min(0)
  perTransactionMax?: number | null;

  @IsOptional() @IsNumber() @Min(0)
  dailyMax?: number | null;

  @IsOptional() @IsNumber() @Min(0)
  monthlyMax?: number | null;

  @IsOptional() @IsNumber() @Min(1)
  velocityMaxCount?: number | null;

  @IsOptional() @IsNumber() @Min(1)
  velocityWindowMinutes?: number | null;
}

class UpdateRiskConfigDto {
  @IsBoolean()
  concentrationEnabled!: boolean;

  @IsNumber() @Min(1) @Max(100)
  maxPositionPct!: number;

  @IsOptional() @IsNumber() @Min(1) @Max(100)
  warnPositionPct?: number | null;

  @IsArray() @ValidateNested({ each: true }) @Type(() => DepositRuleDto)
  depositRules!: DepositRuleDto[];
}

/**
 * Broker Dashboard → Settings → Risk & Limits.
 *
 * Broker admins configure THEIR OWN risk constraints (portfolio
 * concentration + deposit limits). The mobile app never defines limits —
 * it only displays what this configuration enforces server-side. Every
 * change is audited with the before/after configuration.
 */
@ApiTags('admin', 'risk')
@ApiBearerAuth()
@Controller('admin/risk')
@RequirePermissions(Permission.ADMIN_ACCESS)
export class AdminRiskController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly brokerScope: BrokerScopeService,
    private readonly riskPolicy: RiskPolicyService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @Get('config')
  @ApiOperation({ summary: "Read the broker's risk constraint configuration" })
  async getConfig(@CurrentUser() admin: AuthenticatedUser) {
    const brokerId = await this.brokerScope.requireBrokerActor(admin);
    const policy = await this.riskPolicy.forBroker(brokerId);
    return {
      brokerId,
      concentrationEnabled: policy.concentrationEnabled,
      maxPositionPct: policy.maxPositionPct.toNumber(),
      warnPositionPct: policy.warnPositionPct?.toNumber() ?? null,
      depositRules: policy.depositRules,
    };
  }

  @Put('config')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Update the broker's risk constraint configuration (audited)" })
  async updateConfig(
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: UpdateRiskConfigDto,
    @Req() req: RequestWithUser,
  ) {
    const brokerId = await this.brokerScope.requireBrokerActor(admin);
    this.validateConfig(dto);

    const before = await this.riskPolicy.forBroker(brokerId);

    await this.prisma.brokerRiskConfig.upsert({
      where: { brokerId },
      create: {
        brokerId,
        concentrationEnabled: dto.concentrationEnabled,
        maxPositionPct: dto.maxPositionPct,
        warnPositionPct: dto.warnPositionPct ?? null,
        depositRules: dto.depositRules as any,
      },
      update: {
        concentrationEnabled: dto.concentrationEnabled,
        maxPositionPct: dto.maxPositionPct,
        warnPositionPct: dto.warnPositionPct ?? null,
        depositRules: dto.depositRules as any,
      },
    });
    this.riskPolicy.invalidate(brokerId);

    await this.auditLogService.log({
      actorId: admin.id,
      actorRole: admin.role,
      action: 'RISK_CONFIG_UPDATED',
      resourceType: 'BROKER_RISK_CONFIG',
      resourceId: brokerId,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      metadata: {
        before: {
          concentrationEnabled: before.concentrationEnabled,
          maxPositionPct: before.maxPositionPct.toNumber(),
          warnPositionPct: before.warnPositionPct?.toNumber() ?? null,
          depositRules: before.depositRules,
        },
        after: {
          concentrationEnabled: dto.concentrationEnabled,
          maxPositionPct: dto.maxPositionPct,
          warnPositionPct: dto.warnPositionPct ?? null,
          depositRules: dto.depositRules,
        },
      },
    });

    return this.getConfig(admin);
  }

  private validateConfig(dto: UpdateRiskConfigDto): void {
    if (
      dto.warnPositionPct != null &&
      dto.concentrationEnabled &&
      dto.warnPositionPct >= dto.maxPositionPct
    ) {
      throw new ValidationException(
        'The warning threshold must be below the maximum position limit.',
      );
    }
    const seen = new Set<string>();
    for (const [i, r] of dto.depositRules.entries()) {
      if (seen.has(r.id)) {
        throw new ValidationException(`Deposit rule ${i + 1}: duplicate rule id.`);
      }
      seen.add(r.id);
      const hasAnyBound =
        r.perTransactionMax != null || r.dailyMax != null || r.monthlyMax != null ||
        (r.velocityMaxCount != null && r.velocityWindowMinutes != null);
      if (!hasAnyBound) {
        throw new ValidationException(
          `Deposit rule ${i + 1}: set at least one limit (per-transaction, daily, monthly, or velocity).`,
        );
      }
      if ((r.velocityMaxCount != null) !== (r.velocityWindowMinutes != null)) {
        throw new ValidationException(
          `Deposit rule ${i + 1}: velocity needs BOTH a count and a window.`,
        );
      }
      if (r.dailyMax != null && r.monthlyMax != null && r.monthlyMax < r.dailyMax) {
        throw new ValidationException(
          `Deposit rule ${i + 1}: the monthly limit cannot be below the daily limit.`,
        );
      }
    }
  }
}
