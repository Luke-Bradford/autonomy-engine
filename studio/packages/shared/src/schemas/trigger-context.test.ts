import { describe, expect, it } from 'vitest';
import {
  resolveTriggerBindings,
  validateTriggerBindings,
  windowBindingErrors,
} from '../engine/params.js';
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
  // surface. The user-facing window facts are `windowStart`/`windowEnd` (S11b,
  // below); leaking the raw epoch hash would freeze an internal identity
  // scheme into user docs.
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

// #5 S11b — `${trigger.windowStart/End}`, the user-facing window bounds.
// CONTEXT-SCOPED: legal ONLY in a tumbling trigger's param bindings (the one
// save-time surface where the tumbling context is a KNOWN fact — the ADF
// `@trigger().outputs.windowStartTime` parameter-mapping idiom); a node config
// or a non-tumbling binding is refused at save.
describe('window fields in trigger bindings (#5 S11b)', () => {
  it('ACCEPTS ${trigger.windowStart/End} when window fields are in scope', () => {
    expect(
      validateTriggerBindings(
        { s: '${trigger.windowStart}', e: '${trigger.windowEnd}' },
        { windowFields: true },
      ),
    ).toEqual([]);
  });

  it('REFUSES window fields by default with the context-scoped message', () => {
    const errors = validateTriggerBindings({ s: '${trigger.windowStart}' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/tumbling trigger's param bindings/);
  });

  it('windowEpoch stays refused even with window fields in scope', () => {
    expect(
      validateTriggerBindings({ x: '${trigger.windowEpoch}' }, { windowFields: true }),
    ).not.toEqual([]);
  });

  it('names the window fields in the closed-set typo message when in scope', () => {
    const [error] = validateTriggerBindings(
      { x: '${trigger.windowstart}' },
      {
        windowFields: true,
      },
    );
    expect(error).toMatch(/windowStart/);
  });

  it('resolves window fields at fire time from a window-carrying context', () => {
    const resolved = resolveTriggerBindings(
      { s: '${trigger.windowStart}', e: '${trigger.windowEnd}' },
      {
        ...base,
        windowEpoch: 'abcd1234abcd1234',
        windowStart: '2026-07-22T00:00:00.000Z',
        windowEnd: '2026-07-22T01:00:00.000Z',
      },
    );
    expect(resolved).toEqual({
      s: '2026-07-22T00:00:00.000Z',
      e: '2026-07-22T01:00:00.000Z',
    });
  });

  it('resolves window fields to null when the fire carried none (a pre-gate row)', () => {
    // No legal write path binds a window field on a non-tumbling trigger, but a
    // stored pre-gate/hand-crafted row must fail SOFT here (null, the
    // scheduledTime-on-manual semantic) rather than throw a fire-stopping error.
    expect(resolveTriggerBindings({ s: '${trigger.windowStart}' }, base)).toEqual({ s: null });
  });
});

describe('windowBindingErrors (#5 S11b — the mode-scoping primitive)', () => {
  it('returns ONLY the window-field defects, not pre-existing binding noise', () => {
    const params = {
      s: '${trigger.windowStart}',
      bad: '${params.x}', // a pre-gate defect — must NOT leak into the window check
      ok: '${trigger.scheduledTime}',
    };
    const errors = windowBindingErrors(params);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/windowStart/);
  });

  it('is empty for a binding set with no window-field references', () => {
    expect(windowBindingErrors({ ok: '${trigger.scheduledTime}', bad: '${params.x}' })).toEqual([]);
  });

  it('a TYPO’d unknown trigger field cancels too (scope-independent message)', () => {
    // The unknown-field enumeration must be identical in both scans — a
    // scope-dependent list would make this typo differ between the runs and
    // leak into the difference as a phantom "window binding", bricking an
    // unrelated PATCH / mislabelling an import refusal (pre-PR lens finding).
    expect(windowBindingErrors({ bad: '${trigger.scheduledtime}' })).toEqual([]);
    expect(windowBindingErrors({ bad: '${trigger.windowstart}' })).toEqual([]);
  });
});

describe('TriggerContextSchema window bounds (#5 S11b)', () => {
  it('round-trips a window fire context carrying windowStart/windowEnd', () => {
    const tc = {
      ...base,
      windowEpoch: 'abcd1234abcd1234',
      windowStart: '2026-07-22T00:00:00.000Z',
      windowEnd: '2026-07-22T01:00:00.000Z',
    };
    expect(TriggerContextSchema.parse(tc)).toEqual(tc);
  });

  it('keeps both bounds ABSENT (never manufactured) for a pre-S11b row', () => {
    const parsed = TriggerContextSchema.parse(base);
    expect(parsed.windowStart).toBeUndefined();
    expect(parsed.windowEnd).toBeUndefined();
  });
});
