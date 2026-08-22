import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { COPY_ACTIVITY_TYPE, type DatasetColumn } from '@autonomy-studio/shared';
import { fsAdapter } from '../fs.js';
import type { ActivityContext, ActivityEvent } from '../types.js';
import { buildXlsx, type WorkbookSpec } from './xlsx-fixtures.js';
import { cleanupTempRoots, rowsOf, seedSink, tempRoot, writableConfig } from './sqlite-fixtures.js';

/**
 * #996 M11 slice 2 (#1215) — a real `.xlsx`, through the `fs` adapter, into a
 * real SQLite table, and the FORK that now chooses between the two fs readers.
 *
 * `copy-delimited.test.ts`'s subject with the other source kind, and its
 * argument for real ends on both sides applies unchanged: what is only true
 * here is the composition, and a fake at any of the three layers would test
 * itself.
 *
 * WHAT ONLY THIS SUITE CAN REACH is the fork. `excel-io.test.ts` proves the
 * reader; `fs.ts`'s `fsReaderFor` is what decides a workbook is not handed to
 * the CSV parser, and it has FOUR consumers (address, describe, batches,
 * coercion) that a partial fork would leave disagreeing with each other.
 */

afterEach(cleanupTempRoots);

const text = (t: string) => ({ kind: 'inline', text: t }) as const;
const num = (value: number) => ({ kind: 'number', value }) as const;

function seedBook(root: string, spec: WorkbookSpec, name = 'src.xlsx'): string {
  const path = join(root, name);
  writeFileSync(path, buildXlsx(spec));
  return path;
}

const column = (name: string, nullable: boolean): DatasetColumn =>
  ({ name, type: name === 'id' ? 'integer' : 'string', nullable }) as DatasetColumn;

function copyCtx(over: {
  root: string;
  sinkPath: string;
  sourceKind?: string;
  sourceConfig?: Record<string, unknown>;
  sinkColumns?: DatasetColumn[];
}): ActivityContext {
  return {
    runId: 'run-1',
    nodeId: 'n1',
    attemptId: 'a1',
    activityType: COPY_ACTIVITY_TYPE,
    input: {
      mapping: [
        { source: 'id', sink: 'id', type: 'integer' },
        { source: 'name', sink: 'name', type: 'string' },
      ],
    },
    connectionConfig: { roots: [over.root] },
    sink: { kind: 'sqlite', connectionConfig: writableConfig(over.root, over.sinkPath) },
    datasets: {
      source: {
        id: 'ds-1',
        name: 'src.xlsx',
        kind: over.sourceKind ?? 'excel',
        config: over.sourceConfig ?? {},
        columns: [],
      },
      sink: {
        id: 'ds-2',
        name: 'dst',
        kind: 'table',
        config: { table: 'sink' },
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

describe('Excel -> SQLite, end to end', () => {
  it('copies a real workbook into a real table', async () => {
    const root = tempRoot('copy-excel');
    const sinkPath = seedSink(root, 'dst.db');
    const path = seedBook(root, {
      sheets: [
        {
          name: 'People',
          rows: [
            [text('id'), text('name')],
            [num(1), text('alpha')],
            [num(2), text('beta')],
          ],
        },
      ],
    });

    const events = await run(
      copyCtx({
        root,
        sinkPath,
        sourceConfig: { path, header: true, sheet: 'People' },
        sinkColumns: [column('id', false), column('name', true)],
      }),
    );
    const end = terminal(events);
    expect(end.type).toBe('succeeded');
    expect(end.type === 'succeeded' ? end.outputs : null).toMatchObject({
      rowsRead: 2,
      rowsWritten: 2,
      rowsFailed: 0,
      truncated: false,
    });
    expect(rowsOf(sinkPath, 'SELECT id, name FROM sink ORDER BY rowid')).toEqual([
      { id: 1, name: 'alpha' },
      { id: 2, name: 'beta' },
    ]);
  });

  it("routes by the dataset's KIND, so a workbook is never read by the CSV parser", async () => {
    // The fork's whole subject. Mis-routed, this refuses with a message about a
    // delimiter or — worse, before the kind guards existed — parses zip bytes
    // as text. The refusal must name the DELIMITED reader, which is what says
    // the routing (not the store) is what went wrong.
    const root = tempRoot('copy-excel-fork');
    const sinkPath = seedSink(root, 'dst.db');
    const path = seedBook(root, {
      sheets: [{ name: 'People', rows: [[text('id'), text('name')], [num(1), text('alpha')]] }],
    });

    const events = await run(
      copyCtx({
        root,
        sinkPath,
        sourceKind: 'delimited',
        sourceConfig: { path, header: true },
        sinkColumns: [column('id', false), column('name', true)],
      }),
    );
    const end = terminal(events);
    expect(end.type).toBe('failed');
    // MEASURED: a zip's bytes are not valid UTF-8, so `delimited-io`'s
    // `{ fatal: true }` decoder refuses rather than producing replacement
    // characters — which is what makes a mis-route DIAGNOSABLE rather than a
    // silently wrong copy. That decoder is the only thing standing there, and
    // it is the reason this test asserts the encoding refusal specifically: a
    // laxer decoder would have written U+FFFD into the sink and SUCCEEDED.
    expect(end.type === 'failed' ? end.error : '').toMatch(/not valid utf-8/);
  });

  it('refuses a dataset kind NEITHER fs reader handles, naming both', async () => {
    const root = tempRoot('copy-excel-foreign');
    const sinkPath = seedSink(root, 'dst.db');
    const events = await run(
      copyCtx({
        root,
        sinkPath,
        sourceKind: 'table',
        sourceConfig: { table: 'orders' },
        sinkColumns: [column('id', false), column('name', true)],
      }),
    );
    const end = terminal(events);
    expect(end.type).toBe('failed');
    expect(end.type === 'failed' ? end.error : '').toContain(
      "the fs store reads 'delimited' and 'excel' datasets; this one is 'table'",
    );
  });

  it("carries the dataset's own §6.4 coercion options through the fork", async () => {
    // `sourceCoercion` is one of the four seams the fork feeds. A partial fork
    // would hand `delimitedCoercionFor` an excel config here, which refuses —
    // so this proves the excel projection is what reached the pump.
    const root = tempRoot('copy-excel-coerce');
    const sinkPath = seedSink(root, 'dst.db');
    const path = seedBook(root, {
      sheets: [
        {
          name: 'People',
          rows: [[text('id'), text('name')], [num(1), text('\\N')], [num(2), text('beta')]],
        },
      ],
    });

    const events = await run(
      copyCtx({
        root,
        sinkPath,
        sourceConfig: { path, header: true, sheet: 'People', nullValue: '\\N' },
        sinkColumns: [column('id', false), column('name', true)],
      }),
    );
    expect(terminal(events).type).toBe('succeeded');
    expect(rowsOf(sinkPath, 'SELECT id, name FROM sink ORDER BY rowid')).toEqual([
      { id: 1, name: null },
      { id: 2, name: 'beta' },
    ]);
  });

  it('resolves the workbook ADDRESS through the fork too', async () => {
    const root = tempRoot('copy-excel-address');
    const path = seedBook(root, { sheets: [{ name: 'S', rows: [[text('a')]] }] });
    const address = await fsAdapter.resolveDatasetAddress?.({
      connectionConfig: { roots: [root] },
      dataset: {
        id: 'ds-1',
        name: 'src.xlsx',
        kind: 'excel',
        config: { path, header: true, sheet: 'S' },
        columns: [],
      },
      secret: null,
    } as never);
    expect(address).toMatchObject({ kind: 'fs', store: path, object: path });
  });
});
