import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { ConfigModule } from './config/config.module';
import { AppConfigService } from './config/app-config.service';
import { CorrelationIdMiddleware } from './core/middleware/correlation-id.middleware';
import { GlobalExceptionFilter } from './core/filters/global-exception.filter';
import { ResponseEnvelopeInterceptor } from './core/interceptors/response-envelope.interceptor';
import { ThrottlerBehindProxyGuard } from './core/guards/throttler-behind-proxy.guard';
import { DatabaseModule } from './infrastructure/database/database.module';
import { RedisModule } from './infrastructure/redis/redis.module';
import { LoggerModule } from './infrastructure/logger/logger.module';
import { QueueModule } from './infrastructure/queue/queue.module';
import { StorageModule } from './infrastructure/storage/storage.module';
import { HealthModule } from './infrastructure/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { KycModule } from './modules/kyc/kyc.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { StocksModule } from './modules/stocks/stocks.module';
import { MarketSyncModule } from './modules/market-sync/market-sync.module';
import { TradingModule } from './modules/trading/trading.module';
import { PortfolioModule } from './modules/portfolio/portfolio.module';
import { DividendsModule } from './modules/dividends/dividends.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { AdminModule } from './modules/admin/admin.module';
import { AuditModule } from './modules/audit/audit.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { WatchlistModule } from './modules/watchlist/watchlist.module';

@Module({
  imports: [
    // ---- Cross-cutting infrastructure (order matters: Config first) ----
    ConfigModule,
    LoggerModule,
    DatabaseModule,
    RedisModule,
    QueueModule,
    StorageModule,
    HealthModule,

    // ---- Platform services ----
    EventEmitterModule.forRoot({ wildcard: false, global: true, delimiter: '.' }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        throttlers: [{ ttl: config.rateLimit.ttlMs, limit: config.rateLimit.max }],
      }),
    }),

    // ---- Feature modules (Phase 2+, scaffolded empty in Phase 1) ----
    AuthModule,
    UsersModule,
    KycModule,
    WalletModule,
    PaymentsModule,
    StocksModule,
    MarketSyncModule,
    TradingModule,
    PortfolioModule,
    DividendsModule,
    NotificationsModule,
    AdminModule,
    AuditModule,
    AnalyticsModule,
    WatchlistModule,
  ],
  providers: [
    // Applied globally, outermost-to-innermost as Nest resolves them:
    // guard -> interceptor -> filter is the effective request/response
    // order once combined with Nest's own pipeline.
    { provide: APP_GUARD, useClass: ThrottlerBehindProxyGuard },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes({ path: '*', method: RequestMethod.ALL });
  }
}
