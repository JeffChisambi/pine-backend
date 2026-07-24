import { Module } from '@nestjs/common';
import { ConfigModule } from '../../config/config.module';
import { WalletModule } from '../wallet/wallet.module';
import { PaychanguService } from './services/paychangu.service';
import { BankCardService } from './services/bank-card.service';
import { PaymentsController } from './controllers/payments.controller';

/**
 * PaymentsModule — payment gateway integrations.
 *
 * Gateways:
 *   • PayChangu  — mobile money & card via hosted checkout webview
 *   • BankCardService — direct bank card (skeleton; wire up processor)
 *
 * PayChangu flow:
 *   1. POST /payments/initiate → creates wallet tx + PayChangu checkout
 *   2. User pays in PayChangu checkout
 *   3. GET /payments/callback → verifies + processes deposit → deep links to app
 *   4. GET /payments/verify/:txRef → mobile polls for status
 *
 * Bank Card flow:
 *   1. POST /payments/card/initiate → creates wallet tx + charges card directly
 *   2. GET /payments/card/verify/:txRef → mobile polls for status
 */
@Module({
  imports: [
    ConfigModule,
    WalletModule,
  ],
  controllers: [PaymentsController],
  providers: [
    PaychanguService,
    BankCardService,
  ],
  exports: [
    PaychanguService,
    BankCardService,
  ],
})
export class PaymentsModule {}
