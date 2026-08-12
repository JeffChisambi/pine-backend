import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../../core/decorators/require-permissions.decorator';
import { Permission } from '../../auth/constants/permissions.constant';
import { CurrentUser } from '../../../core/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../../core/types/request-context.types';
import { AdminRepository } from '../repositories/admin.repository';
import { ResourceNotFoundException } from '../../../core/exceptions/app.exception';
import { BrokerScopeService } from '../../brokers/services/broker-scope.service';

@ApiTags('admin', 'wallets')
@ApiBearerAuth()
@Controller('admin/wallets')
export class AdminWalletController {
  constructor(
    private readonly adminRepo: AdminRepository,
    private readonly brokerScope: BrokerScopeService,
  ) {}

  @Get()
  @RequirePermissions(Permission.WALLET_READ)
  @ApiOperation({ summary: 'List wallets (broker admins: own broker only)' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'frozen', required: false, type: Boolean })
  @ApiResponse({ status: 200, description: 'Paginated wallet list' })
  async listWallets(
    @CurrentUser() admin: AuthenticatedUser,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('frozen') frozen?: string,
  ) {
    const scope = await this.brokerScope.resolveScope(admin);
    return this.adminRepo.listWallets(
      {
        page: page ? parseInt(page, 10) : 1,
        limit: limit ? parseInt(limit, 10) : 50,
        frozen: frozen === 'true' ? true : frozen === 'false' ? false : undefined,
      },
      scope,
    );
  }

  @Get(':userId')
  @RequirePermissions(Permission.WALLET_READ)
  @ApiOperation({
    summary: 'Wallet detail for a user',
    description: 'Balance, reserved, transactions, and ledger entries.',
  })
  @ApiResponse({ status: 200, description: 'Wallet detail' })
  async getWalletDetail(
    @Param('userId') userId: string,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    const scope = await this.brokerScope.resolveScope(admin);
    const wallet = await this.adminRepo.getWalletDetail(userId, scope);
    if (!wallet) {
      throw new ResourceNotFoundException('Wallet', userId);
    }
    return wallet;
  }
}
