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
import { InitiateBankCardPaymentDto, BankCardPaymentResponse } from '../dto/bank-card.dto';

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
}
