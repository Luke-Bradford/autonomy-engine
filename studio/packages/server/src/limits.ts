/**
 * The most validation issues from a single doc that any error response echoes
 * back to the caller — in EITHER representation it can take:
 *   - the response `issues[]` array (`errors.ts`, for BOTH the `validation_error`
 *     and `invalid_pipeline_doc` branches), and
 *   - the joined human `message` of `InvalidPipelineDocError` (`repo/pipeline-versions.ts`).
 *
 * ONE constant, deliberately: both representations describe the SAME underlying
 * list, and the whole point is that neither re-emits it in full — a doc whose
 * issue count is proportional to its node/container count must not produce an
 * O(doc) body. Beyond this cap the tail is dropped and the truncation is STATED
 * (`truncated`/`totalIssues`, or "…and N more"), never silently — an absent fact
 * must not be manufactured as "that was all of them" (the F13a/#473 rule; #496).
 *
 * Deliberately well below the durable `RUN_DIAGNOSTIC_CAP` (500): this is a
 * synchronous 4xx returned to the caller who just sent the doc, not a durable
 * diagnostic log — 100 already exceeds what any human reads at once, and the
 * full count is still stated.
 */
export const ISSUE_LIST_CAP = 100;
