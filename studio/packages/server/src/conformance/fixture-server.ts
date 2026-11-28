import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * #1574 OR39 — the local HTTP backend: one server on 127.0.0.1 that answers as
 * the `http` kind's target and as the three hosted LLM APIs, at their real
 * paths, with their real response shapes. The adapters reach it over the
 * network through their `baseUrl`, exactly as they reach a provider: nothing in
 * studio is stubbed. Every request is recorded, so a cell can prove what the
 * adapter actually sent.
 */

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
}

export interface FixtureServer {
  readonly url: string;
  readonly requests: RecordedRequest[];
  close(): Promise<void>;
}

/** The completion text every LLM route answers with. */
export const FIXTURE_COMPLETION = 'fixture answer';

/** `/flaky/<key>`: the keys already answered once, with a 503. */
const flakySeen = new Set<string>();

/** How long `/slow` takes to answer, longer than any cell's timeout policy. */
export const SLOW_MS = 5_000;

function answer(method: string, path: string, body: string): { status: number; json: unknown } {
  // A transient failure the first time each key is asked, then a success: the
  // shape a retry policy exists for.
  if (path.startsWith('/flaky/')) {
    if (!flakySeen.has(path)) {
      flakySeen.add(path);
      return { status: 503, json: { error: 'try again' } };
    }
    return { status: 200, json: { ok: true } };
  }
  // Probes: each provider's model list.
  if (method === 'GET' && (path === '/v1/models' || path === '/models')) {
    return { status: 200, json: { data: [{ id: 'fixture-model' }] } };
  }
  if (method === 'GET' && path === '/api/tags') {
    return { status: 200, json: { models: [{ name: 'fixture-model' }] } };
  }
  // Anthropic Messages.
  if (method === 'POST' && path === '/v1/messages') {
    return {
      status: 200,
      json: {
        content: [{ type: 'text', text: FIXTURE_COMPLETION }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 3, output_tokens: 2 },
      },
    };
  }
  // OpenAI-compatible Chat Completions.
  if (method === 'POST' && path === '/chat/completions') {
    return {
      status: 200,
      json: {
        choices: [
          { message: { role: 'assistant', content: FIXTURE_COMPLETION }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      },
    };
  }
  // Ollama chat.
  if (method === 'POST' && path === '/api/chat') {
    return {
      status: 200,
      json: {
        message: { role: 'assistant', content: FIXTURE_COMPLETION },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 3,
        eval_count: 2,
      },
    };
  }
  // Anything else: the `http` kind's target, which echoes what it was sent.
  return { status: 200, json: { method, path, body } };
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const path = (req.url ?? '/').split('?')[0] ?? '/';
      const method = req.method ?? 'GET';
      requests.push({ method, path, headers: req.headers, body });
      const { status, json } = answer(method, path, body);
      const send = (): void => {
        if (res.destroyed) return;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      if (path === '/slow') setTimeout(send, SLOW_MS).unref();
      else send();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
