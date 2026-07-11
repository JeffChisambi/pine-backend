import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.validation';

const validEnv = {
  NODE_ENV: 'test',
  APP_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  REDIS_HOST: 'localhost',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  PIN_ENCRYPTION_KEY: 'c'.repeat(32),
  STORAGE_ENDPOINT: 'http://localhost:9000',
  STORAGE_ACCESS_KEY_ID: 'key',
  STORAGE_SECRET_ACCESS_KEY: 'secret',
  STORAGE_BUCKET_AVATARS: 'avatars',
  STORAGE_BUCKET_KYC: 'kyc',
  STORAGE_BUCKET_REPORTS: 'reports',
  EMAIL_HOST: 'localhost',
  EMAIL_FROM: 'Pine <no-reply@pine.mw>',
  SMS_API_KEY: 'key',
  PAYCHANGU_BASE_URL: 'https://api.paychangu.com',
  PAYCHANGU_PUBLIC_KEY: 'pub',
  PAYCHANGU_SECRET_KEY: 'secret',
  PAYCHANGU_WEBHOOK_SECRET: 'whsec',
  COOKIE_SECRET: 'd'.repeat(32),
};

describe('validateEnv', () => {
  it('accepts a fully valid environment and applies defaults', () => {
    const result = validateEnv(validEnv);
    expect(result.APP_PORT).toBe(3000);
    expect(result.JWT_ACCESS_EXPIRES_IN).toBe('15m');
    expect(result.OTP_LENGTH).toBe(6);
  });

  it('throws when a required variable is missing', () => {
    const rest = { ...validEnv };
    delete (rest as Partial<typeof validEnv>).DATABASE_URL;
    expect(() => validateEnv(rest)).toThrow(/Environment validation failed/);
  });

  it('throws when a secret is shorter than the minimum length', () => {
    expect(() => validateEnv({ ...validEnv, JWT_ACCESS_SECRET: 'too-short' })).toThrow(
      /Environment validation failed/,
    );
  });

  it('rejects an invalid NODE_ENV value', () => {
    expect(() => validateEnv({ ...validEnv, NODE_ENV: 'staging-typo' })).toThrow();
  });

  it('coerces numeric strings to numbers', () => {
    const result = validateEnv({ ...validEnv, APP_PORT: '8080' });
    expect(result.APP_PORT).toBe(8080);
    expect(typeof result.APP_PORT).toBe('number');
  });
});
