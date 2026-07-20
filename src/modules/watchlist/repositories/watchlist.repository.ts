import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/database/prisma.service';

export interface WatchlistStockRow {
  stockId: string;
  symbol: string;
  addedAt: Date;
}

@Injectable()
export class WatchlistRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Returns true if the given stock is in the user's watchlist. */
  async isWatched(userId: string, stockId: string): Promise<boolean> {
    const entry = await this.prisma.watchlistEntry.findUnique({
      where: { userId_stockId: { userId, stockId } },
      select: { id: true },
    });
    return entry !== null;
  }

  /** Adds a stock to the user's watchlist (idempotent). Returns the entry. */
  async add(userId: string, stockId: string): Promise<WatchlistStockRow> {
    const entry = await this.prisma.watchlistEntry.upsert({
      where: { userId_stockId: { userId, stockId } },
      create: { userId, stockId },
      update: {},
      include: { stock: { select: { symbol: true } } },
    });
    return {
      stockId: entry.stockId,
      symbol: (entry as any).stock.symbol,
      addedAt: entry.createdAt,
    };
  }

  /** Removes a stock from the user's watchlist (idempotent). */
  async remove(userId: string, stockId: string): Promise<void> {
    await this.prisma.watchlistEntry
      .delete({ where: { userId_stockId: { userId, stockId } } })
      .catch(() => {}); // ignore "not found" — removal is idempotent
  }

  /** Returns the user's full watchlist. */
  async findAll(userId: string): Promise<WatchlistStockRow[]> {
    const entries = await this.prisma.watchlistEntry.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { stock: { select: { symbol: true } } },
    });
    return entries.map((e) => ({
      stockId: e.stockId,
      symbol: (e as any).stock.symbol,
      addedAt: e.createdAt,
    }));
  }

  /** Returns the stockId for the given symbol, or null. */
  async findStockIdBySymbol(symbol: string): Promise<string | null> {
    const stock = await this.prisma.stock.findFirst({
      where: { symbol: symbol.toUpperCase(), isActive: true },
      select: { id: true },
    });
    return stock?.id ?? null;
  }

  /** Returns the set of symbols currently watched by the user. */
  async findWatchedSymbols(userId: string): Promise<Set<string>> {
    const entries = await this.prisma.watchlistEntry.findMany({
      where: { userId },
      include: { stock: { select: { symbol: true } } },
    });
    return new Set(entries.map((e) => (e as any).stock.symbol as string));
  }
}
