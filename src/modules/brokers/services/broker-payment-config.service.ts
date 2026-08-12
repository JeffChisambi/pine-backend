import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { BrokerSecretsService } from './broker-secrets.service';
import { AuditLogService } from '../../audit/services/audit-log.service';
import { Role } from '../../../core/constants/roles.constant';
import {
  ConflictException,
  ResourceNotFoundException,
} from '../../../core/exceptions/app.exception';
import type { UpsertBrokerPaymentConfigDto, UpsertBrokerApiConfigDto } from '../dto/broker.dto';

/** Decrypted gateway credentials — server-side use only. Never serialized. */
export interface ResolvedBrokerGatewayConfig {
  brokerId: string;
  provider: string;
  baseUrl: string;
  apiVersion: number;
  environment: string;
  merchantId: string;
  apiPassword: string;
}

/**
 * BrokerPaymentConfigService — Super Admin management of each broker's
 * payment integration, plus server-side credential resolution for the
 * deposit pipeline.
 *
 * Security invariants:
 *   - Secrets are AES-256-GCM encrypted at rest.
 *   - GET responses never contain a secret — only `configured` flags and
 *     masked settlement info.
 *   - Configuration changes are audit-logged (without secret values).
 *   - Decrypted credentials exist only in memory while a gateway request
 *     is being built, and only for the broker of the paying investor.
 */
@Injectable()
export class BrokerPaymentConfigService {
  private readonly logger = new Logger(BrokerPaymentConfigService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: BrokerSecretsService,
    private readonly auditLog: AuditLogService,
  ) {}

  // ── Super Admin: read (masked) ────────────────────────────────────

  async getMaskedConfig(brokerId: string) {
    const broker = await this.prisma.broker.findUnique({ where: { id: brokerId } });
    if (!broker) throw new ResourceNotFoundException('Broker', brokerId);

    const cfg = await this.prisma.brokerPaymentConfig.findUnique({ where: { brokerId } });
    if (!cfg) {
      return { brokerId, configured: false };
    }

    return {
      brokerId,
      configured: true,
      provider: cfg.provider,
      baseUrl: cfg.baseUrl,
      apiVersion: cfg.apiVersion,
      environment: cfg.environment,
      merchantId: cfg.merchantId,
      apiPasswordSet: !!cfg.apiPasswordEnc,
      settlementBankName: cfg.settlementBankName,
      settlementAccountName: cfg.settlementAccountName,
      settlementAccountMasked: cfg.settlementAccountMasked,
      isEnabled: cfg.isEnabled,
      updatedAt: cfg.updatedAt.toISOString(),
    };
  }

  // ── Super Admin: upsert ───────────────────────────────────────────

  async upsertConfig(
    brokerId: string,
    dto: UpsertBrokerPaymentConfigDto,
    actor: { id: string; role: Role },
    ip?: string,
  ) {
    const broker = await this.prisma.broker.findUnique({ where: { id: brokerId } });
    if (!broker) throw new ResourceNotFoundException('Broker', brokerId);

    const data: Record<string, unknown> = { updatedById: actor.id };
    const changedFields: string[] = [];

    for (const field of ['provider', 'baseUrl', 'apiVersion', 'environment', 'merchantId', 'settlementBankName', 'settlementAccountName', 'isEnabled'] as const) {
      if (dto[field] !== undefined) {
        data[field] = dto[field];
        changedFields.push(field);
      }
    }

    if (dto.apiPassword !== undefined) {
      const { enc, iv, tag } = this.secrets.encrypt(dto.apiPassword);
      data.apiPasswordEnc = enc;
      data.apiPasswordIv = iv;
      data.apiPasswordTag = tag;
      changedFields.push('apiPassword'); // field name only — never the value
    }

    if (dto.settlementAccountNumber !== undefined) {
      const { enc, iv, tag } = this.secrets.encrypt(dto.settlementAccountNumber);
      data.settlementAccountEnc = enc;
      data.settlementAccountIv = iv;
      data.settlementAccountTag = tag;
      data.settlementAccountMasked = this.secrets.mask(dto.settlementAccountNumber);
      changedFields.push('settlementAccountNumber');
    }

    await this.prisma.brokerPaymentConfig.upsert({
      where: { brokerId },
      create: { brokerId, ...data },
      update: data,
    });

    await this.auditLog.log({
      actorId: actor.id,
      actorRole: actor.role,
      action: 'BROKER_PAYMENT_CONFIG_UPDATED',
      resourceType: 'BROKER_PAYMENT_CONFIG',
      resourceId: brokerId,
      ipAddress: ip,
      metadata: { changedFields }, // never secret values
    });

    return this.getMaskedConfig(brokerId);
  }

  // ── Super Admin: broker API configs ───────────────────────────────

  async listApiConfigs(brokerId: string) {
    const broker = await this.prisma.broker.findUnique({ where: { id: brokerId } });
    if (!broker) throw new ResourceNotFoundException('Broker', brokerId);

    const configs = await this.prisma.brokerApiConfig.findMany({
      where: { brokerId },
      orderBy: { key: 'asc' },
    });

    return configs.map((c) => ({
      id: c.id,
      key: c.key,
      label: c.label,
      baseUrl: c.baseUrl,
      secretSet: !!c.secretEnc,
      metadata: c.metadata,
      isEnabled: c.isEnabled,
      updatedAt: c.updatedAt.toISOString(),
    }));
  }

  async upsertApiConfig(
    brokerId: string,
    dto: UpsertBrokerApiConfigDto,
    actor: { id: string; role: Role },
    ip?: string,
  ) {
    const broker = await this.prisma.broker.findUnique({ where: { id: brokerId } });
    if (!broker) throw new ResourceNotFoundException('Broker', brokerId);

    const data: Record<string, unknown> = {
      label: dto.label,
      baseUrl: dto.baseUrl,
      metadata: dto.metadata as object | undefined,
      updatedById: actor.id,
      ...(dto.isEnabled !== undefined ? { isEnabled: dto.isEnabled } : {}),
    };

    if (dto.secret !== undefined) {
      const { enc, iv, tag } = this.secrets.encrypt(dto.secret);
      data.secretEnc = enc;
      data.secretIv = iv;
      data.secretTag = tag;
    }

    await this.prisma.brokerApiConfig.upsert({
      where: { brokerId_key: { brokerId, key: dto.key } },
      create: { brokerId, key: dto.key, ...data },
      update: data,
    });

    await this.auditLog.log({
      actorId: actor.id,
      actorRole: actor.role,
      action: 'BROKER_API_CONFIG_UPDATED',
      resourceType: 'BROKER_API_CONFIG',
      resourceId: brokerId,
      ipAddress: ip,
      metadata: { key: dto.key, secretChanged: dto.secret !== undefined },
    });

    return this.listApiConfigs(brokerId);
  }

  // ── Payments pipeline: resolve live credentials for a user ────────

  /**
   * Resolve the decrypted gateway configuration for the broker of the
   * given investor. Derives the broker STRICTLY from the authenticated
   * user's persisted relationship — never from client input.
   *
   * Throws:
   *   - BROKER_REQUIRED conflict if the investor has no broker.
   *   - Conflict if the broker is inactive or payments are not configured.
   */
  async resolveGatewayConfigForUser(userId: string): Promise<ResolvedBrokerGatewayConfig> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        brokerId: true,
        broker: { select: { id: true, name: true, isActive: true, paymentConfig: true } },
      },
    });

    if (!user?.brokerId || !user.broker) {
      throw new ConflictException(
        'Select a broker in your profile before making a deposit.',
        undefined,
        { reason: 'BROKER_REQUIRED' },
      );
    }
    if (!user.broker.isActive) {
      throw new ConflictException('Your broker is currently unavailable. Contact support.');
    }

    const cfg = user.broker.paymentConfig;
    if (!cfg || !cfg.isEnabled || !cfg.merchantId || !cfg.apiPasswordEnc || !cfg.baseUrl) {
      throw new ConflictException(
        'Deposits are not yet enabled for your broker. Please try again later.',
        undefined,
        { reason: 'BROKER_PAYMENTS_NOT_CONFIGURED' },
      );
    }

    const apiPassword = this.secrets.decrypt(
      cfg.apiPasswordEnc,
      cfg.apiPasswordIv!,
      cfg.apiPasswordTag!,
    );

    return {
      brokerId: user.broker.id,
      provider: cfg.provider,
      baseUrl: cfg.baseUrl,
      apiVersion: cfg.apiVersion,
      environment: cfg.environment,
      merchantId: cfg.merchantId,
      apiPassword,
    };
  }
}
