import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../../core/decorators/require-permissions.decorator';
import { Permission } from '../../auth/constants/permissions.constant';
import { CurrentUser } from '../../../core/decorators/current-user.decorator';
import type { AuthenticatedUser, RequestWithUser } from '../../../core/types/request-context.types';
import { AdminRepository } from '../repositories/admin.repository';
import { AuditLogService } from '../../audit/services/audit-log.service';
import { TradingService } from '../../trading/services/trading.service';
import { ListOrdersQueryDto } from '../dto/admin.dto';
import { ResourceNotFoundException } from '../../../core/exceptions/app.exception';

@ApiTags('admin', 'trading')
@ApiBearerAuth()
@Controller('admin/trading')
export class AdminTradingController {
  constructor(
    private readonly adminRepo: AdminRepository,
    private readonly auditLogService: AuditLogService,
    private readonly tradingService: TradingService,
  ) {}

  @Get('orders')
  @RequirePermissions(Permission.MARKET_READ)
  @ApiOperation({ summary: 'List all trading orders with filters' })
  @ApiResponse({ status: 200, description: 'Paginated order list' })
  async listOrders(@Query() query: ListOrdersQueryDto) {
    return this.adminRepo.listOrders({
      status: query.status,
      side: query.side,
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

  // ── POST /v1/admin/trading/orders/:id/execute ──────────────────────────────
  // Broker confirms a queued order has been executed at the exchange. Runs the
  // remaining pipeline (broker gateway → trade → fill → ledger → settlement →
  // portfolio → user notification). Idempotent: only SUBMITTED (queued) orders
  // are accepted; re-clicks meet a 409 because the status has moved on.

  @Post('orders/:id/execute')
  @RequirePermissions(Permission.TRADE_EXECUTE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Execute a queued order (broker confirmation)',
    description:
      'Confirms a market-closed queued order as executed. Idempotent — an ' +
      'order can only be executed once.',
  })
  @ApiResponse({ status: 200, description: 'Order executed (or rejected by broker).' })
  @ApiResponse({ status: 404, description: 'Order not found.' })
  @ApiResponse({ status: 409, description: 'Order is not in a queued state.' })
  async executeOrder(
    @Param('id') orderId: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Req() req: RequestWithUser,
  ) {
    const result = await this.tradingService.executeQueuedOrder(orderId, {
      adminId: admin.id,
      role: admin.role,
    });

    await this.auditLogService.log({
      actorId: admin.id,
      actorRole: admin.role,
      action: 'ORDER_EXECUTED_BY_BROKER',
      resourceType: 'ORDER',
      resourceId: orderId,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      metadata: { resultStatus: result.status },
    });

    return {
      orderId,
      status: result.status,
      message:
        result.status === 'REJECTED'
          ? 'Broker rejected the order.'
          : 'Order executed successfully.',
    };
  }
}
