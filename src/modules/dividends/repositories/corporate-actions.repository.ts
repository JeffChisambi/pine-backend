import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { Decimal } from '@prisma/client/runtime/library';

/**
 * Corporate Actions Repository — all Prisma queries.
 *
 * The Corporate Actions module is the single authority for
 * everything that happens because a company changes the
 * characteristics or benefits of its shares.
 */
@Injectable()
export class CorporateActionsRepository {
  private readonly logger = new Logger(CorporateActionsRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Corporate Actions (parent) ──────────────────────────────

  async createCorporateAction(data: {
    stockId: string;
    type: string;
    title: string;
    description?: string;
    effectiveDate: Date;
  }) {
    return this.prisma.corporateAction.create({
      data: {
        stockId: data.stockId,
        type: data.type as any,
        title: data.title,
        description: data.description,
        effectiveDate: data.effectiveDate,
        status: 'ANNOUNCED',
      },
    });
  }

  async updateCorporateActionStatus(id: string, status: string, extra: Record<string, any> = {}) {
    return this.prisma.corporateAction.update({
      where: { id },
      data: { status: status as any, ...extra },
    });
  }

  async findCorporateActions(stockId?: string, limit = 30, offset = 0) {
    const where: any = stockId ? { stockId } : {};
    const [actions, total] = await Promise.all([
      this.prisma.corporateAction.findMany({
        where,
        include: { stock: { select: { symbol: true, name: true } } },
        orderBy: { effectiveDate: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.corporateAction.count({ where }),
    ]);
    return { actions, total };
  }

  async findCorporateActionById(id: string) {
    return this.prisma.corporateAction.findUnique({
      where: { id },
      include: {
        stock: { select: { symbol: true, name: true } },
        dividend: true,
        stockSplit: true,
        bonusIssue: true,
        rightsIssue: true,
      },
    });
  }

  // ── Dividends ───────────────────────────────────────────────

  async createDividend(data: {
    corporateActionId: string;
    stockId: string;
    amountPerShare: Decimal;
    withholdingTaxPct: Decimal;
    exDividendDate: Date;
    recordDate: Date;
    paymentDate: Date;
  }) {
    return this.prisma.dividend.create({ data: data as any });
  }

  async findDividendById(id: string) {
    return this.prisma.dividend.findUnique({
      where: { id },
      include: {
        stock: { select: { symbol: true, name: true } },
        corporateAction: true,
      },
    });
  }

  async findDividends(stockId?: string, limit = 30) {
    const where: any = stockId ? { stockId } : {};
    return this.prisma.dividend.findMany({
      where,
      include: { stock: { select: { symbol: true, name: true } } },
      orderBy: { paymentDate: 'desc' },
      take: limit,
    });
  }

  async findDividendsDueForPayment(date: Date) {
    return this.prisma.dividend.findMany({
      where: {
        paymentDate: { lte: date },
        status: 'ANNOUNCED',
      },
      include: { stock: { select: { symbol: true, name: true } } },
    });
  }

  async updateDividendStatus(id: string, status: string) {
    return this.prisma.dividend.update({
      where: { id },
      data: { status: status as any },
    });
  }

  // ── Distributions ───────────────────────────────────────────

  async createDistribution(data: {
    dividendId: string;
    userId: string;
    quantityHeld: Decimal;
    grossAmount: Decimal;
    taxWithheld: Decimal;
    netAmount: Decimal;
  }) {
    return this.prisma.dividendDistribution.create({ data: data as any });
  }

  async findDistributionsByDividend(dividendId: string) {
    return this.prisma.dividendDistribution.findMany({
      where: { dividendId },
      orderBy: { grossAmount: 'desc' },
    });
  }

  async findUserDistributions(userId: string, limit = 30) {
    return this.prisma.dividendDistribution.findMany({
      where: { userId },
      include: {
        dividend: {
          include: { stock: { select: { symbol: true, name: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async updateDistributionStatus(id: string, status: string) {
    return this.prisma.dividendDistribution.update({
      where: { id },
      data: { status: status as any, processedAt: new Date() },
    });
  }

  // ── Stock Splits ────────────────────────────────────────────

  async createStockSplit(data: {
    corporateActionId: string;
    stockId: string;
    ratioFrom: number;
    ratioTo: number;
    effectiveDate: Date;
  }) {
    return this.prisma.stockSplit.create({ data });
  }

  // ── Bonus Issues ────────────────────────────────────────────

  async createBonusIssue(data: {
    corporateActionId: string;
    stockId: string;
    ratioFrom: number;
    ratioTo: number;
    recordDate: Date;
    effectiveDate: Date;
  }) {
    return this.prisma.bonusIssue.create({ data });
  }

  // ── Rights Issues ───────────────────────────────────────────

  async createRightsIssue(data: {
    corporateActionId: string;
    stockId: string;
    ratioFrom: number;
    ratioTo: number;
    subscriptionPrice: Decimal;
    openDate: Date;
    closeDate: Date;
  }) {
    return this.prisma.rightsIssue.create({ data: data as any });
  }

  // ── Shareholders (for distribution) ─────────────────────────

  async findShareholdersByStock(stockId: string) {
    return this.prisma.holding.findMany({
      where: { stockId, quantity: { gt: 0 } },
      select: { userId: true, quantity: true, averageCost: true },
    });
  }

  // ── Prisma instance (for transactions) ──────────────────────

  get prismaClient() {
    return this.prisma;
  }
}
