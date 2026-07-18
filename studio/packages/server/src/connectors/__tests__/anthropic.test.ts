import { afterEach, describe, expect, it, vi } from 'vitest';
import { anthropicAdapter } from '../anthropic.js';
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
    expect(events).toEqual([
      {
        type: 'failed',
        kind: 'permanent',
        error: `anthropic_api returned a 2xx response with no completion (${reason})`,
      },
    ]);
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
    // Order: metered precedes the terminal succeeded.
    expect(events.map((e) => e.type)).toEqual(['metered', 'succeeded']);
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
    expect(events[0]).toMatchObject({ type: 'failed' });
  });
});
