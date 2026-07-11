import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../../core/decorators/require-permissions.decorator';
import { Permission } from '../../auth/constants/permissions.constant';
import { AdminRepository } from '../repositories/admin.repository';
import { ListOrdersQueryDto } from '../dto/admin.dto';
import { ResourceNotFoundException } from '../../../core/exceptions/app.exception';

@ApiTags('admin', 'trading')
@ApiBearerAuth()
@Controller('admin/trading')
export class AdminTradingController {
  constructor(private readonly adminRepo: AdminRepository) {}

  @Get('orders')
  @RequirePermissions(Permission.MARKET_READ)
  @ApiOperation({ summary: 'List all trading orders with filters' })
  @ApiResponse({ status: 200, description: 'Paginated order list' })
  async listOrders(@Query() query: ListOrdersQueryDto) {
    return this.adminRepo.listOrders({
      status: query.status,
      userId: query.userId,
      stockId: query.stockId,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      page: query.page,
      limit: query.limit,
    });
  }

  @Get('orders/:id')
  @RequirePermissions(Permission.MARKET_READ)
  @ApiOperation({
    summary: 'Order detail with full timeline',
    description: 'Returns the order with trades, executions, settlements, and audit trail.',
  })
  @ApiResponse({ status: 200, description: 'Order detail' })
  async getOrderDetail(@Param('id') orderId: string) {
    const order = await this.adminRepo.getOrderDetail(orderId);
    if (!order) {
      throw new ResourceNotFoundException('Order', orderId);
    }
    return order;
  }
}
