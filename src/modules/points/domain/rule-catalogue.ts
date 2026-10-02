import { RuleGroup, RuleKey } from './rule-keys';

/**
 * What every rule is worth, and how often it may be earned.
 *
 * This lives in code rather than the database on purpose. A rule is two
 * halves: what it pays, and the condition that earns it. The condition is a
 * listener or a claim handler — code, reviewed in a diff. If the amount lived
 * in a table, someone could set a sell to 9,999 points in a competition with
 * cash prizes and no one would see a change. Keeping both halves together
 * means a points change is reviewed like any other change, and the catalogue
 * can be unit-tested. The season window, which genuinely is operational data,
 * is a database row instead.
 *
 * The mobile earn screen renders entirely from this, served by
 * GET /points/rules, so the app ships no points values of its own and a
 * change here reaches every installed copy without an app release.
 */
export interface PointRule {
  key: RuleKey;
  points: number;
  /** Most awards of this rule in one Malawi day. null means no limit. */
  dailyCap: number | null;
  /** True when it can be earned at most once per person per season. */
  oneTime: boolean;
  title: Record<'en' | 'ny', string>;
  hint: Record<'en' | 'ny', string>;
  /** Icon name the app maps to its own artwork. */
  icon: string;
  group: RuleGroup;
}

/**
 * Buying is worth MORE than selling, deliberately. Practice orders fill
 * instantly, so a buy-then-sell round trip costs one second; pricing the sell
 * below the buy means the round trip is never a better deal than simply
 * buying and holding. The overnight condition on SELL_STOCK (enforced in the
 * listener, not here) is what actually makes wash trading pointless.
 */
export const RULE_CATALOGUE: Readonly<Record<RuleKey, PointRule>> = Object.freeze({
  SIGN_UP: {
    key: 'SIGN_UP',
    points: 10,
    dailyCap: 1,
    oneTime: true,
    title: { en: 'Create your account', ny: 'Pangani akaunti yanu' },
    hint: { en: 'Awarded once when you join Pine.', ny: 'Mumalandira kamodzi mukalowa mu Pine.' },
    icon: 'user',
    group: 'GETTING_STARTED',
  },
  PROFILE_EMAIL_VERIFIED: {
    key: 'PROFILE_EMAIL_VERIFIED',
    points: 10,
    dailyCap: 1,
    oneTime: true,
    title: { en: 'Verify your email', ny: 'Tsimikizani imelo yanu' },
    hint: { en: 'Once, after you confirm your email address.', ny: 'Kamodzi, mukatsimikiza imelo yanu.' },
    icon: 'mail',
    group: 'GETTING_STARTED',
  },
  PROFILE_PHONE_VERIFIED: {
    key: 'PROFILE_PHONE_VERIFIED',
    points: 10,
    dailyCap: 1,
    oneTime: true,
    title: { en: 'Verify your phone number', ny: 'Tsimikizani nambala yanu ya foni' },
    hint: { en: 'Once, after you confirm your number.', ny: 'Kamodzi, mukatsimikiza nambala yanu.' },
    icon: 'phone',
    group: 'GETTING_STARTED',
  },
  PROFILE_AVATAR_SET: {
    key: 'PROFILE_AVATAR_SET',
    points: 10,
    dailyCap: 1,
    oneTime: true,
    title: { en: 'Add a profile photo', ny: 'Ikani chithunzi chanu' },
    hint: { en: 'Once, the first time you set a photo.', ny: 'Kamodzi, mukaika chithunzi koyamba.' },
    icon: 'camera',
    group: 'GETTING_STARTED',
  },
  DEPOSIT_FUNDS: {
    key: 'DEPOSIT_FUNDS',
    points: 15,
    dailyCap: 1,
    oneTime: false,
    title: { en: 'Add practice money', ny: 'Onjezani ndalama zochitira masewera' },
    hint: {
      en: 'Once a day, for a deposit of MK 1,000 or more.',
      ny: 'Kamodzi patsiku, ndalama zoyambira MK 1,000.',
    },
    icon: 'wallet',
    group: 'TRADING',
  },
  BUY_STOCK: {
    key: 'BUY_STOCK',
    points: 20,
    dailyCap: 2,
    oneTime: false,
    title: { en: 'Buy a stock', ny: 'Gulani sheya' },
    hint: { en: 'Up to twice a day, MK 1,000 or more each time.', ny: 'Kawiri patsiku, MK 1,000 kapena kuposa.' },
    icon: 'trendUp',
    group: 'TRADING',
  },
  SELL_STOCK: {
    key: 'SELL_STOCK',
    points: 15,
    dailyCap: 2,
    oneTime: false,
    title: { en: 'Sell a stock you have held', ny: 'Gulitsani sheya yomwe munagula kale' },
    hint: {
      en: 'Up to twice a day. The stock must have been bought on an earlier day.',
      ny: 'Kawiri patsiku. Sheya iyenera kuti munaigula tsiku linalake lapitalo.',
    },
    icon: 'trendDown',
    group: 'TRADING',
  },
  USE_COMPARE_TOOL: {
    key: 'USE_COMPARE_TOOL',
    points: 5,
    dailyCap: 1,
    oneTime: false,
    title: { en: 'Compare two stocks', ny: 'Yerekezerani masheya awiri' },
    hint: { en: 'Once a day, for any pair.', ny: 'Kamodzi patsiku, pa masheya aliwonse awiri.' },
    icon: 'compare',
    group: 'LEARNING',
  },
  COMPLETE_LESSON: {
    key: 'COMPLETE_LESSON',
    points: 30,
    dailyCap: 2,
    oneTime: false,
    title: { en: 'Finish a lesson', ny: 'Malizitsani phunziro' },
    hint: {
      en: 'Up to two lessons a day. Each lesson counts once.',
      ny: 'Maphunziro awiri patsiku. Phunziro lililonse limawerengedwa kamodzi.',
    },
    icon: 'book',
    group: 'LEARNING',
  },
  DAILY_CHECK_IN: {
    key: 'DAILY_CHECK_IN',
    points: 5,
    dailyCap: 1,
    oneTime: false,
    title: { en: 'Open Pine today', ny: 'Tsegulani Pine lero' },
    hint: { en: 'Once a day, just for showing up.', ny: 'Kamodzi patsiku, chifukwa chongobwera.' },
    icon: 'calendar',
    group: 'HABITS',
  },
  STREAK_BONUS_3: {
    key: 'STREAK_BONUS_3',
    points: 10,
    dailyCap: 1,
    oneTime: false,
    title: { en: 'Three days in a row', ny: 'Masiku atatu motsatana' },
    hint: { en: 'A bonus when your streak reaches three days.', ny: 'Mphatso mukafika masiku atatu motsatana.' },
    icon: 'flame',
    group: 'HABITS',
  },
  STREAK_BONUS_7: {
    key: 'STREAK_BONUS_7',
    points: 25,
    dailyCap: 1,
    oneTime: false,
    title: { en: 'Seven days in a row', ny: 'Masiku asanu ndi awiri motsatana' },
    hint: { en: 'A bonus when your streak reaches a week.', ny: 'Mphatso mukafika sabata limodzi.' },
    icon: 'flame',
    group: 'HABITS',
  },
  STREAK_BONUS_30: {
    key: 'STREAK_BONUS_30',
    points: 100,
    dailyCap: 1,
    oneTime: false,
    title: { en: 'Thirty days in a row', ny: 'Masiku makumi atatu motsatana' },
    hint: { en: 'A bonus every thirty days you keep the streak alive.', ny: 'Mphatso masiku 30 aliwonse mosalekeza.' },
    icon: 'flame',
    group: 'HABITS',
  },
  NOTIFICATION_OPEN_FAST: {
    key: 'NOTIFICATION_OPEN_FAST',
    points: 20,
    dailyCap: 1,
    oneTime: false,
    title: { en: 'Answer an alert quickly', ny: 'Yankhani uthenga mwachangu' },
    hint: {
      en: 'Once a day, when you open Pine within a minute of an alert.',
      ny: 'Kamodzi patsiku, mukatsegula Pine mkati mwa mphindi imodzi.',
    },
    icon: 'bell',
    group: 'HABITS',
  },
  MILESTONE_FIRST_TRADE: {
    key: 'MILESTONE_FIRST_TRADE',
    points: 50,
    dailyCap: 1,
    oneTime: true,
    title: { en: 'Your first trade', ny: 'Malonda anu oyamba' },
    hint: { en: 'Awarded once, for your very first trade.', ny: 'Mumalandira kamodzi, pa malonda anu oyamba.' },
    icon: 'star',
    group: 'MILESTONES',
  },
  MILESTONE_THREE_STOCKS: {
    key: 'MILESTONE_THREE_STOCKS',
    points: 75,
    dailyCap: 1,
    oneTime: true,
    title: { en: 'Hold three different stocks', ny: 'Khalani ndi masheya atatu osiyana' },
    hint: { en: 'Awarded once, for spreading your money around.', ny: 'Kamodzi, chifukwa chogawa ndalama zanu.' },
    icon: 'layers',
    group: 'MILESTONES',
  },
  MILESTONE_FIVE_STOCKS: {
    key: 'MILESTONE_FIVE_STOCKS',
    points: 150,
    dailyCap: 1,
    oneTime: true,
    title: { en: 'Hold five different stocks', ny: 'Khalani ndi masheya asanu osiyana' },
    hint: { en: 'Awarded once, for a properly varied portfolio.', ny: 'Kamodzi, chifukwa cha potifoliyo yosiyanasiyana.' },
    icon: 'layers',
    group: 'MILESTONES',
  },
  MILESTONE_ALL_LESSONS: {
    key: 'MILESTONE_ALL_LESSONS',
    points: 200,
    dailyCap: 1,
    oneTime: true,
    title: { en: 'Finish the whole course', ny: 'Malizitsani maphunziro onse' },
    hint: { en: 'Awarded once, when every lesson is done.', ny: 'Kamodzi, mukamaliza maphunziro onse.' },
    icon: 'graduationCap',
    group: 'MILESTONES',
  },
  ADMIN_ADJUSTMENT: {
    key: 'ADMIN_ADJUSTMENT',
    points: 0,
    dailyCap: null,
    oneTime: false,
    title: { en: 'Adjustment by Pine', ny: 'Kusintha kochokera kwa Pine' },
    hint: { en: 'A manual correction.', ny: 'Kukonza kwa manja.' },
    icon: 'settings',
    group: 'MILESTONES',
  },
});

/** Rules the app shows on the earn screen, in display order. */
export const PUBLIC_RULE_ORDER: RuleKey[] = [
  'SIGN_UP',
  'PROFILE_PHONE_VERIFIED',
  'PROFILE_EMAIL_VERIFIED',
  'PROFILE_AVATAR_SET',
  'DEPOSIT_FUNDS',
  'BUY_STOCK',
  'SELL_STOCK',
  'COMPLETE_LESSON',
  'USE_COMPARE_TOOL',
  'DAILY_CHECK_IN',
  'STREAK_BONUS_3',
  'STREAK_BONUS_7',
  'STREAK_BONUS_30',
  'NOTIFICATION_OPEN_FAST',
  'MILESTONE_FIRST_TRADE',
  'MILESTONE_THREE_STOCKS',
  'MILESTONE_FIVE_STOCKS',
  'MILESTONE_ALL_LESSONS',
];

export const GROUP_TITLES: Record<RuleGroup, Record<'en' | 'ny', string>> = {
  GETTING_STARTED: { en: 'Getting started', ny: 'Kuyamba' },
  TRADING: { en: 'Trading', ny: 'Malonda' },
  LEARNING: { en: 'Learning', ny: 'Kuphunzira' },
  HABITS: { en: 'Everyday habits', ny: 'Zochita tsiku ndi tsiku' },
  MILESTONES: { en: 'Milestones', ny: 'Zopambana' },
};

/** The prizes, served to the app so the copy lives in one place. */
export const PRIZES = [
  { rank: 1, label: { en: 'MWK 100,000', ny: 'MWK 100,000' } },
  {
    rank: 2,
    label: {
      en: 'MWK 50,000 of investing on Pine',
      ny: 'MWK 50,000 yoyika ndalama mu Pine',
    },
  },
  { rank: 3, label: { en: 'Pine branded merchandise', ny: 'Zovala za Pine' } },
] as const;

/** The smallest deposit or trade that earns points, in kwacha. */
export const MIN_SCORING_NOTIONAL = 1_000;

export function getRule(key: RuleKey): PointRule {
  return RULE_CATALOGUE[key];
}
