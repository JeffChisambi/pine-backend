import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../../core/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../../core/types/request-context.types';
import { PinGuard } from '../../auth/guards/pin.guard';
import { WalletService } from '../services/wallet.service';
import { DepositDto, WithdrawDto, StatementQueryDto } from '../dto/wallet.dto';

/**
 * Wallet Controller — cash position view.
 *
 * The Wallet answers: "How much money does this customer have available?"
 *
 * It does NOT answer:
 *   "How did they get the money?"  → Ledger
 *   "Did they pass KYC?"          → KYC
 *   "Can they buy a stock?"       → Trading + Risk
 *   "Was the deposit successful?"  → Payments
 *
 * Endpoints:
 *   GET    /v1/wallet              → Full wallet summary
 *   GET    /v1/wallet/balance      → Quick balance
 *   GET    /v1/wallet/statement    → Transaction history
 *   GET    /v1/wallet/reservations → Active fund holds
 *   GET    /v1/wallet/history      → Detailed ledger view
 *   GET    /v1/wallet/snapshots    → Balance history for charts
 *   POST   /v1/wallet/deposit      → Initiate deposit
 *   POST   /v1/wallet/withdraw     → Initiate withdrawal
 */
@ApiTags('wallet')
@ApiBearerAuth()
@Controller('wallet')
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  // ── Balance ─────────────────────────────────────────────────

  @Get()
  @ApiOperation({
    summary: 'Get wallet summary',
    description:
      'Returns the full wallet summary: total balance, available balance ' +
      '(after reservations), reserved amount, pending deposits/withdrawals, ' +
      'and frozen status.',
  })
  @ApiResponse({ status: 200, description: 'Wallet summary' })
  async getWallet(@CurrentUser() user: AuthenticatedUser) {
    return this.walletService.getWallet(user.id);
  }

  @Get('balance')
  @ApiOperation({
    summary: 'Get quick balance',
    description: 'Returns just the balance and currency. Fastest endpoint.',
  })
  @ApiResponse({ status: 200, description: 'Balance and currency' })
  async getBalance(@CurrentUser() user: AuthenticatedUser) {
    return this.walletService.getBalance(user.id);
  }

  // ── Statement ───────────────────────────────────────────────

  @Get('statement')
  @ApiOperation({
    summary: 'Get transaction statement',
    description:
      'Returns paginated transaction history: deposits, withdrawals, ' +
      'trading debits/credits, dividends, fees.',
  })
  @ApiResponse({ status: 200, description: 'Transaction statement' })
  async getStatement(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: StatementQueryDto,
  ) {
    return this.walletService.getStatement(
      user.id,
      query.limit ?? 30,
      query.offset ?? 0,
    );
  }

  @Get('history')
  @ApiOperation({
    summary: 'Get transaction history',
    description: 'Returns paginated transaction history in the standard contract format.',
  })
  @ApiResponse({ status: 200, description: 'Transaction history' })
  async getHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limitStr?: string,
  ) {
    const limit = Math.min(parseInt(limitStr ?? '20', 10) || 20, 100);
    const result = await this.walletService.getStatement(user.id, limit, 0);
    return {
      transactions: result.entries.map((e) => ({
        id: e.id,
        type: e.type,
        // Statement entries expose amount as a plain number — the previous
        // `.toNumber()` cast crashed every call to this endpoint.
        amount: Number(e.amount).toFixed(2),
        currency: e.currency,
        // Real transaction status (was hardcoded 'COMPLETED', so pending
        // deposits/withdrawals rendered as completed in the app).
        status: e.status,
        description: e.description ?? '',
        createdAt: e.createdAt,
      })),
      count: result.total,
    };
  }

  @Get('snapshots')
  @ApiOperation({
    summary: 'Get balance history for charts',
    description:
      'Returns daily balance snapshots in chronological order. ' +
      'Shows balance, reserved, and available over time.',
  })
  @ApiResponse({ status: 200, description: 'Balance history' })
  async getSnapshots(@CurrentUser() user: AuthenticatedUser) {
    return this.walletService.getBalanceHistory(user.id);
  }

  // ── Reservations ────────────────────────────────────────────

  @Get('reservations')
  @ApiOperation({
    summary: 'Get active fund reservations',
    description:
      'Returns funds reserved for pending orders. ' +
      'Reserved funds reduce available balance but are not spent.',
  })
  @ApiResponse({ status: 200, description: 'Active reservations' })
  async getReservations(@CurrentUser() user: AuthenticatedUser) {
    return this.walletService.getReservations(user.id);
  }

  // ── Deposit ─────────────────────────────────────────────────

  @Get('deposit/preview')
  @ApiOperation({
    summary: 'Preview a deposit fee breakdown',
    description:
      "Returns gross amount, the broker's configured processing fee, and " +
      'the net amount that will be credited to the wallet — before paying.',
  })
  @ApiResponse({ status: 200, description: 'Deposit fee breakdown' })
  async depositPreview(
    @CurrentUser() user: AuthenticatedUser,
    @Query('amount') amount: string,
  ) {
    return this.walletService.previewDeposit(user.id, Number(amount));
  }

  @Post('deposit')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Initiate a deposit',
    description:
      'Creates a pending deposit transaction. The actual money movement ' +
      'happens when the Payment provider confirms via webhook. ' +
      'Supports idempotency keys for retry safety.',
  })
  @ApiResponse({ status: 201, description: 'Deposit initiated' })
  @ApiResponse({ status: 400, description: 'Invalid amount or frozen wallet' })
  async deposit(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: DepositDto,
  ) {
    return this.walletService.initiateDeposit({
      userId: user.id,
      amount: dto.amount,
      idempotencyKey: dto.idempotencyKey,
    });
  }

  // ── Withdrawal ──────────────────────────────────────────────

  @Post('withdraw')
  @UseGuards(PinGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Initiate a withdrawal',
    description:
      'Creates a pending withdrawal transaction after validating ' +
      'sufficient available funds. Actual disbursement happens via ' +
      'the Payments module. Supports idempotency keys.',
  })
  @ApiResponse({ status: 201, description: 'Withdrawal initiated' })
  @ApiResponse({ status: 400, description: 'Insufficient funds or frozen wallet' })
  async withdraw(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: WithdrawDto,
  ) {
    return this.walletService.initiateWithdrawal({
      userId: user.id,
      amount: dto.amount,
      idempotencyKey: dto.idempotencyKey,
    });
  }
}
