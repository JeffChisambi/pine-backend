import { Injectable, NotFoundException } from '@nestjs/common';
import { WatchlistRepository } from '../repositories/watchlist.repository';
import { StocksService } from '../../stocks/services/stocks.service';

@Injectable()
export class WatchlistService {
  constructor(
    private readonly watchlistRepo: WatchlistRepository,
    private readonly stocksService: StocksService,
  ) {}

  /**
   * GET /v1/watchlist
   * Returns the user's watchlist with full stock details (latest price, change%).
   */
  async getWatchlist(userId: string) {
    const rows = await this.watchlistRepo.findAll(userId);
    if (rows.length === 0) return { stocks: [], count: 0 };

    // Fetch full details for each watched stock in parallel
    const details = await Promise.all(
      rows.map(async (r) => {
        try {
          const stock = await this.stocksService.getStockDetail(r.symbol);
          return { ...stock, addedAt: r.addedAt };
        } catch {
          return null; // stock may have been delisted; skip gracefully
        }
      }),
    );

    const stocks = details.filter(Boolean);
    return { stocks, count: stocks.length };
  }

  /**
   * POST /v1/watchlist/:symbol
   * Adds the stock to the user's watchlist. Idempotent.
   */
  async addStock(userId: string, symbol: string) {
    const stockId = await this.watchlistRepo.findStockIdBySymbol(symbol);
    if (!stockId) {
      throw new NotFoundException(`Stock "${symbol.toUpperCase()}" not found or is not active.`);
    }
    const entry = await this.watchlistRepo.add(userId, stockId);
    return { message: `${entry.symbol} added to watchlist.`, symbol: entry.symbol, addedAt: entry.addedAt };
  }

  /**
   * DELETE /v1/watchlist/:symbol
   * Removes the stock from the user's watchlist. Idempotent.
   */
  async removeStock(userId: string, symbol: string) {
    const stockId = await this.watchlistRepo.findStockIdBySymbol(symbol);
    if (!stockId) {
      throw new NotFoundException(`Stock "${symbol.toUpperCase()}" not found or is not active.`);
    }
    await this.watchlistRepo.remove(userId, stockId);
    return { message: `${symbol.toUpperCase()} removed from watchlist.`, symbol: symbol.toUpperCase() };
  }

  /**
   * GET /v1/watchlist/symbols
   * Returns only the set of symbols currently watched. Cheap — used to
   * seed the star icon state on the stock detail screen.
   */
  async getWatchedSymbols(userId: string): Promise<{ symbols: string[] }> {
    const set = await this.watchlistRepo.findWatchedSymbols(userId);
    return { symbols: [...set] };
  }

  /**
   * Returns whether a specific symbol is in the user's watchlist.
   */
  async isWatched(userId: string, symbol: string): Promise<{ watched: boolean }> {
    const stockId = await this.watchlistRepo.findStockIdBySymbol(symbol);
    if (!stockId) return { watched: false };
    const watched = await this.watchlistRepo.isWatched(userId, stockId);
    return { watched };
  }
}
