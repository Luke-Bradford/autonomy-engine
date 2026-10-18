import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  HTTP_REQUEST_ACTIVITY_TYPE,
  WARNING_CODES,
  WEB_ACTIVITY_TYPE,
  WEB_MAX_JSON_DEPTH,
} from '@autonomy-studio/shared';
import { httpAdapter } from '../http.js';
import type { ActivityContext, ActivityEvent } from '../types.js';

/**
 * #1600 OR41 C11a — Web (catalogue §4.6), against REAL servers on 127.0.0.1:
 * the status gate, Retry-After, the bounded body, Parse as, the timeouts, the
 * network failures, and secret headers on a redirect to another origin.
 */

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

/** A local server whose behaviour each test sets; it records what it received. */
function stubServer() {
  let handler: Handler = (_q, res) => res.end();
  const received: { url?: string; method?: string; headers: IncomingMessage['headers'] }[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      received.push({ url: req.url, method: req.method, headers: req.headers });
      handler(req, res, body);
    });
  });
  return {
    server,
    received,
    set: (h: Handler) => {
      handler = h;
    },
    url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}

const main = stubServer();
const other = stubServer();

beforeAll(async () => {
  await Promise.all(
    [main.server, other.server].map(
      (s) => new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve)),
    ),
  );
});
afterAll(async () => {
  await Promise.all(
    [main.server, other.server].map((s) => {
      s.closeAllConnections(); // the never-answering handlers hold sockets open
      return new Promise((resolve) => s.close(resolve));
    }),
  );
});
beforeEach(() => {
  main.received.length = 0;
  other.received.length = 0;
});

async function drain(stream: AsyncIterable<ActivityEvent>): Promise<ActivityEvent[]> {
  const events: ActivityEvent[] = [];
  for await (const e of stream) events.push(e);
  return events;
}

function run(
  input: Record<string, unknown>,
  over: {
    connectionConfig?: Record<string, unknown>;
    secret?: string | null;
    secretFields?: Record<string, string>;
    signal?: AbortSignal;
    activityType?: string;
  } = {},
): Promise<ActivityEvent[]> {
  const ctx: ActivityContext = {
    runId: 'run_1',
    nodeId: 'n1',
    attemptId: 'n1#0',
    activityType: over.activityType ?? WEB_ACTIVITY_TYPE,
    input,
    connectionConfig: over.connectionConfig ?? { baseUrl: main.url() },
    signal: over.signal ?? new AbortController().signal,
  } as ActivityContext;
  return drain(httpAdapter.runActivity(ctx, over.secret ?? null, over.secretFields ?? {}));
}

const json = (status: number, value: unknown, headers: Record<string, string> = {}): Handler => {
  return (_q, res) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(value));
  };
};

const failed = (events: ActivityEvent[]) =>
  events.at(-1) as Extract<ActivityEvent, { type: 'failed' }>;
const succeeded = (events: ActivityEvent[]) =>
  events.at(-1) as Extract<ActivityEvent, { type: 'succeeded' }>;

describe('Web — the response', () => {
  it('parses a JSON body and reports status, headers, bytes and duration', async () => {
    main.set(json(200, { rows: [1, 2] }, { 'x-trace': 'abc' }));
    const events = await run({ url: '/items' });
    expect(events).toHaveLength(1);
    const { outputs } = succeeded(events);
    expect(outputs).toMatchObject({
      status: 200,
      body: { rows: [1, 2] },
      bytes: Buffer.byteLength('{"rows":[1,2]}'),
      truncated: false,
      callback: null,
    });
    expect((outputs.headers as Record<string, string>)['x-trace']).toBe('abc');
    expect(typeof outputs.durationMs).toBe('number');
    expect(main.received[0]).toMatchObject({ url: '/items', method: 'GET' });
  });

  it('reads an empty JSON body as null, and Parse as Text keeps the string', async () => {
    main.set((_q, res) => res.writeHead(204).end());
    expect(succeeded(await run({ url: '/' })).outputs.body).toBeNull();
    main.set((_q, res) => res.end('{"a":1}'));
    expect(succeeded(await run({ url: '/', parseAs: 'text' })).outputs.body).toBe('{"a":1}');
  });

  it('fails permanent on a body that is not JSON, naming Parse as', async () => {
    main.set((_q, res) => res.end('<html>hi</html>'));
    const event = failed(await run({ url: '/' }));
    expect(event).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect(event.error).toContain('Parse as');
  });

  it('fails permanent on JSON nested deeper than the limit, and reads one at the limit', async () => {
    const nest = (n: number) => '['.repeat(n) + ']'.repeat(n);
    main.set((_q, res) => res.end(nest(WEB_MAX_JSON_DEPTH + 1)));
    expect(failed(await run({ url: '/' }))).toMatchObject({ kind: 'permanent' });
    // A bracket inside a string is not nesting.
    main.set((_q, res) => res.end(`[${JSON.stringify('['.repeat(500))}]`));
    expect(succeeded(await run({ url: '/' })).outputs.body).toEqual(['['.repeat(500)]);
    main.set((_q, res) => res.end(nest(WEB_MAX_JSON_DEPTH)));
    expect(succeeded(await run({ url: '/' })).type).toBe('succeeded');
  });
});

describe('Web — Fail on HTTP error', () => {
  it('fails a 404 permanent by default, with the status and a body excerpt', async () => {
    main.set(json(404, { error: 'no such item' }));
    const event = failed(await run({ url: '/' }));
    expect(event.kind).toBe('permanent');
    expect(event.error).toMatch(/^HTTP 404 Not Found: /);
    expect(event.error).toContain('no such item');
  });

  it('succeeds on a status listed in Treat as success, and on any status when off', async () => {
    main.set(json(404, { error: 'missing' }));
    expect(succeeded(await run({ url: '/', successStatusCodes: [404] })).outputs).toMatchObject({
      status: 404,
      body: { error: 'missing' },
    });
    main.set(json(500, { error: 'boom' }));
    expect(succeeded(await run({ url: '/', failOnHttpError: false })).outputs.status).toBe(500);
  });

  it('a 429 is rate_limit and carries Retry-After; a 5xx is transient', async () => {
    main.set(json(429, {}, { 'retry-after': '7' }));
    expect(failed(await run({ url: '/' }))).toMatchObject({
      kind: 'rate_limit',
      retryAfterSeconds: 7,
    });
    main.set(json(503, {}, { 'retry-after': '9' }));
    expect(failed(await run({ url: '/' }))).toMatchObject({
      kind: 'transient',
      retryAfterSeconds: 9,
    });
    main.set(json(502, {}));
    const bad = failed(await run({ url: '/' }));
    expect(bad.kind).toBe('transient');
    expect(bad.retryAfterSeconds).toBeUndefined();
  });

  it('401 and 403 are auth', async () => {
    main.set(json(401, {}));
    expect(failed(await run({ url: '/' })).kind).toBe('auth');
    main.set(json(403, {}));
    expect(failed(await run({ url: '/' })).kind).toBe('auth');
  });

  it('Retry on 429 and 503 off: a 429 is permanent, Retry-After is ignored', async () => {
    main.set(json(429, {}, { 'retry-after': '7' }));
    const event = failed(await run({ url: '/', retryOnThrottle: false }));
    expect(event.kind).toBe('permanent');
    expect(event.retryAfterSeconds).toBeUndefined();
    main.set(json(503, {}, { 'retry-after': '9' }));
    const unavailable = failed(await run({ url: '/', retryOnThrottle: false }));
    expect(unavailable.kind).toBe('transient');
    expect(unavailable.retryAfterSeconds).toBeUndefined();
  });

  it('redacts a secret the server echoes into its error body', async () => {
    main.set((req, res) => {
      res.writeHead(400).end(`bad key ${String(req.headers['x-api-key'])}`);
    });
    const event = failed(
      await run(
        { url: '/', secretHeaders: { 'X-Api-Key': { $secret: 'k' } } },
        { secretFields: { 'secretHeaders.X-Api-Key': 'sk-live-123' } },
      ),
    );
    expect(event.error).not.toContain('sk-live-123');
  });
});

describe('Web — Max size', () => {
  const big = 'x'.repeat(5000);

  it('fails a longer body permanent by default, from Content-Length and from a stream', async () => {
    main.set((_q, res) => res.end(JSON.stringify(big)));
    const declared = failed(await run({ url: '/', maxResponseBytes: 1000 }));
    expect(declared).toMatchObject({ kind: 'permanent' });
    expect(declared.error).toContain('Max size (1000 bytes)');
    // No Content-Length: chunked, so the bounded read is what refuses it.
    main.set((_q, res) => {
      res.write(JSON.stringify(big).slice(0, 2500));
      res.end(JSON.stringify(big).slice(2500));
    });
    expect(failed(await run({ url: '/', maxResponseBytes: 1000 })).error).toContain('Max size');
  });

  it('Truncate keeps the first Max size bytes, sets truncated and warns', async () => {
    main.set((_q, res) => {
      res.write(big.slice(0, 2500));
      res.end(big.slice(2500));
    });
    const events = await run({
      url: '/',
      parseAs: 'text',
      maxResponseBytes: 1000,
      whenOverLimit: 'truncate',
    });
    expect(events.map((e) => e.type)).toEqual(['warned', 'succeeded']);
    expect(events[0]).toMatchObject({ code: WARNING_CODES.WEB_RESPONSE_TRUNCATED });
    expect(succeeded(events).outputs).toMatchObject({
      body: 'x'.repeat(1000),
      bytes: 1000,
      truncated: true,
    });
  });

  it('a truncation that splits a UTF-8 character drops the partial character', async () => {
    main.set((_q, res) => res.end('ab€')); // € is 3 bytes
    const events = await run({
      url: '/',
      parseAs: 'text',
      maxResponseBytes: 3,
      whenOverLimit: 'truncate',
    });
    expect(succeeded(events).outputs).toMatchObject({ body: 'ab', bytes: 3, truncated: true });
  });

  it('a body of exactly Max size is whole', async () => {
    main.set((_q, res) => res.end('"12345678"'));
    expect(succeeded(await run({ url: '/', maxResponseBytes: 10 })).outputs).toMatchObject({
      body: '12345678',
      truncated: false,
    });
  });
});

describe('Web — the request', () => {
  it('sends the method, body, headers, Bearer and secret headers; echoes none of the secrets', async () => {
    main.set(json(200, { ok: true }));
    const events = await run(
      {
        url: '/submit',
        method: 'POST',
        body: '{"n":1}',
        headers: { 'content-type': 'application/json' },
        secretHeaders: { 'X-Api-Key': { $secret: 'k' } },
      },
      { secret: 'bearer-1', secretFields: { 'secretHeaders.X-Api-Key': 'sk-live-123' } },
    );
    expect(succeeded(events).type).toBe('succeeded');
    expect(main.received[0]).toMatchObject({ method: 'POST' });
    expect(main.received[0]!.headers).toMatchObject({
      authorization: 'Bearer bearer-1',
      'x-api-key': 'sk-live-123',
    });
    expect(JSON.stringify(events)).not.toMatch(/sk-live-123|bearer-1/);
  });

  it('sends no body for an empty Body box on a GET', async () => {
    main.set(json(200, {}));
    expect(succeeded(await run({ url: '/', body: '' })).type).toBe('succeeded');
  });

  it('drops the secret headers and the Bearer on a redirect to another origin', async () => {
    other.set(json(200, { landed: true }));
    main.set((_q, res) => res.writeHead(302, { location: `${other.url()}/elsewhere` }).end());
    const events = await run(
      { url: '/start', secretHeaders: { 'X-Api-Key': { $secret: 'k' } }, headers: { 'x-n': '1' } },
      { secret: 'bearer-1', secretFields: { 'secretHeaders.X-Api-Key': 'sk-live-123' } },
    );
    expect(succeeded(events).outputs.body).toEqual({ landed: true });
    expect(other.received[0]!.url).toBe('/elsewhere');
    expect(other.received[0]!.headers['x-api-key']).toBeUndefined();
    expect(other.received[0]!.headers.authorization).toBeUndefined();
    // A plain request header still follows.
    expect(other.received[0]!.headers['x-n']).toBe('1');
  });

  it('http_request also drops them on a redirect to another origin', async () => {
    other.set(json(200, {}));
    main.set((_q, res) => res.writeHead(302, { location: `${other.url()}/x` }).end());
    const events = await run(
      { url: '/start', secretHeaders: { 'X-Api-Key': { $secret: 'k' } } },
      {
        activityType: HTTP_REQUEST_ACTIVITY_TYPE,
        secretFields: { 'secretHeaders.X-Api-Key': 'sk-live-123' },
      },
    );
    expect(succeeded(events).outputs.status).toBe(200);
    expect(other.received[0]!.headers['x-api-key']).toBeUndefined();
  });

  it('keeps the secret headers on a same-origin redirect', async () => {
    main.set((req, res) => {
      if (req.url === '/start') res.writeHead(307, { location: '/next' }).end();
      else json(200, { ok: 1 })(req, res, '');
    });
    await run(
      { url: '/start', secretHeaders: { 'X-Api-Key': { $secret: 'k' } } },
      { secretFields: { 'secretHeaders.X-Api-Key': 'sk-live-123' } },
    );
    expect(main.received.map((r) => r.url)).toEqual(['/start', '/next']);
    expect(main.received[1]!.headers['x-api-key']).toBe('sk-live-123');
  });

  it('a 303 after a POST becomes a GET without the body', async () => {
    main.set((req, res, body) => {
      if (req.url === '/form') res.writeHead(303, { location: '/done' }).end();
      else json(200, { method: req.method, body })(req, res, '');
    });
    const events = await run({ url: '/form', method: 'POST', body: 'a=1' });
    expect(succeeded(events).outputs.body).toEqual({ method: 'GET', body: '' });
  });

  it('a redirect loop fails permanent', async () => {
    main.set((_q, res) => res.writeHead(302, { location: '/again' }).end());
    expect(failed(await run({ url: '/' })).kind).toBe('permanent');
  });
});

describe('Web — failures to complete', () => {
  it('a refused connection is transient', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    const event = failed(await run({ url: `http://127.0.0.1:${port}/` }));
    expect(event.kind).toBe('transient');
    expect(event.error).toContain('ECONNREFUSED');
  });

  it('a malformed URL is permanent', async () => {
    expect(failed(await run({ url: 'http://exa mple.com/' }, { connectionConfig: {} })).kind).toBe(
      'permanent',
    );
  });

  it('the activity timeout beats the connection timeout, and is transient', async () => {
    main.set(() => undefined); // never answers
    const started = Date.now();
    const event = failed(
      await run(
        { url: '/', httpRequestTimeoutSeconds: 1 },
        { connectionConfig: { baseUrl: main.url(), timeoutMs: 60_000 } },
      ),
    );
    expect(event).toMatchObject({ kind: 'transient', error: 'web request timed out after 1000ms' });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('the run cancel is cancelled', async () => {
    main.set(() => undefined);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    expect(failed(await run({ url: '/' }, { signal: controller.signal })).kind).toBe('cancelled');
  });

  it('a config the schema refuses fails permanent before any request', async () => {
    const event = failed(await run({ url: '/', whenOverLimit: 'truncate' }));
    expect(event.kind).toBe('permanent');
    expect(event.error).toContain('Parse as Text');
    expect(main.received).toHaveLength(0);
  });
});
