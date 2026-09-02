#!/usr/bin/env node
/**
 * Financial architecture scenario tests (A–E) — run against the REAL stack.
 *
 * Creates an isolated FINTEST broker + investor + broker admin, then drives
 * the actual HTTP API (mobile surface + admin surface with real TOTP MFA)
 * through: fee configuration → deposit with processing fee → quoted buy →
 * queued-order execution → settlement → sell → cancellation → withdrawal
 * approval/rejection → dashboard aggregation → reconciliation. Every
 * money-moving step is then verified against the DATABASE (wallet, ledger
 * legs, trade breakdown, holdings) — the displayed numbers must derive
 * from those rows.
 *
 * Usage (inside the backend container, API reachable at API_BASE):
 *   API_BASE=http://appine-api:3000/v1 node scripts/finance-scenarios.mjs
 *   ... --keep   # skip cleanup (leave test rows for inspection)
 *
 * Exit code 0 = all scenarios passed. Non-zero = at least one assertion failed.
 */
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const argon2 = require('argon2');

const API = process.env.API_BASE ?? 'http://appine-api:3000/v1';
const KEEP = process.argv.includes('--keep');
const prisma = new PrismaClient();

// ── tiny test harness ────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];
function ok(cond, label, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual, expected, label, tolerance = 0.01) {
  const a = Number(actual), e = Number(expected);
  ok(Math.abs(a - e) <= tolerance, label, `expected ${e}, got ${a}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── HTTP helper (unwraps the {success, data} envelope) ───────
async function call(method, path, { token, pinToken, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(pinToken ? { 'x-pin-token': pinToken } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  const data = json?.data !== undefined ? json.data : json;
  return { status: res.status, data, raw: json };
}

// ── TOTP (RFC 6238, SHA1, 6 digits, 30s) ─────────────────────
function base32Decode(str) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0; const out = [];
  for (const ch of str.replace(/=+$/, '').toUpperCase()) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}
function totp(secret, offsetSteps = 0) {
  const counter = Math.floor(Date.now() / 30000) + offsetSteps;
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 0x0f;
  const code = ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
  return code;
}

// ── constants for the test fixture ───────────────────────────
const TAG = 'FINTEST';
const INVESTOR_EMAIL = 'fin.scenario.investor@appine.online';
const ADMIN_EMAIL = 'fin.scenario.broker@appine.online';
const SUPER_EMAIL = 'fin.scenario.super@appine.online';
const PASSWORD = 'Fin-Scenario-2026!x';
const PIN = '4321';
const DEPOSIT = 100_000;           // gross
const DEPOSIT_FEE_PCT = 2;         // configured below via the admin API
const TIER1 = { minAmount: 0, maxAmount: 100_000, ratePct: 2, minFee: 500 };
const TIER2 = { minAmount: 100_000, maxAmount: null, ratePct: 1.5, minFee: 500 };
const SEC = 0.001, MSE = 0.001;    // statutory

const commissionFor = (gross) => {
  const t = gross < TIER1.maxAmount ? TIER1 : TIER2; // half-open [min, max)
  return Math.max(gross * (t.ratePct / 100), t.minFee ?? 0);
};

async function main() {
  console.log(`\n━━ Financial scenario tests against ${API} ━━\n`);

  // ── 0. Fixture: broker + investor + broker admin ───────────
  console.log('— Fixture: isolated test broker, investor, broker admin');
  await cleanup(true); // remove leftovers from any previous run

  const broker = await prisma.broker.create({
    data: { name: `${TAG} Securities`, code: TAG, isActive: true },
  });
  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const pinHash = await argon2.hash(PIN, { type: argon2.argon2id });
  const investor = await prisma.user.create({
    data: {
      email: INVESTOR_EMAIL, phone: '+265990000901',
      firstName: 'Fin', lastName: 'Investor',
      role: 'CUSTOMER', kycStatus: 'APPROVED',
      isActive: true, emailVerifiedAt: new Date(), phoneVerifiedAt: new Date(),
      passwordHash, pinHash, brokerId: broker.id,
    },
  });
  const brokerAdmin = await prisma.user.create({
    data: {
      email: ADMIN_EMAIL, phone: '+265990000902',
      firstName: 'Fin', lastName: 'BrokerAdmin',
      role: 'BROKER', kycStatus: 'NOT_SUBMITTED',
      isActive: true, emailVerifiedAt: new Date(), phoneVerifiedAt: new Date(),
      passwordHash, brokerId: broker.id,
    },
  });
  // Test SUPER_ADMIN for platform-level (Pine) settings — no broker.
  await prisma.user.create({
    data: {
      email: SUPER_EMAIL, phone: '+265990000903',
      firstName: 'Fin', lastName: 'SuperAdmin',
      role: 'SUPER_ADMIN', kycStatus: 'NOT_SUBMITTED',
      isActive: true, emailVerifiedAt: new Date(), phoneVerifiedAt: new Date(),
      passwordHash,
    },
  });
  console.log(`  broker=${broker.id.slice(0, 8)} investor=${investor.id.slice(0, 8)} admin=${brokerAdmin.id.slice(0, 8)}`);

  // ── 1. Broker admin login with real MFA setup ──────────────
  console.log('\n— Admin surface: login + TOTP MFA setup via API');
  const login1 = await call('POST', '/admin/auth/login', { body: { email: ADMIN_EMAIL, password: PASSWORD } });
  ok(login1.status === 200 && login1.data?.mfaRequired === 'setup', 'admin login requires MFA setup', JSON.stringify(login1.raw)?.slice(0, 200));
  const setup = await call('POST', '/admin/auth/mfa/setup', { body: { mfaToken: login1.data.mfaToken } });
  ok(setup.status === 200 && !!setup.data?.secret, 'MFA setup returns TOTP secret');
  const confirm = await call('POST', '/admin/auth/mfa/confirm-setup', {
    body: { mfaToken: login1.data.mfaToken, code: totp(setup.data.secret) },
  });
  ok(confirm.status === 200 && !!confirm.data?.accessToken, 'MFA confirmed — admin tokens issued', JSON.stringify(confirm.raw)?.slice(0, 200));
  const adminToken = confirm.data.accessToken;

  // ── 2. Fees & Charges configuration via the admin API ──────
  console.log('\n— Fee configuration (Settings → Fees & Charges)');
  const putCfg = await call('PUT', '/admin/fees/config', {
    token: adminToken,
    body: {
      depositFeeEnabled: true, depositFeeKind: 'PERCENT', depositFeeValue: DEPOSIT_FEE_PCT,
      depositFeeDescription: 'Card processing fee',
      commissionEnabled: true, commissionTiers: [TIER1, TIER2],
    },
  });
  ok(putCfg.status === 200 && putCfg.data?.depositFeeEnabled === true, 'fee config saved', JSON.stringify(putCfg.raw)?.slice(0, 200));
  const badCfg = await call('PUT', '/admin/fees/config', {
    token: adminToken,
    body: {
      depositFeeEnabled: false, depositFeeKind: 'PERCENT', depositFeeValue: 0,
      commissionEnabled: true,
      commissionTiers: [ { minAmount: 0, maxAmount: 50_000, ratePct: 2 }, { minAmount: 40_000, maxAmount: null, ratePct: 1 } ],
    },
  });
  ok(badCfg.status >= 400, 'overlapping tiers rejected');

  // ── 3. Investor login ──────────────────────────────────────
  console.log('\n— Investor login (mobile surface)');
  const iLogin = await call('POST', '/auth/login', { body: { email: INVESTOR_EMAIL, password: PASSWORD } });
  ok(iLogin.status === 200 && !!iLogin.data?.accessToken, 'investor login', JSON.stringify(iLogin.raw)?.slice(0, 300));
  const iTok = iLogin.data.accessToken;

  // ── SCENARIO A: deposit with processing fee ────────────────
  console.log('\n━ Scenario A: deposit MK 100,000 with a 2% processing fee');
  const expFee = DEPOSIT * (DEPOSIT_FEE_PCT / 100);      // 2 000
  const expNet = DEPOSIT - expFee;                        // 98 000

  const prev = await call('GET', `/wallet/deposit/preview?amount=${DEPOSIT}`, { token: iTok });
  eq(prev.data?.processingFee, expFee, 'preview: processing fee = MK 2,000');
  eq(prev.data?.netAmount, expNet, 'preview: net credit = MK 98,000');

  const pay = await call('POST', '/payments/card/initiate', {
    token: iTok,
    body: {
      amount: DEPOSIT, currency: 'MWK',
      cardholderName: 'FIN INVESTOR', cardNumber: '4111111111111111',
      expiryMonth: '12', expiryYear: '29', cvv: '123',
      testScenario: 'success',
    },
  });
  ok(pay.status === 201 && /SUCCESS|COMPLETED/i.test(pay.data?.status ?? ''), 'test-card deposit succeeded', JSON.stringify(pay.raw)?.slice(0, 300));
  await sleep(1500);

  const wallet = await prisma.wallet.findUnique({ where: { userId: investor.id } });
  eq(wallet?.balance, expNet, 'DB: wallet credited NET (98,000)');
  const depTx = await prisma.transaction.findFirst({
    where: { walletId: wallet.id, type: 'DEPOSIT', status: 'COMPLETED' },
  });
  eq(depTx?.amount, expNet, 'DB: Transaction.amount = net');
  eq(depTx?.metadata?.processingFee, expFee, 'DB: metadata.processingFee = 2,000');
  eq(depTx?.metadata?.grossAmount, DEPOSIT, 'DB: metadata.grossAmount = 100,000');

  const legs = await prisma.ledgerEntry.findMany({ where: { transactionId: depTx.id } });
  const leg = (type) => legs.find((l) => l.accountType === type);
  eq(leg('USER_WALLET')?.amount, expNet, 'ledger: USER_WALLET credit = net');
  eq(leg('PLATFORM_CASH')?.amount, DEPOSIT, 'ledger: PLATFORM_CASH debit = gross');
  eq(leg('PLATFORM_FEE_REVENUE')?.amount, expFee, 'ledger: FEE_REVENUE credit = fee');
  const drCr = legs.reduce((s, l) => s + (l.direction === 'DEBIT' ? 1 : -1) * Number(l.amount), 0);
  eq(drCr, 0, 'ledger: debits = credits (balanced entry)');

  // ── SCENARIO B: quoted buy under the tier schedule ─────────
  console.log('\n━ Scenario B: buy order — quote matches execution charge');
  const stockRow = await prisma.$queryRaw`
    SELECT s.id, s.symbol, p."closePrice"::float AS price
    FROM "stocks" s
    JOIN LATERAL (
      SELECT "closePrice" FROM "stock_prices" WHERE "stockId" = s.id ORDER BY "tradedAt" DESC LIMIT 1
    ) p ON true
    WHERE s."isActive" = true AND p."closePrice" > 0
    ORDER BY p."closePrice" ASC LIMIT 1`;
  const stock = stockRow[0];
  ok(!!stock, `picked test stock ${stock?.symbol} @ MK ${stock?.price}`);
  const qty = Math.max(1, Math.floor(30_000 / stock.price));
  const gross = qty * stock.price;
  const expCommission = commissionFor(gross);
  const expLevies = gross * (SEC + MSE);
  const expTotal = gross + expCommission + expLevies;

  const quote = await call('GET', `/trading/quote?symbol=${stock.symbol}&quantity=${qty}&side=BUY`, { token: iTok });
  eq(quote.data?.grossValue, gross, `quote: gross = ${gross}`);
  eq(quote.data?.commission, expCommission, `quote: commission (tiered) = ${expCommission}`);
  eq(quote.data?.secLevy + quote.data?.mseLevy, expLevies, 'quote: levies = 0.2% of gross');
  eq(quote.data?.totalCost, expTotal, 'quote: total cost = gross + commission + levies');
  eq(quote.data?.remainingAfter, expNet - expTotal, 'quote: remaining balance after');

  const pin1 = await call('POST', '/auth/pin/verify', { token: iTok, body: { pin: PIN } });
  ok(!!pin1.data?.pinToken, 'PIN verified → pinToken');
  const buy = await call('POST', '/trading/buy', {
    token: iTok, pinToken: pin1.data.pinToken,
    body: { stockSymbol: stock.symbol, quantity: qty, orderType: 'MARKET', idempotencyKey: `${TAG}-buy-1` },
  });
  ok(buy.status === 201, 'buy order accepted', JSON.stringify(buy.raw)?.slice(0, 300));
  await sleep(800);

  const buyOrder = await prisma.order.findFirst({ where: { userId: investor.id, side: 'BUY' }, orderBy: { createdAt: 'desc' } });
  const resv = await prisma.walletReservation.findFirst({ where: { orderId: buyOrder.id, status: 'ACTIVE' } });
  eq(resv?.amount, expTotal, 'DB: reservation = total cost (funds held)');
  const bal1 = await call('GET', '/wallet/balance', { token: iTok });
  eq(bal1.data?.availableBalance, expNet - expTotal, 'API: available = net − reserved');

  // Broker executes the queued order (market closed → broker-confirmed fill)
  const exec = await call('POST', `/admin/trading/orders/${buyOrder.id}/execute`, { token: adminToken });
  ok(exec.status === 200 || exec.status === 201, 'broker executed queued buy', JSON.stringify(exec.raw)?.slice(0, 300));
  await sleep(2500); // settlement is event-driven

  const buyTrade = await prisma.trade.findFirst({ where: { orderId: buyOrder.id } });
  ok(!!buyTrade, 'DB: trade recorded');
  eq(buyTrade?.commission, expCommission, 'DB: trade.commission = tiered broker commission');
  eq(buyTrade?.levies, expLevies, 'DB: trade.levies = statutory levies');
  const wallet2 = await prisma.wallet.findUnique({ where: { userId: investor.id } });
  eq(wallet2?.balance, expNet - expTotal, 'DB: wallet debited exactly total cost at settlement');
  const holding = await prisma.holding.findFirst({ where: { userId: investor.id, stockId: stock.id } });
  eq(holding?.quantity, qty, 'DB: holding quantity');
  eq(Number(holding?.averageCost) * qty, expTotal, 'DB: cost basis includes fees (avgCost×qty = totalCost)');
  const resv2 = await prisma.walletReservation.findFirst({ where: { orderId: buyOrder.id } });
  ok(resv2?.status === 'CONSUMED', 'DB: reservation consumed at settlement');

  // ── SCENARIO C: sell with net proceeds ─────────────────────
  console.log('\n━ Scenario C: sell half — net proceeds & commission recorded');
  const sellQty = Math.max(1, Math.floor(qty / 2));
  const sGross = sellQty * stock.price;
  const sCommission = commissionFor(sGross);
  const sLevies = sGross * (SEC + MSE);
  const sNet = sGross - sCommission - sLevies;

  const sQuote = await call('GET', `/trading/quote?symbol=${stock.symbol}&quantity=${sellQty}&side=SELL`, { token: iTok });
  eq(sQuote.data?.netProceeds, sNet, 'quote: net proceeds = gross − commission − levies');
  eq(sQuote.data?.sharesAvailable, qty, 'quote: available shares = held (none committed)');

  const pin2 = await call('POST', '/auth/pin/verify', { token: iTok, body: { pin: PIN } });
  const sell = await call('POST', '/trading/sell', {
    token: iTok, pinToken: pin2.data.pinToken,
    body: { stockSymbol: stock.symbol, quantity: sellQty, orderType: 'MARKET', idempotencyKey: `${TAG}-sell-1` },
  });
  ok(sell.status === 201, 'sell order accepted', JSON.stringify(sell.raw)?.slice(0, 300));
  await sleep(500);

  // Over-sell guard: a second sell of MORE than the uncommitted remainder must be rejected
  const pin3 = await call('POST', '/auth/pin/verify', { token: iTok, body: { pin: PIN } });
  const overSell = await call('POST', '/trading/sell', {
    token: iTok, pinToken: pin3.data.pinToken,
    body: { stockSymbol: stock.symbol, quantity: qty, orderType: 'MARKET', idempotencyKey: `${TAG}-oversell` },
  });
  ok(overSell.status >= 400, 'over-sell (held − committed < qty) rejected');

  const sellOrder = await prisma.order.findFirst({ where: { userId: investor.id, side: 'SELL', status: { notIn: ['REJECTED'] } }, orderBy: { createdAt: 'desc' } });
  const execS = await call('POST', `/admin/trading/orders/${sellOrder.id}/execute`, { token: adminToken });
  ok(execS.status === 200 || execS.status === 201, 'broker executed queued sell');
  await sleep(2500);

  const sellTrade = await prisma.trade.findFirst({ where: { orderId: sellOrder.id } });
  eq(sellTrade?.commission, sCommission, 'DB: sell trade.commission recorded (broker earnings)');
  const wallet3 = await prisma.wallet.findUnique({ where: { userId: investor.id } });
  eq(wallet3?.balance, expNet - expTotal + sNet, 'DB: wallet credited NET proceeds');
  const holding2 = await prisma.holding.findFirst({ where: { userId: investor.id, stockId: stock.id } });
  eq(holding2?.quantity, qty - sellQty, 'DB: holding reduced by sold quantity');

  // ── SCENARIO E: cancelled order releases the hold ──────────
  console.log('\n━ Scenario E: cancelled buy — reservation released, no fees recorded');
  const pin4 = await call('POST', '/auth/pin/verify', { token: iTok, body: { pin: PIN } });
  const buy2 = await call('POST', '/trading/buy', {
    token: iTok, pinToken: pin4.data.pinToken,
    body: { stockSymbol: stock.symbol, quantity: 1, orderType: 'MARKET', idempotencyKey: `${TAG}-buy-cancel` },
  });
  ok(buy2.status === 201, 'second buy accepted (to cancel)');
  await sleep(500);
  const order2 = await prisma.order.findFirst({ where: { userId: investor.id, idempotencyKey: `${TAG}-buy-cancel` } });
  const cancel = await call('POST', `/trading/cancel/${order2.id}`, { token: iTok });
  ok(cancel.status === 200, 'order cancelled', JSON.stringify(cancel.raw)?.slice(0, 200));
  await sleep(800);
  const resvC = await prisma.walletReservation.findFirst({ where: { orderId: order2.id } });
  ok(resvC == null || resvC.status !== 'ACTIVE', 'DB: reservation released on cancel');
  const trades2 = await prisma.trade.count({ where: { orderId: order2.id } });
  eq(trades2, 0, 'DB: no trade/fees recorded for cancelled order');
  const wallet4 = await prisma.wallet.findUnique({ where: { userId: investor.id } });
  eq(wallet4?.balance, expNet - expTotal + sNet, 'DB: balance unchanged by cancelled order');

  // ── Withdrawals: hold → broker approve / reject ────────────
  console.log('\n━ Withdrawals: pending hold, double-spend guard, broker decision');
  const WD = 20_000;
  const pin5 = await call('POST', '/auth/pin/verify', { token: iTok, body: { pin: PIN } });
  const wd1 = await call('POST', '/wallet/withdraw', {
    token: iTok, pinToken: pin5.data.pinToken,
    body: { amount: WD, idempotencyKey: `${TAG}-wd-1` },
  });
  ok(wd1.status === 201 && wd1.data?.status === 'PENDING', 'withdrawal request → PENDING', JSON.stringify(wd1.raw)?.slice(0, 200));
  const balW = await call('GET', '/wallet/balance', { token: iTok });
  eq(balW.data?.availableBalance, Number(wallet4.balance) - WD, 'API: available excludes pending withdrawal');

  // Double-spend guard: buy costing more than the remaining available must fail
  const bigQty = Math.ceil((Number(wallet4.balance) - WD) / stock.price) + 5;
  const pin6 = await call('POST', '/auth/pin/verify', { token: iTok, body: { pin: PIN } });
  const dblSpend = await call('POST', '/trading/buy', {
    token: iTok, pinToken: pin6.data.pinToken,
    body: { stockSymbol: stock.symbol, quantity: bigQty, orderType: 'MARKET', idempotencyKey: `${TAG}-dblspend` },
  });
  ok(dblSpend.status >= 400, 'buy overlapping withdrawn funds rejected');

  const pending = await call('GET', '/admin/wallets/withdrawals/pending', { token: adminToken });
  ok((pending.data?.withdrawals ?? []).some((w) => w.transactionId === wd1.data.transactionId), 'admin sees pending withdrawal');

  const approve = await call('POST', `/admin/wallets/withdrawals/${wd1.data.transactionId}/approve`, { token: adminToken });
  ok(approve.status === 200, 'broker approved withdrawal', JSON.stringify(approve.raw)?.slice(0, 200));
  await sleep(800);
  const wallet5 = await prisma.wallet.findUnique({ where: { userId: investor.id } });
  eq(wallet5?.balance, Number(wallet4.balance) - WD, 'DB: wallet debited on approval (not before)');
  const wdLegs = await prisma.ledgerEntry.findMany({ where: { transactionId: wd1.data.transactionId } });
  ok(wdLegs.length === 2, 'ledger: withdrawal posted double-entry');

  // Rejection path: funds stay
  const pin7 = await call('POST', '/auth/pin/verify', { token: iTok, body: { pin: PIN } });
  const wd2 = await call('POST', '/wallet/withdraw', {
    token: iTok, pinToken: pin7.data.pinToken,
    body: { amount: 5_000, idempotencyKey: `${TAG}-wd-2` },
  });
  const reject = await call('POST', `/admin/wallets/withdrawals/${wd2.data.transactionId}/reject`, {
    token: adminToken, body: { reason: 'Bank details unverified' },
  });
  ok(reject.status === 200, 'broker rejected withdrawal');
  await sleep(500);
  const wd2Tx = await prisma.transaction.findUnique({ where: { id: wd2.data.transactionId } });
  ok(wd2Tx?.status === 'FAILED', 'DB: rejected withdrawal → FAILED, no money moved');
  const wallet6 = await prisma.wallet.findUnique({ where: { userId: investor.id } });
  eq(wallet6?.balance, Number(wallet5.balance), 'DB: balance unchanged by rejection');
  const rejNotif = await prisma.notification.findFirst({
    where: { userId: investor.id, title: { contains: 'Rejected', mode: 'insensitive' } },
  });
  ok(!!rejNotif, 'investor notified of rejection');

  // ── SCENARIO D: dashboard aggregation & separation ─────────
  console.log('\n━ Scenario D: dashboard financials — one source of truth, no double counting');
  const fin = await call('GET', '/admin/dashboard/financials', { token: adminToken });
  const expCash = Number(wallet6.balance);
  const expPortfolio = (qty - sellQty) * stock.price;
  eq(fin.data?.clientAssets?.clientCash, expCash, 'financials: Client Cash = Σ wallet balances (scoped)');
  eq(fin.data?.clientAssets?.portfolioValue, expPortfolio, 'financials: Portfolio Value = qty × latest close');
  eq(fin.data?.clientAssets?.totalInvestorAssets, expCash + expPortfolio, 'financials: Total = cash + portfolio (no double count)');
  eq(fin.data?.brokerRevenue?.tradingCommissions, expCommission + sCommission, 'financials: commissions = Σ trade.commission');
  eq(fin.data?.paymentCosts?.processingFees, expFee, 'financials: processing fees = Σ deposit fees');

  const summary = await call('GET', `/admin/users/${investor.id}`, { token: adminToken });
  const fs = summary.data?.financialSummary;
  eq(fs?.cash?.total, expCash, 'investor summary: cash total');
  eq(fs?.portfolioValue, expPortfolio, 'investor summary: portfolio at market');
  eq(fs?.totalAssets, expCash + expPortfolio, 'investor summary: total assets');
  eq(fs?.lifetimeFees?.commissionsPaid, expCommission + sCommission, 'investor summary: lifetime commissions');
  eq(fs?.lifetimeFees?.depositFeesPaid, expFee, 'investor summary: deposit fees paid');

  // Mobile portfolio must agree with the dashboard (same source of truth)
  const mob = await call('GET', '/portfolio/summary', { token: iTok });
  eq(mob.data?.totalMarketValue, expPortfolio, 'mobile portfolio market value = dashboard portfolio value');

  // ── Reconciliation ─────────────────────────────────────────
  console.log('\n━ Reconciliation: wallet ↔ ledger');
  const rec = await call('GET', '/admin/dashboard/reconciliation', { token: adminToken });
  ok(rec.status === 200, 'reconciliation endpoint responds');
  ok(rec.data?.inBalance === true, 'wallet balances match ledger exactly (0 drift)',
    JSON.stringify(rec.data?.discrepancies)?.slice(0, 300));

  // ── RISK ENGINE: broker-configured constraints ─────────────
  console.log('\n━ Risk engine: deposit limits (per-tx / daily / velocity)');
  // Daily gross so far: Scenario A deposited 100,000 (gross) today.
  const putRisk = await call('PUT', '/admin/risk/config', {
    token: adminToken,
    body: {
      concentrationEnabled: false, maxPositionPct: 100, warnPositionPct: null,
      depositRules: [
        { id: 'r-card', label: 'Card deposits', enabled: true, method: 'CARD', kycStatus: null,
          perTransactionMax: 50_000, dailyMax: 120_000, monthlyMax: null,
          velocityMaxCount: null, velocityWindowMinutes: null },
      ],
    },
  });
  ok(putRisk.status === 200 && putRisk.data?.depositRules?.length === 1, 'risk config saved', JSON.stringify(putRisk.raw)?.slice(0, 200));

  const badRisk = await call('PUT', '/admin/risk/config', {
    token: adminToken,
    body: { concentrationEnabled: true, maxPositionPct: 20, warnPositionPct: 30, depositRules: [] },
  });
  ok(badRisk.status >= 400, 'invalid config (warn ≥ max) rejected');

  const limPrev = await call('GET', '/wallet/deposit/preview?amount=30000&method=CARD', { token: iTok });
  eq(limPrev.data?.limits?.dailyUsed, 100_000, 'preview: daily used = gross deposits today (100,000)');
  eq(limPrev.data?.limits?.dailyRemaining, 20_000, 'preview: daily remaining = 20,000');
  eq(limPrev.data?.limits?.maxAllowedNow, 20_000, 'preview: max allowed now = most restrictive bound');
  ok(limPrev.data?.limits?.allowed === false, 'preview: 30,000 exceeds remaining → flagged before paying');

  const overTx = await call('POST', '/payments/card/initiate', {
    token: iTok,
    body: { amount: 60_000, currency: 'MWK', cardholderName: 'FIN INVESTOR', cardNumber: '4111111111111111',
      expiryMonth: '12', expiryYear: '29', cvv: '123', testScenario: 'success' },
  });
  ok(overTx.status >= 400 && /Maximum per deposit/i.test(JSON.stringify(overTx.raw)), 'deposit over per-transaction cap rejected with reason', JSON.stringify(overTx.raw)?.slice(0, 200));

  const okDep = await call('POST', '/payments/card/initiate', {
    token: iTok,
    body: { amount: 15_000, currency: 'MWK', cardholderName: 'FIN INVESTOR', cardNumber: '4111111111111111',
      expiryMonth: '12', expiryYear: '29', cvv: '123', testScenario: 'success' },
  });
  ok(okDep.status === 201 && /SUCCESS|COMPLETED/i.test(okDep.data?.status ?? ''), 'deposit within limits succeeds (15,000)');
  await sleep(1200);

  const overDaily = await call('POST', '/payments/card/initiate', {
    token: iTok,
    body: { amount: 10_000, currency: 'MWK', cardholderName: 'FIN INVESTOR', cardNumber: '4111111111111111',
      expiryMonth: '12', expiryYear: '29', cvv: '123', testScenario: 'success' },
  });
  ok(overDaily.status >= 400 && /Daily deposit limit/i.test(JSON.stringify(overDaily.raw)), 'deposit exceeding daily remaining rejected with usage in reason');

  // Velocity: 2 deposits already today → a 2-per-hour rule blocks the next.
  await call('PUT', '/admin/risk/config', {
    token: adminToken,
    body: {
      concentrationEnabled: false, maxPositionPct: 100, warnPositionPct: null,
      depositRules: [
        { id: 'r-vel', label: 'Anti-abuse velocity', enabled: true, method: null, kycStatus: null,
          perTransactionMax: null, dailyMax: null, monthlyMax: null,
          velocityMaxCount: 2, velocityWindowMinutes: 60 },
      ],
    },
  });
  const velDep = await call('POST', '/payments/card/initiate', {
    token: iTok,
    body: { amount: 5_000, currency: 'MWK', cardholderName: 'FIN INVESTOR', cardNumber: '4111111111111111',
      expiryMonth: '12', expiryYear: '29', cvv: '123', testScenario: 'success' },
  });
  ok(velDep.status >= 400 && /Too many deposits/i.test(JSON.stringify(velDep.raw)), 'velocity limit blocks a 3rd deposit in the window');

  console.log('\n━ Risk engine: portfolio concentration (buys only)');
  // Live investor state → compute expected post-order exposure ourselves.
  const wNow = await prisma.wallet.findUnique({ where: { userId: investor.id } });
  const hNow = await prisma.holding.findFirst({ where: { userId: investor.id, stockId: stock.id } });
  const posValue = Number(hNow?.quantity ?? 0) * stock.price;
  const totalAssets = Number(wNow.balance) + posValue;
  const buyQty2 = Math.max(1, Math.floor(10_000 / stock.price));
  const buyGross = buyQty2 * stock.price;
  const expPostPct = ((posValue + buyGross) / totalAssets) * 100;

  // Tight cap (below the post-order exposure) → BLOCKED end-to-end.
  const tightMax = Math.max(1, Math.floor(expPostPct - 3));
  await call('PUT', '/admin/risk/config', {
    token: adminToken,
    body: { concentrationEnabled: true, maxPositionPct: tightMax, warnPositionPct: null, depositRules: [] },
  });
  const qBlocked = await call('GET', `/trading/quote?symbol=${stock.symbol}&quantity=${buyQty2}&side=BUY`, { token: iTok });
  ok(qBlocked.data?.constraints?.concentration?.status === 'BLOCKED', `quote: post-order ${expPostPct.toFixed(1)}% vs cap ${tightMax}% → BLOCKED`);
  eq(qBlocked.data?.constraints?.concentration?.postOrderPct, expPostPct, 'quote: post-order exposure math matches', 0.5);
  const pinC1 = await call('POST', '/auth/pin/verify', { token: iTok, body: { pin: PIN } });
  const buyBlocked = await call('POST', '/trading/buy', {
    token: iTok, pinToken: pinC1.data.pinToken,
    body: { stockSymbol: stock.symbol, quantity: buyQty2, orderType: 'MARKET', idempotencyKey: `${TAG}-conc-block` },
  });
  ok(buyBlocked.status >= 400 && /one stock|concentration/i.test(JSON.stringify(buyBlocked.raw)), 'buy over concentration cap rejected server-side');

  // Selling must ALWAYS remain possible under the same tight cap.
  // (Quantity sized so net proceeds stay positive — a 1-share sell is
  // legitimately rejected because the minimum commission exceeds it.)
  const sellProbeQty = Math.max(1, Math.min(
    Number(hNow?.quantity ?? 1),
    Math.ceil(700 / stock.price),
  ));
  const pinSell = await call('POST', '/auth/pin/verify', { token: iTok, body: { pin: PIN } });
  const sellUnderCap = await call('POST', '/trading/sell', {
    token: iTok, pinToken: pinSell.data.pinToken,
    body: { stockSymbol: stock.symbol, quantity: sellProbeQty, orderType: 'MARKET', idempotencyKey: `${TAG}-conc-sell` },
  });
  ok(sellUnderCap.status === 201, 'selling still possible under concentration cap', JSON.stringify(sellUnderCap.raw)?.slice(0, 300));
  const sellOrderC = await prisma.order.findFirst({ where: { userId: investor.id, idempotencyKey: `${TAG}-conc-sell` } });
  await call('POST', `/trading/cancel/${sellOrderC.id}`, { token: iTok });

  // Loose cap with a warning threshold → WARNING shown, order accepted.
  const looseWarn = Math.max(1, Math.floor(expPostPct - 3));
  await call('PUT', '/admin/risk/config', {
    token: adminToken,
    body: { concentrationEnabled: true, maxPositionPct: 90, warnPositionPct: looseWarn, depositRules: [] },
  });
  const qWarn = await call('GET', `/trading/quote?symbol=${stock.symbol}&quantity=${buyQty2}&side=BUY`, { token: iTok });
  ok(qWarn.data?.constraints?.concentration?.status === 'WARNING', 'quote: over warn threshold (under cap) → WARNING');
  const pinC2 = await call('POST', '/auth/pin/verify', { token: iTok, body: { pin: PIN } });
  const buyWarn = await call('POST', '/trading/buy', {
    token: iTok, pinToken: pinC2.data.pinToken,
    body: { stockSymbol: stock.symbol, quantity: buyQty2, orderType: 'MARKET', idempotencyKey: `${TAG}-conc-warn` },
  });
  ok(buyWarn.status === 201, 'warned order still accepted (warning is advisory)');
  const warnOrder = await prisma.order.findFirst({ where: { userId: investor.id, idempotencyKey: `${TAG}-conc-warn` } });
  await call('POST', `/trading/cancel/${warnOrder.id}`, { token: iTok });

  // Config changes are audited with before/after.
  const auditRows = await prisma.auditLog.count({
    where: { action: 'RISK_CONFIG_UPDATED', actorId: brokerAdmin.id },
  });
  ok(auditRows >= 4, `risk config changes audited (${auditRows} entries with before/after)`);

  // Final integrity: the extra deposit kept wallet ↔ ledger in balance.
  const rec2 = await call('GET', '/admin/dashboard/reconciliation', { token: adminToken });
  ok(rec2.data?.inBalance === true, 'still 0 drift after risk-engine scenarios');

  // ── Platform commission: Pine's cut of broker commissions ──
  console.log('\n━ Platform commission: super admin sets rate, broker owes Pine per trade');
  const superLogin = await call('POST', '/admin/auth/login', { body: { email: SUPER_EMAIL, password: PASSWORD } });
  const superSetup = await call('POST', '/admin/auth/mfa/setup', { body: { mfaToken: superLogin.data?.mfaToken } });
  const superConfirm = await call('POST', '/admin/auth/mfa/confirm-setup', {
    body: { mfaToken: superLogin.data?.mfaToken, code: totp(superSetup.data?.secret ?? '') },
  });
  ok(!!superConfirm.data?.accessToken, 'test super admin logged in (MFA)', JSON.stringify(superConfirm.raw)?.slice(0, 200));
  const superToken = superConfirm.data?.accessToken;

  const prevRate = (await call('GET', '/admin/platform/commission', { token: superToken })).data?.platformCommissionPct ?? 0;
  const PLATFORM_PCT = 20;
  const setRate = await call('PUT', '/admin/platform/commission', { token: superToken, body: { platformCommissionPct: PLATFORM_PCT } });
  eq(setRate.data?.platformCommissionPct, PLATFORM_PCT, 'platform rate set to 20% (audited)');
  const brokerForbidden = await call('PUT', '/admin/platform/commission', { token: adminToken, body: { platformCommissionPct: 1 } });
  ok(brokerForbidden.status === 403, 'broker admin cannot change the platform rate');

  // Relax concentration so a small buy passes, then trade 1 share.
  await call('PUT', '/admin/risk/config', {
    token: adminToken,
    body: { concentrationEnabled: false, maxPositionPct: 100, warnPositionPct: null, depositRules: [] },
  });
  await sleep(1200); // fee-policy / risk caches
  const pinP = await call('POST', '/auth/pin/verify', { token: iTok, body: { pin: PIN } });
  const buyP = await call('POST', '/trading/buy', {
    token: iTok, pinToken: pinP.data.pinToken,
    body: { stockSymbol: stock.symbol, quantity: 1, orderType: 'MARKET', idempotencyKey: `${TAG}-platform-buy` },
  });
  ok(buyP.status === 201, 'buy accepted under platform rate', JSON.stringify(buyP.raw)?.slice(0, 200));
  await sleep(800);
  const orderP = await prisma.order.findFirst({ where: { userId: investor.id, idempotencyKey: `${TAG}-platform-buy` } });
  await sleep(61_000); // PlatformFeeService caches the rate for 60s — wait it out before execution
  const execP = await call('POST', `/admin/trading/orders/${orderP.id}/execute`, { token: adminToken });
  ok(execP.status === 200 || execP.status === 201, 'broker executed the trade');
  await sleep(2500);
  const tradeP = await prisma.trade.findFirst({ where: { orderId: orderP.id } });
  const expPlatform = Number(tradeP?.commission ?? 0) * (PLATFORM_PCT / 100);
  eq(tradeP?.platformFee, expPlatform, `DB: trade.platformFee = 20% of broker commission (${expPlatform})`);

  const finP = await call('GET', '/admin/dashboard/financials', { token: adminToken });
  eq(finP.data?.platformFees?.ratePct, PLATFORM_PCT, 'broker dashboard shows the platform rate');
  eq(finP.data?.platformFees?.owedThisMonth, expPlatform, 'broker dashboard: owed to Pine this month = Σ platformFee');

  const report = await call('GET', '/admin/platform/brokers/earnings', { token: superToken });
  const mine = (report.data?.brokers ?? []).find((b) => b.code === TAG);
  eq(mine?.thisMonth?.owedToPlatform, expPlatform, 'admin earnings report: FINTEST owes Pine the same amount');
  ok((mine?.thisMonth?.commissions ?? 0) > 0, 'admin earnings report: broker commissions tracked');
  const reportAsBroker = await call('GET', '/admin/platform/brokers/earnings', { token: adminToken });
  ok(reportAsBroker.status === 403, 'earnings report is super-admin only');

  // Restore the production rate exactly as it was.
  await call('PUT', '/admin/platform/commission', { token: superToken, body: { platformCommissionPct: prevRate } });
  eq((await call('GET', '/admin/platform/commission', { token: superToken })).data?.platformCommissionPct, prevRate, 'platform rate restored');

  // ── Hosted Session / tokenisation safety ───────────────────
  // No live MPGS credentials exist for the test broker, so the value here is
  // proving the new money paths fail SAFELY and legibly rather than crashing,
  // and that nothing can be charged without a configured broker gateway.
  console.log('\n━ Hosted Session: card data never reaches Pine');

  const sess = await call('POST', '/payments/card/session', {
    token: iTok,
    body: { amount: 5_000, currency: 'MWK', purpose: 'wallet_deposit' },
  });
  ok(
    sess.status === 409 || sess.status === 503,
    'card session refused cleanly when the broker gateway is unconfigured',
    `status ${sess.status} ${JSON.stringify(sess.raw)?.slice(0, 160)}`,
  );
  ok(
    /not yet enabled|not configured|unavailable/i.test(JSON.stringify(sess.raw ?? '')),
    'refusal explains that the broker has no payment configuration',
  );

  const noDeposit = await prisma.transaction.findFirst({
    where: { wallet: { userId: investor.id }, metadata: { path: ['integration'], equals: 'HOSTED_SESSION' } },
  });
  ok(!noDeposit, 'no pending deposit is left behind by a refused session');

  const completeUnknown = await call('POST', '/payments/card/session/complete', {
    token: iTok,
    body: { txRef: 'PINE-CARD-does-not-exist' },
  });
  ok(completeUnknown.status === 404, 'completing an unknown reference is rejected');

  // A saved card from the pre-tokenisation era holds no gateway token: it must
  // be refused with a re-add prompt, never charged and never crash.
  const legacyCard = await prisma.savedCard.create({
    data: {
      userId: investor.id,
      last4: '4242',
      cardBrand: 'Visa',
      cardholderName: 'Fin Investor',
      expiryMonth: '12',
      expiryYear: '29',
      cardNumberEncrypted: 'legacy-placeholder',
      isDefault: false,
    },
  });
  const legacyCharge = await call('POST', '/payments/card/saved', {
    token: iTok,
    body: { savedCardId: legacyCard.id, amount: 5_000, currency: 'MWK' },
  });
  ok(
    legacyCharge.status >= 400,
    'a pre-tokenisation saved card cannot be charged',
    `status ${legacyCharge.status}`,
  );

  const cardList = await call('GET', '/cards', { token: iTok });
  const listed = (Array.isArray(cardList.data) ? cardList.data : []).find((c) => c.id === legacyCard.id);
  ok(listed?.chargeable === false, 'saved-card list marks the legacy card as not chargeable');
  await prisma.savedCard.delete({ where: { id: legacyCard.id } }).catch(() => {});

  // The sandbox path must be untouched by the tokenisation work. Clear the
  // deposit limits the risk scenarios left in force first, otherwise this
  // would be blocked by them rather than by anything to do with cards.
  await call('PUT', '/admin/risk/config', {
    token: adminToken,
    body: {
      concentrationEnabled: false, maxPositionPct: 100, warnPositionPct: null,
      depositRules: [],
    },
  });
  await sleep(1200); // risk-policy cache

  const sandboxStill = await call('POST', '/payments/card/initiate', {
    token: iTok,
    body: {
      amount: 5_000, currency: 'MWK',
      cardholderName: 'FIN INVESTOR', cardNumber: '4111111111111111',
      expiryMonth: '12', expiryYear: '29', cvv: '123',
      testScenario: 'success',
    },
  });
  ok(
    sandboxStill.status === 201 && /SUCCESS|COMPLETED/i.test(sandboxStill.data?.status ?? ''),
    'sandbox test transactions still work after the tokenisation change',
    JSON.stringify(sandboxStill.raw)?.slice(0, 160),
  );

  // ── Portfolio analytics: stocks only, cash never counted as growth ──
  console.log('\n━ Portfolio analytics excludes uninvested cash');

  const sumA = await call('GET', '/portfolio/summary', { token: iTok });
  const perfA = await call('GET', '/portfolio/performance', { token: iTok });
  const mktA = Number(sumA.data?.totalMarketValue ?? 0);
  const investedA = Number(sumA.data?.totalInvested ?? 0);
  const cashA = Number(sumA.data?.cashBalance ?? 0);

  ok(cashA > 0 && mktA > 0, 'fixture holds both cash and stocks (a real mixed case)',
    `cash ${cashA} market ${mktA}`);

  // Lifetime return must be the stocks' unrealised P&L. Before the fix this
  // was (cash + market) − invested, so idle cash showed up as pure profit.
  eq(perfA.data?.lifetimeReturn, mktA - investedA,
    'lifetime return = market value − invested (cash excluded)', 1);
  const cashInflated = cashA + mktA - investedA;
  ok(
    Math.abs(Number(perfA.data?.lifetimeReturn ?? 0) - cashInflated) > 1,
    'lifetime return is NOT the cash-inflated figure',
    `cash-inflated would be ${cashInflated}`,
  );

  // The history series the app charts must carry a holdings-only field.
  const histA = await call('GET', '/portfolio/history?limit=5', { token: iTok });
  const rows = Array.isArray(histA.data) ? histA.data : (histA.data?.snapshots ?? []);
  ok(histA.status === 200, 'portfolio history responds');
  if (rows.length > 0) {
    const r = rows[rows.length - 1];
    ok('holdingsValue' in r && 'cashBalance' in r,
      'history rows expose holdingsValue and cashBalance separately');
    eq(Number(r.holdingsValue) + Number(r.cashBalance), Number(r.totalValue),
      'holdingsValue + cashBalance reconciles to the legacy totalValue', 1);
  } else {
    ok(true, 'history empty (daily snapshot cron has not run for the fixture) — skipped row check');
  }

  // ── Result ─────────────────────────────────────────────────
  console.log(`\n━━ ${passed} passed, ${failed} failed ━━`);
  if (failures.length) console.log('Failed:\n' + failures.map((f) => `  • ${f}`).join('\n'));

  if (!KEEP) {
    console.log('\n— Cleanup: removing FINTEST fixture');
    await cleanup(false);
  } else {
    console.log('\n(--keep: fixture left in place)');
  }

  process.exit(failed > 0 ? 1 : 0);
}

/** Remove every row belonging to the FINTEST fixture, FK-safe order. */
async function cleanup(quiet) {
  try {
    const users = await prisma.user.findMany({
      where: { email: { in: [INVESTOR_EMAIL, ADMIN_EMAIL, SUPER_EMAIL] } },
      select: { id: true },
    });
    const uids = users.map((u) => u.id);
    const broker = await prisma.broker.findUnique({ where: { code: TAG } });

    if (uids.length) {
      const wallets = await prisma.wallet.findMany({ where: { userId: { in: uids } }, select: { id: true } });
      const wids = wallets.map((w) => w.id);
      const orders = await prisma.order.findMany({ where: { userId: { in: uids } }, select: { id: true } });
      const oids = orders.map((o) => o.id);
      const trades = await prisma.trade.findMany({ where: { orderId: { in: oids } }, select: { id: true } });
      const tids = trades.map((t) => t.id);

      const del = async (fn) => { try { await fn(); } catch (e) { if (!quiet) console.log(`  cleanup skip: ${e.message?.slice(0, 100)}`); } };
      await del(() => prisma.settlementRecord.deleteMany({ where: { tradeId: { in: tids } } }));
      await del(() => prisma.tradeAudit.deleteMany({ where: { orderId: { in: oids } } }));
      await del(() => prisma.orderExecution.deleteMany({ where: { orderId: { in: oids } } }));
      await del(() => prisma.trade.deleteMany({ where: { orderId: { in: oids } } }));
      await del(() => prisma.ledgerEntry.deleteMany({ where: { OR: [ { walletId: { in: wids } }, { transaction: { walletId: { in: wids } } } ] } }));
      await del(() => prisma.transaction.deleteMany({ where: { walletId: { in: wids } } }));
      await del(() => prisma.walletReservation.deleteMany({ where: { walletId: { in: wids } } }));
      await del(() => prisma.walletSnapshot.deleteMany({ where: { walletId: { in: wids } } }));
      await del(() => prisma.order.deleteMany({ where: { id: { in: oids } } }));
      await del(() => prisma.savedCard.deleteMany({ where: { userId: { in: uids } } }));
      await del(() => prisma.holding.deleteMany({ where: { userId: { in: uids } } }));
      await del(() => prisma.wallet.deleteMany({ where: { id: { in: wids } } }));
      await del(() => prisma.payment.deleteMany({ where: { userId: { in: uids } } }));
      await del(() => prisma.notificationDelivery.deleteMany({ where: { notification: { userId: { in: uids } } } }));
      await del(() => prisma.notification.deleteMany({ where: { userId: { in: uids } } }));
      await del(() => prisma.auditLog.deleteMany({ where: { actorId: { in: uids } } }));
      await del(() => prisma.session.deleteMany({ where: { userId: { in: uids } } }));
      await del(() => prisma.device.deleteMany({ where: { userId: { in: uids } } }));
      await del(() => prisma.otpCode.deleteMany({ where: { userId: { in: uids } } }));
      await del(() => prisma.mfaConfig.deleteMany({ where: { userId: { in: uids } } }));
      await del(() => prisma.notificationPreference.deleteMany({ where: { userId: { in: uids } } }));
      await del(() => prisma.userPreference.deleteMany({ where: { userId: { in: uids } } }));
      await del(() => prisma.user.deleteMany({ where: { id: { in: uids } } }));
    }
    if (broker) {
      try { await prisma.brokerFeeConfig.deleteMany({ where: { brokerId: broker.id } }); } catch {}
      try { await prisma.broker.delete({ where: { id: broker.id } }); } catch (e) { if (!quiet) console.log(`  broker cleanup: ${e.message?.slice(0, 100)}`); }
    }
  } catch (e) {
    if (!quiet) console.log(`  cleanup error: ${e.message}`);
  }
}

main().catch(async (e) => {
  console.error('\nFATAL:', e);
  await cleanup(false);
  process.exit(1);
}).finally(() => prisma.$disconnect());
