#!/usr/bin/env node
/**
 * Re-run the AI verification pipeline for a KYC application.
 *
 * Enqueues a 'verify' job on the kyc-queue exactly like the API does, so the
 * running backend worker picks it up with the full pipeline (OCR + MRZ +
 * face match + address extraction). Use after fixing pipeline config/models
 * to reprocess applications that were submitted while the pipeline was broken.
 *
 * Usage:
 *   node scripts/reprocess-kyc.mjs                  # latest application
 *   node scripts/reprocess-kyc.mjs <applicationId>  # specific application
 *
 * Requires: backend infra running (Postgres + Redis) and the backend itself
 * running (npm run start:dev) so the queue worker consumes the job.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const { Queue } = require('bullmq');

const prisma = new PrismaClient();

const appId = process.argv[2];
const app = appId
  ? await prisma.kycApplication.findUnique({ where: { id: appId } })
  : await prisma.kycApplication.findFirst({ orderBy: { createdAt: 'desc' } });

if (!app) {
  console.error(appId ? `Application ${appId} not found` : 'No KYC applications found');
  process.exit(1);
}

console.log(`Re-queueing verification for application ${app.id} (user ${app.userId}, status ${app.status})`);

const queue = new Queue('kyc-queue', {
  connection: {
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.REDIS_PORT ?? 6379),
  },
});

await queue.add(
  'verify',
  { applicationId: app.id, userId: app.userId },
  { jobId: `kyc-reprocess-${app.id}-${Date.now()}`, removeOnComplete: true, attempts: 1 },
);

console.log('Job enqueued. Watch the backend logs for pipeline progress.');
await queue.close();
await prisma.$disconnect();
