import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { CorporateActionsRepository } from '../repositories/corporate-actions.repository';

/**
 * Dividend Service — declares and manages dividends.
 *
 * Responsible for:
 *   - Declaring dividends (from market sync or admin)
 *   - Recording ex-dividend, record, and payment dates
 *   - Tracking dividend status
 *
 * NOT responsible for:
 *   - Distributing dividends (that's the DistributionEngine)
 *   - Crediting wallets (that's the Ledger/Wallet)
 *   - Notifying users (that's the Notifications module)
 */
@Injectable()
export class DividendService {
  private readonly logger = new Logger(DividendService.name);

  constructor(private readonly repo: CorporateActionsRepository) {}

  /**
   * Declare a new dividend for a stock.
   *
   * Creates both a parent CorporateAction and the Dividend record.
   */
  async declareDividend(params: {
    stockId: string;
    amountPerShare: number;
    withholdingTaxPct?: number;
    exDividendDate: Date;
    recordDate: Date;
    paymentDate: Date;
  }): Promise<{ corporateActionId: string; dividendId: string }> {
    // Create parent corporate action
    const ca = await this.repo.createCorporateAction({
      stockId: params.stockId,
      type: 'DIVIDEND',
      title: `Dividend — MWK ${params.amountPerShare} per share`,
      effectiveDate: params.paymentDate,
    });

    // Create dividend record
    const dividend = await this.repo.createDividend({
      corporateActionId: ca.id,
      stockId: params.stockId,
      amountPerShare: new Decimal(params.amountPerShare),
      withholdingTaxPct: new Decimal(params.withholdingTaxPct ?? 0),
      exDividendDate: params.exDividendDate,
      recordDate: params.recordDate,
      paymentDate: params.paymentDate,
    });

    this.logger.log(
      {
        stockId: params.stockId,
        amountPerShare: params.amountPerShare,
        paymentDate: params.paymentDate,
        dividendId: dividend.id,
      },
      'Dividend declared',
    );

    return { corporateActionId: ca.id, dividendId: dividend.id };
  }

  /**
   * Get all dividends (optionally filtered by stock).
   */
  async getDividends(stockId?: string, limit = 30) {
    const dividends = await this.repo.findDividends(stockId, limit);
    return dividends.map((d) => ({
      id: d.id,
      stockSymbol: d.stock.symbol,
      stockName: d.stock.name,
      amountPerShare: d.amountPerShare.toNumber(),
      exDividendDate: d.exDividendDate,
      paymentDate: d.paymentDate,
      status: d.status,
      createdAt: d.createdAt,
    }));
  }

  /**
   * Get dividend detail by ID.
   */
  async getDividendById(id: string) {
    const d = await this.repo.findDividendById(id);
    if (!d) throw new NotFoundException('Dividend not found');

    return {
      id: d.id,
      stockSymbol: d.stock.symbol,
      stockName: d.stock.name,
      amountPerShare: d.amountPerShare.toNumber(),
      withholdingTaxPct: d.withholdingTaxPct.toNumber(),
      exDividendDate: d.exDividendDate,
      recordDate: d.recordDate,
      paymentDate: d.paymentDate,
      status: d.status,
    };
  }

  /**
   * Get dividends ready for distribution (payment date reached).
   */
  async getDividendsDueForPayment(): Promise<any[]> {
    return this.repo.findDividendsDueForPayment(new Date());
  }

  /**
   * Get a user's dividend history.
   */
  async getUserDividendHistory(userId: string, limit = 30) {
    const distributions = await this.repo.findUserDistributions(userId, limit);
    return distributions.map((d) => ({
      id: d.id,
      stockSymbol: d.dividend.stock.symbol,
      stockName: d.dividend.stock.name,
      quantityHeld: d.quantityHeld.toNumber(),
      grossAmount: d.grossAmount.toNumber(),
      taxWithheld: d.taxWithheld.toNumber(),
      netAmount: d.netAmount.toNumber(),
      reinvested: d.reinvested,
      status: d.status,
      paymentDate: d.dividend.paymentDate,
      processedAt: d.processedAt,
    }));
  }
}
