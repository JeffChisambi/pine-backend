import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfigService } from '../../config/app-config.service';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/**
 * Single shared ioredis connection, used across the app for:
 *   - OTP storage (auth module)
 *   - Session / refresh-token-family lookups (auth module)
 *   - Rate limiting (`ThrottlerBehindProxyGuard`, `core/guards`)
 *   - Market data cache (stocks module)
 *   - Portfolio snapshot cache (portfolio module)
 *   - BullMQ's own connection is separate (see `infrastructure/queue`)
 *     since BullMQ requires `maxRetriesPerRequest: null` on its
 *     connection, which we do NOT want on this general-purpose client.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (config: AppConfigService): Redis => {
        const { host, port, password, db, tls } = config.redis;
        return new Redis({
          host,
          port,
          password,
          db,
          tls: tls ? {} : undefined,
          maxRetriesPerRequest: 3,
          retryStrategy: (times: number) => Math.min(times * 200, 5_000),
        });
      },
      inject: [AppConfigService],
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit();
  }
}
