import { describe, expect, it } from 'vitest';
import { AggregateRoot, Entity } from './entity.base';
import { DomainEvent } from './domain-event.base';

class TestEvent extends DomainEvent {
  readonly eventName = 'TestEvent';

  constructor(aggregateId: string) {
    super(aggregateId);
  }
}

class TestEntity extends Entity<string> {
  constructor(id: string) {
    super(id);
  }
}

class TestAggregate extends AggregateRoot<string> {
  constructor(id: string) {
    super(id);
  }

  triggerEvent(): void {
    this.addDomainEvent(new TestEvent(this.id));
  }
}

describe('Entity', () => {
  it('is equal to another entity with the same id', () => {
    const a = new TestEntity('1');
    const b = new TestEntity('1');
    expect(a.equals(b)).toBe(true);
  });

  it('is not equal to an entity with a different id', () => {
    const a = new TestEntity('1');
    const b = new TestEntity('2');
    expect(a.equals(b)).toBe(false);
  });

  it('is not equal to undefined', () => {
    const a = new TestEntity('1');
    expect(a.equals(undefined)).toBe(false);
  });
});

describe('AggregateRoot', () => {
  it('accumulates and drains domain events exactly once', () => {
    const aggregate = new TestAggregate('agg-1');
    aggregate.triggerEvent();
    aggregate.triggerEvent();

    const events = aggregate.pullDomainEvents();
    expect(events).toHaveLength(2);
    expect(events[0].aggregateId).toBe('agg-1');

    // Pulling again returns nothing further — events are drained, not duplicated.
    expect(aggregate.pullDomainEvents()).toHaveLength(0);
  });
});
