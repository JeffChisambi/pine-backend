import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../../core/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../../core/types/request-context.types';
import { PinGuard } from '../../auth/guards/pin.guard';
import { TradingService } from '../services/trading.service';
import {
  BuyOrderDto,
  SellOrderDto,
  OrderHistoryQueryDto,
  TradeHistoryQueryDto,
} from '../dto/trading.dto';

/**
 * Trading Controller — REST API for the Pine trading pipeline.
 *
 * All endpoints require authentication (@CurrentUser).
 * No public trading endpoints exist.
 *
 * Endpoints:
 *   POST   /v1/trading/buy           → Submit buy order
 *   POST   /v1/trading/sell          → Submit sell order
 *   POST   /v1/trading/cancel/:id    → Cancel an order
 *   GET    /v1/trading/orders        → Order history (paginated)
 *   GET    /v1/trading/orders/:id    → Single order detail
 *   GET    /v1/trading/portfolio     → Full portfolio with P&L
 *   GET    /v1/trading/holdings      → All holdings
 *   GET    /v1/trading/history       → Trade execution history
 */
@ApiTags('trading')
@ApiBearerAuth()
@Controller('trading')
export class TradingController {
  constructor(private readonly tradingService: TradingService) {}

  // ── Buy ─────────────────────────────────────────────────────

  @Post('buy')
  @UseGuards(PinGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Submit a buy order',
    description:
      'Creates and executes a buy order through the full trading pipeline: ' +
      'validation → risk checks → execution → ledger → settlement → portfolio update. ' +
      'Returns the completed order with trade details and fees.',
  })
  @ApiResponse({ status: 201, description: 'Order created and executed' })
  @ApiResponse({ status: 400, description: 'Validation or risk check failed' })
  @ApiResponse({ status: 404, description: 'Stock not found' })
  async buy(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: BuyOrderDto,
  ) {
    return this.tradingService.submitBuyOrder(
      user.id,
      {
        stockSymbol: dto.stockSymbol,
        quantity: dto.quantity,
        orderType: dto.orderType,
        limitPrice: dto.limitPrice,
        idempotencyKey: dto.idempotencyKey,
      },
      user.kycStatus,
    );
  }

  // ── Sell ────────────────────────────────────────────────────

  @Post('sell')
  @UseGuards(PinGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Submit a sell order',
    description:
      'Creates and executes a sell order. Validates that you hold sufficient shares ' +
      'before proceeding through the trading pipeline.',
  })
  @ApiResponse({ status: 201, description: 'Sell order created and executed' })
  @ApiResponse({ status: 400, description: 'Validation failed (insufficient shares, market closed, etc.)' })
  async sell(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SellOrderDto,
  ) {
    return this.tradingService.submitSellOrder(
      user.id,
      {
        stockSymbol: dto.stockSymbol,
        quantity: dto.quantity,
        orderType: dto.orderType,
        limitPrice: dto.limitPrice,
        idempotencyKey: dto.idempotencyKey,
      },
      user.kycStatus,
    );
  }

  // ── Cancel ──────────────────────────────────────────────────

  @Post('cancel/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel an order',
    description:
      'Cancels an order if it is still in a cancellable state (DRAFT, PENDING_VALIDATION, ' +
      'VALIDATED, or SUBMITTED). Orders that are already filled or settled cannot be cancelled.',
  })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiResponse({ status: 200, description: 'Order cancelled' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  @ApiResponse({ status: 409, description: 'Order cannot be cancelled in current state' })
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') orderId: string,
  ) {
    return this.tradingService.cancelOrder(user.id, orderId);
  }

  // ── Orders ──────────────────────────────────────────────────

  @Get('orders')
  @ApiOperation({
    summary: 'Get order history',
    description: 'Returns a paginated list of your orders. Filter by status or side.',
  })
  @ApiResponse({ status: 200, description: 'Paginated order list' })
  async getOrders(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: OrderHistoryQueryDto,
  ) {
    return this.tradingService.getOrders(user.id, {
      status: query.status,
      side: query.side,
      limit: query.limit,
      offset: query.offset,
    });
  }

  @Get('orders/:id')
  @ApiOperation({
    summary: 'Get order detail',
    description: 'Returns full details for a single order including all trade executions.',
  })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiResponse({ status: 200, description: 'Order detail with trades' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  async getOrder(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') orderId: string,
  ) {
    return this.tradingService.getOrderDetail(user.id, orderId);
  }

  // ── Trade History ───────────────────────────────────────────

  @Get('history')
  @ApiOperation({
    summary: 'Get trade execution history',
    description: 'Returns a list of all executed trades (filled orders) with price and fee details.',
  })
  @ApiResponse({ status: 200, description: 'Trade history list' })
  async getTradeHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: TradeHistoryQueryDto,
  ) {
    return this.tradingService.getTradeHistory(
      user.id,
      query.limit ?? 20,
      query.offset ?? 0,
    );
  }
}
