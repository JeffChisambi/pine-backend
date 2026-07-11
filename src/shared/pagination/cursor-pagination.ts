import { ValidationException } from '../../core/exceptions/app.exception';

/**
 * Cursor (keyset) pagination, not offset (`?page=`/`?skip=`) pagination.
 * At financial-app scale, `OFFSET 500000` degrades badly and — worse —
 * is unstable under concurrent inserts (a page can silently skip or
 * repeat rows as new transactions land). A cursor encodes the last seen
 * row's sort key and is stable regardless of what's inserted around it.
 */
export interface CursorPageRequest {
  cursor?: string;
  limit: number;
}

export interface DecodedCursor {
  id: string;
  sortValue: string;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export function parsePageRequest(query: {
  cursor?: string;
  limit?: string | number;
}): CursorPageRequest {
  const limit = query.limit ? Number(query.limit) : DEFAULT_LIMIT;

  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new ValidationException(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }

  return { cursor: query.cursor, limit };
}

export function encodeCursor(id: string, sortValue: string | Date): string {
  const raw = JSON.stringify({
    id,
    sortValue: sortValue instanceof Date ? sortValue.toISOString() : sortValue,
  });
  return Buffer.from(raw, 'utf-8').toString('base64url');
}

export function decodeCursor(cursor: string): DecodedCursor {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf-8');
    const parsed = JSON.parse(raw) as Partial<DecodedCursor>;

    if (!parsed.id || !parsed.sortValue) {
      throw new Error('missing fields');
    }

    return { id: parsed.id, sortValue: parsed.sortValue };
  } catch {
    throw new ValidationException('Invalid pagination cursor');
  }
}

/**
 * Given `limit + 1` rows fetched from the DB (the "fetch one extra" trick),
 * trims to `limit` and reports whether more pages exist — avoiding a
 * separate `COUNT(*)` query per page.
 */
export function buildPage<T extends { id: string }>(
  rows: T[],
  limit: number,
  sortValueOf: (row: T) => string | Date,
): { items: T[]; pagination: { nextCursor: string | null; hasMore: boolean; limit: number } } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];

  return {
    items,
    pagination: {
      nextCursor: hasMore && last ? encodeCursor(last.id, sortValueOf(last)) : null,
      hasMore,
      limit,
    },
  };
}
