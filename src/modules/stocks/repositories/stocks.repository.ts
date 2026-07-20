import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/database/prisma.service';

export interface StockRow {
  id: string;
  symbol: string;
  name: string;
  sector: string;
  description: string | null;
  listedShares: bigint | null;
  latestPrice: {
    closePrice: string;
    openPrice: string;
    highPrice: string;
    lowPrice: string;
    volume: bigint;
    turnover: string | null;
    tradedAt: Date;
    changePct: string | null;
  } | null;
  prevClosePrice: string | null;
}

@Injectable()
export class StocksRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** All active stocks with their most recent price + previous day price. */
  async findAllWithLatestPrice(sector?: string): Promise<StockRow[]> {
    const stocks = await this.prisma.stock.findMany({
      where: { isActive: true, ...(sector ? { sector } : {}) },
      orderBy: { symbol: 'asc' },
      include: {
        prices: {
          orderBy: { tradedAt: 'desc' },
          take: 2, // [latest, previous]
          select: {
            closePrice: true,
            openPrice: true,
            highPrice: true,
            lowPrice: true,
            volume: true,
            turnover: true,
            tradedAt: true,
            changePct: true,
          },
        },
      },
    });

    return stocks.map((s) => ({
      id: s.id,
      symbol: s.symbol,
      name: s.name,
      sector: s.sector,
      description: s.description,
      listedShares: s.listedShares,
      latestPrice: s.prices[0]
        ? {
            closePrice: s.prices[0].closePrice.toString(),
            openPrice: s.prices[0].openPrice.toString(),
            highPrice: s.prices[0].highPrice.toString(),
            lowPrice: s.prices[0].lowPrice.toString(),
            volume: s.prices[0].volume,
            turnover: s.prices[0].turnover?.toString() ?? null,
            tradedAt: s.prices[0].tradedAt,
            changePct: s.prices[0].changePct?.toString() ?? null,
          }
        : null,
      prevClosePrice: s.prices[1]?.closePrice.toString() ?? null,
    }));
  }

  /** Single stock with latest + previous price. */
  async findBySymbol(symbol: string): Promise<StockRow | null> {
    const stock = await this.prisma.stock.findFirst({
      where: { symbol: symbol.toUpperCase(), isActive: true },
      include: {
        prices: {
          orderBy: { tradedAt: 'desc' },
          take: 2,
          select: {
            closePrice: true,
            openPrice: true,
            highPrice: true,
            lowPrice: true,
            volume: true,
            turnover: true,
            tradedAt: true,
            changePct: true,
          },
        },
      },
    });

    if (!stock) return null;

    return {
      id: stock.id,
      symbol: stock.symbol,
      name: stock.name,
      sector: stock.sector,
      description: stock.description,
      listedShares: stock.listedShares,
      latestPrice: stock.prices[0]
        ? {
            closePrice: stock.prices[0].closePrice.toString(),
            openPrice: stock.prices[0].openPrice.toString(),
            highPrice: stock.prices[0].highPrice.toString(),
            lowPrice: stock.prices[0].lowPrice.toString(),
            volume: stock.prices[0].volume,
            turnover: stock.prices[0].turnover?.toString() ?? null,
            tradedAt: stock.prices[0].tradedAt,
            changePct: stock.prices[0].changePct?.toString() ?? null,
          }
        : null,
      prevClosePrice: stock.prices[1]?.closePrice.toString() ?? null,
    };
  }

  /**
   * Price history for chart rendering.
   *
   * Uses a calendar-day range filter (tradedAt >= since) rather than
   * `take: N` so the correct window of trading days is returned even
   * when there are gaps (weekends, holidays).  Results are ordered
   * oldest-first as expected by the SVG chart component.
   */
  async findPriceHistory(stockId: string, days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    return this.prisma.stockPrice.findMany({
      where: {
        stockId,
        tradedAt: { gte: since },
      },
      orderBy: { tradedAt: 'asc' },
      select: {
        tradedAt: true,
        closePrice: true,
        openPrice: true,
        highPrice: true,
        lowPrice: true,
        volume: true,
        turnover: true,
        changePct: true,
      },
    });
  }

  /** Fuzzy search by symbol or name, top 20 results. */
  async search(query: string): Promise<StockRow[]> {
    const q = query.trim().toLowerCase();
    const stocks = await this.prisma.stock.findMany({
      where: {
        isActive: true,
        OR: [
          { symbol: { contains: q, mode: 'insensitive' } },
          { name: { contains: q, mode: 'insensitive' } },
        ],
      },
      orderBy: { symbol: 'asc' },
      take: 20,
      include: {
        prices: {
          orderBy: { tradedAt: 'desc' },
          take: 2,
          select: {
            closePrice: true,
            openPrice: true,
            highPrice: true,
            lowPrice: true,
            volume: true,
            turnover: true,
            tradedAt: true,
            changePct: true,
          },
        },
      },
    });

    return stocks.map((s) => ({
      id: s.id,
      symbol: s.symbol,
      name: s.name,
      sector: s.sector,
      description: s.description,
      listedShares: s.listedShares,
      latestPrice: s.prices[0]
        ? {
            closePrice: s.prices[0].closePrice.toString(),
            openPrice: s.prices[0].openPrice.toString(),
            highPrice: s.prices[0].highPrice.toString(),
            lowPrice: s.prices[0].lowPrice.toString(),
            volume: s.prices[0].volume,
            turnover: s.prices[0].turnover?.toString() ?? null,
            tradedAt: s.prices[0].tradedAt,
            changePct: s.prices[0].changePct?.toString() ?? null,
          }
        : null,
      prevClosePrice: s.prices[1]?.closePrice.toString() ?? null,
    }));
  }
}
