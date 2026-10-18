import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CATALOG_VERSION,
  getActivity,
  lowerRetiredTypes,
  WEB_ACTIVITY_TYPE,
  WEBHOOK_ACTIVITY_TYPE,
  type Container,
  type Node,
  type Param,
} from '@autonomy-studio/shared';
import { buildTestAppWithContext } from '../../__tests__/build-test-app.js';
import { until } from '../../__tests__/poll-until.js';
import { armWakeup, listPendingWakeups } from '../../repo/scheduled-wakeups.js';
import { createConnection } from '../../repo/connections.js';
import { createPipeline, createPipelineVersion, getPipelineVersion } from '../../repo/index.js';
import { createRun, getRun, updateRun } from '../../repo/runs.js';
import { getExternalWaitByAttempt, recordExternalWait } from '../../repo/external-waits.js';
import {
  deriveExternalWaitToken,
  externalWaitCallbackUrl,
  hashExternalWaitToken,
} from '../../webhooks/external-wait-token.js';
import { buildEngine, externalWaitArmInput } from '../driver.js';
import { appendEngineEvent, loadEngineEvents } from '../events.js';
import { resolvePublicBaseUrl } from '../../index.js';

/**
 * #1600 OR41 C11c — Web *Wait for callback*, end to end through the app: the real
 * executor sends `callBackUri` to a local endpoint, the driver parks the node on
 * the external-wait machinery, and the anonymous callback route settles it.
 *
 * The endpoint plays the remote system: it reads `callBackUri` from the body and
 * calls it back through `app.inject` (the app is not listening), either after it
 * answers (the usual 202 pattern) or BEFORE it answers, which is the race the
 * correlation row recorded before the request exists to win.
 */

type Behaviour = (body: Record<string, unknown>, res: ServerResponse) => Promise<void> | void;

let app: FastifyInstance;
let stub: Server;
let behaviour: Behaviour = (_b, res) => {
  res.end();
};
let connectionId: string;

const PUBLIC = 'http://studio.test:9999/base/';

beforeAll(async () => {
  ({ app } = await buildTestAppWithContext({ publicBaseUrl: PUBLIC }));
  stub = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      void behaviour(JSON.parse(raw || '{}') as Record<string, unknown>, res);
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  connectionId = createConnection(app.db, {
    ownerId: 'local',
    name: 'Jobs API',
    kind: 'http',
    config: { baseUrl: `http://127.0.0.1:${(stub.address() as AddressInfo).port}` },
    secretRef: null,
  }).id;
});

afterAll(async () => {
  stub.closeAllConnections();
  await new Promise<void>((resolve) => stub.close(() => resolve()));
  await app.close();
});

/** The callback path inside the app, from the absolute `callBackUri` sent. */
function callbackPathOf(body: Record<string, unknown>): string {
  const uri = body.callBackUri as string;
  expect(uri.startsWith('http://studio.test:9999/base/api/external-wait/')).toBe(true);
  return uri.slice('http://studio.test:9999/base'.length);
}

function callBack(path: string, payload: unknown) {
  return app.inject({
    method: 'POST',
    url: path,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
}

async function startRun(
  config: Record<string, unknown> = {},
  policy?: Node['policy'],
): Promise<string> {
  return startNode({
    id: 'job',
    type: WEB_ACTIVITY_TYPE,
    connectionId,
    config: {
      url: '/jobs',
      method: 'POST',
      body: '{"job":"nightly"}',
      waitForCallback: true,
      outputs: getActivity(WEB_ACTIVITY_TYPE)!.outputs,
      ...config,
    },
    position: { x: 0, y: 0 },
    ...(policy !== undefined ? { policy } : {}),
  });
}

async function startNode(node: Node): Promise<string> {
  return startDoc([node], [], []);
}

/** A run of a doc with containers and params (#1761: a Web wait inside a ForEach). */
async function startDoc(
  nodes: Node[],
  containers: Container[],
  params: Param[],
  runParams: Record<string, unknown> = {},
): Promise<string> {
  const pipeline = createPipeline(app.db, { ownerId: 'local', name: `Web wait ${Math.random()}` });
  const version = createPipelineVersion(app.db, {
    pipelineId: pipeline.id,
    params,
    outputs: [],
    nodes,
    edges: [],
    containers,
    catalogVersion: CATALOG_VERSION,
  });
  const res = await app.inject({
    method: 'POST',
    url: `/api/pipelines/${pipeline.id}/runs`,
    payload: { pipelineVersionId: version.id, params: runParams },
  });
  expect(res.statusCode).toBe(202);
  return (res.json() as { runId: string }).runId;
}

const statusOf = (runId: string) => getRun(app.db, runId)?.status;

function untilStatus(runId: string, status: string) {
  return until(() => statusOf(runId) === status, `run ${runId} to be ${status}`, {
    iterations: 1500,
  });
}

function projected(runId: string) {
  const doc = getPipelineVersion(app.db, getRun(app.db, runId)!.pipelineVersionId)!;
  return buildEngine(doc).projectRunState(loadEngineEvents(app.db, runId));
}

/** The node ids whose callback has settled them, in log order. */
const completedNodes = (runId: string) =>
  loadEngineEvents(app.db, runId).flatMap((e) =>
    e.type === 'externalWait.completed' ? [e.nodeId] : [],
  );

const eventTypes = (runId: string) => loadEngineEvents(app.db, runId).map((e) => e.type);

describe('#1600 C11c — Web Wait for callback through the app', () => {
  it('sends callBackUri, parks, and settles on the callback with request outputs plus callback', async () => {
    let sent: Record<string, unknown> | undefined;
    behaviour = (body, res) => {
      sent = body;
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end('{"accepted":true}');
    };
    const runId = await startRun();
    await untilStatus(runId, 'waiting');
    expect(sent).toMatchObject({ job: 'nightly' });
    expect(projected(runId).nodes.job!.status).toBe('external_wait_pending');

    // The owner listing offers the wait, with the armed (not provisional) expiry.
    const listed = await app.inject({ method: 'GET', url: `/api/runs/${runId}/external-waits` });
    const waits = listed.json() as Array<{ callbackPath: string; expiresAt: number }>;
    expect(waits).toHaveLength(1);
    expect(waits[0]!.callbackPath).toBe(callbackPathOf(sent!));
    expect(waits[0]!.expiresAt).toBeLessThanOrEqual(Date.now() + 600_000);

    const res = await callBack(callbackPathOf(sent!), { Output: { rows: 3 } });
    expect(res.statusCode).toBe(204);
    expect(statusOf(runId)).toBe('success');
    expect(projected(runId).outputs.job).toMatchObject({
      status: 202,
      body: { accepted: true },
      callback: { Output: { rows: 3 } },
    });
    // No token anywhere in the log.
    const token = callbackPathOf(sent!).split('/').at(-1)!;
    expect(JSON.stringify(loadEngineEvents(app.db, runId))).not.toContain(token);
  });

  it('a callback that arrives BEFORE the endpoint answers still settles the node', async () => {
    let early: number | undefined;
    behaviour = async (body, res) => {
      early = (await callBack(callbackPathOf(body), { done: true })).statusCode;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    };
    const runId = await startRun();
    await untilStatus(runId, 'success');
    expect(early).toBe(204);
    expect(projected(runId).outputs.job).toMatchObject({ status: 200, callback: { done: true } });
    // It never parked: the arm carried the early callback.
    const types = eventTypes(runId);
    expect(types).toContain('node.awaitingCallback');
    expect(types).not.toContain('run.waiting');
    expect(types).not.toContain('externalWait.completed');
  });

  it('an early callback that reports a failure fails the run at the arm', async () => {
    behaviour = async (body, res) => {
      await callBack(callbackPathOf(body), { StatusCode: 403, Error: { Message: 'denied' } });
      res.end();
    };
    const runId = await startRun({ reportStatusOnCallback: true });
    await untilStatus(runId, 'failure');
    const created = loadEngineEvents(app.db, runId).find((e) => e.type === 'externalWait.created');
    expect(created).toMatchObject({
      arrived: { reportedError: 'the callback reported StatusCode 403: denied' },
    });
  });

  it('an early callback is accepted, but a request that then fails still fails the run', async () => {
    behaviour = async (body, res) => {
      await callBack(callbackPathOf(body), { done: true });
      res.writeHead(500).end('boom');
    };
    const runId = await startRun();
    await untilStatus(runId, 'failure');
    const attemptId = projected(runId).nodes.job!.currentAttemptId!;
    expect(getExternalWaitByAttempt(app.db, runId, 'job', attemptId)?.status).toBe('completed');
    expect(eventTypes(runId)).not.toContain('node.awaitingCallback');
  });

  it('a secure node keeps an early callback on the row as the log would: redacted', async () => {
    behaviour = async (body, res) => {
      await callBack(callbackPathOf(body), { secret: 'sk-live-early' });
      res.end();
    };
    const runId = await startRun({}, { secureOutput: true });
    await untilStatus(runId, 'success');
    const attemptId = projected(runId).nodes.job!.currentAttemptId!;
    const row = getExternalWaitByAttempt(app.db, runId, 'job', attemptId)!;
    expect(row.earlyCallback).not.toBeNull();
    expect(row.earlyCallback).not.toContain('sk-live-early');
    expect(JSON.stringify(loadEngineEvents(app.db, runId))).not.toContain('sk-live-early');
  });

  it('Report status on callback: a StatusCode of 400 or above fails the run', async () => {
    let path: string | undefined;
    behaviour = (body, res) => {
      path = callbackPathOf(body);
      res.end();
    };
    const runId = await startRun({ reportStatusOnCallback: true });
    await untilStatus(runId, 'waiting');
    await callBack(path!, { Error: { ErrorCode: 'E42', Message: 'disk full' }, StatusCode: '500' });
    await untilStatus(runId, 'failure');
    const done = loadEngineEvents(app.db, runId).find((e) => e.type === 'externalWait.completed');
    expect(done).toMatchObject({
      reportedError: 'the callback reported StatusCode 500: E42: disk full',
    });
  });

  it('refuses a callback body that is not JSON, and the node stays parked for a retry', async () => {
    let path: string | undefined;
    behaviour = (body, res) => {
      path = callbackPathOf(body);
      res.end();
    };
    const runId = await startRun();
    await untilStatus(runId, 'waiting');
    const bad = await app.inject({ method: 'POST', url: path!, payload: 'not json' });
    expect(bad.statusCode).toBe(422);
    expect(statusOf(runId)).toBe('waiting');
    expect((await callBack(path!, 'fine')).statusCode).toBe(204);
    expect(projected(runId).outputs.job).toMatchObject({ callback: 'fine' });
  });

  it('a request that fails does not wait, and leaves no callback on offer', async () => {
    let path: string | undefined;
    behaviour = (body, res) => {
      path = callbackPathOf(body);
      res.writeHead(400).end('bad request');
    };
    const runId = await startRun();
    await untilStatus(runId, 'failure');
    const listed = await app.inject({ method: 'GET', url: `/api/runs/${runId}/external-waits` });
    expect(listed.json()).toEqual([]);
    const row = getExternalWaitByAttempt(
      app.db,
      runId,
      'job',
      projected(runId).nodes.job!.currentAttemptId!,
    );
    expect(row?.status).toBe('expired');
    // A late callback on the dead attempt changes nothing.
    expect((await callBack(path!, {})).statusCode).toBe(404);
  });

  it('the callback timeout fails the node', async () => {
    behaviour = (_body, res) => {
      res.end();
    };
    const runId = await startRun({ callbackTimeoutSeconds: 3600 });
    await untilStatus(runId, 'waiting');
    // Bring the armed expiry due; the app's alarm clock ticks every second.
    app.db.run(
      sql`UPDATE scheduled_wakeups SET due_at = 0 WHERE kind = 'node_external_wait' AND status = 'pending' AND json_extract(ref, '$.runId') = ${runId}`,
    );
    await untilStatus(runId, 'failure');
    expect(eventTypes(runId)).toContain('externalWait.expired');
  });

  it('a finished run offers no callback, even for a row left pending', async () => {
    let path: string | undefined;
    behaviour = (body, res) => {
      path = callbackPathOf(body);
      res.end();
    };
    const runId = await startRun();
    await untilStatus(runId, 'waiting');
    // A cancel ends the run; nothing settles the row it parked on.
    const cancelled = await app.inject({ method: 'POST', url: `/api/runs/${runId}/cancel` });
    expect(cancelled.statusCode).toBeLessThan(300);
    await until(
      () => statusOf(runId) === 'cancelled' || statusOf(runId) === 'failure',
      'the run to end',
      { iterations: 1500 },
    );
    const listed = await app.inject({ method: 'GET', url: `/api/runs/${runId}/external-waits` });
    expect(listed.json()).toEqual([]);
    expect((await callBack(path!, {})).statusCode).toBe(404);
  });
});

describe('#1761 — a Web wait inside a parallel ForEach', () => {
  it('gives each item its own callBackUri, and each callback settles its own item', async () => {
    const sent: Array<Record<string, unknown>> = [];
    behaviour = (body, res) => {
      sent.push(body);
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end('{"accepted":true}');
    };
    const runId = await startDoc(
      [
        {
          id: 'w',
          type: WEB_ACTIVITY_TYPE,
          connectionId,
          config: {
            url: '/jobs',
            method: 'POST',
            body: '{"item":"${item}"}',
            waitForCallback: true,
            outputs: getActivity(WEB_ACTIVITY_TYPE)!.outputs,
          },
          position: { x: 0, y: 0 },
        },
      ],
      // batchCount 2 = both items in flight together, so both park at once.
      [{ id: 'fe', kind: 'foreach', children: ['w'], items: '${params.list}', batchCount: 2 }],
      [{ name: 'list', type: 'json', required: true }],
      { list: ['a', 'b'] },
    );
    await untilStatus(runId, 'waiting');
    // Both items' requests, however the two dispatches interleave with the park.
    await until(() => sent.length === 2, 'both items to send their request');

    // Two requests, two DISTINCT callback URIs, two correlation rows.
    expect(sent).toHaveLength(2);
    const listed = await app.inject({ method: 'GET', url: `/api/runs/${runId}/external-waits` });
    expect(listed.json() as unknown[]).toHaveLength(2);
    const state = projected(runId);
    expect(state.nodes['w@0']!.status).toBe('external_wait_pending');
    expect(state.nodes['w@1']!.status).toBe('external_wait_pending');

    // Each request names its item; call back the SECOND item's first.
    const pathOf = (item: string) => callbackPathOf(sent.find((b) => b.item === item)!);
    expect(pathOf('a')).not.toBe(pathOf('b'));
    expect((await callBack(pathOf('b'), { for: 'b' })).statusCode).toBe(204);
    await until(() => completedNodes(runId).includes('w@1'), 'item b to settle', {
      iterations: 1500,
    });
    // Only item b settled: item a is still parked and so is the run.
    expect(completedNodes(runId)).toEqual(['w@1']);
    expect(projected(runId).nodes['w@0']!.status).toBe('external_wait_pending');
    expect(statusOf(runId)).toBe('waiting');

    expect((await callBack(pathOf('a'), { for: 'a' })).statusCode).toBe(204);
    await untilStatus(runId, 'success');
    // The ForEach collects each item's outputs in item order, each carrying the
    // callback body that settled THAT item.
    const results = (projected(runId).outputs.fe as { results: unknown[] }).results;
    expect(results).toMatchObject([
      { status: 202, callback: { for: 'a' } },
      { status: 202, callback: { for: 'b' } },
    ]);
    expect(completedNodes(runId).sort()).toEqual(['w@0', 'w@1']);
  });
});

describe('#1761 — a crash between node.awaitingCallback and externalWait.created', () => {
  it('re-parks on boot exactly once, on the already-armed alarm, and a callback then settles it', async () => {
    // Server one writes the crash window by hand (the log is append-only): the
    // executor's pre-request correlation row, the request's `node.awaitingCallback`,
    // and the expiry alarm the driver armed — but no `externalWait.created`.
    const first = await buildTestAppWithContext({ publicBaseUrl: PUBLIC });
    const db = first.app.db;
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'Web wait crash' });
    const version = createPipelineVersion(db, {
      pipelineId: pipeline.id,
      params: [],
      outputs: [],
      nodes: [
        {
          id: 'job',
          type: WEB_ACTIVITY_TYPE,
          config: {
            url: '/jobs',
            method: 'POST',
            waitForCallback: true,
            outputs: getActivity(WEB_ACTIVITY_TYPE)!.outputs,
          },
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    });
    const run = createRun(db, {
      ownerId: 'local',
      pipelineVersionId: version.id,
      triggerId: null,
      parentRunId: null,
      params: {},
    });
    const key = { runId: run.id, nodeId: 'job', attemptId: 'job#0' };
    const token = deriveExternalWaitToken(first.app.masterKey, key);
    // The URL is PUBLIC (its trailing `/` dropped) joined to the path.
    const callbackPath = externalWaitCallbackUrl(PUBLIC, token).slice(
      PUBLIC.replace(/\/+$/, '').length,
    );
    appendEngineEvent(db, {
      type: 'run.started',
      runId: run.id,
      pipelineVersionId: version.id,
      params: {},
    });
    appendEngineEvent(db, { type: 'node.dispatched', ...key, idempotent: false });
    recordExternalWait(db, {
      ...key,
      tokenHash: hashExternalWaitToken(token),
      expiresAt: Date.now() + 600_000,
      now: Date.now(),
    });
    appendEngineEvent(db, {
      type: 'node.awaitingCallback',
      ...key,
      outputs: { status: 202, headers: {}, body: null, bytes: 0, durationMs: 1, truncated: false },
      timeoutSeconds: 600,
    });
    const alarm = armWakeup(
      db,
      externalWaitArmInput({ now: Date.now }, { ...key, timeoutSeconds: 600 }),
    );
    updateRun(db, run.id, { status: 'running' });
    const before = loadEngineEvents(db, run.id).map((e) => e.type);
    // Closed before asserting, so a failing check does not leak the first app.
    await first.app.close();
    expect(before).toEqual(['run.started', 'node.dispatched', 'node.awaitingCallback']);

    // Server two boots on the same database and master key: reconcile resumes it.
    const second = await buildTestAppWithContext({
      publicBaseUrl: PUBLIC,
      dbPath: join(first.tmpDir, 'test.sqlite'),
      masterKeyFile: join(first.tmpDir, 'master.key'),
    });
    try {
      await until(() => getRun(second.app.db, run.id)?.status === 'waiting', 'the resumed run', {
        iterations: 1500,
      });
      const types = loadEngineEvents(second.app.db, run.id).map((e) => e.type);
      // Re-parked once, and never re-sent: no second dispatch, no second request.
      expect(types.filter((t) => t === 'externalWait.created')).toHaveLength(1);
      expect(types.filter((t) => t === 'node.dispatched')).toHaveLength(1);
      expect(types.filter((t) => t === 'node.awaitingCallback')).toHaveLength(1);
      // The ONE alarm is the row armed before the crash, not a second one.
      const armed = listPendingWakeups(second.app.db).filter(
        (w) => w.kind === 'node_external_wait' && (w.ref as { runId?: string }).runId === run.id,
      );
      expect(armed).toEqual([alarm]);
      const created = loadEngineEvents(second.app.db, run.id).find(
        (e) => e.type === 'externalWait.created',
      );
      expect(created).toMatchObject({ ...key, dueAt: alarm.dueAt });
      const listed = await second.app.inject({
        method: 'GET',
        url: `/api/runs/${run.id}/external-waits`,
      });
      expect(listed.json() as Array<{ callbackPath: string }>).toMatchObject([{ callbackPath }]);

      // The callback URL the request carried before the crash still settles it.
      const res = await second.app.inject({
        method: 'POST',
        url: callbackPath,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ ok: true }),
      });
      expect(res.statusCode).toBe(204);
      expect(getRun(second.app.db, run.id)?.status).toBe('success');
    } finally {
      await second.app.close();
    }
  });
});

describe('#1600 C11c — the public base URL', () => {
  it('defaults to the bind address, a wildcard as loopback', () => {
    expect(resolvePublicBaseUrl(undefined, '127.0.0.1', 8080)).toBe('http://127.0.0.1:8080');
    expect(resolvePublicBaseUrl('', '0.0.0.0', 9000)).toBe('http://127.0.0.1:9000');
    expect(resolvePublicBaseUrl(undefined, '::1', 8080)).toBe('http://[::1]:8080');
  });

  it('takes AUTONOMY_PUBLIC_URL, keeping a path prefix and dropping a trailing slash', () => {
    expect(resolvePublicBaseUrl('https://studio.example.com/', 'x', 1)).toBe(
      'https://studio.example.com',
    );
    expect(resolvePublicBaseUrl('https://example.com/studio/', 'x', 1)).toBe(
      'https://example.com/studio',
    );
  });

  it('refuses a value that is not an http(s) URL without query or fragment', () => {
    expect(() => resolvePublicBaseUrl('studio.example.com', 'x', 1)).toThrow(/AUTONOMY_PUBLIC_URL/);
    expect(() => resolvePublicBaseUrl('ftp://h/', 'x', 1)).toThrow(/AUTONOMY_PUBLIC_URL/);
    expect(() => resolvePublicBaseUrl('https://h/?a=1', 'x', 1)).toThrow(/AUTONOMY_PUBLIC_URL/);
  });
});

describe('#1600 C11c-2 — a Web with no Request URL only waits', () => {
  const waitsOnly = (id = 'job'): Node => ({
    id,
    type: WEB_ACTIVITY_TYPE,
    config: {
      waitForCallback: true,
      callbackTimeoutSeconds: 300,
      outputs: getActivity(WEB_ACTIVITY_TYPE)!.outputs,
    },
    position: { x: 0, y: 0 },
  });

  async function pendingPath(runId: string): Promise<string> {
    const res = await app.inject({ method: 'GET', url: `/api/runs/${runId}/external-waits` });
    expect(res.statusCode).toBe(200);
    const waits = res.json() as Array<{ callbackPath: string }>;
    expect(waits).toHaveLength(1);
    return waits[0]!.callbackPath;
  }

  it('sends nothing, parks without a connection, and settles on the callback', async () => {
    const runId = await startNode(waitsOnly());
    await untilStatus(runId, 'waiting');
    expect(eventTypes(runId)).not.toContain('node.dispatched');
    const res = await callBack(await pendingPath(runId), { approved: true });
    expect(res.statusCode).toBe(204);
    await untilStatus(runId, 'success');
    expect(projected(runId).outputs.job).toEqual({
      status: null,
      headers: null,
      body: null,
      bytes: null,
      durationMs: null,
      truncated: null,
      callback: { approved: true },
    });
  });

  it('keeps a callback body that is not JSON as text, as a webhook accepted any body', async () => {
    const runId = await startNode(waitsOnly());
    await untilStatus(runId, 'waiting');
    const res = await app.inject({
      method: 'POST',
      url: await pendingPath(runId),
      headers: { 'content-type': 'text/plain' },
      payload: 'approved',
    });
    expect(res.statusCode).toBe(204);
    await untilStatus(runId, 'success');
    expect(projected(runId).outputs.job).toMatchObject({ callback: 'approved' });
  });

  it('a stored webhook and its lowering settle the same way on the same callback', async () => {
    const hook: Node = {
      id: 'job',
      type: WEBHOOK_ACTIVITY_TYPE,
      config: { timeoutSeconds: '${300}' },
      position: { x: 0, y: 0 },
    };
    const [lowered] = lowerRetiredTypes({ nodes: [hook], containers: [] }).nodes;
    expect(lowered!.type).toBe(WEB_ACTIVITY_TYPE);
    const outputs: unknown[] = [];
    for (const node of [hook, lowered!]) {
      const runId = await startNode(node);
      await untilStatus(runId, 'waiting');
      expect((await callBack(await pendingPath(runId), { ok: 1 })).statusCode).toBe(204);
      await untilStatus(runId, 'success');
      outputs.push(projected(runId).outputs.job);
    }
    // The documented difference: the Web keeps the body the webhook discarded.
    expect(outputs[0]).toEqual({});
    expect(outputs[1]).toMatchObject({ status: null, callback: { ok: 1 } });
  });
});
