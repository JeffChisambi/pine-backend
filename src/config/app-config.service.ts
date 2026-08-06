import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  AppConfig,
  CorsConfig,
  DatabaseConfig,
  EmailConfig,
  JwtConfig,
  MarketConfig,
  MastercardGatewayConfig,
  ObservabilityConfig,
  OtpConfig,
  RateLimitConfig,
  RedisConfig,
  SecurityConfig,
  SmsConfig,
  StorageConfig,
} from './config.types';

/**
 * Every other module in the codebase should depend on `AppConfigService`,
 * never on the raw `ConfigService` or `process.env` directly. This keeps
 * config access typed, testable (trivial to mock in unit tests), and
 * gives us one place to change if the underlying config source ever
 * changes (e.g. move to AWS Secrets Manager / Vault at runtime).
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly configService: ConfigService) {}

  get app(): AppConfig {
    return this.configService.getOrThrow<AppConfig>('app');
  }

  get cors(): CorsConfig {
    return this.configService.getOrThrow<CorsConfig>('cors');
  }

  get database(): DatabaseConfig {
    return this.configService.getOrThrow<DatabaseConfig>('database');
  }

  get redis(): RedisConfig {
    return this.configService.getOrThrow<RedisConfig>('redis');
  }

  get jwt(): JwtConfig {
    return this.configService.getOrThrow<JwtConfig>('jwt');
  }

  get security(): SecurityConfig {
    return this.configService.getOrThrow<SecurityConfig>('security');
  }

  get otp(): OtpConfig {
    return this.configService.getOrThrow<OtpConfig>('otp');
  }

  get rateLimit(): RateLimitConfig {
    return this.configService.getOrThrow<RateLimitConfig>('rateLimit');
  }

  get storage(): StorageConfig {
    return this.configService.getOrThrow<StorageConfig>('storage');
  }

  get email(): EmailConfig {
    return this.configService.getOrThrow<EmailConfig>('email');
  }

  get sms(): SmsConfig {
    return this.configService.getOrThrow<SmsConfig>('sms');
  }

  get market(): MarketConfig {
    return this.configService.getOrThrow<MarketConfig>('market');
  }

  get observability(): ObservabilityConfig {
    return this.configService.getOrThrow<ObservabilityConfig>('observability');
  }

  get mastercardGateway(): MastercardGatewayConfig {
    return this.configService.getOrThrow<MastercardGatewayConfig>('mastercardGateway');
  }
}
