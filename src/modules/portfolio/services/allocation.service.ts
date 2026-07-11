import { Injectable, Logger } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { PortfolioRepository } from '../repositories/portfolio.repository';
import { PortfolioCalculator, AllocationEntry } from './portfolio-calculator.service';
import { ValuationService } from './valuation.service';

/**
 * Allocation Service — asset and sector allocation.
 *
 * Computes:
 * - Stocks vs Cash breakdown
 * - Per-sector allocation
 * - Per-stock weight
 *
 * Future: Malawi Stocks, US Stocks, ETFs, Government Bonds
 */
@Injectable()
export class AllocationService {
  private readonly logger = new Logger(AllocationService.name);

  constructor(
    private readonly repo: PortfolioRepository,
    private readonly calculator: PortfolioCalculator,
    private readonly valuationService: ValuationService,
  ) {}

  /**
   * Calculate current allocation breakdown.
   */
  async getAllocation(userId: string): Promise<{
    allocations: AllocationEntry[];
    sectorAllocation: Array<{ sector: string; percentage: number }>;
  }> {
    const holdings = await this.valuationService.getValuations(userId);
    const wallet = await this.repo.findWalletByUserId(userId);
    const cashBalance = wallet?.balance.toNumber() ?? 0;

    const totalMarketValue = holdings.reduce((sum, h) => sum + h.marketValue, 0);
    const totalPortfolioValue = cashBalance + totalMarketValue;

    const allocations = this.calculator.calculateAllocation(
      holdings,
      cashBalance,
      totalPortfolioValue,
    );

    const sectorAllocation = this.calculator.calculateSectorAllocation(holdings);

    return { allocations, sectorAllocation };
  }

  /**
   * Save an allocation snapshot for today.
   */
  async saveAllocationSnapshot(userId: string): Promise<void> {
    const { allocations } = await this.getAllocation(userId);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    await this.repo.saveAllocations(
      userId,
      today,
      allocations.map((a) => ({
        assetType: a.assetType,
        sector: a.sector,
        symbol: a.symbol,
        value: new Decimal(a.value),
        percentage: new Decimal(a.percentage),
      })),
    );
  }
}
