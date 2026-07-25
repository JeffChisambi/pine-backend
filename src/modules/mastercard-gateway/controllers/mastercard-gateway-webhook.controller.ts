import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Request } from 'express';
import { Public } from '../../../core/decorators/public.decorator';
import { AppConfigService } from '../../../config/app-config.service';
import { MastercardWebhookDto } from '../dto/mastercard-request.dto';

/**
 * MastercardGatewayWebhookController
 *
 * Receives transaction-status notifications (webhooks) sent by the Mastercard
 * Gateway to the merchant's configured notification URL.
 *
 * ─── How Mastercard notifications work ───────────────────────────────────────
 * After configuring a notification URL in the gateway merchant profile, the
 * gateway POSTs a JSON payload to this endpoint whenever a transaction status
 * changes (e.g. APPROVED → SETTLED, or a chargeback is raised).
 *
 * The gateway does not sign its notifications with an HMAC/JWT — instead, it
 * originates from known IP ranges. For production hardening, add IP allowlisting
 * in a NestJS guard or at the reverse-proxy layer.
 *
 * Because this endpoint is called server-to-server by the gateway (not by the
 * mobile app), it is marked @Public() to bypass JWT auth.
 * ─────────────────────────────────────────────────────────────────────────────
 */
@ApiExcludeController()
@Controller('payments/mcgs')
export class MastercardGatewayWebhookController {
  private readonly logger = new Logger(MastercardGatewayWebhookController.name);

  constructor(private readonly config: AppConfigService) {}

  /**
   * POST /v1/payments/mcgs/webhook
   *
   * Receives Mastercard Gateway transaction-status notifications.
   *
   * The gateway expects a 2xx response within its configured timeout.
   * Any non-2xx causes a retry. Idempotent processing is therefore required
   * (the same notification may arrive more than once).
   *
   * TODO (Phase 3): Emit a domain event and update the corresponding
   * Payment record in the database based on the notification result.
   */
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @Public()
  async handleNotification(
    @Req() req: RawBodyRequest<Request>,
    @Body() dto: MastercardWebhookDto,
  ): Promise<{ received: true }> {
    // Extract the key identifiers for structured logging
    const orderId = dto.orderId ?? 'unknown';
    const transactionId = dto.transactionId ?? 'unknown';
    const result = dto.result ?? 'unknown';
    const gatewayCode =
      (dto.response as Record<string, string> | undefined)?.gatewayCode ?? 'unknown';

    this.logger.log(
      { orderId, transactionId, result, gatewayCode },
      'Mastercard Gateway notification received',
    );

    // ── Future implementation notes ──────────────────────────────────────────
    //
    // 1. Idempotency: check if this notification has already been processed
    //    (e.g. Redis key `mcgs:notif:{orderId}:{transactionId}` with a short TTL).
    //
    // 2. Locate the matching Payment record in the database using orderId
    //    (which equals Pine's txRef).
    //
    // 3. Map result/gatewayCode to PaymentStatus and update the record
    //    (INITIATED → COMPLETED | FAILED).
    //
    // 4. If the payment is for a wallet top-up, credit the wallet balance.
    //    If it's for a trade, release the pending trade reservation.
    //
    // 5. Emit a domain event (e.g. PaymentStatusChangedEvent) that downstream
    //    modules (notifications, audit, trading) can react to.
    //
    // 6. For chargebacks (result = 'CHARGEBACK'), notify the finance team and
    //    place the wallet balance on hold.
    //
    // ─────────────────────────────────────────────────────────────────────────

    // Always return 200 immediately so the gateway does not retry
    return { received: true };
  }
}
