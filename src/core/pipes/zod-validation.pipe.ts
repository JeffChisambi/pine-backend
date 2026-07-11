import { PipeTransform } from '@nestjs/common';
import type { ZodSchema } from 'zod';
import { ValidationException } from '../exceptions/app.exception';

/**
 * class-validator DTOs (validated by the global `ValidationPipe` in
 * `main.ts`) are the default for request bodies. This pipe covers the
 * remaining cases where a Zod schema is a better fit — e.g. validating
 * a third-party webhook payload (PayChangu) whose shape we don't
 * control with decorators, or a loosely-typed query/CSV-import row.
 *
 * @example
 * @Post('webhooks/paychangu')
 * handle(@Body(new ZodValidationPipe(paychanguWebhookSchema)) body: PaychanguWebhookDto) { ... }
 */
export class ZodValidationPipe<T> implements PipeTransform {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      throw new ValidationException(
        'Validation failed',
        result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      );
    }

    return result.data;
  }
}
