import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QueueName } from '../../../core/constants/queue-names.constant';
import { KycWorkflowService } from '../services/kyc-workflow.service';

export interface KycVerifyJobPayload {
  applicationId: string;
  userId: string;
}

/**
 * BullMQ processor for the KYC verification queue.
 *
 * Consumes 'verify' jobs enqueued by KycController.process() / retry().
 * Running the pipeline as a background job (H-3 fix):
 *   - Eliminates HTTP timeouts caused by the synchronous 30+ second pipeline
 *   - Ensures exactly-once processing via BullMQ jobId deduplication
 *   - Allows horizontal scaling: add workers = add throughput
 *
 * If the pipeline throws, BullMQ retries per DEFAULT_JOB_OPTIONS (3 attempts
 * with exponential back-off). After all retries are exhausted, the application
 * remains PENDING for manual broker review.
 */
@Processor(QueueName.KYC)
export class KycProcessor extends WorkerHost {
  private readonly logger = new Logger(KycProcessor.name);

  constructor(private readonly workflowService: KycWorkflowService) {
    super();
  }

  async process(job: Job<KycVerifyJobPayload>): Promise<void> {
    const { applicationId, userId } = job.data;

    this.logger.log(
      { applicationId, userId, jobId: job.id, attempt: job.attemptsMade + 1 },
      'Processing KYC verification job',
    );

    await this.workflowService.processVerification(applicationId, userId);

    this.logger.log(
      { applicationId, jobId: job.id },
      'KYC verification job complete',
    );
  }
}
