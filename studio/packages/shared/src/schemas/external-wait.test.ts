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

  /* The projection's "the row's own fields never cross the wire" property is NOT
     asserted here. A test that parsed `{...WAIT, tokenHash, status}` and found them
     stripped would be asserting `z.object`'s behaviour, not this schema's — it
     would pass just as happily on `z.object({})`. What actually pins it is the
     exact key set of the REAL response, which only the route can produce; that
     assertion lives in `server/src/routes/__tests__/external-wait.test.ts`. */

  it.each([
    ['negative', -1],
    ['zero', 0],
    ['fractional', 3.7],
    ['NaN', Number.NaN],
  ])('refuses a %s expiresAt', (_label, expiresAt) => {
    // The docblock promises epoch ms. Without these the contract admits all four,
    // and every reader has to re-assert the range to get back what it was told.
    expect(() => PendingExternalWaitSchema.parse({ ...WAIT, expiresAt })).toThrow();
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
