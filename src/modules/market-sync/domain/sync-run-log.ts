/**
 * Sync run audit log — captures every scrape attempt's outcome so
 * operators can track reliability, debug failures, and detect
 * degradation trends. Not a Prisma model (we store this in Redis
 * lists + emit as structured log lines) — keeps the audit trail
 * lightweight and avoids schema migrations for operational metadata.
 */

export enum SyncRunStatus {
  SUCCESS = 'SUCCESS',
  PARTIAL = 'PARTIAL',
  FAILED = 'FAILED',
  SKIPPED = 'SKIPPED',
}

export interface SyncRunLog {
  /** Unique run identifier (UUID) */
  runId: string;

  /** When the sync run started */
  startedAt: Date;

  /** When the sync run completed (success or failure) */
  completedAt: Date;

  /** Final status */
  status: SyncRunStatus;

  /** What triggered this run */
  trigger: 'cron' | 'manual' | 'retry';

  /** Total wall-clock duration in milliseconds */
  durationMs: number;

  /** Number of stock rows successfully processed */
  rowsProcessed: number;

  /** Number of stock rows that failed validation */
  rowsFailed: number;

  /** Number of new/updated price records upserted */
  rowsUpserted: number;

  /** Human-readable error message, if any */
  errorMessage?: string;

  /** Error class name for programmatic handling */
  errorCode?: string;

  /** Path to failure screenshot, if captured */
  screenshotPath?: string;
}
