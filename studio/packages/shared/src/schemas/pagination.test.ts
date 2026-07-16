import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  PaginationQuerySchema,
  paginatedResponseSchema,
} from './pagination.js';

describe('PaginationQuerySchema', () => {
  it('defaults limit to DEFAULT_PAGE_SIZE when absent', () => {
    const parsed = PaginationQuerySchema.parse({});
    expect(parsed.limit).toBe(DEFAULT_PAGE_SIZE);
    expect(parsed.cursor).toBeUndefined();
  });

  it('coerces a numeric-string limit from the query string', () => {
    expect(PaginationQuerySchema.parse({ limit: '25' }).limit).toBe(25);
  });

  it('rejects a limit below 1', () => {
    expect(() => PaginationQuerySchema.parse({ limit: '0' })).toThrow();
  });

  it('rejects a limit above MAX_PAGE_SIZE (no silent clamp)', () => {
    expect(() => PaginationQuerySchema.parse({ limit: String(MAX_PAGE_SIZE + 1) })).toThrow();
    expect(PaginationQuerySchema.parse({ limit: String(MAX_PAGE_SIZE) }).limit).toBe(MAX_PAGE_SIZE);
  });

  it('rejects a non-numeric limit', () => {
    expect(() => PaginationQuerySchema.parse({ limit: 'abc' })).toThrow();
  });

  it('rejects a fractional limit', () => {
    expect(() => PaginationQuerySchema.parse({ limit: '2.5' })).toThrow();
  });

  it('carries a cursor string through, and rejects an empty one', () => {
    expect(PaginationQuerySchema.parse({ cursor: 'abc' }).cursor).toBe('abc');
    expect(() => PaginationQuerySchema.parse({ cursor: '' })).toThrow();
  });

  it('ignores unknown query keys (not strict)', () => {
    expect(() => PaginationQuerySchema.parse({ limit: '10', _: '1' })).not.toThrow();
  });
});

describe('paginatedResponseSchema', () => {
  const Schema = paginatedResponseSchema(z.object({ id: z.string() }));

  it('accepts an items array with a string nextCursor', () => {
    const parsed = Schema.parse({ items: [{ id: 'a' }], nextCursor: 'c' });
    expect(parsed.items).toEqual([{ id: 'a' }]);
    expect(parsed.nextCursor).toBe('c');
  });

  it('accepts a null nextCursor (last page)', () => {
    expect(Schema.parse({ items: [], nextCursor: null }).nextCursor).toBeNull();
  });

  it('rejects a missing nextCursor (must be explicit)', () => {
    expect(() => Schema.parse({ items: [] })).toThrow();
  });

  it('rejects a malformed item', () => {
    expect(() => Schema.parse({ items: [{ id: 1 }], nextCursor: null })).toThrow();
  });
});
