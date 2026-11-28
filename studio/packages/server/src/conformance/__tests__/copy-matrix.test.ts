import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BAD_ROW_IDS,
  CANONICAL_COLUMNS,
  CANONICAL_ROWS,
  ENDPOINT_STORES,
  dropPostgresSchemas,
  mappingFor,
  needsPostgres,
  postgresAvailable,
  type EndpointStore,
  type SourceFixture,
} from '../backends.js';
import { copyEndpoints, type CopyEndpoint } from '../copy-endpoints.js';
import { createHarness, onlyOutputs, type Harness, type RunResult } from '../harness.js';

/**
 * #1574 OR39 — the COPY SOURCE × SINK matrix.
 *
 * Every source endpoint × every sink endpoint the catalog and the stores allow
 * (`copy-endpoints.ts`), each cell a real Copy run through the app. A cell
 * proves, for its pair:
 *  - row counts (`rowsRead`/`rowsWritten`/`rowsFailed` and the rows landed);
 *  - coercion of string / integer / number / boolean / date / null, by reading
 *    the sink back with a reader that is not studio's (`backends.ts`);
 *  - unicode (the canonical names are accented, CJK and astral);
 *  - empty input;
 *  - one bad row, counted in `rowsFailed`, with the others landed;
 *  - append vs overwrite.
 * A separate block runs parallel copies into one store per sink.
 *
 * Cell ids are `copy/<source>→<sink>`; `adf-parity.ts` links to them.
 */

const { sources, sinks } = copyEndpoints();
const PG = postgresAvailable();

/** Whether a cell can run here: postgres cells skip only off CI (`postgresAvailable`). */
const runnable = (...endpoints: string[]): boolean => PG || !endpoints.some(needsPostgres);

export const copyCellId = (source: CopyEndpoint, sink: CopyEndpoint): string =>
  `copy/${source}→${sink}`;

describe('the copy matrix covers every endpoint the catalog allows', () => {
  it('has a store for every derived source and sink endpoint, and none stale', () => {
    const derived = [...new Set([...sources, ...sinks])].sort();
    expect(Object.keys(ENDPOINT_STORES).sort()).toEqual(derived);
  });

  it('covers the pairs the ticket names, in both directions where writable', () => {
    for (const s of ['fs:delimited', 'fs:excel', 'sqlite:table', 'postgres:table']) {
      expect(sources).toContain(s);
    }
    for (const s of ['fs:delimited', 'sqlite:table', 'postgres:table']) expect(sinks).toContain(s);
    // Excel is read-only: no excel writer exists, so it is never a sink.
    expect(sinks).not.toContain('fs:excel');
  });
});

let h: Harness;
const stores = new Map<string, EndpointStore>();

beforeAll(async () => {
  h = await createHarness();
  for (const endpoint of Object.keys(ENDPOINT_STORES)) {
    if (!runnable(endpoint)) continue;
    stores.set(endpoint, await ENDPOINT_STORES[endpoint]!(h));
  }
});
afterAll(async () => {
  await h?.close();
  if (PG) await dropPostgresSchemas();
});

const store = (endpoint: string): EndpointStore => {
  const s = stores.get(endpoint);
  if (s === undefined) throw new Error(`no store opened for ${endpoint}`);
  return s;
};

interface CopyRun {
  result: RunResult;
  sinkAddress: Awaited<ReturnType<NonNullable<EndpointStore['sinkAddress']>>>;
}

async function copyOnce(
  source: CopyEndpoint,
  sink: CopyEndpoint,
  fixture: SourceFixture,
  opts: {
    mode?: 'append' | 'overwrite';
    sinkAddress?: CopyRun['sinkAddress'];
    config?: Record<string, unknown>;
  } = {},
): Promise<CopyRun> {
  const src = store(source);
  const dst = store(sink);
  const planted = await src.plant(fixture);
  const sinkAddress = opts.sinkAddress ?? (await dst.sinkAddress!());
  const sourceDatasetId = await h.createDataset({
    connectionId: src.connectionId,
    kind: planted.kind,
    config: planted.config,
  });
  const sinkDatasetId = await h.createDataset({
    connectionId: dst.connectionId,
    kind: sinkAddress.kind,
    config: sinkAddress.config,
    columns: CANONICAL_COLUMNS,
  });
  const result = await h.runDoc({
    nodes: [
      {
        id: 'copy',
        type: 'copy',
        position: { x: 0, y: 0 },
        connectionIds: { source: src.connectionId, sink: dst.connectionId },
        datasetIds: { source: sourceDatasetId, sink: sinkDatasetId },
        config: { mapping: mappingFor(planted), mode: opts.mode ?? 'overwrite', ...opts.config },
      },
    ],
  });
  return { result, sinkAddress };
}

const isFileSink = (sink: string): boolean => sink.startsWith('fs:');

/**
 * Sources that REFUSE an empty input, on purpose: a JSON or JSON Lines file
 * names its columns by its first record's keys (`json-io.ts`), so a file with
 * no records has no columns to map. The cell pins the refusal and its reason.
 */
const EMPTY_INPUT_REFUSED: ReadonlySet<string> = new Set(['fs:json', 'fs:jsonl']);

describe.each(sources)('copy from %s', (source) => {
  describe.each(sinks)(`to %s`, (sink) => {
    const cell = copyCellId(source, sink);
    const run = runnable(source, sink) ? it : it.skip;

    run(`${cell} — rows, counts and every type land as written (unicode, null)`, async () => {
      const { result, sinkAddress } = await copyOnce(source, sink, 'canonical');
      expect(onlyOutputs(result, 'copy')).toMatchObject({
        rowsRead: 3,
        rowsWritten: 3,
        rowsFailed: 0,
      });
      expect(result.status).toBe('success');
      expect(await store(sink).readBack!(sinkAddress)).toEqual(CANONICAL_ROWS);
      // The activity-runs table reports the same counts the outputs do.
      expect(result.activityRuns.find((r) => r.activityId === 'copy')).toMatchObject({
        status: 'success',
        rowsRead: 3,
        rowsWritten: 3,
      });
    });

    run(`${cell} — empty input copies nothing (JSON sources refuse it, saying why)`, async () => {
      const { result, sinkAddress } = await copyOnce(source, sink, 'empty');
      if (EMPTY_INPUT_REFUSED.has(source)) {
        expect(result.status).toBe('failure');
        expect(result.failures.get('copy')?.join(' ')).toMatch(/holds no records/);
        return;
      }
      expect(onlyOutputs(result, 'copy')).toMatchObject({
        rowsRead: 0,
        rowsWritten: 0,
        rowsFailed: 0,
      });
      expect(await store(sink).readBack!(sinkAddress)).toEqual([]);
    });

    run(`${cell} — a bad row is counted in rowsFailed and the rest land`, async () => {
      const { result, sinkAddress } = await copyOnce(source, sink, 'badRow', {
        config: { skipIncompatibleRows: true },
      });
      expect(onlyOutputs(result, 'copy')).toMatchObject({
        rowsRead: BAD_ROW_IDS.length,
        rowsWritten: 2,
        rowsFailed: 1,
      });
      expect((await store(sink).readBack!(sinkAddress)).map((r) => r.id)).toEqual([1, 3]);
    });

    run(`${cell} — append adds to what is there; overwrite replaces it`, async () => {
      const first = await copyOnce(source, sink, 'canonical', { mode: 'overwrite' });
      const again = await copyOnce(source, sink, 'canonical', {
        mode: 'append',
        sinkAddress: first.sinkAddress,
      });
      if (isFileSink(sink)) {
        // A file sink's Append writes a NEW file and refuses to replace one.
        expect(again.result.status).toBe('failure');
        expect(again.result.failures.get('copy')?.join(' ')).toMatch(/already exists/);
        expect(await store(sink).readBack!(first.sinkAddress)).toEqual(CANONICAL_ROWS);
      } else {
        expect(again.result.status).toBe('success');
        expect(await store(sink).readBack!(first.sinkAddress)).toHaveLength(6);
      }
      const replaced = await copyOnce(source, sink, 'canonical', {
        mode: 'overwrite',
        sinkAddress: first.sinkAddress,
      });
      expect(replaced.result.status).toBe('success');
      expect(await store(sink).readBack!(first.sinkAddress)).toEqual(CANONICAL_ROWS);
    });
  });
});

describe.each(sinks)('parallel copies into one %s store', (sink) => {
  const run = runnable(sink, 'sqlite:table') ? it : it.skip;

  run(`copy/parallel→${sink} — three parallel ForEach items all land`, async () => {
    const src = store('sqlite:table');
    const dst = store(sink);
    const planted = await src.plant('canonical');
    const sourceDatasetId = await h.createDataset({
      connectionId: src.connectionId,
      kind: planted.kind,
      config: planted.config,
    });
    const base = await dst.sinkAddress!();
    const perFile = isFileSink(sink);
    const sinkDatasetId = await h.createDataset({
      connectionId: dst.connectionId,
      kind: base.kind,
      config: base.config,
      columns: CANONICAL_COLUMNS,
      ...(perFile ? { parameters: ['path'] } : {}),
    });
    const path = String(base.config['path'] ?? '');
    const itemPath = (item: string): string => path.replace(/(\.[a-z]+)$/, `-${item}$1`);
    const result = await h.runDoc({
      nodes: [
        {
          id: 'copy',
          type: 'copy',
          position: { x: 0, y: 0 },
          connectionIds: { source: src.connectionId, sink: dst.connectionId },
          datasetIds: { source: sourceDatasetId, sink: sinkDatasetId },
          config: { mapping: mappingFor(planted), mode: 'append' },
          ...(perFile
            ? { datasetParams: { sink: { path: path.replace(/(\.[a-z]+)$/, '-${item}$1') } } }
            : {}),
        },
      ],
      containers: [
        {
          id: 'each',
          kind: 'foreach',
          children: ['copy'],
          items: "${createArray('a', 'b', 'c')}",
          batchCount: 3,
        },
      ],
    });
    expect(result.status).toBe('success');
    const copies = result.activityRuns.filter((r) => r.activityId === 'copy');
    expect(copies).toHaveLength(3);
    expect(copies.every((r) => r.status === 'success' && r.rowsWritten === 3)).toBe(true);
    if (perFile) {
      for (const item of ['a', 'b', 'c']) {
        expect(
          await dst.readBack!({ kind: base.kind, config: { ...base.config, path: itemPath(item) } }),
        ).toEqual(CANONICAL_ROWS);
      }
    } else {
      expect(await dst.readBack!(base)).toHaveLength(9);
    }
  });
});
