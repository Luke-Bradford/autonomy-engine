import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  armPostgresCancel,
  sendPostgresCancelRequest,
  type PostgresCancelSender,
  type PostgresCancelTarget,
  type PostgresClient,
} from '../postgres-session.js';

/**
 * #1800 — the protocol CancelRequest a Script sends for the block in flight
 * when its run is cancelled or its activity times out. Driven against a real
 * local socket, so the bytes on the wire are what is asserted.
 */

const servers: net.Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A server that records what each connection sent; it closes after 16 bytes unless told not to. */
function listen(
  at: { port: number } | { path: string },
  closeAfterRequest = true,
): Promise<{ received: Buffer[]; closed: Promise<void>; port: number }> {
  const received: Buffer[] = [];
  let markClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  const server = net.createServer((socket) => {
    let bytes = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length >= 16) {
        received.push(bytes);
        if (closeAfterRequest) socket.end();
      }
    });
    socket.on('close', markClosed);
    socket.on('error', () => undefined);
  });
  servers.push(server);
  return new Promise((resolve) => {
    const ready = () => {
      const address = server.address();
      resolve({
        received,
        closed,
        port: typeof address === 'object' && address !== null ? address.port : 0,
      });
    };
    if ('path' in at) server.listen(at.path, ready);
    else server.listen(at.port, '127.0.0.1', ready);
  });
}

function expectedRequest(processID: number, secretKey: number): Buffer {
  const b = Buffer.alloc(16);
  b.writeInt32BE(16, 0);
  b.writeInt32BE(80877102, 4);
  b.writeInt32BE(processID, 8);
  b.writeInt32BE(secretKey, 12);
  return b;
}

describe('sendPostgresCancelRequest (#1800)', () => {
  it('writes the 16-byte CancelRequest for the session and resolves once the server closes', async () => {
    const server = await listen({ port: 0 });
    await sendPostgresCancelRequest(
      { host: '127.0.0.1', port: server.port, timeoutMs: 5_000 },
      4242,
      -1_234_567,
    );
    expect(server.received).toEqual([expectedRequest(4242, -1_234_567)]);
  });

  it('reaches a unix-socket server at <dir>/.s.PGSQL.<port>, as pg does', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pgc-'));
    dirs.push(dir);
    const server = await listen({ path: join(dir, '.s.PGSQL.5433') });
    await sendPostgresCancelRequest({ host: dir, port: 5433, timeoutMs: 5_000 }, 7, 8);
    expect(server.received).toEqual([expectedRequest(7, 8)]);
  });

  it('resolves, never rejects, when nothing listens', async () => {
    const server = await listen({ port: 0 });
    const { port } = server;
    await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
    await expect(
      sendPostgresCancelRequest({ host: '127.0.0.1', port, timeoutMs: 5_000 }, 1, 2),
    ).resolves.toBeUndefined();
  });

  it('gives up at its timeout and closes the socket when the server never closes it', async () => {
    const server = await listen({ port: 0 }, false);
    const started = Date.now();
    await sendPostgresCancelRequest({ host: '127.0.0.1', port: server.port, timeoutMs: 200 }, 1, 2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    await server.closed;
    expect(server.received).toEqual([expectedRequest(1, 2)]);
  });
});

describe('armPostgresCancel (#1800)', () => {
  const target: PostgresCancelTarget = { host: 'db.invalid', port: 5432, timeoutMs: 10_000 };
  const keyed = (processID: unknown, secretKey: unknown): PostgresClient =>
    ({ processID, secretKey }) as unknown as PostgresClient;

  function recorder(): { send: PostgresCancelSender; sent: unknown[][] } {
    const sent: unknown[][] = [];
    return {
      sent,
      send: (t, pid, key) => {
        sent.push([t, pid, key]);
        return Promise.resolve();
      },
    };
  }

  it('sends one cancel with the session key when the signal aborts', () => {
    const { send, sent } = recorder();
    const controller = new AbortController();
    armPostgresCancel(keyed(4242, 99), target, controller.signal, send);
    expect(sent).toEqual([]);
    controller.abort();
    controller.abort();
    expect(sent).toEqual([[target, 4242, 99]]);
  });

  it('sends nothing once disarmed', () => {
    const { send, sent } = recorder();
    const controller = new AbortController();
    armPostgresCancel(keyed(4242, 99), target, controller.signal, send)();
    controller.abort();
    expect(sent).toEqual([]);
  });

  it('sends at once when the signal has already aborted', () => {
    const { send, sent } = recorder();
    armPostgresCancel(keyed(1, 2), target, AbortSignal.abort(), send);
    expect(sent).toEqual([[target, 1, 2]]);
  });

  it.each([
    ['no key at all', undefined, undefined],
    ['a null key', 1, null],
    ['a key past int32', 1, 2 ** 31],
    ['a non-integer pid', 1.5, 2],
    ['a variable-length key', 1, Buffer.from('abcdefgh')],
  ])('sends nothing for %s', (_label, processID, secretKey) => {
    const { send, sent } = recorder();
    const controller = new AbortController();
    armPostgresCancel(keyed(processID, secretKey), target, controller.signal, send);
    controller.abort();
    expect(sent).toEqual([]);
  });

  it('swallows a sender that rejects', async () => {
    const controller = new AbortController();
    armPostgresCancel(keyed(1, 2), target, controller.signal, () =>
      Promise.reject(new Error('boom')),
    );
    controller.abort();
    // An unhandled rejection would fail the run; let it surface if there were one.
    await new Promise((resolve) => setImmediate(resolve));
  });
});
