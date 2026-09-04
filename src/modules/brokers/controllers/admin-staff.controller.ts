import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsString,
  MaxLength,
} from 'class-validator';
import { RequirePermissions } from '../../../core/decorators/require-permissions.decorator';
import { Permission } from '../../auth/constants/permissions.constant';
import { CurrentUser } from '../../../core/decorators/current-user.decorator';
import type { AuthenticatedUser, RequestWithUser } from '../../../core/types/request-context.types';
import { BrokerScopeService } from '../services/broker-scope.service';
import { BrokerStaffService } from '../services/broker-staff.service';
import { DASHBOARD_SECTIONS } from '../staff/dashboard-sections';

class InviteStaffDto {
  @IsEmail()
  email!: string;

  @IsString() @IsNotEmpty() @MaxLength(80)
  firstName!: string;

  @IsString() @IsNotEmpty() @MaxLength(80)
  lastName!: string;

  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @IsString({ each: true })
  sections!: string[];
}

class UpdateSectionsDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @IsString({ each: true })
  sections!: string[];
}

class SetActiveDto {
  @IsBoolean()
  isActive!: boolean;
}

/**
 * Broker Dashboard → Settings → Staff.
 *
 * A broker administrator invites colleagues and chooses which sections of
 * the dashboard each may use. Every route requires a broker actor who is an
 * administrator — staff members cannot manage other staff.
 *
 * Lives under /admin/staff, which StaffSectionGuard maps to 'settings'; the
 * requireManager check inside is what actually keeps staff out.
 */
@ApiTags('admin', 'staff')
@ApiBearerAuth()
@Controller('admin/staff')
@RequirePermissions(Permission.ADMIN_ACCESS)
export class AdminStaffController {
  constructor(
    private readonly brokerScope: BrokerScopeService,
    private readonly staff: BrokerStaffService,
  ) {}

  @Get('sections')
  @ApiOperation({ summary: 'The sections a staff member can be granted' })
  sections() {
    return { sections: DASHBOARD_SECTIONS };
  }

  @Get()
  @ApiOperation({ summary: 'List this broker’s staff accounts' })
  async list(@CurrentUser() admin: AuthenticatedUser) {
    const brokerId = await this.brokerScope.requireBrokerActor(admin);
    await this.staff.requireManager(admin.id, brokerId);
    return this.staff.list(brokerId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Invite a staff member with a temporary password' })
  async invite(
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: InviteStaffDto,
    @Req() req: RequestWithUser,
  ) {
    const brokerId = await this.brokerScope.requireBrokerActor(admin);
    await this.staff.requireManager(admin.id, brokerId);
    return this.staff.invite(brokerId, admin, dto, req.ip);
  }

  @Patch(':id/sections')
  @ApiOperation({ summary: 'Change which sections a staff member may use' })
  async updateSections(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateSectionsDto,
    @Req() req: RequestWithUser,
  ) {
    const brokerId = await this.brokerScope.requireBrokerActor(admin);
    await this.staff.requireManager(admin.id, brokerId);
    return this.staff.updateSections(brokerId, admin, id, dto.sections, req.ip);
  }

  @Patch(':id/active')
  @ApiOperation({ summary: 'Deactivate or reactivate a staff member' })
  async setActive(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: SetActiveDto,
    @Req() req: RequestWithUser,
  ) {
    const brokerId = await this.brokerScope.requireBrokerActor(admin);
    await this.staff.requireManager(admin.id, brokerId);
    return this.staff.setActive(brokerId, admin, id, dto.isActive, req.ip);
  }

  @Post(':id/reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Email a staff member a new temporary password' })
  async resetPassword(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Req() req: RequestWithUser,
  ) {
    const brokerId = await this.brokerScope.requireBrokerActor(admin);
    await this.staff.requireManager(admin.id, brokerId);
    return this.staff.resetPassword(brokerId, admin, id, req.ip);
  }
}
