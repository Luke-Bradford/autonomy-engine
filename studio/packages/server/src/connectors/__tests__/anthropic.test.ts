import { afterEach, describe, expect, it, vi } from 'vitest';
import { anthropicAdapter } from '../anthropic.js';
import type { ActivityContext, ActivityEvent } from '../types.js';

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
    input: over.input ?? { prompt: 'hello there' },
    connectionConfig: over.connectionConfig ?? {},
    signal: over.signal ?? new AbortController().signal,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

function fakeResponse(status: number, body: unknown): Response {
  return {
    status,
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    headers: new Headers(),
  } as unknown as Response;
}

const OK_BODY = {
  content: [
    { type: 'text', text: 'Hi ' },
    { type: 'text', text: 'there!' },
  ],
  stop_reason: 'end_turn',
};

describe('anthropicAdapter.runActivity', () => {
  // #457 — `stop_reason` is absent on any response shape this adapter does not
  // anticipate (and `null` on a streaming one); `?? null` used to yield `null`
  // there, failing the node. See `coerceStopReason` for the contract rationale.
  it.each([
    ['absent', {}],
    ['a non-string', { stop_reason: 42 }],
    ['null', { stop_reason: null }],
  ])('yields a string stopReason when stop_reason is %s', async (_label, over) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(200, { content: [{ type: 'text', text: 'x' }], ...over }),
    );
    const events = await drain(anthropicAdapter.runActivity(ctx(), 'sk-ant-key'));
    expect(events[0]).toMatchObject({ type: 'succeeded', outputs: { stopReason: 'unknown' } });
    const outputs = (events[0] as Extract<ActivityEvent, { type: 'succeeded' }>).outputs;
    expect(typeof outputs.stopReason).toBe('string');
  });

  // #461 — a 2xx with NO readable completion (absent/non-array `content`, or a
  // content array with zero text-type blocks) is a permanent failure, not
  // `succeeded{text:''}`. A tool_use-only response is text-mode-empty and fails
  // here because tools are not wired yet (revisit at L4b/L10).
  it.each([
    ['no content field', {}],
    ['a non-array content', { content: 'hi' }],
    ['an empty content array', { content: [] }],
    ['only non-text blocks', { content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }] }],
  ])('fails permanent when the 2xx body carries %s', async (_label, body) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, body));
    const events = await drain(anthropicAdapter.runActivity(ctx(), 'sk-ant-key'));
    expect(events).toEqual([
      {
        type: 'failed',
        kind: 'permanent',
        error: 'anthropic_api returned a 2xx response with no completion',
      },
    ]);
  });

  // The complement: a present text block (even an empty string) is a real result.
  it('succeeds with a present-but-empty text block', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(200, { content: [{ type: 'text', text: '' }], stop_reason: 'end_turn' }),
    );
    const events = await drain(anthropicAdapter.runActivity(ctx(), 'sk-ant-key'));
    expect(events).toEqual([{ type: 'succeeded', outputs: { text: '', stopReason: 'end_turn' } }]);
  });

  it('POSTs the Messages API and surfaces concatenated text + stopReason', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));

    const events = await drain(anthropicAdapter.runActivity(ctx(), 'sk-ant-key'));

    expect(events).toEqual([
      { type: 'succeeded', outputs: { text: 'Hi there!', stopReason: 'end_turn' } },
    ]);
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-key');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('defaults the model to claude-opus-4-8 and max_tokens, honoring input overrides', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    await drain(
      anthropicAdapter.runActivity(
        ctx({ input: { prompt: 'p', system: 'be terse', maxTokens: 50 } }),
        'sk',
      ),
    );
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.model).toBe('claude-opus-4-8');
    expect(body.max_tokens).toBe(50);
    expect(body.system).toBe('be terse');
    expect(body.messages).toEqual([{ role: 'user', content: 'p' }]);
  });

  it('prefers the node model over the connection default model', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    await drain(
      anthropicAdapter.runActivity(
        ctx({
          input: { prompt: 'p', model: 'claude-haiku-4-5' },
          connectionConfig: { model: 'x' },
        }),
        'sk',
      ),
    );
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.model).toBe('claude-haiku-4-5');
  });

  it('fails permanent (no request) when no API-key secret is resolved', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const events = await drain(anthropicAdapter.runActivity(ctx(), null));
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('maps 401 to auth, 429 to rate_limit, 500 to transient', async () => {
    for (const [status, kind] of [
      [401, 'auth'],
      [429, 'rate_limit'],
      [500, 'transient'],
    ] as const) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        fakeResponse(status, { error: { message: 'boom' } }),
      );
      const events = await drain(anthropicAdapter.runActivity(ctx(), 'sk'));
      expect(events[0]).toMatchObject({ type: 'failed', kind });
      vi.restoreAllMocks();
    }
  });

  it('never echoes the secret in a failure event', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(401, 'unauthorized'));
    const events = await drain(anthropicAdapter.runActivity(ctx(), 'sk-super-secret'));
    expect(JSON.stringify(events)).not.toContain('sk-super-secret');
  });

  it('maps an aborted run to a cancelled failure', async () => {
    const controller = new AbortController();
    controller.abort();
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    );
    const events = await drain(
      anthropicAdapter.runActivity(ctx({ signal: controller.signal }), 'sk'),
    );
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'cancelled' });
  });

  it('maps a malformed 2xx JSON body to a permanent failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, 'not json{'));
    const events = await drain(anthropicAdapter.runActivity(ctx(), 'sk'));
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
  });

  it('REDACTS the secret when a header-validation TypeError quotes it verbatim', async () => {
    // A secret with an embedded CR makes an invalid header value; Node quotes it
    // verbatim in the TypeError message. That message must never carry the key.
    const secret = 'sk-realkey-9999\rINJECT';
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError(`Headers.append: "${secret}" is an invalid header value.`),
    );
    const events = await drain(anthropicAdapter.runActivity(ctx(), secret));
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect(JSON.stringify(events)).not.toContain('sk-realkey-9999');
    expect(JSON.stringify(events)).toContain('***');
  });

  it('maps a bad-URL TypeError to a permanent failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Invalid URL'));
    const events = await drain(anthropicAdapter.runActivity(ctx(), 'sk'));
    expect(events[0]).toMatchObject({
      type: 'failed',
      kind: 'permanent',
      error: expect.stringContaining('Invalid URL'),
    });
  });

  it('bounds a hung provider by the timeout and reports a transient failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          (init as RequestInit).signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
    );
    const events = await drain(
      anthropicAdapter.runActivity(ctx({ connectionConfig: { timeoutMs: 10 } }), 'sk'),
    );
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'transient' });
    expect(JSON.stringify(events)).toContain('timed out');
  });
});
