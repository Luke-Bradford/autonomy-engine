import { triggerContentForm, type TriggerExportData } from '@autonomy-studio/shared';
import { describe, expect, it } from 'vitest';
import { enabledForBinding, normalizedTriggerContentForm } from '../trigger-content.js';

function triggerData(overrides: Partial<TriggerExportData> = {}): TriggerExportData {
  return {
    id: 'tr_1',
    resourceId: 'res_tr_1',
    ownerId: 'local',
    name: 'My Trigger',
    pipelineVersionId: 'res_pv_1',
    params: {},
    mode: 'manual',
    schedule: null,
    recurrence: null,
    webhook: null,
    event: null,
    window: null,
    concurrency: { policy: 'queue' },
    runWindows: null,
    enabled: true,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

describe('enabledForBinding — the single unbound⇒disabled rule', () => {
  it('forces disabled when unbound, regardless of authored intent', () => {
    expect(enabledForBinding(false, true)).toBe(false);
    expect(enabledForBinding(false, false)).toBe(false);
  });
  it('preserves authored enabled when bound', () => {
    expect(enabledForBinding(true, true)).toBe(true);
    expect(enabledForBinding(true, false)).toBe(false);
  });
});

describe('normalizedTriggerContentForm — resolved-space content compare', () => {
  const resolveAll = () => true;
  const resolveNone = () => false;

  it('an UNRESOLVABLE binding collapses to (null, disabled) — kills the absent→disabled churn', () => {
    // A branch trigger authored enabled+bound to a version absent from this
    // workspace normalizes to exactly what the apply persists: null + disabled.
    const dangling = normalizedTriggerContentForm(
      triggerData({ pipelineVersionId: 'res_absent', enabled: true }),
      resolveNone,
    );
    const persisted = normalizedTriggerContentForm(
      triggerData({ pipelineVersionId: null, enabled: false }),
      resolveNone,
    );
    expect(dangling).toBe(persisted);
  });

  it('an authored-NULL binding also normalizes to disabled (matches force-disable)', () => {
    const authoredNullEnabled = normalizedTriggerContentForm(
      triggerData({ pipelineVersionId: null, enabled: true }),
      resolveAll,
    );
    const disabled = normalizedTriggerContentForm(
      triggerData({ pipelineVersionId: null, enabled: false }),
      resolveAll,
    );
    expect(authoredNullEnabled).toBe(disabled);
  });

  it('a RESOLVABLE binding preserves both the binding and authored enabled', () => {
    // Equal to the raw form — no normalization when the binding resolves.
    expect(normalizedTriggerContentForm(triggerData({ enabled: true }), resolveAll)).toBe(
      triggerContentForm(triggerData({ enabled: true })),
    );
    // Authored enable/disable on a BOUND trigger still differs → still propagates.
    expect(normalizedTriggerContentForm(triggerData({ enabled: false }), resolveAll)).not.toBe(
      normalizedTriggerContentForm(triggerData({ enabled: true }), resolveAll),
    );
  });

  it('a rebind between two RESOLVABLE versions is still a real content change', () => {
    expect(
      normalizedTriggerContentForm(triggerData({ pipelineVersionId: 'res_pv_A' }), resolveAll),
    ).not.toBe(
      normalizedTriggerContentForm(triggerData({ pipelineVersionId: 'res_pv_B' }), resolveAll),
    );
  });
});
