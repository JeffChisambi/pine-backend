import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { AuditLogService } from '../../audit/services/audit-log.service';
import {
  ConflictException,
  ResourceNotFoundException,
  ValidationException,
} from '../../../core/exceptions/app.exception';
import { Role } from '../../../core/constants/roles.constant';
import type { CreateBrokerDto, UpdateBrokerDto, SelectBrokerDto } from '../dto/broker.dto';

/**
 * BrokerService — broker tenant CRUD (Super Admin) and investor broker
 * selection (mobile). The broker relationship is a first-class domain
 * concept: it is persisted on the user, mirrored onto the wallet, and
 * stamped onto every subsequently created broker-scoped row.
 */
@Injectable()
export class BrokerService {
  private readonly logger = new Logger(BrokerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  // ── Super Admin: broker CRUD ──────────────────────────────────────

  async createBroker(dto: CreateBrokerDto, actor: { id: string; role: Role }, ip?: string) {
    const existing = await this.prisma.broker.findUnique({ where: { code: dto.code } });
    if (existing) {
      throw new ConflictException(`A broker with code ${dto.code} already exists`);
    }

    const broker = await this.prisma.broker.create({
      data: {
        name: dto.name,
        code: dto.code,
        description: dto.description,
        logoUrl: dto.logoUrl,
        contactEmail: dto.contactEmail,
        contactPhone: dto.contactPhone,
      },
    });

    await this.auditLog.log({
      actorId: actor.id,
      actorRole: actor.role,
      action: 'BROKER_CREATED',
      resourceType: 'BROKER',
      resourceId: broker.id,
      ipAddress: ip,
      metadata: { name: broker.name, code: broker.code },
    });

    return broker;
  }

  async listBrokers() {
    const brokers = await this.prisma.broker.findMany({
      orderBy: { createdAt: 'asc' },
      include: {
        _count: { select: { users: true } },
        paymentConfig: { select: { isEnabled: true, provider: true, environment: true, merchantId: true } },
      },
    });

    return brokers.map((b) => ({
      id: b.id,
      name: b.name,
      code: b.code,
      description: b.description,
      logoUrl: b.logoUrl,
      contactEmail: b.contactEmail,
      contactPhone: b.contactPhone,
      isActive: b.isActive,
      userCount: b._count.users,
      paymentConfigured: !!b.paymentConfig?.isEnabled,
      paymentProvider: b.paymentConfig?.provider ?? null,
      paymentEnvironment: b.paymentConfig?.environment ?? null,
      createdAt: b.createdAt.toISOString(),
      updatedAt: b.updatedAt.toISOString(),
    }));
  }

  async getBroker(brokerId: string) {
    const broker = await this.prisma.broker.findUnique({
      where: { id: brokerId },
      include: {
        _count: { select: { users: true, orders: true, transactions: true } },
        paymentConfig: {
          select: { isEnabled: true, provider: true, environment: true, updatedAt: true },
        },
        apiConfigs: {
          select: { id: true, key: true, label: true, baseUrl: true, isEnabled: true, updatedAt: true },
        },
      },
    });
    if (!broker) throw new ResourceNotFoundException('Broker', brokerId);

    const admins = await this.prisma.user.findMany({
      where: { brokerId, role: Role.BROKER },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        isActive: true,
        createdAt: true,
        mfaConfig: { select: { isEnabled: true } },
      },
    });

    return {
      ...broker,
      admins: admins.map((a) => ({
        id: a.id,
        email: a.email,
        firstName: a.firstName,
        lastName: a.lastName,
        isActive: a.isActive,
        mfaEnabled: a.mfaConfig?.isEnabled ?? false,
        createdAt: a.createdAt.toISOString(),
      })),
    };
  }

  async updateBroker(
    brokerId: string,
    dto: UpdateBrokerDto,
    actor: { id: string; role: Role },
    ip?: string,
  ) {
    const broker = await this.prisma.broker.findUnique({ where: { id: brokerId } });
    if (!broker) throw new ResourceNotFoundException('Broker', brokerId);

    const updated = await this.prisma.broker.update({
      where: { id: brokerId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.logoUrl !== undefined ? { logoUrl: dto.logoUrl } : {}),
        ...(dto.contactEmail !== undefined ? { contactEmail: dto.contactEmail } : {}),
        ...(dto.contactPhone !== undefined ? { contactPhone: dto.contactPhone } : {}),
      },
    });

    await this.auditLog.log({
      actorId: actor.id,
      actorRole: actor.role,
      action: 'BROKER_UPDATED',
      resourceType: 'BROKER',
      resourceId: brokerId,
      ipAddress: ip,
      metadata: { changes: dto as Record<string, unknown> },
    });

    return updated;
  }

  async setBrokerStatus(
    brokerId: string,
    isActive: boolean,
    actor: { id: string; role: Role },
    ip?: string,
  ) {
    const broker = await this.prisma.broker.findUnique({ where: { id: brokerId } });
    if (!broker) throw new ResourceNotFoundException('Broker', brokerId);

    const updated = await this.prisma.broker.update({
      where: { id: brokerId },
      data: { isActive },
    });

    await this.auditLog.log({
      actorId: actor.id,
      actorRole: actor.role,
      action: isActive ? 'BROKER_ACTIVATED' : 'BROKER_DEACTIVATED',
      resourceType: 'BROKER',
      resourceId: brokerId,
      ipAddress: ip,
    });

    return updated;
  }

  async listBrokerUsers(brokerId: string, page = 1, limit = 50) {
    const broker = await this.prisma.broker.findUnique({ where: { id: brokerId } });
    if (!broker) throw new ResourceNotFoundException('Broker', brokerId);

    const take = Math.min(limit, 100);
    const skip = (page - 1) * take;

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where: { brokerId, role: Role.CUSTOMER },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          kycStatus: true,
          isActive: true,
          brokerSelectedAt: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take,
        skip,
      }),
      this.prisma.user.count({ where: { brokerId, role: Role.CUSTOMER } }),
    ]);

    return { users, total, page, limit: take, totalPages: Math.ceil(total / take) };
  }

  // ── Mobile: broker list + selection ───────────────────────────────

  /** Active brokers an investor may choose from (safe public fields only). */
  async listActiveBrokers() {
    const brokers = await this.prisma.broker.findMany({
      where: { isActive: true },
      select: { id: true, name: true, code: true, description: true, logoUrl: true },
      orderBy: { name: 'asc' },
    });
    return brokers;
  }

  /** The authenticated investor's current broker (or null). */
  async getUserBroker(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        brokerSelectedAt: true,
        broker: { select: { id: true, name: true, code: true, description: true, logoUrl: true, isActive: true } },
      },
    });
    return {
      broker: user?.broker ?? null,
      selectedAt: user?.brokerSelectedAt?.toISOString() ?? null,
    };
  }

  /**
   * Select (or change) the investor's broker.
   *
   * Business rules for CHANGING an existing broker relationship:
   *   - requires explicit `confirmChange: true`
   *   - blocked while the investor has: a nonzero wallet balance, active
   *     reservations, open (non-terminal) orders, holdings, or pending
   *     deposits/withdrawals. Funds and positions are never silently
   *     moved between brokers.
   */
  async selectBroker(userId: string, dto: SelectBrokerDto, ip?: string) {
    const broker = await this.prisma.broker.findUnique({ where: { id: dto.brokerId } });
    if (!broker || !broker.isActive) {
      throw new ValidationException('Selected broker is not available');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, brokerId: true },
    });
    if (!user) throw new ResourceNotFoundException('User', userId);

    // Defense in depth (also enforced by @Roles(CUSTOMER) on the route):
    // only investors may select/change a broker. Staff and broker-admin
    // accounts must never rewrite their own broker relationship.
    if (user.role !== Role.CUSTOMER) {
      throw new ConflictException('Only investor accounts can select a broker.');
    }

    if (user.brokerId === dto.brokerId) {
      return this.getUserBroker(userId);
    }

    const isChange = user.brokerId !== null;

    if (isChange && !dto.confirmChange) {
      throw new ConflictException(
        'You already have a broker. Confirm the change explicitly to proceed.',
      );
    }

    await this.prisma.$transaction(
      async (tx) => {
        if (isChange) {
          // Inside the serializable transaction so a deposit/order landing
          // between check and write cannot slip through (no TOCTOU window).
          await this.assertNoOpenActivity(userId, tx);
        }
        await tx.user.update({
          where: { id: userId },
          data: { brokerId: dto.brokerId, brokerSelectedAt: new Date() },
        });
        // Mirror onto the wallet so wallet-level broker ownership stays
        // consistent (safe: change is blocked unless balance is zero).
        await tx.wallet.updateMany({
          where: { userId },
          data: { brokerId: dto.brokerId },
        });
      },
      { isolationLevel: 'Serializable', maxWait: 5000, timeout: 10000 },
    );

    await this.auditLog.log({
      actorId: userId,
      action: isChange ? 'BROKER_CHANGED' : 'BROKER_SELECTED',
      resourceType: 'BROKER',
      resourceId: dto.brokerId,
      ipAddress: ip,
      metadata: { previousBrokerId: user.brokerId },
    });

    this.logger.log(
      { userId, brokerId: dto.brokerId, previousBrokerId: user.brokerId },
      isChange ? 'Investor changed broker' : 'Investor selected broker',
    );

    return this.getUserBroker(userId);
  }

  /** Throws if the investor has any open financial activity. */
  private async assertNoOpenActivity(
    userId: string,
    db: Pick<PrismaService, 'wallet' | 'walletReservation' | 'transaction' | 'order' | 'holding'> = this
      .prisma,
  ): Promise<void> {
    const wallet = await db.wallet.findUnique({
      where: { userId },
      select: { id: true, balance: true },
    });

    const blockers: string[] = [];

    if (wallet) {
      if (!wallet.balance.isZero()) {
        blockers.push('a nonzero wallet balance (withdraw your funds first)');
      }
      const [activeReservations, pendingTx] = await Promise.all([
        db.walletReservation.count({ where: { walletId: wallet.id, status: 'ACTIVE' } }),
        db.transaction.count({
          where: { walletId: wallet.id, status: { in: ['PENDING', 'PROCESSING'] } },
        }),
      ]);
      if (activeReservations > 0) blockers.push('funds reserved for open orders');
      if (pendingTx > 0) blockers.push('pending deposits or withdrawals');
    }

    const [openOrders, holdings] = await Promise.all([
      db.order.count({
        where: {
          userId,
          // FILLED is intentionally still "open": executed but not yet
          // settled — funds/positions are still in flight.
          status: {
            notIn: ['SETTLED', 'COMPLETED', 'REJECTED', 'CANCELLED', 'EXPIRED'],
          },
        },
      }),
      db.holding.count({ where: { userId, quantity: { gt: 0 } } }),
    ]);
    if (openOrders > 0) blockers.push('open orders (cancel or wait for completion)');
    if (holdings > 0) blockers.push('portfolio holdings (sell your positions first)');

    if (blockers.length > 0) {
      throw new ConflictException(
        `Broker change is not allowed while you have ${blockers.join(', ')}.`,
      );
    }
  }
}
