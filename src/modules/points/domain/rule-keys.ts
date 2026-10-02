/**
 * Every way a Pine Point can be earned.
 *
 * Its own file so the catalogue, the listeners and the dedupe-key builders
 * can all name a rule without importing each other.
 */
export const RULE_KEYS = [
  'SIGN_UP',
  'PROFILE_EMAIL_VERIFIED',
  'DEPOSIT_FUNDS',
  'BUY_STOCK',
  'SELL_STOCK',
  'USE_COMPARE_TOOL',
  'COMPLETE_LESSON',
  'DAILY_CHECK_IN',
  'STREAK_BONUS_3',
  'STREAK_BONUS_7',
  'STREAK_BONUS_30',
  'NOTIFICATION_OPEN_FAST',
  'MILESTONE_FIRST_TRADE',
  'MILESTONE_THREE_STOCKS',
  'MILESTONE_FIVE_STOCKS',
  'MILESTONE_ALL_LESSONS',
  /** Manual correction by a platform admin. Never in the public catalogue. */
  'ADMIN_ADJUSTMENT',
] as const;

export type RuleKey = (typeof RULE_KEYS)[number];

export type RuleGroup =
  | 'GETTING_STARTED'
  | 'TRADING'
  | 'LEARNING'
  | 'HABITS'
  | 'MILESTONES';

/** Why an award did not happen. Returned to the app so it can say so. */
export type AwardRejection =
  | 'DISABLED'
  | 'NO_SEASON'
  | 'SEASON_CLOSED'
  | 'DUPLICATE'
  | 'CAPPED'
  | 'ALREADY_EARNED'
  | 'NOT_ELIGIBLE';
