import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { ConfigModule } from '../../config/config.module';
import { AuthModule } from '../auth/auth.module';

// Repository
import { TradingRepository } from './repositories/trading.repository';

// Services
import { TradingService } from './services/trading.service';
import { OrderService } from './services/order.service';
import { ValidationService } from './services/validation.service';
import { MarketService } from './services/market.service';
import { RiskService } from './services/risk.service';
import { ExecutionEngineService } from './services/execution-engine.service';
import { LedgerService } from './services/ledger.service';
import { SettlementService } from './services/settlement.service';
import {
  BrokerGateway,
  SandboxBrokerAdapter,
  BROKER_ADAPTER,
} from './services/broker-gateway.service';

// Controller
import { TradingController } from './controllers/trading.controller';

/**
 * TradingModule — the full trading pipeline.
 *
 * Architecture:
 *   Controller → TradingService (orchestrator)
 *     → OrderService       (CRUD)
 *     → ValidationService  (pre-trade checks)
 *     → RiskService        (risk limits)
 *     → ExecutionEngine     (trade execution via BrokerGateway)
 *     → LedgerService      (double-entry bookkeeping, via events)
 *     → SettlementService  (T+0 settlement, via events)
 *
 * BrokerGateway uses SandboxBrokerAdapter by default.
 * Switch to MSEBrokerAdapter when the broker dashboard is ready.
 */
@Module({
  imports: [
    DatabaseModule,
    ConfigModule,
    AuthModule,
  ],
  controllers: [TradingController],
  providers: [
    // Repository
    TradingRepository,

    // Broker adapter — swap this to MSEBrokerAdapter for production
    {
      provide: BROKER_ADAPTER,
      useClass: SandboxBrokerAdapter,
    },
    {
      provide: BrokerGateway,
      useFactory: (adapter: any) => new BrokerGateway(adapter),
      inject: [BROKER_ADAPTER],
    },

    // Services
    MarketService,
    OrderService,
    ValidationService,
    RiskService,
    ExecutionEngineService,
    LedgerService,
    SettlementService,
    TradingService,
  ],
  exports: [
    TradingService,
    MarketService,
    TradingRepository,
  ],
})
export class TradingModule {}
