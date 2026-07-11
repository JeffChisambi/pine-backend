import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { ValidationException } from '../../src/core/exceptions/app.exception';

/**
 * Boots the real `AppModule` (not a trimmed-down test module) so e2e
 * tests exercise the actual global pipes/filters/interceptors/guards
 * exactly as they run in production — the whole point of an e2e test
 * over an integration test.
 */
export async function createTestApp(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });

  app.setGlobalPrefix('v1');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: (errors) =>
        new ValidationException(
          'Validation failed',
          errors.map((e) => ({ field: e.property, constraints: e.constraints })),
        ),
    }),
  );

  await app.init();
  return app;
}
