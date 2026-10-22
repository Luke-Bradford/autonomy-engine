import { readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COPY_ACTIVITY_TYPE,
  COPY_PROGRESS_OUTPUT,
  SESSION_LOG_OUTPUT,
  SESSION_LOG_RUN_MAX_LINES,
  WARNING_CODES,
  getActivity,
  newCopyCounters,
  type DatasetColumn,
} from '@autonomy-studio/shared';
import {
  INCREMENTAL_NEEDS_DATABASE,
  runCopyActivity,
  storeCountAdvisory,
  verifyAfterCopyFailure,
  type CopyIo,
} from '../copy.js';
import { DatasetIoError } from '../dataset-io-error.js';
import { SessionLogWriter } from '../session-log-file.js';
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

/**
 * The catalog's outputs a FULL copy yields, in order: every declared one but
 * C5a's `watermark`, which a copy yields under Load Incremental only, so a copy
 * saved before C5a reports exactly the outputs it did.
 */
const fullCopyOutputNames = (): string[] =>
  getActivity('copy')!
    .outputs.map((o) => o.name)
    .filter((name) => name !== 'watermark');

const terminal = (events: ActivityEvent[]): ActivityEvent =>
  events[events.length - 1] as ActivityEvent;

/** #1600 OR41 C6f-1 — bytes/s over the yielded duration, null for an instant copy. */
const throughputOf = (outputs: Record<string, unknown>): number | null => {
  const ms = outputs['durationMs'] as number;
  return ms === 0 ? null : Math.round(((outputs['bytesRead'] as number) * 1000) / ms);
};

describe('copy activity — the happy path contract', () => {
  it('yields ONE terminal event carrying the declared outputs', async () => {
    const root = tempRoot();
    const events = await run(
      copyCtx({ root, sourcePath: seedDb(root, 3, 'src.db'), sinkPath: seedSink(root, 'dst.db') }),
    );

    // Exactly one terminal: the executor folds the FIRST it sees, so a second
    // would be silently discarded state.
    expect(events.filter((e) => e.type === 'succeeded' || e.type === 'failed')).toHaveLength(1);
    const end = terminal(events);
    expect(end.type).toBe('succeeded');
    const outputs = end.type === 'succeeded' ? end.outputs : {};
    expect(outputs).toEqual({
      rowsRead: 3,
      rowsWritten: 3,
      rowsSkipped: 0,
      rowsFailed: 0,
      bytesRead: expect.any(Number),
      truncated: false,
      durationMs: expect.any(Number),
      throughput: throughputOf(outputs),
      consistency: { verified: false, result: 'none' },
      // #1600 OR41 C6f-2 — one reader into one sink transaction: no partitioned
      // reads yet, so a rows Copy always runs one copy (ADF reports the same).
      usedParallelCopies: 1,
      // #1600 OR41 C6c-1b — the run log, so no file.
      logPath: null,
    });
    // #1600 OR41 C6f-1 — the catalog's contract, name for name and in order:
    // an output the entry declares and the copy does not yield fails the node.
    expect(Object.keys(outputs)).toEqual(fullCopyOutputNames());
    // A copy whose store kept exactly what it was sent has nothing to say.
    expect(events.filter((e) => e.type === 'warned')).toEqual([]);
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

describe('copy activity — a store that discards rows says so (#1273)', () => {
  it('names the gap when a sink trigger discards a row, and still succeeds', async () => {
    const root = tempRoot();
    const sinkPath = seedSink(root, 'dst.db');
    const db = new Database(sinkPath);
    db.exec(
      'CREATE TRIGGER t BEFORE INSERT ON sink WHEN new.id = 2 BEGIN SELECT raise(ignore); END;',
    );
    db.close();

    const events = await run(copyCtx({ root, sourcePath: seedDb(root, 3, 'src.db'), sinkPath }));

    const end = terminal(events);
    expect(end.type).toBe('succeeded');
    expect(end.type === 'succeeded' ? end.outputs : null).toMatchObject({
      rowsRead: 3,
      rowsWritten: 2,
      rowsFailed: 0,
    });
    const warnings = events.filter((e) => e.type === 'warned');
    expect(warnings.map((w) => (w.type === 'warned' ? w.code : null))).toEqual([
      'copy_store_count_differs',
    ]);
    expect(warnings[0]?.type === 'warned' ? warnings[0].reason : '').toMatch(
      /the store kept 2 of the 3 row\(s\) the copy sent; 1 was discarded by the sink itself/,
    );
  });
});

describe('storeCountAdvisory — rowsWritten against the rows the copy SENT', () => {
  const counters = (rowsRead: number, rowsFailed: number, rowsWritten: number) => ({
    ...newCopyCounters(),
    rowsRead,
    rowsFailed,
    rowsWritten,
  });

  it('is silent when the store kept every row it was sent', () => {
    expect(storeCountAdvisory(counters(5, 0, 5))).toBeNull();
    expect(storeCountAdvisory(counters(0, 0, 0))).toBeNull();
  });

  it('does not count a coercion failure as a store discard', () => {
    // 2 rows never reached the store; `COPY_ROWS_FAILED` owns saying so.
    expect(storeCountAdvisory(counters(5, 2, 3))).toBeNull();
  });

  it('names a shortfall against the rows sent, not the rows read', () => {
    expect(storeCountAdvisory(counters(5, 1, 2))).toBe(
      'the store kept 2 of the 4 row(s) the copy sent; 2 were discarded by the sink itself ' +
        '(a trigger, rule or conflict clause), not by the mapping',
    );
  });

  it('names an EXCESS without calling it a discard', () => {
    // A postgres `DO INSTEAD` rule reports the rule's own count (#1270).
    const reason = storeCountAdvisory(counters(5, 0, 7));
    expect(reason).toBe(
      'the store reports 7 row(s) written for the 5 the copy sent — a rule or trigger on the ' +
        "sink rewrote the inserts, so rowsWritten is the store's count, not rows this copy delivered",
    );
    expect(reason).not.toMatch(/discarded/);
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

  it("refuses onError:'null' where the DATASET says nullable but the STORE says NOT NULL (#1162)", async () => {
    const root = tempRoot();
    const sinkPath = join(root, 'nn-dst.db');
    const dst = new Database(sinkPath);
    dst.exec(
      "CREATE TABLE sink (id INTEGER, name TEXT NOT NULL); INSERT INTO sink VALUES (9, 'kept')",
    );
    dst.close();
    const end = terminal(
      await run(
        copyCtx({
          root,
          sourcePath: seedDb(root, 2, 'src.db'),
          sinkPath,
          // The declaration is stale: it calls `name` nullable. §7 says the
          // declared schema is not the gate, so the dispatch rung admits this —
          // and the sink, reading the real schema, is what refuses it.
          sinkColumns: columns(['id', true], ['name', true]),
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
      error: expect.stringContaining(
        "sink column 'name' sets onError:'null', but the sink table in the store is NOT NULL",
      ),
    });
    expect(rowsOf(sinkPath)).toEqual([{ id: 9, name: 'kept' }]);
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
          // An UNCOERCIBLE CONSTANT, not a missing source column. The pump
          // still raises this one from inside the sink's transaction, which is
          // what this test is about; #1148's dispatch-time gate now intercepts
          // a missing source column BEFORE the pump runs, so that fixture would
          // exercise `copyFailure`'s direct branch and leave the `.cause`
          // unwrap — the thing under test — with no coverage at all.
          input: { mapping: [{ expression: 'abc', sink: 'id', type: 'integer' }] },
        }),
      ),
    );
    // The pump throws INSIDE the sink's transaction, so the sink wraps it as a
    // DatasetIoError and keeps the original on `.cause`. Reading only the outer
    // error loses the one word that tells an author what to fix.
    expect(end).toMatchObject({
      kind: 'permanent',
      error: expect.stringContaining('uncoercible_constant'),
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
    expect(outputs.map((e) => (e.type === 'output' ? e.name : ''))).toEqual(fullCopyOutputNames());
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

  it("does not read a failed copy's gap as the store discarding rows (#1273)", async () => {
    // rowsRead 1200 against a proven rowsWritten 0: that gap IS the failure, and
    // calling it the sink discarding rows would misname what happened.
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
    const read = events.find((e) => e.type === 'output' && e.name === 'rowsRead');
    expect(read?.type === 'output' ? read.value : null).toBe(1200);
    expect(events.filter((e) => e.type === 'warned')).toEqual([]);
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

  it('refuses an ambiguous source column through the adapter, ahead of any missing one', async () => {
    const root = tempRoot();
    const events = await run(
      copyCtx({
        root,
        sourcePath: seedDb(root, 2, 'src.db'),
        sinkPath: seedSink(root, 'dst.db'),
        datasets: {
          // Two result columns differing only in case, so `id` matches neither
          // exactly and both loosely. A `query` dataset is the only way to
          // produce this — a table cannot hold `ID` alongside `Id`.
          source: {
            id: 'ds-1',
            name: 'src',
            kind: 'query',
            config: { sql: 'SELECT id AS "ID", name AS "Id" FROM t' },
            columns: [],
          },
          sink: { id: 'ds-2', name: 'dst', kind: 'table', config: { table: 'sink' }, columns: [] },
        },
        input: {
          mapping: [
            { source: 'id', sink: 'id', type: 'integer' },
            { source: 'alsonosuch', sink: 'name', type: 'string' },
          ],
        },
      }),
    );
    const end = terminal(events);
    expect(end.type).toBe('failed');
    expect(end.type === 'failed' ? end.kind : '').toBe('permanent');
    // Ambiguity is reported even though a MISSING column is also present: an
    // ambiguous name cannot be resolved at all, where a missing one still has a
    // legitimate `onError: 'null'` answer. Same precedence as `planColumns`.
    expect(end.type === 'failed' ? end.error : '').toContain('ambiguous_source_column');
    expect(end.type === 'failed' ? end.error : '').toContain('case-insensitively');
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
      // `{}` rather than a throw: this test's subject is the DESCRIBE failing,
      // and a coercion projection that also threw would prove nothing about
      // which of the two the ladder reported.
      sourceCoercion: () => ({}),
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

describe('copy activity — §5 progress ticks stream while the copy runs (#1299)', () => {
  const MAPPING = {
    mapping: [
      { source: 'id', sink: 'id', type: 'integer' },
      { source: 'name', sink: 'name', type: 'string' },
    ],
  };

  /**
   * A hand-driven `CopyIo` whose write stops after taking EVERY batch, until the
   * test releases it — so "did the tick arrive while the write was still open"
   * is a question the test can ask, rather than one the event order implies.
   */
  function gatedIo(
    batches: readonly Record<string, unknown>[][],
    fail?: DatasetIoError,
  ): { io: CopyIo; release: () => void } {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const io: CopyIo = {
      describeSource: () => Promise.resolve(['id', 'name']),
      sourceCoercion: () => ({}),
      readBatches: async function* () {
        for (const batch of batches) yield batch;
      },
      writeRows: async ({ batches: incoming, onBatch }) => {
        let written = 0;
        for await (const batch of incoming) {
          written += batch.length;
          onBatch(written);
        }
        await gate;
        if (fail !== undefined) throw fail;
        return { rowsWritten: written };
      },
    };
    return { io, release };
  }

  const ctxFor = (): ActivityContext => {
    const root = tempRoot();
    return copyCtx({ root, sourcePath: 'unused.db', sinkPath: 'unused-dst.db', input: MAPPING });
  };

  const progressOf = (events: ActivityEvent[]): unknown[] =>
    events.flatMap((e) =>
      e.type === 'output' && e.name === COPY_PROGRESS_OUTPUT ? [e.value] : [],
    );

  it('yields a tick BEFORE the write has finished — progress, not a batch at the end', async () => {
    const { io, release } = gatedIo([[{ id: 1, name: 'a' }], [{ id: 2, name: 'b' }]]);
    const gen = runCopyActivity(ctxFor(), io);

    // The write is held open at its gate; a tick must still reach the consumer.
    const first = await gen.next();
    expect(first.value).toEqual({
      type: 'output',
      name: COPY_PROGRESS_OUTPUT,
      value: { rowsRead: 1, rowsInFlight: 1, rowsFailed: 0 },
    });

    release();
    const rest: ActivityEvent[] = [];
    for (let r = await gen.next(); r.done !== true; r = await gen.next()) rest.push(r.value);
    expect(progressOf(rest)).toEqual([{ rowsRead: 2, rowsInFlight: 2, rowsFailed: 0 }]);
    // Every tick lands before the terminal, and the terminal is unchanged by them.
    expect(terminal(rest).type).toBe('succeeded');
    const end = terminal(rest);
    expect(end.type === 'succeeded' ? end.outputs.rowsWritten : null).toBe(2);
  });

  it('ticks for a batch whose rows ALL failed — the copy that must not look hung', async () => {
    // `name` into an integer column: every row fails coercion, so no row ever
    // reaches the sink and the sink's own per-batch callback never fires.
    const { io, release } = gatedIo([[{ id: 1, name: 'a' }], [{ id: 2, name: 'b' }]]);
    release();
    const ctx = ctxFor();
    const events: ActivityEvent[] = [];
    for await (const e of runCopyActivity(
      {
        ...ctx,
        input: {
          mapping: [
            { source: 'id', sink: 'id', type: 'integer' },
            { source: 'name', sink: 'flag', type: 'integer' },
          ],
        },
      },
      io,
    )) {
      events.push(e);
    }
    expect(progressOf(events)).toEqual([
      { rowsRead: 1, rowsInFlight: 0, rowsFailed: 1 },
      { rowsRead: 2, rowsInFlight: 0, rowsFailed: 2 },
    ]);
  });

  it('never lets a closed generator leave the write running under it', async () => {
    const { io, release } = gatedIo([[{ id: 1, name: 'a' }]]);
    const gen = runCopyActivity(ctxFor(), io);
    // Started first: `return()` on an unstarted generator never runs the body.
    expect((await gen.next()).value).toMatchObject({ name: COPY_PROGRESS_OUTPUT });

    let closed = false;
    const closing = gen.return(undefined).then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The write is still open behind its gate, so closing must still be waiting.
    expect(closed).toBe(false);
    release();
    await closing;
    expect(closed).toBe(true);
  });

  it('maps a writeRows that throws SYNCHRONOUSLY onto the failed path, counters included', async () => {
    const { io } = gatedIo([]);
    const throwing: CopyIo = {
      ...io,
      writeRows: () => {
        throw new DatasetIoError('permanent', 'refused before any promise existed');
      },
    };
    const events: ActivityEvent[] = [];
    for await (const e of runCopyActivity(ctxFor(), throwing)) events.push(e);
    const end = terminal(events);
    expect(end.type).toBe('failed');
    expect(end.type === 'failed' ? end.error : '').toMatch(/refused before any promise existed/);
    expect(events.some((e) => e.type === 'output' && e.name === 'rowsWritten')).toBe(true);
  });

  it('keeps the running total as rowsWritten when the sink cannot prove a rollback', async () => {
    const { io, release } = gatedIo(
      [[{ id: 1, name: 'a' }]],
      new DatasetIoError('transient', 'connection lost mid-commit', { partialWritePossible: true }),
    );
    release();
    const events: ActivityEvent[] = [];
    for await (const e of runCopyActivity(ctxFor(), io)) events.push(e);
    expect(terminal(events).type).toBe('failed');
    const written = events.find((e) => e.type === 'output' && e.name === 'rowsWritten');
    expect(written?.type === 'output' ? written.value : null).toBe(1);
  });

  it('ticks per batch over a real store, ascending, and all before the terminal', async () => {
    const root = tempRoot();
    // COPY_BATCH_ROWS is 1000, so 2500 rows is three batches.
    const events = await run(
      copyCtx({
        root,
        sourcePath: seedDb(root, 2500, 'src.db'),
        sinkPath: seedSink(root, 'dst.db'),
      }),
    );
    expect(progressOf(events)).toEqual([
      { rowsRead: 1000, rowsInFlight: 1000, rowsFailed: 0 },
      { rowsRead: 2000, rowsInFlight: 2000, rowsFailed: 0 },
      { rowsRead: 2500, rowsInFlight: 2500, rowsFailed: 0 },
    ]);
    expect(terminal(events).type).toBe('succeeded');
  });

  it('a tick is not the final count — a rolled-back copy still reports rowsWritten 0', async () => {
    const root = tempRoot();
    const sourcePath = join(root, 'late-src.db');
    const src = new Database(sourcePath);
    src.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    const insert = src.prepare('INSERT INTO t (id, name) VALUES (?, ?)');
    src.transaction(() => {
      for (let i = 1; i <= 1200; i += 1) insert.run(i, i === 1100 ? null : `row-${i}`);
    })();
    src.close();
    const sinkPath = join(root, 'late-dst.db');
    const dst = new Database(sinkPath);
    dst.exec('CREATE TABLE sink (id INTEGER, note TEXT NOT NULL)');
    dst.close();

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
    // Batch one reached the open transaction and ticked; batch two rolled it back.
    expect(progressOf(events)).toEqual([{ rowsRead: 1000, rowsInFlight: 1000, rowsFailed: 0 }]);
    const tickAt = events.findIndex((e) => e.type === 'output' && e.name === COPY_PROGRESS_OUTPUT);
    const writtenAt = events.findIndex((e) => e.type === 'output' && e.name === 'rowsWritten');
    expect(tickAt).toBeLessThan(writtenAt);
    const written = events[writtenAt];
    expect(written?.type === 'output' ? written.value : null).toBe(0);
    expect(terminal(events).type).toBe('failed');
  });
});

// #1600 OR41 C3b — the two fields reach the I/O they configure: Batch size the
// reader (whose batch the pump passes through to the sink), the Pre-copy script
// the sink, with its substituted bind values.
describe('copy activity — Batch size and Pre-copy script reach the I/O (C3b)', () => {
  const MAPPING = [
    { source: 'id', sink: 'id', type: 'integer' },
    { source: 'name', sink: 'name', type: 'string' },
  ];

  function capturingIo(): {
    io: CopyIo;
    seen: { batchRows?: number | undefined; preCopyScript?: unknown };
  } {
    const seen: { batchRows?: number | undefined; preCopyScript?: unknown } = {};
    const io: CopyIo = {
      describeSource: () => Promise.resolve(['id', 'name']),
      sourceCoercion: () => ({}),
      readBatches: async function* ({ batchRows }) {
        seen.batchRows = batchRows;
        yield [{ id: 1, name: 'a' }];
      },
      writeRows: async ({ batches: incoming, preCopyScript }) => {
        seen.preCopyScript = preCopyScript;
        let written = 0;
        for await (const batch of incoming) written += batch.length;
        return { rowsWritten: written };
      },
    };
    return { io, seen };
  }

  const ctxWith = (input: unknown): ActivityContext =>
    copyCtx({ root: tempRoot(), sourcePath: 'unused.db', sinkPath: 'unused-dst.db', input });

  async function drain(ctx: ActivityContext, io: CopyIo): Promise<ActivityEvent[]> {
    const events: ActivityEvent[] = [];
    for await (const event of runCopyActivity(ctx, io)) events.push(event);
    return events;
  }

  it('passes Batch size to the reader, and nothing when it is empty', async () => {
    const sized = capturingIo();
    await drain(ctxWith({ mapping: MAPPING, writeBatchSize: 250 }), sized.io);
    expect(sized.seen.batchRows).toBe(250);
    const plain = capturingIo();
    await drain(ctxWith({ mapping: MAPPING }), plain.io);
    expect(plain.seen.batchRows).toBeUndefined();
    expect(plain.seen.preCopyScript).toBeNull();
  });

  it('hands the sink the script with its bind values', async () => {
    const { io, seen } = capturingIo();
    const events = await drain(
      ctxWith({
        mapping: MAPPING,
        preCopyScript: 'delete from sink where id = :id',
        preCopyScriptParameters: { id: 7 },
      }),
      io,
    );
    expect(terminal(events).type).toBe('succeeded');
    expect(seen.preCopyScript).toEqual({
      sql: 'delete from sink where id = :id',
      parameters: { id: 7 },
    });
  });

  it('refuses a script that still holds a ${} at dispatch, before any I/O', async () => {
    const { io, seen } = capturingIo();
    const events = await drain(
      ctxWith({ mapping: MAPPING, preCopyScript: "delete from sink where n = '${run.runId}'" }),
      io,
    );
    const end = terminal(events);
    expect(end.type).toBe('failed');
    expect(end.type === 'failed' ? end.error : '').toMatch(/Pre-copy script stays literal/);
    expect(seen.preCopyScript).toBeUndefined();
  });
});

// #1600 OR41 C3b — Batch size on real stores: the copy moves one batch per tick,
// so five rows at Batch size 2 are three batches, where the default is one.
describe('copy activity — Batch size sets the batch on a real store (C3b)', () => {
  const MAPPING = [
    { source: 'id', sink: 'id', type: 'integer' },
    { source: 'name', sink: 'name', type: 'string' },
  ];
  const ticksOf = (events: ActivityEvent[]): number =>
    events.filter((e) => e.type === 'output' && e.name === COPY_PROGRESS_OUTPUT).length;

  it('reads and writes five rows in batches of two', async () => {
    const root = tempRoot();
    const sinkPath = seedSink(root, 'dst.db');
    const sourcePath = seedDb(root, 5, 'src.db');
    const sized = await run(
      copyCtx({ root, sourcePath, sinkPath, input: { mapping: MAPPING, writeBatchSize: 2 } }),
    );
    expect(terminal(sized).type).toBe('succeeded');
    expect(ticksOf(sized)).toBe(3);
    expect(rowsOf(sinkPath)).toHaveLength(5);

    const plain = await run(
      copyCtx({
        root,
        sourcePath,
        sinkPath: seedSink(root, 'dst2.db'),
        input: { mapping: MAPPING },
      }),
    );
    expect(ticksOf(plain)).toBe(1);
  });
});

// #1600 OR41 C3c — Table option *Auto-create from mapping* reaches the sink as
// the mapping's sink names and declared types, and on a real store the copy
// creates the table it then writes.
describe('copy activity — Auto-create from mapping (C3c)', () => {
  const MAPPING = [
    { source: 'id', sink: 'id', type: 'integer' },
    { source: 'name', sink: 'label', type: 'string' },
  ];

  it('hands the sink the mapping as columns, and null for Use existing', async () => {
    const seen: unknown[] = [];
    const io: CopyIo = {
      describeSource: () => Promise.resolve(['id', 'name']),
      sourceCoercion: () => ({}),
      readBatches: async function* () {
        yield [{ id: 1, name: 'a' }];
      },
      writeRows: async ({ batches: incoming, autoCreate }) => {
        seen.push(autoCreate);
        let written = 0;
        for await (const batch of incoming) written += batch.length;
        return { rowsWritten: written };
      },
    };
    const ctxWith = (input: unknown): ActivityContext =>
      copyCtx({ root: tempRoot(), sourcePath: 'unused.db', sinkPath: 'unused-dst.db', input });
    for (const input of [
      { mapping: MAPPING, tableOption: 'autoCreate' },
      { mapping: MAPPING },
      { mapping: MAPPING, tableOption: 'none' },
    ]) {
      const events: ActivityEvent[] = [];
      for await (const event of runCopyActivity(ctxWith(input), io)) events.push(event);
      expect(terminal(events).type).toBe('succeeded');
    }
    expect(seen).toEqual([
      [
        { name: 'id', type: 'integer' },
        { name: 'label', type: 'string' },
      ],
      null,
      null,
    ]);
  });

  it('creates the sink table on a real store and copies into it', async () => {
    const root = tempRoot();
    const sourcePath = seedDb(root, 3, 'src.db');
    // A store with no `sink` table.
    const sinkPath = seedDb(root, 0, 'dst.db');
    const refused = await run(copyCtx({ root, sourcePath, sinkPath, input: { mapping: MAPPING } }));
    expect(terminal(refused).type).toBe('failed');
    const events = await run(
      copyCtx({
        root,
        sourcePath,
        sinkPath,
        input: { mapping: MAPPING, tableOption: 'autoCreate' },
      }),
    );
    expect(terminal(events).type).toBe('succeeded');
    expect(rowsOf(sinkPath, 'SELECT id, label FROM sink ORDER BY id')).toHaveLength(3);
    expect(
      rowsOf(sinkPath, "SELECT name, type FROM pragma_table_info('sink') ORDER BY cid"),
    ).toEqual([
      { name: 'id', type: 'INTEGER' },
      { name: 'label', type: 'TEXT' },
    ]);
  });
});

describe('copy activity — the session log, to the run log (#1600 OR41 C6a)', () => {
  const lineValues = (events: ActivityEvent[]): string[] =>
    events.flatMap((e) =>
      e.type === 'output' && e.name === SESSION_LOG_OUTPUT ? [e.value as string] : [],
    );
  const dropping = (logLevel?: string) => ({
    mapping: [
      { source: 'id', sink: 'id', type: 'integer' },
      // `name` holds 'row-N', which cannot become an integer: every row is skipped.
      { source: 'name', sink: 'flag', type: 'integer' },
    ],
    ...(logLevel === undefined ? {} : { logLevel }),
  });
  const ts = '\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z';

  it('by default logs each skipped row as a Warning, numbered from 1, before the terminal', async () => {
    const root = tempRoot();
    const events = await run(
      copyCtx({
        root,
        sourcePath: seedDb(root, 2, 'src.db'),
        sinkPath: seedSink(root, 'dst.db'),
        input: dropping(),
      }),
    );
    const lines = lineValues(events);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      new RegExp(`^${ts} Warning TabularRowSkip row 1 not_a_number: into 'flag': .+`),
    );
    expect(lines[1]).toMatch(new RegExp(`^${ts} Warning TabularRowSkip row 2 `));
    const firstLine = events.findIndex((e) => e.type === 'output' && e.name === SESSION_LOG_OUTPUT);
    expect(firstLine).toBeLessThan(events.findIndex((e) => e.type === 'warned'));
    expect(terminal(events).type).toBe('succeeded');
    // The advisory numbers rows as the log does, so one row has one number.
    const warning = events.find((e) => e.type === 'warned');
    expect(warning?.type === 'warned' ? warning.reason : '').toContain('First at row 1 ');
  });

  it('Everything also logs each batch read', async () => {
    const root = tempRoot();
    const events = await run(
      copyCtx({
        root,
        sourcePath: seedDb(root, 3, 'src.db'),
        sinkPath: seedSink(root, 'dst.db'),
        input: dropping('info'),
      }),
    );
    const lines = lineValues(events);
    expect(lines).toHaveLength(4);
    expect(lines[3]).toMatch(
      new RegExp(`^${ts} Info TabularRowBatch rows 1-3 read 3 rows, 3 skipped$`),
    );
  });

  it('Everything numbers each batch by the rows it read and counts its own skips', async () => {
    const root = tempRoot();
    const sourcePath = join(root, 'src.db');
    const src = new Database(sourcePath);
    src.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, flag TEXT)');
    src.exec("INSERT INTO t VALUES (1, '1'), (2, 'x'), (3, '3'), (4, '4'), (5, 'y')");
    src.close();
    const events = await run(
      copyCtx({
        root,
        sourcePath,
        sinkPath: seedSink(root, 'dst.db'),
        input: {
          mapping: [
            { source: 'id', sink: 'id', type: 'integer' },
            { source: 'flag', sink: 'flag', type: 'integer' },
          ],
          writeBatchSize: 2,
          logLevel: 'info',
        },
      }),
    );
    expect(lineValues(events).map((l) => l.replace(new RegExp(`^${ts} `), ''))).toEqual([
      expect.stringMatching(/^Warning TabularRowSkip row 2 /),
      'Info TabularRowBatch rows 1-2 read 2 rows, 1 skipped',
      'Info TabularRowBatch rows 3-4 read 2 rows, 0 skipped',
      expect.stringMatching(/^Warning TabularRowSkip row 5 /),
      'Info TabularRowBatch rows 5-5 read 1 row, 1 skipped',
    ]);
  });

  it('Off logs nothing, and a copy that skips nothing logs nothing at Warnings', async () => {
    const root = tempRoot();
    const off = await run(
      copyCtx({
        root,
        sourcePath: seedDb(root, 2, 'src.db'),
        sinkPath: seedSink(root, 'dst.db'),
        input: dropping('off'),
      }),
    );
    expect(lineValues(off)).toEqual([]);
    const clean = await run(
      copyCtx({ root, sourcePath: seedDb(root, 2, 'b.db'), sinkPath: seedSink(root, 'e.db') }),
    );
    expect(lineValues(clean)).toEqual([]);
  });

  it(`keeps ${SESSION_LOG_RUN_MAX_LINES} lines and counts the rest, pointing at a folder`, async () => {
    const root = tempRoot();
    const n = SESSION_LOG_RUN_MAX_LINES + 5;
    const events = await run(
      copyCtx({
        root,
        sourcePath: seedDb(root, n, 'src.db'),
        sinkPath: seedSink(root, 'dst.db'),
        input: dropping(),
      }),
    );
    const lines = lineValues(events);
    expect(lines).toHaveLength(SESSION_LOG_RUN_MAX_LINES + 1);
    expect(lines.at(-2)).toContain(` row ${SESSION_LOG_RUN_MAX_LINES} `);
    // #1600 OR41 C6c-1b — a rows Copy can write its log to a folder now.
    expect(lines.at(-1)).toMatch(
      / SessionLog {2}5 more lines not kept in the run log; write the session log to a folder to keep every line$/,
    );
  });

  it('a copy that fails keeps the lines it logged, ahead of the terminal, with no Error line', async () => {
    const root = tempRoot();
    const sourcePath = join(root, 'src.db');
    const src = new Database(sourcePath);
    src.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, flag TEXT)');
    const insert = src.prepare('INSERT INTO t (id, name, flag) VALUES (?, ?, ?)');
    src.transaction(() => {
      // Row 3 cannot become an integer; row 1100, in the second batch, breaks
      // the sink's NOT NULL and fails the copy.
      for (let i = 1; i <= 1200; i += 1)
        insert.run(i, i === 1100 ? null : `row-${i}`, i === 3 ? 'bad' : '5');
    })();
    src.close();
    const sinkPath = join(root, 'dst.db');
    const dst = new Database(sinkPath);
    dst.exec('CREATE TABLE sink (id INTEGER, note TEXT NOT NULL, flag INTEGER)');
    dst.close();

    const events = await run(
      copyCtx({
        root,
        sourcePath,
        sinkPath,
        input: {
          mapping: [
            { source: 'id', sink: 'id', type: 'integer' },
            { source: 'name', sink: 'note', type: 'string' },
            { source: 'flag', sink: 'flag', type: 'integer' },
          ],
        },
      }),
    );
    expect(terminal(events).type).toBe('failed');
    const lines = lineValues(events);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(`^${ts} Warning TabularRowSkip row 3 `));
  });
});

describe('copy activity — Skip incompatible rows (#1600 OR41 C6d-1)', () => {
  const lineValues = (events: ActivityEvent[]): string[] =>
    events.flatMap((e) =>
      e.type === 'output' && e.name === SESSION_LOG_OUTPUT
        ? [(e.value as string).replace(/^\S+ /, '')]
        : [],
    );
  /** A source whose flags are given, and a sink that holds each flag once. */
  function stores(root: string, flags: string[]): { sourcePath: string; sinkPath: string } {
    const sourcePath = join(root, 'src.db');
    const src = new Database(sourcePath);
    src.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, flag TEXT)');
    const insert = src.prepare('INSERT INTO t VALUES (?, ?)');
    flags.forEach((flag, i) => insert.run(i + 1, flag));
    src.close();
    const sinkPath = seedSink(root, 'dst.db');
    const db = new Database(sinkPath);
    db.exec('CREATE UNIQUE INDEX sink_flag ON sink (flag)');
    db.close();
    return { sourcePath, sinkPath };
  }
  const input = (skipIncompatibleRows: boolean) => ({
    mapping: [
      { source: 'id', sink: 'id', type: 'integer' },
      { source: 'flag', sink: 'flag', type: 'integer' },
    ],
    skipIncompatibleRows,
  });

  it('skips a row the sink rejects, numbered as its source row, beside the coercion skips', async () => {
    const root = tempRoot();
    const { sourcePath, sinkPath } = stores(root, ['1', '2', 'x', '2']);
    const events = await run(copyCtx({ root, sourcePath, sinkPath, input: input(true) }));
    const end = terminal(events);
    expect(end.type).toBe('succeeded');
    expect(end.type === 'succeeded' ? end.outputs : {}).toMatchObject({
      rowsRead: 4,
      rowsWritten: 2,
      rowsFailed: 2,
    });
    expect(lineValues(events)).toEqual([
      expect.stringMatching(/^Warning TabularRowSkip row 3 not_a_number: into 'flag': /),
      "Warning TabularRowSkip row 4 sink_rejected: into 'sink': UNIQUE constraint failed: sink.flag",
    ]);
    const warnings = events.filter((e) => e.type === 'warned');
    // The rows the sink rejected are not a store that discarded rows (#1273).
    expect(warnings.map((w) => (w.type === 'warned' ? w.code : ''))).toEqual([
      WARNING_CODES.COPY_ROWS_FAILED,
    ]);
    const reason = warnings[0]?.type === 'warned' ? warnings[0].reason : '';
    expect(reason).toContain('(1 not_a_number, 1 sink_rejected)');
    expect(rowsOf(sinkPath, 'SELECT id, flag FROM sink ORDER BY id')).toEqual([
      { id: 1, flag: 1 },
      { id: 2, flag: 2 },
    ]);
  });

  it('reports the lowest row first when the sink rejects a row before a coercion drop', async () => {
    const root = tempRoot();
    const { sourcePath, sinkPath } = stores(root, ['1', '1', 'x']);
    const events = await run(copyCtx({ root, sourcePath, sinkPath, input: input(true) }));
    const warning = events.find((e) => e.type === 'warned');
    expect(warning?.type === 'warned' ? warning.reason : '').toContain(
      "First at row 2 into 'sink': UNIQUE constraint failed: sink.flag.",
    );
  });

  it('off, the rejected row fails the copy and nothing lands', async () => {
    const root = tempRoot();
    const { sourcePath, sinkPath } = stores(root, ['1', '2', '2']);
    const end = terminal(await run(copyCtx({ root, sourcePath, sinkPath, input: input(false) })));
    expect(end).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect(rowsOf(sinkPath)).toEqual([]);
  });
});

describe('copy activity — Verify after copy (#1600 OR41 C6e-1)', () => {
  const input = (over: Record<string, unknown> = {}) => ({
    mapping: [
      { source: 'id', sink: 'id', type: 'integer' },
      { source: 'name', sink: 'name', type: 'string' },
    ],
    validateDataConsistency: true,
    ...over,
  });
  function discardingTwo(root: string): string {
    const sinkPath = seedSink(root, 'dst.db');
    const db = new Database(sinkPath);
    db.exec(
      'CREATE TRIGGER t BEFORE INSERT ON sink WHEN new.id = 2 BEGIN SELECT raise(ignore); END;',
    );
    db.close();
    return sinkPath;
  }

  it('fails a copy whose store kept fewer rows than it was sent, and commits none', async () => {
    const root = tempRoot();
    const sinkPath = discardingTwo(root);
    const events = await run(
      copyCtx({ root, sourcePath: seedDb(root, 3, 'src.db'), sinkPath, input: input() }),
    );
    expect(terminal(events)).toEqual({
      type: 'failed',
      kind: 'permanent',
      error:
        'Verify after copy failed: the copy read 3 row(s) and skipped 0, so 3 should have been ' +
        'written, but the store reports 2',
    });
    expect(rowsOf(sinkPath)).toEqual([]);
    // Rolled back, so the honest count is 0, and the post-commit advisory never runs.
    expect(events).toContainEqual({ type: 'output', name: 'rowsWritten', value: 0 });
    // C6f-1 — ADF's InconsistentData Found, the one place a rows Copy says it.
    expect(events).toContainEqual({
      type: 'output',
      name: 'consistency',
      value: { verified: true, result: 'found' },
    });
    expect(events.filter((e) => e.type === 'warned')).toEqual([]);
  });

  it('off, the same copy succeeds and names the gap, as before C6e', async () => {
    const root = tempRoot();
    const sinkPath = discardingTwo(root);
    const events = await run(
      copyCtx({
        root,
        sourcePath: seedDb(root, 3, 'src.db'),
        sinkPath,
        input: input({ validateDataConsistency: false }),
      }),
    );
    expect(terminal(events).type).toBe('succeeded');
    expect(
      events.filter((e) => e.type === 'warned').map((w) => w.type === 'warned' && w.code),
    ).toEqual([WARNING_CODES.COPY_STORE_COUNT_DIFFERS]);
  });

  it('passes a consistent copy, counting the skipped rows as accounted for', async () => {
    const root = tempRoot();
    const sourcePath = join(root, 'src.db');
    const src = new Database(sourcePath);
    src.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, flag TEXT)');
    const insert = src.prepare('INSERT INTO t VALUES (?, ?)');
    ['1', '2', 'x', '2'].forEach((flag, i) => insert.run(i + 1, flag));
    src.close();
    const sinkPath = seedSink(root, 'dst.db');
    const db = new Database(sinkPath);
    db.exec('CREATE UNIQUE INDEX sink_flag ON sink (flag)');
    db.close();
    const end = terminal(
      await run(
        copyCtx({
          root,
          sourcePath,
          sinkPath,
          input: input({
            mapping: [
              { source: 'id', sink: 'id', type: 'integer' },
              { source: 'flag', sink: 'flag', type: 'integer' },
            ],
            skipIncompatibleRows: true,
          }),
        }),
      ),
    );
    // One coercion drop and one row the sink rejected: 4 read = 2 written + 2 skipped.
    expect(end).toMatchObject({
      type: 'succeeded',
      outputs: {
        rowsRead: 4,
        rowsWritten: 2,
        rowsSkipped: 2,
        rowsFailed: 2,
        consistency: { verified: true, result: 'none' },
      },
    });
    expect(rowsOf(sinkPath, 'SELECT id FROM sink ORDER BY id')).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('refuses Upsert at dispatch, before a store is opened', async () => {
    const root = tempRoot();
    const sinkPath = seedSink(root, 'dst.db');
    const end = terminal(
      await run(
        copyCtx({
          root,
          sourcePath: seedDb(root, 2, 'src.db'),
          sinkPath,
          input: input({ mode: 'upsert' }),
        }),
      ),
    );
    expect(end).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect(end.type === 'failed' ? end.error : '').toContain(
      'Verify after copy does not apply to Upsert',
    );
    expect(rowsOf(sinkPath)).toEqual([]);
  });
});

describe('verifyAfterCopyFailure — rows read = rows written + rows skipped (C6e-1)', () => {
  const counters = (rowsRead: number, rowsFailed: number) => ({
    ...newCopyCounters(),
    rowsRead,
    rowsFailed,
    // A tick, which the verdict must not read: the store's count is handed in.
    rowsWritten: 999,
  });

  it('passes when the store kept every row the copy sent', () => {
    expect(verifyAfterCopyFailure(counters(5, 2), 3)).toBeNull();
    expect(verifyAfterCopyFailure(counters(0, 0), 0)).toBeNull();
  });

  it('fails when the store kept fewer, or reports more, than it was sent', () => {
    expect(verifyAfterCopyFailure(counters(5, 2), 2)).toBe(
      'Verify after copy failed: the copy read 5 row(s) and skipped 2, so 3 should have been ' +
        'written, but the store reports 2',
    );
    expect(verifyAfterCopyFailure(counters(5, 2), 4)).toBe(
      'Verify after copy failed: the copy read 5 row(s) and skipped 2, so 3 should have been ' +
        'written, but the store reports 4',
    );
  });
});

describe('copy activity — the session log, to a folder (#1600 OR41 C6c-1b)', () => {
  let logs: string;
  beforeEach(async () => {
    logs = tempRoot();
    await mkdir(join(logs, 'runs'));
  });
  const logConnection = (over: { writable?: boolean; kind?: string } = {}) => ({
    kind: over.kind ?? 'fs',
    connectionConfig: { roots: [logs], writable: over.writable ?? true },
  });
  const withLog = (ctx: ActivityContext, log: unknown = logConnection()): ActivityContext =>
    ({ ...ctx, ...(log === null ? {} : { logConnection: log }) }) as ActivityContext;
  const dropping = (extra: Record<string, unknown> = {}) => ({
    mapping: [
      { source: 'id', sink: 'id', type: 'integer' },
      // `name` holds 'row-N', which cannot become an integer: every row is skipped.
      { source: 'name', sink: 'flag', type: 'integer' },
    ],
    logTo: 'folder',
    logFolder: 'runs',
    ...extra,
  });
  const files = () => readdir(join(logs, 'runs'));
  /** The one log file's lines without the timestamp, the header first. */
  const csv = async () => {
    const names = await files();
    expect(names).toHaveLength(1);
    return (await readFile(join(logs, 'runs', names[0]!), 'utf8'))
      .replace(/^\uFEFF/, '')
      .split('\r\n')
      .filter((l) => l !== '')
      .map((l, i) => (i === 0 ? l : l.replace(/^[^,]+,/, '')));
  };
  /** The one terminal: the executor folds the first it sees. */
  const only = (events: ActivityEvent[]): ActivityEvent => {
    const ends = events.filter((e) => e.type === 'succeeded' || e.type === 'failed');
    expect(ends).toHaveLength(1);
    expect(events.at(-1)).toBe(ends[0]);
    return ends[0]!;
  };
  const runLogLines = (events: ActivityEvent[]) =>
    events.filter((e) => e.type === 'output' && e.name === SESSION_LOG_OUTPUT);
  const outputsOf = (events: ActivityEvent[]): Record<string, unknown> => {
    const end = events.at(-1)!;
    if (end.type === 'succeeded') return end.outputs;
    return Object.fromEntries(
      events.flatMap((e) => (e.type === 'output' ? [[e.name, e.value]] : [])),
    );
  };

  it('writes every line to the folder, not the run log, and names the file in logPath', async () => {
    const root = tempRoot();
    const events = await run(
      withLog(
        copyCtx({
          root,
          sourcePath: seedDb(root, 2, 'src.db'),
          sinkPath: seedSink(root, 'dst.db'),
          input: dropping(),
        }),
      ),
    );
    expect(only(events).type).toBe('succeeded');
    expect(runLogLines(events)).toEqual([]);
    const lines = await csv();
    expect(lines[0]).toBe('Timestamp,Level,Operation,Item,Message');
    expect(lines.slice(1)).toEqual([
      expect.stringMatching(/^Warning,TabularRowSkip,row 1,not_a_number: into 'flag': /),
      expect.stringMatching(/^Warning,TabularRowSkip,row 2,/),
    ]);
    const outputs = outputsOf(events);
    expect(outputs['logPath']).toBe(join(await realpath(join(logs, 'runs')), (await files())[0]!));
    expect(Object.keys(outputs)).toEqual(fullCopyOutputNames());
  });

  it('keeps every line past the run log’s cap', async () => {
    const root = tempRoot();
    const n = SESSION_LOG_RUN_MAX_LINES + 5;
    await run(
      withLog(
        copyCtx({
          root,
          sourcePath: seedDb(root, n, 'src.db'),
          sinkPath: seedSink(root, 'dst.db'),
          input: dropping(),
        }),
      ),
    );
    const lines = await csv();
    expect(lines).toHaveLength(n + 1);
    expect(lines.at(-1)).toMatch(new RegExp(`^Warning,TabularRowSkip,row ${n},`));
  });

  it('writes a header-only file for a copy of no rows', async () => {
    const root = tempRoot();
    const events = await run(
      withLog(
        copyCtx({
          root,
          sourcePath: seedDb(root, 0, 'src.db'),
          sinkPath: seedSink(root, 'dst.db'),
          input: dropping(),
        }),
      ),
    );
    expect(only(events).type).toBe('succeeded');
    expect(await csv()).toHaveLength(1);
    expect(outputsOf(events)['logPath']).toEqual(expect.any(String));
  });

  it.each([
    [
      'no log connection is bound',
      null,
      'the session log is written to a folder, and no log connection is bound; pick one on the Settings tab',
    ],
    [
      'the log connection does not allow writes',
      { writable: false },
      'the log connection does not allow writes; turn on Allow writes on that connection',
    ],
    [
      'the log connection is not a file one',
      { kind: 'sqlite' },
      'the log connection is not a file connection',
    ],
  ])('refuses before opening a store when %s', async (_why, over, message) => {
    const root = tempRoot();
    const events = await run(
      withLog(
        copyCtx({
          root,
          // Never opened: the refusal comes first, so a missing source is not reported.
          sourcePath: join(root, 'missing.db'),
          sinkPath: seedSink(root, 'dst.db'),
          input: dropping(),
        }),
        over === null ? null : logConnection(over),
      ),
    );
    expect(events).toEqual([{ type: 'failed', kind: 'permanent', error: message }]);
    expect(await files()).toEqual([]);
  });

  it('refuses a log folder that does not exist, before opening a store', async () => {
    const root = tempRoot();
    const events = await run(
      withLog(
        copyCtx({
          root,
          sourcePath: join(root, 'missing.db'),
          sinkPath: seedSink(root, 'dst.db'),
          input: dropping({ logFolder: 'nope' }),
        }),
      ),
    );
    expect(events).toEqual([
      { type: 'failed', kind: 'permanent', error: "the log folder 'nope' does not exist" },
    ]);
  });

  it('keeps the log of a copy refused after it is opened, ending with the refusal', async () => {
    const root = tempRoot();
    const events = await run(
      withLog(
        copyCtx({
          root,
          sourcePath: seedDb(root, 2, 'src.db'),
          sinkPath: seedSink(root, 'dst.db'),
          input: dropping({
            mapping: [{ source: 'nope', sink: 'id', type: 'integer' }],
          }),
        }),
      ),
    );
    const end = only(events);
    expect(end.type).toBe('failed');
    const lines = await csv();
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(`Error,Copy,,${end.type === 'failed' ? end.error : ''}`);
  });

  it('keeps the log of a copy the sink fails, ending with the failure', async () => {
    const root = tempRoot();
    const sinkPath = join(root, 'dst.db');
    const dst = new Database(sinkPath);
    dst.exec('CREATE TABLE sink (id INTEGER, flag INTEGER, note TEXT NOT NULL)');
    dst.close();
    const events = await run(
      withLog(
        copyCtx({
          root,
          sourcePath: seedDb(root, 2, 'src.db'),
          sinkPath,
          input: dropping({
            logLevel: 'info',
            mapping: [
              { source: 'id', sink: 'id', type: 'integer' },
              { source: 'nope', sink: 'note', type: 'string', onError: 'null' },
            ],
          }),
        }),
      ),
    );
    const end = only(events);
    expect(end.type).toBe('failed');
    // The message holds commas, so the cell is quoted.
    expect((await csv()).at(-1)).toBe(`Error,Copy,,"${end.type === 'failed' ? end.error : ''}"`);
    expect(outputsOf(events)['logPath']).toEqual(expect.any(String));
  });

  it('keeps the log of a cancelled copy, ending with the cancel, and rolls the rows back', async () => {
    const root = tempRoot();
    const sinkPath = seedSink(root, 'dst.db');
    const controller = new AbortController();
    const ctx = withLog({
      ...copyCtx({
        root,
        sourcePath: seedDb(root, 5, 'src.db'),
        sinkPath,
        input: dropping({
          logLevel: 'info',
          writeBatchSize: 1,
          mapping: [{ source: 'id', sink: 'id', type: 'integer' }],
        }),
      }),
      signal: controller.signal,
    } as ActivityContext);
    const events: ActivityEvent[] = [];
    for await (const event of sqliteAdapter.runActivity(ctx, null)) {
      events.push(event);
      if (event.type === 'output' && event.name === COPY_PROGRESS_OUTPUT) controller.abort();
    }
    const end = only(events);
    expect(end).toMatchObject({ type: 'failed', kind: 'cancelled' });
    expect((await csv()).at(-1)).toMatch(/^Error,Copy,,/);
    expect(rowsOf(sinkPath)).toEqual([]);
  });

  it('stops the copy and rolls it back once the log can no longer be written', async () => {
    const root = tempRoot();
    const sinkPath = seedSink(root, 'dst.db');
    const spy = vi
      .spyOn(SessionLogWriter.prototype, 'failure', 'get')
      .mockReturnValueOnce(undefined)
      .mockReturnValue('disk full');
    try {
      const events = await run(
        withLog(
          copyCtx({
            root,
            sourcePath: seedDb(root, 3, 'src.db'),
            sinkPath,
            input: dropping({
              writeBatchSize: 1,
              mapping: [{ source: 'id', sink: 'id', type: 'integer' }],
            }),
          }),
        ),
      );
      expect(only(events)).toEqual({
        type: 'failed',
        kind: 'permanent',
        error: 'the session log could not be written: disk full',
      });
      expect(outputsOf(events)['rowsWritten']).toBe(0);
      expect(rowsOf(sinkPath)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('rolls the copy back when the log cannot be written before COMMIT', async () => {
    const root = tempRoot();
    const sinkPath = seedSink(root, 'dst.db');
    const spy = vi.spyOn(SessionLogWriter.prototype, 'drain').mockResolvedValue('disk full');
    try {
      const events = await run(
        withLog(
          copyCtx({
            root,
            sourcePath: seedDb(root, 2, 'src.db'),
            sinkPath,
            input: dropping({ mapping: [{ source: 'id', sink: 'id', type: 'integer' }] }),
          }),
        ),
      );
      expect(only(events)).toEqual({
        type: 'failed',
        kind: 'permanent',
        error: 'the session log could not be written: disk full',
      });
      expect(rowsOf(sinkPath)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('fails a committed copy whose log cannot be closed, reporting the counts first', async () => {
    const root = tempRoot();
    const sinkPath = seedSink(root, 'dst.db');
    const spy = vi
      .spyOn(SessionLogWriter.prototype, 'close')
      .mockResolvedValue({ ok: false, error: 'disk full' });
    try {
      const events = await run(
        withLog(
          copyCtx({
            root,
            sourcePath: seedDb(root, 2, 'src.db'),
            sinkPath,
            input: dropping({ mapping: [{ source: 'id', sink: 'id', type: 'integer' }] }),
          }),
        ),
      );
      const end = only(events);
      expect(end).toMatchObject({ type: 'failed', kind: 'permanent' });
      expect(end.type === 'failed' ? end.error : '').toMatch(
        /^copied 2 rows, but the session log '.+session-log\..+\.csv' could not be written: disk full$/,
      );
      const outputs = outputsOf(events);
      expect(outputs['rowsWritten']).toBe(2);
      expect(outputs['logPath']).toBeNull();
      // Committed: the store holds the rows the counts report.
      expect(rowsOf(sinkPath)).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('stops a copy whose batches are all skipped once the log can no longer be written', async () => {
    // No row reaches the sink, so only the reader's batches can flush the log.
    const root = tempRoot();
    const sinkPath = seedSink(root, 'dst.db');
    const spy = vi
      .spyOn(SessionLogWriter.prototype, 'failure', 'get')
      .mockReturnValueOnce(undefined)
      .mockReturnValue('disk full');
    try {
      const events = await run(
        withLog(
          copyCtx({
            root,
            sourcePath: seedDb(root, 3, 'src.db'),
            sinkPath,
            input: dropping({ writeBatchSize: 1 }),
          }),
        ),
      );
      expect(only(events)).toEqual({
        type: 'failed',
        kind: 'permanent',
        error: 'the session log could not be written: disk full',
      });
      // Stopped after the second batch, not read to the end.
      expect(outputsOf(events)['rowsRead']).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('drains before COMMIT with every line in: none is added after the drain', async () => {
    const root = tempRoot();
    const sinkPath = join(root, 'dst.db');
    const dst = new Database(sinkPath);
    // Row 2's id breaks the key, so the sink rejects it in the last batch.
    dst.exec('CREATE TABLE sink (id INTEGER PRIMARY KEY, flag INTEGER)');
    dst.exec('INSERT INTO sink VALUES (2, 0)');
    dst.close();
    let appended = 0;
    let atDrain = -1;
    const append = SessionLogWriter.prototype.append;
    const drain = SessionLogWriter.prototype.drain;
    const appendSpy = vi.spyOn(SessionLogWriter.prototype, 'append').mockImplementation(function (
      this: SessionLogWriter,
      line,
    ) {
      appended += 1;
      append.call(this, line);
    });
    const drainSpy = vi.spyOn(SessionLogWriter.prototype, 'drain').mockImplementation(function (
      this: SessionLogWriter,
    ) {
      atDrain = appended;
      return drain.call(this);
    });
    try {
      const events = await run(
        withLog(
          copyCtx({
            root,
            sourcePath: seedDb(root, 2, 'src.db'),
            sinkPath,
            input: dropping({
              logLevel: 'info',
              skipIncompatibleRows: true,
              mapping: [{ source: 'id', sink: 'id', type: 'integer' }],
            }),
          }),
        ),
      );
      expect(only(events).type).toBe('succeeded');
      const lines = await csv();
      expect(lines.slice(1)).toEqual([
        expect.stringMatching(/^Warning,TabularRowSkip,row 2,sink_rejected: /),
        'Info,TabularRowBatch,rows 1-2,"read 2 rows, 1 skipped"',
      ]);
      expect(atDrain).toBe(2);
      expect(appended).toBe(2);
    } finally {
      appendSpy.mockRestore();
      drainSpy.mockRestore();
    }
  });

  it('writes the log of an Upsert, which the Settings fields before it refuse', async () => {
    const root = tempRoot();
    const sinkPath = join(root, 'dst.db');
    const dst = new Database(sinkPath);
    dst.exec('CREATE TABLE sink (id INTEGER PRIMARY KEY, flag INTEGER)');
    dst.close();
    const events = await run(
      withLog(
        copyCtx({
          root,
          sourcePath: seedDb(root, 2, 'src.db'),
          sinkPath,
          input: dropping({ mode: 'upsert' }),
        }),
      ),
    );
    expect(only(events).type).toBe('succeeded');
    expect((await csv()).slice(1)).toHaveLength(2);
  });

  it('closes the log of a consumer that stops early', async () => {
    const root = tempRoot();
    const close = vi.spyOn(SessionLogWriter.prototype, 'close');
    try {
      const ctx = withLog(
        copyCtx({
          root,
          sourcePath: seedDb(root, 3, 'src.db'),
          sinkPath: seedSink(root, 'dst.db'),
          input: dropping({ writeBatchSize: 1 }),
        }),
      );
      for await (const event of sqliteAdapter.runActivity(ctx, null)) {
        if (event.type === 'output' && event.name === COPY_PROGRESS_OUTPUT) break;
      }
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
    }
  });

  describe('Log mode (#1600 OR41 C6c-2)', () => {
    const src = (root: string, n = 3) => seedDb(root, n, 'src.db');
    const mapId = { mapping: [{ source: 'id', sink: 'id', type: 'integer' }] };
    const incomplete = (events: ActivityEvent[]) =>
      events.filter((e) => e.type === 'warned' && e.code === 'copy_session_log_incomplete');
    /** The log file's operations each time the copy flushed it. */
    const flushes = () => {
      const seen: string[][] = [];
      const real = SessionLogWriter.prototype.flushIfFull;
      const spy = vi
        .spyOn(SessionLogWriter.prototype, 'flushIfFull')
        .mockImplementation(async function (this: SessionLogWriter) {
          await real.call(this);
          seen.push(
            readFileSync(this.path, 'utf8')
              .split('\r\n')
              .slice(1)
              .filter((l) => l !== '')
              .map((l) => l.split(',')[2]!),
          );
        });
      return { seen, spy };
    };

    /**
     * The log opens for real, then every write to it fails, through the
     * writer's own seam. `flushBytes` 1 writes after every batch in either
     * mode, so a Best effort write fails mid-copy too.
     */
    const failingWrites = () => {
      const realOpen = SessionLogWriter.open.bind(SessionLogWriter);
      return vi.spyOn(SessionLogWriter, 'open').mockImplementation(async (dir, name, opts) => {
        const opened = await realOpen(dir, name, opts);
        if (!opened.ok) return opened;
        await opened.writer.close();
        const fh = {
          write: () => Promise.reject(new Error('disk full')),
          close: () => Promise.resolve(),
        };
        const writer = SessionLogWriter.over(fh, opened.writer.path, { ...opts, flushBytes: 1 });
        return { ok: true, writer };
      });
    };

    it.each([
      [
        'Reliable writes each batch read before the next',
        {},
        [['TabularRowSkip'], ['TabularRowSkip', 'TabularRowSkip']],
      ],
      ['Best effort holds the lines until 64 KiB, or the end', { logMode: 'bestEffort' }, [[], []]],
    ])('%s', async (_name, extra, expected) => {
      const root = tempRoot();
      const { seen, spy } = flushes();
      try {
        const events = await run(
          withLog(
            copyCtx({
              root,
              sourcePath: src(root, 2),
              sinkPath: seedSink(root, 'dst.db'),
              input: dropping({ writeBatchSize: 1, ...extra }),
            }),
          ),
        );
        expect(only(events)).toMatchObject({ type: 'succeeded' });
        // The last read finds no batch, so the reads flushed after are the two rows'.
        expect(seen.slice(0, 2)).toEqual(expected);
      } finally {
        spy.mockRestore();
      }
    });

    it('Reliable stops the copy and rolls it back once a write to the log fails', async () => {
      const root = tempRoot();
      const sinkPath = seedSink(root, 'dst.db');
      const spy = failingWrites();
      try {
        const events = await run(
          withLog(
            copyCtx({
              root,
              sourcePath: src(root),
              sinkPath,
              input: dropping({ writeBatchSize: 1, logLevel: 'info', ...mapId }),
            }),
          ),
        );
        expect(only(events)).toEqual({
          type: 'failed',
          kind: 'permanent',
          error: 'the session log could not be written: disk full',
        });
        expect(incomplete(events)).toEqual([]);
        expect(rowsOf(sinkPath)).toEqual([]);
      } finally {
        spy.mockRestore();
      }
    });

    it('Best effort keeps copying, commits and warns once a write to the log fails', async () => {
      const root = tempRoot();
      const sinkPath = seedSink(root, 'dst.db');
      const spy = failingWrites();
      try {
        const events = await run(
          withLog(
            copyCtx({
              root,
              sourcePath: src(root),
              sinkPath,
              input: dropping({
                writeBatchSize: 1,
                logLevel: 'info',
                logMode: 'bestEffort',
                ...mapId,
              }),
            }),
          ),
        );
        const end = only(events);
        expect(end).toMatchObject({ type: 'succeeded' });
        const logPath = end.type === 'succeeded' ? end.outputs['logPath'] : undefined;
        expect(logPath).toMatch(/session-log\..+\.csv$/);
        expect(incomplete(events)).toEqual([
          {
            type: 'warned',
            code: 'copy_session_log_incomplete',
            reason: `the session log '${String(logPath)}' could not be written, so it is missing lines (Best effort): disk full`,
          },
        ]);
        expect(rowsOf(sinkPath)).toHaveLength(3);
      } finally {
        spy.mockRestore();
      }
    });

    it('Best effort does not drain the log before COMMIT', async () => {
      const root = tempRoot();
      const sinkPath = seedSink(root, 'dst.db');
      const spy = vi.spyOn(SessionLogWriter.prototype, 'drain').mockResolvedValue('disk full');
      try {
        const events = await run(
          withLog(
            copyCtx({
              root,
              sourcePath: src(root, 2),
              sinkPath,
              input: dropping({ logMode: 'bestEffort', ...mapId }),
            }),
          ),
        );
        expect(only(events)).toMatchObject({ type: 'succeeded' });
        expect(incomplete(events)).toEqual([]);
        expect(spy).not.toHaveBeenCalled();
        expect(rowsOf(sinkPath)).toHaveLength(2);
      } finally {
        spy.mockRestore();
      }
    });

    it('Best effort warns, and keeps the rows, when the log cannot be closed', async () => {
      const root = tempRoot();
      const sinkPath = seedSink(root, 'dst.db');
      const spy = vi
        .spyOn(SessionLogWriter.prototype, 'close')
        .mockResolvedValue({ ok: false, error: 'disk full' });
      try {
        const events = await run(
          withLog(
            copyCtx({
              root,
              sourcePath: src(root, 2),
              sinkPath,
              input: dropping({ logMode: 'bestEffort', ...mapId }),
            }),
          ),
        );
        const end = only(events);
        expect(end).toMatchObject({ type: 'succeeded' });
        expect(end.type === 'succeeded' ? end.outputs['logPath'] : null).toMatch(/\.csv$/);
        expect(incomplete(events)).toHaveLength(1);
        expect(rowsOf(sinkPath)).toHaveLength(2);
      } finally {
        spy.mockRestore();
      }
    });

    it('still refuses the copy when the log cannot be opened', async () => {
      const root = tempRoot();
      const sinkPath = seedSink(root, 'dst.db');
      const events = await run(
        withLog(
          copyCtx({
            root,
            sourcePath: src(root, 2),
            sinkPath,
            input: dropping({ logMode: 'bestEffort', logFolder: 'missing', ...mapId }),
          }),
        ),
      );
      expect(only(events)).toMatchObject({ type: 'failed', kind: 'permanent' });
      expect(rowsOf(sinkPath)).toEqual([]);
    });
  });
});

describe('partitioned reads (#1600 OR41 C6f-3)', () => {
  const partitioned = {
    mapping: [
      { source: 'id', sink: 'id', type: 'integer' },
      { source: 'name', sink: 'name', type: 'string' },
    ],
    partitionOption: 'dynamicRange',
    partitionColumnName: 'id',
    parallelCopies: 3,
  };
  const outputsOf = (events: ActivityEvent[]) =>
    Object.fromEntries(
      events.flatMap((e) =>
        e.type === 'output'
          ? [[e.name, e.value]]
          : e.type === 'succeeded'
            ? Object.entries(e.outputs ?? {})
            : [],
      ),
    );

  it('refuses Dynamic range on a SQLite source before the sink writes anything', async () => {
    const root = tempRoot();
    const sinkPath = seedSink(root, 'dst.db');
    const events = await run(
      copyCtx({
        root,
        sourcePath: seedDb(root, 3, 'src.db'),
        sinkPath,
        input: {
          ...partitioned,
          preCopyScript: 'INSERT INTO sink (id, name) VALUES (99, :n)',
          preCopyScriptParameters: { n: 'x' },
        },
      }),
    );
    const end = terminal(events);
    expect(end.type).toBe('failed');
    expect(end.type === 'failed' ? end.error : '').toMatch(
      /Partition option Dynamic range reads a PostgreSQL table/,
    );
    expect(end.type === 'failed' ? end.kind : '').toBe('permanent');
    // The Pre-copy script never ran: the refusal is before the sink's transaction.
    expect(rowsOf(sinkPath)).toEqual([]);
  });

  function planningIo(over: { fail?: Error; sinkFails?: boolean }) {
    const log: string[] = [];
    const io: CopyIo = {
      describeSource: () => Promise.resolve(['id', 'name']),
      sourceCoercion: () => ({}),
      readBatches: async function* () {
        log.push('one reader');
        yield [{ id: 0, name: 'z' }];
      },
      planPartitions: ({ partition }) => {
        log.push(`plan ${partition.column} x${partition.degree}`);
        if (over.fail !== undefined) return Promise.reject(over.fail);
        return Promise.resolve({
          partitions: 2,
          batches: (async function* () {
            yield [{ id: 1, name: 'a' }];
            yield [{ id: 2, name: 'b' }];
          })(),
          close: () => {
            log.push('closed');
            return Promise.resolve();
          },
        });
      },
      writeRows: async ({ batches, onBatch }) => {
        log.push('write');
        if (over.sinkFails === true) throw new DatasetIoError('permanent', 'sink refused');
        let written = 0;
        for await (const batch of batches) {
          written += batch.length;
          onBatch(written);
        }
        return { rowsWritten: written };
      },
    };
    return { io, log };
  }
  const ctxFor = (input: unknown = partitioned): ActivityContext =>
    copyCtx({ root: tempRoot(), sourcePath: 'unused.db', sinkPath: 'unused-dst.db', input });
  const drain = async (ctx: ActivityContext, io: CopyIo) => {
    const events: ActivityEvent[] = [];
    for await (const e of runCopyActivity(ctx, io)) events.push(e);
    return events;
  };

  it('reads the planned ranges, not the one reader, and reports the ranges as usedParallelCopies', async () => {
    const { io, log } = planningIo({});
    const events = await drain(ctxFor(), io);
    expect(terminal(events).type).toBe('succeeded');
    expect(outputsOf(events)).toMatchObject({ rowsRead: 2, rowsWritten: 2, usedParallelCopies: 2 });
    expect(log).toEqual(['plan id x3', 'write', 'closed']);
  });

  it('plans before the write, so a planning refusal reaches no sink', async () => {
    const { io, log } = planningIo({
      fail: new DatasetIoError('permanent', "the partition column 'id' is text"),
    });
    const events = await drain(ctxFor(), io);
    const end = terminal(events);
    expect(end.type === 'failed' ? end.error : '').toMatch(/is text/);
    expect(log).toEqual(['plan id x3']);
  });

  it('releases the plan when the sink fails before it pulls a row, and still reports the ranges', async () => {
    const { io, log } = planningIo({ sinkFails: true });
    const events = await drain(ctxFor(), io);
    expect(terminal(events).type).toBe('failed');
    expect(log).toEqual(['plan id x3', 'write', 'closed']);
    expect(outputsOf(events)['usedParallelCopies']).toBe(2);
  });

  it('keeps one reader and one copy under None', async () => {
    const { io, log } = planningIo({});
    const events = await drain(ctxFor({ mapping: partitioned.mapping }), io);
    expect(outputsOf(events)['usedParallelCopies']).toBe(1);
    expect(log).toEqual(['write', 'one reader']);
  });
});

describe('copy activity — Load Incremental (#1600 OR41 C5a)', () => {
  const mapping = [
    { source: 'id', sink: 'id', type: 'integer' },
    { source: 'name', sink: 'name', type: 'string' },
  ];
  const incremental = (extra: Record<string, unknown>) => ({
    mapping,
    load: 'incremental',
    watermarkColumnName: 'id',
    ...extra,
  });
  const outputsOf = (events: ActivityEvent[]) =>
    Object.fromEntries(
      events.flatMap((e) =>
        e.type === 'output'
          ? [[e.name, e.value]]
          : e.type === 'succeeded'
            ? Object.entries(e.outputs ?? {})
            : [],
      ),
    );
  function stores(rows = 3) {
    const root = tempRoot();
    return { root, sourcePath: seedDb(root, rows, 'src.db'), sinkPath: seedSink(root, 'dst.db') };
  }
  const withWatermark = (ctx: ActivityContext, old: unknown, commit: (next: unknown) => void) =>
    ({ ...ctx, copyWatermark: { old, commit } }) as ActivityContext;

  it('Expression over a TEXT column: compares as text in the store, and reports the watermark', async () => {
    const s = stores();
    const events = await run(
      copyCtx({
        ...s,
        input: incremental({
          watermarkColumnName: 'name',
          watermarkFrom: 'expression',
          watermarkOld: 'row-1',
        }),
      }),
    );
    expect(terminal(events).type).toBe('succeeded');
    expect(rowsOf(s.sinkPath, 'SELECT id FROM sink ORDER BY id')).toEqual([{ id: 2 }, { id: 3 }]);
    expect(outputsOf(events)['watermark']).toEqual({ column: 'name', old: 'row-1', new: 'row-3' });
  });

  it('a Full copy reports no watermark', async () => {
    const s = stores();
    const events = await run(copyCtx({ ...s, input: { mapping } }));
    expect(terminal(events).type).toBe('succeeded');
    expect('watermark' in outputsOf(events)).toBe(false);
  });

  it('Automatic reads the stored watermark and commits the new one after the sink commits', async () => {
    const s = stores();
    const committed: unknown[] = [];
    const events = await run(
      withWatermark(copyCtx({ ...s, input: incremental({}) }), 1, (next) => {
        // The rows are already in the sink when the watermark moves.
        committed.push([next, rowsOf(s.sinkPath, 'SELECT count(*) AS n FROM sink')]);
      }),
    );
    expect(terminal(events).type).toBe('succeeded');
    expect(committed).toEqual([[3, [{ n: 2 }]]]);
    expect(outputsOf(events)['watermark']).toEqual({ column: 'id', old: 1, new: 3 });
  });

  it('Automatic without a stored watermark to read refuses rather than copying every row', async () => {
    const s = stores();
    const end = terminal(await run(copyCtx({ ...s, input: incremental({}) })));
    expect(end).toMatchObject({
      type: 'failed',
      kind: 'permanent',
      error: 'Watermark from Automatic has no stored watermark to read',
    });
    expect(rowsOf(s.sinkPath)).toEqual([]);
  });

  it('a watermark that cannot be stored fails the node, says the rows are committed, and keeps the outputs', async () => {
    const s = stores();
    const events = await run(
      withWatermark(copyCtx({ ...s, input: incremental({}) }), null, () => {
        throw new Error('disk I/O error');
      }),
    );
    const end = terminal(events);
    expect(end.type).toBe('failed');
    expect(end.type === 'failed' ? end.error : '').toBe(
      'the rows were committed, but the watermark could not be stored, so the next run copies them again: disk I/O error',
    );
    expect(rowsOf(s.sinkPath, 'SELECT count(*) AS n FROM sink')).toEqual([{ n: 3 }]);
    expect(outputsOf(events)).toMatchObject({
      rowsWritten: 3,
      watermark: { column: 'id', old: null, new: 3 },
    });
  });

  it('nothing above the old watermark reads nothing and keeps it', async () => {
    const s = stores();
    const committed: unknown[] = [];
    const events = await run(
      withWatermark(copyCtx({ ...s, input: incremental({}) }), 3, (next) => committed.push(next)),
    );
    expect(terminal(events).type).toBe('succeeded');
    expect(outputsOf(events)).toMatchObject({ rowsRead: 0, watermark: { old: 3, new: 3 } });
    expect(committed).toEqual([3]);
  });

  it.each([
    ['an integer past 2^53', "INSERT INTO t VALUES (9007199254740993, 'big')", /past 2\^53/],
    ['a blob', "UPDATE t SET name = x'00' WHERE id = 3", /holds a blob/],
  ])('refuses %s as a watermark before the sink writes', async (_label, sql, message) => {
    const s = stores();
    const db = new Database(s.sourcePath);
    db.exec(sql);
    db.close();
    const column = sql.includes('blob') || sql.includes("x'00'") ? 'name' : 'id';
    const end = terminal(
      await run(
        copyCtx({
          ...s,
          input: incremental({
            watermarkColumnName: column,
            watermarkFrom: 'expression',
            watermarkOld: null,
            preCopyScript: 'INSERT INTO sink (id) VALUES (99)',
          }),
        }),
      ),
    );
    expect(end.type === 'failed' ? end.error : '').toMatch(message);
    expect(rowsOf(s.sinkPath)).toEqual([]);
  });

  it('refuses a column the source does not have before the sink writes', async () => {
    const s = stores();
    const end = terminal(
      await run(
        copyCtx({
          ...s,
          input: incremental({
            watermarkColumnName: 'nope',
            watermarkFrom: 'expression',
            watermarkOld: 1,
          }),
        }),
      ),
    );
    expect(end).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect(end.type === 'failed' ? end.error : '').toMatch(/watermark column 'nope'/);
    expect(rowsOf(s.sinkPath)).toEqual([]);
  });

  it('refuses Load Incremental on a source with no incremental read (a file)', async () => {
    const io: CopyIo = {
      describeSource: () => Promise.resolve(['id', 'name']),
      sourceCoercion: () => ({}),
      readBatches: async function* () {
        yield [{ id: 1, name: 'a' }];
      },
      writeRows: () => Promise.reject(new Error('the sink must not be reached')),
    };
    const events: ActivityEvent[] = [];
    const ctx = copyCtx({
      root: tempRoot(),
      sourcePath: 'unused.db',
      sinkPath: 'unused-dst.db',
      input: incremental({ watermarkFrom: 'expression', watermarkOld: 1 }),
    });
    for await (const e of runCopyActivity(ctx, io)) events.push(e);
    expect(terminal(events)).toMatchObject({
      type: 'failed',
      kind: 'permanent',
      error: INCREMENTAL_NEEDS_DATABASE,
    });
  });
});
