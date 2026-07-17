import { describe, expect, it } from 'vitest';
import { FireOutcomeSchema, FireRequestSchema, FireResultSchema } from './fire-result.js';

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

describe('FireRequestSchema (run-now override — #5 S12b + #547)', () => {
  it('accepts a bare body (plain "run now") and an empty params record', () => {
    expect(FireRequestSchema.parse({})).toEqual({});
    expect(FireRequestSchema.parse({ params: {} })).toEqual({ params: {} });
  });

  it('accepts finite run-now overrides (incl. nested json)', () => {
    const body = { params: { topic: 'news', n: 1e308, cfg: { a: [1, 2] } } };
    expect(FireRequestSchema.parse(body)).toEqual(body);
  });

  // #547 — a run-now override is frozen into run.params → run.started; a
  // non-finite (incl. nested in a json override) is refused at this write
  // boundary before it can become a silently-lossy run fact.
  it('rejects a non-finite run-now override value (#547)', () => {
    expect(() => FireRequestSchema.parse({ params: { x: Infinity } })).toThrow(
      /non-finite number refused/,
    );
    expect(() => FireRequestSchema.parse({ params: { cfg: { deep: [Number.NaN] } } })).toThrow(
      /non-finite number refused/,
    );
  });
});
