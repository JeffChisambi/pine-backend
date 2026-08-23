import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { RequirePermissions } from '../../../core/decorators/require-permissions.decorator';
import { Permission } from '../../auth/constants/permissions.constant';
import { CurrentUser } from '../../../core/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../../core/types/request-context.types';
import type { RequestWithUser } from '../../../core/types/request-context.types';
import { AdminRepository } from '../repositories/admin.repository';
import { ResourceNotFoundException } from '../../../core/exceptions/app.exception';
import { BrokerScopeService } from '../../brokers/services/broker-scope.service';
import { WalletService } from '../../wallet/services/wallet.service';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { AuditLogService } from '../../audit/services/audit-log.service';

class RejectWithdrawalDto {
  @IsOptional() @IsString() @MaxLength(300)
  reason?: string;
}

@ApiTags('admin', 'wallets')
@ApiBearerAuth()
@Controller('admin/wallets')
export class AdminWalletController {
  constructor(
    private readonly adminRepo: AdminRepository,
    private readonly brokerScope: BrokerScopeService,
    private readonly walletService: WalletService,
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  // ── Withdrawal management ─────────────────────────────────
  // Withdrawals NEVER auto-settle: the investor's request creates a
  // PENDING transaction (which immediately reduces their AVAILABLE
  // balance), and the owning broker approves or rejects it here.

  @Get('withdrawals/pending')
  @RequirePermissions(Permission.WALLET_READ)
  @ApiOperation({ summary: 'Pending withdrawal requests (broker-scoped)' })
  async listPendingWithdrawals(@CurrentUser() admin: AuthenticatedUser) {
    const scope = await this.brokerScope.resolveScope(admin);
    const withdrawals = await this.prisma.transaction.findMany({
      where: {
        type: 'WITHDRAWAL',
        status: { in: ['PENDING', 'PROCESSING'] },
        ...(scope ? { wallet: { user: { brokerId: scope } } } : {}),
      },
      include: {
        wallet: {
          select: {
            balance: true,
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                brokerId: true,
                broker: { select: { id: true, name: true } },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    return {
      withdrawals: withdrawals.map((w) => ({
        transactionId: w.id,
        amount: w.amount.toNumber(),
        status: w.status,
        requestedAt: w.createdAt,
        user: {
          id: w.wallet.user.id,
          name: `${w.wallet.user.firstName} ${w.wallet.user.lastName}`,
          email: w.wallet.user.email,
          broker: w.wallet.user.broker?.name ?? null,
        },
        walletBalance: w.wallet.balance.toNumber(),
      })),
    };
  }

  @Post('withdrawals/:transactionId/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.ADMIN_ACCESS)
  @ApiOperation({
    summary: 'Approve a pending withdrawal (owning broker only)',
    description:
      'Settles the withdrawal through the double-entry ledger: DEBIT user wallet, CREDIT platform cash.',
  })
  async approveWithdrawal(
    @Param('transactionId') transactionId: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Req() req: RequestWithUser,
  ) {
    const brokerId = await this.requireOwnedWithdrawal(admin, transactionId);
    await this.walletService.settleWithdrawal(transactionId);
    await this.auditLogService.log({
      actorId: admin.id,
      actorRole: admin.role,
      action: 'WITHDRAWAL_APPROVED_BY_BROKER',
      resourceType: 'TRANSACTION',
      resourceId: transactionId,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      metadata: { brokerId },
    });
    return { transactionId, status: 'COMPLETED' };
  }

  @Post('withdrawals/:transactionId/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.ADMIN_ACCESS)
  @ApiOperation({ summary: 'Reject a pending withdrawal (owning broker only)' })
  async rejectWithdrawal(
    @Param('transactionId') transactionId: string,
    @Body() dto: RejectWithdrawalDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Req() req: RequestWithUser,
  ) {
    const brokerId = await this.requireOwnedWithdrawal(admin, transactionId);
    const reason = dto.reason?.trim() || 'Rejected by your broker';
    await this.walletService.rejectWithdrawal(transactionId, reason);
    await this.auditLogService.log({
      actorId: admin.id,
      actorRole: admin.role,
      action: 'WITHDRAWAL_REJECTED_BY_BROKER',
      resourceType: 'TRANSACTION',
      resourceId: transactionId,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      metadata: { brokerId, reason },
    });
    return { transactionId, status: 'FAILED', reason };
  }

  /**
   * Withdrawal decisions belong to the OWNING BROKER exclusively — platform
   * admins observe but never act (same model as order execution and KYC).
   * 404s on withdrawals outside the caller's book.
   */
  private async requireOwnedWithdrawal(
    admin: AuthenticatedUser,
    transactionId: string,
  ): Promise<string> {
    const brokerId = await this.brokerScope.requireBrokerActor(admin);
    const tx = await this.prisma.transaction.findFirst({
      where: {
        id: transactionId,
        type: 'WITHDRAWAL',
        wallet: { user: { brokerId } },
      },
      select: { id: true },
    });
    if (!tx) {
      throw new ResourceNotFoundException('Withdrawal', transactionId);
    }
    return brokerId;
  }

  @Get()
  @RequirePermissions(Permission.WALLET_READ)
  @ApiOperation({ summary: 'List wallets (broker admins: own broker only)' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'frozen', required: false, type: Boolean })
  @ApiResponse({ status: 200, description: 'Paginated wallet list' })
  async listWallets(
    @CurrentUser() admin: AuthenticatedUser,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('frozen') frozen?: string,
  ) {
    const scope = await this.brokerScope.resolveScope(admin);
    return this.adminRepo.listWallets(
      {
        page: page ? parseInt(page, 10) : 1,
        limit: limit ? parseInt(limit, 10) : 50,
        frozen: frozen === 'true' ? true : frozen === 'false' ? false : undefined,
      },
      scope,
    );
  }

  @Get(':userId')
  @RequirePermissions(Permission.WALLET_READ)
  @ApiOperation({
    summary: 'Wallet detail for a user',
    description: 'Balance, reserved, transactions, and ledger entries.',
  })
  @ApiResponse({ status: 200, description: 'Wallet detail' })
  async getWalletDetail(
    @Param('userId') userId: string,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    const scope = await this.brokerScope.resolveScope(admin);
    const wallet = await this.adminRepo.getWalletDetail(userId, scope);
    if (!wallet) {
      throw new ResourceNotFoundException('Wallet', userId);
    }
    return wallet;
  }
}
