import { describe, expect, it } from 'vitest';
import { buildPage, decodeCursor, encodeCursor, parsePageRequest } from './cursor-pagination';
import { ValidationException } from '../../core/exceptions/app.exception';

describe('cursor-pagination', () => {
  describe('encodeCursor / decodeCursor', () => {
    it('round-trips an id and sort value', () => {
      const cursor = encodeCursor('abc-123', '2026-01-01T00:00:00.000Z');
      const decoded = decodeCursor(cursor);
      expect(decoded).toEqual({ id: 'abc-123', sortValue: '2026-01-01T00:00:00.000Z' });
    });

    it('accepts a Date and serializes it to ISO', () => {
      const date = new Date('2026-06-15T12:00:00.000Z');
      const cursor = encodeCursor('xyz', date);
      expect(decodeCursor(cursor).sortValue).toBe(date.toISOString());
    });

    it('rejects a malformed cursor', () => {
      expect(() => decodeCursor('not-base64-json')).toThrow(ValidationException);
    });
  });

  describe('parsePageRequest', () => {
    it('defaults to limit 20 when not provided', () => {
      expect(parsePageRequest({})).toEqual({ cursor: undefined, limit: 20 });
    });

    it('rejects a limit above the maximum', () => {
      expect(() => parsePageRequest({ limit: '500' })).toThrow(ValidationException);
    });

    it('rejects a non-integer limit', () => {
      expect(() => parsePageRequest({ limit: '10.5' })).toThrow(ValidationException);
    });
  });

  describe('buildPage', () => {
    interface Row {
      id: string;
      createdAt: string;
    }

    it('reports hasMore=false and no cursor when exactly `limit` rows are returned', () => {
      const rows: Row[] = [{ id: '1', createdAt: '2026-01-01' }];
      const page = buildPage(rows, 1, (r) => r.createdAt);
      expect(page.pagination.hasMore).toBe(false);
      expect(page.pagination.nextCursor).toBeNull();
      expect(page.items).toHaveLength(1);
    });

    it('trims the extra row and reports hasMore=true when limit+1 rows are returned', () => {
      const rows: Row[] = [
        { id: '1', createdAt: '2026-01-01' },
        { id: '2', createdAt: '2026-01-02' },
      ];
      const page = buildPage(rows, 1, (r) => r.createdAt);
      expect(page.items).toHaveLength(1);
      expect(page.pagination.hasMore).toBe(true);
      expect(page.pagination.nextCursor).not.toBeNull();
    });
  });
});
