import { afterEach, describe, expect, it, vi } from 'vitest';
import { ollamaAdapter } from '../ollama.js';
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
    input: over.input ?? { prompt: 'hi', model: 'llama3' },
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
  message: { role: 'assistant', content: 'local answer' },
  done: true,
  done_reason: 'stop',
};

describe('ollamaAdapter.runActivity', () => {
  it('POSTs /api/chat (stream:false) to localhost by default, no auth header', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    const events = await drain(ollamaAdapter.runActivity(ctx(), null));
    expect(events).toEqual([
      { type: 'succeeded', outputs: { text: 'local answer', stopReason: 'stop' } },
    ]);
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('http://localhost:11434/api/chat');
    const body = JSON.parse(init.body as string);
    expect(body.stream).toBe(false);
    expect(body.model).toBe('llama3');
    expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined();
  });

  it('maps maxTokens to options.num_predict and passes temperature', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    await drain(
      ollamaAdapter.runActivity(
        ctx({ input: { prompt: 'hi', model: 'llama3', maxTokens: 128, temperature: 0.2 } }),
        null,
      ),
    );
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.options).toEqual({ temperature: 0.2, num_predict: 128 });
  });

  it('sends a bearer token only when a secret is present (proxied Ollama)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    await drain(ollamaAdapter.runActivity(ctx(), 'proxy-token'));
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer proxy-token');
  });

  it('defaults stopReason to "stop" when done_reason is absent', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(200, { message: { content: 'x' }, done: true }),
    );
    const events = await drain(ollamaAdapter.runActivity(ctx(), null));
    expect(events[0]).toMatchObject({ type: 'succeeded', outputs: { stopReason: 'stop' } });
  });

  it('fails permanent when no model is resolvable', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const events = await drain(ollamaAdapter.runActivity(ctx({ input: { prompt: 'hi' } }), null));
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('maps 500 to a transient failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(500, 'model loading'));
    const events = await drain(ollamaAdapter.runActivity(ctx(), null));
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'transient' });
  });
});
