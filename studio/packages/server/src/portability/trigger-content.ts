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
 * #3 G8b-3 — the readiness EXTENSION of `enabledForBinding`: the git-import twin
 * of the enable-time connection-readiness gate (routes/triggers.ts) and the
 * reverse gate (routes/connections.ts). A branch trigger imports enabled ONLY if
 * it is both bound AND its bound version's connections are READY (secrets never
 * travel in git, so a secret-requiring connection lands `needs_secret` on import
 * — an enabled trigger over it would silently never dispatch, the dispatch gate
 * refusing each fire). Composes the single-definition `enabledForBinding` so an
 * unbound OR an unready trigger both fold to disabled. Shared by
 * `buildTriggerWriteInput` (the DB write the import persists) and
 * `normalizedTriggerContentForm` (the resolved-space content compare) so the two
 * can NEVER disagree — the same idempotency posture G7 established for the
 * unbound case (else a force-disabled trigger churns `update` on every import).
 */
export function enabledForReadiness(
  hasBinding: boolean,
  connectionsReady: boolean,
  authoredEnabled: boolean,
): boolean {
  return enabledForBinding(hasBinding, authoredEnabled) && connectionsReady;
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
 *
 * #3 G8b-3 — an OPTIONAL `connectionsReady` predicate extends the fold to secret
 * READINESS: a bound trigger whose bound version's connections are NOT ready
 * folds `enabled` to `false` (keeping the binding — the version IS bound, merely
 * unready) so it matches the row `applyWorkspace` force-disables, keeping a
 * cross-workspace secret-difference import idempotent. When the predicate is
 * OMITTED (the classifier's binding-resolution-only compare when it lacks a
 * readiness domain, or any caller that does not gate readiness), a bound trigger
 * is treated ready → byte-identical to the pre-G8b-3 behavior.
 */
export function normalizedTriggerContentForm(
  data: TriggerExportData,
  resolves: (resourceId: string) => boolean,
  connectionsReady?: (resourceId: string) => boolean,
): string {
  const rid = data.pipelineVersionId;
  const bound = rid !== null && resolves(rid);
  // A bound trigger is enable-eligible only if its connections are ready; with no
  // readiness predicate a bound trigger is treated ready (pre-G8b-3 behavior).
  const ready = bound && (connectionsReady === undefined || connectionsReady(rid!));
  return triggerContentForm({
    ...data,
    pipelineVersionId: bound ? rid : null,
    enabled: enabledForReadiness(bound, ready, data.enabled),
  });
}
