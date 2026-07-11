/**
 * Single source of truth for BullMQ queue names. Producers (services)
 * and consumers (processors, registered per-module in later phases)
 * both import from here so a typo can never silently create two
 * different queues.
 */
export enum QueueName {
  EMAIL = 'email-queue',
  SMS = 'sms-queue',
  NOTIFICATION = 'notification-queue',
  TRADE_PROCESSING = 'trade-processing-queue',
  DIVIDEND = 'dividend-queue',
  KYC = 'kyc-queue',
  MARKET_SYNC = 'market-sync-queue',
  WEBHOOK = 'webhook-queue',
  AUDIT = 'audit-queue',
}

/**
 * Default BullMQ job options applied unless a producer overrides them.
 * Financial queues (trade processing, dividend) get more retries and
 * longer backoff since a dropped job there has direct monetary impact;
 * best-effort queues (notification) fail fast to avoid pointless churn.
 */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: { age: 86_400, count: 1_000 },
  removeOnFail: { age: 604_800 },
};

export const FINANCIAL_JOB_OPTIONS = {
  attempts: 8,
  backoff: { type: 'exponential' as const, delay: 10_000 },
  removeOnComplete: { age: 2_592_000, count: 10_000 },
  removeOnFail: false as const, // never auto-delete failed financial jobs — needs human review
};
