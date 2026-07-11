import { randomUUID } from 'node:crypto';

/**
 * Base for every domain event in the system (`UserRegistered`,
 * `KYCApproved`, `DepositCompleted`, `TradeExecuted`, ...). Concrete
 * events are defined per-module in `modules/<module>/events/` starting
 * Phase 2 and published via `EventEmitter2` (`@nestjs/event-emitter`,
 * synchronous, in-process fan-out) and/or a BullMQ queue (async,
 * durable, cross-process — e.g. `NOTIFICATION` or `AUDIT` queues) when
 * the side effect must survive a process restart.
 *
 * `eventName` is also used as the audit-log `action` where applicable
 * (Audit module, Phase 6) — keep it stable once shipped.
 */
export abstract class DomainEvent {
  public readonly eventId: string;
  public readonly occurredAt: Date;
  public readonly aggregateId: string;
  abstract readonly eventName: string;

  protected constructor(aggregateId: string) {
    this.eventId = randomUUID();
    this.occurredAt = new Date();
    this.aggregateId = aggregateId;
  }
}
