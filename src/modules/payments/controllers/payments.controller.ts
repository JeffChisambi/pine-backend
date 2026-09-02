import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../../core/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../../core/types/request-context.types';
import { CardPaymentService } from '../services/card-payment.service';
import {
  InitiateBankCardPaymentDto,
  BankCardPaymentResponse,
  CreateCardSessionDto,
  CardSessionResponse,
  CompleteCardSessionDto,
  SavedCardPaymentDto,
} from '../dto/bank-card.dto';

/**
 * PaymentsController — bank card deposits.
 *
 * Flow:
 *   1. Mobile app → POST /payments/card/initiate (authenticated)
 *      Creates a PENDING wallet deposit, charges the card through the
 *      resolved gateway (Mastercard MPGS when configured; the mock gateway
 *      in Test Transaction mode), and credits the wallet atomically on
 *      success.
 *   2. Mobile app → GET /payments/card/verify/:txRef (authenticated)
 *      Polls the deposit's status; the database is the source of truth.
 *
 * PCI-DSS: card details transit this endpoint solely to reach the gateway.
 * They are never logged, stored, or echoed back (only brand + last4).
 * TLS-only in production; tokenise client-side when the gateway's hosted
 * session is enabled to reduce PCI scope further.
 */
@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(private readonly cardPayments: CardPaymentService) {}

  @Post('card/initiate')
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Charge a bank card and credit the wallet' })
  @ApiResponse({ status: 201, description: 'Charge outcome (SUCCESS or FAILED)', type: BankCardPaymentResponse })
  @ApiResponse({ status: 503, description: 'Live card gateway not yet enabled (use Test Transaction mode)' })
  async initiateCardPayment(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: InitiateBankCardPaymentDto,
  ): Promise<BankCardPaymentResponse> {
    return this.cardPayments.initiateCardPayment(
      { id: user.id, email: user.email },
      dto,
    );
  }

  @Get('card/verify/:txRef')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Verify a bank card payment status' })
  @ApiResponse({ status: 200, description: 'Current payment status' })
  async verifyCardPayment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('txRef') txRef: string,
  ) {
    return this.cardPayments.verifyCardPayment(user.id, txRef);
  }
  // ── Hosted Session: the card never passes through Pine ─────────────────────

  @Post('card/session')
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Create a gateway payment session for a deposit',
    description:
      'Creates the pending deposit (applying the broker fee schedule and ' +
      'deposit limits) and a Mastercard Gateway session. The app then sends ' +
      'the card DIRECTLY to the gateway using the returned session id, so ' +
      'card data never reaches Pine, and finally calls /card/session/complete.',
  })
  @ApiResponse({ status: 201, description: 'Session handle', type: CardSessionResponse })
  @ApiResponse({ status: 503, description: "Broker's gateway not configured" })
  async createCardSession(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateCardSessionDto,
  ): Promise<CardSessionResponse> {
    return this.cardPayments.createPaymentSession(
      { id: user.id, email: user.email },
      dto,
    );
  }

  @Post('card/session/complete')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Capture the payment for a populated session',
    description:
      'Charges the amount recorded on the pending deposit — never an amount ' +
      'supplied here — then credits the wallet. Optionally tokenises the card ' +
      'so it can be reused without Pine ever storing a card number.',
  })
  @ApiResponse({ status: 200, description: 'Charge outcome', type: BankCardPaymentResponse })
  async completeCardSession(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CompleteCardSessionDto,
  ): Promise<BankCardPaymentResponse> {
    return this.cardPayments.completeSessionPayment(
      { id: user.id, email: user.email },
      dto,
    );
  }

  @Post('card/saved')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Deposit using a saved card (card-on-file token)',
    description:
      'Charges a stored gateway token. No card data is involved on any leg.',
  })
  @ApiResponse({ status: 200, description: 'Charge outcome', type: BankCardPaymentResponse })
  async payWithSavedCard(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SavedCardPaymentDto,
  ): Promise<BankCardPaymentResponse> {
    return this.cardPayments.payWithSavedCard(
      { id: user.id, email: user.email },
      dto,
    );
  }
}
