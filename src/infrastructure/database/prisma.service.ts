import {
  INestApplication,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { AppConfigService } from '../../config/app-config.service';

/**
 * Primary (read-write) database client. Every write in the system goes
 * through this — the read replica (`PrismaReadReplicaService`) is
 * strictly for non-critical, read-heavy queries (market data listings,
 * analytics dashboards) that can tolerate a few seconds of replication
 * lag and must never contend with transaction-processing traffic.
 *
 * `$transaction` is used directly by services for multi-step financial
 * writes (see `shared/base/repository.interface.ts` for the
 * `TransactionalContext` convention) — `Prisma.TransactionClient` is
 * re-exported here so repositories can type their transactional methods
 * without importing `@prisma/client` all over the codebase.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: AppConfigService) {
    super({
      datasourceUrl: config.database.url,
      log: config.app.isDevelopment
        ? [
            { emit: 'event', level: 'query' },
            { emit: 'stdout', level: 'warn' },
            { emit: 'stdout', level: 'error' },
          ]
        : [
            { emit: 'stdout', level: 'warn' },
            { emit: 'stdout', level: 'error' },
          ],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Database connection established');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Database connection closed');
  }

  /**
   * Wires Prisma's `beforeExit` hook into Nest's shutdown sequence so
   * in-flight financial transactions get a chance to finish (or roll
   * back cleanly) instead of being killed mid-write during a deploy.
   */
  enableShutdownHooks(app: INestApplication): void {
    process.on('beforeExit', () => {
      void app.close();
    });
  }
}

export type PrismaTransactionClient = Prisma.TransactionClient;

/**
 * Standard transaction options for financial write paths: `Serializable`
 * isolation is required (not the Postgres default `Read Committed`) to
 * prevent classic double-spend races — e.g. two concurrent withdrawal
 * requests both reading the same pre-debit balance and both passing a
 * "sufficient funds" check. Combined with row-level `SELECT ... FOR
 * UPDATE` locking inside the transaction (each module's repository is
 * responsible for that), this is the standard belt-and-braces pattern
 * for ledger-backed balance mutations.
 */
export const FINANCIAL_TRANSACTION_OPTIONS: {
  isolationLevel: Prisma.TransactionIsolationLevel;
  maxWait: number;
  timeout: number;
} = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  maxWait: 5_000,
  timeout: 10_000,
};
