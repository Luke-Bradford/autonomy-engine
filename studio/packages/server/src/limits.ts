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

/**
 * #1119 M4 — how many rows a dataset read pulls from the store before it yields
 * to the event loop (data-movement spec §9).
 *
 * A batch is a SCHEDULING QUANTUM as much as a read unit, and §9 settles why:
 * `better-sqlite3` is synchronous and `worker_threads` appears nowhere in this
 * package, so an in-process scan that drains a cursor in one call blocks the
 * event loop — and with it the driver pump, the SSE stream and the whole HTTP
 * API. Bounding the pull and yielding between pulls is what keeps a long copy
 * from stalling the server, which is also why cancellation and progress are both
 * defined at batch boundaries (§5, §10).
 *
 * It lives HERE rather than beside its consumer, and the departure is worth
 * naming because `RETENTION_BATCH` (`repo/retention.ts`) and
 * `DEFAULT_MAX_LIST_ENTRIES` (`connectors/fs.ts`) both sit next to theirs: §5
 * and §9 name `limits.ts` explicitly as where the data-movement bounds go, and
 * the ones still to come (`LOOKUP_ROW_CAP`, `LOOKUP_BYTE_CAP` at M12) are read
 * by more than one consumer, so the set belongs in one place.
 *
 * `COPY_CONCURRENCY` — §9's OTHER budget — deliberately does NOT land here yet.
 * It bounds how many copies run at once, which is meaningless until an activity
 * consumes it, so it belongs with `copy` at M5.
 */
export const COPY_BATCH_ROWS = 1000;
