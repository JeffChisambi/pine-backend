import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { Decimal } from '@prisma/client/runtime/library';
import { CorporateActionsRepository } from '../repositories/corporate-actions.repository';
import { FINANCIAL_TRANSACTION_OPTIONS } from '../../../infrastructure/database/prisma.service';

/**
 * Distribution Engine — the heart of Corporate Actions.
 *
 * On payment date:
 *   1. Find all shareholders (from Holdings)
 *   2. Calculate payment per investor (shares × dividend per share)
 *   3. Apply withholding tax
 *   4. Create ledger entries (CREDIT to USER_WALLET)
 *   5. Update wallet balance
 *   6. Notify user
 *
 * Everything automated. The engine also handles:
 *   - Bonus share distributions (Portfolio updated, Wallet unchanged)
 *   - Stock splits (Portfolio updated, Wallet unchanged)
 *
 * Events published:
 *   corporate-actions.dividend.paid
 *   corporate-actions.bonus.issued
 *   corporate-actions.split.applied
 */
@Injectable()
export class DistributionEngine {
  private readonly logger = new Logger(DistributionEngine.name);

  constructor(
    private readonly repo: CorporateActionsRepository,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ── Dividend Distribution ───────────────────────────────────

  /**
   * Distribute a dividend to all eligible shareholders.
   *
   * Workflow:
   *   Record Date → Find shareholders → Calculate payment
   *   → Create distributions → Ledger credit → Wallet updated
   */
  async distributeDividend(dividendId: string): Promise<{
    distributed: number;
    totalPaid: number;
    totalTax: number;
  }> {
    const dividend = await this.repo.findDividendById(dividendId);
    if (!dividend) {
      throw new Error(`Dividend ${dividendId} not found`);
    }

    // Mark as processing
    await this.repo.updateDividendStatus(dividendId, 'PROCESSING');
    if (dividend.corporateAction) {
      await this.repo.updateCorporateActionStatus(
        dividend.corporateAction.id,
        'PROCESSING',
      );
    }

    // Find all shareholders
    const shareholders = await this.repo.findShareholdersByStock(dividend.stockId);
    let totalPaid = new Decimal(0);
    let totalTax = new Decimal(0);
    let distributed = 0;

    const prisma = this.repo.prismaClient;

    for (const holder of shareholders) {
      try {
        await prisma.$transaction(async (tx) => {
          const quantity = holder.quantity;
          const grossAmount = quantity.mul(dividend.amountPerShare);
          const taxRate = dividend.withholdingTaxPct.div(100);
          const taxAmount = grossAmount.mul(taxRate);
          const netAmount = grossAmount.sub(taxAmount);

          // Create distribution record
          await this.repo.createDistribution({
            dividendId,
            userId: holder.userId,
            quantityHeld: quantity,
            grossAmount,
            taxWithheld: taxAmount,
            netAmount,
          });

          // Create ledger entry (credit user wallet)
          const wallet = await tx.wallet.findUnique({
            where: { userId: holder.userId },
          });

          if (wallet) {
            // Create transaction
            const transaction = await tx.transaction.create({
              data: {
                walletId: wallet.id,
                type: 'DIVIDEND_CREDIT',
                status: 'COMPLETED',
                amount: netAmount,
                description: `Dividend: ${dividend.stock.symbol} — ${quantity} shares × MWK ${dividend.amountPerShare}`,
                processedAt: new Date(),
              },
            });

            // Ledger entries (double-entry)
            const newBalance = wallet.balance.add(netAmount);
            await tx.ledgerEntry.create({
              data: {
                transactionId: transaction.id,
                walletId: wallet.id,
                accountType: 'USER_WALLET',
                direction: 'CREDIT',
                amount: netAmount,
                balanceAfter: newBalance,
              },
            });
            await tx.ledgerEntry.create({
              data: {
                transactionId: transaction.id,
                accountType: 'PLATFORM_CASH',
                direction: 'DEBIT',
                amount: netAmount,
                balanceAfter: new Decimal(0),
              },
            });

            // Update wallet balance
            await tx.wallet.update({
              where: { id: wallet.id, version: wallet.version },
              data: { balance: newBalance, version: { increment: 1 } },
            });
          }

          totalPaid = totalPaid.add(netAmount);
          totalTax = totalTax.add(taxAmount);
          distributed++;
        }, FINANCIAL_TRANSACTION_OPTIONS);

        // Emit per-user event
        this.eventEmitter.emit('corporate-actions.dividend.paid', {
          userId: holder.userId,
          dividendId,
          stockId: dividend.stockId,
          stockSymbol: dividend.stock.symbol,
          quantity: holder.quantity.toNumber(),
          grossAmount: holder.quantity.mul(dividend.amountPerShare).toNumber(),
          netAmount: holder.quantity
            .mul(dividend.amountPerShare)
            .sub(
              holder.quantity
                .mul(dividend.amountPerShare)
                .mul(dividend.withholdingTaxPct.div(100)),
            )
            .toNumber(),
        });
      } catch (error) {
        this.logger.error(
          { err: error, userId: holder.userId, dividendId },
          'Failed to distribute dividend to user',
        );
      }
    }

    // Mark dividend as credited
    await this.repo.updateDividendStatus(dividendId, 'CREDITED');
    if (dividend.corporateAction) {
      await this.repo.updateCorporateActionStatus(
        dividend.corporateAction.id,
        'COMPLETED',
        { processedAt: new Date() },
      );
    }

    this.logger.log(
      {
        dividendId,
        stockSymbol: dividend.stock.symbol,
        distributed,
        totalPaid: totalPaid.toNumber(),
        totalTax: totalTax.toNumber(),
      },
      'Dividend distribution complete',
    );

    return {
      distributed,
      totalPaid: totalPaid.toNumber(),
      totalTax: totalTax.toNumber(),
    };
  }

  // ── Stock Split Distribution ────────────────────────────────

  /**
   * Apply a stock split to all holders.
   *
   * For a 2-for-1 split:
   *   250 shares → 500 shares
   *   Average cost halves
   *   Wallet unchanged
   */
  async applyStockSplit(corporateActionId: string): Promise<{
    affected: number;
  }> {
    const ca = await this.repo.findCorporateActionById(corporateActionId);
    if (!ca?.stockSplit) throw new Error('Stock split not found');

    const split = ca.stockSplit;
    const multiplier = new Decimal(split.ratioTo).div(split.ratioFrom);

    await this.repo.updateCorporateActionStatus(corporateActionId, 'PROCESSING');

    const shareholders = await this.repo.findShareholdersByStock(split.stockId);
    const prisma = this.repo.prismaClient;
    let affected = 0;

    for (const holder of shareholders) {
      try {
        await prisma.$transaction(async (tx) => {
          const newQuantity = holder.quantity.mul(multiplier);
          const newAvgCost = holder.averageCost.div(multiplier);

          await tx.holding.updateMany({
            where: { userId: holder.userId, stockId: split.stockId },
            data: { quantity: newQuantity, averageCost: newAvgCost },
          });

          affected++;
        });

        this.eventEmitter.emit('corporate-actions.split.applied', {
          userId: holder.userId,
          stockId: split.stockId,
          ratioFrom: split.ratioFrom,
          ratioTo: split.ratioTo,
          oldQuantity: holder.quantity.toNumber(),
          newQuantity: holder.quantity.mul(multiplier).toNumber(),
        });
      } catch (error) {
        this.logger.error(
          { err: error, userId: holder.userId, corporateActionId },
          'Failed to apply stock split',
        );
      }
    }

    await this.repo.updateCorporateActionStatus(corporateActionId, 'COMPLETED', {
      processedAt: new Date(),
    });

    this.logger.log(
      { corporateActionId, affected, ratio: `${split.ratioFrom}:${split.ratioTo}` },
      'Stock split applied',
    );

    return { affected };
  }

  // ── Bonus Issue Distribution ────────────────────────────────

  /**
   * Distribute bonus shares to all holders.
   *
   * For 1 bonus per 10 shares:
   *   250 shares → 250 + 25 = 275 shares
   *   Average cost adjusted
   *   Wallet unchanged
   */
  async distributeBonusShares(corporateActionId: string): Promise<{
    affected: number;
    totalBonusShares: number;
  }> {
    const ca = await this.repo.findCorporateActionById(corporateActionId);
    if (!ca?.bonusIssue) throw new Error('Bonus issue not found');

    const bonus = ca.bonusIssue;
    await this.repo.updateCorporateActionStatus(corporateActionId, 'PROCESSING');

    const shareholders = await this.repo.findShareholdersByStock(bonus.stockId);
    const prisma = this.repo.prismaClient;
    let affected = 0;
    let totalBonusShares = new Decimal(0);

    for (const holder of shareholders) {
      try {
        const bonusShares = holder.quantity
          .div(bonus.ratioFrom)
          .mul(bonus.ratioTo)
          .floor(); // Only whole shares

        if (bonusShares.lte(0)) continue;

        await prisma.$transaction(async (tx) => {
          const newQuantity = holder.quantity.add(bonusShares);
          // Adjust average cost: total cost stays the same, spread across more shares
          const totalCost = holder.averageCost.mul(holder.quantity);
          const newAvgCost = totalCost.div(newQuantity);

          await tx.holding.updateMany({
            where: { userId: holder.userId, stockId: bonus.stockId },
            data: { quantity: newQuantity, averageCost: newAvgCost },
          });

          affected++;
          totalBonusShares = totalBonusShares.add(bonusShares);
        });

        this.eventEmitter.emit('corporate-actions.bonus.issued', {
          userId: holder.userId,
          stockId: bonus.stockId,
          bonusShares: bonusShares.toNumber(),
          newQuantity: holder.quantity.add(bonusShares).toNumber(),
        });
      } catch (error) {
        this.logger.error(
          { err: error, userId: holder.userId, corporateActionId },
          'Failed to distribute bonus shares',
        );
      }
    }

    await this.repo.updateCorporateActionStatus(corporateActionId, 'COMPLETED', {
      processedAt: new Date(),
    });

    this.logger.log(
      {
        corporateActionId,
        affected,
        totalBonusShares: totalBonusShares.toNumber(),
        ratio: `${bonus.ratioTo}:${bonus.ratioFrom}`,
      },
      'Bonus shares distributed',
    );

    return { affected, totalBonusShares: totalBonusShares.toNumber() };
  }

  // ── Cron: Auto-process due dividends ────────────────────────

  @Cron('0 14 * * 1-5', { name: 'process-due-dividends' })
  async processDueDividends(): Promise<void> {
    this.logger.log('Checking for dividends due for payment');

    const dueDividends = await this.repo.findDividendsDueForPayment(new Date());
    if (dueDividends.length === 0) return;

    for (const dividend of dueDividends) {
      try {
        await this.distributeDividend(dividend.id);
      } catch (error) {
        this.logger.error(
          { err: error, dividendId: dividend.id },
          'Failed to process due dividend',
        );
      }
    }

    this.logger.log(
      { count: dueDividends.length },
      'Due dividends processing complete',
    );
  }
}
