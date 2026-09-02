import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { BrokerSecretsService } from './broker-secrets.service';
import { MastercardGatewayService } from '../../mastercard-gateway/services/mastercard-gateway.service';
import { MastercardGatewayException } from '../../mastercard-gateway/exceptions/mastercard-gateway.exception';
import { AuditLogService } from '../../audit/services/audit-log.service';
import { Role } from '../../../core/constants/roles.constant';
import {
  ConflictException,
  ResourceNotFoundException,
  ValidationException,
} from '../../../core/exceptions/app.exception';
import type { UpsertBrokerPaymentConfigDto, UpsertBrokerApiConfigDto } from '../dto/broker.dto';

/** Result of a Super Admin gateway connection test. Contains no secrets. */
export interface BrokerGatewayTestResult {
  /** The gateway host answered its public /information probe. */
  reachable: boolean;
  /** merchantId + API password were accepted (a session was created). */
  authenticated: boolean;
  /** Round-trip time of the whole test, in milliseconds. */
  latencyMs: number;
  environment: string;
  baseUrl: string;
  /** Masked merchant id — enough to confirm which account was tested. */
  merchantId: string;
  message: string;
}

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
    private readonly gateway: MastercardGatewayService,
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

    const existing = await this.prisma.brokerPaymentConfig.findUnique({ where: { brokerId } });

    // Environment / host consistency: a production merchant must never be
    // pointed at an MTF (test) gateway host, and vice versa — a mismatch
    // silently routes real investor money to a sandbox (or the reverse).
    this.assertEnvironmentMatchesHost(
      dto.environment ?? existing?.environment ?? 'test',
      dto.baseUrl ?? existing?.baseUrl ?? null,
    );

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

  // ── Environment guard ─────────────────────────────────────────────

  /** Hostname of a gateway base URL, lowercased. Falls back to the raw string. */
  private hostOf(baseUrl: string): string {
    try {
      return new URL(baseUrl).hostname.toLowerCase();
    } catch {
      return baseUrl.toLowerCase();
    }
  }

  /**
   * MPGS acquirers expose test/MTF hosts (e.g. `test-nbm.mtf.gateway...`)
   * and production hosts (e.g. `nbm.gateway...`). Saving a mismatched pair
   * is always an operator error, so it is rejected up front.
   */
  private assertEnvironmentMatchesHost(environment: string, baseUrl: string | null): void {
    if (!baseUrl) return;

    const host = this.hostOf(baseUrl);
    const looksTest = host.includes('test') || host.includes('mtf');

    if (environment === 'production' && looksTest) {
      throw new ValidationException(
        'Environment is set to production but the base URL points at a test/MTF gateway host ' +
          `(${host}). Use the acquirer's production host, or switch the environment to test.`,
        { field: 'baseUrl', environment, host },
      );
    }

    if (environment === 'test' && !looksTest) {
      throw new ValidationException(
        `Environment is set to test but the base URL (${host}) is not a test/MTF gateway host. ` +
          "Use the acquirer's test host (it contains \"test\" or \"mtf\"), or switch the environment to production.",
        { field: 'baseUrl', environment, host },
      );
    }
  }

  // ── Super Admin: resolve live credentials for a broker ────────────

  /**
   * Resolve the decrypted gateway configuration for a broker directly,
   * keyed by broker id rather than by investor. Used ONLY by the Super
   * Admin connection test — it deliberately does NOT require `isEnabled`,
   * so credentials can be verified before payments are switched on.
   */
  async resolveGatewayConfigForBroker(brokerId: string): Promise<ResolvedBrokerGatewayConfig> {
    const broker = await this.prisma.broker.findUnique({
      where: { id: brokerId },
      select: { id: true, paymentConfig: true },
    });
    if (!broker) throw new ResourceNotFoundException('Broker', brokerId);

    const cfg = broker.paymentConfig;
    if (!cfg || !cfg.baseUrl || !cfg.merchantId || !cfg.apiPasswordEnc) {
      const missing = [
        !cfg?.baseUrl ? 'baseUrl' : null,
        !cfg?.merchantId ? 'merchantId' : null,
        !cfg?.apiPasswordEnc ? 'apiPassword' : null,
      ].filter(Boolean);
      throw new ValidationException(
        `Gateway credentials are incomplete. Missing: ${missing.join(', ')}.`,
        { missing },
      );
    }

    const apiPassword = this.secrets.decrypt(
      cfg.apiPasswordEnc,
      cfg.apiPasswordIv!,
      cfg.apiPasswordTag!,
    );

    return {
      brokerId: broker.id,
      provider: cfg.provider,
      baseUrl: cfg.baseUrl,
      apiVersion: cfg.apiVersion,
      environment: cfg.environment,
      merchantId: cfg.merchantId,
      apiPassword,
    };
  }

  // ── Super Admin: connection + credential test ─────────────────────

  /**
   * Verify a broker's MPGS integration end to end, without moving money:
   *
   *   1. reachability  — public `/information` probe on the acquirer host.
   *   2. authentication — CREATE SESSION with the broker's merchant id and
   *      decrypted API password. A session id can only be issued when both
   *      are correct, so this proves the credentials, and it charges nothing.
   *
   * The decrypted password lives only in the scoped gateway instance for the
   * duration of the call and never appears in the result, the audit log or
   * any log line.
   */
  async testGatewayConnection(
    brokerId: string,
    actor: { id: string; role: Role },
    ip?: string,
  ): Promise<BrokerGatewayTestResult> {
    const cfg = await this.resolveGatewayConfigForBroker(brokerId);
    const scoped = this.gateway.scopedTo({
      merchantId: cfg.merchantId,
      apiPassword: cfg.apiPassword,
      baseUrl: cfg.baseUrl,
      apiVersion: cfg.apiVersion,
    });

    const started = Date.now();
    let reachable = false;
    let authenticated = false;
    let message: string;

    try {
      const health = await scoped.checkGatewayHealth();
      reachable = health.status === 'OPERATING';
    } catch {
      reachable = false;
    }

    if (!reachable) {
      message =
        `Could not reach ${cfg.baseUrl}. Check the base URL and API version with the acquiring bank.`;
    } else {
      try {
        await scoped.createSession();
        authenticated = true;
        message = 'Gateway reachable and credentials accepted — this broker is ready to take deposits.';
      } catch (error: unknown) {
        authenticated = false;
        message = this.describeGatewayFailure(error);
      }
    }

    const latencyMs = Date.now() - started;

    await this.auditLog.log({
      actorId: actor.id,
      actorRole: actor.role,
      action: 'PAYMENT_CONFIG_TESTED',
      resourceType: 'BROKER',
      resourceId: brokerId,
      ipAddress: ip,
      // Result flags only — never credentials.
      metadata: { reachable, authenticated, latencyMs, environment: cfg.environment },
    });

    return {
      reachable,
      authenticated,
      latencyMs,
      environment: cfg.environment,
      baseUrl: cfg.baseUrl,
      merchantId: this.secrets.mask(cfg.merchantId),
      message,
    };
  }

  /**
   * Turn a gateway failure into an operator-readable sentence. Only the
   * gateway's own cause/explanation is surfaced — never headers, request
   * bodies, credentials or stack traces.
   */
  private describeGatewayFailure(error: unknown): string {
    if (error instanceof MastercardGatewayException) {
      const cause = error.errorCause ?? error.gatewayCode ?? error.gatewayResult;

      if (cause === 'AUTHENTICATION_FAILED' || cause === 'REQUEST_REJECTED') {
        return 'The gateway rejected these credentials. Re-check the merchant ID and API password issued by the acquiring bank.';
      }
      if (cause === 'INVALID_REQUEST') {
        return `The gateway rejected the request: ${error.errorExplanation ?? 'invalid request'}. Check the API version and merchant ID.`;
      }
      if (cause === 'TIMED_OUT') {
        return 'The gateway did not respond in time. Try again, or confirm the host with the acquiring bank.';
      }
      return `Gateway error (${cause}). ${error.errorExplanation ?? ''}`.trim();
    }

    this.logger.error(
      { err: error instanceof Error ? error.message : String(error) },
      'Broker gateway credential test failed unexpectedly',
    );
    return 'The credential check failed unexpectedly. See the server logs for details.';
  }
}
