import {
  Controller,
  Get,
  Param,
  Query,
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
import { PortfolioService } from '../services/portfolio.service';
import { PortfolioHistoryQueryDto } from '../dto/portfolio.dto';

/**
 * Portfolio Controller — read-only REST API for the investor's portfolio.
 *
 * All endpoints require authentication. No transaction PIN needed
 * to view holdings (read-only operations).
 *
 * Endpoints:
 *   GET /v1/portfolio              → Full portfolio overview
 *   GET /v1/portfolio/summary      → Summary with totals and P&L
 *   GET /v1/portfolio/holdings     → All stock positions
 *   GET /v1/portfolio/holdings/:id → Single holding detail
 *   GET /v1/portfolio/performance  → Return metrics
 *   GET /v1/portfolio/allocation   → Asset/sector allocation
 *   GET /v1/portfolio/analytics    → Insights (top/worst, etc.)
 *   GET /v1/portfolio/history      → Snapshot history for charts
 *   GET /v1/portfolio/snapshots    → Raw snapshot data
 */
@ApiTags('portfolio')
@ApiBearerAuth()
@Controller('portfolio')
export class PortfolioController {
  constructor(private readonly portfolioService: PortfolioService) {}

  // ── Overview ────────────────────────────────────────────────

  @Get()
  @ApiOperation({
    summary: 'Get full portfolio overview',
    description:
      'Returns everything: summary, all holdings with valuations, ' +
      'performance metrics, and allocation breakdown in a single call. ' +
      'Ideal for the main portfolio screen.',
  })
  @ApiResponse({ status: 200, description: 'Complete portfolio overview' })
  async getPortfolio(@CurrentUser() user: AuthenticatedUser) {
    const [summary, holdings, performance, allocation] = await Promise.all([
      this.portfolioService.getPortfolioSummary(user.id),
      this.portfolioService.getHoldings(user.id),
      this.portfolioService.getPerformance(user.id),
      this.portfolioService.getAllocation(user.id),
    ]);

    return {
      summary,
      holdings,
      performance,
      allocation: allocation.allocations,
      sectorAllocation: allocation.sectorAllocation,
    };
  }

  @Get('summary')
  @ApiOperation({
    summary: 'Get portfolio summary',
    description:
      'Returns portfolio totals: cash balance, total invested, market value, ' +
      'unrealized P&L, daily change, and portfolio value.',
  })
  @ApiResponse({ status: 200, description: 'Portfolio summary with P&L' })
  async getSummary(@CurrentUser() user: AuthenticatedUser) {
    return this.portfolioService.getPortfolioSummary(user.id);
  }

  // ── Holdings ────────────────────────────────────────────────

  @Get('holdings')
  @ApiOperation({
    summary: 'Get all stock holdings',
    description:
      'Returns all stock positions with current price, market value, ' +
      'cost basis, unrealized P&L, daily change, and portfolio weight.',
  })
  @ApiResponse({ status: 200, description: 'Holdings with valuations' })
  async getHoldings(@CurrentUser() user: AuthenticatedUser) {
    return this.portfolioService.getHoldings(user.id);
  }

  @Get('holdings/:stockId')
  @ApiOperation({
    summary: 'Get single holding detail',
    description: 'Returns detailed valuation for a specific stock holding.',
  })
  @ApiParam({ name: 'stockId', description: 'Stock UUID' })
  @ApiResponse({ status: 200, description: 'Holding detail' })
  @ApiResponse({ status: 404, description: 'Holding not found' })
  async getHoldingDetail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('stockId') stockId: string,
  ) {
    return this.portfolioService.getHoldingDetail(user.id, stockId);
  }

  // ── Performance ─────────────────────────────────────────────

  @Get('performance')
  @ApiOperation({
    summary: 'Get portfolio performance metrics',
    description:
      'Returns daily, weekly, monthly, yearly, and lifetime returns ' +
      'both as absolute MWK values and percentage.',
  })
  @ApiResponse({ status: 200, description: 'Performance metrics' })
  async getPerformance(@CurrentUser() user: AuthenticatedUser) {
    return this.portfolioService.getPerformance(user.id);
  }

  // ── Allocation ──────────────────────────────────────────────

  @Get('allocation')
  @ApiOperation({
    summary: 'Get portfolio allocation',
    description:
      'Returns asset allocation (Stocks vs Cash) and sector allocation ' +
      'breakdown with percentages. Ideal for pie charts.',
  })
  @ApiResponse({ status: 200, description: 'Allocation breakdown' })
  async getAllocation(@CurrentUser() user: AuthenticatedUser) {
    return this.portfolioService.getAllocation(user.id);
  }

  // ── Analytics ───────────────────────────────────────────────

  @Get('analytics')
  @ApiOperation({
    summary: 'Get portfolio analytics',
    description:
      'Returns portfolio insights: top/worst performers, largest position, ' +
      'sector allocation, number of trades, and average holding size.',
  })
  @ApiResponse({ status: 200, description: 'Portfolio analytics' })
  async getAnalytics(@CurrentUser() user: AuthenticatedUser) {
    return this.portfolioService.getAnalytics(user.id);
  }

  // ── History ─────────────────────────────────────────────────

  @Get('history')
  @ApiOperation({
    summary: 'Get portfolio history for charts',
    description:
      'Returns daily portfolio value snapshots in chronological order. ' +
      'Use for line charts showing portfolio growth over time.',
  })
  @ApiResponse({ status: 200, description: 'Portfolio value history' })
  async getHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PortfolioHistoryQueryDto,
  ) {
    return this.portfolioService.getHistory(user.id, query.limit ?? 90);
  }

  @Get('snapshots')
  @ApiOperation({
    summary: 'Get raw portfolio snapshots',
    description:
      'Returns raw snapshot data including total value, cost, and P&L per day.',
  })
  @ApiResponse({ status: 200, description: 'Portfolio snapshots' })
  async getSnapshots(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PortfolioHistoryQueryDto,
  ) {
    return this.portfolioService.getSnapshots(user.id, query.limit ?? 90);
  }
}
