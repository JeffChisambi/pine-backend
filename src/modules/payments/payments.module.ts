import { Module } from '@nestjs/common';
import { ConfigModule } from '../../config/config.module';
import { WalletModule } from '../wallet/wallet.module';
import { PaychanguService } from './services/paychangu.service';
import { PaymentsController } from './controllers/payments.controller';

/**
 * PaymentsModule — PayChangu integration for deposits and share purchases.
 *
 * Flow:
 *   1. POST /payments/initiate → creates wallet tx + PayChangu checkout
 *   2. User pays in PayChangu checkout
 *   3. GET /payments/callback → verifies + processes deposit → deep links to app
 *   4. GET /payments/verify/:txRef → mobile polls for status
 */
@Module({
  imports: [
    ConfigModule,
    WalletModule,
  ],
  controllers: [PaymentsController],
  providers: [PaychanguService],
  exports: [PaychanguService],
})
export class PaymentsModule {}
