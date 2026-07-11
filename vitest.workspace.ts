import { defineWorkspace } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * Three isolated Vitest projects, matching the three test types the
 * spec calls for:
 *   - unit        — colocated with source as `*.spec.ts`, no I/O, fully
 *                    mocked dependencies, runs on every commit.
 *   - integration  — `test/integration/**`, hits a real Postgres/Redis
 *                    (the ones spun up by CI's `services:` or local
 *                    docker-compose), exercises repositories/services
 *                    against real infrastructure but not over HTTP.
 *   - e2e          — `test/e2e/**`, boots the full Nest application and
 *                    drives it over HTTP with supertest, closest to
 *                    what a real client experiences.
 *
 * Run with `npm run test`, `npm run test:integration`, `npm run test:e2e`
 * respectively (see package.json), or `vitest --project unit` directly.
 */
export default defineWorkspace([
  {
    plugins: [tsconfigPaths()],
    test: {
      name: 'unit',
      environment: 'node',
      include: ['src/**/*.spec.ts'],
      globals: true,
    },
  },
  {
    plugins: [tsconfigPaths()],
    test: {
      name: 'integration',
      environment: 'node',
      include: ['test/integration/**/*.integration-spec.ts'],
      globals: true,
      hookTimeout: 30_000,
      testTimeout: 15_000,
    },
  },
  {
    plugins: [tsconfigPaths()],
    test: {
      name: 'e2e',
      environment: 'node',
      include: ['test/e2e/**/*.e2e-spec.ts'],
      globals: true,
      hookTimeout: 30_000,
      testTimeout: 15_000,
    },
  },
]);
