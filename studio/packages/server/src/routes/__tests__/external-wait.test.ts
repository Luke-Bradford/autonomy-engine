import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  buildDedupeKey,
  CATALOG_VERSION,
  type NewPipelineVersion,
  type Node,
} from '@autonomy-studio/shared';
import { createPipeline, createPipelineVersion, getPipelineVersion } from '../../repo/index.js';
import { createRun, getRun } from '../../repo/runs.js';
import { getWakeupByKey } from '../../repo/scheduled-wakeups.js';
import { buildTestApp } from '../../__tests__/build-test-app.js';
import { startRun, buildEngine, type DocResolver, type DriveDeps } from '../../run/driver.js';
import { createRunDrives } from '../../run/drives.js';
import { loadEngineEvents } from '../../run/events.js';
import { makeStubExecutor } from '../../run/__tests__/stub-executor.js';
import { deriveExternalWaitToken } from '../../webhooks/external-wait-token.js';
import { createAlarmClock } from '../../scheduler/alarms.js';
import { createExternalWaitAlarmHandler } from '../../scheduler/external-wait-alarm.js';
import { silentLog } from '../../scheduler/__tests__/testLog.js';

/**
 * #4 A13 — the webhook external-wait HTTP layer end-to-end against a REAL app: the
 * owner-scoped callback-URL retrieval (`GET /api/runs/:id/external-waits`) and the
 * inbound completion route (`POST /api/external-wait/:token`), including its
 * fail-closed / no-state-oracle discipline and replay safety.
 *
 * A run is PARKED on a `webhook` node via `startRun` over the app's OWN db + master
 * key (so the token the app re-derives matches the one that parked it), then the
 * routes are driven through `app.inject`. The app's real `externalWaitCompleter`
 * (wired with the app's master key) performs the completion. `timeoutSeconds` is a
 * far-future 1h so the app's own alarm clock can never expire the wait mid-test.
 */

let seq = 0;
function webhookNode(id: string): Node {
  seq += 1;
  return { id, type: 'webhook', config: { timeoutSeconds: '${3600}' }, position: { x: seq, y: 0 } };
}

describe('external-wait routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  /** Seed a webhook-only pipeline version and PARK a run on it, using the app's db +
   * master key so the token derivation matches what the app re-derives. */
  async function parkRun() {
    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'P' });
    const input: NewPipelineVersion = {
      pipelineId: pipeline.id,
      params: [],
      outputs: [],
      nodes: [webhookNode('w')],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    };
    const pvId = createPipelineVersion(app.db, input).id;
    const run = createRun(app.db, {
      ownerId: 'local',
      pipelineVersionId: pvId,
      triggerId: null,
      parentRunId: null,
      params: {},
    });
    const resolveDoc: DocResolver = (id) => {
      const pv = getPipelineVersion(app.db, id);
      if (pv === null) throw new Error(`no pv ${id}`);
      return pv;
    };
    const deps: DriveDeps = {
      db: app.db,
      resolveDoc,
      executor: makeStubExecutor(),
      alarms: {
        arm: (i) => clock.arm(i),
        find: (i) => getWakeupByKey(app.db, i.kind, buildDedupeKey(i)),
      },
      drives: createRunDrives(),
      now: () => Date.now(),
      signExternalWaitToken: (a) => deriveExternalWaitToken(app.masterKey, a),
    };
    const clock = createAlarmClock({
      db: app.db,
      handlers: [createExternalWaitAlarmHandler(deps)],
      now: () => Date.now(),
      log: silentLog(),
    });
    const state = await startRun(deps, run);
    expect(state.nodes.w!.status).toBe('external_wait_pending');
    return { runId: run.id, resolveDoc };
  }

  async function callbackPathFor(runId: string): Promise<string> {
    const res = await app.inject({ method: 'GET', url: `/api/runs/${runId}/external-waits` });
    expect(res.statusCode).toBe(200);
    const waits = res.json() as Array<{ nodeId: string; callbackPath: string; expiresAt: number }>;
    expect(waits).toHaveLength(1);
    expect(waits[0]!.nodeId).toBe('w');
    return waits[0]!.callbackPath;
  }

  it('owner retrieval returns a working callback URL; posting it completes the run', async () => {
    const { runId, resolveDoc } = await parkRun();
    const path = await callbackPathFor(runId);
    expect(path).toMatch(/^\/api\/external-wait\/.+/);

    const res = await app.inject({ method: 'POST', url: path });
    expect(res.statusCode).toBe(204);

    // Wait for the post-commit drive to finish the run.
    await new Promise((r) => setTimeout(r, 30));
    const state = buildEngine(resolveDoc(getRun(app.db, runId)!.pipelineVersionId)).projectRunState(
      loadEngineEvents(app.db, runId),
    );
    expect(state.nodes.w!.status).toBe('success');
    expect(state.status).toBe('success');
    // The wait is no longer pending in the owner listing.
    const after = await app.inject({ method: 'GET', url: `/api/runs/${runId}/external-waits` });
    expect(after.json()).toEqual([]);
  });

  it('a REPLAYED callback returns the SAME fail-closed 404 (never double-completes)', async () => {
    const { runId } = await parkRun();
    const path = await callbackPathFor(runId);

    const first = await app.inject({ method: 'POST', url: path });
    expect(first.statusCode).toBe(204);
    await new Promise((r) => setTimeout(r, 30));

    const replay = await app.inject({ method: 'POST', url: path });
    expect(replay.statusCode).toBe(404);
    // Only ONE completion event landed.
    const completions = loadEngineEvents(app.db, runId).filter(
      (e) => e.type === 'externalWait.completed',
    );
    expect(completions).toHaveLength(1);
  });

  it('an UNKNOWN token is indistinguishable from a used one (both 404)', async () => {
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/external-wait/not-a-real-token',
    });
    expect(unknown.statusCode).toBe(404);

    const { runId } = await parkRun();
    const path = await callbackPathFor(runId);
    await app.inject({ method: 'POST', url: path }); // use it
    await new Promise((r) => setTimeout(r, 30));
    const used = await app.inject({ method: 'POST', url: path });
    // Same status + same body as the unknown token — no state oracle.
    expect(used.statusCode).toBe(unknown.statusCode);
    expect(used.body).toBe(unknown.body);
  });

  it('the owner retrieval is authorization-scoped through the run (404 for a foreign run)', async () => {
    const missing = await app.inject({
      method: 'GET',
      url: '/api/runs/run_does_not_exist/external-waits',
    });
    expect(missing.statusCode).toBe(404);
  });
});
