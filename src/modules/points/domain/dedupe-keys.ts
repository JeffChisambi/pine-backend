/**
 * Every idempotency key format in the engine, in one place.
 *
 * `point_events.dedupeKey` is uniquely indexed, so the shape of the key *is*
 * the rule about how often something can be earned. Two shapes matter:
 *
 *   - keyed by a source row (`sell:{tradeId}`) — the event can happen many
 *     times, but each occurrence scores once however often it is replayed;
 *   - keyed by a day (`deposit:{userId}:{day}`) — every occurrence after the
 *     first in a day is literally the same row and bounces off the index.
 *
 * Deposits use the day form on purpose: practice deposits are instant and
 * free, so keying by transaction would let a thousand one-kwacha deposits
 * score a thousand times.
 *
 * Collecting them here is what makes the idempotency story auditable — this
 * file is the whole answer to "can this be farmed?".
 */

export const dedupeKeys = {
  signUp: (userId: string) => `signup:${userId}`,

  profile: (userId: string, field: 'email' | 'phone' | 'avatar', seasonId: string) =>
    `profile:${field}:${userId}:${seasonId}`,

  /** Day-keyed: one deposit scores per day, however many are made. */
  deposit: (userId: string, day: string) => `deposit:${userId}:${day}`,

  /** Trade-keyed: a replayed settlement event cannot score twice. */
  buy: (tradeId: string) => `buy:${tradeId}`,
  sell: (tradeId: string) => `sell:${tradeId}`,

  /** Day-keyed, and the pair is sorted so A-vs-B and B-vs-A are one claim. */
  compare: (userId: string, a: string, b: string, day: string) => {
    const [first, second] = [a.toUpperCase(), b.toUpperCase()].sort();
    return `compare:${userId}:${first}:${second}:${day}`;
  },

  /** Lesson-keyed: each lesson scores once per person, ever. */
  lesson: (userId: string, lessonId: string) => `lesson:${userId}:${lessonId}`,

  checkIn: (userId: string, day: string) => `checkin:${userId}:${day}`,

  /** Keyed by the streak length AND how many times it has been reached, so a
   *  rebuilt streak can pay again — but only after the days are actually
   *  lived through. */
  streak: (userId: string, length: number, attainment: number) =>
    `streak:${length}:${userId}:${attainment}`,

  /** Notification-keyed: one notification is claimable once, ever. */
  notificationOpen: (notificationId: string) => `notif-open:${notificationId}`,

  /** One-time per season, so re-evaluating a milestone is free. */
  milestone: (userId: string, key: string, seasonId: string) =>
    `milestone:${key}:${userId}:${seasonId}`,

  /** Admin corrections are never deduped against anything. */
  adjustment: (id: string) => `adjust:${id}`,
};
