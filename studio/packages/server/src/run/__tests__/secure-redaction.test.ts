/**
 * #1 F4 — a secure node's plaintext never reaches `run_events` or the live
 * stream. Driven end to end through the REAL pump against a real DB, and read
 * back as the raw stored rows, so the assertion is about what was persisted —
 * not about what an in-memory projection happens to hold.
 */
import { describe, expect, it } from 'vitest';
import {
  CATALOG_VERSION,
  SECURE_ERROR_WITHHELD,
  SECURE_REDACTED,
  type NewPipelineVersion,
  type Node,
  type RunEvent,
} from '@autonomy-studio/shared';
import { eq } from 'drizzle-orm';
import { runEvents } from '../../db/schema.js';
import { createPipeline } from '../../repo/pipelines.js';
import { createPipelineVersion, getPipelineVersion } from '../../repo/pipeline-versions.js';
import { createRun } from '../../repo/runs.js';
import { freshDb } from '../../repo/__tests__/helpers.js';
import { startRun, type DocResolver, type DriverDeps } from '../driver.js';
import { createRunEventBus } from '../event-bus.js';
import { makeStubExecutor, type StubExecutorOptions } from './stub-executor.js';
import { stubAlarms } from './stub-alarms.js';

type Db = ReturnType<typeof freshDb>['db'];
const PLAINTEXT = 'hunter2-plaintext';

function node(id: string, extra: Partial<Node> = {}): Node {
  // Uncatalogued type: an `absent` output contract, so the stub's ad-hoc
  // outputs pass through (see driver.test.ts's `node`).
  return { id, type: 'test_activity', config: {}, position: { x: 0, y: 0 }, ...extra };
}

async function drive(nodes: Node[], executorOpts: StubExecutorOptions) {
  const { db } = freshDb();
  const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
  const input: NewPipelineVersion = {
    pipelineId: pipeline.id,
    params: [],
    outputs: [],
    nodes,
    edges: [],
    catalogVersion: CATALOG_VERSION,
  };
  const pv = createPipelineVersion(db, input);
  const run = createRun(db, {
    ownerId: 'local',
    pipelineVersionId: pv.id,
    triggerId: null,
    parentRunId: null,
    params: {},
  });
  const resolveDoc: DocResolver = (id) => {
    const found = getPipelineVersion(db as Db, id);
    if (found === null) throw new Error(`no pv ${id}`);
    return found;
  };
  const published: RunEvent[] = [];
  const bus = createRunEventBus();
  bus.subscribeAll((e) => published.push(e));
  const deps: DriverDeps = {
    db,
    resolveDoc,
    executor: makeStubExecutor(executorOpts),
    alarms: stubAlarms(),
    bus,
  };
  const state = await startRun(deps, run);
  const stored = db
    .select({ payload: runEvents.payload })
    .from(runEvents)
    .where(eq(runEvents.runId, run.id))
    .all()
    .map((r) => JSON.stringify(r.payload))
    .join('\n');
  return { state, stored, streamed: JSON.stringify(published) };
}

describe('#1 F4 — emit-time redaction reaches the stored log', () => {
  it("a secureOutput node's output is stored and streamed only as the marker", async () => {
    const { state, stored, streamed } = await drive(
      [node('a', { policy: { secureOutput: true } })],
      { nodes: { a: { outputs: { token: PLAINTEXT } } } },
    );
    expect(state.status).toBe('success');
    expect(stored).not.toContain(PLAINTEXT);
    expect(streamed).not.toContain(PLAINTEXT);
    expect(stored).toContain(SECURE_REDACTED);
    expect(state.outputs['a']).toEqual({ token: SECURE_REDACTED });
  });

  it("a secure node's failure prose is withheld; its kind still routes", async () => {
    const { state, stored } = await drive([node('a', { policy: { secureInput: true } })], {
      nodes: { a: { outcome: 'failure', error: `bad request: ${PLAINTEXT}` } },
    });
    expect(state.status).toBe('failure');
    expect(stored).not.toContain(PLAINTEXT);
    expect(stored).toContain(SECURE_ERROR_WITHHELD);
  });

  // #605 L9b — a `capture: 'full'` node's prompt/completion TEXT. The stored
  // row keeps the lengths and the marker, never the text or a `truncated`.
  const capturedText = (at: { runId: string; nodeId: string; attemptId: string }) => [
    {
      type: 'activity.captured' as const,
      ...at,
      provider: 'ollama',
      model: 'm',
      latencyMs: 1,
      request: {
        messageCount: 1,
        messages: [
          {
            role: 'user' as const,
            chars: PLAINTEXT.length,
            contentHash: 'h',
            text: PLAINTEXT,
            truncated: true as const,
          },
        ],
      },
      completion: { chars: 3, contentHash: 'h2', text: `${PLAINTEXT}-out` },
    },
  ];

  it("a secure node's captured prompt/completion text is stored only as the marker", async () => {
    const { stored, streamed } = await drive([node('a', { policy: { secureInput: true } })], {
      nodes: { a: { activityEvents: capturedText } },
    });
    expect(stored).not.toContain(PLAINTEXT);
    expect(streamed).not.toContain(PLAINTEXT);
    const row = stored.split('\n').find((l) => l.includes('activity.captured'));
    expect(row).toBeDefined();
    const payload = JSON.parse(row!) as {
      request: { messages: Record<string, unknown>[] };
      completion: Record<string, unknown>;
    };
    expect(payload.request.messages[0]).toEqual({
      role: 'user',
      chars: PLAINTEXT.length,
      contentHash: SECURE_REDACTED,
      text: SECURE_REDACTED,
    });
    expect(payload.completion).toEqual({
      chars: 3,
      contentHash: SECURE_REDACTED,
      text: SECURE_REDACTED,
    });
  });

  it('a node WITHOUT the flag stores its captured text as-is', async () => {
    const { stored } = await drive([node('a')], {
      nodes: { a: { activityEvents: capturedText } },
    });
    expect(stored).toContain(`${PLAINTEXT}-out`);
  });

  // The control: without the flag the same run stores the plaintext, so the two
  // assertions above are about the flag and not about the fixture.
  it('a node WITHOUT the flag stores its output as-is', async () => {
    const { stored } = await drive([node('a')], {
      nodes: { a: { outputs: { token: PLAINTEXT } } },
    });
    expect(stored).toContain(PLAINTEXT);
  });
});
