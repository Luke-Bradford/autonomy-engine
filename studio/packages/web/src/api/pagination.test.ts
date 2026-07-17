import { describe, expect, it, vi } from 'vitest';
import type { Paginated } from '@autonomy-studio/shared';
import { fetchAllPages, pageQuery } from './pagination';

describe('fetchAllPages', () => {
  it('follows nextCursor across pages and concatenates items in order', async () => {
    const pages: Record<string, Paginated<number>> = {
      first: { items: [1, 2], nextCursor: 'c1' },
      c1: { items: [3, 4], nextCursor: 'c2' },
      c2: { items: [5], nextCursor: null },
    };
    const fetchPage = vi.fn((cursor: string | undefined) =>
      Promise.resolve(pages[cursor ?? 'first']!),
    );

    const all = await fetchAllPages(fetchPage);
    expect(all).toEqual([1, 2, 3, 4, 5]);
    // First call has no cursor; subsequent calls follow the chain.
    expect(fetchPage.mock.calls.map((c) => c[0])).toEqual([undefined, 'c1', 'c2']);
  });

  it('stops after a single page when nextCursor is null', async () => {
    const fetchPage = vi.fn(() => Promise.resolve({ items: ['x'], nextCursor: null }));
    expect(await fetchAllPages(fetchPage)).toEqual(['x']);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('throws rather than loops forever on a non-advancing (repeated) cursor', async () => {
    // A buggy server that keeps handing back the same cursor must surface as an
    // error, never an infinite fetch loop.
    const fetchPage = vi.fn(() => Promise.resolve({ items: [0], nextCursor: 'stuck' }));
    await expect(fetchAllPages(fetchPage)).rejects.toThrow(/did not advance/);
  });
});

describe('pageQuery', () => {
  it('requests the max page size with no cursor on the first page', () => {
    expect(pageQuery(undefined)).toBe('?limit=100');
  });

  it('URL-encodes an opaque cursor', () => {
    // A base64url cursor is +/=-free, but the helper must still encode safely.
    expect(pageQuery('a b/c')).toBe('?limit=100&cursor=a+b%2Fc');
  });
});
