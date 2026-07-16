import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import sodium from 'libsodium-wrappers';
import { z } from 'zod';
import {
  CATALOG_VERSION,
  type ActivityCatalog,
  type ActivityCatalogEntry,
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
import { refuseToArm } from './stub-alarms.js';
import { reconcileOnBoot } from '../reconcile.js';
import { loadEngineEvents } from '../events.js';
import { createExecutor } from '../executor.js';
import { createConnectorRegistry, type ConnectorRegistry } from '../../connectors/registry.js';
import type { ActivityEvent, ConnectorAdapter } from '../../connectors/types.js';
import type { Supervisor } from '../../workers/process-supervisor.js';

type Db = ReturnType<typeof freshDb>['db'];

// A no-op supervisor: these tests exercise `http`/fake adapters, never
// `agent_cli`, so its spawn/reap are never called — it only satisfies the
// registry's dependency shape.
const noopSupervisor: Supervisor = {
  spawnSupervised: () => {
    throw new Error('noopSupervisor.spawnSupervised should not be called in these tests');
  },
  reapAllSupervised: () => Promise.resolve(),
};
const testRegistry = (): ConnectorRegistry =>
  createConnectorRegistry({ supervisor: noopSupervisor });

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

function deps(
  db: Db,
  over: {
    adapters?: ConnectorRegistry;
    concurrency?: number;
    masterKey?: Uint8Array;
    catalog?: ActivityCatalog;
  } = {},
) {
  const resolveDoc = resolveDocFor(db);
  return {
    db,
    resolveDoc,
    executor: createExecutor({
      db,
      masterKey: over.masterKey ?? KEY,
      resolveDoc,
      adapters: over.adapters ?? testRegistry(),
      concurrency: over.concurrency,
      catalog: over.catalog,
    }),
    // No doc here declares `policy.retry`, so no `scheduleRetry` can be emitted
    // and nothing should ever arm — say so rather than accepting one silently.
    alarms: refuseToArm,
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
    configSchema: testRegistry().get('http')!.configSchema,
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
      // A misconfigured doc never succeeds on a retry → `permanent`.
      kind: 'permanent',
      code: 'unknown_activity',
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
      kind: 'permanent',
      code: 'connection_missing',
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
      kind: 'permanent',
      code: 'connection_kind_invalid',
    });
  });

  it('a connection kind absent from the registry fails loudly (misconfigured registry)', async () => {
    // P3b registers an adapter for every kind, so this exercises the executor's
    // "no adapter" guard directly via an EMPTY registry — a run must never hang
    // silently on a kind the registry happens not to carry.
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

    const emptyRegistry: ConnectorRegistry = new Map();
    const state = await startRun(deps(db, { adapters: emptyRegistry }), run);
    expect(state.status).toBe('failure');
    expect(loadEngineEvents(db, run.id).find((e) => e.type === 'node.failed')).toMatchObject({
      error: expect.stringContaining("no adapter for connection kind 'anthropic_api'"),
      kind: 'permanent',
      code: 'no_adapter',
    });
  });

  it('an undecryptable secret fails loudly with its OWN code, echoing NOTHING of the ciphertext', async () => {
    // `resolveConnection` funnels six distinct misconfigurations through one
    // call site, so each needs its own `code` for an operator (and F9a's
    // `errorMap`) to tell them apart without string-matching the message.
    // This is the realistic one: the master key rotated (or the ciphertext
    // corrupted), so a secret that exists cannot be opened.
    const db = freshDb().db;
    const connId = await seedConnection(db, 'http', {}, 'sk-encrypted-under-the-OLD-key');
    const pvId = seedVersion(db, [httpNode('n1', connId, { url: 'https://x' })]);
    const run = seedRun(db, pvId);

    const otherKey = new Uint8Array(32).fill(9);
    const state = await startRun(deps(db, { masterKey: otherKey }), run);

    expect(state.status).toBe('failure');
    expect(eventTypes(db, run.id)).not.toContain('node.dispatched');
    const failed = loadEngineEvents(db, run.id).find((e) => e.type === 'node.failed');
    expect(failed).toMatchObject({ kind: 'permanent', code: 'secret_undecryptable' });
    // The message must never leak crypto detail (see resolveConnection).
    expect((failed as { error: string }).error).not.toContain('sk-encrypted');
  });
});

describe('createExecutor — the ActivityDefinition contract (#1 D6 / F9a)', () => {
  /**
   * A one-entry catalog. The MVP set is entirely `execution`-with-a-connection,
   * so these contract branches are unreachable through the shipped catalog —
   * injecting one keeps them exercised rather than dead defensive code.
   */
  function catalogOf(over: Partial<ActivityCatalogEntry> & { type: string }): ActivityCatalog {
    const entry: ActivityCatalogEntry = {
      title: 'Test Activity',
      kind: 'execution',
      category: 'general',
      idempotent: false,
      connectionKinds: [],
      outputs: [],
      configSchema: z.object({}),
      ...over,
    };
    return new Map([[entry.type, entry]]);
  }

  function nodeOfType(type: string, connectionId?: string): Node {
    seq += 1;
    return { id: 'n1', type, config: {}, connectionId, position: { x: seq, y: 0 } };
  }

  it('a CONTROL activity is never dispatched to a connector (engine-evaluated)', async () => {
    // Control activities are pure reducer transitions (#1 D6, #4 "Reducer
    // handles them natively"), so one arriving at the executor is an engine
    // invariant violation — fail loud, and NEVER touch an adapter.
    //
    // The fixture is deliberately CONTRADICTORY — a control activity that also
    // names a connector — because that is the only shape in which the guard is
    // load-bearing: delete it and this run reaches the adapter and SUCCEEDS.
    // (With `connectionKinds: []` the run would fail `no_executor` anyway, so
    // the assertions below would pass with or without the guard.)
    let adapterRan = false;
    const adapters = fakeHttpAdapter(async function* () {
      adapterRan = true;
      yield { type: 'succeeded', outputs: {} } satisfies ActivityEvent;
    });
    const db = freshDb().db;
    const connId = await seedConnection(db, 'http', {}, null);
    const pvId = seedVersion(db, [nodeOfType('test_control', connId)]);
    const run = seedRun(db, pvId);

    const state = await startRun(
      deps(db, {
        adapters,
        catalog: catalogOf({ type: 'test_control', kind: 'control', connectionKinds: ['http'] }),
      }),
      run,
    );

    expect(state.status).toBe('failure');
    expect(eventTypes(db, run.id)).not.toContain('node.dispatched');
    expect(loadEngineEvents(db, run.id).find((e) => e.type === 'node.failed')).toMatchObject({
      error: expect.stringContaining('control'),
      kind: 'permanent',
      code: 'control_not_dispatchable',
    });
    expect(adapterRan).toBe(false);
  });

  it('an EXECUTION activity declaring no connection still fails no_executor', async () => {
    // Keying dispatch off `kind` must not swallow this case: an execution
    // activity with no connector is the "future built-in runner" slot, and it
    // stays a loud, distinct failure rather than a confusing connection error.
    const db = freshDb().db;
    const pvId = seedVersion(db, [nodeOfType('test_builtin')]);
    const run = seedRun(db, pvId);

    const state = await startRun(
      deps(db, { catalog: catalogOf({ type: 'test_builtin', kind: 'execution' }) }),
      run,
    );

    expect(state.status).toBe('failure');
    expect(eventTypes(db, run.id)).not.toContain('node.dispatched');
    expect(loadEngineEvents(db, run.id).find((e) => e.type === 'node.failed')).toMatchObject({
      error: expect.stringContaining('has no executor'),
      kind: 'permanent',
      code: 'no_executor',
    });
  });
});

describe('createExecutor — error taxonomy → node.failed{kind, code} (#1 F0)', () => {
  // The executor seam maps the adapters' 5-kind PROVIDER taxonomy down onto the
  // engine's 3-kind RETRY-DECISION axis, preserving the dropped detail in
  // `code`. This table IS the contract (spec #2's error taxonomy fixes it:
  // 429 → transient, 401/403 → permanent, abort → cancelled).
  const TAXONOMY = [
    { adapter: 'auth', kind: 'permanent', code: 'auth' },
    { adapter: 'rate_limit', kind: 'transient', code: 'rate_limit' },
    { adapter: 'transient', kind: 'transient', code: undefined },
    { adapter: 'permanent', kind: 'permanent', code: undefined },
    { adapter: 'cancelled', kind: 'cancelled', code: undefined },
  ] as const;

  for (const row of TAXONOMY) {
    it(`maps a '${row.adapter}' adapter failure → kind '${row.kind}'${row.code ? ` + code '${row.code}'` : ' (no code)'}`, async () => {
      const db = freshDb().db;
      const connId = await seedConnection(db, 'http', {}, null);
      const pvId = seedVersion(db, [httpNode('n1', connId, { url: 'https://x' })]);
      const run = seedRun(db, pvId);

      const adapters = fakeHttpAdapter(async function* (): AsyncIterable<ActivityEvent> {
        yield { type: 'failed', kind: row.adapter, error: 'boom' };
      });

      const state = await startRun(deps(db, { adapters }), run);
      expect(state.status).toBe('failure');
      // node.dispatched IS present — the failure is at the adapter (post-dispatch).
      expect(eventTypes(db, run.id)).toContain('node.dispatched');
      const failed = loadEngineEvents(db, run.id).find((e) => e.type === 'node.failed');
      expect(failed).toMatchObject({ kind: row.kind });
      expect((failed as { code?: string } | undefined)?.code).toBe(row.code);
    });
  }

  it('carries the adapter message through RAW — the kind is a FIELD, never a string prefix', async () => {
    // F0's core fix: the old executor string-formatted `${kind}: ${error}` into
    // `error`, which made the classification only recoverable by parsing text.
    // Any retry/routing layer must read `kind`; `error` stays human detail.
    const db = freshDb().db;
    const connId = await seedConnection(db, 'http', {}, null);
    const pvId = seedVersion(db, [httpNode('n1', connId, { url: 'https://x' })]);
    const run = seedRun(db, pvId);

    const adapters = fakeHttpAdapter(async function* (): AsyncIterable<ActivityEvent> {
      yield { type: 'failed', kind: 'rate_limit', error: 'boom' };
    });

    await startRun(deps(db, { adapters }), run);

    const failed = loadEngineEvents(db, run.id).find((e) => e.type === 'node.failed');
    expect(failed).toMatchObject({ error: 'boom', kind: 'transient', code: 'rate_limit' });
    expect((failed as { error: string }).error).not.toContain('rate_limit:');
  });

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
      kind: 'permanent',
      code: 'adapter_no_terminal',
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
      // An unexpected THROW is an adapter bug of unknown cause. `permanent` is
      // the safe classification: once F2b keys retry off `kind`, a `transient`
      // here would retry-loop a buggy adapter, and no MVP activity is
      // idempotent — so a blind retry could repeat a real side effect.
      kind: 'permanent',
      code: 'adapter_threw',
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
      reconcileOnBoot({
        db,
        resolveDoc: resolveDocFor(db),
        executor: deps(db).executor,
        alarms: refuseToArm,
      }),
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
