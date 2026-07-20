import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QueueName, DEFAULT_JOB_OPTIONS } from '../../../core/constants/queue-names.constant';
import { AppConfigService } from '../../../config/app-config.service';

/**
 * Cron scheduler for market data synchronization.
 *
 * Instead of executing the sync inline (which would block the
 * scheduler and risk timeout), it enqueues a BullMQ job. This
 * decouples scheduling from execution and gives us:
 *
 * - Automatic retries with exponential backoff
 * - Dead-letter queue for failed jobs
 * - Job deduplication (if the previous job is still running)
 * - Visibility into pending/active/failed jobs via BullMQ dashboard
 *
 * The cron expression is configurable via `MARKET_SYNC_CRON` env var.
 * Default: `* /15 8-16 * * 1-5` (every 15 minutes, 8am–4pm, Mon–Fri)
 * which covers MSE trading hours (10am–2pm CAT) with buffer.
 */
@Injectable()
export class MarketSyncCronService {
  private readonly logger = new Logger(MarketSyncCronService.name);

  constructor(
    @InjectQueue(QueueName.MARKET_SYNC)
    private readonly marketSyncQueue: Queue,
    private readonly config: AppConfigService,
  ) {}

  /**
   * The main cron trigger. Uses a hardcoded conservative schedule as
   * a fallback — the actual cron expression is in the env config but
   * NestJS `@Cron` decorator requires a compile-time constant.
   *
   * We use a 15-minute interval during extended market hours (8am–4pm)
   * as the decorator value, and the job processor handles the actual
   * market-open check.
   */
  @Cron('0 */5 8-16 * * 1-5', {
    name: 'market-sync-cron',
    timeZone: 'Africa/Blantyre',
  })
  async handleCron(): Promise<void> {
    this.logger.log('Market sync cron triggered');

    try {
      // Check if there's already a pending/active job to avoid piling up
      const activeJobs = await this.marketSyncQueue.getActiveCount();
      const waitingJobs = await this.marketSyncQueue.getWaitingCount();

      if (activeJobs > 0 || waitingJobs > 0) {
        this.logger.log(
          { activeJobs, waitingJobs },
          'Skipping cron — sync job already queued or active',
        );
        return;
      }

      await this.marketSyncQueue.add(
        'sync',
        { trigger: 'cron', force: false },
        {
          ...DEFAULT_JOB_OPTIONS,
          // Include date + hour so each hour gets a fresh deduplication window.
          // Previously using only the date caused all cron runs in a day to be
          // blocked if one job got stuck in a non-final state.
          jobId: `market-sync-cron-${new Date().toISOString().slice(0, 13)}`,
        },
      );

      this.logger.log('Market sync job enqueued via cron');
    } catch (error) {
      this.logger.error({ err: error }, 'Failed to enqueue market sync job');
    }
  }

  /**
   * Enqueue a manual sync run (called by admin controller).
   * @param force Skip market-calendar and circuit-breaker checks
   * @returns The BullMQ job ID
   */
  async triggerManualSync(force = false): Promise<string> {
    const job = await this.marketSyncQueue.add(
      'sync',
      { trigger: 'manual', force },
      {
        ...DEFAULT_JOB_OPTIONS,
        priority: 1, // Higher priority than cron jobs
      },
    );

    this.logger.log({ jobId: job.id, force }, 'Manual market sync job enqueued');
    return job.id ?? 'unknown';
  }
}
