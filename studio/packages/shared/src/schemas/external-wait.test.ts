import { describe, expect, it } from 'vitest';
import { PendingExternalWaitListSchema, PendingExternalWaitSchema } from './external-wait.js';

const WAIT = {
  nodeId: 'approve',
  attemptId: 'a1',
  expiresAt: 1_770_000_000_000,
  callbackPath: '/api/external-wait/deadbeef',
};

describe('PendingExternalWaitSchema', () => {
  it('accepts the shape the route serves', () => {
    expect(PendingExternalWaitSchema.parse(WAIT)).toEqual(WAIT);
  });

  it('accepts a parallel foreach instance key as the parked node id', () => {
    // The parked id is whatever the engine parked, which for a `foreach` body is
    // an instance key — the client resolves it to a doc node, so the CONTRACT
    // must not refuse it here.
    expect(PendingExternalWaitSchema.parse({ ...WAIT, nodeId: 'approve@1' }).nodeId).toBe(
      'approve@1',
    );
  });

  it.each(['nodeId', 'attemptId', 'expiresAt', 'callbackPath'] as const)(
    'refuses a response missing %s',
    (key) => {
      const rest: Record<string, unknown> = { ...WAIT };
      delete rest[key];
      expect(() => PendingExternalWaitSchema.parse(rest)).toThrow();
    },
  );

  it('refuses an empty callbackPath', () => {
    // An empty path would render as a callback URL that resumes nothing — a
    // silent dead end wearing the shape of a live one.
    expect(() => PendingExternalWaitSchema.parse({ ...WAIT, callbackPath: '' })).toThrow();
  });

  it('refuses a null expiresAt', () => {
    // A13 REQUIRES a webhook timeout, so a parked wait always has a live expiry
    // alarm. Modelling it as nullable would invite a UI that says "no expiry".
    expect(() => PendingExternalWaitSchema.parse({ ...WAIT, expiresAt: null })).toThrow();
  });

  it('does not carry the stored token hash or the row status through', () => {
    const parsed = PendingExternalWaitSchema.parse({
      ...WAIT,
      tokenHash: 'abc',
      status: 'pending',
    }) as Record<string, unknown>;
    expect(parsed['tokenHash']).toBeUndefined();
    expect(parsed['status']).toBeUndefined();
  });
});

describe('PendingExternalWaitListSchema', () => {
  it('accepts an empty list — a run parked on a TIMER owes no callback', () => {
    expect(PendingExternalWaitListSchema.parse([])).toEqual([]);
  });

  it('refuses a bare object', () => {
    expect(() => PendingExternalWaitListSchema.parse(WAIT)).toThrow();
  });
});
