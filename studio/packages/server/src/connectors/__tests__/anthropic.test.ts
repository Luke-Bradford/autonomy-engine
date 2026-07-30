import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolvePrice } from '@autonomy-studio/shared';
import { anthropicAdapter } from '../anthropic.js';
import { DEFAULT_LLM_TIMEOUT_MS } from '../llm-shared.js';
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

  it('defaults the model to claude-opus-5 and max_tokens, honoring input overrides', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    await drain(
      anthropicAdapter.runActivity(
        ctx({ input: { prompt: 'p', system: 'be terse', maxTokens: 50 } }),
        'sk',
      ),
    );
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.model).toBe('claude-opus-5');
    expect(body.max_tokens).toBe(50);
    expect(body.system).toBe('be terse');
    expect(body.messages).toEqual([{ role: 'user', content: 'p' }]);
  });

  // #708 — the default `max_tokens`, pinned because it is COUPLED in BOTH
  // directions and a change either way has a silent failure mode.
  //
  // Too LOW and thinking eats the budget: `max_tokens` caps thinking + response
  // text together, the Opus 5 default thinks unless told not to, and a truncated
  // or text-free response is what `extractText` turns into a PERMANENT
  // `empty_completion_set` failure.
  //
  // Too HIGH and it outruns this connector's own 120s non-streaming timeout
  // (`DEFAULT_LLM_TIMEOUT_MS`): the abort path emits NO `activity.metered` event
  // even though the provider generated and billed the tokens, and classifies
  // `transient`, so the engine retries and buys another unmetered generation.
  // That is the very telemetry hole this ticket closed, via a different door.
  //
  // So this is an upper AND lower bound, not a preference. Anyone moving it
  // should read the `DEFAULT_MAX_TOKENS` block and #725 first.
  it('defaults max_tokens to a budget that fits the non-streaming timeout', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    await drain(anthropicAdapter.runActivity(ctx({ input: { prompt: 'p' } }), 'sk'));
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.max_tokens).toBe(4096);
    // The bound that matters: at a pessimistic ~40 tok/s this must still finish
    // inside DEFAULT_LLM_TIMEOUT_MS, or the silent-billing path above opens.
    expect((body.max_tokens / 40) * 1000).toBeLessThan(DEFAULT_LLM_TIMEOUT_MS);
  });

  // #708 — the REGRESSION GUARD for this ticket's actual defect: the connector
  // default and the built-in price table drifted apart, so every default-model
  // call resolved to a null price and stamped no `costEstimate`. That failure
  // was SILENT — no error, no log, just missing cost telemetry.
  //
  // Asserted through the metered event's `usage.model` rather than by exporting
  // DEFAULT_MODEL, because `usage.model` is literally the value the executor
  // hands to `resolvePrice` — so this exercises the real pricing path instead
  // of agreeing with a constant. Deliberately NOT generalised to "every
  // provider's default is priced": `openai_api` and `ollama` are unpriced BY
  // DESIGN, so a provider-agnostic version would fail on purpose-built gaps.
  it('prices its own default model (the default and the price table must not drift)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    const events = await drain(anthropicAdapter.runActivity(ctx({ input: { prompt: 'p' } }), 'sk'));
    const model = metered(events)?.usage.model;
    expect(model).toBeDefined();
    expect(resolvePrice('anthropic_api', model!, null)).not.toBeNull();
  });

  // #2 L3 — reasoningEffort engages the modern Anthropic reasoning surface:
  // adaptive thinking + output_config.effort (NOT the deprecated budget_tokens,
  // which 400s on every current model incl. the claude-opus-5 default).
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
        // #727 — pinned to a model that still ACCEPTS sampling params. This case
        // previously rode the implicit `DEFAULT_MODEL`, so it was asserting a
        // wire shape the provider answers 400 on — the defect #727 describes,
        // sitting unnoticed in the suite. The subject here is the wire-NAME
        // mapping, which the pin preserves; the reject path has its own tests.
        ctx({
          input: {
            prompt: 'p',
            model: 'claude-opus-4-6',
            topP: 0.9,
            stop: ['STOP'],
            seed: 7,
            temperature: 0.3,
          },
        }),
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
        model: 'claude-opus-5',
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
      model: 'claude-opus-5',
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
      model: 'claude-opus-5',
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
  it('forces the structured_output tool and NOW emits the reasoning surface (#724)', async () => {
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
    // #724 — this used to assert BOTH keys were dropped, on the false premise
    // that a forced `tool_choice` precludes the adaptive-thinking surface. It
    // does not (only MANUAL extended thinking errors under a forced choice), so
    // an authored `reasoningEffort` is now honoured here instead of silently
    // ignored.
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort: 'high' });
  });

  it('still emits NO reasoning surface when the author set no reasoningEffort', async () => {
    // The keys are a pure function of the author's opt-in on every path — a
    // structured node without `reasoningEffort` stays byte-identical to pre-L3.
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(fakeResponse(200, toolResponse({ category: 'bug' })));
    await drain(anthropicAdapter.runActivity(ctx({ input: STRUCTURED_INPUT }), 'sk'));
    const body = sentBody(spy);
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('output_config');
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

  it('#724 — the REPAIR call carries the reasoning surface and the same budget', async () => {
    // The repair is the call that re-issues under an ALREADY-EXHAUSTED budget
    // when thinking starves the forced tool_use block, so its wire shape is the
    // one that matters for the max_tokens interaction #724 introduces. Round 0
    // is covered above; this pins the second call.
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(fakeResponse(200, toolResponse({ category: 'question' })))
      .mockResolvedValueOnce(fakeResponse(200, toolResponse({ category: 'bug' })));
    await drain(
      anthropicAdapter.runActivity(
        ctx({ input: { ...STRUCTURED_INPUT, reasoningEffort: 'high' } }),
        'sk',
      ),
    );
    const repairBody = JSON.parse((spy.mock.calls[1]![1] as RequestInit).body as string);
    expect(repairBody.thinking).toEqual({ type: 'adaptive' });
    expect(repairBody.output_config).toEqual({ effort: 'high' });
    // Same budget as round 0 — the repair gets no extra headroom, which is why
    // an exhausted budget costs TWO billed calls before terminalizing.
    expect(repairBody.max_tokens).toBe(4096);
  });

  it('#724 — a truncated forced-tool response names the stop_reason in its failure', async () => {
    // Budget starvation and a disobedient model produce the SAME symptom (no
    // structured_output block). Without the stop reason the durable error blames
    // the model; `max_tokens` names the real cause.
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(200, {
        content: [],
        stop_reason: 'max_tokens',
        usage: { input_tokens: 4, output_tokens: 4096 },
      }),
    );
    const events = await drain(
      anthropicAdapter.runActivity(
        ctx({ input: { ...STRUCTURED_INPUT, reasoningEffort: 'high' } }),
        'sk',
      ),
    );
    expect(spy).toHaveBeenCalledTimes(2); // original + one repair, both billed
    expect(failed(events).kind).toBe('permanent');
    expect(failed(events).error).toContain('max_tokens');
    // and the repair CRITIQUE carries it too, so the model is told what happened
    const repairBody = JSON.parse((spy.mock.calls[1]![1] as RequestInit).body as string);
    const msgs = repairBody.messages as { role: string; content: string }[];
    expect(msgs[msgs.length - 1]!.content).toContain('max_tokens');
  });

  it('#724 — a TRUNCATED (present but short) tool_use block also names the stop_reason', async () => {
    // The sharper truncation shape, and the one an earlier pass missed: the block
    // IS present, so `findStructuredToolInput` finds it and validation — not the
    // no-block branch — produces the reason. Un-annotated, the durable error read
    // "category: expected string, received undefined", which blames the model for
    // a schema defect when the cause was the budget.
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(200, {
        content: [{ type: 'tool_use', name: 'structured_output', input: {} }],
        stop_reason: 'max_tokens',
        usage: { input_tokens: 4, output_tokens: 4096 },
      }),
    );
    const events = await drain(
      anthropicAdapter.runActivity(
        ctx({ input: { ...STRUCTURED_INPUT, reasoningEffort: 'high' } }),
        'sk',
      ),
    );
    expect(spy).toHaveBeenCalledTimes(2); // original + one repair, both billed
    expect(failed(events).kind).toBe('permanent');
    // Both the schema complaint AND the budget cause, so the reader can tell them apart.
    expect(failed(events).error).toContain('max_tokens');
    expect(failed(events).error).toContain('category');
    // and the repair critique carries it too
    const repairBody = JSON.parse((spy.mock.calls[1]![1] as RequestInit).body as string);
    const msgs = repairBody.messages as { role: string; content: string }[];
    expect(msgs[msgs.length - 1]!.content).toContain('max_tokens');
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
    expect(capture.model).toBe('claude-opus-5');
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

  it("maps toolChoice 'required' to {type:'any'} and NOW keeps the thinking surface (#724)", async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    await drain(
      anthropicAdapter.runActivity(
        toolCtx({ toolChoice: 'required', reasoningEffort: 'high' }),
        'sk',
      ),
    );
    const body = requestBody(fetchSpy, 0);
    expect(body.tool_choice).toEqual({ type: 'any' });
    // #724 — this used to assert suppression, citing the structured path's
    // (equally false) precedent. Adaptive thinking supports forced tool use, and
    // the continuation replays raw content blocks, so thinking blocks travel back
    // intact as the API requires during tool use.
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort: 'high' });
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

// ---------------------------------------------------------------------------
// #727 / #724 — the unsupported-parameter PREFLIGHT.
//
// The connector emits `temperature`/`top_p` and the `thinking`+`output_config`
// reasoning pair only when the AUTHOR opted in. Several current models REMOVED
// those knobs and answer 400. The preflight refuses such a call LOCALLY, before
// any request, with an error naming the model, the parameter and the remedy —
// same terminal class (`permanent`) as the provider 400 it replaces, but
// diagnosable without reading a provider body.
// ---------------------------------------------------------------------------
describe('anthropicAdapter.runActivity — unsupported-parameter preflight (#727)', () => {
  it.each([
    ['temperature', 'claude-opus-5', { temperature: 0.2 }],
    ['topP', 'claude-opus-5', { topP: 0.9 }],
    // The model #727's own ticket text MISSED — sampling params are removed on
    // Sonnet 5 too, so the list had to be re-derived rather than transcribed.
    ['temperature', 'claude-sonnet-5', { temperature: 0.2 }],
    ['temperature', 'claude-opus-4-8', { temperature: 0.2 }],
  ])('refuses %s on %s before issuing any request', async (param, model, over) => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    const events = await drain(
      anthropicAdapter.runActivity(ctx({ input: { prompt: 'hi', model, ...over } }), 'sk'),
    );
    expect(spy).not.toHaveBeenCalled();
    expect(events.map((e) => e.type)).toEqual(['failed']);
    expect(failed(events).kind).toBe('permanent');
    expect(failed(events).error).toContain(model);
    expect(failed(events).error).toContain(param);
  });

  it('refuses a sampling param on the DEFAULT model when the node names none', async () => {
    // DEFAULT_MODEL is `claude-opus-5`, which rejects them — so a node that sets
    // only `temperature` must refuse. This is why the gate is a DISPATCH-time
    // check and not an author-time Zod refinement: the resolved model can come
    // from the connection or the built-in default, neither visible to the node.
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    const events = await drain(
      anthropicAdapter.runActivity(ctx({ input: { prompt: 'hi', temperature: 0.2 } }), 'sk'),
    );
    expect(spy).not.toHaveBeenCalled();
    expect(failed(events).error).toContain('claude-opus-5');
  });

  it('refuses a sampling param when the CONNECTION supplies the rejecting model', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    const events = await drain(
      anthropicAdapter.runActivity(
        ctx({
          input: { prompt: 'hi', temperature: 0.2 },
          connectionConfig: { model: 'claude-fable-5' },
        }),
        'sk',
      ),
    );
    expect(spy).not.toHaveBeenCalled();
    expect(failed(events).error).toContain('claude-fable-5');
  });

  it('refuses an explicitly-set DEFAULT-valued temperature too (conscious over-refusal)', async () => {
    // Sources differ on whether the 400 is on ANY temperature or only a
    // non-default one. The gate gates on PRESENCE: the authored intent (steer
    // sampling) cannot be honoured on a model with no sampling knobs, and
    // "the default" is not well-defined for `topP`. Pinned so the choice is
    // deliberate rather than incidental.
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    const events = await drain(
      anthropicAdapter.runActivity(
        ctx({ input: { prompt: 'hi', model: 'claude-opus-5', temperature: 1 } }),
        'sk',
      ),
    );
    expect(spy).not.toHaveBeenCalled();
    expect(failed(events).kind).toBe('permanent');
  });

  it('does NOT refuse a sampling param on a model that still accepts it', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    await drain(
      anthropicAdapter.runActivity(
        ctx({ input: { prompt: 'hi', model: 'claude-opus-4-6', temperature: 0.2 } }),
        'sk',
      ),
    );
    expect(sentBody(spy).temperature).toBe(0.2);
  });

  it('DOES refuse on the DATED form of a rejecting id, end to end (#751)', async () => {
    // INVERTED by #751, and this is the test that proves normalisation actually
    // reaches the wire rather than only the pure helper: a dated full id is the
    // same model as its alias, so `temperature` is refused locally instead of
    // being sent to a provider guaranteed to 400 on it.
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    const events = await drain(
      anthropicAdapter.runActivity(
        ctx({ input: { prompt: 'hi', model: 'claude-opus-5-20260101', temperature: 0.2 } }),
        'sk',
      ),
    );
    expect(spy).not.toHaveBeenCalled();
    expect(failed(events).kind).toBe('permanent');
    expect(failed(events).error).toContain('temperature');
  });

  it('still does NOT refuse on an unknown or proxied id (absent fact is never a refusal)', async () => {
    // The half of the old pin that SURVIVES, kept separate so the two rules stay
    // visibly distinct. An id the sets do not name — including a Bedrock
    // `anthropic.`-prefixed one, which #751 deliberately leaves unnormalised —
    // is not asserted to reject anything and falls through to the provider. The
    // inverse of `price-table.ts`'s fail-closed default, deliberately so.
    for (const model of ['some-proxied-model', 'anthropic.claude-opus-5']) {
      const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
      await drain(
        anthropicAdapter.runActivity(
          ctx({ input: { prompt: 'hi', model, temperature: 0.2 } }),
          'sk',
        ),
      );
      expect(sentBody(spy).temperature).toBe(0.2);
      spy.mockRestore();
    }
  });

  it('refuses reasoningEffort on a model with no adaptive-thinking surface', async () => {
    // A THIRD defect, pre-existing and independent of #724: the TEXT path has
    // always emitted `thinking`+`output_config` whenever `reasoningEffort` is
    // set, so this already 400d on main.
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    const events = await drain(
      anthropicAdapter.runActivity(
        ctx({ input: { prompt: 'hi', model: 'claude-haiku-4-5', reasoningEffort: 'high' } }),
        'sk',
      ),
    );
    expect(spy).not.toHaveBeenCalled();
    expect(failed(events).kind).toBe('permanent');
    expect(failed(events).error).toContain('reasoningEffort');
  });

  it('refuses reasoningEffort on claude-opus-4-5 even though it accepts effort', async () => {
    // The one model where the two facts come apart: 4.5 accepts
    // `output_config.effort` (low/medium/high) but predates the adaptive
    // surface, and the connector emits both keys TOGETHER — so the pair is
    // rejected on the `thinking` key whatever the effort value.
    //
    // Pinned deliberately, because an earlier draft of this sweep exempted 4.5
    // and asserted `thinking:{type:'adaptive'}` as its correct wire body — which
    // enshrined the very 400 this preflight exists to prevent, invisibly,
    // because `fetch` is mocked.
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    const events = await drain(
      anthropicAdapter.runActivity(
        ctx({ input: { prompt: 'hi', model: 'claude-opus-4-5', reasoningEffort: 'high' } }),
        'sk',
      ),
    );
    expect(spy).not.toHaveBeenCalled();
    expect(failed(events).kind).toBe('permanent');
    expect(failed(events).error).toContain('reasoningEffort');
  });

  it("refuses reasoningEffort 'max' on claude-opus-4-5 (the per-value 400, subsumed)", async () => {
    // `reasoningEffortSchema` admits `max`, which 4.5 rejects even though it
    // accepts the other three levels — a per-(model, VALUE) fact a boolean set
    // cannot express. Refusing 4.5 wholesale subsumes it; this pins that the
    // value dimension really is covered, so removing 4.5 from the set later
    // cannot silently reopen the hole.
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    const events = await drain(
      anthropicAdapter.runActivity(
        ctx({ input: { prompt: 'hi', model: 'claude-opus-4-5', reasoningEffort: 'max' } }),
        'sk',
      ),
    );
    expect(spy).not.toHaveBeenCalled();
    expect(failed(events).kind).toBe('permanent');
  });

  it('REGRESSION, accepted: a structured node that worked on main is now refused', async () => {
    // The one case where this branch is NOT "same outcome, better diagnosis".
    //
    // On main the structured path passed `allowThinking:false`, so a node naming
    // a no-adaptive-surface model AND setting `reasoningEffort` emitted NEITHER
    // reasoning key — a valid body the provider answered 200. #724 deletes that
    // suppression, so the pair is now emitted, the model is in
    // MODELS_REJECTING_ADAPTIVE_THINKING, and the preflight refuses outright.
    // `permanent` is retry-ineligible, so there is no self-recovery.
    //
    // Kept as a REFUSAL rather than silently dropping the keys, for the reason
    // `unsupportedAnthropicParams` gives about `temperature`: proceeding would
    // grant the letter of the authored request while dropping its point. What
    // main actually did was ignore the author's `reasoningEffort` without
    // saying so — the silent defect #724 exists to remove — so the loud failure
    // is the intended direction, not collateral damage. Pinned so the break is
    // a visible decision rather than a production discovery.
    //
    // Affects `claude-opus-4-5` / `claude-sonnet-4-5` / `claude-haiku-4-5` on
    // the STRUCTURED and `toolChoice:'required'` paths only. The text path and
    // the `auto` tools path already 400d on main.
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    const events = await drain(
      anthropicAdapter.runActivity(
        ctx({
          input: {
            prompt: 'classify',
            outputMode: 'structured',
            outputSchema: { type: 'object', properties: { c: { type: 'string' } } },
            model: 'claude-haiku-4-5',
            reasoningEffort: 'high',
          },
        }),
        'sk',
      ),
    );
    expect(spy).not.toHaveBeenCalled();
    expect(failed(events).kind).toBe('permanent');
    expect(failed(events).error).toContain('reasoningEffort');
  });

  it('the same structured node WITHOUT reasoningEffort still succeeds', async () => {
    // The other half of the regression pin: proves the refusal above is caused
    // by `reasoningEffort` alone and that the model itself is still reachable
    // on the structured path. This body is byte-identical to what main sent for
    // the node above, because main dropped both reasoning keys — so this is the
    // behaviour that was lost, captured next to the loss.
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(fakeResponse(200, toolResponse({ c: 'ok' })));
    const events = await drain(
      anthropicAdapter.runActivity(
        ctx({
          input: {
            prompt: 'classify',
            outputMode: 'structured',
            outputSchema: { type: 'object', properties: { c: { type: 'string' } } },
            model: 'claude-haiku-4-5',
          },
        }),
        'sk',
      ),
    );
    const body = JSON.parse((spy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();
    expect(events.map((e) => e.type)).toEqual(['metered', 'succeeded']);
  });

  it('fires on the STRUCTURED path too, not just text', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    const events = await drain(
      anthropicAdapter.runActivity(
        ctx({
          input: {
            prompt: 'classify',
            outputMode: 'structured',
            outputSchema: { type: 'object', properties: { c: { type: 'string' } } },
            model: 'claude-opus-5',
            temperature: 0.2,
          },
        }),
        'sk',
      ),
    );
    expect(spy).not.toHaveBeenCalled();
    expect(events.map((e) => e.type)).toEqual(['failed']);
  });

  it('fires on the TOOLS path too', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, OK_BODY));
    const events = await drain(
      anthropicAdapter.runActivity(
        ctx({
          input: {
            prompt: 'add',
            model: 'claude-opus-5',
            temperature: 0.2,
            tools: [
              {
                name: 'sum',
                description: 'add',
                parameters: {
                  type: 'object',
                  properties: { a: { type: 'number' } },
                  required: ['a'],
                },
                expression: '1',
              },
            ],
          },
        }),
        'sk',
      ),
    );
    expect(spy).not.toHaveBeenCalled();
    expect(events.map((e) => e.type)).toEqual(['failed']);
  });
});
