import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { MigratedInvestorStatus } from '@prisma/client';
import { RequirePermissions } from '../../../core/decorators/require-permissions.decorator';
import { Permission } from '../../auth/constants/permissions.constant';
import { CurrentUser } from '../../../core/decorators/current-user.decorator';
import { Public } from '../../../core/decorators/public.decorator';
import type { AuthenticatedUser } from '../../../core/types/request-context.types';
import { BrokerScopeService } from '../services/broker-scope.service';
import { InvestorMigrationService } from '../services/investor-migration.service';
import { AuditLogService } from '../../audit/services/audit-log.service';

class MigrationRowDto {
  @IsOptional() @IsString() @MaxLength(80)
  firstName?: string;

  @IsOptional() @IsString() @MaxLength(80)
  lastName?: string;

  @IsOptional() @IsString() @MaxLength(32)
  phone?: string;

  @IsOptional() @IsString() @MaxLength(160)
  email?: string;

  @IsOptional() @IsString() @MaxLength(40)
  dateOfBirth?: string;

  @IsOptional() @IsString() @MaxLength(20)
  gender?: string;

  @IsOptional() @IsObject()
  extra?: Record<string, unknown>;
}

class ImportInvestorsDto {
  @IsArray()
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => MigrationRowDto)
  rows!: MigrationRowDto[];
}

class InviteInvestorsDto {
  /** Omit to invite everyone not yet claimed. */
  @IsOptional() @IsArray() @ArrayMaxSize(5000) @IsString({ each: true })
  ids?: string[];
}

/**
 * Broker Dashboard → Settings → Migration.
 *
 * Brokers joining Pine already have a client book. This lets them upload it
 * (the sheet is parsed in the dashboard; the rows arrive here as JSON), then
 * email those clients an invitation to claim their account.
 *
 * The import creates invitations, never accounts: consent, a password and KYC
 * are the investor's to give, and no broker can supply them on their behalf.
 * Every route is scoped to the calling broker by requireBrokerActor.
 */
@ApiTags('admin', 'migration')
@ApiBearerAuth()
@Controller('admin/migration')
@RequirePermissions(Permission.ADMIN_ACCESS)
export class AdminMigrationController {
  constructor(
    private readonly brokerScope: BrokerScopeService,
    private readonly migration: InvestorMigrationService,
    private readonly audit: AuditLogService,
  ) {}

  @Get('investors')
  @ApiOperation({ summary: 'List investors imported from the broker’s previous system' })
  async list(
    @CurrentUser() admin: AuthenticatedUser,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const brokerId = await this.brokerScope.requireBrokerActor(admin);
    return this.migration.list(brokerId, {
      status: status ? (status as MigratedInvestorStatus) : undefined,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post('import')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Import parsed rows from a CSV or spreadsheet' })
  async import(
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: ImportInvestorsDto,
  ) {
    const brokerId = await this.brokerScope.requireBrokerActor(admin);
    const result = await this.migration.import(brokerId, admin.id, dto.rows);

    await this.audit.log({
      actorId: admin.id,
      action: 'INVESTOR_MIGRATION_IMPORT',
      resourceType: 'MigratedInvestor',
      resourceId: result.batchId,
      // The rows themselves are personal data and stay out of the audit trail;
      // the counts are what an auditor needs.
      metadata: {
        imported: result.imported,
        updated: result.updated,
        skipped: result.skipped,
        rows: dto.rows.length,
      },
    });

    return result;
  }

  @Post('invite')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Email imported investors an invitation to claim their account' })
  async invite(
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: InviteInvestorsDto,
  ) {
    const brokerId = await this.brokerScope.requireBrokerActor(admin);
    const result = await this.migration.invite(brokerId, dto.ids);

    await this.audit.log({
      actorId: admin.id,
      action: 'INVESTOR_MIGRATION_INVITE',
      resourceType: 'MigratedInvestor',
      metadata: {
        sent: result.sent,
        failed: result.failed,
        skippedNoEmail: result.skippedNoEmail,
      },
    });

    return result;
  }

  @Delete('investors/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel an invitation and revoke its link' })
  async cancel(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    const brokerId = await this.brokerScope.requireBrokerActor(admin);
    await this.migration.cancel(brokerId, id);

    await this.audit.log({
      actorId: admin.id,
      action: 'INVESTOR_MIGRATION_CANCEL',
      resourceType: 'MigratedInvestor',
      resourceId: id,
    });

    return { cancelled: true };
  }
}

class ClaimQueryDto {
  @IsString() @MaxLength(200)
  token!: string;
}

/**
 * Public counterpart: the mobile app exchanges an invitation token for the
 * details registration should pre-fill. No authentication — the token IS the
 * credential — and it returns nothing but that person's own details.
 */
@ApiTags('migration')
@Controller('migration')
export class MigrationClaimController {
  constructor(private readonly migration: InvestorMigrationService) {}

  @Public()
  @Get('claim')
  @ApiOperation({ summary: 'Resolve an invitation token to pre-fill registration' })
  async claim(@Query() query: ClaimQueryDto) {
    const details = await this.migration.resolveToken(query.token);
    // One answer for unknown, expired, cancelled and already-claimed alike:
    // distinguishing them would let someone probe for valid tokens.
    if (!details) {
      return { valid: false as const };
    }
    return { valid: true as const, ...details };
  }
}
