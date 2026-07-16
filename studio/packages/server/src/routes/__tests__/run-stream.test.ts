import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import {
  CATALOG_VERSION,
  RunStreamServerMessageSchema,
  type EngineEvent,
  type RunEvent,
  type RunStreamServerMessage,
} from '@autonomy-studio/shared';
import { createPipeline, createPipelineVersion, createRun } from '../../repo/index.js';
import { appendEngineEvent } from '../../run/events.js';
import { buildTestApp } from '../../__tests__/build-test-app.js';

/**
 * Integration coverage for the P6 run-events WebSocket: a REAL server on an
 * ephemeral port, a REAL (undici global) `WebSocket` client, real DB + bus. No
 * mocks — the whole replay-then-tail + dedupe + auth path is exercised end to
 * end.
 */

interface Client {
  ws: WebSocket;
  messages: RunStreamServerMessage[];
  closeCode(): number | null;
}

async function connect(port: number, runId: string): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/runs/${runId}/events/stream`);
  const messages: RunStreamServerMessage[] = [];
  let code: number | null = null;
  ws.addEventListener('message', (ev) => {
    messages.push(RunStreamServerMessageSchema.parse(JSON.parse(ev.data as string)));
  });
  ws.addEventListener('close', (ev) => {
    code = ev.code;
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    // A denied connect opens then immediately closes (4404) — resolve on close
    // too so the auth test can observe the code rather than hanging.
    ws.addEventListener('close', () => resolve());
    ws.addEventListener('error', () => reject(new Error('ws connect error')));
  });
  return { ws, messages, closeCode: () => code };
}

async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('until() timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const started = (runId: string, pvId: string): EngineEvent => ({
  type: 'run.started',
  runId,
  pipelineVersionId: pvId,
  params: {},
});
const output = (runId: string, value: unknown): EngineEvent => ({
  type: 'node.output',
  runId,
  nodeId: 'n1',
  name: 'chunk',
  value,
});
const finished = (runId: string): EngineEvent => ({
  type: 'run.finished',
  runId,
  outcome: 'success',
});

describe('run-events WebSocket (P6 live monitor)', () => {
  let app: FastifyInstance;
  let port: number;
  let pipelineVersionId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as AddressInfo).port;
    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'For WS' });
    const version = createPipelineVersion(app.db, {
      pipelineId: pipeline.id,
      params: [],
      outputs: [],
      nodes: [],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    });
    pipelineVersionId = version.id;
  });

  afterAll(async () => {
    await app.close();
  });

  function newRun(ownerId: string | null): string {
    return createRun(app.db, {
      ownerId,
      pipelineVersionId,
      triggerId: null,
      parentRunId: null,
      params: {},
    }).id;
  }

  it('replays the durable log in seq order then sends replay_complete', async () => {
    const runId = newRun('local');
    appendEngineEvent(app.db, started(runId, pipelineVersionId));
    appendEngineEvent(app.db, output(runId, 'a'));

    const client = await connect(port, runId);
    await until(() => client.messages.some((m) => m.kind === 'replay_complete'));

    const events = client.messages.filter((m) => m.kind === 'event');
    expect(events.map((m) => m.event.seq)).toEqual([0, 1]);
    expect(events[0]!.event.type).toBe('run.started');
    const marker = client.messages.find((m) => m.kind === 'replay_complete');
    expect(marker).toEqual({ kind: 'replay_complete', throughSeq: 1 });
    client.ws.close();
  });

  it('sends replay_complete with throughSeq -1 for a run with no events yet', async () => {
    const runId = newRun('local');
    const client = await connect(port, runId);
    await until(() => client.messages.some((m) => m.kind === 'replay_complete'));
    expect(client.messages.find((m) => m.kind === 'replay_complete')).toEqual({
      kind: 'replay_complete',
      throughSeq: -1,
    });
    client.ws.close();
  });

  it('tails a live append after replay (published through the bus by appendEngineEvent)', async () => {
    const runId = newRun('local');
    appendEngineEvent(app.db, started(runId, pipelineVersionId));

    const client = await connect(port, runId);
    await until(() => client.messages.some((m) => m.kind === 'replay_complete'));

    // A live append AFTER the client is subscribed — routed through the bus.
    appendEngineEvent(app.db, output(runId, 'live'), app.runEventBus);

    await until(() =>
      client.messages.some((m) => m.kind === 'event' && m.event.type === 'node.output'),
    );
    const live = client.messages.find(
      (m): m is Extract<RunStreamServerMessage, { kind: 'event' }> =>
        m.kind === 'event' && m.event.type === 'node.output',
    );
    expect(live!.event.seq).toBe(1);
    client.ws.close();
  });

  it('never re-sends an event already covered by the replay (seq dedupe)', async () => {
    const runId = newRun('local');
    const seed = appendEngineEvent(app.db, started(runId, pipelineVersionId)).record; // seq 0

    const client = await connect(port, runId);
    await until(() => client.messages.some((m) => m.kind === 'replay_complete'));

    // Re-publish the ALREADY-replayed seq-0 envelope directly onto the bus: the
    // client must ignore it (seq <= what replay already delivered).
    app.runEventBus.publish(seed as RunEvent);
    // And a genuinely new live event, to prove the socket is still tailing.
    appendEngineEvent(app.db, output(runId, 'next'), app.runEventBus); // seq 1

    await until(() => client.messages.some((m) => m.kind === 'event' && m.event.seq === 1));
    const seqZeros = client.messages.filter((m) => m.kind === 'event' && m.event.seq === 0);
    expect(seqZeros).toHaveLength(1);
    client.ws.close();
  });

  it('closes the socket cleanly (1000) once a terminal event is delivered', async () => {
    const runId = newRun('local');
    appendEngineEvent(app.db, started(runId, pipelineVersionId));

    const client = await connect(port, runId);
    await until(() => client.messages.some((m) => m.kind === 'replay_complete'));

    appendEngineEvent(app.db, finished(runId), app.runEventBus);

    await until(() => client.closeCode() !== null);
    expect(client.closeCode()).toBe(1000);
    expect(client.messages.some((m) => m.kind === 'event' && m.event.type === 'run.finished')).toBe(
      true,
    );
  });

  it('closes immediately after replay when the run is already terminal in the log', async () => {
    const runId = newRun('local');
    appendEngineEvent(app.db, started(runId, pipelineVersionId));
    appendEngineEvent(app.db, finished(runId));

    const client = await connect(port, runId);
    await until(() => client.closeCode() !== null);
    expect(client.closeCode()).toBe(1000);
    expect(client.messages.some((m) => m.kind === 'replay_complete')).toBe(true);
  });

  it('refuses (4404) a run owned by a different principal', async () => {
    const runId = newRun('someone-else');
    appendEngineEvent(app.db, started(runId, pipelineVersionId));
    const client = await connect(port, runId);
    await until(() => client.closeCode() !== null);
    expect(client.closeCode()).toBe(4404);
    expect(client.messages).toHaveLength(0);
  });

  it('refuses (4404) an unknown run id', async () => {
    const client = await connect(port, 'run_does_not_exist');
    await until(() => client.closeCode() !== null);
    expect(client.closeCode()).toBe(4404);
  });
});
