import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectionKind, InlineDataset } from '@autonomy-studio/shared';
import { sqliteAdapter } from '../../connectors/sqlite.js';
import type { ConnectorRegistry } from '../../connectors/registry.js';
import type { ActivityEvent, ConnectorAdapter } from '../../connectors/types.js';
import { cleanupTempRoots, seedDb, tempRoot } from '../../connectors/__tests__/sqlite-fixtures.js';
import { PREVIEW_CONCURRENCY, PREVIEW_ROW_CAP } from '../../limits.js';
import { previewInlineSource } from '../preview.js';

/**
 * #1600 C1q-c — Preview reads through the store adapter's own Lookup arm, so
 * these run the REAL sqlite adapter against real database files.
 */
afterEach(cleanupTempRoots);

const registry: ConnectorRegistry = new Map([['sqlite' as ConnectionKind, sqliteAdapter]]);

function sqliteDb(rows: number) {
  const root = tempRoot('preview-');
  const path = seedDb(root, rows);
  return {
    path,
    connection: { kind: 'sqlite' as ConnectionKind, config: { roots: [root], path } },
  };
}

const table = (name = 't'): InlineDataset => ({ kind: 'table', config: { table: name } });
const query = (sql: string, parameters?: Record<string, unknown>): InlineDataset => ({
  kind: 'query',
  config: parameters === undefined ? { sql } : { sql, parameters },
});

describe('previewInlineSource', () => {
  it('reads a table’s rows through the run’s Lookup read', async () => {
    const { connection } = sqliteDb(3);
    const result = await previewInlineSource({
      registry,
      connection,
      secret: null,
      inline: table(),
    });
    expect(result).toEqual({
      ok: true,
      rows: [
        { id: 1, name: 'row-1' },
        { id: 2, name: 'row-2' },
        { id: 3, name: 'row-3' },
      ],
      truncated: false,
    });
  });

  it('binds a query’s :name values', async () => {
    const { connection } = sqliteDb(5);
    const result = await previewInlineSource({
      registry,
      connection,
      secret: null,
      inline: query('SELECT id FROM t WHERE id > :wm ORDER BY id', { wm: 3 }),
    });
    expect(result).toEqual({ ok: true, rows: [{ id: 4 }, { id: 5 }], truncated: false });
  });

  it(`keeps the first ${PREVIEW_ROW_CAP} rows and says the rest exist`, async () => {
    const { connection } = sqliteDb(PREVIEW_ROW_CAP + 50);
    const result = await previewInlineSource({
      registry,
      connection,
      secret: null,
      inline: table(),
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.rows).toHaveLength(PREVIEW_ROW_CAP);
    expect(result.rows[0]).toEqual({ id: 1, name: 'row-1' });
    expect(result.truncated).toBe(true);
    expect(result.note).toBeUndefined();
  });

  it('says why no rows are shown when the first row alone is over the byte limit', async () => {
    const { path, connection } = sqliteDb(0);
    const db = new Database(path);
    db.prepare('INSERT INTO t (id, name) VALUES (1, ?)').run('x'.repeat(2 * 1024 * 1024));
    db.close();
    const result = await previewInlineSource({
      registry,
      connection,
      secret: null,
      inline: table(),
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.rows).toEqual([]);
    expect(result.truncated).toBe(true);
    expect(result.note).toMatch(/^The first row alone is larger than/);
  });

  it('answers a store error as a refusal, not a throw', async () => {
    const { connection } = sqliteDb(1);
    const result = await previewInlineSource({
      registry,
      connection,
      secret: null,
      inline: query('SELECT nope FROM t'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/nope/);
  });

  // The read is the run's read-only one; a statement that would write is refused
  // by the store and the table is unchanged.
  it('cannot write: a DELETE is refused and every row is still there', async () => {
    const { path, connection } = sqliteDb(2);
    const result = await previewInlineSource({
      registry,
      connection,
      secret: null,
      inline: query('DELETE FROM t RETURNING id'),
    });
    expect(result.ok).toBe(false);
    const db = new Database(path, { readonly: true });
    expect(db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 2 });
    db.close();
  });

  it('applies save’s literal-SQL rule, so a source that cannot be saved shows no rows', async () => {
    const { connection } = sqliteDb(1);
    const result = await previewInlineSource({
      registry,
      connection,
      secret: null,
      inline: query("SELECT * FROM t WHERE name = '${x}'"),
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/stays literal/) });
  });

  it('applies the run’s checks: a secret marker, a bad config and the wrong store are refused', async () => {
    const { connection } = sqliteDb(1);
    const marker = await previewInlineSource({
      registry,
      connection,
      secret: null,
      inline: query('SELECT * FROM t WHERE id = :k', { k: { $secret: 'k' } }),
    });
    expect(marker).toMatchObject({ ok: false, error: expect.stringMatching(/secret marker/) });

    const stray = await previewInlineSource({
      registry,
      connection,
      secret: null,
      inline: { kind: 'table', config: { table: 't', where: 'id = 1' } },
    });
    expect(stray).toMatchObject({ ok: false, error: expect.stringMatching(/not valid/) });

    const fs = await previewInlineSource({
      registry,
      connection: { kind: 'fs', config: { roots: ['/tmp'] } },
      secret: null,
      inline: table(),
    });
    expect(fs).toMatchObject({ ok: false, error: expect.stringMatching(/^the inline source's/) });
  });

  it('does not read for a caller that has already gone', async () => {
    const { connection } = sqliteDb(1);
    const gone = new AbortController();
    gone.abort();
    const result = await previewInlineSource({
      registry,
      connection,
      secret: null,
      inline: table(),
      signal: gone.signal,
    });
    expect(result).toEqual({ ok: false, error: 'the preview was cancelled' });
  });

  // Probe's split: a slot is held until the REAL read settles, so a hung store
  // queues the next caller rather than letting reads pile up uncounted; a
  // caller answered while queued is never read for.
  it(`holds ${PREVIEW_CONCURRENCY} slots until their reads settle, and never reads for a caller answered while queued`, async () => {
    let started = 0;
    const releases: (() => void)[] = [];
    const hung: ConnectorAdapter = {
      ...sqliteAdapter,
      async *runActivity(): AsyncIterable<ActivityEvent> {
        started += 1;
        await new Promise<void>((resolve) => releases.push(resolve));
        yield { type: 'succeeded', outputs: { rows: [], truncated: false } };
      },
    };
    const hungRegistry: ConnectorRegistry = new Map([['sqlite' as ConnectionKind, hung]]);
    const { connection } = sqliteDb(0);
    const preview = (backstopMs: number) =>
      previewInlineSource({
        registry: hungRegistry,
        connection,
        secret: null,
        inline: table(),
        backstopMs,
      });

    const held = Array.from({ length: PREVIEW_CONCURRENCY }, () => preview(20));
    const answered = await Promise.all(held);
    for (const r of answered)
      expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/did not finish/) });
    expect(started).toBe(PREVIEW_CONCURRENCY);

    // Every slot is still held by a hung read, so this caller is answered by
    // its backstop while queued.
    const queued = await preview(20);
    expect(queued).toMatchObject({ ok: false, error: expect.stringMatching(/did not finish/) });

    for (const release of releases) release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The queued caller reached a free slot after it had its answer, and read nothing.
    expect(started).toBe(PREVIEW_CONCURRENCY);
  });
});
