import { Injectable, Logger } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../../../infrastructure/database/prisma.service';

/**
 * PlatformFeeService — Pine's own commission on broker earnings.
 *
 * The platform rate is a percentage of the BROKER's commission (not of the
 * trade value): if a broker earns MK 1,000 commission on a trade and the
 * platform rate is 20%, Pine's fee on that trade is MK 200 — recorded on
 * the Trade row at execution (`platformFee`) so later rate changes never
 * rewrite history. Brokers settle the accumulated total with Pine monthly.
 *
 * Single source of truth for the rate; 60s cache, invalidated on update.
 */
@Injectable()
export class PlatformFeeService {
  private readonly logger = new Logger(PlatformFeeService.name);
  private cache: { ratePct: Decimal; at: number } | null = null;
  private static readonly TTL_MS = 60_000;

  constructor(private readonly prisma: PrismaService) {}

  /** Current platform commission rate (percent of broker commission). */
  async ratePct(): Promise<Decimal> {
    if (this.cache && Date.now() - this.cache.at < PlatformFeeService.TTL_MS) {
      return this.cache.ratePct;
    }
    const row = await this.prisma.platformConfig.findUnique({ where: { id: 'default' } });
    const ratePct = row?.platformCommissionPct ?? new Decimal(0);
    this.cache = { ratePct, at: Date.now() };
    return ratePct;
  }

  /** Pine's fee on a single trade given the broker commission charged. */
  async feeForCommission(brokerCommission: Decimal): Promise<Decimal> {
    const rate = await this.ratePct();
    if (rate.lte(0) || brokerCommission.lte(0)) return new Decimal(0);
    return brokerCommission.mul(rate).div(100).toDecimalPlaces(4);
  }

  async getConfig() {
    const row = await this.prisma.platformConfig.upsert({
      where: { id: 'default' },
      create: { id: 'default' },
      update: {},
    });
    return {
      platformCommissionPct: row.platformCommissionPct.toNumber(),
      updatedAt: row.updatedAt,
      updatedById: row.updatedById,
    };
  }

  async setRate(ratePct: number, updatedById: string) {
    const row = await this.prisma.platformConfig.upsert({
      where: { id: 'default' },
      create: { id: 'default', platformCommissionPct: ratePct, updatedById },
      update: { platformCommissionPct: ratePct, updatedById },
    });
    this.cache = null;
    this.logger.log({ ratePct, updatedById }, 'Platform commission rate updated');
    return {
      platformCommissionPct: row.platformCommissionPct.toNumber(),
      updatedAt: row.updatedAt,
      updatedById: row.updatedById,
    };
  }
}
