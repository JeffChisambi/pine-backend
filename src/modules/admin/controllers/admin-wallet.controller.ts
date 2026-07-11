import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../../core/decorators/require-permissions.decorator';
import { Permission } from '../../auth/constants/permissions.constant';
import { AdminRepository } from '../repositories/admin.repository';
import { ResourceNotFoundException } from '../../../core/exceptions/app.exception';

@ApiTags('admin', 'wallets')
@ApiBearerAuth()
@Controller('admin/wallets')
export class AdminWalletController {
  constructor(private readonly adminRepo: AdminRepository) {}

  @Get()
  @RequirePermissions(Permission.WALLET_READ)
  @ApiOperation({ summary: 'List all wallets' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'frozen', required: false, type: Boolean })
  @ApiResponse({ status: 200, description: 'Paginated wallet list' })
  async listWallets(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('frozen') frozen?: string,
  ) {
    return this.adminRepo.listWallets({
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 50,
      frozen: frozen === 'true' ? true : frozen === 'false' ? false : undefined,
    });
  }

  @Get(':userId')
  @RequirePermissions(Permission.WALLET_READ)
  @ApiOperation({
    summary: 'Wallet detail for a user',
    description: 'Balance, reserved, transactions, and ledger entries.',
  })
  @ApiResponse({ status: 200, description: 'Wallet detail' })
  async getWalletDetail(@Param('userId') userId: string) {
    const wallet = await this.adminRepo.getWalletDetail(userId);
    if (!wallet) {
      throw new ResourceNotFoundException('Wallet', userId);
    }
    return wallet;
  }
}
