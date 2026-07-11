/**
 * Redis key builders. Centralising the templates prevents key collisions
 * between modules and makes it possible to `SCAN` a namespace safely
 * (e.g. `otp:*`) during incident response without guessing formats.
 */
export const CacheKeys = {
  otp: (userId: string, purpose: string) => `otp:${purpose}:${userId}`,
  otpAttempts: (userId: string, purpose: string) => `otp:${purpose}:${userId}:attempts`,
  session: (sessionId: string) => `session:${sessionId}`,
  refreshTokenFamily: (familyId: string) => `refresh-family:${familyId}`,
  rateLimitLogin: (identifier: string) => `ratelimit:login:${identifier}`,
  pinAttempts: (userId: string) => `pin:attempts:${userId}`,
  pinLock: (userId: string) => `pin:locked:${userId}`,
  marketStatus: () => 'market:status',
  stockQuote: (symbol: string) => `market:quote:${symbol}`,
  marketMovers: () => 'market:movers',
  portfolioSnapshot: (userId: string) => `portfolio:snapshot:${userId}`,
  walletBalance: (userId: string) => `wallet:balance:${userId}`,
  idempotencyKey: (key: string) => `idempotency:${key}`,
  deviceTrustScore: (deviceId: string) => `device:trust:${deviceId}`,
} as const;
