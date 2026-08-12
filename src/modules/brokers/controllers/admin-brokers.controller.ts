import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../../core/decorators/roles.decorator';
import { Role } from '../../../core/constants/roles.constant';
import { RequirePermissions } from '../../../core/decorators/require-permissions.decorator';
import { Permission } from '../../auth/constants/permissions.constant';
import { CurrentUser } from '../../../core/decorators/current-user.decorator';
import type { AuthenticatedUser, RequestWithUser } from '../../../core/types/request-context.types';
import { BrokerService } from '../services/broker.service';
import { BrokerAdminService } from '../services/broker-admin.service';
import { BrokerPaymentConfigService } from '../services/broker-payment-config.service';
import {
  CreateBrokerDto,
  InviteBrokerAdminDto,
  UpdateBrokerDto,
  UpdateBrokerStatusDto,
  UpsertBrokerApiConfigDto,
  UpsertBrokerPaymentConfigDto,
} from '../dto/broker.dto';

/**
 * Super Admin broker tenant management. Defense in depth: BOTH the
 * SUPER_ADMIN role and the BROKERS_MANAGE permission are required, so a
 * Broker Admin can never reach these endpoints — even with a manually
 * constructed request — regardless of any frontend state.
 */
@ApiTags('admin', 'brokers')
@ApiBearerAuth()
@Roles(Role.SUPER_ADMIN)
@RequirePermissions(Permission.BROKERS_MANAGE)
@Controller('admin/brokers')
export class AdminBrokersController {
  constructor(
    private readonly brokerService: BrokerService,
    private readonly brokerAdminService: BrokerAdminService,
    private readonly paymentConfigService: BrokerPaymentConfigService,
  ) {}

  // ── Broker CRUD ───────────────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: 'List all brokers with status + user counts' })
  async listBrokers() {
    return this.brokerService.listBrokers();
  }

  @Post()
  @ApiOperation({ summary: 'Create a broker' })
  async createBroker(
    @Body() dto: CreateBrokerDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Req() req: RequestWithUser,
  ) {
    return this.brokerService.createBroker(dto, admin, req.ip);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Broker detail: info, admins, integration status' })
  async getBroker(@Param('id', ParseUUIDPipe) id: string) {
    return this.brokerService.getBroker(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit broker information' })
  async updateBroker(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBrokerDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Req() req: RequestWithUser,
  ) {
    return this.brokerService.updateBroker(id, dto, admin, req.ip);
  }

  @Patch(':id/status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Activate/deactivate a broker' })
  async setBrokerStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBrokerStatusDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Req() req: RequestWithUser,
  ) {
    return this.brokerService.setBrokerStatus(id, dto.isActive, admin, req.ip);
  }

  @Get(':id/users')
  @ApiOperation({ summary: 'Investors associated with this broker' })
  async listBrokerUsers(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.brokerService.listBrokerUsers(
      id,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 50,
    );
  }

  // ── Broker administrators ─────────────────────────────────────────

  @Post(':id/admins')
  @ApiOperation({
    summary: 'Create a broker administrator account (secure invitation flow)',
    description:
      'Creates an inactive BROKER-role account and returns a one-time invitation token. ' +
      'No password is generated or displayed. The invitee sets their own password on ' +
      'activation and must enroll in MFA on first login.',
  })
  async inviteBrokerAdmin(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: InviteBrokerAdminDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Req() req: RequestWithUser,
  ) {
    return this.brokerAdminService.inviteBrokerAdmin(id, dto, admin, req.ip);
  }

  @Post(':id/admins/:adminId/reinvite')
  @ApiOperation({ summary: 'Re-issue an invitation for a not-yet-activated broker admin' })
  async reinviteBrokerAdmin(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('adminId', ParseUUIDPipe) adminId: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Req() req: RequestWithUser,
  ) {
    return this.brokerAdminService.reinviteBrokerAdmin(id, adminId, admin, req.ip);
  }

  // ── Payment configuration ─────────────────────────────────────────

  @Get(':id/payment-config')
  @ApiOperation({
    summary: 'Broker payment configuration (masked — secrets are never returned)',
  })
  async getPaymentConfig(@Param('id', ParseUUIDPipe) id: string) {
    return this.paymentConfigService.getMaskedConfig(id);
  }

  @Put(':id/payment-config')
  @ApiOperation({
    summary: 'Configure the broker payment integration',
    description:
      'Secrets (gateway API password, settlement account number) are write-only: ' +
      'encrypted at rest and never returned after saving. Changes are audit-logged.',
  })
  async upsertPaymentConfig(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpsertBrokerPaymentConfigDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Req() req: RequestWithUser,
  ) {
    return this.paymentConfigService.upsertConfig(id, dto, admin, req.ip);
  }

  // ── API configuration ─────────────────────────────────────────────

  @Get(':id/api-config')
  @ApiOperation({ summary: 'Broker API endpoint configurations (masked)' })
  async listApiConfigs(@Param('id', ParseUUIDPipe) id: string) {
    return this.paymentConfigService.listApiConfigs(id);
  }

  @Put(':id/api-config')
  @ApiOperation({ summary: 'Create/update a broker API endpoint configuration' })
  async upsertApiConfig(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpsertBrokerApiConfigDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Req() req: RequestWithUser,
  ) {
    return this.paymentConfigService.upsertApiConfig(id, dto, admin, req.ip);
  }
}
