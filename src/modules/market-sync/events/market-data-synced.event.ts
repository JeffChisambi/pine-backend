import { DomainEvent } from '../../../shared/base/domain-event.base';

/**
 * Emitted after every successful market data sync. Other modules
 * (Portfolio for mark-to-market, Notifications for price alerts)
 * subscribe via `@OnEvent('market.data.synced')` without creating
 * a compile-time dependency on this module.
 */
export class MarketDataSyncedEvent extends DomainEvent {
  readonly eventName = 'market.data.synced';

  constructor(
    public readonly stockCount: number,
    public readonly syncDurationMs: number,
    public readonly trigger: 'cron' | 'manual' | 'retry',
    public readonly warnings: number,
  ) {
    // aggregateId is 'market-sync' — a singleton conceptual aggregate
    super('market-sync');
  }
}
