import { describe, expect, it } from 'vitest';
import { resolveTriggerBindings, validateTriggerBindings } from '../engine/params.js';
import { TriggerContextSchema } from './trigger-context.js';

const base = {
  triggerId: 'trig_1',
  scheduledTime: '2026-07-22T01:00:00.000Z',
  body: null,
};

describe('TriggerContextSchema', () => {
  it('round-trips the S12 shape (no windowEpoch — every pre-S10 row/event)', () => {
    const parsed = TriggerContextSchema.parse(base);
    expect(parsed).toEqual(base);
    expect(parsed.windowEpoch).toBeUndefined();
  });

  it('round-trips a tumbling fire context carrying windowEpoch (#5 S10)', () => {
    const tc = { ...base, windowEpoch: 'abcd1234abcd1234' };
    expect(TriggerContextSchema.parse(tc)).toEqual(tc);
  });
});

describe('windowEpoch is NOT expression-visible (#5 S10)', () => {
  // `windowEpoch` is an internal run↔window linkage fact (the epoch-scoped
  // `findUnlinkedRunForWindow` join) — NOT part of the closed `${trigger.*}`
  // surface. `${trigger.windowStart/End}` is S11's ticket; leaking the raw
  // epoch hash now would freeze an internal identity scheme into user docs.
  it('save-time gate refuses ${trigger.windowEpoch}', () => {
    expect(validateTriggerBindings({ x: '${trigger.windowEpoch}' })).not.toEqual([]);
  });

  it('fire-time resolution throws even when the context CARRIES windowEpoch', () => {
    expect(() =>
      resolveTriggerBindings(
        { x: '${trigger.windowEpoch}' },
        { ...base, windowEpoch: 'abcd1234abcd1234' },
      ),
    ).toThrow(/unknown trigger field/);
  });
});
