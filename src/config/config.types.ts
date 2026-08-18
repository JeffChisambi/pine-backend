export interface AppConfig {
  name: string;
  env: 'development' | 'test' | 'staging' | 'production';
  port: number;
  url: string;
  /** Broker dashboard origin — used in emails (invitation activation links). */
  dashboardUrl: string;
  apiPrefix: string;
  timezone: string;
  isProduction: boolean;
  isDevelopment: boolean;
  isTest: boolean;
}

export interface CorsConfig {
  origins: string[];
  credentials: boolean;
}

export interface DatabaseConfig {
  url: string;
  readReplicaUrl: string;
  ssl: boolean;
  poolMin: number;
  poolMax: number;
}

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  db: number;
  tls: boolean;
}

export interface JwtConfig {
  accessSecret: string;
  accessExpiresIn: string;
  refreshSecret: string;
  refreshExpiresIn: string;
  issuer: string;
  audience: string;
}

export interface SecurityConfig {
  pinEncryptionKey: string;
  argon2: {
    memoryCost: number;
    timeCost: number;
    parallelism: number;
  };
  trustProxy: boolean;
  bodyLimit: string;
  cookieSecret: string;
}

export interface OtpConfig {
  length: number;
  ttlSeconds: number;
  maxAttempts: number;
  resendCooldownSeconds: number;
}

export interface RateLimitConfig {
  ttlMs: number;
  max: number;
  authMax: number;
}

export interface StorageConfig {
  provider: 's3' | 'r2' | 'minio';
  endpoint: string;
  /** Public-facing endpoint for signed download URLs (defaults to endpoint). */
  publicEndpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  buckets: {
    avatars: string;
    kyc: string;
    reports: string;
  };
  signedUrlTtlSeconds: number;
  maxUploadMb: number;
}

export interface EmailConfig {
  provider: 'smtp' | 'ses';
  host: string;
  port: number;
  user?: string;
  password?: string;
  from: string;
}

export interface SmsConfig {
  provider: 'africastalking' | 'twilio';
  apiKey: string;
  username?: string;
  senderId: string;
}


export interface MarketConfig {
  dataSource: 'scraper' | 'api' | 'csv';
  apiBaseUrl?: string;
  apiKey?: string;
  syncCron: string;
  timezone: string;
  openTime: string;
  closeTime: string;
  mockFallback: boolean;
}

export interface ObservabilityConfig {
  logLevel: string;
  sentryDsn?: string;
  otelEndpoint?: string;
  metricsPath: string;
}

export interface MastercardGatewayConfig {
  /** Gateway base URL. Use test URL for sandbox, production URL for live. */
  baseUrl: string;
  /** Merchant ID issued by the payment provider — up to 12 characters. */
  merchantId?: string;
  /** API password for HTTP Basic authentication. */
  apiPassword?: string;
  /** REST API version (e.g. 100). Check the gateway docs for the latest. */
  apiVersion: number;
  /** 'test' or 'production' — controls logging verbosity and safety checks. */
  environment: 'test' | 'production';
}
