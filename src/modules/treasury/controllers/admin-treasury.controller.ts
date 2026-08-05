import {
  Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Req,
  UsePipes, ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../../core/decorators/require-permissions.decorator';
import { Permission } from '../../auth/constants/permissions.constant';
import { CurrentUser } from '../../../core/decorators/current-user.decorator';
import type { AuthenticatedUser, RequestWithUser } from '../../../core/types/request-context.types';
import { AuditLogService } from '../../audit/services/audit-log.service';
import { TreasuryService } from '../services/treasury.service';
import { CreateTreasuryProductDto, UpdateTreasuryProductDto } from '../dto/admin-treasury.dto';

/**
 * Admin (dashboard) treasury-bill management + investment (order) oversight.
 * Reuses ADMIN_ACCESS and audits mutations, matching the news/admin-users
 * convention.
 */
@ApiTags('admin', 'treasury')
@ApiBearerAuth()
@Controller('admin/treasury')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class AdminTreasuryController {
  constructor(
    private readonly treasury: TreasuryService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @Get('products')
  @RequirePermissions(Permission.ADMIN_ACCESS)
  @ApiOperation({ summary: 'List all treasury products (incl. inactive)' })
  async listProducts() {
    return { products: await this.treasury.listAllProducts() };
  }

  @Post('products')
  @RequirePermissions(Permission.ADMIN_ACCESS)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a treasury product (T-bill)' })
  async createProduct(
    @Body() dto: CreateTreasuryProductDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Req() req: RequestWithUser,
  ) {
    const product = await this.treasury.createProduct(dto);
    await this.auditLogService.log({
      actorId: admin.id, actorRole: admin.role,
      action: 'TREASURY_PRODUCT_CREATED', resourceType: 'TREASURY_PRODUCT', resourceId: product.id,
      ipAddress: req.ip, userAgent: req.headers['user-agent'],
      metadata: { label: product.label, tenorDays: product.tenorDays },
    });
    return product;
  }

  @Patch('products/:id')
  @RequirePermissions(Permission.ADMIN_ACCESS)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a treasury product' })
  async updateProduct(
    @Param('id') id: string,
    @Body() dto: UpdateTreasuryProductDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Req() req: RequestWithUser,
  ) {
    const product = await this.treasury.updateProduct(id, dto);
    await this.auditLogService.log({
      actorId: admin.id, actorRole: admin.role,
      action: 'TREASURY_PRODUCT_UPDATED', resourceType: 'TREASURY_PRODUCT', resourceId: id,
      ipAddress: req.ip, userAgent: req.headers['user-agent'],
    });
    return product;
  }

  @Delete('products/:id')
  @RequirePermissions(Permission.ADMIN_ACCESS)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete (or archive) a treasury product' })
  async deleteProduct(
    @Param('id') id: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Req() req: RequestWithUser,
  ) {
    const result = await this.treasury.deleteProduct(id);
    await this.auditLogService.log({
      actorId: admin.id, actorRole: admin.role,
      action: result.archived ? 'TREASURY_PRODUCT_ARCHIVED' : 'TREASURY_PRODUCT_DELETED',
      resourceType: 'TREASURY_PRODUCT', resourceId: id,
      ipAddress: req.ip, userAgent: req.headers['user-agent'],
    });
    return result;
  }

  @Get('investments')
  @RequirePermissions(Permission.ADMIN_ACCESS)
  @ApiOperation({ summary: 'List all treasury investments (orders) across users' })
  async listInvestments() {
    return { investments: await this.treasury.listAllInvestments() };
  }
}
