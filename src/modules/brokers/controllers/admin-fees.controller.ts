import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Put,
  Query,
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
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { RequirePermissions } from '../../../core/decorators/require-permissions.decorator';
import { Permission } from '../../auth/constants/permissions.constant';
import { CurrentUser } from '../../../core/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../../core/types/request-context.types';
import { BrokerScopeService } from '../services/broker-scope.service';
import { FeePolicyService } from '../services/fee-policy.service';
import { ValidationException } from '../../../core/exceptions/app.exception';
import { calculateTradingFees } from '../../trading/domain/trading-fee.calculator';

class CommissionTierDto {
  @IsNumber() @Min(0)
  minAmount!: number;

  @IsOptional() @IsNumber() @Min(0)
  maxAmount?: number | null;

  @IsNumber() @Min(0) @Max(100)
  ratePct!: number;

  @IsOptional() @IsNumber() @Min(0)
  minFee?: number;
}

class UpdateFeeConfigDto {
  @IsBoolean()
  depositFeeEnabled!: boolean;

  @IsIn(['FIXED', 'PERCENT'])
  depositFeeKind!: 'FIXED' | 'PERCENT';

  @IsNumber() @Min(0)
  depositFeeValue!: number;

  @IsOptional() @IsString() @MaxLength(300)
  depositFeeDescription?: string;

  @IsBoolean()
  commissionEnabled!: boolean;

  @IsArray() @ValidateNested({ each: true }) @Type(() => CommissionTierDto)
  commissionTiers!: CommissionTierDto[];

  /**
   * Statutory levies, percent of gross trade value. Capped at 100 like any
   * other rate; omitted fields keep whatever is already stored, so an older
   * client cannot silently zero a levy it does not know about.
   */
  @IsOptional() @IsNumber() @Min(0) @Max(100)
  secLevyPct?: number;

  @IsOptional() @IsNumber() @Min(0) @Max(100)
  mseLevyPct?: number;

  @IsOptional() @IsNumber() @Min(0) @Max(100)
  withholdingTaxPct?: number;
}

/**
 * Broker Dashboard → Settings → Fees & Charges.
 *
 * Broker admins configure THEIR OWN fee schedule: the deposit processing fee
 * (a payment cost), tiered trading commissions (broker revenue), and the
 * statutory levies they collect and remit (never their revenue).
 * Every change takes effect immediately across mobile and dashboard —
 * both consume FeePolicyService, so there is exactly one fee authority.
 */
@ApiTags('admin', 'fees')
@ApiBearerAuth()
@Controller('admin/fees')
@RequirePermissions(Permission.ADMIN_ACCESS)
export class AdminFeesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly brokerScope: BrokerScopeService,
    private readonly feePolicy: FeePolicyService,
  ) {}

  @Get('config')
  @ApiOperation({ summary: "Read the broker's fee configuration (with defaults)" })
  async getConfig(@CurrentUser() admin: AuthenticatedUser) {
    const brokerId = await this.brokerScope.requireBrokerActor(admin);
    const policy = await this.feePolicy.forBroker(brokerId);
    return {
      brokerId,
      depositFeeEnabled: policy.depositFeeEnabled,
      depositFeeKind: policy.depositFeeKind,
      depositFeeValue: policy.depositFeeValue.toNumber(),
      depositFeeDescription: policy.depositFeeDescription,
      commissionEnabled: policy.commissionEnabled,
      commissionTiers: policy.commissionTiers,
      statutory: {
        secLevyPct: policy.statutoryLevies.secPct,
        mseLevyPct: policy.statutoryLevies.msePct,
        withholdingTaxPct: policy.statutoryLevies.withholdingPct,
      },
    };
  }

  @Put('config')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Update the broker's fee configuration" })
  async updateConfig(
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: UpdateFeeConfigDto,
  ) {
    const brokerId = await this.brokerScope.requireBrokerActor(admin);
    this.validateTiers(dto.commissionTiers);

    // Only write the levies the client actually sent — see the DTO comment.
    const levies = {
      ...(dto.secLevyPct != null ? { secLevyPct: dto.secLevyPct } : {}),
      ...(dto.mseLevyPct != null ? { mseLevyPct: dto.mseLevyPct } : {}),
      ...(dto.withholdingTaxPct != null
        ? { withholdingTaxPct: dto.withholdingTaxPct }
        : {}),
    };

    await this.prisma.brokerFeeConfig.upsert({
      where: { brokerId },
      create: {
        brokerId,
        depositFeeEnabled: dto.depositFeeEnabled,
        depositFeeKind: dto.depositFeeKind,
        depositFeeValue: dto.depositFeeValue,
        depositFeeDescription: dto.depositFeeDescription ?? null,
        commissionEnabled: dto.commissionEnabled,
        commissionTiers: dto.commissionTiers as any,
        ...levies,
      },
      update: {
        depositFeeEnabled: dto.depositFeeEnabled,
        depositFeeKind: dto.depositFeeKind,
        depositFeeValue: dto.depositFeeValue,
        depositFeeDescription: dto.depositFeeDescription ?? null,
        commissionEnabled: dto.commissionEnabled,
        commissionTiers: dto.commissionTiers as any,
        ...levies,
      },
    });
    this.feePolicy.invalidate(brokerId);
    return this.getConfig(admin);
  }

  @Get('preview')
  @ApiOperation({ summary: 'Preview fees for an amount under the current config' })
  async preview(
    @CurrentUser() admin: AuthenticatedUser,
    @Query('amount') amountStr?: string,
  ) {
    const brokerId = await this.brokerScope.requireBrokerActor(admin);
    const amount = new Decimal(amountStr || '0');
    const policy = await this.feePolicy.forBroker(brokerId);

    const deposit = this.feePolicy.depositBreakdown(policy, amount);
    const buy = calculateTradingFees(
      amount,
      new Decimal(1),
      'BUY',
      { tiers: policy.commissionTiers, enabled: policy.commissionEnabled },
      policy.statutoryLevies,
    );
    return {
      deposit: {
        grossAmount: deposit.grossAmount.toNumber(),
        processingFee: deposit.processingFee.toNumber(),
        netAmount: deposit.netAmount.toNumber(),
      },
      buy: {
        grossValue: buy.grossValue.toNumber(),
        commission: buy.brokerCommission.toNumber(),
        levies: buy.secLevy.add(buy.mseLevy).toNumber(),
        totalCost: buy.totalCost.toNumber(),
      },
    };
  }

  private validateTiers(tiers: CommissionTierDto[]): void {
    if (tiers.length === 0) return;
    const sorted = [...tiers].sort((a, b) => a.minAmount - b.minAmount);
    for (let i = 0; i < sorted.length; i++) {
      const t = sorted[i];
      if (t.maxAmount != null && t.maxAmount <= t.minAmount) {
        throw new ValidationException(
          `Tier ${i + 1}: maximum amount must be greater than minimum amount.`,
        );
      }
      if (i < sorted.length - 1) {
        const next = sorted[i + 1];
        if (t.maxAmount == null) {
          throw new ValidationException(
            `Tier ${i + 1}: only the last tier may be open-ended.`,
          );
        }
        // Ranges are half-open [min, max): the next tier may START exactly
        // where this one ends ("0–100,000" then "100,000+" is contiguous).
        if (next.minAmount < t.maxAmount) {
          throw new ValidationException(
            `Tiers ${i + 1} and ${i + 2} overlap — ranges must not intersect.`,
          );
        }
      }
    }
  }
}
