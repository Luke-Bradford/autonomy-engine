import { describe, expect, it } from 'vitest';
import { coerceStopReason, meterUsage, noCompletionFailure } from '../llm-shared.js';

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
