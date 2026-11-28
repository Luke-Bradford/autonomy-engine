import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ConnectionKindSchema,
  catalog,
  type ActivityCatalog,
  type ConnectionKind,
} from '@autonomy-studio/shared';
import { createConnectorRegistry } from '../../connectors/registry.js';
import { createSupervisor } from '../../workers/process-supervisor.js';
import { CANONICAL_ROWS, needsPostgres, postgresAvailable } from '../backends.js';
import {
  BASE_NODES,
  benchPath,
  canonicalDataset,
  connectionOf,
  openBench,
  type Bench,
} from '../bench.js';
import { requiredConnectorCells, type Capability } from '../connector-cells.js';
import { FIXTURE_COMPLETION } from '../fixture-server.js';
import { onlyOutputs, type RunResult } from '../harness.js';

/**
 * #1574 OR39 — the CONNECTOR × CAPABILITY matrix: every connection kind, every
 * capability it declares, each cell a real run (or a real route call) against
 * a real backend: a folder, a SQLite file, the CI Postgres, a local HTTP server
 * playing the http target and the three hosted LLM APIs, and a real child
 * process for `agent_cli`.
 *
 * The table is keyed by `ConnectionKind`, so a kind added to the enum without a
 * row fails typecheck; the guard below fails the suite on any capability the
 * registry and catalog declare (`connector-cells.ts`) that has no cell here.
 * Cell ids are `<kind>/<capability>`; `adf-parity.ts` links to them.
 */

type Cell =
  /** A probe through the route; `probed` is the question it answered. */
  | { readonly probe: 'draft' | 'saved'; readonly probed: 'liveness' | 'config' }
  /** `BASE_NODES[activity]` on this kind, run to success, then `check`ed. */
  | {
      readonly run: string;
      readonly check?: (outputs: Record<string, unknown>, bench: Bench, r: RunResult) => void;
    }
  /** This kind as the SINK of a paired activity. */
  | { readonly sink: 'copy' | 'copy_files' }
  /** This kind as the session log's connection. */
  | { readonly log: 'copy' | 'copy_files' }
  | { readonly dataset: 'preview' | 'schema' };

const llm = (probed: 'liveness' | 'config'): Partial<Record<Capability, Cell>> => ({
  'probe:draft': { probe: 'draft', probed },
  'probe:saved': { probe: 'saved', probed },
  'activity:llm_call': {
    run: 'llm_call',
    check: (o) => expect(o['text']).toBe(FIXTURE_COMPLETION),
  },
});

const database: Partial<Record<Capability, Cell>> = {
  'probe:draft': { probe: 'draft', probed: 'liveness' },
  'probe:saved': { probe: 'saved', probed: 'liveness' },
  'activity:get_metadata': { run: 'get_metadata', check: (o) => expect(o['exists']).toBe(true) },
  'activity:copy': {
    run: 'copy',
    check: (o) => expect(o).toMatchObject({ rowsRead: 3, rowsWritten: 3, rowsFailed: 0 }),
  },
  'sink:copy': { sink: 'copy' },
  'activity:lookup': {
    run: 'lookup',
    check: (o) => expect(o['firstRow']).toMatchObject({ id: 1, name: 'Zoë' }),
  },
  'activity:script': { run: 'script' },
  'dataset:preview': { dataset: 'preview' },
  'dataset:schema': { dataset: 'schema' },
};

export const CONNECTOR_MATRIX: Record<ConnectionKind, Partial<Record<Capability, Cell>>> = {
  http: {
    'probe:draft': { probe: 'draft', probed: 'liveness' },
    'probe:saved': { probe: 'saved', probed: 'liveness' },
    'activity:http_request': {
      run: 'http_request',
      check: (o) => expect(String(o['body'])).toContain('"body":"ping"'),
    },
    'activity:web': {
      run: 'web',
      check: (o) => expect(JSON.stringify(o)).toContain('ping'),
    },
  },
  anthropic_api: llm('liveness'),
  openai_api: llm('liveness'),
  ollama: llm('liveness'),
  agent_cli: {
    // `agent_cli` never spawns to probe: running a command as a liveness check
    // is the side effect its adapter refuses, so it answers for its config.
    ...llm('config'),
    'activity:llm_call': {
      run: 'llm_call',
      check: (o) => expect(String(o['text'])).toContain('agent:'),
    },
    'activity:agent_task': {
      run: 'agent_task',
      check: (o) => expect(JSON.stringify(o)).toContain('agent:do the thing'),
    },
  },
  fs: {
    'probe:draft': { probe: 'draft', probed: 'liveness' },
    'probe:saved': { probe: 'saved', probed: 'liveness' },
    'activity:file_read': { run: 'file_read', check: (o) => expect(o['content']).toBe('read me') },
    'activity:file_write': { run: 'file_write' },
    'activity:file_copy': { run: 'file_copy' },
    'activity:file_move': { run: 'file_move' },
    'activity:file_delete': { run: 'file_delete' },
    'activity:file_list': { run: 'file_list' },
    'activity:get_metadata': { run: 'get_metadata', check: (o) => expect(o['exists']).toBe(true) },
    'activity:delete': { run: 'delete' },
    'activity:copy': {
      run: 'copy',
      check: (o) => expect(o).toMatchObject({ rowsRead: 3, rowsWritten: 3, rowsFailed: 0 }),
    },
    'sink:copy': { sink: 'copy' },
    'log:copy': { log: 'copy' },
    'activity:copy_files': { run: 'copy_files' },
    'sink:copy_files': { sink: 'copy_files' },
    'log:copy_files': { log: 'copy_files' },
    'activity:lookup': {
      run: 'lookup',
      check: (o) => expect(o['firstRow']).toMatchObject({ id: '1', name: 'Zoë' }),
    },
    'dataset:preview': { dataset: 'preview' },
    'dataset:schema': { dataset: 'schema' },
  },
  sqlite: database,
  postgres: database,
};

/** `<kind>/<capability>` for every cell in the table. */
export function connectorCellIds(): string[] {
  return Object.entries(CONNECTOR_MATRIX)
    .flatMap(([kind, caps]) => Object.keys(caps).map((c) => `${kind}/${c}`))
    .sort();
}

describe('the connector matrix covers every kind and capability', () => {
  it('has a cell for every capability the registry and catalog declare, and none stale', () => {
    expect(connectorCellIds()).toEqual(requiredConnectorCells());
  });

  it('covers every kind the adapter registry serves, and the registry serves every kind', () => {
    const registry = createConnectorRegistry({ supervisor: createSupervisor() });
    expect([...registry.keys()].sort()).toEqual([...ConnectionKindSchema.options].sort());
    expect(Object.keys(CONNECTOR_MATRIX).sort()).toEqual([...ConnectionKindSchema.options].sort());
  });

  it('reports the gap when a kind or capability arrives without cells', () => {
    // The derivation, fed a registry with one more kind and a catalog with one
    // more activity on `fs`: both must surface as required cells the table lacks.
    const withActivity: ActivityCatalog = new Map([
      ...catalog,
      [
        'future_activity',
        { ...catalog.get('file_read')!, type: 'future_activity', connectionKinds: ['fs'] },
      ],
    ]);
    const required = requiredConnectorCells({
      kinds: [...ConnectionKindSchema.options, 'future_kind'],
      catalog: withActivity,
    });
    const missing = required.filter((c) => !connectorCellIds().includes(c));
    expect(missing).toEqual([
      'fs/activity:future_activity',
      'future_kind/probe:draft',
      'future_kind/probe:saved',
    ]);
  });

  it('gives every execution activity a base node the matrix runs', () => {
    const execution = [...catalog.values()].filter((e) => e.kind === 'execution');
    expect(Object.keys(BASE_NODES).sort()).toEqual(execution.map((e) => e.type).sort());
  });
});

const PG = postgresAvailable();
let bench: Bench;

beforeAll(async () => {
  bench = await openBench();
});
afterAll(async () => {
  await bench?.close();
});

async function runCell(kind: ConnectionKind, cell: Cell): Promise<void> {
  const { h } = bench;
  if ('probe' in cell) {
    const id = connectionOf(bench, kind);
    const result =
      cell.probe === 'saved'
        ? await h.probeSaved(id)
        : await h.probeDraft({
            kind,
            ...(await savedConfig(id)),
          });
    expect(result).toEqual({ ok: true, probed: cell.probed });
    return;
  }
  if ('run' in cell) {
    const node = await BASE_NODES[cell.run]!(bench, kind);
    const result = await h.runDoc({ nodes: [node] });
    const outputs = onlyOutputs(result, 'n');
    expect(result.status).toBe('success');
    cell.check?.(outputs, bench, result);
    return;
  }
  if ('sink' in cell) {
    await runSinkCell(kind, cell.sink);
    return;
  }
  if ('log' in cell) {
    await runLogCell(kind, cell.log);
    return;
  }
  const { datasetId } = await canonicalDataset(bench, kind);
  const res = await h.app.inject({
    method: 'POST',
    url: `/api/datasets/${datasetId}/${cell.dataset}`,
  });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.ok).toBe(true);
  const text = JSON.stringify(body);
  for (const column of ['id', 'name', 'score', 'active', 'born', 'note']) {
    expect(text).toContain(`"${column}"`);
  }
  if (cell.dataset === 'preview') expect(text).toContain('Zoë');
}

/** The connection's stored config and secret, for a draft probe of the same thing. */
async function savedConfig(
  id: string,
): Promise<{ config: Record<string, unknown>; secret?: string }> {
  const res = await bench.h.app.inject({ method: 'GET', url: `/api/connections/${id}` });
  const body = res.json() as { kind: ConnectionKind; config: Record<string, unknown> };
  const secret =
    body.kind === 'postgres'
      ? (await import('../backends.js')).postgresConfig().password
      : body.kind === 'anthropic_api' || body.kind === 'openai_api'
        ? 'fixture-key'
        : undefined;
  return { config: body.config, ...(secret === undefined ? {} : { secret }) };
}

async function runSinkCell(kind: ConnectionKind, activity: 'copy' | 'copy_files'): Promise<void> {
  const { h } = bench;
  if (activity === 'copy_files') {
    const node = await BASE_NODES['copy_files']!(bench, 'fs');
    const result = await h.runDoc({ nodes: [{ ...node, connectionIds: {
      source: connectionOf(bench, 'fs'),
      sink: connectionOf(bench, kind),
    } }] });
    expect(result.status).toBe('success');
    const folder = String((node['config'] as Record<string, unknown>)['sinkFolder']);
    expect(readdirSync(folder)).toHaveLength(1);
    return;
  }
  const sink =
    kind === 'fs'
      ? bench.stores.fsDelimited
      : kind === 'sqlite'
        ? bench.stores.sqlite
        : bench.stores.postgres!;
  const address = await sink.sinkAddress!();
  const sinkDatasetId = await h.createDataset({
    connectionId: sink.connectionId,
    kind: address.kind,
    config: address.config,
  });
  const source = await canonicalDataset(bench, 'sqlite');
  const result = await h.runDoc({
    nodes: [
      {
        id: 'n',
        type: 'copy',
        position: { x: 0, y: 0 },
        connectionIds: { source: source.connectionId, sink: sink.connectionId },
        datasetIds: { source: source.datasetId, sink: sinkDatasetId },
        config: { mapping: source.mapping, mode: 'overwrite' },
      },
    ],
  });
  expect(onlyOutputs(result, 'n')).toMatchObject({ rowsWritten: 3 });
  expect((await sink.readBack!(address)).map((r) => r.name)).toEqual(
    CANONICAL_ROWS.map((r) => r.name),
  );
}

async function runLogCell(kind: ConnectionKind, activity: 'copy' | 'copy_files'): Promise<void> {
  const node = await BASE_NODES[activity]!(bench, activity === 'copy' ? 'sqlite' : 'fs');
  const logFolder = benchPath(bench, 'logs');
  mkdirSync(logFolder);
  const result = await bench.h.runDoc({
    nodes: [
      {
        ...node,
        connectionIds: {
          ...(node['connectionIds'] as Record<string, string>),
          log: connectionOf(bench, kind),
        },
        config: {
          ...(node['config'] as Record<string, unknown>),
          logLevel: 'info',
          logTo: 'folder',
          logFolder,
        },
      },
    ],
  });
  expect(result.failures.get('n') ?? []).toEqual([]);
  expect(result.status).toBe('success');
  // The session log landed as a file in the folder on the log connection.
  expect(existsSync(logFolder)).toBe(true);
  const files = readdirSync(logFolder, { recursive: true }).map(String);
  const csv = files.find((f) => f.endsWith('.csv'));
  expect(csv).toBeDefined();
  expect(readFileSync(join(logFolder, csv!), 'utf8').length).toBeGreaterThan(0);
}

describe.each(Object.keys(CONNECTOR_MATRIX) as ConnectionKind[])('%s', (kind) => {
  const caps = Object.entries(CONNECTOR_MATRIX[kind]) as [Capability, Cell][];
  // A postgres row skips only off CI: under CI `postgresAvailable` has thrown.
  const run = PG || !needsPostgres(`${kind}:`) ? it : it.skip;
  run.each(caps.map(([cap, cell]) => [`${kind}/${cap}`, cell] as const))('%s', async (_id, cell) => {
    await runCell(kind, cell);
  });
});
