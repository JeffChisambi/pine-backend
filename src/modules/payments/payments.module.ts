import { Module } from '@nestjs/common';
import { ConfigModule } from '../../config/config.module';
import { WalletModule } from '../wallet/wallet.module';
import { MastercardGatewayModule } from '../mastercard-gateway/mastercard-gateway.module';
import { MastercardGatewayService } from '../mastercard-gateway/services/mastercard-gateway.service';
import { PaychanguService } from './services/paychangu.service';
import { BankCardService } from './services/bank-card.service';
import { PaymentsController } from './controllers/payments.controller';

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
 *   3. GET /payments/callback → verifies + processes deposit → deep links to app
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
export class PaymentsModule {}
