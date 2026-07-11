import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import {
  DiskHealthIndicator,
  HealthCheck,
  HealthCheckService,
  MemoryHealthIndicator,
} from '@nestjs/terminus';
import { Public } from '../../core/decorators/public.decorator';
import { PrismaHealthIndicator, RedisHealthIndicator } from './health.indicators';

/**
 * Three distinct endpoints because Kubernetes (or any orchestrator)
 * treats them differently:
 *   - `/health/liveness`  — "is the process alive at all?" No
 *     dependency checks. If this fails, the orchestrator kills and
 *     restarts the pod.
 *   - `/health/readiness` — "can this instance actually serve traffic
 *     right now?" Checks DB + Redis. If this fails, the orchestrator
 *     stops routing traffic to the pod WITHOUT restarting it (useful
 *     during a brief DB failover).
 *   - `/health`            — full diagnostic report (DB, Redis, disk,
 *     memory) for humans/dashboards, not used for orchestration
 *     decisions.
 *
 * Excluded from Swagger and from Pino's request-logging (see
 * `LoggerModule`'s `autoLogging.ignore`) since orchestrators poll these
 * every few seconds and the noise adds nothing.
 */
@ApiExcludeController()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: PrismaHealthIndicator,
    private readonly redis: RedisHealthIndicator,
    private readonly disk: DiskHealthIndicator,
    private readonly memory: MemoryHealthIndicator,
  ) {}

  @Public()
  @Get('liveness')
  @HttpCode(HttpStatus.OK)
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Public()
  @Get('readiness')
  @HealthCheck()
  readiness() {
    return this.health.check([() => this.db.check(), () => this.redis.check()]);
  }

  @Public()
  @Get()
  @HealthCheck()
  check() {
    return this.health.check([
      () => this.db.check(),
      () => this.redis.check(),
      () => this.disk.checkStorage('disk', { path: '/', thresholdPercent: 0.9 }),
      () => this.memory.checkHeap('memory_heap', 500 * 1024 * 1024),
      () => this.memory.checkRSS('memory_rss', 1024 * 1024 * 1024),
    ]);
  }
}
