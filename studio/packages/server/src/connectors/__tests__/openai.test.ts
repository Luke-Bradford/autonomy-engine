import { afterEach, describe, expect, it, vi } from 'vitest';
import { openaiAdapter } from '../openai.js';
import type { ActivityContext, ActivityEvent } from '../types.js';

async function drain(stream: AsyncIterable<ActivityEvent>): Promise<ActivityEvent[]> {
  const events: ActivityEvent[] = [];
  for await (const e of stream) events.push(e);
  return events;
}

/** The terminal `succeeded` event — now preceded by a `metered` event (#2 L2). */
function succeeded(events: ActivityEvent[]): Extract<ActivityEvent, { type: 'succeeded' }> {
  const ev = events.find((e) => e.type === 'succeeded');
  if (ev === undefined) throw new Error(`no succeeded event in ${JSON.stringify(events)}`);
  return ev;
}

/** The `metered` usage event (#2 L2), or undefined if none was yielded. */
function metered(events: ActivityEvent[]): Extract<ActivityEvent, { type: 'metered' }> | undefined {
  return events.find((e): e is Extract<ActivityEvent, { type: 'metered' }> => e.type === 'metered');
}

function ctx(over: Partial<ActivityContext> = {}): ActivityContext {
  return {
    runId: 'run_1',
    nodeId: 'n1',
    attemptId: 'n1#0',
    activityType: over.activityType ?? 'llm_call',
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
  usage: { prompt_tokens: 11, completion_tokens: 4 },
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
    expect(succeeded(events)).toMatchObject({
      type: 'succeeded',
      outputs: { stopReason: 'unknown' },
    });
    const outputs = succeeded(events).outputs;
    expect(typeof outputs.stopReason).toBe('string');
  });

  // #461 — a 2xx with NO readable completion is a permanent failure, not
  // `succeeded{text:''}`: the completion is the activity's product, and an
  // absent/degenerate response structure means the provider returned no product.
  //
  // #556 — sub-reason (diagnostic; retry class stays `permanent`): an absent/
  // non-array `choices` container is `absent_content`; a present-but-empty
  // `choices:[]` is `empty_completion_set`; a candidate present but its
  // `message.content` non-string/absent is `malformed_block`.
  it.each([
    ['no choices field at all', {}, 'absent_content'],
    ['an empty choices array', { choices: [] }, 'empty_completion_set'],
    ['a choice with no message', { choices: [{ finish_reason: 'stop' }] }, 'malformed_block'],
    [
      'a message with no content',
      { choices: [{ message: { role: 'assistant' } }] },
      'malformed_block',
    ],
    ['a non-string content', { choices: [{ message: { content: 42 } }] }, 'malformed_block'],
    [
      'a null content (tool-call shape)',
      { choices: [{ message: { content: null } }] },
      'malformed_block',
    ],
  ])('fails permanent (%s → %s) when the 2xx body carries it', async (_label, body, reason) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, body));
    const events = await drain(openaiAdapter.runActivity(ctx(), 'sk-oai'));
    expect(events).toEqual([
      {
        type: 'failed',
        kind: 'permanent',
        error: `openai_api returned a 2xx response with no completion (${reason})`,
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
    expect(succeeded(events)).toEqual({
      type: 'succeeded',
      outputs: { text: '', stopReason: 'content_filter' },
    });
  });

  it('POSTs chat/completions and surfaces content + finish_reason', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    const events = await drain(openaiAdapter.runActivity(ctx(), 'sk-oai'));
    expect(succeeded(events)).toEqual({
      type: 'succeeded',
      outputs: { text: 'the answer', stopReason: 'stop' },
    });
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

// #2 L1 — config v2: role `messages[]` + sampling, with the system instruction
// carried as a LEADING `role:system` message (Chat Completions has no top-level
// system param).
describe('openaiAdapter v2 config (L1)', () => {
  it('prepends system as a role:system message and keeps non-system turn order', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    await drain(
      openaiAdapter.runActivity(
        ctx({
          input: {
            model: 'gpt-4o',
            system: 'be terse',
            messages: [
              { role: 'user', content: 'u1' },
              { role: 'assistant', content: 'a1' },
            ],
          },
        }),
        'sk',
      ),
    );
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.messages).toEqual([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
    ]);
  });

  it('maps sampling to OpenAI names (top_p, stop, seed)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    await drain(
      openaiAdapter.runActivity(
        ctx({ input: { prompt: 'p', model: 'gpt-4o', topP: 0.9, stop: ['STOP'], seed: 7 } }),
        'sk',
      ),
    );
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.top_p).toBe(0.9);
    expect(body.stop).toEqual(['STOP']);
    expect(body.seed).toBe(7);
  });

  // #2 L3 — `reasoningEffort` maps to the top-level `reasoning_effort` param.
  it('maps reasoningEffort to reasoning_effort (max clamps to high; OpenAI has no `max`)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    await drain(
      openaiAdapter.runActivity(
        ctx({ input: { prompt: 'p', model: 'gpt-4o', reasoningEffort: 'low' } }),
        'sk',
      ),
    );
    expect(
      JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string).reasoning_effort,
    ).toBe('low');

    fetchSpy.mockClear();
    await drain(
      openaiAdapter.runActivity(
        ctx({ input: { prompt: 'p', model: 'gpt-4o', reasoningEffort: 'max' } }),
        'sk',
      ),
    );
    expect(
      JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string).reasoning_effort,
    ).toBe('high');
  });

  it('sends NO reasoning_effort when reasoningEffort is unset (byte-compat with pre-L3)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    await drain(openaiAdapter.runActivity(ctx({ input: { prompt: 'p', model: 'gpt-4o' } }), 'sk'));
    expect(
      JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string).reasoning_effort,
    ).toBeUndefined();
  });

  it('validates the whole node.config — the seeded `outputs` key passes (non-strict)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    const events = await drain(
      openaiAdapter.runActivity(
        ctx({
          input: { prompt: 'p', model: 'gpt-4o', outputs: [{ key: 'text', type: 'string' }] },
        }),
        'sk',
      ),
    );
    expect(succeeded(events)).toMatchObject({ type: 'succeeded' });
  });
});

// #2 L2 — usage capture. Chat Completions reports `usage.{prompt_tokens,
// completion_tokens}`; the adapter yields a `metered` event before the terminal.
describe('openaiAdapter usage capture (L2)', () => {
  it('yields a metered event with the token counts, ordered before succeeded', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    const events = await drain(openaiAdapter.runActivity(ctx(), 'sk'));
    expect(events.map((e) => e.type)).toEqual(['metered', 'succeeded']);
    expect(metered(events)).toEqual({
      type: 'metered',
      usage: {
        provider: 'openai_api',
        model: 'gpt-4o',
        inputTokens: 11,
        outputTokens: 4,
        meteringStatus: 'metered',
      },
    });
  });

  it('reports meteringStatus unknown when a gateway omits usage', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(200, {
        choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
      }),
    );
    const events = await drain(openaiAdapter.runActivity(ctx(), 'sk'));
    expect(metered(events)?.usage).toEqual({
      provider: 'openai_api',
      model: 'gpt-4o',
      meteringStatus: 'unknown',
    });
    expect(succeeded(events)).toMatchObject({ type: 'succeeded' });
  });

  it('yields NO metered event on a failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(429, 'slow down'));
    const events = await drain(openaiAdapter.runActivity(ctx(), 'sk'));
    expect(metered(events)).toBeUndefined();
    expect(events[0]).toMatchObject({ type: 'failed' });
  });
});

function failed(events: ActivityEvent[]): Extract<ActivityEvent, { type: 'failed' }> {
  const ev = events.find((e) => e.type === 'failed');
  if (ev === undefined) throw new Error(`no failed event in ${JSON.stringify(events)}`);
  return ev;
}

const STRUCTURED_INPUT = {
  prompt: 'classify this ticket',
  model: 'gpt-4o',
  outputMode: 'structured',
  outputSchema: {
    type: 'object',
    properties: { category: { type: 'string', enum: ['bug', 'feature'] } },
  },
};

/** A Chat Completions response whose content is the structured JSON string. */
function jsonResponse(obj: unknown): unknown {
  return {
    choices: [{ message: { content: JSON.stringify(obj) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 9, completion_tokens: 3 },
  };
}

describe('openaiAdapter.runActivity — structured output (#2 L4b)', () => {
  it('sends response_format:json_object and a JSON-schema system directive', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(fakeResponse(200, jsonResponse({ category: 'bug' })));
    await drain(openaiAdapter.runActivity(ctx({ input: STRUCTURED_INPUT }), 'sk'));
    const body = JSON.parse((spy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.response_format).toEqual({ type: 'json_object' });
    const sys = (body.messages as { role: string; content: string }[]).find(
      (m) => m.role === 'system',
    );
    // json_object mode requires the token "JSON" in the prompt; the schema steers.
    expect(sys?.content).toContain('JSON');
    expect(sys?.content).toContain('category');
  });

  it('keeps reasoning_effort alongside structured mode (no Anthropic-style clash)', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(fakeResponse(200, jsonResponse({ category: 'bug' })));
    await drain(
      openaiAdapter.runActivity(
        ctx({ input: { ...STRUCTURED_INPUT, reasoningEffort: 'high' } }),
        'sk',
      ),
    );
    const body = JSON.parse((spy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.reasoning_effort).toBe('high');
  });

  it('meters then succeeds with the parsed+validated object (unknown key stripped)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(200, jsonResponse({ category: 'feature', junk: 1 })),
    );
    const events = await drain(openaiAdapter.runActivity(ctx({ input: STRUCTURED_INPUT }), 'sk'));
    expect(metered(events)?.usage).toMatchObject({ inputTokens: 9, outputTokens: 3 });
    expect(succeeded(events).outputs).toEqual({ category: 'feature' });
  });

  it('fails permanent (still meters) on an out-of-enum value (#592)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(200, jsonResponse({ category: 'question' })),
    );
    const events = await drain(openaiAdapter.runActivity(ctx({ input: STRUCTURED_INPUT }), 'sk'));
    expect(metered(events)).toBeDefined();
    expect(failed(events)).toMatchObject({ kind: 'permanent' });
    expect(failed(events).error).toContain('enum');
  });

  it('fails permanent when the completion is not valid JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(200, {
        choices: [{ message: { content: 'sorry, not json' } }],
        usage: {},
      }),
    );
    const events = await drain(openaiAdapter.runActivity(ctx({ input: STRUCTURED_INPUT }), 'sk'));
    expect(failed(events)).toMatchObject({ kind: 'permanent' });
    expect(failed(events).error).toContain('JSON');
  });
});
