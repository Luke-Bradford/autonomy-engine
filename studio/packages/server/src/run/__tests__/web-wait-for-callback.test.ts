import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CATALOG_VERSION,
  getActivity,
  WEB_ACTIVITY_TYPE,
  type Node,
} from '@autonomy-studio/shared';
import { buildTestAppWithContext } from '../../__tests__/build-test-app.js';
import { until } from '../../__tests__/poll-until.js';
import { createConnection } from '../../repo/connections.js';
import { createPipeline, createPipelineVersion, getPipelineVersion } from '../../repo/index.js';
import { getRun } from '../../repo/runs.js';
import { getExternalWaitByAttempt } from '../../repo/external-waits.js';
import { buildEngine } from '../driver.js';
import { loadEngineEvents } from '../events.js';
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
let behaviour: Behaviour = (_b, res) => res.end();
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

async function startRun(config: Record<string, unknown> = {}): Promise<string> {
  const node: Node = {
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
  };
  const pipeline = createPipeline(app.db, { ownerId: 'local', name: `Web wait ${Math.random()}` });
  const version = createPipelineVersion(app.db, {
    pipelineId: pipeline.id,
    params: [],
    outputs: [],
    nodes: [node],
    edges: [],
    catalogVersion: CATALOG_VERSION,
  });
  const res = await app.inject({
    method: 'POST',
    url: `/api/pipelines/${pipeline.id}/runs`,
    payload: { pipelineVersionId: version.id, params: {} },
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
    behaviour = (_body, res) => res.end();
    const runId = await startRun({ callbackTimeoutSeconds: 3600 });
    await untilStatus(runId, 'waiting');
    // Bring the armed expiry due; the app's alarm clock ticks every second.
    app.db.run(
      sql`UPDATE scheduled_wakeups SET due_at = 0 WHERE kind = 'node_external_wait' AND status = 'pending' AND json_extract(ref, '$.runId') = ${runId}`,
    );
    await untilStatus(runId, 'failure');
    expect(eventTypes(runId)).toContain('externalWait.expired');
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
