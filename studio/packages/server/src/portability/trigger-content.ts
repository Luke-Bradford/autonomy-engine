import { triggerContentForm, type TriggerExportData } from '@autonomy-studio/shared';

/**
 * #3 G7 — the single definition of the "an unbound trigger can never be enabled"
 * rule. An unbound trigger (no resolvable binding) folds `enabled` to `false`
 * (belt to the P4 scheduler's fire-time `trigger_unbound` guard: it also keeps
 * the row out of `isSchedulable`, so `sync()` never arms it); a bound trigger
 * keeps its authored `enabled`. Shared by `buildTriggerWriteInput` (the DB write
 * the reconcile persists) and `normalizedTriggerContentForm` (the resolved-space
 * content compare) so the two can NEVER disagree on an unbound trigger's enabled
 * state — the disagreement was the source of the force-disabled-unbound churn.
 */
export function enabledForBinding(hasBinding: boolean, authoredEnabled: boolean): boolean {
  return hasBinding ? authoredEnabled : false;
}

/**
 * #3 G7 — the canonical content form of an INCOMING branch trigger, computed in
 * RESOLVED space. The reconcile classifier and apply compare a branch trigger's
 * content form against the stored DB trigger's form (`serializeTrigger`, which
 * renders a null binding as `null` and a bound one via the ALL-versions map — so
 * the DB side is already resolved and needs no normalization, only the incoming
 * side does).
 *
 * A branch trigger whose `pipelineVersionId` resourceId does NOT resolve to an
 * owned version (`resolves(rid)` false — the "absent → disabled" charter) is
 * normalized to `(null, disabled)` BEFORE forming — exactly what `applyWorkspace`
 * would persist. Without this, such a trigger churns `update` on every import
 * forever: its raw form carries the dangling resourceId (and authored `enabled`)
 * while the DB row the apply force-disabled serializes to `(null, false)`.
 *
 * Crucially `enabled` STAYS authoring content: it is folded to `false` ONLY when
 * the binding is unresolvable (via `enabledForBinding`); a genuine enable/disable
 * on a BOUND trigger still differs here, so a committed enable/disable still
 * propagates on pull. That is the whole point of the resolved-space approach over
 * blanket-excluding `enabled` from the content form (#668).
 */
export function normalizedTriggerContentForm(
  data: TriggerExportData,
  resolves: (resourceId: string) => boolean,
): string {
  const rid = data.pipelineVersionId;
  const bound = rid !== null && resolves(rid);
  if (bound) return triggerContentForm(data); // resolvable — the raw form is already resolved
  return triggerContentForm({
    ...data,
    pipelineVersionId: null,
    enabled: enabledForBinding(false, data.enabled),
  });
}
