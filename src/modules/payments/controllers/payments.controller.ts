import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Response } from 'express';
import { CurrentUser } from '../../../core/decorators/current-user.decorator';
import { Public } from '../../../core/decorators/public.decorator';
import type { AuthenticatedUser } from '../../../core/types/request-context.types';
import { AppConfigService } from '../../../config/app-config.service';
import { PaychanguService } from '../services/paychangu.service';
import { WalletService } from '../../wallet/services/wallet.service';
import { TradingService } from '../../trading/services/trading.service';
import { InitiatePaymentDto } from '../dto/payment.dto';
import { randomUUID } from 'crypto';

/**
 * PaymentsController — handles PayChangu payment flows.
 *
 * Flow:
 *  1. Mobile app → POST /payments/initiate (authenticated)
 *     - Creates a PENDING wallet transaction
 *     - Calls PayChangu API to get a checkout_url
 *     - Returns { checkoutUrl, txRef } to mobile
 *
 *  2. User pays in the PayChangu checkout (browser/webview)
 *
 *  3. PayChangu redirects → GET /payments/callback?tx_ref=...&status=...
 *     - Backend verifies payment with PayChangu
 *     - If successful, processes the deposit (credits wallet)
 *     - Redirects to mobile app via deep link: pine://payment/success?tx_ref=...
 *
 *  4. Mobile app → GET /payments/verify/:txRef (authenticated)
 *     - Returns the current status of the payment
 */
@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(
    private readonly paychangu: PaychanguService,
    private readonly walletService: WalletService,
    private readonly config: AppConfigService,
  ) {}

  // ── Initiate Payment ─────────────────────────────────────

  @Post('initiate')
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Initiate a PayChangu checkout for deposit/purchase' })
  @ApiResponse({ status: 201, description: 'Checkout session created' })
  async initiatePayment(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: InitiatePaymentDto,
  ) {
    const txRef = `PINE-${randomUUID()}`;
    const purpose = dto.purpose || 'DEPOSIT';

    // Determine callback/return URLs (use ngrok URL if set, else APP_URL)
    const baseUrl = process.env.NGROK_URL || this.config.app.url;
    const callbackUrl = `${baseUrl}/v1/payments/callback`;
    const returnUrl = `${baseUrl}/v1/payments/return`;

    this.logger.log({
      userId: user.id,
      amount: dto.amount,
      currency: dto.currency,
      purpose,
      txRef,
      callbackUrl,
    }, 'Initiating payment');

    // Create a pending wallet deposit transaction
    const { transactionId } = await this.walletService.initiateDeposit({
      userId: user.id,
      amount: dto.amount,
      idempotencyKey: txRef,
    });

    // Call PayChangu to create checkout
    const result = await this.paychangu.initiatePayment({
      amount: dto.amount,
      currency: dto.currency,
      txRef,
      email: user.email ?? undefined,
      callbackUrl,
      returnUrl,
      meta: {
        userId: user.id,
        transactionId,
        purpose,
        stockSymbol: dto.stockSymbol,
        quantity: dto.quantity,
      },
      customization: {
        title: purpose === 'BUY_SHARES'
          ? `Buy ${dto.quantity} ${dto.stockSymbol} shares`
          : 'Pine Wallet Deposit',
        description: `MWK ${dto.amount.toLocaleString()} payment via Pine`,
      },
    });

    return {
      checkoutUrl: result.data.checkout_url,
      txRef: result.data.data.tx_ref,
      transactionId,
      status: 'PENDING',
    };
  }

  // ── Callback (PayChangu redirects here after payment) ────

  @Get('callback')
  @Public()
  @ApiOperation({ summary: 'PayChangu payment callback — verifies and processes payment' })
  async handleCallback(
    @Query('tx_ref') txRef: string,
    @Query('status') status: string,
    @Res() res: Response,
  ) {
    this.logger.log({ txRef, status }, 'PayChangu callback received');

    // HTTPS sentinel base — the mobile WebView can load this and intercept it
    // by path. A custom scheme (pine://) is dropped by Android WebView.
    const baseUrl = process.env.NGROK_URL || this.config.app.url;

    try {
      // Verify with PayChangu
      const verification = await this.paychangu.verifyPayment(txRef);

      if (verification.data?.status === 'success') {
        // Find the pending transaction by idempotency key (txRef)
        const transactionId = verification.data?.meta?.transactionId;

        if (transactionId) {
          await this.walletService.processDeposit(transactionId);
          this.logger.log({ txRef, transactionId }, 'Payment verified and deposit processed');
        }

        // Redirect back to the app via the HTTPS sentinel page
        return res.redirect(`${baseUrl}/v1/payments/app-return?status=success&tx_ref=${txRef}`);
      } else {
        this.logger.warn({ txRef, payStatus: verification.data?.status }, 'Payment not successful');
        return res.redirect(`${baseUrl}/v1/payments/app-return?status=failed&tx_ref=${txRef}`);
      }
    } catch (error) {
      this.logger.error({ err: error, txRef }, 'Callback processing failed');
      return res.redirect(
        `${baseUrl}/v1/payments/app-return?status=failed&tx_ref=${txRef}&error=verification_failed`,
      );
    }
  }

  // ── Return URL (user cancelled or failed) ─────────────────

  @Get('return')
  @Public()
  @ApiOperation({ summary: 'PayChangu return URL for cancelled/failed payments' })
  async handleReturn(
    @Query('tx_ref') txRef: string,
    @Query('status') status: string,
    @Res() res: Response,
  ) {
    this.logger.log({ txRef, status }, 'PayChangu return (cancelled/failed)');
    const baseUrl = process.env.NGROK_URL || this.config.app.url;
    return res.redirect(`${baseUrl}/v1/payments/app-return?status=cancelled&tx_ref=${txRef}`);
  }

  // ── App Return (HTTPS sentinel the mobile WebView intercepts) ─────────────

  @Get('app-return')
  @Public()
  @ApiOperation({ summary: 'HTTPS landing page the mobile app WebView intercepts after payment' })
  async handleAppReturn(
    @Query('status') status: string,
    @Query('tx_ref') txRef: string,
    @Res() res: Response,
  ) {
    this.logger.log({ txRef, status }, 'App return page served');

    // Minimal self-contained page. The mobile WebView matches this URL by path
    // (/payments/app-return) and routes in-app before this is ever shown for long.
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Returning to Pine…</title>
<style>
  html,body{height:100%;margin:0}
  body{display:flex;flex-direction:column;align-items:center;justify-content:center;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    background:#F9FAFB;color:#164951}
  .spinner{width:40px;height:40px;border:4px solid rgba(22,73,81,.15);
    border-top-color:#164951;border-radius:50%;animation:spin 1s linear infinite}
  p{margin-top:20px;font-size:15px;color:#164951}
  @keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>
  <div class="spinner"></div>
  <p>Returning to Pine…</p>
</body>
</html>`;

    return res.status(HttpStatus.OK).type('html').send(html);
  }

  // ── Verify Payment (mobile app polls this) ────────────────

  @Get('verify/:txRef')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Verify payment status' })
  async verifyPayment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('txRef') txRef: string,
  ) {
    this.logger.log({ userId: user.id, txRef }, 'Verifying payment');

    const verification = await this.paychangu.verifyPayment(txRef);

    return {
      txRef,
      status: verification.data?.status || 'unknown',
      amount: verification.data?.amount,
      currency: verification.data?.currency,
      channel: verification.data?.authorization?.channel,
      completedAt: verification.data?.authorization?.completed_at,
    };
  }

  // ── Webhook (PayChangu server-to-server) ──────────────────

  @Post('webhook')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'PayChangu webhook endpoint' })
  async handleWebhook(@Body() body: any) {
    this.logger.log({ event: body?.event, txRef: body?.tx_ref }, 'Webhook received');

    // TODO: Validate webhook signature using PAYCHANGU_WEBHOOK_SECRET
    // For now, just log — the callback flow is the primary path

    return { received: true };
  }
}
