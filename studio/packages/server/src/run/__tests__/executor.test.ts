import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import sodium from 'libsodium-wrappers';
import {
  CATALOG_VERSION,
  type ConnectionKind,
  type NewPipelineVersion,
  type Node,
} from '@autonomy-studio/shared';
import { createPipeline } from '../../repo/pipelines.js';
import { createPipelineVersion, getPipelineVersion } from '../../repo/pipeline-versions.js';
import { createRun, getRun } from '../../repo/runs.js';
import { createConnection } from '../../repo/connections.js';
import { createSecret } from '../../repo/secrets.js';
import { encrypt } from '../../secrets/secrets.js';
import { freshDb } from '../../repo/__tests__/helpers.js';
import { startRun, type DocResolver } from '../driver.js';
import { reconcileOnBoot } from '../reconcile.js';
import { loadEngineEvents } from '../events.js';
import { createExecutor } from '../executor.js';
import { createConnectorRegistry, type ConnectorRegistry } from '../../connectors/registry.js';
import type { ActivityEvent, ConnectorAdapter } from '../../connectors/types.js';

type Db = ReturnType<typeof freshDb>['db'];

let KEY: Uint8Array;
beforeAll(async () => {
  await sodium.ready;
  KEY = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --- fixtures --------------------------------------------------------------

let seq = 0;
function httpNode(
  id: string,
  connectionId: string | undefined,
  config: Record<string, unknown>,
): Node {
  seq += 1;
  return { id, type: 'http_request', config, connectionId, position: { x: seq, y: 0 } };
}

function seedVersion(db: Db, nodes: Node[]): string {
  const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
  const input: NewPipelineVersion = {
    pipelineId: pipeline.id,
    params: [],
    outputs: [],
    nodes,
    edges: [],
    catalogVersion: CATALOG_VERSION,
  };
  return createPipelineVersion(db, input).id;
}

function seedRun(db: Db, pvId: string) {
  return createRun(db, {
    ownerId: 'local',
    pipelineVersionId: pvId,
    triggerId: null,
    parentRunId: null,
    params: {},
  });
}

function resolveDocFor(db: Db): DocResolver {
  return (id) => {
    const pv = getPipelineVersion(db, id);
    if (pv === null) throw new Error(`no pv ${id}`);
    return pv;
  };
}

function deps(db: Db, over: { adapters?: ConnectorRegistry; concurrency?: number } = {}) {
  const resolveDoc = resolveDocFor(db);
  return {
    db,
    resolveDoc,
    executor: createExecutor({
      db,
      masterKey: KEY,
      resolveDoc,
      adapters: over.adapters ?? createConnectorRegistry(),
      concurrency: over.concurrency,
    }),
  };
}

/** A connection whose plaintext secret is encrypted at rest (real crypto). */
async function seedConnection(
  db: Db,
  kind: ConnectionKind,
  config: Record<string, unknown>,
  plaintextSecret: string | null,
): Promise<string> {
  let secretRef: string | null = null;
  if (plaintextSecret !== null) {
    const ref = `ref-${(seq += 1)}`;
    createSecret(db, { ref, ciphertext: await encrypt(plaintextSecret, KEY) });
    secretRef = ref;
  }
  return createConnection(db, { ownerId: 'local', name: 'C', kind, config, secretRef }).id;
}

/** A fake adapter for `http`, so taxonomy/cap/ordering tests need no real fetch. */
function fakeHttpAdapter(run: ConnectorAdapter['runActivity']): ConnectorRegistry {
  const adapter: ConnectorAdapter = {
    kind: 'http',
    configSchema: createConnectorRegistry().get('http')!.configSchema,
    testConnection: () => Promise.resolve({ ok: true }),
    runActivity: run,
  };
  return new Map([['http', adapter]]);
}

function eventTypes(db: Db, runId: string): string[] {
  return loadEngineEvents(db, runId).map((e) => e.type);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- tests -----------------------------------------------------------------

describe('createExecutor — happy path (real http adapter, mocked fetch)', () => {
  it('dispatches (idempotent:false) then succeeds with the adapter outputs', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      status: 200,
      text: () => Promise.resolve('BODY'),
      headers: new Headers({ 'x-h': '1' }),
    } as unknown as Response);

    const db = freshDb().db;
    const connId = await seedConnection(db, 'http', {}, null);
    const pvId = seedVersion(db, [httpNode('n1', connId, { url: 'https://x/y' })]);
    const run = seedRun(db, pvId);

    const state = await startRun(deps(db), run);

    expect(state.status).toBe('success');
    const events = loadEngineEvents(db, run.id);
    const dispatched = events.find((e) => e.type === 'node.dispatched');
    expect(dispatched).toMatchObject({ nodeId: 'n1', idempotent: false });
    const succeeded = events.find((e) => e.type === 'node.succeeded');
    expect(succeeded).toMatchObject({
      outputs: { status: 200, body: 'BODY', headers: { 'x-h': '1' } },
    });
    expect(getRun(db, run.id)?.status).toBe('success');
  });
});

describe('createExecutor — loud pre-flight failures (no bogus node.dispatched)', () => {
  it('an unknown activity type fails the node with NO node.dispatched', async () => {
    const db = freshDb().db;
    const pvId = seedVersion(db, [
      { id: 'n1', type: 'no_such_activity', config: {}, position: { x: 1, y: 0 } },
    ]);
    const run = seedRun(db, pvId);

    const state = await startRun(deps(db), run);

    expect(state.status).toBe('failure');
    const types = eventTypes(db, run.id);
    expect(types).not.toContain('node.dispatched');
    expect(types).toContain('node.failed');
    expect(loadEngineEvents(db, run.id).find((e) => e.type === 'node.failed')).toMatchObject({
      error: expect.stringContaining("unknown activity type 'no_such_activity'"),
    });
  });

  it('a node with no connectionId fails loudly (activity requires a connection)', async () => {
    const db = freshDb().db;
    const pvId = seedVersion(db, [httpNode('n1', undefined, { url: 'https://x' })]);
    const run = seedRun(db, pvId);

    const state = await startRun(deps(db), run);
    expect(state.status).toBe('failure');
    expect(eventTypes(db, run.id)).not.toContain('node.dispatched');
    expect(loadEngineEvents(db, run.id).find((e) => e.type === 'node.failed')).toMatchObject({
      error: expect.stringContaining('requires a connection'),
    });
  });

  it('a connection of the wrong kind fails loudly', async () => {
    const db = freshDb().db;
    const connId = await seedConnection(db, 'anthropic_api', {}, 'sk-x');
    const pvId = seedVersion(db, [httpNode('n1', connId, { url: 'https://x' })]);
    const run = seedRun(db, pvId);

    const state = await startRun(deps(db), run);
    expect(state.status).toBe('failure');
    expect(loadEngineEvents(db, run.id).find((e) => e.type === 'node.failed')).toMatchObject({
      error: expect.stringContaining("connection kind 'anthropic_api' is not valid"),
    });
  });

  it('a connection kind with no registered adapter fails loudly (P3a: llm_call)', async () => {
    const db = freshDb().db;
    const connId = await seedConnection(db, 'anthropic_api', {}, 'sk-x');
    const pvId = seedVersion(db, [
      {
        id: 'n1',
        type: 'llm_call',
        config: { prompt: 'hi' },
        connectionId: connId,
        position: { x: 1, y: 0 },
      },
    ]);
    const run = seedRun(db, pvId);

    const state = await startRun(deps(db), run);
    expect(state.status).toBe('failure');
    expect(loadEngineEvents(db, run.id).find((e) => e.type === 'node.failed')).toMatchObject({
      error: expect.stringContaining("no adapter for connection kind 'anthropic_api'"),
    });
  });
});

describe('createExecutor — error taxonomy → node.failed', () => {
  for (const kind of ['auth', 'rate_limit', 'transient', 'permanent', 'cancelled'] as const) {
    it(`maps a '${kind}' adapter failure to node.failed with the kind in the message`, async () => {
      const db = freshDb().db;
      const connId = await seedConnection(db, 'http', {}, null);
      const pvId = seedVersion(db, [httpNode('n1', connId, { url: 'https://x' })]);
      const run = seedRun(db, pvId);

      const adapters = fakeHttpAdapter(async function* (): AsyncIterable<ActivityEvent> {
        yield { type: 'failed', kind, error: 'boom' };
      });

      const state = await startRun(deps(db, { adapters }), run);
      expect(state.status).toBe('failure');
      // node.dispatched IS present — the failure is at the adapter (post-dispatch).
      expect(eventTypes(db, run.id)).toContain('node.dispatched');
      expect(loadEngineEvents(db, run.id).find((e) => e.type === 'node.failed')).toMatchObject({
        error: `${kind}: boom`,
      });
    });
  }

  it('an adapter that yields no terminal event fails the node (contract violation)', async () => {
    const db = freshDb().db;
    const connId = await seedConnection(db, 'http', {}, null);
    const pvId = seedVersion(db, [httpNode('n1', connId, { url: 'https://x' })]);
    const run = seedRun(db, pvId);
    // eslint-disable-next-line require-yield -- intentionally yields nothing
    const adapters = fakeHttpAdapter(async function* (): AsyncIterable<ActivityEvent> {
      return;
    });
    const state = await startRun(deps(db, { adapters }), run);
    expect(state.status).toBe('failure');
    expect(loadEngineEvents(db, run.id).find((e) => e.type === 'node.failed')).toMatchObject({
      error: expect.stringContaining('no terminal event'),
    });
  });

  it('an adapter that THROWS still fails only its node (not the whole pump)', async () => {
    const db = freshDb().db;
    const connId = await seedConnection(db, 'http', {}, null);
    const pvId = seedVersion(db, [httpNode('n1', connId, { url: 'https://x' })]);
    const run = seedRun(db, pvId);
    const adapters = fakeHttpAdapter(
      // eslint-disable-next-line require-yield -- throws before it can yield
      async function* (): AsyncIterable<ActivityEvent> {
        throw new Error('kaboom');
      },
    );
    const state = await startRun(deps(db, { adapters }), run);
    expect(state.status).toBe('failure');
    // node.dispatched durable before the throw → recoverable, not lost.
    expect(eventTypes(db, run.id)).toContain('node.dispatched');
    expect(loadEngineEvents(db, run.id).find((e) => e.type === 'node.failed')).toMatchObject({
      error: 'kaboom',
    });
  });
});

describe('createExecutor — crash-safety ordering (node.dispatched durable BEFORE the side effect)', () => {
  it('the adapter observes node.dispatched already persisted when it starts running', async () => {
    const db = freshDb().db;
    const connId = await seedConnection(db, 'http', {}, null);
    const pvId = seedVersion(db, [httpNode('n1', connId, { url: 'https://x' })]);
    const run = seedRun(db, pvId);

    let sawDispatchedBeforeWork = false;
    const adapters = fakeHttpAdapter(async function* (ctx): AsyncIterable<ActivityEvent> {
      const log = loadEngineEvents(db, ctx.runId);
      sawDispatchedBeforeWork = log.some(
        (e) => e.type === 'node.dispatched' && e.nodeId === ctx.nodeId,
      );
      yield { type: 'succeeded', outputs: {} };
    });

    await startRun(deps(db, { adapters }), run);
    expect(sawDispatchedBeforeWork).toBe(true);
  });
});

describe('createExecutor — secret-resolution boundary', () => {
  it('hands the adapter the plaintext secret but never persists it (or preparedInput)', async () => {
    const db = freshDb().db;
    const SECRET = 'sk-super-secret-value';
    const connId = await seedConnection(db, 'http', { baseUrl: 'https://api' }, SECRET);
    const pvId = seedVersion(db, [httpNode('n1', connId, { url: '/thing' })]);
    const run = seedRun(db, pvId);

    let receivedSecret: string | null = 'UNSET';
    const adapters = fakeHttpAdapter(async function* (_ctx, secret): AsyncIterable<ActivityEvent> {
      receivedSecret = secret;
      yield { type: 'succeeded', outputs: { ok: true } };
    });

    await startRun(deps(db, { adapters }), run);

    // The adapter got the decrypted plaintext...
    expect(receivedSecret).toBe(SECRET);
    // ...but it is NOWHERE in the durable log (no secret, no preparedInput).
    const raw = JSON.stringify(loadEngineEvents(db, run.id));
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain('preparedInput');
  });
});

describe('createExecutor — call_pipeline (startChild) deferral is safe', () => {
  it('a call node fails loudly and leaves NO waiting node for the reconciler to re-emit', async () => {
    const db = freshDb().db;
    const childPvId = seedVersion(db, [httpNode('leaf', undefined, {})]);
    // A call node: carries a `call` config → the reducer emits startChild.
    const callNode: Node = {
      id: 'caller',
      type: 'http_request',
      config: {},
      position: { x: 1, y: 0 },
      call: { pipelineVersionId: childPvId, params: {} },
    };
    const pvId = seedVersion(db, [callNode]);
    const run = seedRun(db, pvId);

    const state = await startRun(deps(db), run);

    expect(state.status).toBe('failure');
    expect(state.nodes['caller']!.status).toBe('failure'); // terminal, not `waiting`
    expect(eventTypes(db, run.id)).toContain('call.returned');

    // The boot reconciler must not throw on this run (no waiting node → no
    // startChild re-emit loop). It should be a no-op (run already terminal).
    await expect(
      reconcileOnBoot({ db, resolveDoc: resolveDocFor(db), executor: deps(db).executor }),
    ).resolves.toBeDefined();
  });
});

describe('createExecutor — worker-pool cap across concurrently-driven runs', () => {
  it('never runs more adapters at once than the configured concurrency', async () => {
    const db = freshDb().db;
    const connId = await seedConnection(db, 'http', {}, null);
    const pvId = seedVersion(db, [httpNode('n1', connId, { url: 'https://x' })]);

    let live = 0;
    let peak = 0;
    const adapters = fakeHttpAdapter(async function* (): AsyncIterable<ActivityEvent> {
      live += 1;
      peak = Math.max(peak, live);
      await sleep(40);
      live -= 1;
      yield { type: 'succeeded', outputs: {} };
    });

    // ONE shared executor (shared p-limit) drives THREE runs concurrently.
    const d = deps(db, { adapters, concurrency: 2 });
    const runs = [seedRun(db, pvId), seedRun(db, pvId), seedRun(db, pvId)];
    const states = await Promise.all(runs.map((r) => startRun(d, r)));

    expect(states.every((s) => s.status === 'success')).toBe(true);
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThanOrEqual(2); // proves real overlap occurred (cap bit)
  });
});
