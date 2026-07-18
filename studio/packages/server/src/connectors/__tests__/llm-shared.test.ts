import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STRUCTURED_REPAIRS,
  buildRepairTurns,
  coerceStopReason,
  meterUsage,
  noCompletionFailure,
  openAiReasoningEffort,
  runStructuredWithRepair,
  structuredEcho,
} from '../llm-shared.js';
import type { LlmTurn, StructuredCallOutcome } from '../llm-shared.js';
import type { ActivityEvent, LlmUsage } from '../types.js';

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
