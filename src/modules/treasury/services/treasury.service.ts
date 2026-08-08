import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../../../infrastructure/database/prisma.service';

/**
 * TreasuryService — T-bill investment management.
 *
 * Handles the full lifecycle of treasury investments:
 *   GET  /treasury/products        → list available products
 *   GET  /treasury/investments      → user's active investments
 *   POST /treasury/invest           → create a new investment
 *   GET  /treasury/investments/:id  → single investment status
 */
@Injectable()
export class TreasuryService {
  private readonly logger = new Logger(TreasuryService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Products ─────────────────────────────────────────────────

  async getProducts() {
    const products = await this.prisma.treasuryProduct.findMany({
      where: { isActive: true },
      orderBy: { tenorDays: 'asc' },
    });

    return products.map((p) => this.formatProduct(p));
  }

  // ── Investments ──────────────────────────────────────────────

  async getUserInvestments(userId: string) {
    const investments = await this.prisma.treasuryInvestment.findMany({
      where: { userId },
      include: { product: true },
      orderBy: { createdAt: 'desc' },
    });

    return investments.map((i) => this.formatInvestment(i));
  }

  async getInvestmentById(userId: string, investmentId: string) {
    const investment = await this.prisma.treasuryInvestment.findFirst({
      where: { id: investmentId, userId },
      include: { product: true },
    });

    if (!investment) {
      throw new NotFoundException('Investment not found');
    }

    return this.formatInvestment(investment);
  }

  async invest(userId: string, productId: string, amount: number) {
    // Validate product exists and is active
    const product = await this.prisma.treasuryProduct.findFirst({
      where: { id: productId, isActive: true },
    });

    if (!product) {
      throw new NotFoundException('Treasury product not found or no longer available');
    }

    const amountDecimal = new Decimal(amount);

    if (!amountDecimal.isFinite() || amountDecimal.lte(0)) {
      throw new BadRequestException('Investment amount must be a positive number');
    }

    const minAmount = product.minAmount;
    const maxAmount = product.maxAmount;

    if (amountDecimal.lt(minAmount)) {
      throw new BadRequestException(
        `Minimum investment amount is ${minAmount.toFixed(2)} ${product.currency}`,
      );
    }

    if (maxAmount && amountDecimal.gt(maxAmount)) {
      throw new BadRequestException(
        `Maximum investment amount is ${maxAmount.toFixed(2)} ${product.currency}`,
      );
    }

    // Calculate returns using actual tenor + yield
    const { earnings, maturityValue, maturityDate } = this.calculateReturns(
      amountDecimal,
      product.yieldPercent,
      product.tenorDays,
    );

    // Atomically verify the user actually has the funds, place a hold on the
    // principal, and create the investment — all in ONE serializable
    // transaction. Without this a user could create T-bill investments funded
    // by nothing (balance never checked, never debited), corrupting financial
    // state and creating an unpaid maturity obligation. The hold reuses the
    // existing WalletReservation mechanism (same one buy-orders use), so the
    // principal can't be double-spent via withdraw / buy / another invest.
    const investment = await this.prisma.$transaction(
      async (tx) => {
        const wallet = await tx.wallet.findUnique({ where: { userId } });
        if (!wallet) {
          throw new BadRequestException(
            'No wallet found. Fund your wallet before investing.',
          );
        }
        if (wallet.isFrozen) {
          throw new BadRequestException(
            `Wallet is frozen: ${wallet.frozenReason ?? 'Contact support'}`,
          );
        }

        const reservedAgg = await tx.walletReservation.aggregate({
          where: { walletId: wallet.id, status: 'ACTIVE' },
          _sum: { amount: true },
        });
        const available = wallet.balance.sub(
          reservedAgg._sum.amount ?? new Decimal(0),
        );

        if (available.lt(amountDecimal)) {
          throw new BadRequestException(
            `Insufficient available funds. Available: ${product.currency} ` +
              `${available.toNumber().toLocaleString()}, Required: ${product.currency} ` +
              `${amountDecimal.toNumber().toLocaleString()}`,
          );
        }

        const created = await tx.treasuryInvestment.create({
          data: {
            userId,
            productId,
            status: 'PENDING',
            amount: amountDecimal,
            yieldPercent: product.yieldPercent,
            earnings,
            maturityValue,
            maturityDate,
          },
          include: { product: true },
        });

        // Hold the principal for the life of the T-bill. expiresAt is null so
        // the 15-minute reservation-sweeper cron never auto-releases it; the
        // redemption flow releases/consumes it at maturity.
        await tx.walletReservation.create({
          data: {
            walletId: wallet.id,
            orderId: created.id,
            amount: amountDecimal,
            status: 'ACTIVE',
            reason: `Treasury investment ${created.id}`,
            expiresAt: null,
          },
        });

        return created;
      },
      { isolationLevel: 'Serializable' as any, maxWait: 5_000, timeout: 10_000 },
    );

    this.logger.log(
      { userId, investmentId: investment.id, productId, amount },
      'Treasury investment created (principal held)',
    );

    return this.formatInvestment(investment);
  }

  // ── Helpers ─────────────────────────────────────────────────

  /**
   * Simple interest formula: earnings = principal × rate × (days / 365)
   * where rate is expressed as a percentage (e.g. 26.5 for 26.5%).
   */
  private calculateReturns(
    amount: Decimal,
    yieldPercent: Decimal,
    tenorDays: number,
  ): { earnings: Decimal; maturityValue: Decimal; maturityDate: Date } {
    const rate = yieldPercent.div(100);
    const fraction = new Decimal(tenorDays).div(365);
    const earnings = amount.mul(rate).mul(fraction);
    const maturityValue = amount.add(earnings);

    const maturityDate = new Date();
    maturityDate.setDate(maturityDate.getDate() + tenorDays);

    return { earnings, maturityValue, maturityDate };
  }

  /**
   * Mobile-facing product shape — matches the app's TBillOption so the
   * treasury screens render DB products identically to the old hardcoded data.
   * Dates are pre-formatted display strings (e.g. "28 Jul 2026").
   */
  private formatProduct(p: any) {
    const fmt = (d: Date | null) =>
      d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '';
    const auction = fmt(p.auctionDate);
    return {
      id: p.id,
      label: p.label,
      // mobile field names
      duration: p.tenorDays,
      yieldPct: p.yieldPercent.toNumber(),
      minInvestment: p.minAmount.toNumber(),
      maxInvestment: p.maxAmount?.toNumber() ?? null,
      riskLevel: p.riskLevel ?? 'Low',
      nextAuction: auction,
      auctionDate: auction,
      issueDate: fmt(p.issueDate),
      maturityDate: fmt(p.maturityDate),
      status: p.status ?? 'open',
      currency: p.currency,
      // canonical names kept for the invest flow / admin
      tenorDays: p.tenorDays,
      yieldPercent: p.yieldPercent.toNumber(),
      minAmount: p.minAmount.toNumber(),
      maxAmount: p.maxAmount?.toNumber() ?? null,
      isActive: p.isActive,
    };
  }

  // ── Admin CRUD (dashboard-managed products) ──────────────────

  async listAllProducts() {
    const products = await this.prisma.treasuryProduct.findMany({
      orderBy: [{ isActive: 'desc' }, { tenorDays: 'asc' }],
    });
    return products.map((p) => this.formatProduct(p));
  }

  async createProduct(data: {
    label: string; tenorDays: number; yieldPercent: number;
    minAmount: number; maxAmount?: number | null; riskLevel?: string;
    auctionDate?: string | null; issueDate?: string | null; maturityDate?: string | null;
    status?: string; isActive?: boolean; currency?: string;
  }) {
    const p = await this.prisma.treasuryProduct.create({
      data: {
        label: data.label,
        tenorDays: data.tenorDays,
        yieldPercent: new Decimal(data.yieldPercent),
        minAmount: new Decimal(data.minAmount),
        maxAmount: data.maxAmount != null ? new Decimal(data.maxAmount) : null,
        riskLevel: data.riskLevel ?? 'Low',
        auctionDate: data.auctionDate ? new Date(data.auctionDate) : null,
        issueDate: data.issueDate ? new Date(data.issueDate) : null,
        maturityDate: data.maturityDate ? new Date(data.maturityDate) : null,
        status: data.status ?? 'open',
        isActive: data.isActive ?? true,
        currency: data.currency ?? 'MWK',
      },
    });
    return this.formatProduct(p);
  }

  async updateProduct(id: string, data: Record<string, any>) {
    const existing = await this.prisma.treasuryProduct.findUnique({ where: { id } });
    if (!existing) throw new Error('Treasury product not found');
    const patch: Record<string, any> = {};
    if (data.label !== undefined) patch.label = data.label;
    if (data.tenorDays !== undefined) patch.tenorDays = data.tenorDays;
    if (data.yieldPercent !== undefined) patch.yieldPercent = new Decimal(data.yieldPercent);
    if (data.minAmount !== undefined) patch.minAmount = new Decimal(data.minAmount);
    if (data.maxAmount !== undefined) patch.maxAmount = data.maxAmount != null ? new Decimal(data.maxAmount) : null;
    if (data.riskLevel !== undefined) patch.riskLevel = data.riskLevel;
    if (data.auctionDate !== undefined) patch.auctionDate = data.auctionDate ? new Date(data.auctionDate) : null;
    if (data.issueDate !== undefined) patch.issueDate = data.issueDate ? new Date(data.issueDate) : null;
    if (data.maturityDate !== undefined) patch.maturityDate = data.maturityDate ? new Date(data.maturityDate) : null;
    if (data.status !== undefined) patch.status = data.status;
    if (data.isActive !== undefined) patch.isActive = data.isActive;
    if (data.currency !== undefined) patch.currency = data.currency;
    const p = await this.prisma.treasuryProduct.update({ where: { id }, data: patch });
    return this.formatProduct(p);
  }

  async deleteProduct(id: string) {
    const invCount = await this.prisma.treasuryInvestment.count({ where: { productId: id } });
    if (invCount > 0) {
      // Preserve investment history — soft-disable instead of hard delete.
      await this.prisma.treasuryProduct.update({ where: { id }, data: { isActive: false, status: 'closed' } });
      return { message: 'Product has investments — archived (set inactive) instead of deleted', id, archived: true };
    }
    await this.prisma.treasuryProduct.delete({ where: { id } });
    return { message: 'Treasury product deleted', id, archived: false };
  }

  /** All investments across users — for the dashboard "treasury orders" view. */
  async listAllInvestments() {
    const investments = await this.prisma.treasuryInvestment.findMany({
      include: { product: true, user: { select: { id: true, firstName: true, lastName: true, phone: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return investments.map((i) => ({
      ...this.formatInvestment(i),
      user: i.user
        ? { id: i.user.id, name: `${i.user.firstName} ${i.user.lastName}`.trim(), phone: i.user.phone }
        : null,
    }));
  }

  private formatInvestment(i: any) {
    return {
      investmentId: i.id,
      status: i.status.toLowerCase(),
      amount: i.amount.toFixed(2),
      yieldPercent: i.yieldPercent.toNumber(),
      earnings: i.earnings.toFixed(2),
      maturityValue: i.maturityValue.toFixed(2),
      maturityDate: i.maturityDate instanceof Date
        ? i.maturityDate.toISOString().split('T')[0]
        : i.maturityDate,
      createdAt: i.createdAt,
      product: i.product ? this.formatProduct(i.product) : undefined,
    };
  }
}
