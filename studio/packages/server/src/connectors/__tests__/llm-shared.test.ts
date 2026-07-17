import { describe, expect, it } from 'vitest';
import { coerceStopReason, noCompletionFailure } from '../llm-shared.js';

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
