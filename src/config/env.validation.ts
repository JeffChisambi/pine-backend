import { z } from 'zod';

/**
 * Every environment variable the application depends on is declared here.
 * `ConfigModule.forRoot({ validate })` runs this against `process.env` at
 * boot time — if anything is missing or malformed the process exits
 * immediately with a readable error instead of failing later at runtime
 * (e.g. mid-transaction because a secret was undefined).
 */
const booleanFromString = z
  .union([z.literal('true'), z.literal('false')])
  .transform((v) => v === 'true');

export const envSchema = z.object({
  // App
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  APP_NAME: z.string().default('pine-backend'),
  APP_PORT: z.coerce.number().int().positive().default(3000),
  APP_URL: z.string().url(),
  API_PREFIX: z.string().default('v1'),
  APP_TIMEZONE: z.string().default('Africa/Blantyre'),

  // CORS
  CORS_ORIGINS: z.string().default(''),
  CORS_CREDENTIALS: booleanFromString.default('true'),

  // Database
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_READ_REPLICA_URL: z.string().optional(),
  DATABASE_SSL: booleanFromString.default('false'),
  DATABASE_POOL_MIN: z.coerce.number().int().nonnegative().default(2),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  // Redis
  REDIS_HOST: z.string().min(1),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_DB: z.coerce.number().int().nonnegative().default(0),
  REDIS_TLS: booleanFromString.default('false'),

  // JWT
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('45m'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),
  JWT_ISSUER: z.string().default('pine.mw'),
  JWT_AUDIENCE: z.string().default('pine-mobile-app'),

  // PIN / password hashing
  PIN_ENCRYPTION_KEY: z.string().min(32, 'PIN_ENCRYPTION_KEY must be at least 32 characters'),
  ARGON2_MEMORY_COST: z.coerce.number().int().positive().default(19456),
  ARGON2_TIME_COST: z.coerce.number().int().positive().default(2),
  ARGON2_PARALLELISM: z.coerce.number().int().positive().default(1),

  // OTP
  OTP_LENGTH: z.coerce.number().int().min(4).max(8).default(6),
  OTP_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(60),

  // Rate limiting
  RATE_LIMIT_TTL_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

  // Storage
  STORAGE_PROVIDER: z.enum(['s3', 'r2', 'minio']).default('minio'),
  STORAGE_ENDPOINT: z.string().url(),
  STORAGE_REGION: z.string().default('auto'),
  STORAGE_ACCESS_KEY_ID: z.string().min(1),
  STORAGE_SECRET_ACCESS_KEY: z.string().min(1),
  STORAGE_FORCE_PATH_STYLE: booleanFromString.default('true'),
  STORAGE_BUCKET_AVATARS: z.string().min(1),
  STORAGE_BUCKET_KYC: z.string().min(1),
  STORAGE_BUCKET_REPORTS: z.string().min(1),
  STORAGE_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  STORAGE_MAX_UPLOAD_MB: z.coerce.number().int().positive().default(10),

  // Email
  EMAIL_PROVIDER: z.enum(['smtp', 'ses']).default('smtp'),
  EMAIL_HOST: z.string().min(1),
  EMAIL_PORT: z.coerce.number().int().positive().default(587),
  EMAIL_USER: z.string().optional(),
  EMAIL_PASSWORD: z.string().optional(),
  EMAIL_FROM: z.string().min(1),

  // SMS
  SMS_PROVIDER: z.enum(['africastalking', 'twilio']).default('africastalking'),
  SMS_API_KEY: z.string().min(1),
  SMS_USERNAME: z.string().optional(),
  SMS_SENDER_ID: z.string().default('PINE'),

  // Market sync
  MSE_DATA_SOURCE: z.enum(['scraper', 'api', 'csv']).default('scraper'),
  MSE_API_BASE_URL: z.string().optional(),
  MSE_API_KEY: z.string().optional(),
  MARKET_SYNC_CRON: z.string().default('*/15 8-16 * * 1-5'),
  MARKET_TIMEZONE: z.string().default('Africa/Blantyre'),
  MARKET_OPEN_TIME: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .default('10:00'),
  MARKET_CLOSE_TIME: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .default('14:00'),
  MSE_MOCK_FALLBACK: booleanFromString.default('false'),

  // Observability
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  SENTRY_DSN: z.string().optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  PROMETHEUS_METRICS_PATH: z.string().default('/metrics'),

  // Security
  TRUST_PROXY: booleanFromString.default('true'),
  BODY_LIMIT: z.string().default('1mb'),
  COOKIE_SECRET: z.string().min(32, 'COOKIE_SECRET must be at least 32 characters'),

  // Mastercard Gateway (Direct Payment)
  MCGS_BASE_URL: z.string().url().default('https://test-nbm.mtf.gateway.mastercard.com'),
  MCGS_MERCHANT_ID: z.string().optional(),
  MCGS_API_PASSWORD: z.string().optional(),
  MCGS_API_VERSION: z.coerce.number().int().positive().default(100),
  MCGS_ENVIRONMENT: z.enum(['test', 'production']).default('test'),
});

export type EnvSchema = z.infer<typeof envSchema>;

/**
 * Entry point wired into `ConfigModule.forRoot({ validate })`.
 * Throwing here aborts Nest's bootstrap process before any HTTP listener
 * or database connection is opened.
 */
export function validateEnv(config: Record<string, unknown>): EnvSchema {
  const parsed = envSchema.safeParse(config);

  if (!parsed.success) {
    const formatted = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');

    // Intentionally thrown synchronously and not logged via Pino: the
    // logger itself depends on validated config, so we fall back to
    // stderr for this one, first-and-only, unrecoverable message.

    console.error(`\n❌ Invalid environment configuration:\n${formatted}\n`);
    throw new Error('Environment validation failed. See errors above.');
  }

  return parsed.data;
}
