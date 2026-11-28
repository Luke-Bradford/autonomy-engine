import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConnectionKind } from '@autonomy-studio/shared';
import {
  CANONICAL_COLUMNS,
  ENDPOINT_STORES,
  dropPostgresSchemas,
  mappingFor,
  postgresAvailable,
  type EndpointStore,
} from './backends.js';
import { startFixtureServer, type FixtureServer } from './fixture-server.js';
import { createHarness, type Harness } from './harness.js';

/**
 * #1574 OR39 — one app with a connection of EVERY kind, each on a real backend,
 * and the base node every catalog activity runs as. The connector matrix runs
 * these nodes as they are; the dynamic-field matrix runs them with one field
 * swapped for an expression. One definition of "a node that runs", so the two
 * matrices cannot drift apart on what a valid config is.
 */

export interface Bench {
  readonly h: Harness;
  readonly server: FixtureServer;
  /** A connection id per kind; postgres is absent where it cannot run (`postgresAvailable`). */
  readonly connections: Partial<Record<ConnectionKind, string>>;
  /** The writable folder the `fs` connection is rooted at. */
  readonly fsRoot: string;
  readonly stores: {
    readonly sqlite: EndpointStore;
    readonly postgres?: EndpointStore;
    readonly fsDelimited: EndpointStore;
  };
  close(): Promise<void>;
}

/** The secret the API-key kinds carry: the fixture server accepts any. */
const FIXTURE_KEY = 'fixture-key';

/** What the fake agent CLI prints: its task, so a cell can see it arrived. */
export const AGENT_SCRIPT =
  "process.stdout.write('agent:' + process.argv[process.argv.length - 1])";

export async function openBench(): Promise<Bench> {
  const h = await createHarness();
  const server = await startFixtureServer();
  const fsRoot = join(h.tmpDir, 'bench-fs');
  mkdirSync(fsRoot, { recursive: true });
  const conn = (
    kind: ConnectionKind,
    config: Record<string, unknown>,
    secret?: string,
  ): Promise<string> =>
    h.createConnection({ kind, config, ...(secret === undefined ? {} : { secret }) });

  const sqlite = await ENDPOINT_STORES['sqlite:table']!(h);
  const fsDelimited = await ENDPOINT_STORES['fs:delimited']!(h);
  const postgres = postgresAvailable() ? await ENDPOINT_STORES['postgres:table']!(h) : undefined;
  const connections: Partial<Record<ConnectionKind, string>> = {
    http: await conn('http', { baseUrl: server.url }),
    anthropic_api: await conn('anthropic_api', { baseUrl: server.url }, FIXTURE_KEY),
    openai_api: await conn('openai_api', { baseUrl: server.url }, FIXTURE_KEY),
    ollama: await conn('ollama', { baseUrl: server.url }),
    agent_cli: await conn('agent_cli', { command: process.execPath, args: ['-e', AGENT_SCRIPT] }),
    fs: await conn('fs', { roots: [fsRoot], writable: true }),
    sqlite: sqlite.connectionId,
    ...(postgres === undefined ? {} : { postgres: postgres.connectionId }),
  };
  return {
    h,
    server,
    connections,
    fsRoot,
    stores: { sqlite, fsDelimited, ...(postgres === undefined ? {} : { postgres }) },
    async close() {
      await h.close();
      await server.close();
      if (postgres !== undefined) await dropPostgresSchemas();
    },
  };
}

export function connectionOf(bench: Bench, kind: ConnectionKind): string {
  const id = bench.connections[kind];
  if (id === undefined) throw new Error(`the bench has no ${kind} connection`);
  return id;
}

/** The store a database-kind node reads, by connection kind. */
function storeOf(bench: Bench, kind: ConnectionKind): EndpointStore {
  if (kind === 'sqlite') return bench.stores.sqlite;
  if (kind === 'postgres' && bench.stores.postgres !== undefined) return bench.stores.postgres;
  if (kind === 'fs') return bench.stores.fsDelimited;
  throw new Error(`no dataset store for ${kind}`);
}

/** A saved dataset holding the canonical rows on `kind`'s store. */
export async function canonicalDataset(
  bench: Bench,
  kind: ConnectionKind,
): Promise<{
  datasetId: string;
  connectionId: string;
  mapping: ReturnType<typeof mappingFor>;
}> {
  const store = storeOf(bench, kind);
  const planted = await store.plant('canonical');
  const datasetId = await bench.h.createDataset({
    connectionId: store.connectionId,
    kind: planted.kind,
    config: planted.config,
  });
  return { datasetId, connectionId: store.connectionId, mapping: mappingFor(planted) };
}

let fileSeq = 0;
/** A fresh file under the fs root holding `text`; returns its absolute path. */
export function benchFile(bench: Bench, text = 'hello'): string {
  const path = join(bench.fsRoot, `f${++fileSeq}.txt`);
  writeFileSync(path, text);
  return path;
}
/** A fresh path under the fs root that does not exist yet. */
export function benchPath(bench: Bench, ext = 'txt'): string {
  return join(bench.fsRoot, `p${++fileSeq}.${ext}`);
}

export type BenchNode = Record<string, unknown> & { id: string; type: string };

const at = { x: 0, y: 0 };

/**
 * The node an activity runs as on `kind` (its SOURCE side for a paired
 * activity), with a config that runs to success. Every execution activity in
 * the catalog has an entry; the connector matrix's guard proves it.
 */
export const BASE_NODES: Record<
  string,
  (bench: Bench, kind: ConnectionKind) => Promise<BenchNode>
> = {
  http_request: async (b, kind) => ({
    id: 'n',
    type: 'http_request',
    position: at,
    connectionId: connectionOf(b, kind),
    config: { url: `${b.server.url}/echo`, method: 'POST', body: 'ping' },
  }),
  web: async (b, kind) => ({
    id: 'n',
    type: 'web',
    position: at,
    connectionId: connectionOf(b, kind),
    config: { url: `${b.server.url}/echo`, method: 'POST', body: 'ping' },
  }),
  llm_call: async (b, kind) => ({
    id: 'n',
    type: 'llm_call',
    position: at,
    connectionId: connectionOf(b, kind),
    config: { model: 'fixture-model', prompt: 'say hi' },
  }),
  agent_task: async (b, kind) => ({
    id: 'n',
    type: 'agent_task',
    position: at,
    connectionId: connectionOf(b, kind),
    config: { task: 'do the thing' },
  }),
  file_read: async (b, kind) => ({
    id: 'n',
    type: 'file_read',
    position: at,
    connectionId: connectionOf(b, kind),
    config: { path: benchFile(b, 'read me') },
  }),
  file_write: async (b, kind) => ({
    id: 'n',
    type: 'file_write',
    position: at,
    connectionId: connectionOf(b, kind),
    config: { path: benchPath(b), content: 'written' },
  }),
  file_copy: async (b, kind) => ({
    id: 'n',
    type: 'file_copy',
    position: at,
    connectionId: connectionOf(b, kind),
    config: { source: benchFile(b), dest: benchPath(b) },
  }),
  file_move: async (b, kind) => ({
    id: 'n',
    type: 'file_move',
    position: at,
    connectionId: connectionOf(b, kind),
    config: { source: benchFile(b), dest: benchPath(b) },
  }),
  file_delete: async (b, kind) => ({
    id: 'n',
    type: 'file_delete',
    position: at,
    connectionId: connectionOf(b, kind),
    config: { path: benchFile(b) },
  }),
  file_list: async (b, kind) => ({
    id: 'n',
    type: 'file_list',
    position: at,
    connectionId: connectionOf(b, kind),
    config: { path: b.fsRoot },
  }),
  get_metadata: async (b, kind) => {
    if (kind === 'fs') {
      return {
        id: 'n',
        type: 'get_metadata',
        position: at,
        connectionId: connectionOf(b, kind),
        config: { path: benchFile(b), fieldList: ['exists'] },
      };
    }
    const source = await canonicalDataset(b, kind);
    return {
      id: 'n',
      type: 'get_metadata',
      position: at,
      connectionId: source.connectionId,
      datasetIds: { source: source.datasetId },
      config: { fieldList: ['exists'] },
    };
  },
  delete: async (b, kind) => ({
    id: 'n',
    type: 'delete',
    position: at,
    connectionId: connectionOf(b, kind),
    config: { pathType: 'file', path: benchFile(b) },
  }),
  copy: async (b, kind) => {
    const source = await canonicalDataset(b, kind);
    const sink = b.stores.sqlite;
    const address = await sink.sinkAddress!();
    const sinkDatasetId = await b.h.createDataset({
      connectionId: sink.connectionId,
      kind: address.kind,
      config: address.config,
      columns: CANONICAL_COLUMNS,
    });
    return {
      id: 'n',
      type: 'copy',
      position: at,
      connectionIds: { source: source.connectionId, sink: sink.connectionId },
      datasetIds: { source: source.datasetId, sink: sinkDatasetId },
      config: { mapping: source.mapping, mode: 'append' },
    };
  },
  copy_files: async (b, kind) => {
    const sinkFolder = join(b.fsRoot, `out${++fileSeq}`);
    mkdirSync(sinkFolder);
    return {
      id: 'n',
      type: 'copy_files',
      position: at,
      connectionIds: { source: connectionOf(b, kind), sink: connectionOf(b, 'fs') },
      config: { pathType: 'file', sourcePath: benchFile(b), sinkFolder },
    };
  },
  lookup: async (b, kind) => {
    const source = await canonicalDataset(b, kind);
    return {
      id: 'n',
      type: 'lookup',
      position: at,
      connectionId: source.connectionId,
      datasetIds: { source: source.datasetId },
      config: {},
    };
  },
  script: async (b, kind) => ({
    id: 'n',
    type: 'script',
    position: at,
    connectionId: connectionOf(b, kind),
    config: { blocks: [{ type: 'query', sql: 'SELECT 1 AS one' }] },
  }),
};
