import { afterEach, describe, expect, it, vi } from 'vitest';
import { anthropicAdapter } from '../anthropic.js';
import type { ActivityContext, ActivityEvent } from '../types.js';
import { sha256Hex } from '../../util/hash.js';

function captured(events: ActivityEvent[]): Extract<ActivityEvent, { type: 'captured' }> {
  const ev = events.find(
    (e): e is Extract<ActivityEvent, { type: 'captured' }> => e.type === 'captured',
  );
  if (ev === undefined) throw new Error(`no captured event in ${JSON.stringify(events)}`);
  return ev;
}

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
    input: over.input ?? { prompt: 'hello there' },
    connectionConfig: over.connectionConfig ?? {},
    signal: over.signal ?? new AbortController().signal,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

function fakeResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return {
    status,
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    headers: new Headers(headers),
  } as unknown as Response;
}

const OK_BODY = {
  content: [
    { type: 'text', text: 'Hi ' },
    { type: 'text', text: 'there!' },
  ],
  stop_reason: 'end_turn',
  usage: { input_tokens: 5, output_tokens: 7 },
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
    expect(succeeded(events)).toMatchObject({
      type: 'succeeded',
      outputs: { stopReason: 'unknown' },
    });
    expect(typeof succeeded(events).outputs.stopReason).toBe('string');
  });

  // #461 — a 2xx with NO readable completion (absent/non-array `content`, or a
  // content array with zero text-type blocks) is a permanent failure, not
  // `succeeded{text:''}`. A tool_use-only response is text-mode-empty and fails
  // here because tools are not wired yet (revisit at L4b/L10).
  //
  // #556 — the failure carries a DIAGNOSTIC sub-reason (retry class stays
  // `permanent` for all): a missing/wrong-type container is `absent_content`; a
  // present container with no text candidate is `empty_completion_set`; a corrupt
  // `type:'text'` block is `malformed_block`.
  it.each([
    ['no content field', {}, 'absent_content'],
    ['a non-array content', { content: 'hi' }, 'absent_content'],
    ['an empty content array', { content: [] }, 'empty_completion_set'],
    [
      'only non-text blocks',
      { content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }] },
      'empty_completion_set',
    ],
    // A text-type block whose `text` is not a string is malformed, not a present
    // completion — it must route through the same absent-vs-present scrutiny.
    [
      'a text block with a non-string text',
      { content: [{ type: 'text', text: 42 }] },
      'malformed_block',
    ],
  ])('fails permanent (%s → %s) when the 2xx body carries it', async (_label, body, reason) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, body));
    const events = await drain(anthropicAdapter.runActivity(ctx(), 'sk-ant-key'));
    // #2 L9a — a capture (completion ABSENT) precedes the terminal failure.
    expect(events.map((e) => e.type)).toEqual(['captured', 'failed']);
    expect(failed(events)).toEqual({
      type: 'failed',
      kind: 'permanent',
      error: `anthropic_api returned a 2xx response with no completion (${reason})`,
    });
    expect(captured(events).capture.completion).toBeUndefined();
  });

  // #556 — a mix of a VALID text block and a malformed one still SUCCEEDS on the
  // valid text (the sub-reason scrutiny only runs when there is zero valid text).
  it('succeeds on a valid text block even alongside a malformed one', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(200, {
        content: [
          { type: 'text', text: 'hi' },
          { type: 'text', text: 42 },
        ],
        stop_reason: 'end_turn',
      }),
    );
    const events = await drain(anthropicAdapter.runActivity(ctx(), 'sk-ant-key'));
    expect(succeeded(events)).toEqual({
      type: 'succeeded',
      outputs: { text: 'hi', stopReason: 'end_turn' },
    });
  });

  // The complement: a present text block (even an empty string) is a real result.
  it('succeeds with a present-but-empty text block', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(200, { content: [{ type: 'text', text: '' }], stop_reason: 'end_turn' }),
    );
    const events = await drain(anthropicAdapter.runActivity(ctx(), 'sk-ant-key'));
    expect(succeeded(events)).toEqual({
      type: 'succeeded',
      outputs: { text: '', stopReason: 'end_turn' },
    });
  });

  it('POSTs the Messages API and surfaces concatenated text + stopReason', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));

    const events = await drain(anthropicAdapter.runActivity(ctx(), 'sk-ant-key'));

    expect(succeeded(events)).toEqual({
      type: 'succeeded',
      outputs: { text: 'Hi there!', stopReason: 'end_turn' },
    });
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

  // #2 L3 — reasoningEffort engages the modern Anthropic reasoning surface:
  // adaptive thinking + output_config.effort (NOT the deprecated budget_tokens,
  // which 400s on every current model incl. the claude-opus-4-8 default).
  it('maps reasoningEffort to adaptive thinking + output_config.effort', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    await drain(
      anthropicAdapter.runActivity(ctx({ input: { prompt: 'p', reasoningEffort: 'high' } }), 'sk'),
    );
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort: 'high' });
  });

  // `max` is a valid Anthropic `output_config.effort` level (no clamp, unlike
  // OpenAI) — pin the verbatim passthrough of the strongest rung.
  it('passes reasoningEffort `max` to output_config.effort verbatim (no clamp)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    await drain(
      anthropicAdapter.runActivity(ctx({ input: { prompt: 'p', reasoningEffort: 'max' } }), 'sk'),
    );
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.output_config).toEqual({ effort: 'max' });
  });

  it('sends NO thinking / output_config when reasoningEffort is unset (byte-compat with pre-L3)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    await drain(anthropicAdapter.runActivity(ctx({ input: { prompt: 'p' } }), 'sk'));
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();
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
      expect(failed(events)).toMatchObject({ type: 'failed', kind });
      vi.restoreAllMocks();
    }
  });

  // #2 L7 — a 429 (or 5xx) carrying a `Retry-After` header surfaces the
  // provider-instructed backoff on the failure event; a permanent failure never
  // does (it will not retry, so the hint is meaningless).
  it('carries the Retry-After hint on a retryable failure but not a permanent one', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(429, { error: { message: 'slow down' } }, { 'retry-after': '42' }),
    );
    const rl = await drain(anthropicAdapter.runActivity(ctx(), 'sk'));
    expect(failed(rl)).toMatchObject({ type: 'failed', kind: 'rate_limit', retryAfterSeconds: 42 });
    vi.restoreAllMocks();

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(400, { error: { message: 'bad' } }, { 'retry-after': '42' }),
    );
    const perm = await drain(anthropicAdapter.runActivity(ctx(), 'sk'));
    expect(failed(perm)).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect(failed(perm)).not.toHaveProperty('retryAfterSeconds');
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
    expect(failed(events)).toMatchObject({ type: 'failed', kind: 'cancelled' });
  });

  it('maps a malformed 2xx JSON body to a permanent failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, 'not json{'));
    const events = await drain(anthropicAdapter.runActivity(ctx(), 'sk'));
    expect(failed(events)).toMatchObject({ type: 'failed', kind: 'permanent' });
  });

  it('REDACTS the secret when a header-validation TypeError quotes it verbatim', async () => {
    // A secret with an embedded CR makes an invalid header value; Node quotes it
    // verbatim in the TypeError message. That message must never carry the key.
    const secret = 'sk-realkey-9999\rINJECT';
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError(`Headers.append: "${secret}" is an invalid header value.`),
    );
    const events = await drain(anthropicAdapter.runActivity(ctx(), secret));
    expect(failed(events)).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect(JSON.stringify(events)).not.toContain('sk-realkey-9999');
    expect(JSON.stringify(events)).toContain('***');
  });

  it('maps a bad-URL TypeError to a permanent failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Invalid URL'));
    const events = await drain(anthropicAdapter.runActivity(ctx(), 'sk'));
    expect(failed(events)).toMatchObject({
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
    expect(failed(events)).toMatchObject({ type: 'failed', kind: 'transient' });
    expect(JSON.stringify(events)).toContain('timed out');
  });
});

// #2 L1 — config v2: role `messages[]`, sampling, `${}`-in-content (upstream),
// with the Messages API's `system` as a TOP-LEVEL param.
describe('anthropicAdapter v2 config (L1)', () => {
  it('sends role-tagged messages and folds system to the top-level param', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    await drain(
      anthropicAdapter.runActivity(
        ctx({
          input: {
            messages: [
              { role: 'user', content: 'u1' },
              { role: 'system', content: 'mid-system' },
              { role: 'assistant', content: 'a1' },
            ],
            system: 'top-system',
          },
        }),
        'sk',
      ),
    );
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    // Non-system turns keep order; system folds to the top-level param.
    expect(body.messages).toEqual([
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
    ]);
    expect(body.system).toBe('top-system\n\nmid-system');
  });

  it('maps sampling to Anthropic names (top_p, stop_sequences) and DROPS seed', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    await drain(
      anthropicAdapter.runActivity(
        ctx({ input: { prompt: 'p', topP: 0.9, stop: ['STOP'], seed: 7, temperature: 0.3 } }),
        'sk',
      ),
    );
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.top_p).toBe(0.9);
    expect(body.stop_sequences).toEqual(['STOP']);
    expect(body.temperature).toBe(0.3);
    expect(body).not.toHaveProperty('seed'); // Anthropic has no seed param.
    expect(body).not.toHaveProperty('stop');
  });

  it('validates against the whole node.config — the seeded `outputs` key passes (non-strict)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    const events = await drain(
      anthropicAdapter.runActivity(
        ctx({ input: { prompt: 'p', outputs: [{ key: 'text', type: 'string' }] } }),
        'sk',
      ),
    );
    expect(succeeded(events)).toMatchObject({ type: 'succeeded' });
  });

  it('fails permanent when the config sets both prompt and messages', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    const events = await drain(
      anthropicAdapter.runActivity(
        ctx({ input: { prompt: 'p', messages: [{ role: 'user', content: 'x' }] } }),
        'sk',
      ),
    );
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// #2 L2 — usage capture. The adapter yields a `metered` event carrying the
// provider token counts BEFORE the terminal `succeeded`; the executor turns it
// into a durable `activity.metered` engine event the L6 cost projection sums.
describe('anthropicAdapter usage capture (L2)', () => {
  it('yields a metered event with the token counts, ordered before succeeded', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    const events = await drain(anthropicAdapter.runActivity(ctx(), 'sk'));
    // Order: metered then the #2 L9a capture precede the terminal succeeded.
    expect(events.map((e) => e.type)).toEqual(['metered', 'captured', 'succeeded']);
    expect(metered(events)).toEqual({
      type: 'metered',
      usage: {
        provider: 'anthropic_api',
        model: 'claude-opus-4-8',
        inputTokens: 5,
        outputTokens: 7,
        meteringStatus: 'metered',
      },
    });
  });

  it('reports meteringStatus unknown with NO token fields when usage is absent', async () => {
    // OK response shape but no `usage` object at all (some gateways omit it).
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(200, { content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn' }),
    );
    const events = await drain(anthropicAdapter.runActivity(ctx(), 'sk'));
    expect(metered(events)?.usage).toEqual({
      provider: 'anthropic_api',
      model: 'claude-opus-4-8',
      meteringStatus: 'unknown',
    });
    // The terminal event still lands — an unmetered response is NOT a failure.
    expect(succeeded(events)).toMatchObject({ type: 'succeeded' });
  });

  it('keeps the present count when only one token field is valid (partial → unknown)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(200, {
        content: [{ type: 'text', text: 'x' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 9, output_tokens: -1 },
      }),
    );
    const events = await drain(anthropicAdapter.runActivity(ctx(), 'sk'));
    // The valid input count is stamped; the invalid negative output is dropped;
    // the pair is incomplete so meteringStatus is unknown.
    expect(metered(events)?.usage).toEqual({
      provider: 'anthropic_api',
      model: 'claude-opus-4-8',
      inputTokens: 9,
      meteringStatus: 'unknown',
    });
  });

  it('records the resolved (node-override) model on the metered event', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    const events = await drain(
      anthropicAdapter.runActivity(
        ctx({ input: { prompt: 'p', model: 'claude-haiku-4-5' } }),
        'sk',
      ),
    );
    expect(metered(events)?.usage.model).toBe('claude-haiku-4-5');
  });

  it('yields NO metered event on a failure (non-2xx produced no billed response)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(500, 'overloaded'));
    const events = await drain(anthropicAdapter.runActivity(ctx(), 'sk'));
    expect(metered(events)).toBeUndefined();
    expect(failed(events)).toMatchObject({ type: 'failed' });
  });
});

function failed(events: ActivityEvent[]): Extract<ActivityEvent, { type: 'failed' }> {
  const ev = events.find((e) => e.type === 'failed');
  if (ev === undefined) throw new Error(`no failed event in ${JSON.stringify(events)}`);
  return ev;
}

function sentBody(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  return JSON.parse((spy.mock.calls[0]![1] as RequestInit).body as string) as Record<
    string,
    unknown
  >;
}

const STRUCTURED_INPUT = {
  prompt: 'classify this ticket',
  outputMode: 'structured',
  outputSchema: {
    type: 'object',
    properties: { category: { type: 'string', enum: ['bug', 'feature'] } },
  },
};

/** A Messages API response that answered via the forced `structured_output` tool. */
function toolResponse(input: unknown): unknown {
  return {
    content: [{ type: 'tool_use', name: 'structured_output', input }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 4, output_tokens: 6 },
  };
}

describe('anthropicAdapter.runActivity — structured output (#2 L4b)', () => {
  it('forces the structured_output tool and omits the reasoning surface', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(fakeResponse(200, toolResponse({ category: 'bug' })));
    await drain(
      anthropicAdapter.runActivity(
        ctx({ input: { ...STRUCTURED_INPUT, reasoningEffort: 'high' } }),
        'sk',
      ),
    );
    const body = sentBody(spy);
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'structured_output' });
    expect((body.tools as { name: string; input_schema: unknown }[])[0]).toMatchObject({
      name: 'structured_output',
      input_schema: STRUCTURED_INPUT.outputSchema,
    });
    // forced tool_choice precludes adaptive thinking → reasoning keys are dropped.
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();
  });

  it('meters then succeeds with the validated object (only schema fields)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(200, toolResponse({ category: 'feature', extra: 'stripped' })),
    );
    const events = await drain(
      anthropicAdapter.runActivity(ctx({ input: STRUCTURED_INPUT }), 'sk'),
    );
    expect(metered(events)?.usage).toMatchObject({ inputTokens: 4, outputTokens: 6 });
    // unknown key stripped; no text/stopReason (not in the structured contract).
    expect(succeeded(events).outputs).toEqual({ category: 'feature' });
  });

  it('fails permanent (metering BOTH repair calls) on a persistently out-of-enum value (#592)', async () => {
    // #2 L4c — an out-of-enum value now triggers ONE internal repair; both the
    // original and the repair call bill, and only the exhausted loop terminalizes.
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(fakeResponse(200, toolResponse({ category: 'question' })));
    const events = await drain(
      anthropicAdapter.runActivity(ctx({ input: STRUCTURED_INPUT }), 'sk'),
    );
    expect(spy).toHaveBeenCalledTimes(2);
    expect(events.filter((e) => e.type === 'metered')).toHaveLength(2);
    expect(failed(events)).toMatchObject({ kind: 'permanent' });
    expect(failed(events).error).toContain('enum');
  });

  it('fails permanent (metering both calls) when no structured_output block is ever returned', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        fakeResponse(200, { content: [{ type: 'text', text: 'sorry' }], usage: {} }),
      );
    const events = await drain(
      anthropicAdapter.runActivity(ctx({ input: STRUCTURED_INPUT }), 'sk'),
    );
    // a missing forced-tool block is now repairable — still terminalizes once
    // repairs are exhausted, and every 2xx billed.
    expect(spy).toHaveBeenCalledTimes(2);
    expect(events.filter((e) => e.type === 'metered')).toHaveLength(2);
    expect(failed(events)).toMatchObject({ kind: 'permanent' });
    expect(failed(events).error).toContain('tool_use');
  });

  it('#2 L4c — repairs an invalid FIRST response then succeeds (two metered, valid output)', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(fakeResponse(200, toolResponse({ category: 'question' }))) // out-of-enum
      .mockResolvedValueOnce(fakeResponse(200, toolResponse({ category: 'bug' }))); // corrected
    const events = await drain(
      anthropicAdapter.runActivity(ctx({ input: STRUCTURED_INPUT }), 'sk'),
    );
    expect(spy).toHaveBeenCalledTimes(2);
    expect(events.filter((e) => e.type === 'metered')).toHaveLength(2);
    expect(succeeded(events).outputs).toEqual({ category: 'bug' });
    // the SECOND request carries the repair critique + prior echo, and its turns
    // still alternate (…user → assistant(echo) → user(critique)).
    const secondBody = JSON.parse((spy.mock.calls[1]![1] as RequestInit).body as string);
    const msgs = secondBody.messages as { role: string; content: string }[];
    expect(msgs).toHaveLength(3);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(msgs[2]!.content).toContain('enum');
    // the structured scaffold is rebuilt on the repair call, not dropped.
    expect(secondBody.tool_choice).toEqual({ type: 'tool', name: 'structured_output' });
  });

  it('#2 L4c — does NOT repair a transport failure; only ONE call, no metered', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(500, 'overloaded'));
    const events = await drain(
      anthropicAdapter.runActivity(ctx({ input: STRUCTURED_INPUT }), 'sk'),
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(metered(events)).toBeUndefined();
    expect(failed(events)).toMatchObject({ kind: 'transient' });
  });

  it('#2 L4c — a run cancelled between calls stops after ONE metered (no repair)', async () => {
    const controller = new AbortController();
    // First call: invalid response (would trigger a repair) AND cancel the run.
    // Second call: llmPost aborts its signal up-front, so fetch sees an aborted
    // signal and rejects — exactly as the real fetch does — → `cancelled` terminal.
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      if ((init as RequestInit).signal?.aborted) {
        return Promise.reject(new DOMException('aborted', 'AbortError'));
      }
      controller.abort();
      return Promise.resolve(fakeResponse(200, toolResponse({ category: 'question' })));
    });
    const events = await drain(
      anthropicAdapter.runActivity(
        ctx({ input: STRUCTURED_INPUT, signal: controller.signal }),
        'sk',
      ),
    );
    expect(events.filter((e) => e.type === 'metered')).toHaveLength(1);
    expect(failed(events)).toMatchObject({ kind: 'cancelled' });
  });
});

describe('anthropicAdapter — #2 L9a prompt/completion capture', () => {
  afterEach(() => vi.restoreAllMocks());

  it('emits a capture (shape + latency, NO raw text) after metered and before the terminal on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    const events = await drain(
      anthropicAdapter.runActivity(
        ctx({ input: { prompt: 'hello there', system: 'be brief' } }),
        'sk-ant-key',
      ),
    );
    const types = events.map((e) => e.type);
    // Ordering: metered → captured → succeeded (capture precedes the terminal).
    expect(types.indexOf('metered')).toBeLessThan(types.indexOf('captured'));
    expect(types.indexOf('captured')).toBeLessThan(types.indexOf('succeeded'));

    const { capture } = captured(events);
    expect(capture.provider).toBe('anthropic_api');
    expect(capture.model).toBe('claude-opus-4-8');
    expect(typeof capture.latencyMs).toBe('number');
    expect(capture.latencyMs).toBeGreaterThanOrEqual(0);
    expect(capture.request).toEqual({
      messageCount: 1,
      system: { chars: 8, contentHash: sha256Hex('be brief') },
      messages: [{ role: 'user', chars: 11, contentHash: sha256Hex('hello there') }],
    });
    expect(capture.completion).toEqual({ chars: 9, contentHash: sha256Hex('Hi there!') });
    // No raw prompt/completion text anywhere in the event.
    const blob = JSON.stringify(captured(events));
    for (const raw of ['hello there', 'be brief', 'Hi there!']) expect(blob).not.toContain(raw);
  });

  it('emits a capture with completion ABSENT before a non-2xx failure terminal (nothing metered)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(500, { error: { message: 'boom' } }),
    );
    const events = await drain(
      anthropicAdapter.runActivity(ctx({ input: { prompt: 'hi' } }), 'sk'),
    );
    const { capture } = captured(events);
    expect(capture.completion).toBeUndefined();
    expect(capture.request.messages).toEqual([
      { role: 'user', chars: 2, contentHash: sha256Hex('hi') },
    ]);
    const types = events.map((e) => e.type);
    expect(types.indexOf('captured')).toBeLessThan(types.indexOf('failed'));
    expect(types).not.toContain('metered'); // a non-2xx billed nothing
  });
});

// ---------------------------------------------------------------------------
// #2 L10a — local tools: wire shape + the single tool round-trip.
// ---------------------------------------------------------------------------

describe('anthropicAdapter — local tools (#2 L10a)', () => {
  const ADDER = {
    name: 'adder',
    description: 'Adds two numbers.',
    parameters: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
    },
    expression: '${add(tool.args.a, tool.args.b)}',
  };

  const TOOL_USE_BODY = {
    content: [
      { type: 'text', text: 'Let me add those.' },
      { type: 'tool_use', id: 'tu_1', name: 'adder', input: { a: 1, b: 2 } },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 10, output_tokens: 4 },
  };

  function toolCtx(over: Record<string, unknown> = {}): ActivityContext {
    return ctx({ input: { prompt: 'add 1 and 2', tools: [ADDER], ...over } });
  }

  function requestBody(spy: ReturnType<typeof vi.spyOn>, call: number): Record<string, unknown> {
    return JSON.parse(
      ((spy as unknown as { mock: { calls: unknown[][] } }).mock.calls[call]![1] as RequestInit)
        .body as string,
    ) as Record<string, unknown>;
  }

  it('sends tools with the explicit-required wire schema and tool_choice auto by default', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    await drain(anthropicAdapter.runActivity(toolCtx(), 'sk'));
    const body = requestBody(fetchSpy, 0);
    expect(body.tool_choice).toEqual({ type: 'auto' });
    expect(body.tools).toEqual([
      {
        name: 'adder',
        description: 'Adds two numbers.',
        input_schema: {
          type: 'object',
          properties: { a: { type: 'number' }, b: { type: 'number' } },
          required: ['a', 'b'],
          additionalProperties: false,
        },
      },
    ]);
  });

  it("maps toolChoice 'required' to {type:'any'} and suppresses the thinking surface", async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    await drain(
      anthropicAdapter.runActivity(
        toolCtx({ toolChoice: 'required', reasoningEffort: 'high' }),
        'sk',
      ),
    );
    const body = requestBody(fetchSpy, 0);
    expect(body.tool_choice).toEqual({ type: 'any' });
    // A forced tool_choice precludes adaptive thinking (the structured-path
    // precedent) — the whole flow suppresses it rather than 400.
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('output_config');
  });

  it("omits tools entirely under toolChoice 'none' (the plain text path)", async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    const events = await drain(anthropicAdapter.runActivity(toolCtx({ toolChoice: 'none' }), 'sk'));
    const body = requestBody(fetchSpy, 0);
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
    expect(succeeded(events).outputs.text).toBe('Hi there!');
  });

  it('drives one tool round-trip and succeeds on the follow-up text', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(fakeResponse(200, TOOL_USE_BODY))
      .mockResolvedValueOnce(fakeResponse(200, OK_BODY));
    const events = await drain(
      anthropicAdapter.runActivity(toolCtx({ toolChoice: 'required' }), 'sk'),
    );
    // metered (call 1) → captured (first exchange) → metered (call 2) → succeeded.
    expect(events.map((e) => e.type)).toEqual([
      'metered',
      'captured',
      'toolCalled',
      'metered',
      'succeeded',
    ]);
    expect(succeeded(events).outputs).toEqual({ text: 'Hi there!', stopReason: 'end_turn' });

    const second = requestBody(fetchSpy, 1);
    // The continuation replays the raw assistant content and answers with a
    // tool_result carrying the executed expression's value.
    const msgs = second.messages as Record<string, unknown>[];
    expect(msgs[msgs.length - 2]).toEqual({ role: 'assistant', content: TOOL_USE_BODY.content });
    expect(msgs[msgs.length - 1]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '3' }],
    });
    // The forced first choice DOWNGRADES on the continuation — else the model
    // could never answer with text. Tools stay present (tool_result needs them).
    expect(second.tool_choice).toEqual({ type: 'auto' });
    expect(second.tools).toBeDefined();
  });

  it('drives TWO round-trips under maxToolIterations: 2 (#2 L10b bounded loop)', async () => {
    const secondToolUse = {
      content: [{ type: 'tool_use', id: 'tu_2', name: 'adder', input: { a: 3, b: 4 } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 12, output_tokens: 5 },
    };
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(fakeResponse(200, TOOL_USE_BODY))
      .mockResolvedValueOnce(fakeResponse(200, secondToolUse))
      .mockResolvedValueOnce(fakeResponse(200, OK_BODY));
    const events = await drain(
      anthropicAdapter.runActivity(toolCtx({ maxToolIterations: 2 }), 'sk'),
    );
    // Three billed exchanges, one telemetry fact per executed round, one terminal.
    expect(events.map((e) => e.type)).toEqual([
      'metered',
      'captured',
      'toolCalled',
      'metered',
      'toolCalled',
      'metered',
      'succeeded',
    ]);
    expect(succeeded(events).outputs.text).toBe('Hi there!');
    // The third request answers the SECOND round's call (7 = 3+4).
    const third = requestBody(fetchSpy, 2);
    const msgs = third.messages as Record<string, unknown>[];
    expect(msgs[msgs.length - 1]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_2', content: '7' }],
    });
  });

  it('executes ALL parallel tool_use blocks of one response in one round-trip', async () => {
    const parallel = {
      content: [
        { type: 'tool_use', id: 'tu_1', name: 'adder', input: { a: 1, b: 2 } },
        { type: 'tool_use', id: 'tu_2', name: 'adder', input: { a: 10, b: 20 } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 8, output_tokens: 6 },
    };
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(fakeResponse(200, parallel))
      .mockResolvedValueOnce(fakeResponse(200, OK_BODY));
    const events = await drain(anthropicAdapter.runActivity(toolCtx(), 'sk'));
    expect(events[events.length - 1]!.type).toBe('succeeded');
    const second = requestBody(fetchSpy, 1);
    const msgs = second.messages as Record<string, unknown>[];
    expect(msgs[msgs.length - 1]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: '3' },
        { type: 'tool_result', tool_use_id: 'tu_2', content: '30' },
      ],
    });
  });

  it('feeds an error tool_result back for an unknown tool / invalid args', async () => {
    const badCall = {
      content: [{ type: 'tool_use', id: 'tu_1', name: 'mystery', input: {} }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 3, output_tokens: 2 },
    };
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(fakeResponse(200, badCall))
      .mockResolvedValueOnce(fakeResponse(200, OK_BODY));
    const events = await drain(anthropicAdapter.runActivity(toolCtx(), 'sk'));
    expect(events[events.length - 1]!.type).toBe('succeeded');
    const second = requestBody(fetchSpy, 1);
    const msgs = second.messages as Record<string, unknown>[];
    expect(msgs[msgs.length - 1]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_1',
          content: "unknown tool 'mystery'",
          is_error: true,
        },
      ],
    });
  });

  it('fails permanent (loud, local) on a tool_use block without a string id', async () => {
    const noId = {
      content: [{ type: 'tool_use', name: 'adder', input: { a: 1, b: 2 } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 3, output_tokens: 2 },
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, noId));
    const events = await drain(anthropicAdapter.runActivity(toolCtx(), 'sk'));
    const last = events[events.length - 1]!;
    expect(last).toMatchObject({ type: 'failed', kind: 'permanent' });
    if (last.type === 'failed') expect(last.error).toMatch(/without a string id/);
    // No continuation was attempted — the malformed response failed locally,
    // not as an opaque provider 400 on a '' tool_use_id.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.type === 'captured')).toHaveLength(1);
  });

  it('fails permanent when the model requests a second tool round-trip', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(fakeResponse(200, TOOL_USE_BODY))
      .mockResolvedValueOnce(fakeResponse(200, TOOL_USE_BODY));
    const events = await drain(anthropicAdapter.runActivity(toolCtx(), 'sk'));
    const last = events[events.length - 1]!;
    expect(last).toMatchObject({ type: 'failed', kind: 'permanent' });
    if (last.type === 'failed') expect(last.error).toMatch(/tool budget/);
    // Both billed responses metered; one first-exchange capture (L9a).
    expect(events.filter((e) => e.type === 'metered')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'captured')).toHaveLength(1);
  });

  it('emits the first-exchange capture before a transport terminal (L9a invariant)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(fakeResponse(500, 'overloaded'));
    const events = await drain(anthropicAdapter.runActivity(toolCtx(), 'sk'));
    expect(events.map((e) => e.type)).toEqual(['captured', 'failed']);
  });

  it('still succeeds directly when the model answers with text and never calls a tool', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    const events = await drain(anthropicAdapter.runActivity(toolCtx(), 'sk'));
    expect(events.map((e) => e.type)).toEqual(['metered', 'captured', 'succeeded']);
  });

  it('sends no tools key at all when the node declares none (byte-identical)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    await drain(anthropicAdapter.runActivity(ctx(), 'sk'));
    const body = requestBody(fetchSpy, 0);
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
  });
});
