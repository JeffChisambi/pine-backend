import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { AppConfigService } from '../../config/app-config.service';
import { ConfigModule } from '../../config/config.module';
import { CORRELATION_ID_HEADER } from '../../core/middleware/correlation-id.middleware';

/**
 * Structured JSON logging via Pino (`nestjs-pino`), auto-wired as an
 * HTTP middleware that logs one line per request/response with the
 * request ID attached — every subsequent `logger.log(...)` call made
 * during that request (via the injected `PinoLogger`/`Logger`) is
 * automatically correlated to the same request ID without manually
 * threading it through every call site.
 *
 * Pretty-printed in development for readability; raw JSON in
 * production/staging so log lines are directly ingestible by a log
 * aggregator (CloudWatch, Loki, Datadog, ...) without a parsing step.
 *
 * Request/response bodies are never logged wholesale — only method,
 * URL, status, and duration — since bodies routinely contain PII (KYC
 * data) and secrets (passwords, PINs, tokens).
 */
@Module({
  imports: [
    ConfigModule,
    PinoLoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        pinoHttp: {
          level: config.observability.logLevel,
          genReqId: (req: { headers: Record<string, string | string[] | undefined> }) => {
            const existing = req.headers[CORRELATION_ID_HEADER];
            return (Array.isArray(existing) ? existing[0] : existing) || randomUUID();
          },
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.headers["x-api-key"]',
              'req.body.password',
              'req.body.pin',
              'req.body.newPin',
              'req.body.currentPin',
              'req.body.otp',
              'req.body.refreshToken',
              'res.headers["set-cookie"]',
            ],
            censor: '[REDACTED]',
          },
          transport: config.app.isDevelopment
            ? { target: 'pino-pretty', options: { colorize: true, singleLine: true } }
            : undefined,
          customProps: () => ({ service: config.app.name, env: config.app.env }),
          autoLogging: {
            ignore: (req: { url?: string }) =>
              req.url === '/health/liveness' || req.url === '/health/readiness',
          },
          serializers: {
            req: (req: Record<string, unknown>) => ({
              id: req.id,
              method: req.method,
              url: req.url,
            }),
            res: (res: Record<string, unknown>) => ({ statusCode: res.statusCode }),
          },
        },
      }),
    }),
  ],
  exports: [PinoLoggerModule],
})
export class LoggerModule {}
