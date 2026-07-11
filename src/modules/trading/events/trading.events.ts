/**
 * Trading Domain Events
 *
 * Published via NestJS EventEmitter (global). Subscribers in other
 * modules (ledger, portfolio, notifications, audit) listen without
 * creating a hard dependency on the trading module.
 *
 * Convention: event names are dot-separated, e.g. 'trading.order.created'.
 */

export class OrderCreatedEvent {
  static readonly event = 'trading.order.created';
  constructor(
    public readonly orderId: string,
    public readonly userId: string,
    public readonly stockSymbol: string,
    public readonly side: 'BUY' | 'SELL',
    public readonly quantity: number,
    public readonly orderType: 'MARKET' | 'LIMIT',
  ) {}
}

export class OrderValidatedEvent {
  static readonly event = 'trading.order.validated';
  constructor(
    public readonly orderId: string,
    public readonly userId: string,
  ) {}
}

export class OrderRejectedEvent {
  static readonly event = 'trading.order.rejected';
  constructor(
    public readonly orderId: string,
    public readonly userId: string,
    public readonly reason: string,
  ) {}
}

export class OrderSubmittedEvent {
  static readonly event = 'trading.order.submitted';
  constructor(
    public readonly orderId: string,
    public readonly userId: string,
    public readonly brokerRef: string | null,
  ) {}
}

export class OrderExecutedEvent {
  static readonly event = 'trading.order.executed';
  constructor(
    public readonly orderId: string,
    public readonly userId: string,
    public readonly stockId: string,
    public readonly stockSymbol: string,
    public readonly side: 'BUY' | 'SELL',
    public readonly quantity: number,
    public readonly price: number,
    public readonly totalFees: number,
    public readonly totalCost: number,
    public readonly tradeId: string,
  ) {}
}

export class TradeSettledEvent {
  static readonly event = 'trading.trade.settled';
  constructor(
    public readonly tradeId: string,
    public readonly orderId: string,
    public readonly userId: string,
    public readonly stockId: string,
    public readonly side: 'BUY' | 'SELL',
    public readonly quantity: number,
    public readonly price: number,
    public readonly settlementId: string,
  ) {}
}

export class OrderCancelledEvent {
  static readonly event = 'trading.order.cancelled';
  constructor(
    public readonly orderId: string,
    public readonly userId: string,
    public readonly reason: string,
  ) {}
}

export class PortfolioUpdatedEvent {
  static readonly event = 'trading.portfolio.updated';
  constructor(
    public readonly userId: string,
    public readonly stockId: string,
    public readonly stockSymbol: string,
    public readonly newQuantity: number,
    public readonly averageCost: number,
  ) {}
}
