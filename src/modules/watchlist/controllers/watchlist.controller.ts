import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
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
import { WatchlistService } from '../services/watchlist.service';

/**
 * Watchlist Controller — per-user stock watchlist.
 *
 * All endpoints require a valid JWT (applied globally via APP_GUARD).
 *
 * Endpoints:
 *   GET    /v1/watchlist          → Full watchlist with latest stock details
 *   GET    /v1/watchlist/symbols  → Just the set of watched symbols (cheap)
 *   GET    /v1/watchlist/:symbol  → Is this specific symbol watched?
 *   POST   /v1/watchlist/:symbol  → Add stock to watchlist (idempotent)
 *   DELETE /v1/watchlist/:symbol  → Remove stock from watchlist (idempotent)
 */
@ApiTags('watchlist')
@ApiBearerAuth()
@Controller('watchlist')
export class WatchlistController {
  constructor(private readonly watchlistService: WatchlistService) {}

  @Get()
  @ApiOperation({
    summary: 'Get full watchlist',
    description: 'Returns all stocks in the user\'s watchlist with latest price data.',
  })
  @ApiResponse({ status: 200, description: 'Watchlist with stock details' })
  async getWatchlist(@CurrentUser() user: AuthenticatedUser) {
    return this.watchlistService.getWatchlist(user.id);
  }

  @Get('symbols')
  @ApiOperation({
    summary: 'Get watched symbols',
    description: 'Returns just the set of stock symbols the user is watching. Cheap endpoint for seeding icon state.',
  })
  @ApiResponse({ status: 200, description: 'Array of watched symbols' })
  async getSymbols(@CurrentUser() user: AuthenticatedUser) {
    return this.watchlistService.getWatchedSymbols(user.id);
  }

  @Get(':symbol')
  @ApiOperation({ summary: 'Check if stock is watched' })
  @ApiParam({ name: 'symbol', description: 'Stock ticker symbol' })
  @ApiResponse({ status: 200, description: '{ watched: boolean }' })
  async isWatched(
    @CurrentUser() user: AuthenticatedUser,
    @Param('symbol') symbol: string,
  ) {
    return this.watchlistService.isWatched(user.id, symbol);
  }

  @Post(':symbol')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Add stock to watchlist',
    description: 'Idempotent — calling twice has no effect.',
  })
  @ApiParam({ name: 'symbol', description: 'Stock ticker symbol' })
  @ApiResponse({ status: 200, description: 'Stock added to watchlist' })
  @ApiResponse({ status: 404, description: 'Stock not found' })
  async addStock(
    @CurrentUser() user: AuthenticatedUser,
    @Param('symbol') symbol: string,
  ) {
    return this.watchlistService.addStock(user.id, symbol);
  }

  @Delete(':symbol')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Remove stock from watchlist',
    description: 'Idempotent — calling on a non-watched stock is a no-op.',
  })
  @ApiParam({ name: 'symbol', description: 'Stock ticker symbol' })
  @ApiResponse({ status: 200, description: 'Stock removed from watchlist' })
  async removeStock(
    @CurrentUser() user: AuthenticatedUser,
    @Param('symbol') symbol: string,
  ) {
    return this.watchlistService.removeStock(user.id, symbol);
  }
}
