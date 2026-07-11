import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import type { ApiSuccessResponse, CursorPaginationMeta } from '../types/api-response.types';
import type { RequestWithContext } from '../types/request-context.types';

/**
 * Marker shape a service/controller can return when it wants to attach
 * cursor-pagination metadata. Anything else returned from a handler is
 * treated as plain `data` and wrapped as-is.
 */
export interface Paginated<T> {
  items: T[];
  pagination: CursorPaginationMeta;
}

function isPaginated<T>(value: unknown): value is Paginated<T> {
  return typeof value === 'object' && value !== null && 'items' in value && 'pagination' in value;
}

@Injectable()
export class ResponseEnvelopeInterceptor<T> implements NestInterceptor<T, ApiSuccessResponse<T>> {
  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<ApiSuccessResponse<T>> {
    const request = context.switchToHttp().getRequest<RequestWithContext>();

    return next.handle().pipe(
      map((result) => {
        const paginated = isPaginated<T>(result);

        return {
          success: true,
          data: paginated ? (result as unknown as Paginated<T>).items : result,
          meta: {
            requestId: request.requestId,
            timestamp: new Date().toISOString(),
            ...(paginated ? { pagination: (result as unknown as Paginated<T>).pagination } : {}),
          },
        } as ApiSuccessResponse<T>;
      }),
    );
  }
}
