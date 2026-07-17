import { afterEach, describe, expect, it, vi } from 'vitest';
import { openaiAdapter } from '../openai.js';
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
    input: over.input ?? { prompt: 'hi', model: 'gpt-4o' },
    connectionConfig: over.connectionConfig ?? {},
    signal: over.signal ?? new AbortController().signal,
  };
}

afterEach(() => vi.restoreAllMocks());

function fakeResponse(status: number, body: unknown): Response {
  return {
    status,
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    headers: new Headers(),
  } as unknown as Response;
}

const OK_BODY = {
  choices: [{ message: { role: 'assistant', content: 'the answer' }, finish_reason: 'stop' }],
};

describe('openaiAdapter.runActivity', () => {
  // #457 — a missing `finish_reason` is realistic here beyond OpenAI itself:
  // `baseUrl` points this adapter at any OpenAI-COMPATIBLE gateway, which need
  // not populate it. See `coerceStopReason` for the contract rationale.
  it.each([
    ['absent', { message: { content: 'x' } }],
    ['a non-string', { message: { content: 'x' }, finish_reason: 42 }],
    ['null', { message: { content: 'x' }, finish_reason: null }],
  ])('yields a string stopReason when finish_reason is %s', async (_label, choice) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, { choices: [choice] }));
    const events = await drain(openaiAdapter.runActivity(ctx(), 'sk-oai'));
    expect(events[0]).toMatchObject({ type: 'succeeded', outputs: { stopReason: 'unknown' } });
    const outputs = (events[0] as Extract<ActivityEvent, { type: 'succeeded' }>).outputs;
    expect(typeof outputs.stopReason).toBe('string');
  });

  // #461 — a 2xx with NO readable completion is a permanent failure, not
  // `succeeded{text:''}`: the completion is the activity's product, and an
  // absent/degenerate response structure means the provider returned no product.
  it.each([
    ['no choices field at all', {}],
    ['an empty choices array', { choices: [] }],
    ['a choice with no message', { choices: [{ finish_reason: 'stop' }] }],
    ['a message with no content', { choices: [{ message: { role: 'assistant' } }] }],
    ['a non-string content', { choices: [{ message: { content: 42 } }] }],
    ['a null content (tool-call shape)', { choices: [{ message: { content: null } }] }],
  ])('fails permanent when the 2xx body carries %s', async (_label, body) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, body));
    const events = await drain(openaiAdapter.runActivity(ctx(), 'sk-oai'));
    expect(events).toEqual([
      {
        type: 'failed',
        kind: 'permanent',
        error: 'openai_api returned a 2xx response with no completion',
      },
    ]);
  });

  // The complement: a PRESENT-but-empty completion is a real result and succeeds
  // — `stopReason` (e.g. content_filter) carries why; downstream can branch.
  it('succeeds with an explicit empty-string completion', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(200, {
        choices: [{ message: { content: '' }, finish_reason: 'content_filter' }],
      }),
    );
    const events = await drain(openaiAdapter.runActivity(ctx(), 'sk-oai'));
    expect(events).toEqual([
      { type: 'succeeded', outputs: { text: '', stopReason: 'content_filter' } },
    ]);
  });

  it('POSTs chat/completions and surfaces content + finish_reason', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    const events = await drain(openaiAdapter.runActivity(ctx(), 'sk-oai'));
    expect(events).toEqual([
      { type: 'succeeded', outputs: { text: 'the answer', stopReason: 'stop' } },
    ]);
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer sk-oai');
    const body = JSON.parse(init.body as string);
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('prepends a system message when provided', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    await drain(
      openaiAdapter.runActivity(
        ctx({ input: { prompt: 'hi', model: 'gpt-4o', system: 'be brief' } }),
        'sk',
      ),
    );
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.messages).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('honors a custom baseUrl (OpenAI-compatible gateway)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    await drain(
      openaiAdapter.runActivity(
        ctx({ connectionConfig: { baseUrl: 'https://api.groq.com/openai/v1/' } }),
        'sk',
      ),
    );
    expect(fetchSpy.mock.calls[0]![0]).toBe('https://api.groq.com/openai/v1/chat/completions');
  });

  it('fails permanent when no model is resolvable', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const events = await drain(openaiAdapter.runActivity(ctx({ input: { prompt: 'hi' } }), 'sk'));
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails permanent (no request) with no API key', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const events = await drain(openaiAdapter.runActivity(ctx(), null));
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('maps 429 to rate_limit and never echoes the secret', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(429, 'slow down'));
    const events = await drain(openaiAdapter.runActivity(ctx(), 'sk-secret-xyz'));
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'rate_limit' });
    expect(JSON.stringify(events)).not.toContain('sk-secret-xyz');
  });
});
