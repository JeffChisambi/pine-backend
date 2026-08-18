import { registerAs } from '@nestjs/config';

/**
 * Each `registerAs` call creates an isolated, typed configuration
 * namespace (`config.get('app')`, `config.get('database')`, ...).
 * Namespacing avoids a single flat, unstructured config blob and keeps
 * each module's concerns separate — a module only injects the
 * namespace(s) it actually needs.
 */

export const appConfig = registerAs('app', () => ({
  name: process.env.APP_NAME ?? 'pine-backend',
  env: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.APP_PORT ?? '3000', 10),
  url: process.env.APP_URL ?? 'http://localhost:3000',
  /** Broker dashboard origin — used in emails (e.g. invitation activation links). */
  dashboardUrl: process.env.DASHBOARD_URL ?? 'https://broker.appine.online',
  apiPrefix: process.env.API_PREFIX ?? 'v1',
  timezone: process.env.APP_TIMEZONE ?? 'Africa/Blantyre',
  isProduction: process.env.NODE_ENV === 'production',
  isDevelopment: (process.env.NODE_ENV ?? 'development') === 'development',
  isTest: process.env.NODE_ENV === 'test',
}));

export const corsConfig = registerAs('cors', () => ({
  origins: (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  credentials: process.env.CORS_CREDENTIALS !== 'false',
}));

export const databaseConfig = registerAs('database', () => ({
  url: process.env.DATABASE_URL,
  readReplicaUrl: process.env.DATABASE_READ_REPLICA_URL || process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true',
  poolMin: parseInt(process.env.DATABASE_POOL_MIN ?? '2', 10),
  poolMax: parseInt(process.env.DATABASE_POOL_MAX ?? '10', 10),
}));

export const redisConfig = registerAs('redis', () => ({
  host: process.env.REDIS_HOST ?? 'localhost',
  port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_DB ?? '0', 10),
  tls: process.env.REDIS_TLS === 'true',
}));

export const jwtConfig = registerAs('jwt', () => ({
  accessSecret: process.env.JWT_ACCESS_SECRET,
  accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN ?? '45m',
  refreshSecret: process.env.JWT_REFRESH_SECRET,
  refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? '30d',
  issuer: process.env.JWT_ISSUER ?? 'pine.mw',
  audience: process.env.JWT_AUDIENCE ?? 'pine-mobile-app',
}));

export const securityConfig = registerAs('security', () => ({
  pinEncryptionKey: process.env.PIN_ENCRYPTION_KEY,
  argon2: {
    memoryCost: parseInt(process.env.ARGON2_MEMORY_COST ?? '19456', 10),
    timeCost: parseInt(process.env.ARGON2_TIME_COST ?? '2', 10),
    parallelism: parseInt(process.env.ARGON2_PARALLELISM ?? '1', 10),
  },
  trustProxy: process.env.TRUST_PROXY !== 'false',
  bodyLimit: process.env.BODY_LIMIT ?? '1mb',
  cookieSecret: process.env.COOKIE_SECRET,
}));

export const otpConfig = registerAs('otp', () => ({
  length: parseInt(process.env.OTP_LENGTH ?? '6', 10),
  ttlSeconds: parseInt(process.env.OTP_TTL_SECONDS ?? '300', 10),
  maxAttempts: parseInt(process.env.OTP_MAX_ATTEMPTS ?? '5', 10),
  resendCooldownSeconds: parseInt(process.env.OTP_RESEND_COOLDOWN_SECONDS ?? '60', 10),
}));

export const rateLimitConfig = registerAs('rateLimit', () => ({
  ttlMs: parseInt(process.env.RATE_LIMIT_TTL_MS ?? '60000', 10),
  max: parseInt(process.env.RATE_LIMIT_MAX ?? '100', 10),
  authMax: parseInt(process.env.AUTH_RATE_LIMIT_MAX ?? '10', 10),
}));

export const storageConfig = registerAs('storage', () => ({
  provider: process.env.STORAGE_PROVIDER ?? 'minio',
  endpoint: process.env.STORAGE_ENDPOINT,
  publicEndpoint: process.env.STORAGE_PUBLIC_ENDPOINT || process.env.STORAGE_ENDPOINT,
  region: process.env.STORAGE_REGION ?? 'auto',
  accessKeyId: process.env.STORAGE_ACCESS_KEY_ID,
  secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY,
  forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE !== 'false',
  buckets: {
    avatars: process.env.STORAGE_BUCKET_AVATARS ?? 'pine-avatars',
    kyc: process.env.STORAGE_BUCKET_KYC ?? 'pine-kyc-documents',
    reports: process.env.STORAGE_BUCKET_REPORTS ?? 'pine-reports',
  },
  signedUrlTtlSeconds: parseInt(process.env.STORAGE_SIGNED_URL_TTL_SECONDS ?? '900', 10),
  maxUploadMb: parseInt(process.env.STORAGE_MAX_UPLOAD_MB ?? '10', 10),
}));

export const emailConfig = registerAs('email', () => ({
  provider: process.env.EMAIL_PROVIDER ?? 'smtp',
  host: process.env.EMAIL_HOST,
  port: parseInt(process.env.EMAIL_PORT ?? '587', 10),
  user: process.env.EMAIL_USER,
  password: process.env.EMAIL_PASSWORD,
  from: process.env.EMAIL_FROM ?? 'Pine <no-reply@pine.mw>',
}));

export const smsConfig = registerAs('sms', () => ({
  provider: process.env.SMS_PROVIDER ?? 'africastalking',
  apiKey: process.env.SMS_API_KEY,
  username: process.env.SMS_USERNAME,
  senderId: process.env.SMS_SENDER_ID ?? 'PINE',
}));

export const marketConfig = registerAs('market', () => ({
  dataSource: process.env.MSE_DATA_SOURCE ?? 'scraper',
  apiBaseUrl: process.env.MSE_API_BASE_URL,
  apiKey: process.env.MSE_API_KEY,
  syncCron: process.env.MARKET_SYNC_CRON ?? '*/5 8-16 * * 1-5',
  timezone: process.env.MARKET_TIMEZONE ?? 'Africa/Blantyre',
  openTime: process.env.MARKET_OPEN_TIME ?? '10:00',
  closeTime: process.env.MARKET_CLOSE_TIME ?? '14:00',
  mockFallback: process.env.MSE_MOCK_FALLBACK === 'true',
}));

export const observabilityConfig = registerAs('observability', () => ({
  logLevel: process.env.LOG_LEVEL ?? 'info',
  sentryDsn: process.env.SENTRY_DSN,
  otelEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  metricsPath: process.env.PROMETHEUS_METRICS_PATH ?? '/metrics',
}));

export const mastercardGatewayConfig = registerAs('mastercardGateway', () => ({
  baseUrl:
    process.env.MCGS_BASE_URL ??
    'https://test-nbm.mtf.gateway.mastercard.com',
  merchantId: process.env.MCGS_MERCHANT_ID || undefined,
  apiPassword: process.env.MCGS_API_PASSWORD || undefined,
  apiVersion: parseInt(process.env.MCGS_API_VERSION ?? '100', 10),
  environment: (process.env.MCGS_ENVIRONMENT ?? 'test') as 'test' | 'production',
}));

export const allConfigs = [
  appConfig,
  corsConfig,
  databaseConfig,
  redisConfig,
  jwtConfig,
  securityConfig,
  otpConfig,
  rateLimitConfig,
  storageConfig,
  emailConfig,
  smsConfig,
  marketConfig,
  observabilityConfig,
  mastercardGatewayConfig,
];
