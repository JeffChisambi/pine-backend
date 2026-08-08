import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule } from '../../config/config.module';
import { WalletModule } from '../wallet/wallet.module';
import { TradingModule } from '../trading/trading.module';
import { MastercardGatewayModule } from '../mastercard-gateway/mastercard-gateway.module';
import { PaymentsController } from './controllers/payments.controller';
import { SavedCardsController } from './controllers/saved-cards.controller';
import { CardPaymentService } from './services/card-payment.service';
import { MockBankCardGatewayService } from './services/mock-bank-card.service';
import { SavedCardService } from './services/saved-card.service';
import { CardEncryptionService } from './services/card-encryption.service';
import { WalletService } from '../wallet/services/wallet.service';
import { TradingService } from '../trading/services/trading.service';

/**
 * PaymentsModule — bank card deposits.
 *
 * Layers:
 *   PaymentsController → CardPaymentService (orchestration, idempotency,
 *   failure mapping) → gateway:
 *     • MastercardGatewayService — live MPGS integration; activates
 *       automatically once MCGS_MERCHANT_ID + MCGS_API_PASSWORD are set.
 *     • MockBankCardGatewayService — Test Transaction mode; same contract,
 *       same error taxonomy, zero business-logic divergence.
 *
 * Adding another provider = implement the gateway contract + extend the
 * resolver in CardPaymentService. Business logic stays untouched.
 */
@Module({
  imports: [
    ConfigModule,
    WalletModule,
    TradingModule,
    MastercardGatewayModule,
  ],
  controllers: [PaymentsController, SavedCardsController],
  providers: [
    CardPaymentService,
    MockBankCardGatewayService,
    SavedCardService,
    CardEncryptionService,
  ],
  exports: [CardPaymentService, SavedCardService],
})
export class PaymentsModule implements OnModuleInit {
  constructor(
    private readonly walletService: WalletService,
    private readonly tradingService: TradingService,
  ) {}

  /**
   * Wire TradingService into WalletService after all modules are initialised.
   * This breaks the Wallet ↔ Trading circular dependency without forwardRef.
   */
  onModuleInit(): void {
    this.walletService.setTradingService(this.tradingService);
  }
}
