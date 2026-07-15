import { describe, it, expect } from 'vitest';
import { EngineEventSchema, FailureKindSchema, FAILURE_CODES } from '../types.js';

/**
 * #1 F0 — the structured failure `kind` on `node.failed`.
 *
 * `kind` is the engine's RETRY-DECISION axis (3-valued), deliberately narrower
 * than the connector adapters' 5-kind `ConnectorErrorKind`; the detail that
 * mapping drops is preserved losslessly in `code`. These tests pin the two
 * properties every later retry/policy ticket (F2a–F2c, F3) leans on: old events
 * still parse, and the field set is closed where it must be.
 */

const base = { type: 'node.failed', runId: 'r1', nodeId: 'n1', attemptId: 'n1#0' } as const;

describe('F0 — node.failed.kind parse boundary', () => {
  it('defaults an OLD stored event with NO kind to `permanent` (back-compat)', () => {
    // The spec's parse-default table: every `node.failed` already in `run_events`
    // predates this field. `permanent` is the safe default — it never retries.
    const parsed = EngineEventSchema.parse({ ...base, error: 'boom' });

    expect(parsed).toMatchObject({ type: 'node.failed', kind: 'permanent' });
  });

  it('leaves `code` absent when the producer supplies none', () => {
    const parsed = EngineEventSchema.parse({ ...base, error: 'boom' });

    expect(parsed).toMatchObject({ type: 'node.failed' });
    expect((parsed as { code?: string }).code).toBeUndefined();
  });

  for (const kind of ['transient', 'permanent', 'cancelled'] as const) {
    it(`round-trips the '${kind}' kind`, () => {
      const parsed = EngineEventSchema.parse({ ...base, error: 'boom', kind });

      expect(parsed).toMatchObject({ kind });
    });
  }

  it('round-trips an optional machine `code` alongside the kind', () => {
    const parsed = EngineEventSchema.parse({
      ...base,
      error: '429 slow down',
      kind: 'transient',
      code: FAILURE_CODES.RATE_LIMIT,
    });

    expect(parsed).toMatchObject({ kind: 'transient', code: 'rate_limit' });
  });

  it('REJECTS a kind outside the engine taxonomy (the connector 5-kind set must be mapped, not passed through)', () => {
    // `auth`/`rate_limit` are connector-level kinds. They must be mapped down at
    // the executor seam; leaking one into the log would mean the reducer has to
    // answer a policy question it does not own.
    for (const bogus of ['auth', 'rate_limit', 'nope', '']) {
      expect(() => EngineEventSchema.parse({ ...base, error: 'boom', kind: bogus })).toThrow();
    }
  });

  it('keeps `code` an OPEN vocabulary (an unknown code parses — an enum would be a back-compat trap)', () => {
    const parsed = EngineEventSchema.parse({
      ...base,
      error: 'boom',
      kind: 'permanent',
      code: 'some_future_provider_code',
    });

    expect(parsed).toMatchObject({ code: 'some_future_provider_code' });
  });

  it('exposes the closed kind set on its own schema', () => {
    expect(FailureKindSchema.options).toEqual(['transient', 'permanent', 'cancelled']);
  });

  it('reserves the `timeout` code D4/F3 mandates, so F3 cannot mint a rival spelling', () => {
    expect(FAILURE_CODES.TIMEOUT).toBe('timeout');
  });
});
