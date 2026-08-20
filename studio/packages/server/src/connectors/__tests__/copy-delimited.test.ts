import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { COPY_ACTIVITY_TYPE, type DatasetColumn } from '@autonomy-studio/shared';
import { fsAdapter } from '../fs.js';
import type { ActivityContext, ActivityEvent } from '../types.js';
import { cleanupTempRoots, rowsOf, seedSink, tempRoot, writableConfig } from './sqlite-fixtures.js';

/**
 * #996 M7 slice 3 (#1167) — THE HETEROGENEOUS COPY: a real CSV file, through the
 * `fs` adapter, into a real SQLite table. The thing M7 exists to prove.
 *
 * REAL FILES AND A REAL DATABASE on both ends, for `copy-pipeline.test.ts`'s
 * stated reason: what is only true here is the composition — the reader's raw
 * strings meeting the pump's coercion meeting the sink's transaction — and a
 * fake at any of the three would test itself.
 *
 * WHAT IS DELIBERATELY NOT RE-TESTED. The row grammar (`shared`'s
 * `delimited.test.ts`), the reader's own confinement/decoding/handle contract
 * (`delimited-io.test.ts`), the refusal LADDER and the five-output terminal
 * contract (`copy-activity.test.ts`, which proves them once at the adapter
 * boundary and is not store-specific). What only this suite can reach is the
 * pairing of an `fs` SOURCE with a `sqlite` SINK, which no other suite has both
 * ends of.
 *
 * The local `copyCtx` is NOT `copy-activity.test.ts`'s, and the difference is
 * the whole subject rather than drift: that one builds a `sqlite`→`sqlite` pair,
 * so BOTH its connection configs are `writableConfig` and both its datasets are
 * `table`. Here the source connection is an `fs` root (no `path`, no `writable`
 * gate) and the source dataset is `delimited`. Generalising one builder over
 * both would take a parameter for nearly every field it sets.
 */

afterEach(cleanupTempRoots);

/** A CSV file under `root`. Returns the path the dataset config names. */
function seedCsv(root: string, body: string, name = 'src.csv'): string {
  const path = join(root, name);
  writeFileSync(path, body, 'utf8');
  return path;
}

const column = (name: string, nullable: boolean): DatasetColumn => ({
  name,
  type: 'string',
  nullable,
});

function copyCtx(over: {
  root: string;
  csvPath: string;
  sinkPath: string;
  sourceConfig?: Record<string, unknown>;
  input?: unknown;
  sinkColumns?: DatasetColumn[];
  sinkKind?: string;
  sinkTable?: string;
}): ActivityContext {
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
    // The SOURCE connection is the `fs` one — roots only. A `delimited` dataset
    // names its file inside them, so there is no per-connection `path`.
    connectionConfig: { roots: [over.root] },
    sink: {
      kind: over.sinkKind ?? 'sqlite',
      connectionConfig: writableConfig(over.root, over.sinkPath),
    },
    datasets: {
      source: {
        id: 'ds-1',
        name: 'src.csv',
        kind: 'delimited',
        config: over.sourceConfig ?? { path: over.csvPath, header: true },
        columns: [],
      },
      sink: {
        id: 'ds-2',
        name: 'dst',
        kind: 'table',
        config: { table: over.sinkTable ?? 'sink' },
        columns: over.sinkColumns ?? [],
      },
    },
    signal: new AbortController().signal,
  } as unknown as ActivityContext;
}

async function run(ctx: ActivityContext): Promise<ActivityEvent[]> {
  const events: ActivityEvent[] = [];
  for await (const event of fsAdapter.runActivity(ctx, null)) events.push(event);
  return events;
}

const terminal = (events: ActivityEvent[]): ActivityEvent =>
  events[events.length - 1] as ActivityEvent;

const outputsOf = (events: ActivityEvent[]): unknown => {
  const end = terminal(events);
  return end.type === 'succeeded' ? end.outputs : end;
};

describe('CSV -> SQLite, end to end', () => {
  it('copies a CSV into a sqlite table and reports the five outputs', async () => {
    const root = tempRoot('copy-delim-');
    const csvPath = seedCsv(root, 'id,name\n1,ada\n2,grace\n');
    const sinkPath = seedSink(root, 'dst.db');

    const events = await run(copyCtx({ root, csvPath, sinkPath }));

    expect(events.filter((e) => e.type === 'succeeded' || e.type === 'failed')).toHaveLength(1);
    expect(outputsOf(events)).toEqual({
      rowsRead: 2,
      rowsWritten: 2,
      rowsFailed: 0,
      // The RAW bytes the reader materialised — charged before coercion, so it
      // stays a fact about the source file rather than about the sink's types.
      bytesRead: expect.any(Number),
      truncated: false,
    });
    // The rows actually landed, in the SINK store, typed the way the mapping
    // declared: `id` as an INTEGER, not the string the CSV carried.
    expect(rowsOf(sinkPath, 'SELECT id, name FROM sink ORDER BY rowid')).toEqual([
      { id: 1, name: 'ada' },
      { id: 2, name: 'grace' },
    ]);
  });

  it('names a headerless file positionally', async () => {
    const root = tempRoot('copy-delim-');
    const csvPath = seedCsv(root, '7,turing\n');
    const sinkPath = seedSink(root, 'dst.db');

    const events = await run(
      copyCtx({
        root,
        csvPath,
        sinkPath,
        sourceConfig: { path: csvPath, header: false },
        input: {
          mapping: [
            { source: 'column1', sink: 'id', type: 'integer' },
            { source: 'column2', sink: 'name', type: 'string' },
          ],
        },
      }),
    );

    expect(terminal(events).type).toBe('succeeded');
    expect(rowsOf(sinkPath, 'SELECT id, name FROM sink')).toEqual([{ id: 7, name: 'turing' }]);
  });
});

describe('the dataset’s coercion options reach the pump', () => {
  it('applies `nullValue`, so a sentinel field lands as a real NULL', async () => {
    const root = tempRoot('copy-delim-');
    // `\N` is postgres/mysql's export sentinel and the one operators actually
    // meet. Without the coercion channel it copies as the literal TEXT '\N'.
    const csvPath = seedCsv(root, 'id,name\n1,\\N\n2,grace\n');
    const sinkPath = seedSink(root, 'dst.db');

    const events = await run(
      copyCtx({
        root,
        csvPath,
        sinkPath,
        sourceConfig: { path: csvPath, header: true, nullValue: '\\N' },
      }),
    );

    expect(terminal(events).type).toBe('succeeded');
    expect(rowsOf(sinkPath, 'SELECT id, name FROM sink ORDER BY rowid')).toEqual([
      { id: 1, name: null },
      { id: 2, name: 'grace' },
    ]);
  });

  it('applies `dateFormat`, so a textual date parses instead of failing its row', async () => {
    const root = tempRoot('copy-delim-');
    const csvPath = seedCsv(root, 'id,when\n1,03/02/2026\n');
    const sinkPath = seedSink(root, 'dst.db');

    const events = await run(
      copyCtx({
        root,
        csvPath,
        sinkPath,
        sourceConfig: { path: csvPath, header: true, dateFormat: 'dd/MM/yyyy' },
        input: {
          mapping: [
            { source: 'id', sink: 'id', type: 'integer' },
            { source: 'when', sink: 'note', type: 'date' },
          ],
        },
      }),
    );

    expect(terminal(events).type).toBe('succeeded');
    expect(outputsOf(events)).toMatchObject({ rowsWritten: 1, rowsFailed: 0 });
    expect(rowsOf(sinkPath, 'SELECT note FROM sink')).toEqual([{ note: '2026-02-03' }]);
  });

  it('without `dateFormat` a date target fails the ROW rather than guessing', async () => {
    // The polarity that makes the two tests above mean something: the channel
    // carries a real decision, so an ABSENT `dateFormat` must still refuse.
    const root = tempRoot('copy-delim-');
    const csvPath = seedCsv(root, 'id,when\n1,03/02/2026\n');
    const sinkPath = seedSink(root, 'dst.db');

    const events = await run(
      copyCtx({
        root,
        csvPath,
        sinkPath,
        input: {
          mapping: [
            { source: 'id', sink: 'id', type: 'integer' },
            { source: 'when', sink: 'note', type: 'date' },
          ],
        },
      }),
    );

    expect(terminal(events).type).toBe('succeeded');
    expect(outputsOf(events)).toMatchObject({ rowsRead: 1, rowsWritten: 0, rowsFailed: 1 });
    const warned = events.find((e) => e.type === 'warned');
    expect(warned && 'reason' in warned ? warned.reason : '').toContain('no_date_format');
  });
});

describe('the refusals a CSV source brings', () => {
  it('refuses a sink connection that is not a sqlite store', async () => {
    const root = tempRoot('copy-delim-');
    const events = await run(
      copyCtx({
        root,
        csvPath: seedCsv(root, 'id,name\n1,ada\n'),
        sinkPath: seedSink(root, 'dst.db'),
        sinkKind: 'http',
      }),
    );

    const end = terminal(events);
    expect(end.type).toBe('failed');
    expect(end.type === 'failed' ? end.error : '').toMatch(/sink connection is 'http'/);
  });

  it('refuses a mapping naming a column the header lacks, BEFORE the sink is opened', async () => {
    const root = tempRoot('copy-delim-');
    const sinkPath = seedSink(root, 'dst.db');
    const events = await run(
      copyCtx({
        root,
        csvPath: seedCsv(root, 'id,name\n1,ada\n'),
        sinkPath,
        input: {
          mapping: [
            { source: 'id', sink: 'id', type: 'integer' },
            { source: 'nope', sink: 'name', type: 'string' },
          ],
        },
      }),
    );

    const end = terminal(events);
    expect(end.type).toBe('failed');
    expect(end.type === 'failed' ? end.error : '').toContain('missing_source_column');
    // The gate ran BEFORE the write: nothing reached the store.
    expect(rowsOf(sinkPath, 'SELECT count(*) AS n FROM sink')).toEqual([{ n: 0 }]);
  });

  it('drops one unusable row without destroying the copy (#1155)', async () => {
    const root = tempRoot('copy-delim-');
    const csvPath = seedCsv(root, 'id,name\n1,ada\nnot-a-number,grace\n3,hopper\n');
    const sinkPath = seedSink(root, 'dst.db');

    const events = await run(copyCtx({ root, csvPath, sinkPath }));

    expect(terminal(events).type).toBe('succeeded');
    expect(outputsOf(events)).toMatchObject({ rowsRead: 3, rowsWritten: 2, rowsFailed: 1 });
    expect(rowsOf(sinkPath, 'SELECT id FROM sink ORDER BY rowid')).toEqual([{ id: 1 }, { id: 3 }]);
  });

  it("refuses onError:'null' against a sink column the dataset declares NOT NULL", async () => {
    // The ladder's rung, reached through the `fs` arm — proving the arm supplies
    // the ladder rather than reimplementing part of it.
    const root = tempRoot('copy-delim-');
    const events = await run(
      copyCtx({
        root,
        csvPath: seedCsv(root, 'id,name\n1,ada\n'),
        sinkPath: seedSink(root, 'dst.db'),
        sinkColumns: [column('name', false)],
        input: {
          mapping: [{ source: 'name', sink: 'name', type: 'string', onError: 'null' }],
        },
      }),
    );

    const end = terminal(events);
    expect(end.type).toBe('failed');
    expect(end.type === 'failed' ? end.error : '').toMatch(/NOT NULL/);
  });

  it('refuses a CSV outside the connection roots', async () => {
    const root = tempRoot('copy-delim-');
    const outside = tempRoot('copy-delim-out-');
    const events = await run(
      copyCtx({
        root,
        csvPath: seedCsv(outside, 'id,name\n1,ada\n'),
        sinkPath: seedSink(root, 'dst.db'),
      }),
    );

    const end = terminal(events);
    expect(end.type).toBe('failed');
    expect(end.type === 'failed' ? end.kind : '').toBe('permanent');
  });

  it('writes into the SINK store, never the source connection root', async () => {
    // The `fs` arm parses the sink connection from `ctx.sink`, never from its
    // own: a fallback to the source would be the one silently-wrong answer.
    const root = tempRoot('copy-delim-');
    const other = tempRoot('copy-delim-sink-');
    const sinkPath = join(other, 'dst.db');
    const db = new Database(sinkPath);
    db.exec('CREATE TABLE sink (id INTEGER, name TEXT)');
    db.close();

    const events = await run({
      ...copyCtx({ root, csvPath: seedCsv(root, 'id,name\n1,ada\n'), sinkPath }),
      sink: { kind: 'sqlite', connectionConfig: writableConfig(other, sinkPath) },
    } as unknown as ActivityContext);

    expect(terminal(events).type).toBe('succeeded');
    expect(rowsOf(sinkPath, 'SELECT id, name FROM sink')).toEqual([{ id: 1, name: 'ada' }]);
  });
});
