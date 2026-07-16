import { describe, expect, it } from 'vitest';
import { secrets } from '../../db/schema.js';
import { decodeCursor, encodeCursor, toPage } from '../pagination.js';
import { listNamedSecretsPage } from '../secrets.js';
import { freshDb } from './helpers.js';

describe('cursor codec', () => {
  it('round-trips a key through encode/decode', () => {
    const key = { createdAt: 1_700_000_000_123, id: 'sec_abc' };
    expect(decodeCursor(encodeCursor(key))).toEqual(key);
  });

  it('produces a URL-safe (base64url) string — no +, /, or =', () => {
    const cursor = encodeCursor({ createdAt: 999, id: 'x/y+z' });
    expect(cursor).not.toMatch(/[+/=]/);
  });

  it('returns null for a non-base64/JSON blob (→ 400 at the route)', () => {
    expect(decodeCursor('not-a-real-cursor!!!')).toBeNull();
  });

  it('returns null for a wrong-version payload rather than misreading it', () => {
    const stale = Buffer.from(JSON.stringify({ v: 999, c: 1, i: 'a' }), 'utf8').toString(
      'base64url',
    );
    expect(decodeCursor(stale)).toBeNull();
  });

  it('returns null for a well-formed base64url of the wrong shape', () => {
    const wrong = Buffer.from(JSON.stringify({ hello: 'world' }), 'utf8').toString('base64url');
    expect(decodeCursor(wrong)).toBeNull();
  });
});

describe('toPage', () => {
  const row = (createdAt: number, id: string) => ({ createdAt, id });

  it('is the last page (nextCursor null) when rows do not exceed the limit', () => {
    const page = toPage([row(1, 'a'), row(2, 'b')], 2);
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  it('drops the sentinel extra row and mints a cursor from the last KEPT row', () => {
    const page = toPage([row(1, 'a'), row(2, 'b'), row(3, 'c')], 2);
    expect(page.items.map((r) => r.id)).toEqual(['a', 'b']);
    expect(page.nextCursor).not.toBeNull();
    expect(decodeCursor(page.nextCursor!)).toEqual({ createdAt: 2, id: 'b' });
  });

  it('handles an empty result (empty items, null cursor)', () => {
    const page = toPage([], 10);
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});

describe('keyset over a created_at tie (the tuple-predicate case)', () => {
  it('paginates rows sharing one created_at deterministically by id — no gap, no overlap', () => {
    const { db } = freshDb();
    // Three rows, IDENTICAL createdAt, distinct ids in a known order. A naive
    // `id > i` or `created_at > c` predicate would drop or duplicate a row at
    // the page boundary; the tuple form must not.
    const rows = ['sec_a', 'sec_b', 'sec_c'].map((id, i) => ({
      id,
      ref: `ref-${id}`,
      ciphertext: `blob-${id}`,
      ownerId: 'local',
      name: `n-${i}`,
      createdAt: 1000,
    }));
    db.insert(secrets).values(rows).run();

    const collected: string[] = [];
    let cursor = undefined as ReturnType<typeof decodeCursor> | undefined;
    for (let page = 0; page < 10; page++) {
      const result = listNamedSecretsPage(db, 'local', { limit: 1, cursor: cursor ?? undefined });
      expect(result.items.length).toBeLessThanOrEqual(1);
      for (const s of result.items) collected.push(s.id);
      if (result.nextCursor === null) break;
      cursor = decodeCursor(result.nextCursor);
      expect(cursor).not.toBeNull();
    }
    // Tie broken by ascending id, every row exactly once.
    expect(collected).toEqual(['sec_a', 'sec_b', 'sec_c']);
  });
});
