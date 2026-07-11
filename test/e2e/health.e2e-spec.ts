import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from '../utils/test-app.factory';

describe('Health (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /v1/health/liveness returns 200 without checking dependencies', async () => {
    const response = await request(app.getHttpServer()).get('/v1/health/liveness');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('GET /v1/health/readiness returns 200 when DB and Redis are reachable', async () => {
    const response = await request(app.getHttpServer()).get('/v1/health/readiness');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });

  it('returns a standard error envelope for an unknown route', async () => {
    const response = await request(app.getHttpServer()).get('/v1/this-route-does-not-exist');
    expect(response.status).toBe(404);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(response.body.meta.requestId).toBeDefined();
  });
});
