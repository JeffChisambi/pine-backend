import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { StocksService } from '../services/stocks.service';

/**
 * Public stock market data API consumed by the Pine mobile app.
 * No auth required — market data is public information.
 */
@ApiTags('stocks')
@Controller('stocks')
export class StocksController {
  constructor(private readonly stocksService: StocksService) {}

  @Get()
  @ApiOperation({
    summary: 'List all MSE stocks with latest price',
    description:
      'Returns all active MSE-listed stocks with their most recent closing price, ' +
      'percentage change from the previous trading day, and volume. ' +
      'Optionally filter by sector.',
  })
  @ApiQuery({ name: 'sector', required: false, description: 'Filter by sector name (e.g. "Banking")' })
  @ApiResponse({ status: 200, description: 'Array of stocks with pricing data' })
  async listStocks(@Query('sector') sector?: string) {
    return this.stocksService.listStocks(sector);
  }

  @Get('sectors')
  @ApiOperation({ summary: 'List all available stock sectors' })
  @ApiResponse({ status: 200, description: 'Array of sector name strings' })
  async getSectors() {
    return this.stocksService.getSectors();
  }

  @Get('search')
  @ApiOperation({
    summary: 'Search stocks by ticker or company name',
    description: 'Case-insensitive search. Returns up to 20 matching stocks.',
  })
  @ApiQuery({ name: 'q', required: true, description: 'Search query (min 1 character)' })
  @ApiResponse({ status: 200, description: 'Array of matching stocks' })
  async searchStocks(@Query('q') q = '') {
    return this.stocksService.searchStocks(q);
  }

  @Get(':symbol')
  @ApiOperation({
    summary: 'Get detailed data for a single stock',
    description:
      'Returns full stock details including OHLC, volume, and price history for charting. ' +
      'Use the `period` parameter to control the history window: 1M (default), 3M, 6M, 1Y, 2Y, 5Y.',
  })
  @ApiParam({ name: 'symbol', description: 'Stock ticker symbol (e.g. "NBM", "AIRTEL")' })
  @ApiQuery({
    name: 'period',
    required: false,
    enum: ['1M', '3M', '6M', '1Y', '2Y', '5Y'],
    description: 'History window period (default: 1M = 30 trading days)',
  })
  @ApiResponse({ status: 200, description: 'Stock detail with price history' })
  @ApiResponse({ status: 404, description: 'Stock not found' })
  async getStockDetail(
    @Param('symbol') symbol: string,
    @Query('period') period?: string,
  ) {
    return this.stocksService.getStockDetail(symbol, period);
  }
}
