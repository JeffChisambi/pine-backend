import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AppConfigService } from '../../config/app-config.service';
import { ConfigModule } from '../../config/config.module';
import { QueueName } from '../../core/constants/queue-names.constant';

/**
 * Registers the BullMQ connection and every named queue up front so any
 * module can `@InjectQueue(QueueName.X)` a producer without redeclaring
 * connection options. Consumers (`@Processor` classes) are registered
 * per-module starting Phase 2 (e.g. `EmailProcessor` in the
 * Notification module) — this module only sets up the queues
 * themselves, it does not process jobs.
 *
 * Uses its own Redis connection (via `BullModule.forRootAsync`, not the
 * shared `REDIS_CLIENT` from `infrastructure/redis`) because BullMQ
 * requires `maxRetriesPerRequest: null` on its connection, which is the
 * wrong setting for general-purpose Redis calls elsewhere in the app.
 */
@Module({
  imports: [
    ConfigModule,
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        connection: {
          host: config.redis.host,
          port: config.redis.port,
          password: config.redis.password,
          db: config.redis.db,
          tls: config.redis.tls ? {} : undefined,
          maxRetriesPerRequest: null,
        },
      }),
    }),
    BullModule.registerQueue(
      { name: QueueName.EMAIL },
      { name: QueueName.SMS },
      { name: QueueName.NOTIFICATION },
      { name: QueueName.TRADE_PROCESSING },
      { name: QueueName.DIVIDEND },
      { name: QueueName.KYC },
      { name: QueueName.MARKET_SYNC },
      { name: QueueName.WEBHOOK },
      { name: QueueName.AUDIT },
    ),
  ],
  exports: [BullModule],
})
export class QueueModule {}
