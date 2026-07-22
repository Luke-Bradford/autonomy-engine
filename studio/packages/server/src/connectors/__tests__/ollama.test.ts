import { afterEach, describe, expect, it, vi } from 'vitest';
import { ollamaAdapter } from '../ollama.js';
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

/** The `captured` prompt/completion event (#2 L9a). */
function captured(events: ActivityEvent[]): Extract<ActivityEvent, { type: 'captured' }> {
  const ev = events.find(
    (e): e is Extract<ActivityEvent, { type: 'captured' }> => e.type === 'captured',
  );
  if (ev === undefined) throw new Error(`no captured event in ${JSON.stringify(events)}`);
  return ev;
}

function ctx(over: Partial<ActivityContext> = {}): ActivityContext {
  return {
    runId: 'run_1',
    nodeId: 'n1',
    attemptId: 'n1#0',
    activityType: over.activityType ?? 'llm_call',
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
  prompt_eval_count: 12,
  eval_count: 8,
};

describe('ollamaAdapter.runActivity', () => {
  it('POSTs /api/chat (stream:false) to localhost by default, no auth header', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    const events = await drain(ollamaAdapter.runActivity(ctx(), null));
    expect(succeeded(events)).toEqual({
      type: 'succeeded',
      outputs: { text: 'local answer', stopReason: 'stop' },
    });
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

  // #457 — CHANGED: this adapter used to default an absent `done_reason` to
  // `'stop'`. It was the only adapter honouring its declared `string` type, but
  // it did so by inventing a REAL provider value. All three now share
  // `coerceStopReason` — see its docblock for why the sentinel is not `'stop'`.
  it('defaults stopReason to the "unknown" sentinel when done_reason is absent', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(200, { message: { content: 'x' }, done: true }),
    );
    const events = await drain(ollamaAdapter.runActivity(ctx(), null));
    expect(succeeded(events)).toMatchObject({
      type: 'succeeded',
      outputs: { stopReason: 'unknown' },
    });
  });

  // #461 — a 2xx with NO readable completion is a permanent failure, not
  // `succeeded{text:''}`.
  //
  // #556 — sub-reason (diagnostic; retry class stays `permanent`): an absent/
  // non-object `message` is `absent_content`; a present message whose `content`
  // is non-string/absent is `malformed_block`. ollama has no
  // `empty_completion_set` — its response is a single message, not a candidate set.
  it.each([
    ['no message field', { done: true }, 'absent_content'],
    ['a message with no content', { message: { role: 'assistant' } }, 'malformed_block'],
    ['a non-string content', { message: { content: 42 } }, 'malformed_block'],
  ])('fails permanent (%s → %s) when the 2xx body carries it', async (_label, body, reason) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, body));
    const events = await drain(ollamaAdapter.runActivity(ctx(), null));
    // #2 L9a — a capture (completion ABSENT) precedes the terminal failure.
    expect(events.map((e) => e.type)).toEqual(['captured', 'failed']);
    expect(failed(events)).toEqual({
      type: 'failed',
      kind: 'permanent',
      error: `ollama returned a 2xx response with no completion (${reason})`,
    });
    expect(captured(events).capture.completion).toBeUndefined();
  });

  it('succeeds with an explicit empty-string completion', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(200, { message: { content: '' }, done_reason: 'stop' }),
    );
    const events = await drain(ollamaAdapter.runActivity(ctx(), null));
    expect(succeeded(events)).toEqual({
      type: 'succeeded',
      outputs: { text: '', stopReason: 'stop' },
    });
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
    expect(failed(events)).toMatchObject({ type: 'failed', kind: 'transient' });
  });
});

// #2 L1 — config v2: role `messages[]`, with the system instruction as a
// LEADING role:system message and sampling under `options`.
describe('ollamaAdapter v2 config (L1)', () => {
  it('prepends system as a role:system message and keeps non-system turn order', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    await drain(
      ollamaAdapter.runActivity(
        ctx({
          input: {
            model: 'llama3',
            system: 'be terse',
            messages: [
              { role: 'user', content: 'u1' },
              { role: 'assistant', content: 'a1' },
            ],
          },
        }),
        null,
      ),
    );
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.messages).toEqual([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
    ]);
  });

  it('maps sampling under options (top_p, stop, seed, num_predict)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    await drain(
      ollamaAdapter.runActivity(
        ctx({
          input: {
            prompt: 'p',
            model: 'llama3',
            topP: 0.9,
            stop: ['STOP'],
            seed: 7,
            maxTokens: 42,
          },
        }),
        null,
      ),
    );
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.options.top_p).toBe(0.9);
    expect(body.options.stop).toEqual(['STOP']);
    expect(body.options.seed).toBe(7);
    expect(body.options.num_predict).toBe(42);
  });

  // #2 L3 — Ollama's `/api/chat` takes reasoning as the TOP-LEVEL `think` param
  // (not under `options`); our enum passes through verbatim. `max` is not a
  // documented Ollama level, so it's best-effort (may be ignored/rejected by a
  // model) — but the ADAPTER's job is faithful passthrough, which this pins.
  // Spec #2: "ollama/others: best-effort or ignored".
  it('maps reasoningEffort to the top-level `think` param (verbatim, incl. max)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    await drain(
      ollamaAdapter.runActivity(
        ctx({ input: { prompt: 'p', model: 'llama3', reasoningEffort: 'max' } }),
        null,
      ),
    );
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.think).toBe('max');
    expect(body.options).toBeUndefined(); // think is not a sampling option
  });

  it('sends NO `think` when reasoningEffort is unset (byte-compat with pre-L3)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    await drain(ollamaAdapter.runActivity(ctx({ input: { prompt: 'p', model: 'llama3' } }), null));
    expect(
      JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string).think,
    ).toBeUndefined();
  });

  it('validates the whole node.config — the seeded `outputs` key passes (non-strict)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    const events = await drain(
      ollamaAdapter.runActivity(
        ctx({
          input: { prompt: 'p', model: 'llama3', outputs: [{ key: 'text', type: 'string' }] },
        }),
        null,
      ),
    );
    expect(succeeded(events)).toMatchObject({ type: 'succeeded' });
  });
});

// #2 L2 — usage capture. Ollama reports token counts at the TOP LEVEL
// (`prompt_eval_count`/`eval_count`), not under a `usage` object.
describe('ollamaAdapter usage capture (L2)', () => {
  it('yields a metered event with the top-level token counts, before succeeded', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    const events = await drain(ollamaAdapter.runActivity(ctx(), null));
    expect(events.map((e) => e.type)).toEqual(['metered', 'captured', 'succeeded']);
    expect(metered(events)).toEqual({
      type: 'metered',
      usage: {
        provider: 'ollama',
        model: 'llama3',
        inputTokens: 12,
        outputTokens: 8,
        meteringStatus: 'metered',
      },
    });
  });

  it('reports meteringStatus unknown when a model omits the eval counts', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(200, { message: { content: 'x' }, done_reason: 'stop' }),
    );
    const events = await drain(ollamaAdapter.runActivity(ctx(), null));
    expect(metered(events)?.usage).toEqual({
      provider: 'ollama',
      model: 'llama3',
      meteringStatus: 'unknown',
    });
    expect(succeeded(events)).toMatchObject({ type: 'succeeded' });
  });

  it('yields NO metered event on a failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(500, 'model crashed'));
    const events = await drain(ollamaAdapter.runActivity(ctx(), null));
    expect(metered(events)).toBeUndefined();
    expect(failed(events)).toMatchObject({ type: 'failed' });
  });
});

function failed(events: ActivityEvent[]): Extract<ActivityEvent, { type: 'failed' }> {
  const ev = events.find((e) => e.type === 'failed');
  if (ev === undefined) throw new Error(`no failed event in ${JSON.stringify(events)}`);
  return ev;
}

const STRUCTURED_INPUT = {
  prompt: 'classify this ticket',
  model: 'llama3',
  outputMode: 'structured',
  outputSchema: {
    type: 'object',
    properties: { category: { type: 'string', enum: ['bug', 'feature'] } },
  },
};

/** An /api/chat response whose message.content is the structured JSON string. */
function jsonResponse(obj: unknown): unknown {
  return {
    message: { role: 'assistant', content: JSON.stringify(obj) },
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 12,
    eval_count: 8,
  };
}

describe('ollamaAdapter.runActivity — structured output (#2 L4b)', () => {
  it('sends the schema in the native top-level format field', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(fakeResponse(200, jsonResponse({ category: 'bug' })));
    await drain(ollamaAdapter.runActivity(ctx({ input: STRUCTURED_INPUT }), null));
    const body = JSON.parse((spy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.format).toEqual(STRUCTURED_INPUT.outputSchema);
  });

  it('keeps the think reasoning field alongside structured mode', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(fakeResponse(200, jsonResponse({ category: 'bug' })));
    await drain(
      ollamaAdapter.runActivity(
        ctx({ input: { ...STRUCTURED_INPUT, reasoningEffort: 'high' } }),
        null,
      ),
    );
    const body = JSON.parse((spy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.format).toEqual(STRUCTURED_INPUT.outputSchema);
    expect(body.think).toBe('high');
  });

  it('meters then succeeds with the parsed+validated object (unknown key stripped)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(200, jsonResponse({ category: 'feature', junk: 1 })),
    );
    const events = await drain(ollamaAdapter.runActivity(ctx({ input: STRUCTURED_INPUT }), null));
    expect(metered(events)?.usage).toMatchObject({ inputTokens: 12, outputTokens: 8 });
    expect(succeeded(events).outputs).toEqual({ category: 'feature' });
  });

  it('fails permanent (metering BOTH repair calls) on a persistently out-of-enum value (#592)', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(fakeResponse(200, jsonResponse({ category: 'question' })));
    const events = await drain(ollamaAdapter.runActivity(ctx({ input: STRUCTURED_INPUT }), null));
    expect(spy).toHaveBeenCalledTimes(2); // #2 L4c — one internal repair
    expect(events.filter((e) => e.type === 'metered')).toHaveLength(2);
    expect(failed(events)).toMatchObject({ kind: 'permanent' });
    expect(failed(events).error).toContain('enum');
  });

  it('fails permanent (metering both calls) when message.content is never valid JSON', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(200, {
        message: { content: 'not json' },
        prompt_eval_count: 1,
        eval_count: 1,
      }),
    );
    const events = await drain(ollamaAdapter.runActivity(ctx({ input: STRUCTURED_INPUT }), null));
    expect(spy).toHaveBeenCalledTimes(2);
    expect(failed(events)).toMatchObject({ kind: 'permanent' });
    expect(failed(events).error).toContain('JSON');
  });

  it('#2 L4c — repairs an invalid FIRST completion then succeeds (two metered)', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(fakeResponse(200, jsonResponse({ category: 'question' }))) // out-of-enum
      .mockResolvedValueOnce(fakeResponse(200, jsonResponse({ category: 'feature' }))); // corrected
    const events = await drain(ollamaAdapter.runActivity(ctx({ input: STRUCTURED_INPUT }), null));
    expect(spy).toHaveBeenCalledTimes(2);
    expect(events.filter((e) => e.type === 'metered')).toHaveLength(2);
    expect(succeeded(events).outputs).toEqual({ category: 'feature' });
    // the repair request keeps the native `format` schema AND carries the critique.
    const secondBody = JSON.parse((spy.mock.calls[1]![1] as RequestInit).body as string);
    const msgs = secondBody.messages as { role: string; content: string }[];
    expect(secondBody.format).toEqual(STRUCTURED_INPUT.outputSchema);
    expect(msgs.some((m) => m.role === 'user' && m.content.includes('enum'))).toBe(true);
  });

  it('#2 L4c — does NOT repair a transport failure (one call, no metered)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(500, 'boom'));
    const events = await drain(ollamaAdapter.runActivity(ctx({ input: STRUCTURED_INPUT }), null));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(metered(events)).toBeUndefined();
    expect(failed(events)).toMatchObject({ kind: 'transient' });
  });
});

// ---------------------------------------------------------------------------
// #2 L10a — local tools: wire shape + the single tool round-trip.
// ---------------------------------------------------------------------------

describe('ollamaAdapter — local tools (#2 L10a)', () => {
  const ADDER = {
    name: 'adder',
    description: 'Adds two numbers.',
    parameters: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
    },
    expression: '${add(tool.args.a, tool.args.b)}',
  };

  const TOOL_CALL_BODY = {
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'adder', arguments: { a: 1, b: 2 } } }],
    },
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 7,
    eval_count: 3,
  };

  function toolCtx(over: Record<string, unknown> = {}): ActivityContext {
    return ctx({ input: { prompt: 'add 1 and 2', model: 'llama3', tools: [ADDER], ...over } });
  }

  function requestBody(spy: ReturnType<typeof vi.spyOn>, call: number): Record<string, unknown> {
    return JSON.parse(
      ((spy as unknown as { mock: { calls: unknown[][] } }).mock.calls[call]![1] as RequestInit)
        .body as string,
    ) as Record<string, unknown>;
  }

  it('sends function-wrapped tools; no tool_choice (Ollama has no forced-choice surface)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    // `required` is best-effort on this provider — tools are sent, the model decides.
    await drain(ollamaAdapter.runActivity(toolCtx({ toolChoice: 'required' }), null));
    const body = requestBody(fetchSpy, 0);
    expect(body).not.toHaveProperty('tool_choice');
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'adder',
          description: 'Adds two numbers.',
          parameters: {
            type: 'object',
            properties: { a: { type: 'number' }, b: { type: 'number' } },
            required: ['a', 'b'],
            additionalProperties: false,
          },
        },
      },
    ]);
  });

  it('drives one round-trip: object arguments, no call ids, role:tool results', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(fakeResponse(200, TOOL_CALL_BODY))
      .mockResolvedValueOnce(fakeResponse(200, OK_BODY));
    const events = await drain(ollamaAdapter.runActivity(toolCtx(), null));
    expect(events.map((e) => e.type)).toEqual([
      'metered',
      'captured',
      'toolCalled',
      'metered',
      'succeeded',
    ]);
    const second = requestBody(fetchSpy, 1);
    const msgs = second.messages as Record<string, unknown>[];
    expect(msgs[msgs.length - 2]).toEqual(TOOL_CALL_BODY.message);
    expect(msgs[msgs.length - 1]).toEqual({ role: 'tool', content: '3' });
  });

  it('fails permanent on a second tool round-trip request', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(fakeResponse(200, TOOL_CALL_BODY))
      .mockResolvedValueOnce(fakeResponse(200, TOOL_CALL_BODY));
    const events = await drain(ollamaAdapter.runActivity(toolCtx(), null));
    const last = events[events.length - 1]!;
    expect(last).toMatchObject({ type: 'failed', kind: 'permanent' });
    if (last.type === 'failed') expect(last.error).toMatch(/tool budget/);
  });

  it("omits tools under toolChoice 'none'", async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    await drain(ollamaAdapter.runActivity(toolCtx({ toolChoice: 'none' }), null));
    expect(requestBody(fetchSpy, 0)).not.toHaveProperty('tools');
  });
});
