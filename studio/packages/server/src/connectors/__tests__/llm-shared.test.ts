import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STRUCTURED_REPAIRS,
  MAX_RETRY_AFTER_SECONDS,
  MAX_TOOL_RESULT_CHARS,
  buildCapture,
  buildRepairTurns,
  coerceStopReason,
  executeLocalTool,
  executeToolCalls,
  httpStatusFailure,
  meterUsage,
  noCompletionFailure,
  openAiReasoningEffort,
  parseRetryAfter,
  runStructuredWithRepair,
  runTextWithTools,
  structuredEcho,
} from '../llm-shared.js';
import { sha256Hex } from '../../util/hash.js';
import type { LlmToolDef, LlmTurn, StructuredCallOutcome, ToolCallResult } from '../llm-shared.js';
import type { ActivityEvent, LlmCapture, LlmUsage } from '../types.js';

async function drain(stream: AsyncIterable<ActivityEvent>): Promise<ActivityEvent[]> {
  const events: ActivityEvent[] = [];
  for await (const e of stream) events.push(e);
  return events;
}

const USAGE: LlmUsage = { provider: 'openai_api', model: 'm', meteringStatus: 'metered' };

/** #461 — a 2xx with no readable completion is a permanent failure, adapter-named.
 *  #556 — it carries a DIAGNOSTIC sub-reason; the retry class is `permanent` for
 *  every reason, so no downstream behaviour branches on it. */
describe('noCompletionFailure', () => {
  it('is a permanent failure naming the adapter and the sub-reason', () => {
    expect(noCompletionFailure('openai_api', 'absent_content')).toEqual({
      type: 'failed',
      kind: 'permanent',
      error: 'openai_api returned a 2xx response with no completion (absent_content)',
    });
    expect(noCompletionFailure('anthropic_api', 'malformed_block').error).toContain(
      'anthropic_api',
    );
    expect(noCompletionFailure('ollama', 'malformed_block').error).toContain('ollama');
  });

  it('stays `permanent` for every sub-reason (the reason is diagnostic only)', () => {
    for (const reason of ['absent_content', 'malformed_block', 'empty_completion_set'] as const) {
      const event = noCompletionFailure('openai_api', reason);
      expect(event.kind).toBe('permanent');
      expect(event.error).toContain(`(${reason})`);
    }
  });
});

/** #457 — see `coerceStopReason`'s docblock for the contract rationale. */
describe('coerceStopReason', () => {
  it('passes a provider-sent string through verbatim', () => {
    // Real values from each vocabulary — none of these is ours to reinterpret.
    for (const v of ['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'stop', 'length']) {
      expect(coerceStopReason(v)).toBe(v);
    }
  });

  it('coerces every non-string to the sentinel — the declared type is the contract', () => {
    for (const v of [null, undefined, 42, {}, [], true]) {
      expect(coerceStopReason(v)).toBe('unknown');
      expect(typeof coerceStopReason(v)).toBe('string');
    }
  });

  it('the sentinel collides with no documented provider value', () => {
    // The guard on the sentinel CHOICE: "we could not read a reason" must stay
    // distinguishable from a real one. `'stop'` — the tempting default, and what
    // ollama shipped — is a real OpenAI `finish_reason`, so it would report a
    // normal completion for a response we could not read. This list is the
    // first-party documented vocabularies (not exhaustive, and a bespoke
    // OpenAI-compatible gateway can send anything); it fails the moment the
    // sentinel moves onto one of them.
    const DOCUMENTED_PROVIDER_VALUES = [
      // Anthropic `stop_reason`
      'end_turn',
      'max_tokens',
      'stop_sequence',
      'tool_use',
      'refusal',
      'pause_turn',
      // OpenAI `finish_reason`
      'stop',
      'length',
      'tool_calls',
      'content_filter',
      // Ollama `done_reason`
      'load',
      'unload',
    ];
    expect(DOCUMENTED_PROVIDER_VALUES).not.toContain(coerceStopReason(null));
  });
});

/** #2 L2 — the metering-fact normalizer shared by all three LLM adapters. */
describe('meterUsage', () => {
  it('records both counts and reports metered when the pair is well-formed', () => {
    expect(meterUsage('anthropic_api', 'claude-opus-4-8', 10, 20)).toEqual({
      provider: 'anthropic_api',
      model: 'claude-opus-4-8',
      inputTokens: 10,
      outputTokens: 20,
      meteringStatus: 'metered',
    });
  });

  it('reports unknown with NO token fields when usage is entirely absent', () => {
    expect(meterUsage('openai_api', 'gpt-4o', undefined, undefined)).toEqual({
      provider: 'openai_api',
      model: 'gpt-4o',
      meteringStatus: 'unknown',
    });
  });

  it('keeps whichever count is valid but reports unknown when the pair is incomplete', () => {
    // A fact is never discarded: the valid input count is stamped even though the
    // output count is missing — but the response is not fully accounted → unknown.
    expect(meterUsage('ollama', 'llama3', 7, undefined)).toEqual({
      provider: 'ollama',
      model: 'llama3',
      inputTokens: 7,
      meteringStatus: 'unknown',
    });
  });

  it('rejects a non-integer, negative, or non-number count as invalid (→ unknown, dropped)', () => {
    for (const bad of [1.5, -1, NaN, Infinity, '5', null, {}]) {
      const usage = meterUsage('openai_api', 'gpt-4o', bad, 3);
      expect(usage).not.toHaveProperty('inputTokens');
      expect(usage.outputTokens).toBe(3);
      expect(usage.meteringStatus).toBe('unknown');
    }
  });

  it('accepts a zero token count as a valid, present fact', () => {
    // 0 is a real count (an empty completion), not "absent" — it must be recorded.
    expect(meterUsage('anthropic_api', 'm', 0, 0)).toEqual({
      provider: 'anthropic_api',
      model: 'm',
      inputTokens: 0,
      outputTokens: 0,
      meteringStatus: 'metered',
    });
  });
});

// #2 L9a — the prompt/completion CAPTURE builder. Metadata ONLY (hash + length),
// NEVER raw text; fail-closed on absence.
describe('buildCapture', () => {
  const turns: LlmTurn[] = [
    { role: 'user', content: 'hello world' },
    { role: 'assistant', content: 'hi' },
  ];

  it('captures per-message role/length/hash and NEVER carries raw text', () => {
    const cap = buildCapture({
      provider: 'anthropic_api',
      model: 'claude-opus-4-8',
      latencyMs: 42,
      turns,
      system: 'be terse',
      completionText: 'the answer',
    });
    expect(cap).toEqual({
      provider: 'anthropic_api',
      model: 'claude-opus-4-8',
      latencyMs: 42,
      request: {
        messageCount: 2,
        system: { chars: 8, contentHash: sha256Hex('be terse') },
        messages: [
          { role: 'user', chars: 11, contentHash: sha256Hex('hello world') },
          { role: 'assistant', chars: 2, contentHash: sha256Hex('hi') },
        ],
      },
      completion: { chars: 10, contentHash: sha256Hex('the answer') },
    });
    // Defence in depth: no field anywhere holds the plaintext.
    const blob = JSON.stringify(cap);
    for (const raw of ['hello world', 'be terse', 'the answer']) {
      expect(blob).not.toContain(raw);
    }
  });

  it('omits `system` when no system instruction was sent', () => {
    const cap = buildCapture({
      provider: 'ollama',
      model: 'm',
      latencyMs: 1,
      turns,
      completionText: 'x',
    });
    expect(cap.request).not.toHaveProperty('system');
    expect(cap.request.messageCount).toBe(2);
  });

  it('omits `completion` entirely when there is no completion (fail-closed — never hash of "")', () => {
    const cap = buildCapture({ provider: 'openai_api', model: 'm', latencyMs: 5, turns });
    expect(cap).not.toHaveProperty('completion');
    // The empty-string hash must NOT appear — an absent completion is absent.
    expect(JSON.stringify(cap)).not.toContain(sha256Hex(''));
  });

  it('is a stable drift fingerprint: identical content ⇒ identical hash, a change flips it', () => {
    const a = buildCapture({
      provider: 'ollama',
      model: 'm',
      latencyMs: 1,
      turns,
      completionText: 'z',
    });
    const b = buildCapture({
      provider: 'ollama',
      model: 'm',
      latencyMs: 999,
      turns,
      completionText: 'z',
    });
    expect(b.request.messages[0]?.contentHash).toBe(a.request.messages[0]?.contentHash);
    const c = buildCapture({
      provider: 'ollama',
      model: 'm',
      latencyMs: 1,
      turns: [
        { role: 'user', content: 'hello worlD' },
        { role: 'assistant', content: 'hi' },
      ],
      completionText: 'z',
    });
    expect(c.request.messages[0]?.contentHash).not.toBe(a.request.messages[0]?.contentHash);
  });

  it('records a present-but-empty completion as a real fact (chars 0, hashed)', () => {
    // An empty completion ('') is a real result (#461 present-but-empty succeeds),
    // distinct from ABSENT: it IS captured, with chars 0 and the empty-string hash.
    const cap = buildCapture({
      provider: 'openai_api',
      model: 'm',
      latencyMs: 1,
      turns,
      completionText: '',
    });
    expect(cap.completion).toEqual({ chars: 0, contentHash: sha256Hex('') });
  });
});

describe('sha256Hex', () => {
  it('is a deterministic lowercase-hex sha256 of the utf8 input', () => {
    // Known-answer vector: sha256('') — locks the algorithm + encoding.
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

// #2 L3 — the OpenAI reasoning-effort clamp. Anthropic + Ollama take the enum
// value verbatim (all four are valid there); OpenAI's canonical vocabulary is
// low|medium|high, so `max` clamps down to `high` and the rest pass through.
describe('openAiReasoningEffort', () => {
  it('passes low/medium/high through unchanged', () => {
    expect(openAiReasoningEffort('low')).toBe('low');
    expect(openAiReasoningEffort('medium')).toBe('medium');
    expect(openAiReasoningEffort('high')).toBe('high');
  });

  it('clamps `max` to `high` (OpenAI has no `max` level)', () => {
    expect(openAiReasoningEffort('max')).toBe('high');
  });
});

// #2 L4c — the always-non-empty, bounded echo fed into a repair sub-call.
describe('structuredEcho', () => {
  it('passes a string completion through', () => {
    expect(structuredEcho('{"category":"bug"}')).toBe('{"category":"bug"}');
  });

  it('JSON-stringifies a parsed object (Anthropic tool input)', () => {
    expect(structuredEcho({ category: 'bug' })).toBe('{"category":"bug"}');
  });

  it('is a NON-EMPTY placeholder for an absent / empty / non-serializable payload', () => {
    const placeholder = '(the response contained no valid structured output)';
    expect(structuredEcho(undefined)).toBe(placeholder);
    expect(structuredEcho(null)).toBe(placeholder);
    // an empty assistant turn is itself an Anthropic 400 — never emit ''.
    expect(structuredEcho('')).toBe(placeholder);
    expect(structuredEcho(0n)).toBe(placeholder); // BigInt → JSON.stringify throws
  });

  it('bounds a huge payload (errorExcerpt truncation)', () => {
    const echo = structuredEcho('x'.repeat(2000));
    expect(echo.length).toBeLessThan(2000);
    expect(echo.endsWith('…')).toBe(true);
  });
});

// #2 L4c — role-aware repair-turn construction (Anthropic strict alternation).
describe('buildRepairTurns', () => {
  const base: LlmTurn[] = [{ role: 'user', content: 'classify' }];

  it('appends assistant(echo) + user(critique) when the last turn is user', () => {
    const out = buildRepairTurns(
      base,
      'category: value is not one of the declared enum values',
      'X',
    );
    expect(out).toHaveLength(3);
    expect(out[1]).toEqual({ role: 'assistant', content: 'X' });
    expect(out[2]?.role).toBe('user');
    expect(out[2]?.content).toContain('enum');
    // …user → assistant → user alternates.
  });

  it('folds the echo into a SINGLE user turn when the conversation ends on assistant', () => {
    // A v2 messages[] may legally end on an assistant turn; appending another
    // assistant echo would break Anthropic's strict role alternation.
    const turns: LlmTurn[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'prior' },
    ];
    const out = buildRepairTurns(turns, 'missing field', 'ECHOED');
    expect(out).toHaveLength(3);
    expect(out[2]?.role).toBe('user'); // …assistant → user, no assistant,assistant
    expect(out[2]?.content).toContain('ECHOED');
    expect(out[2]?.content).toContain('missing field');
    expect(out.filter((t) => t.role === 'assistant')).toHaveLength(1);
  });
});

// #2 L4c — the bounded internal-repair loop, exercised with a fake `doCall` so the
// control flow (meter-every-call, repair-then-terminalize, no-repair-on-terminal)
// is tested independent of any provider wire shape.
describe('runStructuredWithRepair', () => {
  const okOutcome = (): StructuredCallOutcome => ({
    type: 'validated',
    usage: USAGE,
    result: { ok: true, value: { category: 'bug' } },
    echo: '{"category":"bug"}',
  });
  const invalidOutcome = (reason: string): StructuredCallOutcome => ({
    type: 'validated',
    usage: USAGE,
    result: { ok: false, reason },
    echo: 'bad',
  });

  it('meters once and succeeds when the first response validates', async () => {
    let calls = 0;
    const events = await drain(
      runStructuredWithRepair('openai_api', [{ role: 'user', content: 'q' }], async () => {
        calls += 1;
        return okOutcome();
      }),
    );
    expect(calls).toBe(1);
    expect(events.map((e) => e.type)).toEqual(['metered', 'succeeded']);
  });

  it('repairs once then succeeds — TWO metered facts, both billed', async () => {
    const turnsSeen: LlmTurn[][] = [];
    const events = await drain(
      runStructuredWithRepair('openai_api', [{ role: 'user', content: 'q' }], async (turns) => {
        turnsSeen.push(turns);
        return turnsSeen.length === 1 ? invalidOutcome('category: enum') : okOutcome();
      }),
    );
    expect(events.map((e) => e.type)).toEqual(['metered', 'metered', 'succeeded']);
    // the SECOND call carries the repair critique appended to the first turns.
    expect(turnsSeen[1]!.length).toBeGreaterThan(turnsSeen[0]!.length);
    expect(turnsSeen[1]!.some((t) => t.content.includes('enum'))).toBe(true);
  });

  it('terminalizes permanent after repairs are exhausted (still meters both calls)', async () => {
    let calls = 0;
    const events = await drain(
      runStructuredWithRepair('ollama', [{ role: 'user', content: 'q' }], async () => {
        calls += 1;
        return invalidOutcome('missing field');
      }),
    );
    // DEFAULT_STRUCTURED_REPAIRS repairs = calls one MORE than the repair count.
    expect(calls).toBe(DEFAULT_STRUCTURED_REPAIRS + 1);
    const failed = events.find((e) => e.type === 'failed');
    expect(failed).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect((failed as { error: string }).error).toContain('missing field');
    expect(events.filter((e) => e.type === 'metered')).toHaveLength(DEFAULT_STRUCTURED_REPAIRS + 1);
  });

  it('yields a terminal transport failure verbatim WITHOUT metering or repair', async () => {
    let calls = 0;
    const events = await drain(
      runStructuredWithRepair('anthropic_api', [{ role: 'user', content: 'q' }], async () => {
        calls += 1;
        return {
          type: 'terminal',
          event: { type: 'failed', kind: 'transient', error: 'llm request timed out' },
        };
      }),
    );
    expect(calls).toBe(1); // no repair on a transport/HTTP failure
    expect(events).toEqual([{ type: 'failed', kind: 'transient', error: 'llm request timed out' }]);
  });
});

/** #2 L7 — parse the provider's `Retry-After` HTTP header into a bounded seconds
 *  hint for the retry alarm. Both RFC-9110 forms; a useless/absent value → the
 *  caller falls back to `policy.retryIntervalSeconds`. */
describe('parseRetryAfter', () => {
  const NOW = 1_000_000_000_000; // fixed clock for deterministic HTTP-date math

  it('parses delta-seconds', () => {
    expect(parseRetryAfter('120', NOW)).toBe(120);
    expect(parseRetryAfter('1', NOW)).toBe(1);
  });

  it('trims surrounding whitespace before the integer match', () => {
    expect(parseRetryAfter('  30 ', NOW)).toBe(30);
  });

  it('parses an HTTP-date into whole seconds from now (rounded up)', () => {
    // HTTP-date has second resolution, so the whole-second delta is exact...
    const when = new Date(NOW + 45_000).toUTCString();
    expect(parseRetryAfter(when, NOW)).toBe(45);
    // ...and a sub-second `now` offset rounds the delta UP, so we never retry
    // a hair before the instant the provider named.
    expect(parseRetryAfter(when, NOW + 400)).toBe(45); // 44.6s → 45
  });

  it('returns undefined for a past HTTP-date (retry-now → use policy)', () => {
    const past = new Date(NOW - 60_000).toUTCString();
    expect(parseRetryAfter(past, NOW)).toBeUndefined();
  });

  it('returns undefined for a null / empty / zero / garbage value (policy fallback)', () => {
    expect(parseRetryAfter(null, NOW)).toBeUndefined();
    expect(parseRetryAfter('', NOW)).toBeUndefined();
    expect(parseRetryAfter('   ', NOW)).toBeUndefined();
    expect(parseRetryAfter('0', NOW)).toBeUndefined(); // "retry now" → don't hot-loop
    expect(parseRetryAfter('-5', NOW)).toBeUndefined();
    expect(parseRetryAfter('120.5', NOW)).toBeUndefined(); // not integer, not a date
    expect(parseRetryAfter('soon', NOW)).toBeUndefined();
  });

  it('clamps an absurd value to MAX_RETRY_AFTER_SECONDS', () => {
    expect(parseRetryAfter('999999999', NOW)).toBe(MAX_RETRY_AFTER_SECONDS);
    expect(MAX_RETRY_AFTER_SECONDS).toBe(86400); // matches the policy retryIntervalSeconds ceiling
  });
});

/** #2 L7 — the single builder for a non-2xx LLM failure. Attaches the parsed
 *  `retryAfterSeconds` hint ONLY when the failure is retryable (rate_limit /
 *  transient); an auth/permanent status carrying the header does NOT (it never
 *  retries, so the hint is meaningless). */
describe('httpStatusFailure', () => {
  const NOW = 1_000_000_000_000;

  it('builds the adapter-named HTTP failure, kind from the status', () => {
    expect(httpStatusFailure('anthropic_api', 429, '{"error":"slow down"}', null, NOW)).toEqual({
      type: 'failed',
      kind: 'rate_limit',
      error: 'anthropic_api HTTP 429: {"error":"slow down"}',
    });
    expect(httpStatusFailure('openai_api', 503, 'overloaded', null, NOW).kind).toBe('transient');
    expect(httpStatusFailure('ollama', 400, 'bad', null, NOW).kind).toBe('permanent');
    expect(httpStatusFailure('openai_api', 401, 'nope', null, NOW).kind).toBe('auth');
  });

  it('attaches retryAfterSeconds on a 429 / 5xx that carries the header', () => {
    expect(httpStatusFailure('anthropic_api', 429, 'b', '30', NOW).retryAfterSeconds).toBe(30);
    expect(httpStatusFailure('openai_api', 503, 'b', '12', NOW).retryAfterSeconds).toBe(12);
  });

  it('does NOT attach retryAfterSeconds to a permanent/auth failure even with the header', () => {
    expect(httpStatusFailure('ollama', 400, 'b', '30', NOW).retryAfterSeconds).toBeUndefined();
    expect(httpStatusFailure('openai_api', 401, 'b', '30', NOW).retryAfterSeconds).toBeUndefined();
  });

  it('omits retryAfterSeconds when the header is absent or useless', () => {
    expect(
      httpStatusFailure('anthropic_api', 429, 'b', null, NOW).retryAfterSeconds,
    ).toBeUndefined();
    expect(
      httpStatusFailure('anthropic_api', 429, 'b', '0', NOW).retryAfterSeconds,
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// #2 L10a — local tool execution + the single-round-trip tool flow.
// ---------------------------------------------------------------------------

const ADDER: LlmToolDef = {
  name: 'adder',
  description: 'Adds two numbers.',
  parameters: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
  },
  expression: '${add(tool.args.a, tool.args.b)}',
};

describe('executeLocalTool (#2 L10a)', () => {
  it('validates args and evaluates the expression to a JSON result string', () => {
    const r = executeLocalTool(ADDER, { a: 2, b: 3 });
    expect(r).toEqual({ ok: true, resultText: '5' });
  });

  it('strips unknown args (validateStructuredOutput reuse)', () => {
    const r = executeLocalTool(ADDER, { a: 2, b: 3, extra: 'x' });
    expect(r).toEqual({ ok: true, resultText: '5' });
  });

  it('returns an error for missing/mistyped args instead of failing the node', () => {
    const missing = executeLocalTool(ADDER, { a: 2 });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.message).toMatch(/invalid arguments for tool 'adder'/);
    const mistyped = executeLocalTool(ADDER, { a: 'two', b: 3 });
    expect(mistyped.ok).toBe(false);
  });

  it('returns an error for a non-object args payload', () => {
    expect(executeLocalTool(ADDER, 'garbage').ok).toBe(false);
    expect(executeLocalTool(ADDER, null).ok).toBe(false);
  });

  it('normalizes an optional arg to present-null (#594 contract)', () => {
    const tool: LlmToolDef = {
      ...ADDER,
      name: 'echoer',
      parameters: {
        type: 'object',
        properties: { req: { type: 'string' }, opt: { type: 'string' } },
        required: ['req'],
      },
      expression: '${coalesce(tool.args.opt, tool.args.req)}',
    };
    expect(executeLocalTool(tool, { req: 'fallback' })).toEqual({
      ok: true,
      resultText: '"fallback"',
    });
  });

  it('returns an error when the expression evaluation throws', () => {
    const tool: LlmToolDef = { ...ADDER, expression: '${tool.args.a.deep.miss}' };
    const r = executeLocalTool(tool, { a: 1, b: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/evaluation failed/);
  });

  it('bounds an oversized result instead of shipping it', () => {
    const tool: LlmToolDef = {
      name: 'big',
      description: 'Builds a big array.',
      parameters: { type: 'object', properties: { n: { type: 'number' } } },
      expression: '${range(0, tool.args.n)}',
    };
    const r = executeLocalTool(tool, { n: 9999 });
    expect(r.ok).toBe(false);
    // The message names the SSOT cap, pinning the boundary to the constant.
    if (!r.ok) expect(r.message).toContain(`max ${MAX_TOOL_RESULT_CHARS}`);
  });
});

describe('executeToolCalls (#2 L10a)', () => {
  it('executes each call in order against the declared tools', () => {
    const results = executeToolCalls(
      [ADDER],
      [
        { id: 't1', name: 'adder', args: { a: 1, b: 2 } },
        { id: 't2', name: 'adder', args: { a: 10, b: 20 } },
      ],
    );
    expect(results).toEqual([
      { id: 't1', name: 'adder', resultText: '3', isError: false },
      { id: 't2', name: 'adder', resultText: '30', isError: false },
    ]);
  });

  it('returns an error result for an unknown tool and a nameless call', () => {
    const results = executeToolCalls(
      [ADDER],
      [
        { id: 't1', name: 'mystery', args: {} },
        { id: 't2', name: null, args: {} },
      ],
    );
    expect(results[0]).toMatchObject({ isError: true, resultText: "unknown tool 'mystery'" });
    expect(results[1]).toMatchObject({ isError: true });
  });
});

describe('runTextWithTools (#2 L10a — single round-trip)', () => {
  const CAPTURE: LlmCapture = {
    provider: 'anthropic_api',
    model: 'm',
    latencyMs: 5,
    request: { messageCount: 1, messages: [{ role: 'user', chars: 2, contentHash: 'h' }] },
  };
  const SUCCEEDED: Extract<ActivityEvent, { type: 'succeeded' }> = {
    type: 'succeeded',
    outputs: { text: 'done', stopReason: 'end_turn' },
  };

  it('passes an immediate text response through: metered, captured, succeeded', async () => {
    const events = await drain(
      runTextWithTools('anthropic_api', [ADDER], ['conv0'], 'auto', () =>
        Promise.resolve({ type: 'text', usage: USAGE, capture: CAPTURE, succeeded: SUCCEEDED }),
      ),
    );
    expect(events.map((e) => e.type)).toEqual(['metered', 'captured', 'succeeded']);
  });

  it('drives one tool round-trip: 2 metered, 1 captured (first exchange), then success', async () => {
    const seen: { conv: unknown; choice: string }[] = [];
    const events = await drain(
      runTextWithTools('anthropic_api', [ADDER], 'conv0', 'required', (conv, choice) => {
        seen.push({ conv, choice });
        if (seen.length === 1) {
          return Promise.resolve({
            type: 'toolUse' as const,
            usage: USAGE,
            capture: CAPTURE,
            calls: [{ id: 't1', name: 'adder', args: { a: 1, b: 2 } }],
            buildNext: (results: ToolCallResult[]) => `conv1:${results[0]!.resultText}`,
          });
        }
        return Promise.resolve({ type: 'text' as const, usage: USAGE, succeeded: SUCCEEDED });
      }),
    );
    expect(events.map((e) => e.type)).toEqual(['metered', 'captured', 'metered', 'succeeded']);
    // The continuation call sees the tool-result conversation AND the downgraded
    // choice — a `required` first call must not force a second tool call.
    expect(seen).toEqual([
      { conv: 'conv0', choice: 'required' },
      { conv: 'conv1:3', choice: 'auto' },
    ]);
  });

  it('fails permanent when the model requests a second tool call', async () => {
    let calls = 0;
    const events = await drain(
      runTextWithTools('openai_api', [ADDER], 'c', 'auto', () => {
        calls += 1;
        return Promise.resolve({
          type: 'toolUse' as const,
          usage: USAGE,
          capture: calls === 1 ? CAPTURE : undefined,
          calls: [{ id: `t${calls}`, name: 'adder', args: { a: 1, b: 2 } }],
          buildNext: () => 'next',
        });
      }),
    );
    expect(calls).toBe(2);
    const last = events[events.length - 1]!;
    expect(last).toMatchObject({ type: 'failed', kind: 'permanent' });
    if (last.type === 'failed') expect(last.error).toMatch(/tool budget/);
    // Both billed responses are metered; the single first-exchange capture holds.
    expect(events.filter((e) => e.type === 'metered')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'captured')).toHaveLength(1);
  });

  it('yields a first-exchange capture before a terminal failure (L9a invariant)', async () => {
    const events = await drain(
      runTextWithTools('ollama', [ADDER], 'c', 'auto', () =>
        Promise.resolve({
          type: 'terminal' as const,
          event: { type: 'failed' as const, kind: 'transient' as const, error: 'boom' },
          capture: CAPTURE,
        }),
      ),
    );
    expect(events.map((e) => e.type)).toEqual(['captured', 'failed']);
  });

  it('feeds an error tool_result back rather than failing the node', async () => {
    let sawResults: ToolCallResult[] | null = null;
    const events = await drain(
      runTextWithTools('anthropic_api', [ADDER], 'c', 'auto', (conv) => {
        if (conv === 'c') {
          return Promise.resolve({
            type: 'toolUse' as const,
            usage: USAGE,
            capture: CAPTURE,
            calls: [{ id: 't1', name: 'nope', args: {} }],
            buildNext: (results: ToolCallResult[]) => {
              sawResults = results;
              return 'after';
            },
          });
        }
        return Promise.resolve({ type: 'text' as const, usage: USAGE, succeeded: SUCCEEDED });
      }),
    );
    expect(sawResults).toEqual([
      { id: 't1', name: 'nope', resultText: "unknown tool 'nope'", isError: true },
    ]);
    expect(events[events.length - 1]!.type).toBe('succeeded');
  });
});
