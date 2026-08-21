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
  it('names WHY a connection config was refused, in one line (#1175)', async () => {
    // This site used to yield a bare `invalid openai_api connection config` with no
    // reason at all — the opposite failure to the JSON blob, and in the same
    // function as one. Refused BEFORE the request, so this stays egress-free;
    // and the secret is in hand at the refusal, so assert it is not echoed.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const events = await drain(
      openaiAdapter.runActivity(ctx({ connectionConfig: { timeoutMs: 'soon' } }), 'sk-oai'),
    );
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    const error = (events[0] as { error: string }).error;
    expect(error).toMatch(/^invalid openai_api connection config: [^\n]+$/);
    expect(error).toContain('timeoutMs: ');
    expect(error).not.toContain('sk-oai');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

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
    // #2 L9a — a capture (completion ABSENT) precedes the terminal failure.
    expect(events.map((e) => e.type)).toEqual(['captured', 'failed']);
    expect(failed(events)).toEqual({
      type: 'failed',
      kind: 'permanent',
      error: `openai_api returned a 2xx response with no completion (${reason})`,
      spendFact: { provider: 'openai_api', model: 'gpt-4o', meteringStatus: 'unknown' },
    });
    expect(captured(events).capture.completion).toBeUndefined();
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
    expect(failed(events)).toMatchObject({ type: 'failed', kind: 'rate_limit' });
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
    expect(events.map((e) => e.type)).toEqual(['metered', 'captured', 'succeeded']);
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

  it('fails permanent (metering BOTH repair calls) on a persistently out-of-enum value (#592)', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(fakeResponse(200, jsonResponse({ category: 'question' })));
    const events = await drain(openaiAdapter.runActivity(ctx({ input: STRUCTURED_INPUT }), 'sk'));
    expect(spy).toHaveBeenCalledTimes(2); // #2 L4c — one internal repair
    expect(events.filter((e) => e.type === 'metered')).toHaveLength(2);
    expect(failed(events)).toMatchObject({ kind: 'permanent' });
    expect(failed(events).error).toContain('enum');
  });

  it('fails permanent (metering both calls) when the completion is never valid JSON', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(200, {
        choices: [{ message: { content: 'sorry, not json' } }],
        usage: {},
      }),
    );
    const events = await drain(openaiAdapter.runActivity(ctx({ input: STRUCTURED_INPUT }), 'sk'));
    expect(spy).toHaveBeenCalledTimes(2);
    expect(failed(events)).toMatchObject({ kind: 'permanent' });
    expect(failed(events).error).toContain('JSON');
  });

  it('#2 L4c — an empty `choices` (no completion) now ROUTES THROUGH repair, then succeeds', async () => {
    // Pre-L4c an empty `choices` was an immediate `noCompletionFailure` (#461); a
    // structured call now feeds it through the repair loop (an absent completion is
    // just an invalid structured payload), so a corrected retry can still succeed.
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(fakeResponse(200, { choices: [], usage: {} })) // no completion
      .mockResolvedValueOnce(fakeResponse(200, jsonResponse({ category: 'bug' }))); // corrected
    const events = await drain(openaiAdapter.runActivity(ctx({ input: STRUCTURED_INPUT }), 'sk'));
    expect(spy).toHaveBeenCalledTimes(2);
    expect(events.filter((e) => e.type === 'metered')).toHaveLength(2);
    expect(succeeded(events).outputs).toEqual({ category: 'bug' });
  });

  it('#2 L4c — repairs an invalid FIRST completion then succeeds (two metered)', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(fakeResponse(200, jsonResponse({ category: 'question' }))) // out-of-enum
      .mockResolvedValueOnce(fakeResponse(200, jsonResponse({ category: 'feature' }))); // corrected
    const events = await drain(openaiAdapter.runActivity(ctx({ input: STRUCTURED_INPUT }), 'sk'));
    expect(spy).toHaveBeenCalledTimes(2);
    expect(events.filter((e) => e.type === 'metered')).toHaveLength(2);
    expect(succeeded(events).outputs).toEqual({ category: 'feature' });
    // the repair request keeps the JSON system directive AND carries the critique.
    const secondBody = JSON.parse((spy.mock.calls[1]![1] as RequestInit).body as string);
    const msgs = secondBody.messages as { role: string; content: string }[];
    expect(secondBody.response_format).toEqual({ type: 'json_object' });
    expect(msgs.find((m) => m.role === 'system')?.content).toContain('JSON');
    expect(msgs.some((m) => m.role === 'user' && m.content.includes('enum'))).toBe(true);
  });

  it('#2 L4c — does NOT repair a transport failure (one call, no metered)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(503, 'overloaded'));
    const events = await drain(openaiAdapter.runActivity(ctx({ input: STRUCTURED_INPUT }), 'sk'));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(metered(events)).toBeUndefined();
    expect(failed(events)).toMatchObject({ kind: 'transient' });
  });
});

// ---------------------------------------------------------------------------
// #2 L10a — local tools: wire shape + the single tool round-trip.
// ---------------------------------------------------------------------------

describe('openaiAdapter — local tools (#2 L10a)', () => {
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
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'adder', arguments: '{"a":1,"b":2}' },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 9, completion_tokens: 5 },
  };

  function toolCtx(over: Record<string, unknown> = {}): ActivityContext {
    return ctx({ input: { prompt: 'add 1 and 2', model: 'gpt-4o', tools: [ADDER], ...over } });
  }

  function requestBody(spy: ReturnType<typeof vi.spyOn>, call: number): Record<string, unknown> {
    return JSON.parse(
      ((spy as unknown as { mock: { calls: unknown[][] } }).mock.calls[call]![1] as RequestInit)
        .body as string,
    ) as Record<string, unknown>;
  }

  it('sends function-wrapped tools with the explicit-required schema, tool_choice auto', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    await drain(openaiAdapter.runActivity(toolCtx(), 'sk'));
    const body = requestBody(fetchSpy, 0);
    expect(body.tool_choice).toBe('auto');
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

  it("maps toolChoice 'required' and downgrades the continuation to 'auto'", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(fakeResponse(200, TOOL_CALL_BODY))
      .mockResolvedValueOnce(fakeResponse(200, OK_BODY));
    const events = await drain(
      openaiAdapter.runActivity(toolCtx({ toolChoice: 'required' }), 'sk'),
    );
    expect(events[events.length - 1]!.type).toBe('succeeded');
    expect(requestBody(fetchSpy, 0).tool_choice).toBe('required');
    expect(requestBody(fetchSpy, 1).tool_choice).toBe('auto');
  });

  it('drives one round-trip: continuation carries the raw assistant message + tool results', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(fakeResponse(200, TOOL_CALL_BODY))
      .mockResolvedValueOnce(fakeResponse(200, OK_BODY));
    const events = await drain(openaiAdapter.runActivity(toolCtx(), 'sk'));
    expect(events.map((e) => e.type)).toEqual([
      'metered',
      'captured',
      'toolCalled',
      'metered',
      'succeeded',
    ]);
    expect(succeeded(events).outputs).toEqual({ text: 'the answer', stopReason: 'stop' });
    const second = requestBody(fetchSpy, 1);
    const msgs = second.messages as Record<string, unknown>[];
    expect(msgs[msgs.length - 2]).toEqual(TOOL_CALL_BODY.choices[0]!.message);
    expect(msgs[msgs.length - 1]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: '3',
    });
  });

  it('a tool-calls-only response (content null) is the tool flow, not a no-completion', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(fakeResponse(200, TOOL_CALL_BODY))
      .mockResolvedValueOnce(fakeResponse(200, OK_BODY));
    const events = await drain(openaiAdapter.runActivity(toolCtx(), 'sk'));
    expect(events.every((e) => e.type !== 'failed')).toBe(true);
  });

  it('feeds unparseable arguments back as an error tool result', async () => {
    const badArgs = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'adder', arguments: '{oops' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    };
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(fakeResponse(200, badArgs))
      .mockResolvedValueOnce(fakeResponse(200, OK_BODY));
    const events = await drain(openaiAdapter.runActivity(toolCtx(), 'sk'));
    expect(events[events.length - 1]!.type).toBe('succeeded');
    const second = requestBody(fetchSpy, 1);
    const msgs = second.messages as Record<string, unknown>[];
    const toolMsg = msgs[msgs.length - 1] as { role: string; content: string };
    expect(toolMsg.role).toBe('tool');
    expect(toolMsg.content).toMatch(/invalid arguments for tool 'adder'/);
  });

  it('fails permanent (loud, local) on a tool call without a string id', async () => {
    const noId = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ type: 'function', function: { name: 'adder', arguments: '{}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, noId));
    const events = await drain(openaiAdapter.runActivity(toolCtx(), 'sk'));
    const last = events[events.length - 1]!;
    expect(last).toMatchObject({ type: 'failed', kind: 'permanent' });
    if (last.type === 'failed') expect(last.error).toMatch(/without a string id/);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // failed locally, no continuation
  });

  it('fails permanent on a second tool round-trip request', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(fakeResponse(200, TOOL_CALL_BODY))
      .mockResolvedValueOnce(fakeResponse(200, TOOL_CALL_BODY));
    const events = await drain(openaiAdapter.runActivity(toolCtx(), 'sk'));
    const last = events[events.length - 1]!;
    expect(last).toMatchObject({ type: 'failed', kind: 'permanent' });
    if (last.type === 'failed') expect(last.error).toMatch(/tool budget/);
  });

  it("omits tools under toolChoice 'none' and when the node declares none", async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    await drain(openaiAdapter.runActivity(toolCtx({ toolChoice: 'none' }), 'sk'));
    await drain(openaiAdapter.runActivity(ctx(), 'sk'));
    expect(requestBody(fetchSpy, 0)).not.toHaveProperty('tools');
    expect(requestBody(fetchSpy, 0)).not.toHaveProperty('tool_choice');
    expect(requestBody(fetchSpy, 1)).not.toHaveProperty('tools');
  });
});

/**
 * #730 — the sampling-parameter preflight, the `openai_api` half of the defect
 * class #727 fixed for `anthropic_api`.
 *
 * OpenAI's reasoning models reject `temperature`/`top_p` with a 400 whose body
 * does not name which of the author's fields was at fault. These tests assert
 * the refusal happens BEFORE `fetch`, which is the whole point: the diagnosis
 * has to come from us, because the provider's does not identify the field.
 */
describe('openaiAdapter unsupported-parameter preflight (#730)', () => {
  it('refuses permanent, without issuing a request, when a reasoning model gets temperature', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    const events = await drain(
      openaiAdapter.runActivity(
        ctx({ input: { prompt: 'p', model: 'o3', temperature: 0.3 } }),
        'sk',
      ),
    );
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    // The message names the model AND the author-facing field, which is exactly
    // what the provider's own 400 leaves out.
    const failure = events[0] as Extract<ActivityEvent, { type: 'failed' }>;
    expect(failure.error).toContain('o3');
    expect(failure.error).toContain('temperature');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('covers the STRUCTURED path too — the preflight precedes the branch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    const events = await drain(
      openaiAdapter.runActivity(
        ctx({
          input: {
            prompt: 'p',
            model: 'gpt-5',
            topP: 0.9,
            structuredOutput: { type: 'object', properties: { a: { type: 'string' } } },
          },
        }),
        'sk',
      ),
    );
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // #752 — the reasoning-effort half of the same preflight. `o1-mini` is the one
  // reasoning model that accepts NO `reasoning_effort`, so the key was a
  // guaranteed 400 that only the author's opt-in reached.
  it('refuses reasoningEffort on o1-mini instead of sending a guaranteed 400', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    const events = await drain(
      openaiAdapter.runActivity(
        ctx({ input: { prompt: 'p', model: 'o1-mini', reasoningEffort: 'low' } }),
        'sk',
      ),
    );
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    const failure = events[0] as Extract<ActivityEvent, { type: 'failed' }>;
    expect(failure.error).toContain('o1-mini');
    expect(failure.error).toContain('reasoningEffort');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('renders BOTH remedies when o1-mini is asked for temperature AND reasoningEffort', async () => {
    // The first genuinely reachable two-cause message in either provider
    // module: `o1-mini` is in both OpenAI capability sets, so the author is told
    // to pick an OLDER model for the sampling knob and a NEWER one for the
    // reasoning knob, in two cause-grouped sentences. Both remedies are
    // individually correct. Pinned at the RENDERED level, because the sets
    // being non-disjoint is what makes the message builder's n-safe join
    // load-bearing rather than hypothetical.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    const events = await drain(
      openaiAdapter.runActivity(
        ctx({
          input: { prompt: 'p', model: 'o1-mini', temperature: 0.3, reasoningEffort: 'low' },
        }),
        'sk',
      ),
    );
    const failure = events[0] as Extract<ActivityEvent, { type: 'failed' }>;
    expect(failure).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect(failure.error).toContain('select a model that still accepts');
    expect(failure.error).toContain('select a newer model that supports');
    expect(failure.error).toContain('temperature');
    expect(failure.error).toContain('reasoningEffort');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still SENDS reasoningEffort to a gateway serving the same id — these are facts about OpenAI', async () => {
    // The first-party gate the sibling facts already carry. An
    // OpenAI-COMPATIBLE server reusing the name `o1-mini` is someone else's
    // request surface, and refusing there is the manufactured refusal the
    // module's fail-direction rule forbids.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    const events = await drain(
      openaiAdapter.runActivity(
        ctx({
          input: { prompt: 'p', model: 'o1-mini', reasoningEffort: 'low' },
          connectionConfig: { baseUrl: 'https://api.groq.com/openai/v1' },
        }),
        'sk',
      ),
    );
    expect(events[0]).not.toMatchObject({ type: 'failed' });
    expect(
      JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string).reasoning_effort,
    ).toBe('low');
  });

  it('does NOT refuse reasoningEffort on a reasoning model that accepts it', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    await drain(
      openaiAdapter.runActivity(
        ctx({ input: { prompt: 'p', model: 'o4-mini', reasoningEffort: 'high' } }),
        'sk',
      ),
    );
    expect(
      JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string).reasoning_effort,
    ).toBe('high');
  });

  it('resolves the model from the CONNECTION default, which node config cannot see', async () => {
    // The case that cannot be caught by author-time Zod validation: the node
    // sets only `temperature`, and the rejecting model arrives from the
    // connection.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    const events = await drain(
      openaiAdapter.runActivity(
        ctx({
          input: { prompt: 'p', temperature: 0.3 },
          connectionConfig: { model: 'o4-mini' },
        }),
        'sk',
      ),
    );
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does NOT refuse when the author set no sampling params', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    const events = await drain(
      openaiAdapter.runActivity(ctx({ input: { prompt: 'p', model: 'o3' } }), 'sk'),
    );
    expect(succeeded(events)).toMatchObject({ type: 'succeeded' });
  });

  it('does NOT refuse a non-reasoning model that accepts sampling', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    const events = await drain(
      openaiAdapter.runActivity(
        ctx({ input: { prompt: 'p', model: 'gpt-4o', temperature: 0.3 } }),
        'sk',
      ),
    );
    expect(succeeded(events)).toMatchObject({ type: 'succeeded' });
    expect(JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string).temperature).toBe(
      0.3,
    );
  });

  it('does NOT refuse an OpenAI-COMPATIBLE gateway serving the same model name', async () => {
    // The inverted-proxy case. These gateways deliberately reuse OpenAI's model
    // ids while deciding their own request surface, so a fact about
    // api.openai.com is not a fact about them — refusing would manufacture a
    // local failure of a call that works. The request goes out unchanged.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    const events = await drain(
      openaiAdapter.runActivity(
        ctx({
          input: { prompt: 'p', model: 'o3', temperature: 0.3 },
          connectionConfig: { baseUrl: 'https://openrouter.ai/api/v1' },
        }),
        'sk',
      ),
    );
    expect(succeeded(events)).toMatchObject({ type: 'succeeded' });
    expect(JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string).temperature).toBe(
      0.3,
    );
  });

  it('still refuses when the connection pins the DEFAULT base url explicitly', async () => {
    // A trailing slash is normalised away before the gate sees it, so an
    // explicitly-configured default host is still first-party.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    const events = await drain(
      openaiAdapter.runActivity(
        ctx({
          input: { prompt: 'p', model: 'o3', temperature: 0.3 },
          connectionConfig: { baseUrl: 'https://api.openai.com/v1/' },
        }),
        'sk',
      ),
    );
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/**
 * #739 — the wire-field RENAME half of the #730 defect. `buildBody` emitted
 * `max_tokens` unconditionally, which reasoning models reject outright; the
 * Chat Completions field for that class is `max_completion_tokens`.
 *
 * These are the only wire-level assertions on `maxTokens` for this adapter —
 * before #739 the field had no dispatch coverage at all, which is why the defect
 * survived #730's own sweep of the same source.
 */
describe('openaiAdapter maxTokens wire field (#739)', () => {
  async function bodyFor(input: Record<string, unknown>, connectionConfig = {}) {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    await drain(openaiAdapter.runActivity(ctx({ input, connectionConfig }), 'sk'));
    return JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
  }

  it('sends max_completion_tokens (and NOT max_tokens) on a first-party reasoning model', async () => {
    const body = await bodyFor({ prompt: 'p', model: 'o3', maxTokens: 256 });
    expect(body.max_completion_tokens).toBe(256);
    // The absence assertion is the load-bearing half: sending BOTH still 400s,
    // because `max_tokens` is itself unsupported on this class.
    expect(body).not.toHaveProperty('max_tokens');
  });

  it('still sends max_tokens on a first-party NON-reasoning model', async () => {
    const body = await bodyFor({ prompt: 'p', model: 'gpt-4o', maxTokens: 256 });
    expect(body.max_tokens).toBe(256);
    expect(body).not.toHaveProperty('max_completion_tokens');
  });

  it('leaves max_tokens ALONE on an OpenAI-compatible gateway, even for a reasoning id', async () => {
    // The ticket's open question, answered. `max_completion_tokens` is newer
    // than many gateways (vLLM, LiteLLM, self-hosted proxies), and these are
    // facts about api.openai.com only — renaming on someone else's server would
    // manufacture a break in calls that work today. Same gate, same direction as
    // the #730 preflight.
    const body = await bodyFor(
      { prompt: 'p', model: 'o3', maxTokens: 256 },
      { baseUrl: 'https://openrouter.ai/api/v1' },
    );
    expect(body.max_tokens).toBe(256);
    expect(body).not.toHaveProperty('max_completion_tokens');
  });

  it('emits neither key when the author set no maxTokens', async () => {
    const body = await bodyFor({ prompt: 'p', model: 'o3' });
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('max_completion_tokens');
  });

  // One body builder feeds all three dispatch paths (#648), but that is an
  // implementation fact, so each path is pinned separately — a future split
  // cannot then silently regress one of them.
  //
  // The first draft of these two tests was VACUOUS and both pre-PR review lenses
  // caught it independently: it passed `structuredOutput`, which is the INTERNAL
  // name `normalizeLlmRequest` produces, not an author input. `llmCallConfigSchema`
  // is a non-strict `z.object`, so the unknown key was silently stripped and the
  // "structured" case was a second copy of the text case. Both tests below now
  // assert a path MARKER (`response_format` / `tools`) alongside the field name,
  // so a request that quietly fell back to the text path fails here rather than
  // passing under a misleading title.
  it('renames on the STRUCTURED path (#2 L4b)', async () => {
    const body = await bodyFor({
      prompt: 'classify this ticket',
      model: 'o3',
      maxTokens: 256,
      outputMode: 'structured',
      outputSchema: {
        type: 'object',
        properties: { category: { type: 'string', enum: ['bug', 'feature'] } },
      },
    });
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.max_completion_tokens).toBe(256);
    expect(body).not.toHaveProperty('max_tokens');
  });

  it('renames on the TOOLS path (#2 L10a)', async () => {
    const body = await bodyFor({
      prompt: 'add 1 and 2',
      model: 'o3',
      maxTokens: 256,
      tools: [
        {
          name: 'adder',
          description: 'Adds two numbers.',
          parameters: {
            type: 'object',
            properties: { a: { type: 'number' }, b: { type: 'number' } },
          },
          // L10a tools are PURE local expressions; omitting this fails config
          // validation before dispatch, which is how the first draft of this
          // test surfaced its own malformed fixture rather than passing blind.
          expression: '${add(tool.args.a, tool.args.b)}',
        },
      ],
    });
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.max_completion_tokens).toBe(256);
    expect(body).not.toHaveProperty('max_tokens');
  });
});

// #725 — the timeout door. `openai.test.ts` had NO timeout coverage at all before
// this ticket. It bounds a hung provider AND pins that the abort is deliberately
// not counted as billed spend (see `llmPost`: a timeout cannot distinguish a long
// generation from a dropped SYN, so marking it would invent a cost gap).
describe('openaiAdapter timeout → NO spend fact (#725)', () => {
  it('bounds a hung provider and records NO spend fact (a timeout cannot prove billing)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          (init as RequestInit).signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
    );
    const events = await drain(
      openaiAdapter.runActivity(ctx({ connectionConfig: { timeoutMs: 10 } }), 'sk'),
    );
    expect(failed(events)).toMatchObject({ type: 'failed', kind: 'transient' });
    // #725 — a timeout is deliberately UNMARKED: it cannot tell a >120s generation
    // from a dropped SYN. See `llmPost` for the measurement.
    expect(failed(events).spendFact).toBeUndefined();
  });

  it('does NOT record a spend fact for a 401 (nothing was generated)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(401, { error: 'nope' }));
    const events = await drain(openaiAdapter.runActivity(ctx(), 'sk'));
    expect(failed(events).spendFact).toBeUndefined();
  });
});
