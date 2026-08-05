import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  buildDedupeKey,
  ApiErrorBodySchema,
  CATALOG_VERSION,
  PendingExternalWaitListSchema,
  type NewPipelineVersion,
  type Node,
} from '@autonomy-studio/shared';
import { createPipeline, createPipelineVersion, getPipelineVersion } from '../../repo/index.js';
import { createRun, getRun } from '../../repo/runs.js';
import { markExternalWaitExpired } from '../../repo/external-waits.js';
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
function webhookNode(id: string, outputs?: Array<{ name: string; type: string }>): Node {
  seq += 1;
  const config: Record<string, unknown> = { timeoutSeconds: '${3600}' };
  if (outputs !== undefined) config.outputs = outputs;
  return { id, type: 'webhook', config, position: { x: seq, y: 0 } };
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
   * master key so the token derivation matches what the app re-derives. An optional
   * declared `config.outputs` contract exercises the #4 A16 typed-output path. */
  async function parkRun(outputs?: Array<{ name: string; type: string }>) {
    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'P' });
    const input: NewPipelineVersion = {
      pipelineId: pipeline.id,
      params: [],
      outputs: [],
      nodes: [webhookNode('w', outputs)],
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

  /**
   * #900 — the retrieval response is held to the SHARED schema, not merely to
   * whatever this file happens to destructure. The web client parses through this
   * same schema, so a field renamed or dropped here fails on THIS side rather than
   * silently degrading a rendered surface into "no waits". Parsed strictly enough
   * to matter: the row's stored token hash and `status` must not ride along.
   */
  it('the retrieval response satisfies the shared PendingExternalWait contract', async () => {
    const { runId } = await parkRun();
    const res = await app.inject({ method: 'GET', url: `/api/runs/${runId}/external-waits` });
    expect(res.statusCode).toBe(200);

    const waits = PendingExternalWaitListSchema.parse(res.json());
    expect(waits).toHaveLength(1);
    expect(waits[0]!.nodeId).toBe('w');
    expect(waits[0]!.expiresAt).toBeGreaterThan(0);

    const raw = (res.json() as Array<Record<string, unknown>>)[0]!;
    expect(Object.keys(raw).sort()).toEqual(['attemptId', 'callbackPath', 'expiresAt', 'nodeId']);
  });

  it('a run with no parked webhook returns an empty list, not a 404', async () => {
    // The client renders the callback section only when the run is parked on a
    // CALLBACK, but a run parked on a timer is also `waiting` — this is the shape
    // that must come back for it rather than an error the page would have to
    // distinguish from a real failure.
    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'no-wait' });
    const input: NewPipelineVersion = {
      pipelineId: pipeline.id,
      params: [],
      outputs: [],
      nodes: [{ id: 'n', type: 'fail', config: { message: 'x' }, position: { x: 0, y: 0 } }],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    };
    const run = createRun(app.db, {
      ownerId: 'local',
      pipelineVersionId: createPipelineVersion(app.db, input).id,
      triggerId: null,
      parentRunId: null,
      params: {},
    });

    const res = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/external-waits` });
    expect(res.statusCode).toBe(200);
    expect(PendingExternalWaitListSchema.parse(res.json())).toEqual([]);
  });

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

  // #4 A16 — typed webhook output.
  function projectState(runId: string, resolveDoc: DocResolver) {
    return buildEngine(resolveDoc(getRun(app.db, runId)!.pipelineVersionId)).projectRunState(
      loadEngineEvents(app.db, runId),
    );
  }

  it('a valid typed body completes the node and stores the declared, filtered outputs', async () => {
    const { runId, resolveDoc } = await parkRun([{ name: 'decision', type: 'string' }]);
    const path = await callbackPathFor(runId);

    const res = await app.inject({
      method: 'POST',
      url: path,
      payload: { decision: 'approve', ignored: 'dropped' },
    });
    expect(res.statusCode).toBe(204);

    await new Promise((r) => setTimeout(r, 30));
    const state = projectState(runId, resolveDoc);
    expect(state.nodes.w!.status).toBe('success');
    // Undeclared keys filtered at the boundary; only the declared output persists.
    expect(state.outputs.w).toEqual({ decision: 'approve' });
  });

  it('a body missing a declared output → 422 and the node STAYS parked (no completion)', async () => {
    const { runId, resolveDoc } = await parkRun([{ name: 'decision', type: 'string' }]);
    const path = await callbackPathFor(runId);

    const res = await app.inject({ method: 'POST', url: path, payload: { note: 'no decision' } });
    expect(res.statusCode).toBe(422);
    // The 422 names WHICH declared field failed so a live-token holder can correct
    // it on retry (safe to reveal — reachable only past the token + parked checks).
    expect(res.json().detail).toContain('decision');

    await new Promise((r) => setTimeout(r, 30));
    const state = projectState(runId, resolveDoc);
    // Left parked to retry; nothing appended.
    expect(state.nodes.w!.status).toBe('external_wait_pending');
    const completions = loadEngineEvents(app.db, runId).filter(
      (e) => e.type === 'externalWait.completed',
    );
    expect(completions).toHaveLength(0);
  });

  it('a mistyped declared output → 422 (number declared, string sent)', async () => {
    const { runId } = await parkRun([{ name: 'score', type: 'number' }]);
    const path = await callbackPathFor(runId);
    const res = await app.inject({ method: 'POST', url: path, payload: { score: 'high' } });
    expect(res.statusCode).toBe(422);
  });

  it('a rejected body leaves the wait live: a corrected retry then completes it', async () => {
    const { runId, resolveDoc } = await parkRun([{ name: 'decision', type: 'string' }]);
    const path = await callbackPathFor(runId);

    const bad = await app.inject({ method: 'POST', url: path, payload: { wrong: true } });
    expect(bad.statusCode).toBe(422);

    // The SAME token/URL still works — the node never left external_wait_pending.
    const good = await app.inject({ method: 'POST', url: path, payload: { decision: 'reject' } });
    expect(good.statusCode).toBe(204);
    await new Promise((r) => setTimeout(r, 30));
    const state = projectState(runId, resolveDoc);
    expect(state.nodes.w!.status).toBe('success');
    expect(state.outputs.w).toEqual({ decision: 'reject' });
  });

  it('a webhook with NO declared outputs still accepts any body and completes with {} (A13)', async () => {
    const { runId, resolveDoc } = await parkRun(); // no contract
    const path = await callbackPathFor(runId);
    const res = await app.inject({ method: 'POST', url: path, payload: { anything: 'goes' } });
    expect(res.statusCode).toBe(204);
    await new Promise((r) => setTimeout(r, 30));
    const state = projectState(runId, resolveDoc);
    expect(state.nodes.w!.status).toBe('success');
    // No contract → nothing refable → the untrusted body is never persisted.
    expect(state.outputs.w).toEqual({});
  });

  it('a JSON body sent as text/plain still buffers + validates (all default parsers removed)', async () => {
    // Fastify 5 ships default exact-match parsers for BOTH application/json AND
    // text/plain; the plugin removes ALL of them so `*` buffers every body. A valid
    // JSON payload under a text/plain content-type must therefore still complete.
    const { runId, resolveDoc } = await parkRun([{ name: 'decision', type: 'string' }]);
    const path = await callbackPathFor(runId);
    const res = await app.inject({
      method: 'POST',
      url: path,
      headers: { 'content-type': 'text/plain' },
      payload: JSON.stringify({ decision: 'approve' }),
    });
    expect(res.statusCode).toBe(204);
    await new Promise((r) => setTimeout(r, 30));
    expect(projectState(runId, resolveDoc).outputs.w).toEqual({ decision: 'approve' });
  });

  it('an invalid-payload 422 is only reachable with a LIVE token (unknown token still 404)', async () => {
    // A guesser cannot even reach the 422 branch — the contract check runs only
    // after the token + parked checks pass, so an unknown token is a plain 404.
    const res = await app.inject({
      method: 'POST',
      url: '/api/external-wait/not-a-real-token',
      payload: { decision: 'approve' },
    });
    expect(res.statusCode).toBe(404);
  });

  /**
   * #901 — the OWNER-scoped completion route, `POST /api/runs/:id/external-waits/
   * complete`: the same settle, reached through the run the caller owns instead of
   * through a capability token.
   *
   * These tests hold the two properties that justify a second door existing at all.
   * (1) The TOKEN never leaves the server — every request below sends only
   * `(nodeId, attemptId, payload)`. (2) The route DISCLOSES state an owner is
   * entitled to (`already completed` / `expired` / which field failed) where the
   * anonymous seam above must answer an identical 404 — those tests sit in the same
   * file deliberately, so a change that relaxed the seam's no-oracle collapse would
   * have to walk past them.
   */
  async function pendingWaitFor(runId: string) {
    const res = await app.inject({ method: 'GET', url: `/api/runs/${runId}/external-waits` });
    expect(res.statusCode).toBe(200);
    const waits = PendingExternalWaitListSchema.parse(res.json());
    expect(waits).toHaveLength(1);
    return waits[0]!;
  }

  function completeAsOwner(runId: string, body: unknown) {
    return app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/external-waits/complete`,
      payload: body,
    });
  }

  it('#901 — an owner completes a parked wait from the app, sending NO token', async () => {
    const { runId, resolveDoc } = await parkRun([{ name: 'decision', type: 'string' }]);
    const wait = await pendingWaitFor(runId);

    const res = await completeAsOwner(runId, {
      nodeId: wait.nodeId,
      attemptId: wait.attemptId,
      payload: { decision: 'approve', ignored: 'dropped' },
    });
    expect(res.statusCode).toBe(204);

    await new Promise((r) => setTimeout(r, 30));
    const state = projectState(runId, resolveDoc);
    expect(state.nodes.w!.status).toBe('success');
    // Same boundary filtering as the anonymous seam — one settle path, two doors.
    expect(state.outputs.w).toEqual({ decision: 'approve' });
  });

  it('#901 — the capability token crosses the wire in NEITHER direction', async () => {
    // The whole reason this route exists rather than the SPA calling
    // `/api/external-wait/:token`: completing a wait must not require shipping a
    // live bearer credential into the browser. The request above carried no token
    // (and succeeded), and the response must not hand one back either.
    const { runId } = await parkRun();
    const wait = await pendingWaitFor(runId);
    const token = deriveExternalWaitToken(app.masterKey, {
      runId,
      nodeId: wait.nodeId,
      attemptId: wait.attemptId,
    });

    const res = await completeAsOwner(runId, {
      nodeId: wait.nodeId,
      attemptId: wait.attemptId,
      payload: {},
    });
    expect(res.statusCode).toBe(204);
    expect(res.body).not.toContain(token);
    expect(res.body).not.toContain('external-wait/');
  });

  it('#901 — completion is authorization-scoped through the run (a FOREIGN run is 404)', async () => {
    // Authentication is not authorization. The run exists and is genuinely parked;
    // it simply is not the caller's, and a non-owner must not be able to resume
    // someone else's run — nor learn from the status that it exists.
    const { runId, resolveDoc } = await parkRun();
    const wait = await pendingWaitFor(runId);
    app.db.run(sql`UPDATE runs SET owner_id = 'somebody-else' WHERE id = ${runId}`);

    const res = await completeAsOwner(runId, {
      nodeId: wait.nodeId,
      attemptId: wait.attemptId,
      payload: {},
    });
    expect(res.statusCode).toBe(404);

    app.db.run(sql`UPDATE runs SET owner_id = 'local' WHERE id = ${runId}`);
    await new Promise((r) => setTimeout(r, 30));
    // Refused BEFORE the settle: the node is untouched, not merely unreported.
    expect(projectState(runId, resolveDoc).nodes.w!.status).toBe('external_wait_pending');
  });

  it('#901 — a non-existent run is the same 404', async () => {
    const res = await completeAsOwner('run_does_not_exist', {
      nodeId: 'w',
      attemptId: 'a_1',
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it('#901 — a STALE attemptId is refused, never redirected onto the live attempt', async () => {
    // The CAS, and the reason `attemptId` is in the body at all (#904's shape). A
    // webhook that expires re-parks under a NEW attempt, so a body composed for the
    // attempt the operator was LOOKING at must not silently settle a later one.
    const { runId, resolveDoc } = await parkRun([{ name: 'decision', type: 'string' }]);
    const wait = await pendingWaitFor(runId);

    const res = await completeAsOwner(runId, {
      nodeId: wait.nodeId,
      attemptId: `${wait.attemptId}-stale`,
      payload: { decision: 'approve' },
    });
    expect(res.statusCode).toBe(404);

    await new Promise((r) => setTimeout(r, 30));
    const state = projectState(runId, resolveDoc);
    expect(state.nodes.w!.status).toBe('external_wait_pending');
    expect(loadEngineEvents(app.db, runId).filter((e) => e.type === 'externalWait.completed'))
      .toHaveLength(0);
  });

  it('#901 — an unknown nodeId on an owned run is a 404', async () => {
    const { runId } = await parkRun();
    const wait = await pendingWaitFor(runId);
    const res = await completeAsOwner(runId, {
      nodeId: 'no-such-node',
      attemptId: wait.attemptId,
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it('#901 — an ALREADY-COMPLETED wait says so (409), where the token seam says 404', async () => {
    const { runId } = await parkRun();
    const wait = await pendingWaitFor(runId);
    const first = await completeAsOwner(runId, {
      nodeId: wait.nodeId,
      attemptId: wait.attemptId,
      payload: {},
    });
    expect(first.statusCode).toBe(204);

    const second = await completeAsOwner(runId, {
      nodeId: wait.nodeId,
      attemptId: wait.attemptId,
      payload: {},
    });
    expect(second.statusCode).toBe(409);
    // Through the CENTRAL error handler, so the body is the shared contract and the
    // client's `messageFromBody` can actually show the reason — the defect #901 was
    // opened over (the seam's own 404/422 bodies bypass it and lose their detail).
    const body = ApiErrorBodySchema.parse(second.json());
    expect(body.error).toBe('external_wait_settled');
    expect(body.message).toContain('already completed');
  });

  it('#901 — an EXPIRED wait is a 410, distinguished from a completed one', async () => {
    const { runId } = await parkRun();
    const wait = await pendingWaitFor(runId);
    // Settle the ROW as the expiry alarm does. The alarm also fails the node; this
    // exercises the route's status mapping, which reads the row and answers before
    // the completer is ever reached.
    expect(
      markExternalWaitExpired(
        app.db,
        { runId, nodeId: wait.nodeId, attemptId: wait.attemptId },
        Date.now(),
      ),
    ).toBe(true);

    const res = await completeAsOwner(runId, {
      nodeId: wait.nodeId,
      attemptId: wait.attemptId,
      payload: {},
    });
    expect(res.statusCode).toBe(410);
    const body = ApiErrorBodySchema.parse(res.json());
    expect(body.error).toBe('external_wait_settled');
    expect(body.message).toContain('expired');
  });

  it('#901 — a body failing the declared contract is a 422 that NAMES the field, and retries', async () => {
    const { runId, resolveDoc } = await parkRun([{ name: 'decision', type: 'string' }]);
    const wait = await pendingWaitFor(runId);

    const bad = await completeAsOwner(runId, {
      nodeId: wait.nodeId,
      attemptId: wait.attemptId,
      payload: { note: 'no decision' },
    });
    expect(bad.statusCode).toBe(422);
    const body = ApiErrorBodySchema.parse(bad.json());
    expect(body.error).toBe('external_wait_payload');
    // A PAYLOAD defect, so the completer's reason survives to the operator. (A
    // CONTRACT defect — the node's own corrupt `config.outputs` — is withheld and
    // logged server-side instead, which is why the UI must not promise a reason.)
    expect(body.message).toContain('decision');

    await new Promise((r) => setTimeout(r, 30));
    expect(projectState(runId, resolveDoc).nodes.w!.status).toBe('external_wait_pending');

    // Still live: the operator corrects the JSON and sends it again.
    const good = await completeAsOwner(runId, {
      nodeId: wait.nodeId,
      attemptId: wait.attemptId,
      payload: { decision: 'reject' },
    });
    expect(good.statusCode).toBe(204);
    await new Promise((r) => setTimeout(r, 30));
    expect(projectState(runId, resolveDoc).outputs.w).toEqual({ decision: 'reject' });
  });

  it('#901 — a body missing `attemptId` is a 400, never an unpinned completion', async () => {
    const { runId } = await parkRun();
    const res = await completeAsOwner(runId, { nodeId: 'w', payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('#901 — an ABSENT payload is refused, not manufactured as an empty one', async () => {
    // `payload` is required with no `.default()`: an absent fact must never be
    // invented as a benign one (#473/#904). Sending nothing is a malformed request,
    // not a decision to complete the wait with no outputs.
    const { runId } = await parkRun();
    const wait = await pendingWaitFor(runId);
    const res = await completeAsOwner(runId, {
      nodeId: wait.nodeId,
      attemptId: wait.attemptId,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('#646 — a corrupt run LOG behind a live callback is a 500, not a 400', () => {
  it('server-side log corruption is never blamed on the caller as validation_error', async () => {
    const app = await buildTestApp();
    try {
      // Reuse the outer harness shape inline (this describe has its own app so
      // the poison row cannot leak into the shared instance's later tests).
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
      await startRun(deps, run);

      const list = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/external-waits` });
      const path = (list.json() as Array<{ callbackPath: string }>)[0]!.callbackPath;

      // Poison appended row (the log's UPDATE is trigger-blocked — #642
      // precedent). Deliberately the ZodError CLASS — valid JSON, wrong shape —
      // because that is the class whose route behavior this pins: before #646
      // the raw ZodError from the log read fell into the global ZodError→400
      // mapping (`errors.ts`), telling the EXTERNAL CALLER its POST was
      // invalid. The typed RunLogUnparseableError is a server fault: 500.
      // (The SyntaxError class was already a 500 — no change to pin there.)
      app.db.run(
        sql`INSERT INTO run_events (id, run_id, seq, type, payload, ts)
            VALUES ('evt_poison', ${run.id}, 999, 'x', '{"type":"no.such.event"}', ${Date.now()})`,
      );
      const res = await app.inject({ method: 'POST', url: path });
      expect(res.statusCode).toBe(500);
      expect((res.json() as { error: string }).error).toBe('internal_error');
    } finally {
      await app.close();
    }
  });
});
