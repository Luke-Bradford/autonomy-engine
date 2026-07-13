import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpAdapter } from '../http.js';
import type { ActivityContext, ActivityEvent } from '../types.js';

/** Drain an adapter's event stream to an array. */
async function drain(stream: AsyncIterable<ActivityEvent>): Promise<ActivityEvent[]> {
  const events: ActivityEvent[] = [];
  for await (const e of stream) events.push(e);
  return events;
}

function ctx(over: Partial<ActivityContext> = {}): ActivityContext {
  return {
    runId: 'run_1',
    nodeId: 'n1',
    attemptId: 'n1#0',
    input: over.input ?? { url: 'https://api.example.com/thing' },
    connectionConfig: over.connectionConfig ?? {},
    signal: over.signal ?? new AbortController().signal,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** A minimal `Response`-like stub for the global `fetch`. */
function fakeResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Response {
  return {
    status,
    text: () => Promise.resolve(body),
    headers: new Headers(headers),
  } as unknown as Response;
}

describe('httpAdapter.runActivity', () => {
  it('surfaces status, body, and RESPONSE headers on a completed exchange', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(fakeResponse(200, 'hello', { 'x-trace': 'abc' }));

    const events = await drain(httpAdapter.runActivity(ctx(), null));

    expect(events).toEqual([
      { type: 'succeeded', outputs: { status: 200, body: 'hello', headers: { 'x-trace': 'abc' } } },
    ]);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('a non-2xx status is STILL succeeded (status is data, not an error)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(404, 'nope'));
    const events = await drain(httpAdapter.runActivity(ctx(), null));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'succeeded', outputs: { status: 404 } });
  });

  it('sends the resolved secret as a bearer token but NEVER echoes it in outputs', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, 'ok'));

    const events = await drain(httpAdapter.runActivity(ctx(), 'sk-super-secret'));

    // The secret went out on the request...
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer sk-super-secret',
    );
    // ...but is nowhere in the surfaced outputs.
    expect(JSON.stringify(events)).not.toContain('sk-super-secret');
  });

  it('merges connection + request headers (request wins, then secret)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, 'ok'));

    await drain(
      httpAdapter.runActivity(
        ctx({
          connectionConfig: { headers: { 'x-conn': 'c', 'x-both': 'conn' } },
          input: { url: 'https://x/y', headers: { 'x-both': 'req' } },
        }),
        null,
      ),
    );

    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const sent = init.headers as Record<string, string>;
    expect(sent['x-conn']).toBe('c');
    expect(sent['x-both']).toBe('req'); // request header overrides connection default
  });

  it('prepends the connection baseUrl to a relative request url', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, 'ok'));
    await drain(
      httpAdapter.runActivity(
        ctx({ connectionConfig: { baseUrl: 'https://api.example.com/' }, input: { url: '/v1/x' } }),
        null,
      ),
    );
    expect(fetchSpy.mock.calls[0]![0]).toBe('https://api.example.com/v1/x');
  });

  it('maps an aborted request to a cancelled failure', async () => {
    const controller = new AbortController();
    controller.abort();
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });

    const events = await drain(httpAdapter.runActivity(ctx({ signal: controller.signal }), null));
    expect(events).toEqual([{ type: 'failed', kind: 'cancelled', error: 'http request aborted' }]);
  });

  it('maps a network error to a transient failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const events = await drain(httpAdapter.runActivity(ctx(), null));
    expect(events).toEqual([{ type: 'failed', kind: 'transient', error: 'ECONNREFUSED' }]);
  });

  it('rejects a malformed activity config as a permanent failure', async () => {
    const events = await drain(httpAdapter.runActivity(ctx({ input: { method: 'GET' } }), null));
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
  });

  it('rejects a body on a GET/HEAD as a permanent failure (no fetch attempted)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const events = await drain(
      httpAdapter.runActivity(
        ctx({ input: { url: 'https://x', method: 'GET', body: 'nope' } }),
        null,
      ),
    );
    expect(events).toEqual([
      { type: 'failed', kind: 'permanent', error: 'an HTTP GET cannot carry a body' },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('maps a malformed-request TypeError (e.g. bad URL) to a permanent failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Invalid URL'));
    const events = await drain(httpAdapter.runActivity(ctx(), null));
    expect(events).toEqual([{ type: 'failed', kind: 'permanent', error: 'Invalid URL' }]);
  });

  it('bounds a hung request by the timeout and reports a transient failure', async () => {
    // fetch hangs until ITS signal aborts — exactly what a slowloris endpoint
    // does. The adapter's own timeout must fire the abort and terminalize.
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = (init as RequestInit).signal;
          signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
    );

    const events = await drain(
      httpAdapter.runActivity(ctx({ connectionConfig: { timeoutMs: 10 } }), null),
    );
    expect(events).toEqual([
      { type: 'failed', kind: 'transient', error: 'http request timed out after 10ms' },
    ]);
  });
});
