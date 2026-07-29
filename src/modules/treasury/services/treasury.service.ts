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

    const investment = await this.prisma.treasuryInvestment.create({
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

    this.logger.log(
      { userId, investmentId: investment.id, productId, amount },
      'Treasury investment created',
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

  private formatProduct(p: any) {
    return {
      id: p.id,
      label: p.label,
      tenorDays: p.tenorDays,
      yieldPercent: p.yieldPercent.toNumber(),
      minAmount: p.minAmount.toNumber(),
      maxAmount: p.maxAmount?.toNumber() ?? null,
      currency: p.currency,
      isActive: p.isActive,
    };
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
