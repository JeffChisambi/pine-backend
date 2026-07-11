import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CorporateActionsRepository } from '../repositories/corporate-actions.repository';
import { DividendService } from './dividend.service';
import { DistributionEngine } from './distribution-engine.service';

/**
 * Corporate Actions Service — the orchestrator.
 *
 * The single authority for everything that happens because a company
 * changes the characteristics or benefits of its shares.
 *
 * Types:
 *   Dividends       → Cash to wallet
 *   Stock Splits    → Holdings updated, wallet unchanged
 *   Bonus Shares    → Holdings updated, wallet unchanged
 *   Rights Issues   → Offer to buy more shares at a discount
 *   Mergers         → Future
 *   Delistings      → Future
 */
@Injectable()
export class CorporateActionsService {
  private readonly logger = new Logger(CorporateActionsService.name);

  constructor(
    private readonly repo: CorporateActionsRepository,
    private readonly dividendService: DividendService,
    private readonly distributionEngine: DistributionEngine,
  ) {}

  // ── API Methods ─────────────────────────────────────────────

  /** GET /corporate-actions — all corporate actions */
  async getCorporateActions(stockId?: string, limit = 30, offset = 0) {
    const { actions, total } = await this.repo.findCorporateActions(
      stockId,
      limit,
      offset,
    );

    return {
      actions: actions.map((a) => ({
        id: a.id,
        stockSymbol: a.stock.symbol,
        stockName: a.stock.name,
        type: a.type,
        title: a.title,
        description: a.description,
        status: a.status,
        effectiveDate: a.effectiveDate,
        processedAt: a.processedAt,
        createdAt: a.createdAt,
      })),
      total,
    };
  }

  /** GET /corporate-actions/:id — detail */
  async getCorporateActionById(id: string) {
    const ca = await this.repo.findCorporateActionById(id);
    if (!ca) throw new NotFoundException('Corporate action not found');

    return {
      id: ca.id,
      stockSymbol: ca.stock.symbol,
      stockName: ca.stock.name,
      type: ca.type,
      title: ca.title,
      description: ca.description,
      status: ca.status,
      effectiveDate: ca.effectiveDate,
      processedAt: ca.processedAt,
      dividend: ca.dividend
        ? {
            id: ca.dividend.id,
            amountPerShare: ca.dividend.amountPerShare.toNumber(),
            withholdingTaxPct: ca.dividend.withholdingTaxPct.toNumber(),
            exDividendDate: ca.dividend.exDividendDate,
            recordDate: ca.dividend.recordDate,
            paymentDate: ca.dividend.paymentDate,
            status: ca.dividend.status,
          }
        : null,
      stockSplit: ca.stockSplit
        ? {
            id: ca.stockSplit.id,
            ratioFrom: ca.stockSplit.ratioFrom,
            ratioTo: ca.stockSplit.ratioTo,
            effectiveDate: ca.stockSplit.effectiveDate,
          }
        : null,
      bonusIssue: ca.bonusIssue
        ? {
            id: ca.bonusIssue.id,
            ratioFrom: ca.bonusIssue.ratioFrom,
            ratioTo: ca.bonusIssue.ratioTo,
            recordDate: ca.bonusIssue.recordDate,
            effectiveDate: ca.bonusIssue.effectiveDate,
          }
        : null,
      rightsIssue: ca.rightsIssue
        ? {
            id: ca.rightsIssue.id,
            ratioFrom: ca.rightsIssue.ratioFrom,
            ratioTo: ca.rightsIssue.ratioTo,
            subscriptionPrice: ca.rightsIssue.subscriptionPrice.toNumber(),
            openDate: ca.rightsIssue.openDate,
            closeDate: ca.rightsIssue.closeDate,
          }
        : null,
    };
  }

  /** GET /corporate-actions/dividends */
  async getDividends(stockId?: string, limit = 30) {
    return this.dividendService.getDividends(stockId, limit);
  }

  /** GET /corporate-actions/dividends/:id */
  async getDividendById(id: string) {
    return this.dividendService.getDividendById(id);
  }

  /** GET /corporate-actions/history — user's dividend/corporate action history */
  async getUserHistory(userId: string, limit = 30) {
    return this.dividendService.getUserDividendHistory(userId, limit);
  }
}
