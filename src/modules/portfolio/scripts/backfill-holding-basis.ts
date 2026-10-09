/**
 * Fills averagePrice, realizedPnl and realizedPricePnl on existing holdings
 * by replaying each one's trades through the same position logic settlement
 * now uses.
 *
 *   node dist/modules/portfolio/scripts/backfill-holding-basis.js [--apply]
 *
 * Dry run unless --apply. Safe to repeat: it recomputes from the trades
 * every time rather than adjusting what is there.
 *
 * A holding whose trades do not add up to its stored quantity was shaped by
 * something other than trading — a migration from another broker, a
 * corporate action, a manual correction. Its history cannot be reconstructed
 * from trades, so it is not rewritten from them: it gets averagePrice equal
 * to its averageCost (no fees can be separated out) and is listed for review.
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { AppModule } from '../../../app.module';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { replayPosition, type TradeFill } from '../../../shared/portfolio/position';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const logger = new Logger('backfill-holding-basis');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });

  try {
    const prisma = app.get(PrismaService);
    if (!apply) logger.warn('DRY RUN — pass --apply to write.');

    const holdings = await prisma.holding.findMany({
      select: { id: true, userId: true, stockId: true, quantity: true, averageCost: true, stock: { select: { symbol: true } } },
    });

    let replayed = 0;
    let unexplained = 0;
    for (const h of holdings) {
      const trades = await prisma.trade.findMany({
        where: { order: { userId: h.userId, stockId: h.stockId } },
        select: { quantity: true, price: true, fee: true, createdAt: true, order: { select: { side: true } } },
        orderBy: { createdAt: 'asc' },
      });

      const fills: TradeFill[] = trades.map((t) => ({
        side: t.order.side as 'BUY' | 'SELL',
        quantity: t.quantity,
        price: t.price,
        fees: t.fee,
      }));

      let position;
      try {
        position = replayPosition(fills);
      } catch {
        position = null;
      }

      const explained = position !== null && position.quantity.eq(h.quantity);
      const data = explained
        ? {
            averagePrice: position!.averagePrice,
            realizedPnl: position!.realizedPnl,
            realizedPricePnl: position!.realizedPricePnl,
          }
        : { averagePrice: h.averageCost, realizedPnl: new Decimal(0), realizedPricePnl: new Decimal(0) };

      if (explained) {
        replayed += 1;
        // The stored averageCost should agree with the replay; say so if not.
        if (h.quantity.gt(0) && position!.averageCost.sub(h.averageCost).abs().gt(0.01)) {
          logger.warn(
            `${h.stock.symbol} ${h.userId}: stored averageCost ${h.averageCost} vs replayed ${position!.averageCost.toFixed(4)}`,
          );
        }
      } else {
        unexplained += 1;
        logger.warn(
          `${h.stock.symbol} ${h.userId}: trades give ${position?.quantity.toString() ?? 'an invalid history'}, ` +
            `holding is ${h.quantity.toString()} — averagePrice set to averageCost for review`,
        );
      }

      logger.log(
        `${h.stock.symbol.padEnd(8)} qty ${h.quantity.toString().padStart(8)}  ` +
          `avgCost ${h.averageCost.toFixed(4)}  avgPrice ${new Decimal(data.averagePrice).toFixed(4)}  ` +
          `realised ${new Decimal(data.realizedPnl).toFixed(2)}`,
      );

      if (apply) await prisma.holding.update({ where: { id: h.id }, data });
    }

    logger.log(`${holdings.length} holdings: ${replayed} replayed from trades, ${unexplained} set aside for review`);
    logger.log(apply ? 'Backfill written.' : 'Dry run complete — nothing written.');
  } finally {
    await app.close();
  }
}

// Exit explicitly: the application context leaves timers and queue
// connections behind after close(), which otherwise keep a one-off container
// running indefinitely.
main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error('Backfill failed:', error);
  process.exit(1);
});
