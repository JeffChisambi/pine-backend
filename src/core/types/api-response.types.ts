/**
 * Every `/v1` response — success or failure — is wrapped in one of these
 * two envelopes so the mobile client can rely on a single, predictable
 * shape rather than branching per-endpoint.
 */
export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
  meta: ResponseMeta;
}

export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  meta: ResponseMeta;
}

export interface ResponseMeta {
  requestId: string;
  timestamp: string;
  pagination?: CursorPaginationMeta;
}

export interface CursorPaginationMeta {
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;
