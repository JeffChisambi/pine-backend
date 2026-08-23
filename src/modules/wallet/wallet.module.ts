import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { ConfigModule } from '../../config/config.module';
import { AuthModule } from '../auth/auth.module';
import { BrokersModule } from '../brokers/brokers.module';

// Repository
import { WalletRepository } from './repositories/wallet.repository';

// Calculator
import { WalletCalculator } from './services/wallet-calculator.service';

// Services
import { BalanceService } from './services/balance.service';
import { ReservationService } from './services/reservation.service';
import { StatementService } from './services/statement.service';
import { WalletService } from './services/wallet.service';

// Controller
import { WalletController } from './controllers/wallet.controller';

/**
 * WalletModule — the customer's cash position view.
 *
 * The Wallet answers: "How much money does this customer have available?"
 *
 * The Wallet is NOT the source of truth for money — the Ledger is.
 * wallet.balance is a denormalized cache, reconciled nightly.
 *
 * Architecture:
 *   Controller → WalletService (orchestrator)
 *     → BalanceService       (available/reserved/pending/total)
 *     → ReservationService   (fund holds for pending orders)
 *     → StatementService     (transaction history & charts)
 *     → WalletCalculator     (pure computation)
 *
 * Event-driven:
 *   Listens: payments.deposit.completed, payments.withdrawal.completed,
 *            trading.order.cancelled, trading.trade.settled
 *
 * Cron:
 *   Daily wallet snapshots at 13:00 UTC (15:00 CAT)
 *   Expire stale reservations every 15 minutes
 */
@Module({
  imports: [
    DatabaseModule,
    ConfigModule,
    AuthModule,
    // FeePolicyService — deposit processing-fee schedule.
    BrokersModule,
  ],
  controllers: [WalletController],
  providers: [
    WalletRepository,
    WalletCalculator,
    BalanceService,
    ReservationService,
    StatementService,
    WalletService,
  ],
  exports: [
    WalletService,
    BalanceService,
    ReservationService,
    WalletRepository,
  ],
})
export class WalletModule {}
