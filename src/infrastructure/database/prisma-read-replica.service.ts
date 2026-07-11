import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AppConfigService } from '../../config/app-config.service';

/**
 * Read-only replica client. Falls back to the primary's URL when no
 * replica is configured (local dev / early production before a replica
 * exists), so injecting this service is always safe — it degrades to
 * "read from primary" rather than failing to boot.
 *
 * Intended consumers: Stocks module listings, Portfolio history,
 * Analytics dashboards, Admin reports — anything that scans many rows
 * and can tolerate replication lag. Never inject this where you're
 * about to make a decision that gates a write (e.g. "check balance
 * then debit") — that read must go through the primary inside the same
 * transaction as the write, or you reintroduce the race the replica
 * lag was supposed to be irrelevant to.
 */
@Injectable()
export class PrismaReadReplicaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaReadReplicaService.name);

  constructor(config: AppConfigService) {
    super({ datasourceUrl: config.database.readReplicaUrl });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Read-replica database connection established');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
