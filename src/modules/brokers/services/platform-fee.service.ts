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

  /** The broker new investors are placed with (see identity.service). */
  async getDefaultBroker() {
    const row = await this.prisma.platformConfig.findUnique({
      where: { id: 'default' },
      select: { defaultBrokerId: true },
    });
    if (!row?.defaultBrokerId) return { broker: null, unassignedInvestors: await this.countUnassigned() };
    const broker = await this.prisma.broker.findUnique({
      where: { id: row.defaultBrokerId },
      select: { id: true, name: true, code: true, isActive: true },
    });
    return { broker, unassignedInvestors: await this.countUnassigned() };
  }

  /**
   * Set the default broker and, if asked, place every investor who has no
   * broker with it. Only investors with NO broker are touched: an existing
   * relationship (and the money under it) is never moved by this.
   */
  async setDefaultBroker(brokerId: string, updatedById: string, applyToUnassigned: boolean) {
    const broker = await this.prisma.broker.findUnique({
      where: { id: brokerId },
      select: { id: true, name: true, code: true, isActive: true },
    });
    if (!broker || !broker.isActive) {
      throw new Error('That broker does not exist or is not active.');
    }

    await this.prisma.platformConfig.upsert({
      where: { id: 'default' },
      create: { id: 'default', defaultBrokerId: brokerId, updatedById },
      update: { defaultBrokerId: brokerId, updatedById },
    });

    let assigned = 0;
    if (applyToUnassigned) {
      const now = new Date();
      const result = await this.prisma.user.updateMany({
        where: { role: 'CUSTOMER', brokerId: null, deletedAt: null },
        data: { brokerId, brokerSelectedAt: now },
      });
      assigned = result.count;
      // Wallets mirror the owner's broker so wallet-level ownership stays
      // consistent (the same mirror selectBroker maintains).
      await this.prisma.wallet.updateMany({
        where: { brokerId: null, user: { brokerId } },
        data: { brokerId },
      });
    }

    this.logger.log({ brokerId, updatedById, assigned }, 'Default broker updated');
    return { broker, assigned, unassignedInvestors: await this.countUnassigned() };
  }

  private countUnassigned(): Promise<number> {
    return this.prisma.user.count({ where: { role: 'CUSTOMER', brokerId: null, deletedAt: null } });
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
