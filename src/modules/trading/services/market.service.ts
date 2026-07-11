import { Injectable, Logger } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { TradingRepository } from '../repositories/trading.repository';
import { AppConfigService } from '../../../config/app-config.service';

/**
 * Market Service — read-only market data for trading decisions.
 *
 * Knows about:
 * - Current prices
 * - Market status (open/closed/holiday)
 * - Trading session hours
 * - MSE tick sizes
 *
 * Never executes trades.
 */
@Injectable()
export class MarketService {
  private readonly logger = new Logger(MarketService.name);

  constructor(
    private readonly repo: TradingRepository,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Check if the MSE is currently open for trading.
   *
   * Logic:
   * 1. Is today a weekday? (Mon–Fri)
   * 2. Is today NOT a holiday? (check MarketCalendar)
   * 3. Is current time within trading hours? (10:00–14:00 CAT)
   */
  async isMarketOpen(): Promise<boolean> {
    const now = new Date();
    const catOffset = 2; // CAT = UTC+2
    const catHour = (now.getUTCHours() + catOffset) % 24;
    const catDay = now.getUTCDay(); // 0=Sun, 6=Sat

    // Weekend check
    if (catDay === 0 || catDay === 6) {
      return false;
    }

    // Holiday check
    const calendar = await this.repo.findMarketCalendarToday();
    if (calendar && calendar.status === 'HOLIDAY') {
      return false;
    }
    if (calendar && calendar.status === 'HALTED') {
      return false;
    }

    // Parse configured trading hours (default: 10:00–14:00)
    const openHour = parseInt(this.config.market.openTime.split(':')[0], 10) || 10;
    const closeHour = parseInt(this.config.market.closeTime.split(':')[0], 10) || 14;

    return catHour >= openHour && catHour < closeHour;
  }

  /**
   * Get the current market price for a stock.
   * Returns the most recent closing price from StockPrice.
   */
  async getCurrentPrice(stockId: string): Promise<Decimal | null> {
    const stock = await this.repo.findStockById(stockId);
    if (!stock || stock.prices.length === 0) {
      return null;
    }
    return stock.prices[0].closePrice;
  }

  /**
   * MSE tick size rules. The minimum price increment depends on
   * the stock's current price level:
   *
   * Price < K10:    tick = K0.01
   * K10 – K100:     tick = K0.05
   * K100 – K1000:   tick = K0.10
   * Price > K1000:  tick = K1.00
   */
  getTickSize(price: Decimal): Decimal {
    if (price.lt(new Decimal(10))) return new Decimal('0.01');
    if (price.lt(new Decimal(100))) return new Decimal('0.05');
    if (price.lt(new Decimal(1000))) return new Decimal('0.10');
    return new Decimal('1.00');
  }

  /**
   * Validate that a limit price conforms to the tick size.
   */
  isValidTickPrice(price: Decimal): boolean {
    const tick = this.getTickSize(price);
    // Price should be evenly divisible by tick size
    return price.mod(tick).eq(new Decimal(0));
  }
}
