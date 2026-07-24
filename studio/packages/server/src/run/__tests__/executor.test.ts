import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sodium from 'libsodium-wrappers';
import { z } from 'zod';
import {
  BUILTIN_PRICE_TABLE_VERSION,
  CATALOG_VERSION,
  type ActivityCatalog,
  type ActivityCatalogEntry,
  type ConnectionKind,
  type NewPipelineVersion,
  type Node,
  type PipelineVersion,
} from '@autonomy-studio/shared';
import { createPipeline } from '../../repo/pipelines.js';
import { createPipelineVersion, getPipelineVersion } from '../../repo/pipeline-versions.js';
import { createRun, getRun } from '../../repo/runs.js';
import { createConnection } from '../../repo/connections.js';
import { createSecret } from '../../repo/secrets.js';
import { encrypt } from '../../secrets/secrets.js';
import { freshDb } from '../../repo/__tests__/helpers.js';
import { startRun, type DocResolver, type RetryAlarms } from '../driver.js';
import { refuseToArm, stubAlarms } from './stub-alarms.js';
import { reconcileOnBoot } from '../reconcile.js';
import { loadEngineEvents } from '../events.js';
import { createExecutor } from '../executor.js';
import { createConnectorRegistry, type ConnectorRegistry } from '../../connectors/registry.js';
import { connections } from '../../db/schema.js';
import { and, eq } from 'drizzle-orm';
import { runEvents } from '../../db/schema.js';
import {
  getConnectionQuotaResetEpoch,
  recordConnectionQuotaExhaustion,
} from '../../repo/connection-quota.js';
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
    now?: () => number;
    alarms?: RetryAlarms;
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
      now: over.now,
    }),
    // The same clock the executor gate reads also drives a retry's `dueAt`, so a
    // gate-armed retry lands deterministically in the `now`-injecting tests.
    now: over.now,
    // Default: no doc declares `policy.retry`, so no `scheduleRetry` can be emitted
    // and nothing should ever arm — say so rather than accepting one silently. A
    // test that DOES exercise the retry path passes a real `stubAlarms`.
    alarms: over.alarms ?? refuseToArm,
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

describe('createExecutor — activity.metered (#2 L2 usage capture)', () => {
  it('maps a metered ActivityEvent to a durable activity.metered event, before node.succeeded', async () => {
    const db = freshDb().db;
    const connId = await seedConnection(db, 'http', {}, null);
    // An explicit empty output contract so a `succeeded{outputs:{}}` from the fake
    // adapter validates — this test is about the metering event, not http outputs.
    const pvId = seedVersion(db, [httpNode('n1', connId, { url: 'https://x/y', outputs: [] })]);
    const run = seedRun(db, pvId);
    const adapters = fakeHttpAdapter(async function* () {
      yield {
        type: 'metered',
        usage: {
          provider: 'anthropic_api',
          model: 'claude-opus-4-8',
          inputTokens: 3,
          outputTokens: 9,
          meteringStatus: 'metered',
        },
      } satisfies ActivityEvent;
      yield { type: 'succeeded', outputs: {} } satisfies ActivityEvent;
    });

    const state = await startRun(deps(db, { adapters }), run);

    expect(state.status).toBe('success');
    const events = loadEngineEvents(db, run.id);
    const types = events.map((e) => e.type);
    // The metered fact is durable AND ordered before the terminal node.succeeded.
    expect(types).toContain('activity.metered');
    expect(types.indexOf('activity.metered')).toBeLessThan(types.indexOf('node.succeeded'));
    expect(events.find((e) => e.type === 'activity.metered')).toMatchObject({
      runId: run.id,
      nodeId: 'n1',
      provider: 'anthropic_api',
      model: 'claude-opus-4-8',
      inputTokens: 3,
      outputTokens: 9,
      meteringStatus: 'metered',
    });
  });

  it('OMITS token fields on the engine event when meteringStatus is unknown', async () => {
    const db = freshDb().db;
    const connId = await seedConnection(db, 'http', {}, null);
    // An explicit empty output contract so a `succeeded{outputs:{}}` from the fake
    // adapter validates — this test is about the metering event, not http outputs.
    const pvId = seedVersion(db, [httpNode('n1', connId, { url: 'https://x/y', outputs: [] })]);
    const run = seedRun(db, pvId);
    const adapters = fakeHttpAdapter(async function* () {
      yield {
        type: 'metered',
        usage: { provider: 'ollama', model: 'llama3', meteringStatus: 'unknown' },
      } satisfies ActivityEvent;
      yield { type: 'succeeded', outputs: {} } satisfies ActivityEvent;
    });

    await startRun(deps(db, { adapters }), run);

    const metered = loadEngineEvents(db, run.id).find((e) => e.type === 'activity.metered');
    // Absent counts are OMITTED, not stored as `undefined`/`0` — the stored event
    // matches the schema's `.optional()` shape, and `meteringStatus` flags the gap.
    expect(metered).not.toHaveProperty('inputTokens');
    expect(metered).not.toHaveProperty('outputTokens');
    expect(metered).toMatchObject({
      provider: 'ollama',
      model: 'llama3',
      meteringStatus: 'unknown',
    });
  });

  it('L14: meteringStatus=unpriced SUPPRESSES all price fields — even for a priceable model', async () => {
    const db = freshDb().db;
    const connId = await seedConnection(db, 'http', {}, null);
    const pvId = seedVersion(db, [httpNode('n1', connId, { url: 'https://x/y', outputs: [] })]);
    const run = seedRun(db, pvId);
    // A CLI/subscription response whose (provider, model) WOULD resolve a built-in
    // price (claude-opus-4-8 is in the price table). The executor must NOT stamp a
    // per-token cost onto a subscription call — a manufactured cost misreports spend.
    const adapters = fakeHttpAdapter(async function* () {
      yield {
        type: 'metered',
        usage: {
          provider: 'anthropic_api',
          model: 'claude-opus-4-8',
          inputTokens: 100,
          outputTokens: 200,
          meteringStatus: 'unpriced',
        },
      } satisfies ActivityEvent;
      yield { type: 'succeeded', outputs: {} } satisfies ActivityEvent;
    });

    await startRun(deps(db, { adapters }), run);

    const metered = loadEngineEvents(db, run.id).find((e) => e.type === 'activity.metered');
    // usage (a FACT) is kept; the price (a DERIVATION) is suppressed entirely.
    expect(metered).toMatchObject({
      provider: 'anthropic_api',
      model: 'claude-opus-4-8',
      inputTokens: 100,
      outputTokens: 200,
      meteringStatus: 'unpriced',
    });
    expect(metered).not.toHaveProperty('inUnitPrice');
    expect(metered).not.toHaveProperty('outUnitPrice');
    expect(metered).not.toHaveProperty('priceTableVersion');
    expect(metered).not.toHaveProperty('costEstimate');
  });
});

describe('createExecutor — activity.captured (#2 L9a prompt/completion capture)', () => {
  it('maps a captured ActivityEvent to a durable activity.captured event, before node.succeeded', async () => {
    const db = freshDb().db;
    const connId = await seedConnection(db, 'http', {}, null);
    const pvId = seedVersion(db, [httpNode('n1', connId, { url: 'https://x/y', outputs: [] })]);
    const run = seedRun(db, pvId);
    const adapters = fakeHttpAdapter(async function* () {
      yield {
        type: 'captured',
        capture: {
          provider: 'anthropic_api',
          model: 'claude-opus-4-8',
          latencyMs: 12,
          request: {
            messageCount: 1,
            system: { chars: 4, contentHash: 'sys-hash' },
            messages: [{ role: 'user', chars: 5, contentHash: 'msg-hash' }],
          },
          completion: { chars: 3, contentHash: 'out-hash' },
        },
      } satisfies ActivityEvent;
      yield { type: 'succeeded', outputs: {} } satisfies ActivityEvent;
    });

    const state = await startRun(deps(db, { adapters }), run);

    expect(state.status).toBe('success');
    const events = loadEngineEvents(db, run.id);
    const types = events.map((e) => e.type);
    expect(types).toContain('activity.captured');
    expect(types.indexOf('activity.captured')).toBeLessThan(types.indexOf('node.succeeded'));
    const captured = events.find((e) => e.type === 'activity.captured');
    expect(captured).toMatchObject({
      runId: run.id,
      nodeId: 'n1',
      provider: 'anthropic_api',
      model: 'claude-opus-4-8',
      latencyMs: 12,
      request: {
        messageCount: 1,
        system: { chars: 4, contentHash: 'sys-hash' },
        messages: [{ role: 'user', chars: 5, contentHash: 'msg-hash' }],
      },
      completion: { chars: 3, contentHash: 'out-hash' },
    });
    // The executor stamps the attempt id.
    expect(typeof (captured as { attemptId?: unknown }).attemptId).toBe('string');
  });

  it('OMITS completion on the engine event when the capture carried none (fail-closed)', async () => {
    const db = freshDb().db;
    const connId = await seedConnection(db, 'http', {}, null);
    const pvId = seedVersion(db, [httpNode('n1', connId, { url: 'https://x/y', outputs: [] })]);
    const run = seedRun(db, pvId);
    const adapters = fakeHttpAdapter(async function* () {
      yield {
        type: 'captured',
        capture: {
          provider: 'ollama',
          model: 'llama3',
          latencyMs: 7,
          request: { messageCount: 1, messages: [{ role: 'user', chars: 2, contentHash: 'h' }] },
        },
      } satisfies ActivityEvent;
      yield { type: 'succeeded', outputs: {} } satisfies ActivityEvent;
    });

    await startRun(deps(db, { adapters }), run);

    const captured = loadEngineEvents(db, run.id).find((e) => e.type === 'activity.captured');
    expect(captured).not.toHaveProperty('completion');
    expect(captured).toMatchObject({ provider: 'ollama', model: 'llama3', latencyMs: 7 });
  });
});

describe('createExecutor — activity.toolCalled (#2 L10b tool-loop telemetry)', () => {
  it('maps a toolCalled ActivityEvent to a durable event with ids stamped, before the terminal', async () => {
    const db = freshDb().db;
    const connId = await seedConnection(db, 'http', {}, null);
    const pvId = seedVersion(db, [httpNode('n1', connId, { url: 'https://x/y', outputs: [] })]);
    const run = seedRun(db, pvId);
    const adapters = fakeHttpAdapter(async function* () {
      yield {
        type: 'toolCalled',
        call: {
          round: 0,
          toolName: 'adder',
          callId: 't1',
          argsChars: 13,
          argsHash: 'args-hash',
          resultChars: 1,
          resultHash: 'result-hash',
          isError: false,
        },
      } satisfies ActivityEvent;
      yield { type: 'succeeded', outputs: {} } satisfies ActivityEvent;
    });

    const state = await startRun(deps(db, { adapters }), run);

    expect(state.status).toBe('success');
    const events = loadEngineEvents(db, run.id);
    const types = events.map((e) => e.type);
    expect(types).toContain('activity.toolCalled');
    expect(types.indexOf('activity.toolCalled')).toBeLessThan(types.indexOf('node.succeeded'));
    const called = events.find((e) => e.type === 'activity.toolCalled');
    expect(called).toMatchObject({
      runId: run.id,
      nodeId: 'n1',
      round: 0,
      toolName: 'adder',
      callId: 't1',
      argsChars: 13,
      argsHash: 'args-hash',
      resultChars: 1,
      resultHash: 'result-hash',
      isError: false,
    });
    // The executor stamps the attempt id.
    expect(typeof (called as { attemptId?: unknown }).attemptId).toBe('string');
  });

  it('OMITS callId and both hashes on the engine event when the telemetry carried none (fail-closed)', async () => {
    const db = freshDb().db;
    const connId = await seedConnection(db, 'http', {}, null);
    const pvId = seedVersion(db, [httpNode('n1', connId, { url: 'https://x/y', outputs: [] })]);
    const run = seedRun(db, pvId);
    const adapters = fakeHttpAdapter(async function* () {
      yield {
        type: 'toolCalled',
        call: { round: 1, toolName: '', argsChars: 0, resultChars: 0, isError: true },
      } satisfies ActivityEvent;
      yield { type: 'succeeded', outputs: {} } satisfies ActivityEvent;
    });

    await startRun(deps(db, { adapters }), run);

    const called = loadEngineEvents(db, run.id).find((e) => e.type === 'activity.toolCalled');
    expect(called).toBeDefined();
    expect(called).not.toHaveProperty('callId');
    expect(called).not.toHaveProperty('argsHash');
    expect(called).not.toHaveProperty('resultHash');
  });
});

describe('createExecutor — activity.agentTelemetry (#2 L11a agent_task telemetry)', () => {
  it('maps an agentTelemetry ActivityEvent to a durable event with ids stamped, before the terminal', async () => {
    const db = freshDb().db;
    const connId = await seedConnection(db, 'http', {}, null);
    const pvId = seedVersion(db, [httpNode('n1', connId, { url: 'https://x/y', outputs: [] })]);
    const run = seedRun(db, pvId);
    const adapters = fakeHttpAdapter(async function* () {
      yield {
        type: 'agentTelemetry',
        telemetry: {
          latencyMs: 42,
          exitCode: 0,
          summary: 'completed',
          outputChars: 5,
          outputHash: 'out-hash',
        },
      } satisfies ActivityEvent;
      yield { type: 'succeeded', outputs: {} } satisfies ActivityEvent;
    });

    const state = await startRun(deps(db, { adapters }), run);

    expect(state.status).toBe('success');
    const events = loadEngineEvents(db, run.id);
    const types = events.map((e) => e.type);
    expect(types).toContain('activity.agentTelemetry');
    expect(types.indexOf('activity.agentTelemetry')).toBeLessThan(types.indexOf('node.succeeded'));
    const telem = events.find((e) => e.type === 'activity.agentTelemetry');
    expect(telem).toMatchObject({
      runId: run.id,
      nodeId: 'n1',
      latencyMs: 42,
      exitCode: 0,
      summary: 'completed',
      outputChars: 5,
      outputHash: 'out-hash',
    });
    // The executor stamps the attempt id.
    expect(typeof (telem as { attemptId?: unknown }).attemptId).toBe('string');
  });

  it('OMITS signal and outputHash on the engine event when the telemetry carried none (fail-closed)', async () => {
    const db = freshDb().db;
    const connId = await seedConnection(db, 'http', {}, null);
    const pvId = seedVersion(db, [httpNode('n1', connId, { url: 'https://x/y', outputs: [] })]);
    const run = seedRun(db, pvId);
    const adapters = fakeHttpAdapter(async function* () {
      yield {
        type: 'agentTelemetry',
        telemetry: { latencyMs: 7, exitCode: null, summary: 'spawnFailed', outputChars: 0 },
      } satisfies ActivityEvent;
      // spawnFailed → a permanent terminal (the telemetry still lands first).
      yield { type: 'failed', kind: 'permanent', error: 'boom' } satisfies ActivityEvent;
    });

    await startRun(deps(db, { adapters }), run);

    const telem = loadEngineEvents(db, run.id).find((e) => e.type === 'activity.agentTelemetry');
    expect(telem).not.toHaveProperty('signal');
    expect(telem).not.toHaveProperty('outputHash');
    expect(telem).toMatchObject({ exitCode: null, summary: 'spawnFailed', outputChars: 0 });
  });
});

describe('createExecutor — activity.metered price fields (#2 L5 cost)', () => {
  /** Run one node that emits a single metered fact, return the stored event. */
  async function meteredOf(
    db: Db,
    connectionConfig: Record<string, unknown>,
    usage: Extract<ActivityEvent, { type: 'metered' }>['usage'],
  ): Promise<Record<string, unknown>> {
    const connId = await seedConnection(db, 'http', connectionConfig, null);
    const pvId = seedVersion(db, [httpNode('n1', connId, { url: 'https://x/y', outputs: [] })]);
    const run = seedRun(db, pvId);
    const adapters = fakeHttpAdapter(async function* () {
      yield { type: 'metered', usage } satisfies ActivityEvent;
      yield { type: 'succeeded', outputs: {} } satisfies ActivityEvent;
    });
    await startRun(deps(db, { adapters }), run);
    return loadEngineEvents(db, run.id).find(
      (e) => e.type === 'activity.metered',
    ) as unknown as Record<string, unknown>;
  }

  it('stamps unit prices + costEstimate for a priced model with a metered token pair', async () => {
    const metered = await meteredOf(
      freshDb().db,
      {},
      {
        provider: 'anthropic_api',
        model: 'claude-opus-4-8',
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        meteringStatus: 'metered',
      },
    );
    // Opus 4.8 = $5/Mtok in, $25/Mtok out → 1M×5 + 0.5M×25 (÷1e6) = 5 + 12.5 = 17.5
    expect(metered).toMatchObject({
      inUnitPrice: 5,
      outUnitPrice: 25,
      costEstimate: 17.5,
      priceTableVersion: BUILTIN_PRICE_TABLE_VERSION,
    });
  });

  it('leaves ALL price fields absent for a model with no known price (never a zero)', async () => {
    // A legacy-active Anthropic model absent from the built-in table.
    const metered = await meteredOf(
      freshDb().db,
      {},
      {
        provider: 'anthropic_api',
        model: 'claude-opus-4-5',
        inputTokens: 10,
        outputTokens: 20,
        meteringStatus: 'metered',
      },
    );
    // Usage facts still land; the price absence stays VISIBLE (no manufactured 0)
    // so L6 can flag run-cost incompleteness.
    expect(metered).toMatchObject({ model: 'claude-opus-4-5', inputTokens: 10, outputTokens: 20 });
    expect(metered).not.toHaveProperty('inUnitPrice');
    expect(metered).not.toHaveProperty('outUnitPrice');
    expect(metered).not.toHaveProperty('costEstimate');
    expect(metered).not.toHaveProperty('priceTableVersion');
  });

  it('stamps unit prices but OMITS costEstimate when usage is incomplete (unknown)', async () => {
    // Priced model, but only an input count → meteringStatus 'unknown'. A full
    // cost cannot be computed, so costEstimate is absent while the known unit
    // prices are still recorded.
    const metered = await meteredOf(
      freshDb().db,
      {},
      {
        provider: 'anthropic_api',
        model: 'claude-opus-4-8',
        inputTokens: 100,
        meteringStatus: 'unknown',
      },
    );
    expect(metered).toMatchObject({
      inUnitPrice: 5,
      outUnitPrice: 25,
      priceTableVersion: BUILTIN_PRICE_TABLE_VERSION,
      meteringStatus: 'unknown',
    });
    expect(metered).not.toHaveProperty('costEstimate');
  });

  it('applies a per-connection price override (wins over built-in absence)', async () => {
    // openai_api has no built-in price; the connection supplies one.
    const metered = await meteredOf(
      freshDb().db,
      {
        priceTable: {
          version: 'acme-v1',
          models: { 'gpt-5': { inUnitPrice: 2, outUnitPrice: 8 } },
        },
      },
      {
        provider: 'openai_api',
        model: 'gpt-5',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        meteringStatus: 'metered',
      },
    );
    // 1M×2 + 1M×8 (÷1e6) = 2 + 8 = 10
    expect(metered).toMatchObject({
      inUnitPrice: 2,
      outUnitPrice: 8,
      costEstimate: 10,
      priceTableVersion: 'acme-v1',
    });
  });

  it('leaves a prototype-named model unpriced without throwing on the durable append', async () => {
    // `model` is operator config; a value like `toString` must resolve UNPRICED
    // (own-property lookup), not to an inherited function that would mint a
    // NaN costEstimate and make the metered append throw.
    const metered = await meteredOf(
      freshDb().db,
      {},
      {
        provider: 'anthropic_api',
        model: 'toString',
        inputTokens: 5,
        outputTokens: 5,
        meteringStatus: 'metered',
      },
    );
    expect(metered).toMatchObject({ model: 'toString', meteringStatus: 'metered' });
    expect(metered).not.toHaveProperty('inUnitPrice');
    expect(metered).not.toHaveProperty('costEstimate');
  });

  it('ignores a malformed price override (fail-safe: never fails the node)', async () => {
    // A negative price is rejected by the schema → override discarded → the
    // built-in table is used, and the run still succeeds.
    const db = freshDb().db;
    const connId = await seedConnection(
      db,
      'http',
      { priceTable: { models: { 'claude-opus-4-8': { inUnitPrice: -1, outUnitPrice: 8 } } } },
      null,
    );
    const pvId = seedVersion(db, [httpNode('n1', connId, { url: 'https://x/y', outputs: [] })]);
    const run = seedRun(db, pvId);
    const adapters = fakeHttpAdapter(async function* () {
      yield {
        type: 'metered',
        usage: {
          provider: 'anthropic_api',
          model: 'claude-opus-4-8',
          inputTokens: 1_000_000,
          outputTokens: 0,
          meteringStatus: 'metered',
        },
      } satisfies ActivityEvent;
      yield { type: 'succeeded', outputs: {} } satisfies ActivityEvent;
    });
    const state = await startRun(deps(db, { adapters }), run);
    expect(state.status).toBe('success');
    const metered = loadEngineEvents(db, run.id).find((e) => e.type === 'activity.metered');
    // Built-in Opus 4.8 price, NOT the malformed override.
    expect(metered).toMatchObject({
      inUnitPrice: 5,
      outUnitPrice: 25,
      costEstimate: 5,
      priceTableVersion: BUILTIN_PRICE_TABLE_VERSION,
    });
  });

  // #2 L7 — the executor plumbs an adapter `failed.retryAfterSeconds` onto the
  // durable `node.failed`, whence the reducer feeds it to the retry alarm. An
  // adapter `failed` WITHOUT the field yields a `node.failed` without it.
  it('plumbs an adapter Retry-After hint onto node.failed, and omits it when absent', async () => {
    const db = freshDb().db;
    const connId = await seedConnection(db, 'http', {}, null);
    const pvId = seedVersion(db, [httpNode('n1', connId, { url: 'https://x' })]);
    const run = seedRun(db, pvId);
    const adapters = fakeHttpAdapter(async function* () {
      yield {
        type: 'failed',
        kind: 'rate_limit',
        error: 'slow down',
        retryAfterSeconds: 42,
      } satisfies ActivityEvent;
    });
    await startRun(deps(db, { adapters }), run);
    const failed = loadEngineEvents(db, run.id).find((e) => e.type === 'node.failed');
    // rate_limit → engine `transient`, with the hint carried through.
    expect(failed).toMatchObject({ kind: 'transient', retryAfterSeconds: 42 });

    const db2 = freshDb().db;
    const connId2 = await seedConnection(db2, 'http', {}, null);
    const pvId2 = seedVersion(db2, [httpNode('n1', connId2, { url: 'https://x' })]);
    const run2 = seedRun(db2, pvId2);
    const adapters2 = fakeHttpAdapter(async function* () {
      yield { type: 'failed', kind: 'transient', error: 'blip' } satisfies ActivityEvent;
    });
    await startRun(deps(db2, { adapters: adapters2 }), run2);
    const failed2 = loadEngineEvents(db2, run2.id).find((e) => e.type === 'node.failed');
    expect(failed2).toMatchObject({ kind: 'transient' });
    expect(failed2).not.toHaveProperty('retryAfterSeconds');
  });
});

describe('createExecutor — fs connector end-to-end (#4 A11, real fsAdapter)', () => {
  // The `fs` connector is the FIRST to serve TWO activity types through ONE
  // adapter, so it proves the executor threads `node.type` into
  // `ActivityContext.activityType` — without it the adapter cannot tell a read
  // from a write. Uses the REAL fsAdapter via `testRegistry()`.
  function fsNode(id: string, connectionId: string, config: Record<string, unknown>): Node {
    seq += 1;
    // `type` is what the executor threads as `activityType`; both file activities
    // bind an `fs` connection.
    return {
      id,
      type: config.content === undefined ? 'file_read' : 'file_write',
      config,
      connectionId,
      position: { x: seq, y: 0 },
    };
  }

  let root: string;
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'exec-fs-')));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('dispatches a file_read node and succeeds with the file content (activityType threaded)', async () => {
    await writeFile(join(root, 'greeting.txt'), 'from disk', 'utf8');
    const db = freshDb().db;
    const connId = await seedConnection(db, 'fs', { roots: [root] }, null);
    const pvId = seedVersion(db, [fsNode('n1', connId, { path: 'greeting.txt' })]);
    const run = seedRun(db, pvId);

    const state = await startRun(deps(db), run);

    expect(state.status).toBe('success');
    const succeeded = loadEngineEvents(db, run.id).find((e) => e.type === 'node.succeeded');
    expect(succeeded).toMatchObject({
      outputs: { content: 'from disk', path: join(root, 'greeting.txt') },
    });
  });

  it('dispatches a file_write node and the bytes land on disk', async () => {
    const db = freshDb().db;
    const connId = await seedConnection(db, 'fs', { roots: [root] }, null);
    const pvId = seedVersion(db, [
      fsNode('n1', connId, { path: 'written.txt', content: 'payload' }),
    ]);
    const run = seedRun(db, pvId);

    const state = await startRun(deps(db), run);

    expect(state.status).toBe('success');
    expect(await readFile(join(root, 'written.txt'), 'utf8')).toBe('payload');
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

  // #3 G8a — the SECRET-READINESS dispatch GATE: a node whose connection is
  // operator-disabled or missing its required secret is refused BEFORE any
  // secret decrypt or adapter call (the gate is at fire time, not enable time).
  it('refuses to dispatch a node bound to a needs_secret connection (permanent, no dispatch)', async () => {
    const db = freshDb().db;
    // anthropic_api with NO secret ⟹ deriveSecretStatus → needs_secret.
    const connId = await seedConnection(db, 'anthropic_api', {}, null);
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
    expect(eventTypes(db, run.id)).not.toContain('node.dispatched');
    expect(loadEngineEvents(db, run.id).find((e) => e.type === 'node.failed')).toMatchObject({
      error: expect.stringContaining('needs_secret'),
      kind: 'permanent',
      code: 'connection_not_ready',
    });
  });

  it('refuses to dispatch a node bound to a disabled connection (permanent, no dispatch)', async () => {
    const db = freshDb().db;
    // http is `not_required`, so it would otherwise pass readiness — flip the
    // operator `enabled` flag off directly (G8a has no toggle write path yet)
    // to exercise the enable axis of the gate in isolation.
    const connId = await seedConnection(db, 'http', {}, null);
    db.update(connections).set({ enabled: false }).where(eq(connections.id, connId)).run();
    const pvId = seedVersion(db, [httpNode('n1', connId, { url: 'https://x' })]);
    const run = seedRun(db, pvId);

    const state = await startRun(deps(db), run);
    expect(state.status).toBe('failure');
    expect(eventTypes(db, run.id)).not.toContain('node.dispatched');
    expect(loadEngineEvents(db, run.id).find((e) => e.type === 'node.failed')).toMatchObject({
      error: expect.stringContaining('disabled'),
      kind: 'permanent',
      code: 'connection_not_ready',
    });
  });

  it('a not_required (credential-less) connection PASSES the readiness gate and dispatches', async () => {
    const db = freshDb().db;
    // http with no secret ⟹ not_required, enabled ⟹ the gate lets it through
    // to dispatch (proving the gate refuses only needs_secret / disabled).
    const connId = await seedConnection(db, 'http', {}, null);
    // An explicit empty output contract so a `succeeded{outputs:{}}` from the
    // fake adapter validates (mirrors the activity.metered test).
    const pvId = seedVersion(db, [httpNode('n1', connId, { url: 'https://x', outputs: [] })]);
    const run = seedRun(db, pvId);

    const adapters = fakeHttpAdapter(async function* () {
      yield { type: 'succeeded', outputs: {} } satisfies ActivityEvent;
    });
    const state = await startRun(deps(db, { adapters }), run);
    expect(state.status).toBe('success');
    expect(eventTypes(db, run.id)).toContain('node.dispatched');
  });
});

describe('createExecutor — #2 L13a dynamic connectionId routing', () => {
  // Seed a version whose http node routes by `${params.provider}` — the param
  // MUST be declared or `validatePipelineDoc` (my new connectionId scan) refuses
  // the version, so this also proves the save-gate accepts a well-formed ref.
  function routeVersion(db: Db, connExpr: string): string {
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
    return createPipelineVersion(db, {
      pipelineId: pipeline.id,
      params: [{ name: 'provider', type: 'string', required: true }],
      outputs: [],
      nodes: [httpNode('n1', connExpr, { url: 'https://x/y', outputs: [] })],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    }).id;
  }
  function routeRun(db: Db, pvId: string, provider: string) {
    return createRun(db, {
      ownerId: 'local',
      pipelineVersionId: pvId,
      triggerId: null,
      parentRunId: null,
      params: { provider },
    });
  }
  // An adapter that records the connectionConfig it was handed, proving the run
  // reached the connection the param selected (not merely "a" connection).
  function capturingAdapter(sink: { config?: Record<string, unknown> }): ConnectorRegistry {
    return fakeHttpAdapter(async function* (ctx) {
      sink.config = ctx.connectionConfig;
      yield { type: 'succeeded', outputs: {} } satisfies ActivityEvent;
    });
  }

  it('routes to the connection a ${params.provider} resolves to', async () => {
    const db = freshDb().db;
    // Two connections exist so routing has a genuine choice; the run must reach B.
    await seedConnection(db, 'http', { tag: 'A' }, null);
    const connB = await seedConnection(db, 'http', { tag: 'B' }, null);
    const pvId = routeVersion(db, '${params.provider}');

    const sink: { config?: Record<string, unknown> } = {};
    const state = await startRun(
      deps(db, { adapters: capturingAdapter(sink) }),
      routeRun(db, pvId, connB),
    );

    expect(state.status).toBe('success');
    // The run reached B's connection, not A's — genuine routing by param.
    expect(sink.config).toEqual({ tag: 'B' });
  });

  it('the SAME node routes to the OTHER connection when the param changes', async () => {
    const db = freshDb().db;
    const connA = await seedConnection(db, 'http', { tag: 'A' }, null);
    await seedConnection(db, 'http', { tag: 'B' }, null);
    const pvId = routeVersion(db, '${params.provider}');

    const sink: { config?: Record<string, unknown> } = {};
    const state = await startRun(
      deps(db, { adapters: capturingAdapter(sink) }),
      routeRun(db, pvId, connA),
    );
    expect(state.status).toBe('success');
    expect(sink.config).toEqual({ tag: 'A' });
  });

  it('a ${} that resolves to an unknown id fails with CONNECTION_NOT_FOUND (not MISSING)', async () => {
    const db = freshDb().db;
    await seedConnection(db, 'http', { tag: 'A' }, null);
    const pvId = routeVersion(db, '${params.provider}');
    const run = routeRun(db, pvId, 'conn-does-not-exist');

    const state = await startRun(deps(db), run);
    expect(state.status).toBe('failure');
    expect(loadEngineEvents(db, run.id).find((e) => e.type === 'node.failed')).toMatchObject({
      error: expect.stringContaining("connection 'conn-does-not-exist' not found"),
      kind: 'permanent',
      code: 'connection_not_found',
    });
  });

  it('REFUSES a ${} resolving to ANOTHER owner’s connection id (authz, not just authn)', async () => {
    // The escalation L13a widened: `connectionId` now derives from run params
    // (trigger-influenceable), so a run must not be able to steer dispatch onto
    // a connection it does not own and decrypt that connection's secret. Folds
    // into NOT_FOUND (never leaks that the id names a real, other-owned row).
    const db = freshDb().db;
    const foreign = createConnection(db, {
      ownerId: 'someone-else',
      name: 'Foreign',
      kind: 'http',
      config: {},
      secretRef: null,
    });
    const pvId = routeVersion(db, '${params.provider}'); // run owner is 'local'
    const run = routeRun(db, pvId, foreign.id);

    const state = await startRun(deps(db), run);
    expect(state.status).toBe('failure');
    expect(loadEngineEvents(db, run.id).find((e) => e.type === 'node.failed')).toMatchObject({
      code: 'connection_not_found',
    });
  });

  it('ALLOWS a ${} resolving to a null-owner (shared/global) connection', async () => {
    // A null-owner connection is not "another owner's private" row — it is
    // shared, so any run may bind it (the owner check is `!== null && !== owner`).
    const db = freshDb().db;
    const shared = createConnection(db, {
      ownerId: null,
      name: 'Shared',
      kind: 'http',
      config: { tag: 'shared' },
      secretRef: null,
    });
    const pvId = routeVersion(db, '${params.provider}');

    const sink: { config?: Record<string, unknown> } = {};
    const state = await startRun(
      deps(db, { adapters: capturingAdapter(sink) }),
      routeRun(db, pvId, shared.id),
    );
    expect(state.status).toBe('success');
    expect(sink.config).toEqual({ tag: 'shared' });
  });

  it('a ${} that resolves to the EMPTY string is bound-but-empty → CONNECTION_NOT_FOUND', async () => {
    // A bound ref that resolves to '' is distinct from a node with NO connection
    // (which is CONNECTION_MISSING) — the guard is `=== undefined`, not falsy.
    const db = freshDb().db;
    const pvId = routeVersion(db, '${params.provider}');
    const run = routeRun(db, pvId, '');

    const state = await startRun(deps(db), run);
    expect(state.status).toBe('failure');
    expect(loadEngineEvents(db, run.id).find((e) => e.type === 'node.failed')).toMatchObject({
      code: 'connection_not_found',
    });
  });
});

describe('createExecutor — #2 L13b connection parameters (dispatch-time merge)', () => {
  // A version whose http node binds `model` (+ optionally more) per-dispatch.
  function paramsVersion(
    db: Db,
    connectionId: string,
    connectionParams: Record<string, unknown>,
  ): string {
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
    return createPipelineVersion(db, {
      pipelineId: pipeline.id,
      params: [{ name: 'm', type: 'json', required: false }],
      outputs: [],
      nodes: [
        {
          ...httpNode('n1', connectionId, { url: 'https://x/y', outputs: [] }),
          connectionParams,
        },
      ],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    }).id;
  }
  function paramsRun(db: Db, pvId: string, params: Record<string, unknown> = {}) {
    return createRun(db, {
      ownerId: 'local',
      pipelineVersionId: pvId,
      triggerId: null,
      parentRunId: null,
      params,
    });
  }
  function capturingAdapter(sink: { config?: Record<string, unknown> }): ConnectorRegistry {
    return fakeHttpAdapter(async function* (ctx) {
      sink.config = ctx.connectionConfig;
      yield { type: 'succeeded', outputs: {} } satisfies ActivityEvent;
    });
  }

  it('shallow-merges a DECLARED binding over the static config; un-bound keys survive', async () => {
    const db = freshDb().db;
    const connId = createConnection(db, {
      ownerId: 'local',
      name: 'C',
      kind: 'http',
      config: { tag: 'static', model: 'default-model' },
      parameters: ['model'],
      secretRef: null,
    }).id;
    const pvId = paramsVersion(db, connId, { model: 'override-model' });

    const sink: { config?: Record<string, unknown> } = {};
    const state = await startRun(
      deps(db, { adapters: capturingAdapter(sink) }),
      paramsRun(db, pvId),
    );
    expect(state.status).toBe('success');
    // `model` overridden, `tag` untouched — the static value is the default.
    expect(sink.config).toEqual({ tag: 'static', model: 'override-model' });
  });

  it('REFUSES an UNDECLARED binding key — permanent, its own code, allowlist is the connection owner\u2019s', async () => {
    const db = freshDb().db;
    const connId = createConnection(db, {
      ownerId: 'local',
      name: 'C',
      kind: 'http',
      config: { tag: 'static' },
      parameters: [], // nothing declared — nothing overridable
      secretRef: null,
    }).id;
    const pvId = paramsVersion(db, connId, { model: 'sneaky' });
    const run = paramsRun(db, pvId);

    const state = await startRun(deps(db), run);
    expect(state.status).toBe('failure');
    expect(loadEngineEvents(db, run.id).find((e) => e.type === 'node.failed')).toMatchObject({
      error: expect.stringContaining("does not declare parameter 'model'"),
      kind: 'permanent',
      code: 'connection_param_undeclared',
    });
  });

  it('REFUSES a resolved binding value that is (or embeds) a {$secret} marker', async () => {
    // Parameters are NON-secret by design. A `${}` binding can resolve to a
    // run-param-supplied json value, so a marker can be INJECTED at run time —
    // the guard must judge the RESOLVED value, not the authored config.
    const db = freshDb().db;
    const connId = createConnection(db, {
      ownerId: 'local',
      name: 'C',
      kind: 'http',
      config: {},
      parameters: ['model'],
      secretRef: null,
    }).id;
    const pvId = paramsVersion(db, connId, { model: '${params.m}' });
    const run = paramsRun(db, pvId, { m: { nested: { $secret: 'smuggled' } } });

    const state = await startRun(deps(db), run);
    expect(state.status).toBe('failure');
    expect(loadEngineEvents(db, run.id).find((e) => e.type === 'node.failed')).toMatchObject({
      kind: 'permanent',
      code: 'connection_param_secret_marker',
    });
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

describe('createExecutor — config-sink secrets: dispatch resolution + redaction (item 7 / S3)', () => {
  // A synthetic activity that declares a secret SINK. No REAL activity declares
  // one until S4, and the SAVE gate (`createPipelineVersion`) uses the REAL
  // catalog, so a stored version can't carry a marker at a synthetic sink. These
  // tests therefore inject the sink catalog into the EXECUTOR and feed it the
  // marker-doc through a custom `resolveDoc` — exercising the real resolution +
  // redaction path against a doc the executor really would run.
  function sinkCatalog(over: Partial<ActivityCatalogEntry> = {}): ActivityCatalog {
    const entry: ActivityCatalogEntry = {
      type: 'secret_sink_test',
      title: 'Sink Test',
      kind: 'execution',
      category: 'general',
      idempotent: false,
      connectionKinds: ['http'],
      outputs: [],
      configSchema: z.record(z.string(), z.unknown()),
      secretSinkFields: ['secretHeaders'],
      ...over,
    };
    return new Map([[entry.type, entry]]);
  }

  /** A stored trivial version (satisfies the run FK) whose doc is REPLACED by
   * `markerNode` — the marker never passes the real-catalog save gate, so the
   * executor reads it via `resolveDoc`, not the DB row. */
  function seedMarkerRun(
    db: Db,
    markerNode: Node,
    opts: { ownerId?: string | null } = {},
  ): { doc: PipelineVersion; run: ReturnType<typeof createRun>; runId: string } {
    const ownerId = opts.ownerId === undefined ? 'local' : opts.ownerId;
    const pipeline = createPipeline(db, { ownerId: ownerId ?? 'local', name: 'P' });
    const stored = createPipelineVersion(db, {
      pipelineId: pipeline.id,
      params: [],
      outputs: [],
      nodes: [httpNode('placeholder', undefined, {})],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    });
    const doc: PipelineVersion = { ...stored, nodes: [markerNode] };
    const run = createRun(db, {
      ownerId,
      pipelineVersionId: stored.id,
      triggerId: null,
      parentRunId: null,
      params: {},
    });
    return { doc, run, runId: run.id };
  }

  function depsForDoc(
    db: Db,
    doc: PipelineVersion,
    over: { adapters?: ConnectorRegistry; masterKey?: Uint8Array; catalog?: ActivityCatalog } = {},
  ) {
    const resolveDoc: DocResolver = (id) => {
      if (id === doc.id) return doc;
      throw new Error(`unexpected pv ${id}`);
    };
    return {
      db,
      resolveDoc,
      executor: createExecutor({
        db,
        masterKey: over.masterKey ?? KEY,
        resolveDoc,
        adapters: over.adapters ?? testRegistry(),
        catalog: over.catalog ?? sinkCatalog(),
      }),
      alarms: refuseToArm,
    };
  }

  /** A synthetic node carrying a `{$secret}` marker at the declared sink. */
  async function seedNamedSecret(db: Db, name: string, plaintext: string, ownerId = 'local') {
    createSecret(db, {
      ref: `sref-${(seq += 1)}`,
      ciphertext: await encrypt(plaintext, KEY),
      ownerId,
      name,
    });
  }

  function markerNode(name: string, connectionId: string): Node {
    seq += 1;
    return {
      id: 'n1',
      type: 'secret_sink_test',
      config: { secretHeaders: { 'X-Api-Key': { $secret: name } } },
      connectionId,
      position: { x: seq, y: 0 },
    };
  }

  it('resolves the marker into secretFields (keyed by config path), never persisting the plaintext', async () => {
    const db = freshDb().db;
    const PLAINTEXT = 'sk-config-sink-value';
    await seedNamedSecret(db, 'my-key', PLAINTEXT);
    const connId = await seedConnection(db, 'http', {}, null);
    const { doc, run, runId } = seedMarkerRun(db, markerNode('my-key', connId));

    let received: Readonly<Record<string, string>> | undefined = { UNSET: 'yes' };
    let inputAtAdapter: unknown;
    const adapters = fakeHttpAdapter(async function* (ctx, _secret, secretFields) {
      received = secretFields;
      inputAtAdapter = ctx.input;
      yield { type: 'succeeded', outputs: {} } satisfies ActivityEvent;
    });

    const state = await startRun(depsForDoc(db, doc, { adapters }), run);
    expect(state.status).toBe('success');

    // The adapter got the decrypted plaintext keyed by CONFIG PATH...
    expect(received).toEqual({ 'secretHeaders.X-Api-Key': PLAINTEXT });
    // ...ctx.input STILL carries only the inert marker (a NAME, safe to log)...
    expect((inputAtAdapter as Record<string, unknown>).secretHeaders).toEqual({
      'X-Api-Key': { $secret: 'my-key' },
    });
    // ...and NOTHING plaintext is in the durable log (event OR preparedInput).
    const raw = JSON.stringify(loadEngineEvents(db, runId));
    expect(raw).not.toContain(PLAINTEXT);
    expect(raw).not.toContain('preparedInput');
  });

  it('a marker naming a MISSING secret fails permanent (config_secret_not_found) with NO node.dispatched', async () => {
    const db = freshDb().db;
    const connId = await seedConnection(db, 'http', {}, null);
    const { doc, run, runId } = seedMarkerRun(db, markerNode('no-such-secret', connId));

    const state = await startRun(depsForDoc(db, doc), run);
    expect(state.status).toBe('failure');
    // Pre-flight resolution → node fails while still `ready`, no durable dispatch.
    expect(eventTypes(db, runId)).not.toContain('node.dispatched');
    expect(loadEngineEvents(db, runId).find((e) => e.type === 'node.failed')).toMatchObject({
      error: expect.stringContaining("secret 'no-such-secret' not found"),
      kind: 'permanent',
      code: 'config_secret_not_found',
    });
  });

  it('a config-sink secret that will not decrypt fails config_secret_undecryptable, leaking no ciphertext', async () => {
    const db = freshDb().db;
    await seedNamedSecret(db, 'rotated-key', 'sk-under-the-OLD-key');
    const connId = await seedConnection(db, 'http', {}, null);
    const { doc, run, runId } = seedMarkerRun(db, markerNode('rotated-key', connId));

    const otherKey = new Uint8Array(32).fill(9);
    const state = await startRun(depsForDoc(db, doc, { masterKey: otherKey }), run);

    expect(state.status).toBe('failure');
    expect(eventTypes(db, runId)).not.toContain('node.dispatched');
    const failed = loadEngineEvents(db, runId).find((e) => e.type === 'node.failed');
    expect(failed).toMatchObject({ kind: 'permanent', code: 'config_secret_undecryptable' });
    expect((failed as { error: string }).error).not.toContain('sk-under');
  });

  it('owner-scopes the lookup — a secret owned by ANOTHER owner is not-found for this run', async () => {
    const db = freshDb().db;
    // The name exists, but under a DIFFERENT owner than the run.
    await seedNamedSecret(db, 'shared-name', 'not-yours', 'someone-else');
    const connId = await seedConnection(db, 'http', {}, null);
    const { doc, run, runId } = seedMarkerRun(db, markerNode('shared-name', connId), {
      ownerId: 'local',
    });

    const state = await startRun(depsForDoc(db, doc), run);
    expect(state.status).toBe('failure');
    expect(loadEngineEvents(db, runId).find((e) => e.type === 'node.failed')).toMatchObject({
      code: 'config_secret_not_found',
    });
  });

  it('a NULL-owner run cannot resolve a standalone secret (fail-closed, no owner namespace)', async () => {
    const db = freshDb().db;
    // Even a globally-present name must not resolve for a run with no owner.
    await seedNamedSecret(db, 'orphan-key', 'value', 'local');
    // A null-owner (shared) connection so this test isolates the CONFIG-SECRET
    // null-owner gate: a null-owner run is now also refused an OWNED connection
    // (#2 L13a authz), which would otherwise fail this run one gate earlier with
    // `connection_not_found`. A shared connection resolves, so the run reaches
    // and exercises the standalone-secret fail-closed this test is about.
    const connId = createConnection(db, {
      ownerId: null,
      name: 'Shared',
      kind: 'http',
      config: {},
      secretRef: null,
    }).id;
    const { doc, run, runId } = seedMarkerRun(db, markerNode('orphan-key', connId), {
      ownerId: null,
    });

    const state = await startRun(depsForDoc(db, doc), run);
    expect(state.status).toBe('failure');
    expect(loadEngineEvents(db, runId).find((e) => e.type === 'node.failed')).toMatchObject({
      code: 'config_secret_not_found',
    });
  });

  it('redacts a resolved plaintext an adapter echoes into a node.output AND node.succeeded outputs', async () => {
    const db = freshDb().db;
    const PLAINTEXT = 'sk-leaky-value';
    await seedNamedSecret(db, 'leaky', PLAINTEXT);
    const connId = await seedConnection(db, 'http', {}, null);
    const { doc, run, runId } = seedMarkerRun(db, markerNode('leaky', connId));

    // A hostile/buggy adapter that echoes the plaintext into both an output
    // stream event and the final outputs — the executor choke point must scrub both.
    const adapters = fakeHttpAdapter(async function* (): AsyncIterable<ActivityEvent> {
      yield { type: 'output', name: 'dbg', value: `saw ${PLAINTEXT} here` };
      yield { type: 'succeeded', outputs: { echoed: { nested: PLAINTEXT } } };
    });

    const state = await startRun(depsForDoc(db, doc, { adapters }), run);
    expect(state.status).toBe('success');

    const events = loadEngineEvents(db, runId);
    const out = events.find((e) => e.type === 'node.output') as { value: unknown } | undefined;
    expect(out?.value).toBe('saw *** here');
    const ok = events.find((e) => e.type === 'node.succeeded') as
      { outputs: Record<string, unknown> } | undefined;
    expect(ok?.outputs).toEqual({ echoed: { nested: '***' } });
    // Belt-and-braces: the plaintext appears NOWHERE in the durable log.
    expect(JSON.stringify(events)).not.toContain(PLAINTEXT);
  });

  it('redacts a resolved plaintext an adapter echoes into a node.failed error message', async () => {
    const db = freshDb().db;
    const PLAINTEXT = 'sk-in-the-error';
    await seedNamedSecret(db, 'errkey', PLAINTEXT);
    const connId = await seedConnection(db, 'http', {}, null);
    const { doc, run, runId } = seedMarkerRun(db, markerNode('errkey', connId));

    const adapters = fakeHttpAdapter(async function* (): AsyncIterable<ActivityEvent> {
      yield { type: 'failed', kind: 'permanent', error: `boom: ${PLAINTEXT}` };
    });

    const state = await startRun(depsForDoc(db, doc, { adapters }), run);
    expect(state.status).toBe('failure');
    const failed = loadEngineEvents(db, runId).find((e) => e.type === 'node.failed') as
      { error: string } | undefined;
    expect(failed?.error).toBe('boom: ***');
    expect(JSON.stringify(loadEngineEvents(db, runId))).not.toContain(PLAINTEXT);
  });

  it('folds the CONNECTION secret into the same choke-point pass (no scrub asymmetry)', async () => {
    // Deviation (b)'s guarantee: once a config sink pulls the choke point on,
    // the connection `secret` is redacted from the SAME emitted events — not
    // just the config-sink plaintext. Prove it with a NON-null connection secret
    // the adapter echoes alongside the config secret.
    const db = freshDb().db;
    const CONFIG_PLAINTEXT = 'sk-config-sink';
    const CONN_PLAINTEXT = 'sk-connection-cred';
    await seedNamedSecret(db, 'cfg', CONFIG_PLAINTEXT);
    const connId = await seedConnection(db, 'http', {}, CONN_PLAINTEXT);
    const { doc, run, runId } = seedMarkerRun(db, markerNode('cfg', connId));

    const adapters = fakeHttpAdapter(async function* (): AsyncIterable<ActivityEvent> {
      // A hostile adapter echoing BOTH plaintexts it was handed.
      yield {
        type: 'failed',
        kind: 'permanent',
        error: `leak ${CONN_PLAINTEXT} and ${CONFIG_PLAINTEXT}`,
      };
    });

    const state = await startRun(depsForDoc(db, doc, { adapters }), run);
    expect(state.status).toBe('failure');
    const failed = loadEngineEvents(db, runId).find((e) => e.type === 'node.failed') as
      { error: string } | undefined;
    expect(failed?.error).toBe('leak *** and ***');
    const raw = JSON.stringify(loadEngineEvents(db, runId));
    expect(raw).not.toContain(CONN_PLAINTEXT);
    expect(raw).not.toContain(CONFIG_PLAINTEXT);
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
      // The http_request node now carries its catalog output contract (F13b/#456
      // lowers it in on save), so a real adapter must yield those declared
      // outputs or the node fails validation — mirror the real adapter here.
      yield { type: 'succeeded', outputs: { status: 200, body: '', headers: {} } };
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

describe('createExecutor — item 7 / S4: http_request config-sink secret headers, end-to-end', () => {
  // The DIFFERENCE from the S3 block above: no synthetic catalog, no bypassed
  // save gate. The version is authored through the REAL `createPipelineVersion`
  // (default catalog), proving `http_request`'s `secretHeaders` sink now lets a
  // `{$secret}` marker PASS the save gate; the run uses the REAL `httpAdapter`
  // (via `testRegistry()`) with a mocked `fetch`, proving the resolved plaintext
  // reaches the wire as a header and NEVER the durable log.
  it('authors a marker past the real save gate, sends it as a header, keeps plaintext out of the log', async () => {
    const db = freshDb().db;
    const PLAINTEXT = 'sk-s4-end-to-end-secret';

    // A standalone named secret owned by the run owner.
    createSecret(db, {
      ref: `sref-s4-${(seq += 1)}`,
      ciphertext: await encrypt(PLAINTEXT, KEY),
      ownerId: 'local',
      name: 'api-key',
    });
    const connId = await seedConnection(db, 'http', {}, null);

    // The REAL save gate accepts the marker ONLY because `secretHeaders` is a
    // declared sink (S4) — a marker in `headers` would be refused here.
    const pvId = seedVersion(db, [
      httpNode('n1', connId, {
        url: 'https://api.example.com/thing',
        secretHeaders: { 'X-Api-Key': { $secret: 'api-key' } },
      }),
    ]);
    const run = seedRun(db, pvId);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      status: 200,
      text: () => Promise.resolve('OK'),
      headers: new Headers({ 'x-h': '1' }),
    } as unknown as Response);

    const state = await startRun(deps(db), run);
    expect(state.status).toBe('success');

    // The resolved plaintext went out under its declared header name...
    const sent = (fetchSpy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(sent['X-Api-Key']).toBe(PLAINTEXT);

    // ...but NOTHING plaintext (nor a `preparedInput`) is in the durable run
    // log — `node.dispatched` carries no input, so the events never hold it.
    const raw = JSON.stringify(loadEngineEvents(db, run.id));
    expect(raw).not.toContain(PLAINTEXT);
    expect(raw).not.toContain('preparedInput');

    // What DOES persist is the inert `{$secret:api-key}` marker, in the stored
    // pipeline VERSION (a name, safe to persist/export/diff) — never plaintext.
    const stored = getPipelineVersion(db, pvId)!;
    expect(stored.nodes[0]!.config.secretHeaders).toEqual({ 'X-Api-Key': { $secret: 'api-key' } });
    expect(JSON.stringify(stored)).not.toContain(PLAINTEXT);
  });

  it('a NON-marker value at secretHeaders fails PERMANENT, never silently sending it', async () => {
    // The save gate only VISITS `{$secret}`-shaped values (isSecretRef), so a raw
    // string at the sink is not a marker to bless OR refuse — it passes save. At
    // dispatch it is left in ctx.input (never resolved to a secretField), where the
    // adapter's `secretHeaders: z.record(SecretRefSchema)` rejects it as a permanent
    // config error. The PR's fail-loud claim: a misauthored sink FAILS, it does not
    // silently drop the value onto the wire. Proven through the REAL save gate +
    // REAL httpAdapter (not the S3 synthetic-catalog block above).
    const db = freshDb().db;
    const connId = await seedConnection(db, 'http', {}, null);
    const pvId = seedVersion(db, [
      httpNode('n1', connId, {
        url: 'https://api.example.com/thing',
        secretHeaders: { 'X-Api-Key': 'raw-plaintext-not-a-marker' },
      }),
    ]);
    const run = seedRun(db, pvId);

    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const state = await startRun(deps(db), run);
    expect(state.status).toBe('failure');
    // Fail-loud, not silent-drop: the misauthored request never reaches the wire.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(loadEngineEvents(db, run.id).find((e) => e.type === 'node.failed')).toMatchObject({
      kind: 'permanent',
      error: expect.stringContaining('invalid http_request activity config'),
    });
  });
});

// --- #2 L14c: CLI/subscription quota admission gate + window writer ----------

/** A fake `agent_cli` adapter yielding a caller-supplied terminal, so the quota
 * tests never spawn a real subprocess (the `noopSupervisor` would throw). */
function fakeAgentCliAdapter(run: ConnectorAdapter['runActivity']): ConnectorRegistry {
  const adapter: ConnectorAdapter = {
    kind: 'agent_cli',
    configSchema: z.object({}).passthrough(),
    testConnection: () => Promise.resolve({ ok: true }),
    runActivity: run,
  };
  return new Map([['agent_cli', adapter]]);
}

function agentTaskNode(
  id: string,
  connectionId: string | undefined,
  policy?: Node['policy'],
): Node {
  seq += 1;
  return {
    id,
    type: 'agent_task',
    config: { task: 'do work' },
    connectionId,
    position: { x: seq, y: 0 },
    ...(policy !== undefined ? { policy } : {}),
  };
}

/** An adapter runActivity that yields a subscription-quota `rate_limit` failure
 * carrying `retryAfterSeconds` — the reactive shape L14c's first slice emits. */
const rateLimit = (retryAfterSeconds: number): ConnectorAdapter['runActivity'] =>
  async function* () {
    yield { type: 'failed', kind: 'rate_limit', error: 'quota exhausted', retryAfterSeconds };
  };

describe('#2 L14c — quota window writer (driver, sole persister)', () => {
  it('records the reset window on an agent_cli rate_limit, anchored to the event ts', async () => {
    const db = freshDb().db;
    const connId = await seedConnection(db, 'agent_cli', {}, 'k');
    const pvId = seedVersion(db, [agentTaskNode('n1', connId)]);
    const run = seedRun(db, pvId);

    await startRun(deps(db, { adapters: fakeAgentCliAdapter(rateLimit(300)) }), run);

    const failed = loadEngineEvents(db, run.id).find((e) => e.type === 'node.failed');
    expect(failed).toMatchObject({ code: 'rate_limit', connectionId: connId });
    // The window is anchored to the FAILURE EVENT's durable ts (not a fresh clock),
    // so it is a pure function of the frozen event and idempotent on replay. Read
    // the row's stored ts off the raw log to pin the exact `ts + retryAfter` epoch.
    const failedRow = db
      .select({ ts: runEvents.ts })
      .from(runEvents)
      .where(and(eq(runEvents.runId, run.id), eq(runEvents.type, 'node.failed')))
      .get();
    expect(failedRow).toBeDefined();
    expect(getConnectionQuotaResetEpoch(db, connId)).toBe(failedRow!.ts + 300 * 1000);
  });

  it('does NOT record a window for a provider-API rate_limit (no subscription quota)', async () => {
    // An `http` connection's `rate_limit` shares the code AND is stamped with its
    // resolved `connectionId` on the dispatched failure — so this proves the driver
    // gates the window writer on `kind === agent_cli`, not merely on the presence of
    // a connectionId. A provider-API 429 has no subscription quota window.
    const db = freshDb().db;
    const connId = await seedConnection(db, 'http', {}, null);
    const pvId = seedVersion(db, [httpNode('n1', connId, { url: 'https://x/y' })]);
    const run = seedRun(db, pvId);
    const adapters = fakeHttpAdapter(async function* () {
      yield { type: 'failed', kind: 'rate_limit', error: 'slow down', retryAfterSeconds: 120 };
    });

    await startRun(deps(db, { adapters }), run);

    const failed = loadEngineEvents(db, run.id).find((e) => e.type === 'node.failed');
    // The failure IS a rate_limit carrying both the hint and the connectionId, but
    // the connection is `http` not `agent_cli` → the driver records no window.
    expect(failed).toMatchObject({
      code: 'rate_limit',
      retryAfterSeconds: 120,
      connectionId: connId,
    });
    expect(getConnectionQuotaResetEpoch(db, connId)).toBeNull();
  });
});

describe('#2 L14c — quota admission gate (executor pre-flight)', () => {
  it('short-circuits an agent_cli dispatch during an active window WITHOUT spawning', async () => {
    const db = freshDb().db;
    const connId = await seedConnection(db, 'agent_cli', {}, 'k');
    const pvId = seedVersion(db, [agentTaskNode('n1', connId)]);
    const run = seedRun(db, pvId);
    // An active window: reset 60s in the future of the injected clock.
    const now = () => 1_000_000;
    recordConnectionQuotaExhaustion(db, connId, 1_000_000 + 60_000, 900_000);

    // This adapter MUST NOT be reached — a hit means the gate failed to fire.
    const neverCalled = vi.fn();
    const registry = fakeAgentCliAdapter(
      // eslint-disable-next-line require-yield
      async function* () {
        neverCalled();
        throw new Error('adapter should not run while the quota window is active');
      },
    );

    await startRun(deps(db, { adapters: registry, now }), run);

    expect(neverCalled).not.toHaveBeenCalled();
    const types = eventTypes(db, run.id);
    expect(types).not.toContain('node.dispatched');
    const failed = loadEngineEvents(db, run.id).find((e) => e.type === 'node.failed');
    expect(failed).toMatchObject({ kind: 'transient', code: 'rate_limit', retryAfterSeconds: 60 });
    // A pre-dispatch failure carries NO connectionId, so the writer does not
    // re-record the window it is reacting to.
    expect(failed).not.toHaveProperty('connectionId');
  });

  it('does NOT gate once the window has elapsed (dispatch proceeds to the adapter)', async () => {
    const db = freshDb().db;
    const connId = await seedConnection(db, 'agent_cli', {}, 'k');
    const pvId = seedVersion(db, [agentTaskNode('n1', connId)]);
    const run = seedRun(db, pvId);
    // A window that reset in the PAST relative to the injected clock → not active.
    const now = () => 2_000_000;
    recordConnectionQuotaExhaustion(db, connId, 1_500_000, 1_400_000);

    const reached = vi.fn();
    const registry = fakeAgentCliAdapter(async function* () {
      reached();
      yield { type: 'succeeded', outputs: { result: 'ok' } };
    });

    await startRun(deps(db, { adapters: registry, now }), run);

    expect(reached).toHaveBeenCalledTimes(1);
    expect(eventTypes(db, run.id)).toContain('node.dispatched');
  });

  it('a gated node WITH a retry policy actually arms a retry at the window end (flows through L7)', async () => {
    // The gate emits `kind:'transient'` + `retryAfterSeconds` precisely so it
    // flows through the L7 retry path exactly like an adapter-reported rate_limit
    // — so a gated node that DECLARES a retry budget must genuinely arm a retry
    // (not merely fail-shaped-as-transient). The same injected clock drives both
    // the gate's remaining-window math and the retry's `dueAt`, so the armed alarm
    // lands exactly at the window reset, WITHOUT ever reaching the adapter.
    const db = freshDb().db;
    const connId = await seedConnection(db, 'agent_cli', {}, 'k');
    const pvId = seedVersion(db, [
      agentTaskNode('n1', connId, { retry: 1, retryIntervalSeconds: 300 }),
    ]);
    const run = seedRun(db, pvId);
    const now = () => 1_000_000;
    recordConnectionQuotaExhaustion(db, connId, 1_000_000 + 60_000, 900_000);

    const neverCalled = vi.fn();
    const registry = fakeAgentCliAdapter(
      // eslint-disable-next-line require-yield
      async function* () {
        neverCalled();
        throw new Error('adapter should not run while the quota window is active');
      },
    );
    const alarms = stubAlarms();

    await startRun(deps(db, { adapters: registry, now, alarms }), run);

    // The gate short-circuited (no dispatch), yet a real retry was armed — landing
    // at the window reset (now + the gate's 60s remaining), NOT the 300s static
    // policy interval, so the provider-authority hint governs (#602/L7).
    expect(neverCalled).not.toHaveBeenCalled();
    expect(eventTypes(db, run.id)).toContain('node.retryScheduled');
    expect(alarms.armed).toHaveLength(1);
    const [armed] = alarms.armed;
    expect(armed).toBeDefined();
    expect(armed!.dueAt).toBe(1_000_000 + 60_000);
    expect(armed!.ref).toMatchObject({ runId: run.id, nodeId: 'n1' });
  });
});

// ===========================================================================
// #2 L12 — the transcript augmentation: an `emitMessages: true` llm_call's
// `node.succeeded` gains a `messages` output (history + authored turns + the
// final assistant text), assembled at the executor's single succeeded site.
// ===========================================================================

describe('createExecutor — L12 emitMessages transcript + history threading', () => {
  function llmNode(id: string, connectionId: string, config: Record<string, unknown>): Node {
    seq += 1;
    return { id, type: 'llm_call', config, connectionId, position: { x: seq, y: 0 } };
  }

  /** A fake anthropic adapter that answers `ANS(<prompt-or-last-turn>)`. */
  function fakeLlmAdapter(text: (input: Record<string, unknown>) => string): ConnectorRegistry {
    const adapter: ConnectorAdapter = {
      kind: 'anthropic_api',
      configSchema: testRegistry().get('anthropic_api')!.configSchema,
      testConnection: () => Promise.resolve({ ok: true }),
      runActivity: async function* (ctx) {
        yield {
          type: 'succeeded',
          outputs: { text: text(ctx.input), stopReason: 'end_turn' },
        } satisfies ActivityEvent;
      },
    };
    return new Map([['anthropic_api', adapter]]);
  }

  function seedLlmVersion(db: Db, nodes: Node[], edges: { from: string; to: string }[]): string {
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
    const input: NewPipelineVersion = {
      pipelineId: pipeline.id,
      params: [],
      outputs: [],
      nodes,
      edges: edges.map(({ from, to }) => ({ id: `${from}->${to}`, from, to, on: 'success' })),
      catalogVersion: CATALOG_VERSION,
    };
    return createPipelineVersion(db, input).id;
  }

  it('emits the transcript output and threads it through a downstream history ref (end-to-end)', async () => {
    const db = freshDb().db;
    const connId = await seedConnection(db, 'anthropic_api', {}, 'sk-test');
    const pvId = seedLlmVersion(
      db,
      [
        llmNode('a', connId, { prompt: 'first question', emitMessages: true }),
        llmNode('b', connId, {
          prompt: 'follow-up',
          history: '${nodes.a.output.messages}',
          emitMessages: true,
        }),
      ],
      [{ from: 'a', to: 'b' }],
    );
    const run = seedRun(db, pvId);

    const state = await startRun(
      deps(db, { adapters: fakeLlmAdapter((input) => `ANS(${String(input['prompt'])})`) }),
      run,
    );

    expect(state.status).toBe('success');
    const events = loadEngineEvents(db, run.id);
    const succeededA = events.find((e) => e.type === 'node.succeeded' && e.nodeId === 'a');
    expect(succeededA).toMatchObject({
      outputs: {
        text: 'ANS(first question)',
        messages: [
          { role: 'user', content: 'first question' },
          { role: 'assistant', content: 'ANS(first question)' },
        ],
      },
    });
    // b's transcript COMPOUNDS: a's turns (via the history ref), b's own turn,
    // b's completion — the multi-turn chain with zero mutable state.
    const succeededB = events.find((e) => e.type === 'node.succeeded' && e.nodeId === 'b');
    expect(succeededB).toMatchObject({
      outputs: {
        messages: [
          { role: 'user', content: 'first question' },
          { role: 'assistant', content: 'ANS(first question)' },
          { role: 'user', content: 'follow-up' },
          { role: 'assistant', content: 'ANS(follow-up)' },
        ],
      },
    });
  });

  it('emits NO messages key without the flag (contract and emission stay in lockstep)', async () => {
    const db = freshDb().db;
    const connId = await seedConnection(db, 'anthropic_api', {}, 'sk-test');
    const pvId = seedLlmVersion(db, [llmNode('a', connId, { prompt: 'q' })], []);
    const run = seedRun(db, pvId);

    const state = await startRun(deps(db, { adapters: fakeLlmAdapter(() => 'A') }), run);

    expect(state.status).toBe('success');
    const succeeded = loadEngineEvents(db, run.id).find((e) => e.type === 'node.succeeded');
    expect(succeeded).toMatchObject({ outputs: { text: 'A', stopReason: 'end_turn' } });
    expect((succeeded as { outputs: Record<string, unknown> }).outputs['messages']).toBeUndefined();
  });

  it('omits the assistant turn from the transcript on an EMPTY completion (never a manufactured empty turn)', async () => {
    const db = freshDb().db;
    const connId = await seedConnection(db, 'anthropic_api', {}, 'sk-test');
    const pvId = seedLlmVersion(
      db,
      [llmNode('a', connId, { prompt: 'q', emitMessages: true })],
      [],
    );
    const run = seedRun(db, pvId);

    const state = await startRun(deps(db, { adapters: fakeLlmAdapter(() => '') }), run);

    expect(state.status).toBe('success');
    const succeeded = loadEngineEvents(db, run.id).find((e) => e.type === 'node.succeeded');
    expect(succeeded).toMatchObject({
      outputs: { text: '', messages: [{ role: 'user', content: 'q' }] },
    });
  });
});

describe('createExecutor — L12 transcript is connection-kind-agnostic (single choke-point)', () => {
  it('augments an agent_cli-kind llm_call the same way (emission keys off activityType, not adapter)', async () => {
    const db = freshDb().db;
    const connId = await seedConnection(db, 'agent_cli', {}, null);
    const adapter: ConnectorAdapter = {
      kind: 'agent_cli',
      configSchema: testRegistry().get('agent_cli')!.configSchema,
      testConnection: () => Promise.resolve({ ok: true }),
      runActivity: async function* () {
        yield {
          type: 'succeeded',
          outputs: { text: 'CLI SAYS', stopReason: 'end_turn' },
        } satisfies ActivityEvent;
      },
    };
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
    const pvId = createPipelineVersion(db, {
      pipelineId: pipeline.id,
      params: [],
      outputs: [],
      nodes: [
        {
          id: 'a',
          type: 'llm_call',
          config: { prompt: 'q', emitMessages: true },
          connectionId: connId,
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    }).id;
    const run = seedRun(db, pvId);

    const state = await startRun(deps(db, { adapters: new Map([['agent_cli', adapter]]) }), run);

    expect(state.status).toBe('success');
    const succeeded = loadEngineEvents(db, run.id).find((e) => e.type === 'node.succeeded');
    expect(succeeded).toMatchObject({
      outputs: {
        text: 'CLI SAYS',
        messages: [
          { role: 'user', content: 'q' },
          { role: 'assistant', content: 'CLI SAYS' },
        ],
      },
    });
  });
});
