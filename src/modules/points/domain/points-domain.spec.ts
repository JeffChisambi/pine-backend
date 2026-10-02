import { describe, expect, it } from 'vitest';
import { dedupeKeys } from './dedupe-keys';
import { daysBetween, toMalawiDay, toMalawiDayString } from './malawi-day';
import {
  PUBLIC_RULE_ORDER,
  RULE_CATALOGUE,
  getRule,
} from './rule-catalogue';
import { RULE_KEYS, RuleKey } from './rule-keys';

describe('malawi-day', () => {
  // Blantyre is UTC+2. These two assertions are the whole reason the helper
  // exists: an award at 22:30 UTC belongs to TOMORROW in Malawi, and one at
  // 21:30 UTC still belongs to today. Getting this wrong hands out two days'
  // worth of daily caps within two hours every night.
  it('rolls over at Malawi midnight, not UTC midnight', () => {
    expect(toMalawiDayString(new Date('2026-10-02T22:30:00Z'))).toBe('2026-10-03');
    expect(toMalawiDayString(new Date('2026-10-02T21:30:00Z'))).toBe('2026-10-02');
  });

  it('treats the whole Malawi day as one day', () => {
    const early = toMalawiDay(new Date('2026-10-02T22:10:00Z')); // 00:10 local
    const late = toMalawiDay(new Date('2026-10-03T21:50:00Z')); // 23:50 local
    expect(early.getTime()).toBe(late.getTime());
  });

  it('returns UTC midnight, which is what a DATE column stores', () => {
    const day = toMalawiDay(new Date('2026-10-02T09:00:00Z'));
    expect(day.toISOString()).toBe('2026-10-02T00:00:00.000Z');
  });

  it('counts whole days between two days', () => {
    const a = toMalawiDay(new Date('2026-10-01T09:00:00Z'));
    const b = toMalawiDay(new Date('2026-10-02T09:00:00Z'));
    expect(daysBetween(a, b)).toBe(1);
    expect(daysBetween(b, a)).toBe(-1);
    expect(daysBetween(a, a)).toBe(0);
  });
});

describe('dedupe keys', () => {
  it('gives a deposit one key per day, so extra deposits cannot score', () => {
    expect(dedupeKeys.deposit('u1', '2026-10-02')).toBe(
      dedupeKeys.deposit('u1', '2026-10-02'),
    );
    expect(dedupeKeys.deposit('u1', '2026-10-02')).not.toBe(
      dedupeKeys.deposit('u1', '2026-10-03'),
    );
  });

  it('gives each trade its own key, so a replayed settlement cannot score twice', () => {
    expect(dedupeKeys.sell('trade-1')).not.toBe(dedupeKeys.sell('trade-2'));
    expect(dedupeKeys.sell('trade-1')).toBe(dedupeKeys.sell('trade-1'));
  });

  it('treats a compared pair as the same claim in either order', () => {
    expect(dedupeKeys.compare('u1', 'NBM', 'TNM', '2026-10-02')).toBe(
      dedupeKeys.compare('u1', 'TNM', 'NBM', '2026-10-02'),
    );
    expect(dedupeKeys.compare('u1', 'nbm', 'tnm', '2026-10-02')).toBe(
      dedupeKeys.compare('u1', 'NBM', 'TNM', '2026-10-02'),
    );
  });

  it('keys a lesson to the person, not the device', () => {
    expect(dedupeKeys.lesson('u1', 'what-is-a-stock')).toBe(
      dedupeKeys.lesson('u1', 'what-is-a-stock'),
    );
    expect(dedupeKeys.lesson('u1', 'what-is-a-stock')).not.toBe(
      dedupeKeys.lesson('u2', 'what-is-a-stock'),
    );
  });

  it('lets a rebuilt streak pay again, but only on a later attainment', () => {
    expect(dedupeKeys.streak('u1', 3, 1)).not.toBe(dedupeKeys.streak('u1', 3, 2));
  });

  it('never collides across rules for one user on one day', () => {
    const keys = [
      dedupeKeys.signUp('u1'),
      dedupeKeys.deposit('u1', '2026-10-02'),
      dedupeKeys.checkIn('u1', '2026-10-02'),
      dedupeKeys.compare('u1', 'NBM', 'TNM', '2026-10-02'),
      dedupeKeys.buy('t1'),
      dedupeKeys.sell('t1'),
      dedupeKeys.lesson('u1', 'market-indices'),
      dedupeKeys.notificationOpen('n1'),
      dedupeKeys.milestone('u1', 'MILESTONE_FIRST_TRADE', 's1'),
      dedupeKeys.profile('u1', 'email', 's1'),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives a buy and a sell of the same trade different keys', () => {
    expect(dedupeKeys.buy('t1')).not.toBe(dedupeKeys.sell('t1'));
  });
});

describe('rule catalogue', () => {
  it('describes every rule key', () => {
    for (const key of RULE_KEYS) {
      expect(getRule(key as RuleKey), key).toBeDefined();
      expect(getRule(key as RuleKey).key).toBe(key);
    }
  });

  it('uses the values the competition was announced with', () => {
    expect(RULE_CATALOGUE.SIGN_UP.points).toBe(10);
    expect(RULE_CATALOGUE.DEPOSIT_FUNDS.points).toBe(15);
    expect(RULE_CATALOGUE.SELL_STOCK.points).toBe(15);
    expect(RULE_CATALOGUE.NOTIFICATION_OPEN_FAST.points).toBe(20);
    expect(RULE_CATALOGUE.COMPLETE_LESSON.points).toBe(30);
  });

  // The anti-farming invariant. Practice orders fill instantly, so a round
  // trip costs a second; if a sell paid more than a buy, churning would be a
  // profit centre. The overnight rule in the listener is the other half.
  it('never makes a round trip pay more than buying and holding', () => {
    expect(RULE_CATALOGUE.BUY_STOCK.points).toBeGreaterThan(
      RULE_CATALOGUE.SELL_STOCK.points,
    );
  });

  it('caps or one-times every rule a user can trigger at will', () => {
    for (const key of PUBLIC_RULE_ORDER) {
      const rule = RULE_CATALOGUE[key];
      expect(rule.dailyCap !== null || rule.oneTime, `${key} is uncapped`).toBe(true);
    }
  });

  it('writes both languages for every public rule', () => {
    for (const key of PUBLIC_RULE_ORDER) {
      const rule = RULE_CATALOGUE[key];
      expect(rule.title.en.length, key).toBeGreaterThan(0);
      expect(rule.title.ny.length, key).toBeGreaterThan(0);
      expect(rule.hint.en.length, key).toBeGreaterThan(0);
      expect(rule.hint.ny.length, key).toBeGreaterThan(0);
    }
  });

  it('keeps the admin adjustment out of what the app advertises', () => {
    expect(PUBLIC_RULE_ORDER).not.toContain('ADMIN_ADJUSTMENT');
  });

  it('shows every rule a user can earn', () => {
    const earnable = RULE_KEYS.filter((k) => k !== 'ADMIN_ADJUSTMENT');
    expect([...PUBLIC_RULE_ORDER].sort()).toEqual([...earnable].sort());
  });
});
