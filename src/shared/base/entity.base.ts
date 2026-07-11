import type { DomainEvent } from './domain-event.base';

/**
 * Base for every domain entity across every module. Identity-based
 * equality (two entities are equal if their IDs match, regardless of
 * attribute values) — the defining property of an Entity vs a Value
 * Object (see `shared/money/money.ts` for a Value Object example).
 */
export abstract class Entity<Id> {
  protected readonly _id: Id;

  protected constructor(id: Id) {
    this._id = id;
  }

  get id(): Id {
    return this._id;
  }

  equals(other?: Entity<Id>): boolean {
    if (other === null || other === undefined) return false;
    if (this === other) return true;
    return this._id === other._id;
  }
}

/**
 * An Entity that is the root of a consistency boundary (an "aggregate"
 * in DDD terms — e.g. `Wallet`, `Order`, `KycApplication`). Only
 * aggregate roots are loaded/saved directly by repositories; anything
 * nested inside one is modified only through the root's methods so
 * invariants (e.g. "balance never goes negative") can't be bypassed.
 *
 * Aggregate roots accumulate domain events as they mutate; the
 * repository/unit-of-work layer collects and dispatches them (via
 * `@nestjs/event-emitter`, wired in `app.module.ts`) after the DB
 * transaction that persisted the change commits successfully — never
 * before, so a consumer never reacts to a change that then gets
 * rolled back.
 */
export abstract class AggregateRoot<Id> extends Entity<Id> {
  private _domainEvents: DomainEvent[] = [];

  protected addDomainEvent(event: DomainEvent): void {
    this._domainEvents.push(event);
  }

  pullDomainEvents(): DomainEvent[] {
    const events = this._domainEvents;
    this._domainEvents = [];
    return events;
  }
}
