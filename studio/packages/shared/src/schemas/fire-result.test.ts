import { describe, expect, it } from 'vitest';
import { FireOutcomeSchema, FireResultSchema } from './fire-result.js';

describe('FireOutcomeSchema', () => {
  it('accepts the three launcher outcomes', () => {
    for (const o of ['started', 'queued', 'skipped']) {
      expect(FireOutcomeSchema.parse(o)).toBe(o);
    }
  });

  it('rejects the transient webhook-only `pending` outcome', () => {
    // `pending` is a webhook-delivery ledger state, never a fire() result.
    expect(() => FireOutcomeSchema.parse('pending')).toThrow();
  });
});

describe('FireResultSchema', () => {
  it('parses a started result with a runId', () => {
    expect(FireResultSchema.parse({ outcome: 'started', runId: 'run_1' })).toEqual({
      outcome: 'started',
      runId: 'run_1',
    });
  });

  it('parses a bare queued result (no runId/reason)', () => {
    expect(FireResultSchema.parse({ outcome: 'queued' })).toEqual({ outcome: 'queued' });
  });

  it('parses a skipped result with a reason', () => {
    expect(FireResultSchema.parse({ outcome: 'skipped', reason: 'cap reached' })).toEqual({
      outcome: 'skipped',
      reason: 'cap reached',
    });
  });

  it('rejects an unknown outcome', () => {
    expect(() => FireResultSchema.parse({ outcome: 'exploded' })).toThrow();
  });
});
