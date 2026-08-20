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
 * `COPY_CONCURRENCY` — §9's OTHER budget — deliberately does NOT land here yet,
 * and this note is AMENDED rather than discharged by M5 finishing. It said the
 * constant "belongs with `copy` at M5"; slice 4c (#1139) is M5's last slice and
 * did not add it, because the premise was wrong. Nothing in the executor reads a
 * PER-ACTIVITY concurrency limit: `executor.ts` holds one global `pLimit`, and
 * `driver.ts` a per-run dispatch cap. A copy budget is therefore net-new
 * plumbing, not a constant slotting into an existing consumer. Filed as #1140;
 * the residual is that `copy` is reachable from 4c onward, so §9's "long copies
 * hold every global adapter slot" hazard is live, mitigated by the batch-yield
 * half of §9 which IS built (the reader yields between batches).
 */
export const COPY_BATCH_ROWS = 1000;

/**
 * #1125 M5 slice 2 — how long a SQLite open/lock may wait before it reports
 * `SQLITE_BUSY`, in milliseconds.
 *
 * This exists because better-sqlite3's default is 5000ms and that default is a
 * **synchronous busy-wait**, which is precisely the §9 hazard the data-movement
 * spec forbids: "an in-process SQLite scan blocks the event loop, and with it
 * the driver pump, the SSE stream and the whole HTTP API."
 *
 * Measured cross-process on better-sqlite3 12.11.1: with process A holding
 * `BEGIN IMMEDIATE`, process B's `db.exec('begin immediate')` blocked for
 * **2868ms during which ZERO `setInterval` ticks fired**. Nothing yields; the
 * whole server is frozen for the duration. Lowering the ceiling does not make
 * contention succeed more often — it makes the failure arrive fast, as
 * `SQLITE_BUSY`, which `isTransientSqliteCode` already classifies `transient`
 * and which a copy can therefore retry from row 0 safely (§4.1: the transaction
 * guarantees no partial write survived).
 *
 * 250ms is chosen to absorb a brief overlap — a checkpoint, another connection
 * committing — without ever being a stall an operator would notice. The tradeoff
 * is stated rather than hidden: a store under sustained write contention will
 * report `transient` sooner than it would with the default, and retry is the
 * mechanism that handles it. That is the correct polarity for a shared server.
 *
 * It applies to the READER too, whose opens carried the 5000ms default from M4.
 * The residual is the same on both sides and there is no reason to fix half of
 * it in the file being edited.
 */
export const SQLITE_BUSY_TIMEOUT_MS = 250;

/**
 * #996 M7 slice 2 (#1165) — how much of a file a streaming read pulls per
 * syscall, in bytes.
 *
 * ONE constant for both streaming file readers, which is the point of naming
 * it: `file_copy` has streamed at 64 KiB since A12 (as a bare
 * `Buffer.allocUnsafe(64 * 1024)`) and the `delimited` dataset reader wants the
 * identical granularity for the identical reason — a read that is memory-bounded
 * regardless of file size. Two spellings of one number is how they drift.
 *
 * It is a throughput/RSS tradeoff and nothing more: no behaviour depends on the
 * value, because both consumers are chunk-boundary-independent by construction
 * (the CSV grammar is a single pass with no lookahead, and `TextDecoder`
 * carries a partial multi-byte sequence across `{ stream: true }` calls).
 */
export const FS_STREAM_CHUNK_BYTES = 64 * 1024;

/**
 * #996 M7 slice 2 (#1165) — the `delimited` reader's accumulation bounds, in
 * CODE POINTS.
 *
 * NOT BYTES, and the distinction is the parser's, not a nicety
 * (`shared/datamove/delimited.ts`): the grammar runs on already-decoded text and
 * iterates code points, so charging UTF-16 units would bill an astral character
 * twice to one bound and once to the other. `bytesRead` is a different
 * measurement made at a different place (§5, at the copy boundary).
 *
 * They exist because "yields a stream" and "never holds the whole file" are
 * different properties and only the second is what §12 asks M7 for. A binary, a
 * gzip, or a CSV with one unclosed quote has no row terminator the grammar can
 * find, so an UNBOUNDED machine would accumulate the entire file into a single
 * field — satisfying the streaming signature while violating its whole point.
 *
 * `DELIMITED_MAX_ROW_CHARS` must stay >= `DELIMITED_MAX_FIELD_CHARS`, or the
 * field bound is unreachable and only ever reports as a row overflow. The row
 * bound charges EVERY character the row consumed, including delimiters and
 * quoting, because the row ARRAY is the accumulator that has to be bounded —
 * `,,,,,…` adds no character to any field and would otherwise grow without
 * limit.
 *
 * The values are deliberately generous. A 1 MiB single CSV field is already
 * pathological, and 8 MiB per row is far more than any real record; the bounds
 * are here to make a MALFORMED file fail fast, not to police a large one.
 */
export const DELIMITED_MAX_FIELD_CHARS = 1_048_576;
export const DELIMITED_MAX_ROW_CHARS = 8_388_608;
