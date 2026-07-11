/**
 * Order Lifecycle State Machine
 *
 * Defines all valid state transitions for an order. Every status
 * change MUST go through `canTransition()` before mutating — this
 * prevents impossible states like FILLED → DRAFT.
 *
 * Happy path:
 *   DRAFT → PENDING_VALIDATION → VALIDATED → SUBMITTED → ACCEPTED
 *   → FILLED → PENDING_SETTLEMENT → SETTLED → COMPLETED
 *
 * Partial fill path:
 *   ... → ACCEPTED → PARTIALLY_FILLED → FILLED → ...
 *
 * Terminal states (no further transitions):
 *   COMPLETED, REJECTED, CANCELLED, EXPIRED
 */

export enum OrderLifecycleStatus {
  DRAFT = 'DRAFT',
  PENDING_VALIDATION = 'PENDING_VALIDATION',
  VALIDATED = 'VALIDATED',
  SUBMITTED = 'SUBMITTED',
  ACCEPTED = 'ACCEPTED',
  PARTIALLY_FILLED = 'PARTIALLY_FILLED',
  FILLED = 'FILLED',
  PENDING_SETTLEMENT = 'PENDING_SETTLEMENT',
  SETTLED = 'SETTLED',
  COMPLETED = 'COMPLETED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
  EXPIRED = 'EXPIRED',
}

/** Map of each state → set of states it can transition to. */
const TRANSITIONS: Record<OrderLifecycleStatus, ReadonlySet<OrderLifecycleStatus>> = {
  [OrderLifecycleStatus.DRAFT]: new Set([
    OrderLifecycleStatus.PENDING_VALIDATION,
    OrderLifecycleStatus.CANCELLED,
  ]),
  [OrderLifecycleStatus.PENDING_VALIDATION]: new Set([
    OrderLifecycleStatus.VALIDATED,
    OrderLifecycleStatus.REJECTED,
    OrderLifecycleStatus.CANCELLED,
  ]),
  [OrderLifecycleStatus.VALIDATED]: new Set([
    OrderLifecycleStatus.SUBMITTED,
    OrderLifecycleStatus.REJECTED,
    OrderLifecycleStatus.CANCELLED,
  ]),
  [OrderLifecycleStatus.SUBMITTED]: new Set([
    OrderLifecycleStatus.ACCEPTED,
    OrderLifecycleStatus.REJECTED,
    OrderLifecycleStatus.CANCELLED,
    OrderLifecycleStatus.EXPIRED,
  ]),
  [OrderLifecycleStatus.ACCEPTED]: new Set([
    OrderLifecycleStatus.PARTIALLY_FILLED,
    OrderLifecycleStatus.FILLED,
    OrderLifecycleStatus.CANCELLED,
    OrderLifecycleStatus.EXPIRED,
  ]),
  [OrderLifecycleStatus.PARTIALLY_FILLED]: new Set([
    OrderLifecycleStatus.PARTIALLY_FILLED, // additional fills
    OrderLifecycleStatus.FILLED,
    OrderLifecycleStatus.CANCELLED,
  ]),
  [OrderLifecycleStatus.FILLED]: new Set([
    OrderLifecycleStatus.PENDING_SETTLEMENT,
  ]),
  [OrderLifecycleStatus.PENDING_SETTLEMENT]: new Set([
    OrderLifecycleStatus.SETTLED,
  ]),
  [OrderLifecycleStatus.SETTLED]: new Set([
    OrderLifecycleStatus.COMPLETED,
  ]),
  // Terminal states — no outgoing transitions
  [OrderLifecycleStatus.COMPLETED]: new Set(),
  [OrderLifecycleStatus.REJECTED]: new Set(),
  [OrderLifecycleStatus.CANCELLED]: new Set(),
  [OrderLifecycleStatus.EXPIRED]: new Set(),
};

/** States where an order can still be cancelled by the user. */
export const CANCELLABLE_STATES = new Set<OrderLifecycleStatus>([
  OrderLifecycleStatus.DRAFT,
  OrderLifecycleStatus.PENDING_VALIDATION,
  OrderLifecycleStatus.VALIDATED,
  OrderLifecycleStatus.SUBMITTED,
]);

/** States considered "terminal" — no further transitions possible. */
export const TERMINAL_STATES = new Set<OrderLifecycleStatus>([
  OrderLifecycleStatus.COMPLETED,
  OrderLifecycleStatus.REJECTED,
  OrderLifecycleStatus.CANCELLED,
  OrderLifecycleStatus.EXPIRED,
]);

/** States considered "active" — order is in-flight. */
export const ACTIVE_STATES = new Set<OrderLifecycleStatus>([
  OrderLifecycleStatus.DRAFT,
  OrderLifecycleStatus.PENDING_VALIDATION,
  OrderLifecycleStatus.VALIDATED,
  OrderLifecycleStatus.SUBMITTED,
  OrderLifecycleStatus.ACCEPTED,
  OrderLifecycleStatus.PARTIALLY_FILLED,
]);

/**
 * Check whether transitioning from `from` → `to` is valid.
 */
export function canTransition(
  from: OrderLifecycleStatus,
  to: OrderLifecycleStatus,
): boolean {
  return TRANSITIONS[from]?.has(to) ?? false;
}

/**
 * Assert a transition is valid, throwing if not.
 * Used inside services before mutating order status.
 */
export function assertTransition(
  from: OrderLifecycleStatus,
  to: OrderLifecycleStatus,
): void {
  if (!canTransition(from, to)) {
    throw new Error(
      `Invalid order state transition: ${from} → ${to}`,
    );
  }
}
