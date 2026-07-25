import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MastercardGatewayService } from './services/mastercard-gateway.service';
import { MastercardGatewayWebhookController } from './controllers/mastercard-gateway-webhook.controller';

/**
 * MastercardGatewayModule
 *
 * Encapsulates all integration with the Mastercard Gateway REST API
 * (Direct Payment model).
 *
 * ─── What this module provides ───────────────────────────────────────────────
 *
 * • MastercardGatewayService — implements IBankCardGateway (from PaymentsModule)
 *   and the extended IMastercardGateway interface. Covers:
 *     - PAY        (authorize + capture in one step)
 *     - AUTHORIZE  (reserve funds only)
 *     - CAPTURE    (settle a previous authorization)
 *     - REFUND     (full or partial)
 *     - VOID       (cancel an un-settled transaction)
 *     - VERIFY     (validate card without charging)
 *     - RETRIEVE   (poll transaction status)
 *     - Health     (gateway connectivity check)
 *
 * • MastercardGatewayWebhookController — receives real-time transaction-status
 *   notifications (webhooks) posted by the gateway to POST /v1/payments/mcgs/webhook.
 *
 * ─── Integration ─────────────────────────────────────────────────────────────
 *
 * PaymentsModule imports this module and wires MastercardGatewayService as the
 * provider behind the BankCardService injection token.  No other module needs
 * to import MastercardGatewayModule directly — all card payment operations go
 * through PaymentsModule.
 *
 * ─── Required environment variables ──────────────────────────────────────────
 *
 * MCGS_BASE_URL          Gateway base URL (default: https://test-nbm.mtf.gateway.mastercard.com)
 * MCGS_MERCHANT_ID       Merchant ID issued by the payment provider
 * MCGS_API_PASSWORD      API password for HTTP Basic authentication
 * MCGS_API_VERSION       REST API version (default: 100)
 * MCGS_ENVIRONMENT       test | production (default: test)
 *
 * See .env.example for full list.
 *
 * ─── PCI-DSS scope note ───────────────────────────────────────────────────────
 *
 * This module uses the Direct Payment integration model, which means the
 * server handles raw card data (PAN, CVV).  This increases PCI DSS scope.
 * When a frontend card-capture SDK is available, consider migrating to the
 * Hosted Session model so card data never touches this server.
 * ─────────────────────────────────────────────────────────────────────────────
 */
@Module({
  imports: [ConfigModule],
  controllers: [MastercardGatewayWebhookController],
  providers: [MastercardGatewayService],
  exports: [MastercardGatewayService],
})
export class MastercardGatewayModule {}
