import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Logger, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger as PinoLogger } from 'nestjs-pino';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { AppConfigService } from './config/app-config.service';
import { PrismaService } from './infrastructure/database/prisma.service';
import { ValidationException } from './core/exceptions/app.exception';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });

  // Pino replaces Nest's default console logger for the entire app,
  // including framework-internal log lines emitted before our own
  // modules initialize (buffered above via `bufferLogs`, flushed here).
  app.useLogger(app.get(PinoLogger));

  const config = app.get(AppConfigService);

  // ---- Security headers ----
  app.use(
    helmet({
      contentSecurityPolicy: config.app.isProduction
        ? {
            directives: {
              defaultSrc: ["'self'"],
              objectSrc: ["'none'"],
              frameAncestors: ["'none'"],
            },
          }
        : false,
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  // Behind an ALB/nginx/Cloudflare in every real deployment — required
  // for `req.ip`/`req.ips` (rate limiting, audit logs) and `Secure`
  // cookies to work correctly when TLS terminates upstream.
  if (config.security.trustProxy) {
    app.set('trust proxy', 1);
  }

  app.use(compression());
  app.use(cookieParser(config.security.cookieSecret));

  // ---- CORS ----
  const corsOrigins = config.cors.origins.length > 0
    ? config.cors.origins
    : false;

  app.enableCors({
    origin: corsOrigins,
    credentials: config.cors.credentials,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id'],
  });

  // ---- Request size limits ----
  app.useBodyParser('json', { limit: config.security.bodyLimit });
  app.useBodyParser('urlencoded', { limit: config.security.bodyLimit, extended: true });

  // ---- Prefix: every route is served under /v1/... ----
  app.setGlobalPrefix(config.app.apiPrefix);

  // ---- Strict input validation ----
  // whitelist + forbidNonWhitelisted: unknown fields are REJECTED, not
  // silently stripped — a client sending an unexpected field (e.g. a
  // tampered `role` or `balance` in a body) gets a 400, not a body that
  // quietly ignores the extra field and proceeds.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      exceptionFactory: (errors) =>
        new ValidationException(
          'Validation failed',
          errors.map((e) => ({ field: e.property, constraints: e.constraints })),
        ),
    }),
  );

  // Never leak stack traces / internal error shapes to the client —
  // enforced in `GlobalExceptionFilter`, registered as `APP_FILTER` in
  // `AppModule`.

  app.enableShutdownHooks();
  app.get(PrismaService).enableShutdownHooks(app);

  // ---- OpenAPI / Swagger (never exposed in production) ----
  if (!config.app.isProduction) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Pine API')
        .setDescription('Pine — Malawi Stock Exchange investment platform backend')
        .setVersion('1.0')
        .addBearerAuth()
        .addTag('auth')
        .addTag('users')
        .addTag('kyc')
        .addTag('wallet')
        .addTag('payments')
        .addTag('stocks')
        .addTag('trading')
        .addTag('portfolio')
        .addTag('dividends')
        .addTag('notifications')
        .addTag('admin')
        .addTag('analytics')
        .build(),
    );
    SwaggerModule.setup('docs', app, document, {
      swaggerOptions: { persistAuthorization: true },
    });
  }

  await app.listen(config.app.port);

  const logger = new Logger('Bootstrap');
  logger.log(
    `🚀 ${config.app.name} listening on port ${config.app.port} [${config.app.env}] — API at /${config.app.apiPrefix}`,
  );
}

bootstrap().catch((error: unknown) => {
  console.error('❌ Fatal error during bootstrap:', error);
  process.exit(1);
});
