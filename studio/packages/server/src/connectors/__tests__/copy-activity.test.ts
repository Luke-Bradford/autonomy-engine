import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { COPY_ACTIVITY_TYPE, type DatasetColumn } from '@autonomy-studio/shared';
import { runCopyActivity } from '../copy.js';
import { DatasetIoError } from '../dataset-io-error.js';
import { sqliteAdapter } from '../sqlite.js';
import type { ActivityContext, ActivityEvent } from '../types.js';
import {
  cleanupTempRoots,
  rowsOf,
  seedDb,
  seedSink,
  tempRoot,
  writableConfig,
} from './sqlite-fixtures.js';

/**
 * #996 M5 slice 4b (#1134) — the `copy` ACTIVITY, at the adapter boundary.
 *
 * `copy-pipeline.test.ts` already proves the data path — reader → pump → sink
 * over real database files — so this suite deliberately does not re-assert it.
 * What is only true at THIS layer is the contract the executor depends on:
 * exactly one terminal event, the five declared outputs on it, each rung of the
 * refusal ladder, and that a failure still reports how far the copy got.
 *
 * `copy` has no catalog entry yet (that ships in 4c with the canvas pickers), so
 * these call the adapter directly — which is what the executor does once an
 * entry exists, with a `ctx` the dispatch seam built.
 */

afterEach(cleanupTempRoots);

const columns = (...names: [string, boolean][]): DatasetColumn[] =>
  names.map(([name, nullable]) => ({ name, type: 'string', nullable }));

function copyCtx(over: {
  sourcePath: string;
  sinkPath: string;
  root: string;
  input?: unknown;
  sinkColumns?: DatasetColumn[];
  sinkKind?: string;
  datasets?: unknown;
  sink?: unknown;
}): ActivityContext {
  const store = writableConfig(over.root, over.sourcePath);
  return {
    runId: 'run-1',
    nodeId: 'n1',
    attemptId: 'a1',
    activityType: COPY_ACTIVITY_TYPE,
    input: over.input ?? {
      mapping: [
        { source: 'id', sink: 'id', type: 'integer' },
        { source: 'name', sink: 'name', type: 'string' },
      ],
    },
    connectionConfig: store,
    ...(over.sink === null
      ? {}
      : {
          sink: over.sink ?? {
            kind: over.sinkKind ?? 'sqlite',
            connectionConfig: writableConfig(over.root, over.sinkPath),
          },
        }),
    ...(over.datasets === null
      ? {}
      : {
          datasets: over.datasets ?? {
            source: { id: 'ds-1', name: 'src', kind: 'table', config: { table: 't' }, columns: [] },
            sink: {
              id: 'ds-2',
              name: 'dst',
              kind: 'table',
              config: { table: 'sink' },
              columns: over.sinkColumns ?? [],
            },
          },
        }),
    signal: new AbortController().signal,
  } as unknown as ActivityContext;
}

async function run(ctx: ActivityContext): Promise<ActivityEvent[]> {
  const events: ActivityEvent[] = [];
  for await (const event of sqliteAdapter.runActivity(ctx, null)) events.push(event);
  return events;
}

const terminal = (events: ActivityEvent[]): ActivityEvent =>
  events[events.length - 1] as ActivityEvent;

describe('copy activity — the happy path contract', () => {
  it('yields ONE terminal event carrying the five declared outputs', async () => {
    const root = tempRoot();
    const events = await run(
      copyCtx({ root, sourcePath: seedDb(root, 3, 'src.db'), sinkPath: seedSink(root, 'dst.db') }),
    );

    // Exactly one terminal: the executor folds the FIRST it sees, so a second
    // would be silently discarded state.
    expect(events.filter((e) => e.type === 'succeeded' || e.type === 'failed')).toHaveLength(1);
    const end = terminal(events);
    expect(end.type).toBe('succeeded');
    expect(end.type === 'succeeded' ? end.outputs : null).toEqual({
      rowsRead: 3,
      rowsWritten: 3,
      rowsFailed: 0,
      bytesRead: expect.any(Number),
      truncated: false,
    });
  });

  it('actually moves the rows, into the SINK store and not the source', async () => {
    const root = tempRoot();
    const sinkPath = seedSink(root, 'dst.db');
    await run(copyCtx({ root, sourcePath: seedDb(root, 2, 'src.db'), sinkPath }));
    expect(rowsOf(sinkPath)).toEqual([
      { id: 1, name: 'row-1', flag: null, big: null, payload: null, note: null },
      { id: 2, name: 'row-2', flag: null, big: null, payload: null, note: null },
    ]);
  });

  it('reports dropped rows as an ADVISORY with the bounded tally, and still succeeds', async () => {
    const root = tempRoot();
    const events = await run(
      copyCtx({
        root,
        sourcePath: seedDb(root, 2, 'src.db'),
        sinkPath: seedSink(root, 'dst.db'),
        // `name` holds 'row-1'/'row-2', which cannot become an integer.
        input: {
          mapping: [
            { source: 'id', sink: 'id', type: 'integer' },
            { source: 'name', sink: 'flag', type: 'integer' },
          ],
        },
      }),
    );

    const end = terminal(events);
    expect(end.type).toBe('succeeded');
    expect(end.type === 'succeeded' ? end.outputs.rowsFailed : null).toBe(2);
    const warning = events.find((e) => e.type === 'warned');
    expect(warning?.type === 'warned' ? warning.code : null).toBe('copy_rows_failed');
    // The tally is the point: `rowsFailed: 2` alone tells an operator nothing.
    expect(warning?.type === 'warned' ? warning.reason : '').toMatch(/2 not_a_number/);
  });
});

describe('copy activity — the refusal ladder', () => {
  it('refuses a missing dataset END rather than copying half a pair', async () => {
    const root = tempRoot();
    const end = terminal(
      await run(
        copyCtx({
          root,
          sourcePath: seedDb(root, 1, 'src.db'),
          sinkPath: seedSink(root, 'dst.db'),
          datasets: {
            source: { id: 'ds-1', name: 'src', kind: 'table', config: { table: 't' }, columns: [] },
          },
        }),
      ),
    );
    expect(end).toEqual({
      type: 'failed',
      kind: 'permanent',
      error: expect.stringContaining('both a source and a sink dataset'),
    });
  });

  it('refuses a missing sink CONNECTION — the store it writes into', async () => {
    const root = tempRoot();
    const end = terminal(
      await run(
        copyCtx({
          root,
          sourcePath: seedDb(root, 1, 'src.db'),
          sinkPath: seedSink(root, 'dst.db'),
          sink: null,
        }),
      ),
    );
    expect(end).toMatchObject({
      kind: 'permanent',
      error: expect.stringContaining('sink connection'),
    });
  });

  it('refuses a NON-sqlite sink by naming the kind, not the config', async () => {
    const root = tempRoot();
    const end = terminal(
      await run(
        copyCtx({
          root,
          sourcePath: seedDb(root, 1, 'src.db'),
          sinkPath: seedSink(root, 'dst.db'),
          sink: { kind: 'fs', connectionConfig: { roots: [root] } },
        }),
      ),
    );
    // The diagnosis matters: without this rung the fs config reaches the writer
    // and is refused as "invalid sqlite connection config" — true, and useless.
    expect(end).toMatchObject({
      kind: 'permanent',
      error: expect.stringContaining("sink connection is 'fs'"),
    });
  });

  it('reports the FIRST failed rung: a missing dataset end outranks a foreign sink kind', async () => {
    const root = tempRoot();
    const end = terminal(
      await run(
        copyCtx({
          root,
          sourcePath: seedDb(root, 1, 'src.db'),
          sinkPath: seedSink(root, 'dst.db'),
          datasets: null,
          sink: { kind: 'fs', connectionConfig: { roots: [root] } },
        }),
      ),
    );
    // Both rungs fail here. The ladder's order is what decides which the
    // operator is told about, so it has to be the ladder's — a store-specific
    // guard sitting ahead of the dispatch would answer the second question
    // while the first went unmentioned.
    expect(end).toMatchObject({
      kind: 'permanent',
      error: expect.stringContaining('both a source and a sink dataset'),
    });
  });

  it('refuses a malformed config rather than dispatching a partial mapping', async () => {
    const root = tempRoot();
    const end = terminal(
      await run(
        copyCtx({
          root,
          sourcePath: seedDb(root, 1, 'src.db'),
          sinkPath: seedSink(root, 'dst.db'),
          input: { mapping: [{ source: 'id', expression: 'x', sink: 'id', type: 'integer' }] },
        }),
      ),
    );
    expect(end).toMatchObject({
      kind: 'permanent',
      error: expect.stringContaining('invalid copy activity config'),
    });
  });

  it("refuses onError:'null' against a NOT NULL sink column, before opening a store", async () => {
    const root = tempRoot();
    const sinkPath = seedSink(root, 'dst.db');
    const end = terminal(
      await run(
        copyCtx({
          root,
          sourcePath: seedDb(root, 2, 'src.db'),
          sinkPath,
          sinkColumns: columns(['id', true], ['name', false]),
          input: {
            mapping: [
              { source: 'id', sink: 'id', type: 'integer' },
              { source: 'name', sink: 'name', type: 'string', onError: 'null' },
            ],
          },
        }),
      ),
    );
    expect(end).toMatchObject({
      kind: 'permanent',
      error: expect.stringContaining('NOT NULL'),
    });
    // "Before opening a store" is the property, not just the refusal: a
    // constraint violation raised mid-transaction would already have written.
    expect(rowsOf(sinkPath)).toEqual([]);
  });

  it("allows onError:'null' where the sink column is NULLABLE", async () => {
    const root = tempRoot();
    const end = terminal(
      await run(
        copyCtx({
          root,
          sourcePath: seedDb(root, 1, 'src.db'),
          sinkPath: seedSink(root, 'dst.db'),
          sinkColumns: columns(['id', true], ['flag', true]),
          input: {
            mapping: [
              { source: 'id', sink: 'id', type: 'integer' },
              { source: 'name', sink: 'flag', type: 'integer', onError: 'null' },
            ],
          },
        }),
      ),
    );
    expect(end.type).toBe('succeeded');
  });

  it('ignores an UNDECLARED sink column — column existence is the drift gate, not this rule', async () => {
    const root = tempRoot();
    const end = terminal(
      await run(
        copyCtx({
          root,
          sourcePath: seedDb(root, 1, 'src.db'),
          sinkPath: seedSink(root, 'dst.db'),
          // 'flag' is not in the DECLARED set, so the NOT NULL rule has nothing
          // to say about it; whether it exists in the store is §7's business.
          sinkColumns: columns(['id', true]),
          input: {
            mapping: [
              { source: 'id', sink: 'id', type: 'integer' },
              { source: 'name', sink: 'flag', type: 'integer', onError: 'null' },
            ],
          },
        }),
      ),
    );
    expect(end.type).toBe('succeeded');
  });

  it('surfaces the BOUNDED mapping code, which the sink wrapping would otherwise bury', async () => {
    const root = tempRoot();
    const end = terminal(
      await run(
        copyCtx({
          root,
          sourcePath: seedDb(root, 2, 'src.db'),
          sinkPath: seedSink(root, 'dst.db'),
          input: { mapping: [{ source: 'nosuch', sink: 'id', type: 'integer' }] },
        }),
      ),
    );
    // The pump throws INSIDE the sink's transaction, so the sink wraps it as a
    // DatasetIoError and keeps the original on `.cause`. Reading only the outer
    // error loses the one word that tells an author what to fix.
    expect(end).toMatchObject({
      kind: 'permanent',
      error: expect.stringContaining('missing_source_column'),
    });
  });
});

describe('copy activity — a failure is never a silent partial (§10)', () => {
  it('reports the counters as outputs BEFORE the terminal, because node.failed carries none', async () => {
    const root = tempRoot();
    const events = await run(
      copyCtx({
        root,
        sourcePath: seedDb(root, 2, 'src.db'),
        sinkPath: seedSink(root, 'dst.db'),
        // A SINK column that does not exist, so the failure lands inside the
        // write — M6's source-side gate (below) now refuses a missing SOURCE
        // column BEFORE any of this, which is the point of the milestone but
        // makes it the wrong way to provoke a mid-copy failure.
        input: { mapping: [{ source: 'id', sink: 'nosuch', type: 'integer' }] },
      }),
    );

    const outputs = events.filter((e) => e.type === 'output');
    expect(outputs.map((e) => (e.type === 'output' ? e.name : ''))).toEqual([
      'rowsRead',
      'rowsWritten',
      'rowsFailed',
      'bytesRead',
      'truncated',
    ]);
    expect(events.indexOf(outputs[0] as ActivityEvent)).toBeLessThan(
      events.indexOf(terminal(events)),
    );
    expect(terminal(events).type).toBe('failed');
  });
});

describe('copy activity — a tick is progress, not committed truth', () => {
  /** A source whose LAST batch violates a NOT NULL on the sink. */
  function seedLateFailure(root: string): { sourcePath: string; sinkPath: string } {
    const sourcePath = join(root, 'late-src.db');
    const src = new Database(sourcePath);
    src.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    const insert = src.prepare('INSERT INTO t (id, name) VALUES (?, ?)');
    src.transaction(() => {
      // COPY_BATCH_ROWS is 1000, so this is two batches and the offender is in
      // the SECOND — the first has already ticked its running total by then.
      for (let i = 1; i <= 1200; i += 1) insert.run(i, i === 1100 ? null : `row-${i}`);
    })();
    src.close();

    const sinkPath = join(root, 'late-dst.db');
    const dst = new Database(sinkPath);
    dst.exec('CREATE TABLE sink (id INTEGER, note TEXT NOT NULL)');
    dst.close();
    return { sourcePath, sinkPath };
  }

  it('reports rowsWritten 0 when the transaction demonstrably rolled back', async () => {
    const root = tempRoot();
    const { sourcePath, sinkPath } = seedLateFailure(root);
    const events = await run(
      copyCtx({
        root,
        sourcePath,
        sinkPath,
        input: {
          mapping: [
            { source: 'id', sink: 'id', type: 'integer' },
            { source: 'name', sink: 'note', type: 'string' },
          ],
        },
      }),
    );

    expect(terminal(events).type).toBe('failed');
    // The sink ticked 1000 after batch one, into an OPEN transaction. Batch two
    // violated NOT NULL and the whole transaction rolled back, so NOTHING landed.
    // Reporting the tick as the final count would tell an operator 1000 rows
    // moved on a run that moved none.
    expect(rowsOf(sinkPath, 'SELECT * FROM sink')).toEqual([]);
    const written = events.find((e) => e.type === 'output' && e.name === 'rowsWritten');
    expect(written?.type === 'output' ? written.value : null).toBe(0);
  });
});

describe('copy activity — identifier matching folds case, as SQLite does', () => {
  it("refuses onError:'null' against a NOT NULL column declared in another case", async () => {
    const root = tempRoot();
    const end = terminal(
      await run(
        copyCtx({
          root,
          sourcePath: seedDb(root, 1, 'src.db'),
          sinkPath: seedSink(root, 'dst.db'),
          // Declared 'ID', mapped as 'id'. SQLite treats those as ONE column, so
          // a case-sensitive check would let the null through to become a
          // constraint violation mid-transaction — the failure this rung exists
          // to move to the boundary.
          sinkColumns: [{ name: 'ID', type: 'string', nullable: false }],
          input: {
            mapping: [{ source: 'name', sink: 'id', type: 'string', onError: 'null' }],
          },
        }),
      ),
    );
    expect(end).toMatchObject({
      kind: 'permanent',
      error: expect.stringContaining('NOT NULL'),
    });
  });
});

describe('copy activity — §7 the source-side drift gate runs before the first row moves (#1148 M6)', () => {
  it('refuses a mapped source column the store does not have, naming it, with nothing written', () => {
    const root = tempRoot();
    const sinkPath = seedSink(root, 'dst.db');
    return run(
      copyCtx({
        root,
        sourcePath: seedDb(root, 3, 'src.db'),
        sinkPath,
        input: { mapping: [{ source: 'nosuch', sink: 'id', type: 'integer' }] },
      }),
    ).then((events) => {
      const end = terminal(events);
      expect(end.type).toBe('failed');
      expect(end.type === 'failed' ? end.kind : '').toBe('permanent');
      expect(end.type === 'failed' ? end.error : '').toContain('nosuch');
      // The gate ran BEFORE the pump, so there are no counters to report: the
      // copy never started. That is the observable difference from the pre-M6
      // behaviour, where the same mapping failed from inside the open write
      // transaction with `rowsRead` already ticking.
      expect(events.filter((e) => e.type === 'output')).toEqual([]);
      expect(rowsOf(sinkPath)).toEqual([]);
    });
  });

  it('refuses it against an EMPTY source, which before M6 reported SUCCESS over 0 rows', async () => {
    const root = tempRoot();
    const events = await run(
      copyCtx({
        root,
        // 0 rows: `planColumns` resolves from the FIRST ROW's keys, so it never
        // ran at all here and the copy succeeded having silently copied nothing
        // through a mapping that names a column the store does not have.
        sourcePath: seedDb(root, 0, 'src.db'),
        sinkPath: seedSink(root, 'dst.db'),
        input: { mapping: [{ source: 'nosuch', sink: 'id', type: 'integer' }] },
      }),
    );
    const end = terminal(events);
    expect(end.type).toBe('failed');
    expect(end.type === 'failed' ? end.error : '').toContain('nosuch');
  });

  it("does not refuse an absent column the mapping opted out of with onError:'null'", async () => {
    const root = tempRoot();
    const sinkPath = seedSink(root, 'dst.db');
    const events = await run(
      copyCtx({
        root,
        sourcePath: seedDb(root, 2, 'src.db'),
        sinkPath,
        input: {
          mapping: [
            { source: 'id', sink: 'id', type: 'integer' },
            { source: 'nosuch', sink: 'note', type: 'string', onError: 'null' },
          ],
        },
      }),
    );
    expect(terminal(events).type).toBe('succeeded');
    expect(rowsOf(sinkPath, 'SELECT id, note FROM sink ORDER BY rowid')).toEqual([
      { id: 1, note: null },
      { id: 2, note: null },
    ]);
  });

  it('warns about a source column the mapping does not read, and still copies (§7 row 4)', async () => {
    const root = tempRoot();
    const events = await run(
      copyCtx({
        root,
        sourcePath: seedDb(root, 2, 'src.db'),
        sinkPath: seedSink(root, 'dst.db'),
        input: { mapping: [{ source: 'id', sink: 'id', type: 'integer' }] },
      }),
    );
    const warned = events.filter((e) => e.type === 'warned');
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({
      code: 'copy_source_columns_unmapped',
      reason: expect.stringContaining("'name'"),
    });
    expect(terminal(events).type).toBe('succeeded');
  });

  it('emits that warning on a FAILING copy too — the run whose log is being read', async () => {
    const root = tempRoot();
    const events = await run(
      copyCtx({
        root,
        sourcePath: seedDb(root, 2, 'src.db'),
        sinkPath: seedSink(root, 'dst.db'),
        // `name` goes unread AND the sink column does not exist, so the copy
        // fails inside the write, after the warning was already emitted.
        input: { mapping: [{ source: 'id', sink: 'nosuch', type: 'integer' }] },
      }),
    );
    expect(
      events.filter((e) => e.type === 'warned' && e.code === 'copy_source_columns_unmapped'),
    ).toHaveLength(1);
    expect(terminal(events).type).toBe('failed');
  });

  it('does not warn when the mapping reads every source column', async () => {
    const root = tempRoot();
    const events = await run(
      copyCtx({
        root,
        sourcePath: seedDb(root, 2, 'src.db'),
        sinkPath: seedSink(root, 'dst.db'),
      }),
    );
    expect(events.filter((e) => e.type === 'warned')).toEqual([]);
    expect(terminal(events).type).toBe('succeeded');
  });

  it("reports a store it could not REACH with the store's own kind, never as drift", async () => {
    // #1148: "a failure to reach the store to describe it is `transient` and
    // must not be reported as drift". Driven through a stub `CopyIo` rather than
    // a real lock, because the fact under test is the CLASSIFICATION, and a
    // timing-dependent SQLITE_BUSY would pin it only by luck.
    const events: ActivityEvent[] = [];
    const ctx = copyCtx({
      root: tempRoot(),
      sourcePath: 'unused',
      sinkPath: 'unused',
      input: { mapping: [{ source: 'id', sink: 'id', type: 'integer' }] },
    });
    for await (const event of runCopyActivity(ctx, {
      describeSource: () => Promise.reject(new DatasetIoError('transient', 'database is locked')),
      readBatches: () => {
        throw new Error('the reader must never be reached');
      },
      writeRows: () => {
        throw new Error('the writer must never be reached');
      },
    })) {
      events.push(event);
    }
    const end = terminal(events);
    expect(end.type).toBe('failed');
    expect(end.type === 'failed' ? end.kind : '').toBe('transient');
  });
});
