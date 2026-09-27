import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_STRUCTURED_REPAIRS,
  MAX_RETRY_AFTER_SECONDS,
  MAX_TOOL_RESULT_CHARS,
  buildCapture,
  LLM_CAPTURE_BUDGET_CHARS,
  LLM_CAPTURE_FIELD_MAX_CHARS,
  buildRepairTurns,
  coerceStopReason,
  emptyTruncationWarning,
  executeLocalTool,
  executeToolCalls,
  httpStatusFailure,
  meterUsage,
  noCompletionFailure,
  normalizeModelId,
  openAiReasoningEffort,
  parseRetryAfter,
  postJsonAndParse,
  runStructuredWithRepair,
  runTextWithTools,
  structuredEcho,
  toolCallTelemetry,
  TRUNCATION_STOP_REASONS,
} from '../llm-shared.js';
import { sha256Hex } from '../../util/hash.js';
import type { LlmToolDef, LlmTurn, StructuredCallOutcome, ToolCallResult } from '../llm-shared.js';
import type { ActivityContext, ActivityEvent, LlmCapture, LlmUsage } from '../types.js';

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

  // #605 L9b — `captureMode: 'full'` keeps the TEXT too, under a budget.
  describe("captureMode 'full'", () => {
    const base = { provider: 'ollama' as const, model: 'm', latencyMs: 1 };

    it('metadata (explicit or absent) carries NO text key anywhere', () => {
      for (const captureMode of [undefined, 'metadata'] as const) {
        const cap = buildCapture({ ...base, turns, system: 's', completionText: 'c', captureMode });
        expect('text' in cap.request.messages[0]!).toBe(false);
        expect('text' in cap.request.system!).toBe(false);
        expect('text' in cap.completion!).toBe(false);
      }
    });

    it("stores each field's text beside its length and hash", () => {
      const cap = buildCapture({
        ...base,
        turns,
        system: 'be terse',
        completionText: 'the answer',
        captureMode: 'full',
      });
      expect(cap.request).toStrictEqual({
        messageCount: 2,
        system: { chars: 8, contentHash: sha256Hex('be terse'), text: 'be terse' },
        messages: [
          { role: 'user', chars: 11, contentHash: sha256Hex('hello world'), text: 'hello world' },
          { role: 'assistant', chars: 2, contentHash: sha256Hex('hi'), text: 'hi' },
        ],
      });
      expect(cap.completion).toStrictEqual({
        chars: 10,
        contentHash: sha256Hex('the answer'),
        text: 'the answer',
      });
    });

    it('keeps an absent completion ABSENT (a failure is not an empty answer)', () => {
      const cap = buildCapture({ ...base, turns, captureMode: 'full' });
      expect('completion' in cap).toBe(false);
    });

    it('cuts a field at the per-field cap, marks it, and still measures the whole', () => {
      const long = 'x'.repeat(LLM_CAPTURE_FIELD_MAX_CHARS + 5);
      const cap = buildCapture({ ...base, turns, completionText: long, captureMode: 'full' });
      expect(cap.completion).toStrictEqual({
        chars: long.length,
        contentHash: sha256Hex(long),
        text: long.slice(0, LLM_CAPTURE_FIELD_MAX_CHARS),
        truncated: true,
      });
    });

    it('never splits a surrogate pair at the cut', () => {
      const text = 'a'.repeat(LLM_CAPTURE_FIELD_MAX_CHARS - 1) + '\u{1F600}';
      const cap = buildCapture({ ...base, turns, completionText: text, captureMode: 'full' });
      expect(cap.completion?.text).toBe('a'.repeat(LLM_CAPTURE_FIELD_MAX_CHARS - 1));
      expect(cap.completion?.truncated).toBe(true);
    });

    it('spends the event budget completion → system → newest message first', () => {
      const f = LLM_CAPTURE_FIELD_MAX_CHARS;
      const n = Math.ceil(LLM_CAPTURE_BUDGET_CHARS / f) + 1; // more messages than fit
      const many: LlmTurn[] = Array.from({ length: n }, (_, i) => ({
        role: 'user' as const,
        content: String(i % 10).repeat(f),
      }));
      const cap = buildCapture({
        ...base,
        turns: many,
        system: 's'.repeat(f),
        completionText: 'c'.repeat(f),
        captureMode: 'full',
      });
      expect(cap.completion?.text).toHaveLength(f);
      expect(cap.request.system?.text).toHaveLength(f);
      const kept = LLM_CAPTURE_BUDGET_CHARS / f - 2; // what is left after those two
      const msgs = cap.request.messages;
      msgs.slice(n - kept).forEach((m) => {
        expect(m.text).toHaveLength(f);
        expect('truncated' in m).toBe(false);
      });
      msgs.slice(0, n - kept).forEach((m) => {
        expect(m).toMatchObject({ text: '', truncated: true, chars: f });
      });
      const stored = [cap.completion, cap.request.system, ...msgs].reduce(
        (sum, x) => sum + (x?.text?.length ?? 0),
        0,
      );
      expect(stored).toBe(LLM_CAPTURE_BUDGET_CHARS);
    });
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
  // #605 — the capture context the loop builds each response's `captured` fact from.
  const CAP = { model: 'm', system: 'be terse', captureMode: 'full' as const };
  const okOutcome = (): StructuredCallOutcome => ({
    type: 'validated',
    usage: USAGE,
    result: { ok: true, value: { category: 'bug' } },
    echo: '{"category":"bug"}',
    latencyMs: 7,
    completionText: '{"category":"bug"}',
  });
  const invalidOutcome = (reason: string): StructuredCallOutcome => ({
    type: 'validated',
    usage: USAGE,
    result: { ok: false, reason },
    echo: 'bad',
    latencyMs: 5,
    completionText: 'bad',
  });
  const capturesOf = (events: ActivityEvent[]): LlmCapture[] =>
    events.flatMap((e) => (e.type === 'captured' ? [e.capture] : []));

  it('meters once and succeeds when the first response validates', async () => {
    let calls = 0;
    const events = await drain(
      runStructuredWithRepair('openai_api', [{ role: 'user', content: 'q' }], CAP, async () => {
        calls += 1;
        return okOutcome();
      }),
    );
    expect(calls).toBe(1);
    expect(events.map((e) => e.type)).toEqual(['metered', 'captured', 'succeeded']);
  });

  it('repairs once then succeeds — TWO metered facts, both billed', async () => {
    const turnsSeen: LlmTurn[][] = [];
    const events = await drain(
      runStructuredWithRepair(
        'openai_api',
        [{ role: 'user', content: 'q' }],
        CAP,
        async (turns) => {
          turnsSeen.push(turns);
          return turnsSeen.length === 1 ? invalidOutcome('category: enum') : okOutcome();
        },
      ),
    );
    expect(events.map((e) => e.type)).toEqual([
      'metered',
      'captured',
      'metered',
      'captured',
      'succeeded',
    ]);
    // the SECOND call carries the repair critique appended to the first turns.
    expect(turnsSeen[1]!.length).toBeGreaterThan(turnsSeen[0]!.length);
    expect(turnsSeen[1]!.some((t) => t.content.includes('enum'))).toBe(true);
  });

  // #605 — one capture PER provider response, each recording the turns that
  // call actually SENT: the repair capture holds the echo + critique, never a
  // copy of the first request.
  it('captures each response with the turns that call sent and its own completion', async () => {
    const turnsSeen: LlmTurn[][] = [];
    const events = await drain(
      runStructuredWithRepair(
        'openai_api',
        [{ role: 'user', content: 'q' }],
        CAP,
        async (turns) => {
          turnsSeen.push(turns);
          return turnsSeen.length === 1 ? invalidOutcome('category: enum') : okOutcome();
        },
      ),
    );
    const [first, second] = capturesOf(events);
    expect(first).toMatchObject({
      provider: 'openai_api',
      model: 'm',
      latencyMs: 5,
      request: {
        messageCount: 1,
        system: { text: 'be terse' },
        messages: [{ role: 'user', text: 'q' }],
      },
      completion: { text: 'bad' },
    });
    expect(second!.request.messageCount).toBe(turnsSeen[1]!.length);
    expect(second!.request.messages.map((m) => m.text)).toEqual(
      turnsSeen[1]!.map((t) => t.content),
    );
    expect(second!.request.messages.at(-1)!.text).toContain('enum');
    expect(second).toMatchObject({ latencyMs: 7, completion: { text: '{"category":"bug"}' } });
  });

  it('records NO completion when the response carried none — absent, never hash("")', async () => {
    const events = await drain(
      runStructuredWithRepair('ollama', [{ role: 'user', content: 'q' }], CAP, async () => ({
        ...okOutcome(),
        completionText: undefined,
      })),
    );
    const [cap] = capturesOf(events);
    expect(cap).toBeDefined();
    expect(cap).not.toHaveProperty('completion');
  });

  it('stores hashes but no text unless the node asked for full capture', async () => {
    const events = await drain(
      runStructuredWithRepair(
        'ollama',
        [{ role: 'user', content: 'q' }],
        { model: 'm' },
        async () => okOutcome(),
      ),
    );
    const [cap] = capturesOf(events);
    expect(cap!.completion).toEqual({
      chars: '{"category":"bug"}'.length,
      contentHash: sha256Hex('{"category":"bug"}'),
    });
    expect(cap!.request.messages[0]).not.toHaveProperty('text');
  });

  it('terminalizes permanent after repairs are exhausted (still meters both calls)', async () => {
    let calls = 0;
    const events = await drain(
      runStructuredWithRepair('ollama', [{ role: 'user', content: 'q' }], CAP, async () => {
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
    expect(capturesOf(events)).toHaveLength(DEFAULT_STRUCTURED_REPAIRS + 1);
    expect(events.at(-1)!.type).toBe('failed');
  });

  it('yields a terminal transport failure WITHOUT metering or repair, after a request-only capture', async () => {
    let calls = 0;
    const events = await drain(
      runStructuredWithRepair('anthropic_api', [{ role: 'user', content: 'q' }], CAP, async () => {
        calls += 1;
        return {
          type: 'terminal',
          event: { type: 'failed', kind: 'transient', error: 'llm request timed out' },
          latencyMs: 3,
        };
      }),
    );
    expect(calls).toBe(1); // no repair on a transport/HTTP failure
    expect(events.map((e) => e.type)).toEqual(['captured', 'failed']);
    expect(events[1]).toEqual({
      type: 'failed',
      kind: 'transient',
      error: 'llm request timed out',
    });
    const [cap] = capturesOf(events);
    expect(cap).toMatchObject({ latencyMs: 3, request: { messages: [{ text: 'q' }] } });
    expect(cap).not.toHaveProperty('completion');
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

/** #648 — the shared post→status→parse terminal ladder. One helper folds the
 *  three-step `llmPost failed → non-2xx httpStatusFailure → parseJsonBody`
 *  sequence every adapter path (text / structured / tools) previously carried
 *  inline. Latency brackets the POST (fetch + body read) only — the JSON parse
 *  is excluded, matching the adapters' historical per-site measurement. */
describe('postJsonAndParse (#648)', () => {
  afterEach(() => vi.restoreAllMocks());

  const pctx = (): ActivityContext => ({
    runId: 'run_1',
    nodeId: 'n1',
    attemptId: 'n1#0',
    activityType: 'llm_call',
    input: {},
    connectionConfig: {},
    signal: new AbortController().signal,
  });

  function fakeResponse(status: number, bodyText: string, retryAfter?: string): Response {
    const headers = new Headers();
    if (retryAfter !== undefined) headers.set('retry-after', retryAfter);
    return {
      status,
      text: () => Promise.resolve(bodyText),
      headers,
    } as unknown as Response;
  }

  it('returns the parsed json + a numeric latency on a 2xx JSON body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, '{"a":1}'));
    const res = await postJsonAndParse(
      pctx(),
      'openai_api',
      'gpt-test',
      'http://x/y',
      {},
      { m: 1 },
      1000,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.json).toEqual({ a: 1 });
      expect(typeof res.latencyMs).toBe('number');
      expect(res.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('passes a transport failure event through (network error → transient)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('socket hang up'));
    const res = await postJsonAndParse(pctx(), 'ollama', 'llama-test', 'http://x/y', {}, {}, 1000);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.event).toMatchObject({ type: 'failed', kind: 'transient' });
      // The failure arm carries latency too — the text/tools capture closures
      // (#2 L9a) report the latency of a FAILED exchange as well.
      expect(typeof res.latencyMs).toBe('number');
    }
  });

  it('maps a non-2xx through httpStatusFailure, retry-after hint included', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(429, '{"err":"slow"}', '7'));
    const res = await postJsonAndParse(
      pctx(),
      'anthropic_api',
      'claude-test',
      'http://x/y',
      {},
      {},
      1000,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.event).toMatchObject({
        type: 'failed',
        kind: 'rate_limit',
        retryAfterSeconds: 7,
      });
      expect(res.event.error).toContain('anthropic_api HTTP 429');
    }
  });

  it('maps a plain 4xx to a permanent adapter-named failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(400, 'bad request'));
    const res = await postJsonAndParse(
      pctx(),
      'openai_api',
      'gpt-test',
      'http://x/y',
      {},
      {},
      1000,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.event).toMatchObject({ type: 'failed', kind: 'permanent' });
      expect(res.event.error).toContain('openai_api HTTP 400');
    }
  });

  it('rejects a 2xx non-JSON body as a permanent parse failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(200, 'not json'));
    const res = await postJsonAndParse(pctx(), 'ollama', 'llama-test', 'http://x/y', {}, {}, 1000);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.event).toMatchObject({
        type: 'failed',
        kind: 'permanent',
        error: 'provider returned a non-JSON response body',
      });
    }
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

// #605 — the author turns and capture context every tool-loop test threads.
const TURNS: LlmTurn[] = [{ role: 'user', content: 'add 1 and 2' }];
const TOOL_CAP = { model: 'm', system: 'be terse', captureMode: 'full' as const };

describe('runTextWithTools (#2 L10a — single round-trip)', () => {
  const SUCCEEDED: Extract<ActivityEvent, { type: 'succeeded' }> = {
    type: 'succeeded',
    outputs: { text: 'done', stopReason: 'end_turn' },
  };

  it('passes an immediate text response through: metered, captured, succeeded', async () => {
    const events = await drain(
      runTextWithTools('anthropic_api', [ADDER], ['conv0'], TURNS, TOOL_CAP, 'auto', () =>
        Promise.resolve({
          type: 'text',
          usage: USAGE,
          latencyMs: 5,
          completionText: 'done',
          succeeded: SUCCEEDED,
        }),
      ),
    );
    expect(events.map((e) => e.type)).toEqual(['metered', 'captured', 'succeeded']);
  });

  it('drives one tool round-trip: metered + captured per exchange, then success', async () => {
    const seen: { conv: unknown; choice: string }[] = [];
    const events = await drain(
      runTextWithTools(
        'anthropic_api',
        [ADDER],
        'conv0',
        TURNS,
        TOOL_CAP,
        'required',
        (conv, choice) => {
          seen.push({ conv, choice });
          if (seen.length === 1) {
            return Promise.resolve({
              type: 'toolUse' as const,
              usage: USAGE,
              latencyMs: 5,
              calls: [{ id: 't1', name: 'adder', args: { a: 1, b: 2 } }],
              buildNext: (results: ToolCallResult[]) => `conv1:${results[0]!.resultText}`,
            });
          }
          return Promise.resolve({
            type: 'text' as const,
            usage: USAGE,
            latencyMs: 5,
            completionText: 'done',
            succeeded: SUCCEEDED,
          });
        },
      ),
    );
    // L10b adds the executed-call telemetry fact between the exchanges.
    expect(events.map((e) => e.type)).toEqual([
      'metered',
      'captured',
      'toolCalled',
      'metered',
      'captured',
      'succeeded',
    ]);
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
      runTextWithTools('openai_api', [ADDER], 'c', TURNS, TOOL_CAP, 'auto', () => {
        calls += 1;
        return Promise.resolve({
          type: 'toolUse' as const,
          usage: USAGE,
          latencyMs: 5,
          calls: [{ id: `t${calls}`, name: 'adder', args: { a: 1, b: 2 } }],
          buildNext: () => 'next',
        });
      }),
    );
    expect(calls).toBe(2);
    const last = events[events.length - 1]!;
    expect(last).toMatchObject({ type: 'failed', kind: 'permanent' });
    if (last.type === 'failed') expect(last.error).toMatch(/tool budget/);
    // Both billed responses are metered, and each is captured before the
    // budget terminal (#605).
    expect(events.map((e) => e.type)).toEqual([
      'metered',
      'captured',
      'toolCalled',
      'metered',
      'captured',
      'failed',
    ]);
  });

  it('yields a first-exchange capture before a terminal failure (L9a invariant)', async () => {
    const events = await drain(
      runTextWithTools('ollama', [ADDER], 'c', TURNS, TOOL_CAP, 'auto', () =>
        Promise.resolve({
          type: 'terminal' as const,
          event: { type: 'failed' as const, kind: 'transient' as const, error: 'boom' },
          latencyMs: 5,
        }),
      ),
    );
    expect(events.map((e) => e.type)).toEqual(['captured', 'failed']);
  });

  it('feeds an error tool_result back rather than failing the node', async () => {
    let sawResults: ToolCallResult[] | null = null;
    const events = await drain(
      runTextWithTools('anthropic_api', [ADDER], 'c', TURNS, TOOL_CAP, 'auto', (conv) => {
        if (conv === 'c') {
          return Promise.resolve({
            type: 'toolUse' as const,
            usage: USAGE,
            latencyMs: 5,
            calls: [{ id: 't1', name: 'nope', args: {} }],
            buildNext: (results: ToolCallResult[]) => {
              sawResults = results;
              return 'after';
            },
          });
        }
        return Promise.resolve({
          type: 'text' as const,
          usage: USAGE,
          latencyMs: 5,
          completionText: 'done',
          succeeded: SUCCEEDED,
        });
      }),
    );
    expect(sawResults).toEqual([
      { id: 't1', name: 'nope', resultText: "unknown tool 'nope'", isError: true },
    ]);
    expect(events[events.length - 1]!.type).toBe('succeeded');
  });
});

describe('runTextWithTools (#2 L10b — bounded loop + telemetry + cancellation)', () => {
  const SUCCEEDED: Extract<ActivityEvent, { type: 'succeeded' }> = {
    type: 'succeeded',
    outputs: { text: 'done', stopReason: 'end_turn' },
  };
  /** A doCall that answers `toolUses` toolUse rounds, then text. */
  const scripted = (toolUses: number) => {
    let calls = 0;
    return () => {
      calls += 1;
      if (calls <= toolUses) {
        return Promise.resolve({
          type: 'toolUse' as const,
          usage: USAGE,
          latencyMs: 5,
          calls: [{ id: `t${calls}`, name: 'adder', args: { a: calls, b: 1 } }],
          buildNext: () => `conv${calls}`,
        });
      }
      return Promise.resolve({
        type: 'text' as const,
        usage: USAGE,
        latencyMs: 5,
        completionText: 'done',
        succeeded: SUCCEEDED,
      });
    };
  };

  it('drives maxRounds round-trips: per-exchange metering, per-call telemetry, then success', async () => {
    const events = await drain(
      runTextWithTools('anthropic_api', [ADDER], 'conv0', TURNS, TOOL_CAP, 'auto', scripted(3), 3),
    );
    expect(events.map((e) => e.type)).toEqual([
      'metered',
      'captured',
      'toolCalled',
      'metered',
      'captured',
      'toolCalled',
      'metered',
      'captured',
      'toolCalled',
      'metered',
      'captured',
      'succeeded',
    ]);
    // Each telemetry event stamps the 0-based exchange index that REQUESTED it.
    const rounds = events.flatMap((e) => (e.type === 'toolCalled' ? [e.call.round] : []));
    expect(rounds).toEqual([0, 1, 2]);
  });

  it('meters the final billed exchange, then fails permanent on budget exhaustion', async () => {
    const events = await drain(
      runTextWithTools('openai_api', [ADDER], 'conv0', TURNS, TOOL_CAP, 'auto', scripted(99), 2),
    );
    // Exchanges 0..2 all billed (3 metered); rounds 0 and 1 executed their
    // tools (2 toolCalled); exchange 2's toolUse exhausts the budget.
    expect(events.filter((e) => e.type === 'metered')).toHaveLength(3);
    expect(events.filter((e) => e.type === 'toolCalled')).toHaveLength(2);
    const last = events[events.length - 1]!;
    expect(last).toMatchObject({ type: 'failed', kind: 'permanent' });
    if (last.type === 'failed') {
      expect(last.error).toMatch(/tool budget/);
      expect(last.error).toContain('maxToolIterations: 2');
    }
  });

  it('carries the telemetry shape: name, id, args/result chars + sha256, isError', async () => {
    const events = await drain(
      runTextWithTools(
        'anthropic_api',
        [ADDER],
        'conv0',
        TURNS,
        TOOL_CAP,
        'auto',
        (conv: unknown) =>
          conv === 'conv0'
            ? Promise.resolve({
                type: 'toolUse' as const,
                usage: USAGE,
                latencyMs: 5,
                calls: [
                  { id: 't1', name: 'adder', args: { a: 1, b: 2 } },
                  { id: 't2', name: 'nope', args: {} },
                ],
                buildNext: () => 'after',
              })
            : Promise.resolve({
                type: 'text' as const,
                usage: USAGE,
                latencyMs: 5,
                completionText: 'done',
                succeeded: SUCCEEDED,
              }),
        1,
      ),
    );
    const calls = events.flatMap((e) => (e.type === 'toolCalled' ? [e.call] : []));
    const args1 = JSON.stringify({ a: 1, b: 2 });
    expect(calls).toEqual([
      {
        round: 0,
        toolName: 'adder',
        callId: 't1',
        argsChars: args1.length,
        argsHash: sha256Hex(args1),
        resultChars: 1, // '3'
        resultHash: sha256Hex('3'),
        isError: false,
      },
      {
        round: 0,
        toolName: 'nope',
        callId: 't2',
        argsChars: 2, // '{}'
        argsHash: sha256Hex('{}'),
        resultChars: "unknown tool 'nope'".length,
        resultHash: sha256Hex("unknown tool 'nope'"),
        isError: true,
      },
    ]);
  });

  it('aborts between rounds: cancelled terminal, no tool execution, no telemetry', async () => {
    const controller = new AbortController();
    let builtNext = false;
    const events = await drain(
      runTextWithTools(
        'anthropic_api',
        [ADDER],
        'conv0',
        TURNS,
        TOOL_CAP,
        'auto',
        () => {
          // The run is cancelled while the provider call is in flight; the
          // response still arrives (billed → metered) but the loop must not
          // execute tools or emit telemetry afterwards.
          controller.abort();
          return Promise.resolve({
            type: 'toolUse' as const,
            usage: USAGE,
            latencyMs: 5,
            calls: [{ id: 't1', name: 'adder', args: { a: 1, b: 2 } }],
            buildNext: () => {
              builtNext = true;
              return 'next';
            },
          });
        },
        3,
        controller.signal,
      ),
    );
    expect(events.map((e) => e.type)).toEqual(['metered', 'captured', 'failed']);
    const last = events[events.length - 1]!;
    expect(last).toMatchObject({ type: 'failed', kind: 'cancelled' });
    if (last.type === 'failed') expect(last.error).toBe('llm tool loop aborted');
    expect(builtNext).toBe(false);
  });

  it('prefers the cancelled terminal when an abort coincides with budget exhaustion', async () => {
    const controller = new AbortController();
    let calls = 0;
    const events = await drain(
      runTextWithTools(
        'openai_api',
        [ADDER],
        'c',
        TURNS,
        TOOL_CAP,
        'auto',
        () => {
          calls += 1;
          // The run is cancelled while the budget-EXHAUSTING exchange is in
          // flight — the abort is the truer fact for operator intent, so
          // `cancelled` must win over `permanent` ("tool budget").
          if (calls === 2) controller.abort();
          return Promise.resolve({
            type: 'toolUse' as const,
            usage: USAGE,
            latencyMs: 5,
            calls: [{ id: `t${calls}`, name: 'adder', args: { a: 1, b: 2 } }],
            buildNext: () => 'next',
          });
        },
        1,
        controller.signal,
      ),
    );
    const last = events[events.length - 1]!;
    expect(last).toMatchObject({ type: 'failed', kind: 'cancelled' });
    // The exhausting exchange is still billed → metered before the terminal.
    expect(events.filter((e) => e.type === 'metered')).toHaveLength(2);
  });

  // #605 — every round is captured, each recording the turns that call SENT:
  // the author's, then each earlier round's calls and results.
  describe('capture per round (#605)', () => {
    const capturesOf = (events: ActivityEvent[]): LlmCapture[] =>
      events.flatMap((e) => (e.type === 'captured' ? [e.capture] : []));
    const twoRounds = () => {
      let n = 0;
      return () => {
        n += 1;
        if (n === 1) {
          return Promise.resolve({
            type: 'toolUse' as const,
            usage: USAGE,
            latencyMs: 7,
            calls: [
              { id: 't1', name: 'adder', args: { a: 1, b: 2 } },
              { id: 't2', name: 'mystery', args: {} },
            ],
            buildNext: () => 'conv1',
          });
        }
        return Promise.resolve({
          type: 'text' as const,
          usage: USAGE,
          latencyMs: 9,
          completionText: 'it is 3',
          succeeded: SUCCEEDED,
        });
      };
    };

    it("records the earlier round's calls and results in the next capture's request", async () => {
      const events = await drain(
        runTextWithTools(
          'anthropic_api',
          [ADDER],
          'conv0',
          TURNS,
          TOOL_CAP,
          'auto',
          twoRounds(),
          2,
        ),
      );
      const [first, second] = capturesOf(events);
      // Round 0: the author's turn only, and no completion — it asked for tools.
      expect(first!.latencyMs).toBe(7);
      expect(first!.request.messages).toEqual([
        expect.objectContaining({ role: 'user', text: 'add 1 and 2' }),
      ]);
      expect(first!.completion).toBeUndefined();
      expect(first!.request.system).toMatchObject({ text: 'be terse' });
      // Round 1: the author's turn, the calls, then one turn per result.
      const callsJson = JSON.stringify([
        { name: 'adder', args: { a: 1, b: 2 } },
        { name: 'mystery', args: {} },
      ]);
      expect(second!.latencyMs).toBe(9);
      expect(second!.request.messageCount).toBe(4);
      expect(
        second!.request.messages.map(({ role, toolTurn, text }) => ({ role, toolTurn, text })),
      ).toEqual([
        { role: 'user', toolTurn: undefined, text: 'add 1 and 2' },
        { role: 'assistant', toolTurn: 'calls', text: callsJson },
        { role: 'user', toolTurn: 'result', text: '3' },
        { role: 'user', toolTurn: 'error', text: "unknown tool 'mystery'" },
      ]);
      expect(second!.completion).toMatchObject({ text: 'it is 3' });
      // An author turn carries no marker at all, not an undefined one.
      expect('toolTurn' in second!.request.messages[0]!).toBe(false);
    });

    it("hashes a result turn exactly as that call's toolCalled resultHash", async () => {
      const events = await drain(
        runTextWithTools(
          'anthropic_api',
          [ADDER],
          'conv0',
          TURNS,
          TOOL_CAP,
          'auto',
          twoRounds(),
          2,
        ),
      );
      const resultHashes = events.flatMap((e) =>
        e.type === 'toolCalled' ? [e.call.resultHash] : [],
      );
      const second = capturesOf(events)[1]!;
      expect(second.request.messages.slice(2).map((m) => m.contentHash)).toEqual(resultHashes);
    });

    it('keeps an unparseable OpenAI argument string and a nameless call as sent', async () => {
      let n = 0;
      const events = await drain(
        runTextWithTools('openai_api', [ADDER], 'c', TURNS, TOOL_CAP, 'auto', () => {
          n += 1;
          return n === 1
            ? Promise.resolve({
                type: 'toolUse' as const,
                usage: USAGE,
                latencyMs: 1,
                calls: [{ id: 't1', name: null, args: '{not json' }],
                buildNext: () => 'next',
              })
            : Promise.resolve({
                type: 'text' as const,
                usage: USAGE,
                latencyMs: 1,
                completionText: 'done',
                succeeded: SUCCEEDED,
              });
        }),
      );
      const calls = capturesOf(events)[1]!.request.messages[1]!;
      expect(calls.text).toBe('[{"name":null,"args":"{not json"}]');
      expect(capturesOf(events)[1]!.request.messages[2]!.toolTurn).toBe('error');
    });

    it('records an unserializable call as args: null without blanking the others', async () => {
      let n = 0;
      const events = await drain(
        runTextWithTools('anthropic_api', [ADDER], 'c', TURNS, TOOL_CAP, 'auto', () => {
          n += 1;
          return n === 1
            ? Promise.resolve({
                type: 'toolUse' as const,
                usage: USAGE,
                latencyMs: 1,
                calls: [
                  { id: 't1', name: 'adder', args: { a: 1, b: 2 } },
                  { id: 't2', name: 'adder', args: { a: 10n } },
                ],
                buildNext: () => 'next',
              })
            : Promise.resolve({
                type: 'text' as const,
                usage: USAGE,
                latencyMs: 1,
                completionText: 'done',
                succeeded: SUCCEEDED,
              });
        }),
      );
      expect(capturesOf(events)[1]!.request.messages[1]!.text).toBe(
        '[{"name":"adder","args":{"a":1,"b":2}},{"name":"adder","args":null}]',
      );
    });

    it('captures a later round that ends in a terminal, before the failure', async () => {
      let n = 0;
      const events = await drain(
        runTextWithTools('ollama', [ADDER], 'c', TURNS, TOOL_CAP, 'auto', () => {
          n += 1;
          return n === 1
            ? Promise.resolve({
                type: 'toolUse' as const,
                usage: USAGE,
                latencyMs: 1,
                calls: [{ id: null, name: 'adder', args: { a: 1, b: 2 } }],
                buildNext: () => 'next',
              })
            : Promise.resolve({
                type: 'terminal' as const,
                event: { type: 'failed' as const, kind: 'transient' as const, error: 'boom' },
                latencyMs: 4,
              });
        }),
      );
      expect(events.map((e) => e.type)).toEqual([
        'metered',
        'captured',
        'toolCalled',
        'captured',
        'failed',
      ]);
      const last = capturesOf(events)[1]!;
      expect(last.latencyMs).toBe(4);
      expect(last.request.messages).toHaveLength(3);
      expect(last.completion).toBeUndefined();
    });

    it('captures the billed round before a cancelled terminal', async () => {
      const controller = new AbortController();
      const events = await drain(
        runTextWithTools(
          'anthropic_api',
          [ADDER],
          'c',
          TURNS,
          TOOL_CAP,
          'auto',
          () => {
            controller.abort();
            return Promise.resolve({
              type: 'toolUse' as const,
              usage: USAGE,
              latencyMs: 1,
              calls: [{ id: 't1', name: 'adder', args: { a: 1, b: 2 } }],
              buildNext: () => 'next',
            });
          },
          3,
          controller.signal,
        ),
      );
      expect(events.map((e) => e.type)).toEqual(['metered', 'captured', 'failed']);
      expect(events[2]).toMatchObject({ kind: 'cancelled' });
    });

    it('stores hashes but no text for a metadata-mode node', async () => {
      const events = await drain(
        runTextWithTools(
          'anthropic_api',
          [ADDER],
          'conv0',
          TURNS,
          { model: 'm' },
          'auto',
          twoRounds(),
          2,
        ),
      );
      for (const m of capturesOf(events)[1]!.request.messages) {
        expect(m.text).toBeUndefined();
        expect(m.contentHash).toMatch(/^[0-9a-f]{64}$/);
      }
    });
  });

  it('defaults to the single L10a round-trip when no budget is passed', async () => {
    const events = await drain(
      runTextWithTools('ollama', [ADDER], 'conv0', TURNS, TOOL_CAP, 'auto', scripted(99)),
    );
    const last = events[events.length - 1]!;
    expect(last).toMatchObject({ type: 'failed', kind: 'permanent' });
    if (last.type === 'failed') expect(last.error).toMatch(/tool budget/);
    expect(events.filter((e) => e.type === 'metered')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'toolCalled')).toHaveLength(1);
  });
});

describe('toolCallTelemetry (#2 L10b — fail-closed shape rules)', () => {
  it('omits hashes for zero-length args/result (never hash(""))', () => {
    const t = toolCallTelemetry(
      1,
      { id: null, name: 'echo', args: undefined },
      { id: null, name: 'echo', resultText: '', isError: false },
    );
    expect(t).toEqual({
      round: 1,
      toolName: 'echo',
      argsChars: 0,
      resultChars: 0,
      isError: false,
    });
    expect(t.callId).toBeUndefined();
    expect(t.argsHash).toBeUndefined();
    expect(t.resultHash).toBeUndefined();
  });

  it('measures unserializable args as 0 instead of throwing (circular reference)', () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const t = toolCallTelemetry(
      2,
      { id: 'c1', name: 'echo', args: circular },
      { id: 'c1', name: 'echo', resultText: 'ok', isError: false },
    );
    expect(t.argsChars).toBe(0);
    expect(t.argsHash).toBeUndefined();
    expect(t.resultChars).toBe(2);
  });

  it('uses the EXECUTED name (may be empty for a nameless malformed call)', () => {
    const t = toolCallTelemetry(
      0,
      { id: 'x', name: null, args: { a: 1 } },
      { id: 'x', name: '', resultText: 'malformed tool call: no tool name', isError: true },
    );
    expect(t.toolName).toBe('');
    expect(t.callId).toBe('x');
    expect(t.isError).toBe(true);
  });
});

describe('normalizeModelId (#751)', () => {
  it.each([
    // Anthropic: the docs list the bare id as the ALIAS and the dated string as
    // the FULL ID of the same model, so the capability fact transfers by
    // documented identity rather than by inference.
    ['an anthropic dated full id', 'claude-opus-4-1-20250805', 'claude-opus-4-1'],
    ['a dated haiku full id', 'claude-haiku-4-5-20251001', 'claude-haiku-4-5'],
    // OpenAI dates are dash-separated rather than compact.
    ['an openai dated snapshot', 'o3-2025-04-16', 'o3'],
  ])('reduces %s to its base id', (_label, input, expected) => {
    expect(normalizeModelId(input)).toBe(expected);
  });

  it.each([
    // The whole risk of this helper is a FALSE MERGE onto a set member that is a
    // DIFFERENT model. OpenAI's set holds `o3` and `o3-mini` as separate
    // members, so a rule that stripped any trailing token would silently refuse
    // sampling params on the wrong model. Nothing but a date or a bracket is
    // stripped, and these pin that.
    ['a sibling -mini id', 'o3-mini'],
    ['a codex sibling', 'gpt-5.1-codex-mini'],
    ['a -latest pointer', 'codex-mini-latest'],
    ['a plain alias', 'claude-opus-4-8'],
    ['an unknown id', 'gpt-4o'],
    ['the empty string', ''],
    // A Vertex `@`-snapshot and a bracketed variant are BOTH left alone — see the
    // docblock. The `@` form exists only on a non-first-party endpoint, and the
    // anthropic preflight has no first-party gate, so normalising it would aim
    // its whole effect at a surface this module claims no facts about; a `[1m]`
    // context variant is an inference rather than a published identity and #751
    // scoped itself to the date form.
    ['a vertex @-separated snapshot', 'claude-opus-4-5@20251101'],
    ['a bracketed context variant', 'claude-opus-4-8[1m]'],
    // A proxied Bedrock id keeps its `anthropic.` prefix DELIBERATELY: those are
    // reachable only through a proxied baseUrl, the anthropic preflight has no
    // first-party gate, and `anthropic.ts` records that the preflight is not the
    // remedy for Bedrock. Stripping it would manufacture a refusal on exactly
    // the surface this module declines to claim facts about.
    ['a bedrock-prefixed id', 'anthropic.claude-opus-4-8'],
    ['a cross-region bedrock id', 'us.anthropic.claude-opus-4-8'],
  ])('leaves %s untouched', (_label, input) => {
    expect(normalizeModelId(input)).toBe(input);
  });

  it('does not strip a date that is part of the published id itself', () => {
    // `claude-3-haiku-20240307` has no dated/undated alias pair — the date IS
    // the id. Normalising yields a string no provider serves, which is harmless
    // for set lookup (neither form is a member) but must not be mistaken for a
    // real id. Pinned so #729's retired ids stay permitted either way.
    expect(normalizeModelId('claude-3-haiku-20240307')).toBe('claude-3-haiku');
  });

  it.each([
    ['claude-opus-4-20250514', 'claude-opus-4', 'claude-opus-4-0'],
    ['claude-sonnet-4-20250514', 'claude-sonnet-4', 'claude-sonnet-4-0'],
  ])(
    'does NOT reach the alias for the Claude 4.0 family: %s',
    (full, normalised, publishedAlias) => {
      // The one family where a date strip misses its own alias, because the alias
      // carries a `-0` the dated id does not. Documented on the helper; pinned
      // here so it is enforced rather than merely written down.
      //
      // Harmless (both aliases are NON-members, which #729 closed as retired
      // models, so this is one non-member reducing to another), but it means any
      // entry ever added for either alias MUST list both spellings or it will not be found for the
      // dated form — the exact spelling-dependent divergence #751 exists to
      // remove. This assertion fails the day someone "fixes" the normaliser into
      // guessing the `-0` back on, which would be a fabricated mapping.
      expect(normalizeModelId(full)).toBe(normalised);
      expect(normalizeModelId(full)).not.toBe(publishedAlias);
    },
  );
});

describe('emptyTruncationWarning (#750 — a completion that is EMPTY *and* truncated)', () => {
  // The pairs the detector must judge. `true` = a warning is owed; `false` = the
  // #461 contract stands untouched and NOTHING is said. Every silent case is a
  // deliberate fail-SAFE: an absent truncation fact is never manufactured into a
  // claim (the same rule that keeps `MODELS_REJECTING_*` from guessing).
  const cases: [name: string, outputs: Record<string, unknown>, warns: boolean][] = [
    ['OpenAI/Ollama truncation with no visible text', { text: '', stopReason: 'length' }, true],
    [
      'Anthropic truncation with an explicit empty text block',
      { text: '', stopReason: 'max_tokens' },
      true,
    ],
    [
      'a truncated but NON-empty completion — partial text IS a real result',
      { text: 'x', stopReason: 'length' },
      false,
    ],
    [
      'an empty completion the provider did NOT truncate (the #461 case)',
      { text: '', stopReason: 'end_turn' },
      false,
    ],
    ['an empty completion that stopped normally', { text: '', stopReason: 'stop' }, false],
    [
      "`agent_cli`'s `unknown` sentinel — an unread stopReason is not a truncation",
      { text: '', stopReason: 'unknown' },
      false,
    ],
    ['a structured-output node — no `text` output exists at all', { value: { ok: true } }, false],
    [
      'a non-string `text` (defence: the adapter contract says string)',
      { text: null, stopReason: 'length' },
      false,
    ],
    ['an absent stopReason', { text: '' }, false],
    [
      'a case-variant token — no fuzzy matching, so a gateway spelling stays silent',
      { text: '', stopReason: 'LENGTH' },
      false,
    ],
  ];

  for (const [name, outputs, warns] of cases) {
    it(`${warns ? 'WARNS' : 'stays silent'}: ${name}`, () => {
      const warning = emptyTruncationWarning(outputs);
      if (warns) {
        expect(warning, name).toBeTypeOf('string');
        // The matched token is quoted back so the operator can branch on the same
        // value `${nodes.x.output.stopReason}` carries.
        expect(warning).toContain(String(outputs['stopReason']));
      } else {
        expect(warning, name).toBeNull();
      }
    });
  }

  it('the table is EXACTLY the two sourced truncation tokens', () => {
    // A membership pin, mirroring `openai-models.test.ts` / `anthropic-models.test.ts`:
    // every member must be citable to a provider's documented vocabulary, so adding
    // one has to argue with this test rather than slip in. `length` = OpenAI
    // `finish_reason` + Ollama `done_reason`; `max_tokens` = Anthropic `stop_reason`.
    expect([...TRUNCATION_STOP_REASONS].sort()).toEqual(['length', 'max_tokens']);
  });

  it('quotes ONLY the matched stopReason token — never any of the outputs', () => {
    // The warning rides a durable event, so it must not become a side channel for
    // model text that `redactEventPlaintexts` never inspects.
    const warning = emptyTruncationWarning({
      text: '',
      stopReason: 'length',
      secretish: 'hunter2',
    });
    expect(warning).not.toContain('hunter2');
  });
});
