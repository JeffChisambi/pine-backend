import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QueueName } from '../../../core/constants/queue-names.constant';
import { MarketSyncService } from './market-sync.service';

interface MarketSyncJobData {
  trigger: 'cron' | 'manual' | 'retry';
  force: boolean;
}

/**
 * BullMQ consumer for the `market-sync-queue`. Each job invokes the
 * orchestrator's `executeSyncRun()` method, which handles the full
 * scrape→validate→persist pipeline.
 *
 * BullMQ gives us out of the box:
 * - Automatic retry with exponential backoff (3 attempts, 5s base)
 * - Dead-letter behaviour (failed jobs are kept for manual review)
 * - Concurrency = 1 (only one sync at a time, enforced here AND
 *   by the Redis distributed lock inside the orchestrator)
 * - Job progress tracking and lifecycle hooks
 */
@Processor(QueueName.MARKET_SYNC, {
  concurrency: 1,
  // Stalled job detection: if a job doesn't report progress within
  // 60s, BullMQ considers it stalled and either retries or moves
  // to failed. This protects against Playwright hangs.
  stalledInterval: 60_000,
  maxStalledCount: 2,
})
export class MarketSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(MarketSyncProcessor.name);

  constructor(private readonly marketSyncService: MarketSyncService) {
    super();
  }

  async process(job: Job<MarketSyncJobData>): Promise<void> {
    const { trigger, force } = job.data;

    this.logger.log(
      { jobId: job.id, trigger, force, attempt: job.attemptsMade + 1 },
      `Processing market sync job (attempt ${job.attemptsMade + 1}/${job.opts.attempts ?? 3})`,
    );

    try {
      await job.updateProgress(10);

      const result = await this.marketSyncService.executeSyncRun(
        trigger,
        force,
      );

      await job.updateProgress(100);

      this.logger.log(
        {
          jobId: job.id,
          status: result.status,
          rowsUpserted: result.rowsUpserted,
          durationMs: result.durationMs,
        },
        `Market sync job completed: ${result.status}`,
      );
    } catch (error) {
      const isLastAttempt = (job.attemptsMade + 1) >= (job.opts.attempts ?? 3);

      this.logger.error(
        {
          jobId: job.id,
          err: error,
          attempt: job.attemptsMade + 1,
          isLastAttempt,
        },
        `Market sync job failed${isLastAttempt ? ' — no more retries' : ' — will retry'}`,
      );

      // Re-throw to let BullMQ handle retry logic
      throw error;
    }
  }
}
