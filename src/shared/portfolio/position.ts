import { Decimal } from '@prisma/client/runtime/library';

/**
 * A position in one stock, under the weighted-average cost method.
 *
 * Two averages are kept because they answer different questions:
 *
 *   averagePrice  what the shares cost at the exchange, before fees. This is
 *                 the basis for price gain or loss: if the market price is
 *                 unchanged since purchase, the investor has made nothing and
 *                 lost nothing on price.
 *   averageCost   what the investor actually paid per share, fees included.
 *                 This is the basis for the result after costs.
 *
 * Before this split there was only averageCost, and every purchase showed an
 * immediate loss equal to the buying fees — about 2.6% on the MSE — which read
 * as the stock falling.
 *
 * Selling does not change either average (that is what the average method
 * means); it realises the difference between the sale and the average on the
 * shares sold. When a position is sold down to nothing, the next purchase
 * starts the averages afresh.
 */
export interface Position {
  quantity: Decimal;
  averagePrice: Decimal;
  averageCost: Decimal;
  /** Cumulative realised result after all costs: net proceeds − average cost. */
  realizedPnl: Decimal;
  /** Cumulative realised price result: (sale price − average price) × quantity. */
  realizedPricePnl: Decimal;
}

export interface TradeFill {
  side: 'BUY' | 'SELL';
  quantity: Decimal;
  /** Execution price per share at the exchange. */
  price: Decimal;
  /** Every cost charged on this fill: commission, levies, platform fee. */
  fees: Decimal;
}

export const ZERO = new Decimal(0);

export function emptyPosition(): Position {
  return {
    quantity: ZERO,
    averagePrice: ZERO,
    averageCost: ZERO,
    realizedPnl: ZERO,
    realizedPricePnl: ZERO,
  };
}

export function applyTrade(position: Position, fill: TradeFill): Position {
  if (fill.quantity.lte(0)) throw new Error('A fill must have a positive quantity');

  if (fill.side === 'BUY') {
    // Starting from nothing means starting fresh, whatever the stale averages say.
    const held = position.quantity.gt(0) ? position.quantity : ZERO;
    const quantity = held.add(fill.quantity);
    const gross = fill.quantity.mul(fill.price);
    return {
      ...position,
      quantity,
      averagePrice: held.mul(position.averagePrice).add(gross).div(quantity),
      averageCost: held.mul(position.averageCost).add(gross).add(fill.fees).div(quantity),
    };
  }

  if (fill.quantity.gt(position.quantity)) {
    throw new Error(
      `Cannot sell ${fill.quantity.toString()} shares from a position of ${position.quantity.toString()}`,
    );
  }
  const proceeds = fill.quantity.mul(fill.price).sub(fill.fees);
  return {
    quantity: position.quantity.sub(fill.quantity),
    averagePrice: position.averagePrice,
    averageCost: position.averageCost,
    realizedPnl: position.realizedPnl.add(proceeds.sub(fill.quantity.mul(position.averageCost))),
    realizedPricePnl: position.realizedPricePnl.add(
      fill.quantity.mul(fill.price.sub(position.averagePrice)),
    ),
  };
}

/** Replays a position's whole history, oldest fill first. */
export function replayPosition(fills: TradeFill[]): Position {
  return fills.reduce(applyTrade, emptyPosition());
}
