import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule } from '../../config/config.module';
import { WalletModule } from '../wallet/wallet.module';
import { TradingModule } from '../trading/trading.module';
import { MastercardGatewayModule } from '../mastercard-gateway/mastercard-gateway.module';
import { MastercardGatewayService } from '../mastercard-gateway/services/mastercard-gateway.service';
import { PaychanguService } from './services/paychangu.service';
import { BankCardService } from './services/bank-card.service';
import { PaymentsController } from './controllers/payments.controller';
import { WalletService } from '../wallet/services/wallet.service';
import { TradingService } from '../trading/services/trading.service';

/**
 * PaymentsModule — payment gateway integrations.
 *
 * Gateways:
 *   • PayChangu           — mobile money & card via hosted checkout webview
 *   • MastercardGateway   — direct bank card payments (Mastercard Gateway REST API)
 *
 * PayChangu flow:
 *   1. POST /payments/initiate → creates wallet tx + PayChangu checkout
 *   2. User pays in PayChangu checkout
 *   3. GET /payments/callback → verifies + processes payment → deep links to app
 *      - DEPOSIT    → credits wallet balance
 *      - BUY_SHARES → credits wallet, then submits buy order via TradingService
 *   4. GET /payments/verify/:txRef → mobile polls for status
 *
 * Bank Card (Mastercard Gateway) flow:
 *   1. POST /payments/card/initiate → charges card directly via Mastercard Gateway
 *   2. GET /payments/card/verify/:txRef → mobile polls for status
 *   3. POST /v1/payments/mcgs/webhook → gateway sends real-time status updates
 */
@Module({
  imports: [
    ConfigModule,
    WalletModule,
    TradingModule,
    MastercardGatewayModule,
  ],
  controllers: [PaymentsController],
  providers: [
    PaychanguService,
    /**
     * Wire MastercardGatewayService as the implementation behind the
     * BankCardService injection token.  Anywhere that injects BankCardService
     * will receive the Mastercard implementation transparently.
     */
    {
      provide: BankCardService,
      useExisting: MastercardGatewayService,
    },
  ],
  exports: [
    PaychanguService,
    BankCardService,
  ],
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
