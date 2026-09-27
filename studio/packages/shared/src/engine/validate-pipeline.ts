// The COMPLETE static validation of a pipeline doc (#444, #844 V5).
import { variableReadsOf, type ValidateDocOptions, type ValidatedDoc } from './params.js';
import { variableGuardErrors } from './variable-guard.js';

/**
 * The COMPLETE static validation of a pipeline doc: the union of the two pure
 * validators. This is the SSOT for *which* rules a doc must satisfy, and both
 * gates call it — the canvas badge (`web/.../canvasDoc.ts`) and the server
 * write-gate (`server/.../repo/pipeline-versions.ts`, #444).
 *
 * It exists so those two can never drift apart. Hand-composing the two calls at
 * each site would make "the badge shows exactly what the server refuses" a
 * convention that holds only while every call site is remembered — the same
 * per-site-convention class that silently dropped `containers` in #473. Here it
 * holds by construction.
 *
 * `containers` is load-bearing for BOTH halves, not just the structural one: a
 * LOOP container re-runs its children, which is what makes a
 * `${nodes.<id>.status}` ref unanswerable in that doc (#6 E3).
 *
 * `options` forwards to `validateDoc` and gates the `call_pipeline` cycle+depth
 * analysis (#495). The two gates supply DIFFERENT options ON PURPOSE:
 *  - the CANVAS badge passes NONE (`canvasDoc.ts`) — it has no DB, and enforcing
 *    a rule the canvas never checked would newly 400 a doc that badges clean;
 *  - the SERVER write gate passes `{ selfId, resolvePipeline }` where
 *    `resolvePipeline` is OWNER-SCOPED (`repo/pipeline-versions.ts`, #495).
 * This function stays PURE — it does no I/O and reads no clock. The DB read the
 * call graph needs lives entirely in the resolver the SERVER injects; passing a
 * function is not an effect, and `validateDoc` only invokes whatever resolver it
 * is handed (the pure-core / injected-effect pattern `ValidateDocOptions` was
 * built for). A cycle that only manifests DYNAMICALLY (an unresolvable `${}` or
 * cross-owner callee) is still caught at run time by the reducer's `stalled`
 * backstop (#491), which the static gate does not replace.
 *
 * #844 V5 — the determinism guard (spec V-D6) runs LAST, and only on a doc both
 * validators accept: its reader list is the validators' own side output, and
 * that list is complete only when they report nothing (`variableReadsOf`). On a
 * refused doc it would judge an incomplete list, which is a false accept, so it
 * waits for the author to clear the other errors first.
 *
 * Returns error strings; `[]` means valid.
 */
export function validatePipelineDoc(
  doc: ValidatedDoc,
  options: Omit<ValidateDocOptions, 'variableReads'> = {},
): string[] {
  const { reads, validatorErrors } = variableReadsOf(doc, options);
  return validatorErrors.length > 0 ? validatorErrors : variableGuardErrors(doc, reads);
}
