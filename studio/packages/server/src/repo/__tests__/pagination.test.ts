import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { connections, pipelines, secrets } from '../../db/schema.js';
import { listConnectionsPage } from '../connections.js';
import { beforeCursor, decodeCursor, encodeCursor, pageOrderDesc, toPage } from '../pagination.js';
import { listPipelinesPage } from '../pipelines.js';
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

describe('owner scope holds under a cross-owner cursor replay (the #534 security claim)', () => {
  // The cursor is an owner-AGNOSTIC position `(created_at, id)` — it carries no
  // identity. The owner scope comes solely from the `ownerId` ARGUMENT the
  // route stamps from `request.principal` (never the client). So a cursor
  // minted while listing owner A's rows, replayed against owner B's list, must
  // still return ONLY B's rows: the keyset only shifts WHERE in B's ordered set
  // the page resumes, never widens it to A's rows.
  //
  // Each case interleaves the two owners' `created_at` values (A: 1000, 3000;
  // B: 2000, 4000) and mints the cursor from A's EARLIEST row (1000). If the
  // owner filter were ever dropped, A's later row (3000) would surface BETWEEN
  // B's two rows — so its absence is a positive proof the filter is applied on
  // every page, not just the first.

  it('secrets: A-minted cursor replayed under B yields only B rows', () => {
    const { db } = freshDb();
    const rows = [
      { owner: 'alice', id: 'sec_a1', createdAt: 1000 },
      { owner: 'bob', id: 'sec_b2', createdAt: 2000 },
      { owner: 'alice', id: 'sec_a3', createdAt: 3000 },
      { owner: 'bob', id: 'sec_b4', createdAt: 4000 },
    ].map((r) => ({
      id: r.id,
      ref: `ref-${r.id}`,
      ciphertext: `blob-${r.id}`,
      ownerId: r.owner,
      name: `n-${r.id}`,
      createdAt: r.createdAt,
    }));
    db.insert(secrets).values(rows).run();

    const aCursor = decodeCursor(encodeCursor({ createdAt: 1000, id: 'sec_a1' }));
    expect(aCursor).not.toBeNull();
    const page = listNamedSecretsPage(db, 'bob', { limit: 10, cursor: aCursor ?? undefined });

    expect(page.items.map((r) => r.id)).toEqual(['sec_b2', 'sec_b4']);
    // Alice's row that sorts BETWEEN bob's rows never leaks in.
    expect(page.items.some((r) => r.ownerId === 'alice')).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('connections: A-minted cursor replayed under B yields only B rows', () => {
    const { db } = freshDb();
    const rows = [
      { owner: 'alice', id: 'conn_a1', createdAt: 1000 },
      { owner: 'bob', id: 'conn_b2', createdAt: 2000 },
      { owner: 'alice', id: 'conn_a3', createdAt: 3000 },
      { owner: 'bob', id: 'conn_b4', createdAt: 4000 },
    ].map((r) => ({
      id: r.id,
      resourceId: `res_${r.id}`,
      ownerId: r.owner,
      name: `n-${r.id}`,
      kind: 'http' as const,
      config: {},
      secretRef: null,
      // #3 G8a — `secret_status` has no DB DEFAULT (derived per row); a raw
      // insert must set it or the read-parse fails. `enabled` DB-defaults true.
      secretStatus: 'not_required' as const,
      createdAt: r.createdAt,
      updatedAt: r.createdAt,
    }));
    db.insert(connections).values(rows).run();

    const aCursor = decodeCursor(encodeCursor({ createdAt: 1000, id: 'conn_a1' }));
    expect(aCursor).not.toBeNull();
    const page = listConnectionsPage(db, 'bob', { limit: 10, cursor: aCursor ?? undefined });

    expect(page.items.map((r) => r.id)).toEqual(['conn_b2', 'conn_b4']);
    expect(page.items.some((r) => r.ownerId === 'alice')).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('pipelines: A-minted cursor replayed under B yields only B rows', () => {
    const { db } = freshDb();
    const rows = [
      { owner: 'alice', id: 'pipe_a1', createdAt: 1000 },
      { owner: 'bob', id: 'pipe_b2', createdAt: 2000 },
      { owner: 'alice', id: 'pipe_a3', createdAt: 3000 },
      { owner: 'bob', id: 'pipe_b4', createdAt: 4000 },
    ].map((r) => ({
      id: r.id,
      resourceId: `res_${r.id}`,
      ownerId: r.owner,
      name: `n-${r.id}`,
      createdAt: r.createdAt,
      updatedAt: r.createdAt,
    }));
    db.insert(pipelines).values(rows).run();

    const aCursor = decodeCursor(encodeCursor({ createdAt: 1000, id: 'pipe_a1' }));
    expect(aCursor).not.toBeNull();
    const page = listPipelinesPage(db, 'bob', { limit: 10, cursor: aCursor ?? undefined });

    expect(page.items.map((r) => r.id)).toEqual(['pipe_b2', 'pipe_b4']);
    expect(page.items.some((r) => r.ownerId === 'alice')).toBe(false);
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

/**
 * #1076 — the DESC pair. Driven directly against `secrets` rather than through a
 * repo wrapper, because the only descending CONSUMER today is the workspace
 * audit log, whose ordering scalar (`seq`) is unique per owner and therefore
 * cannot produce the tie this predicate exists to survive. Testing the helper
 * where a tie is reachable is what makes the tuple form provable rather than
 * merely asserted in its docblock.
 */
describe('beforeCursor + pageOrderDesc (#1076 — the descending pair)', () => {
  /** One descending page of `secrets`, built the way a repo wrapper builds it. */
  function descPage(
    db: ReturnType<typeof freshDb>['db'],
    cursor: ReturnType<typeof decodeCursor> | undefined,
    limit: number,
  ) {
    return db
      .select()
      .from(secrets)
      .where(
        and(
          eq(secrets.ownerId, 'local'),
          cursor ? beforeCursor(secrets.createdAt, secrets.id, cursor) : undefined,
        ),
      )
      .orderBy(...pageOrderDesc(secrets.createdAt, secrets.id))
      .limit(limit)
      .all();
  }

  it('walks a created_at tie backwards by id — no gap, no overlap', () => {
    const { db } = freshDb();
    const rows = ['sec_a', 'sec_b', 'sec_c'].map((id, i) => ({
      id,
      ref: `ref-${id}`,
      ciphertext: `blob-${id}`,
      ownerId: 'local',
      name: `n-${i}`,
      createdAt: 1000,
    }));
    db.insert(secrets).values(rows).run();

    // One row at a time, resuming from the cursor each page: the boundary is
    // crossed twice, which is where a naive `id < i` or `created_at < c`
    // predicate drops or duplicates a row.
    const collected: string[] = [];
    let cursor: ReturnType<typeof decodeCursor> | undefined;
    for (let page = 0; page < 10; page++) {
      const items = descPage(db, cursor, 1);
      if (items.length === 0) break;
      for (const s of items) collected.push(s.id);
      const last = items[items.length - 1]!;
      cursor = { createdAt: last.createdAt, id: last.id };
    }

    expect(collected).toEqual(['sec_c', 'sec_b', 'sec_a']);
  });

  it('orders by the scalar first and only then by id — a newer row wins a lower id', () => {
    const { db } = freshDb();
    // `sec_a` sorts FIRST by id but LAST by created_at. A `pageOrderDesc` that
    // put the id tie-break first (or kept either column ascending) would put it
    // somewhere other than the end.
    db.insert(secrets)
      .values([
        { id: 'sec_a', ref: 'r1', ciphertext: 'b1', ownerId: 'local', name: 'a', createdAt: 100 },
        { id: 'sec_z', ref: 'r2', ciphertext: 'b2', ownerId: 'local', name: 'z', createdAt: 200 },
      ])
      .run();

    expect(descPage(db, undefined, 10).map((s) => s.id)).toEqual(['sec_z', 'sec_a']);
  });
});
