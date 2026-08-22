/**
 * `ISSUE_LIST_CAP` MOVED to `@autonomy-studio/shared`
 * (`shared/src/schemas/zod-issues.ts`) in #1183, and this pointer is left rather
 * than the constant because two of its consumers still live here.
 *
 * The move was forced by a third consumer: `formatZodIssues` is the SSOT
 * renderer for ~44 Zod-failure strings, it lives in `shared`, and `shared`
 * cannot import from `server` — so the cap had to go to the renderer, not the
 * renderer to the cap. `errors.ts`'s `capIssues` and
 * `repo/pipeline-versions.ts`'s `summarizeIssues` now import it from `shared`,
 * and the latter delegates its "…and N more" tail to the shared
 * `summarizeIssueList` so there is one spelling of it.
 */

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

/**
 * §5's bounded-streaming rule, applied to xlsx — where "stream the sheet" is
 * NOT on its own enough to bound memory.
 *
 * A worksheet streams row by row, so rows are bounded by `COPY_BATCH_ROWS` the
 * same way a CSV's are. Two things in the container are not:
 *
 * - **the shared-string table.** xlsx stores most text once in
 *   `xl/sharedStrings.xml` and cells reference it by index, so a cell cannot be
 *   resolved until the table is in hand. Memory is therefore proportional to
 *   DISTINCT STRINGS plus one row batch — never to rows, which is the property
 *   that matters, but still unbounded without a cap.
 * - **inflation.** Every entry is deflated. A zip's declared `uncompressedSize`
 *   is attacker-controlled and must never be trusted as the bound, so the count
 *   is of bytes ACTUALLY inflated, checked as they arrive.
 *
 * These are the reason the readers measured for #1213 were rejected rather than
 * capped: exceljs's non-streaming path peaked at 1001 MB on a 6.8 MB workbook
 * and OOM-crashed under a 128 MB heap. A cap makes the bound a guarantee
 * instead of a hope.
 *
 * Generous on the same reasoning as `DELIMITED_MAX_*` directly above: a 64 MiB
 * string table is already a pathological workbook, and these exist to make a
 * malformed or hostile file fail FAST, not to police a large one.
 */
export const XLSX_MAX_SHARED_STRINGS_BYTES = 67_108_864;
export const XLSX_MAX_ENTRY_BYTES = 268_435_456;
export const XLSX_MAX_CELL_CHARS = 1_048_576;

/**
 * The three SMALL parts — `xl/workbook.xml`, its rels, and `xl/styles.xml` —
 * are read by NAME and fully materialised into one string each, because none of
 * them can be interpreted incrementally: a sheet cannot be resolved until the
 * whole `<sheets>` list is in hand.
 *
 * They therefore sit OUTSIDE the "proportional to distinct strings plus one row
 * batch" guarantee above and need their own, much tighter bound. Under
 * `XLSX_MAX_ENTRY_BYTES` a hostile container could force ~256 MiB of inflation
 * per part — ~512 MiB resident as UTF-16, three times over — while every real
 * workbook's three parts together are a few KB.
 *
 * 16 MiB is still far above anything Excel emits (its 65,490-cell-format
 * ceiling puts a pathological `styles.xml` in the low tens of MB only if every
 * format is also enormous) and 16x below the streamed-entry cap, which is the
 * point: the amplification is gone and no legitimate file is refused.
 */
export const XLSX_MAX_SMALL_PART_BYTES = 16_777_216;

/**
 * The one bound that is not a byte count, and the reason it cannot be.
 *
 * A cell reference carries a COLUMN in letters, and the reader derives an index
 * from it. That derivation is exponential in the letter run while the bytes are
 * linear: `r="ZZZZZZ1"` is fifteen bytes of XML and decodes to ~321 million.
 * The sheet parser fills interior blanks by growing the row's `cells` array to
 * the declared index, so a few bytes could force a multi-gigabyte synchronous
 * allocation — an exhaustion path every `XLSX_MAX_*_BYTES` above is blind to,
 * because they measure what ARRIVES and this is what is DERIVED.
 *
 * 16,384 is not a policy choice: it is XFD, the format's own last column, so
 * nothing Excel can emit is refused and everything past it is malformed by
 * definition rather than merely large.
 */
export const XLSX_MAX_COLUMNS = 16_384;

/**
 * How many central-directory entries a container may declare.
 *
 * The other bound the byte caps cannot reach. `XLSX_MAX_*_BYTES` all measure an
 * entry's CONTENT, and the directory walk that finds the entries runs to
 * completion first — so a zip declaring a very large number of tiny nominal
 * entries builds the whole index Map before any content cap can apply. The
 * entries are cheap individually and unbounded in number, which is the shape of
 * every exhaustion bug in this file.
 *
 * A real workbook holds a handful: the four small parts, one worksheet per
 * sheet, and whatever drawings or media it embeds. Even a pathologically
 * image-heavy one stays in the low thousands.
 *
 * 16,384 rather than something larger, and the reason is the format's: a
 * classic zip records its entry count in the EOCD as a **uint16**, so it cannot
 * declare more than 65,535 at all. A cap at or above that would therefore never
 * bind on an ordinary container and would bite only on ZIP64 — a bound that
 * looks like protection and is dead code for the common case. This one binds on
 * both.
 */
export const XLSX_MAX_ENTRIES = 16_384;

/**
 * #996 M12 slice 2 (#1221, data-movement spec §5) — how many rows a `lookup`
 * may materialise into its declared outputs.
 *
 * `lookup` is the one activity whose rows become DURABLE. §5's rule that "rows
 * never enter `run_events`" is a statement about `copy`, and `lookup` is the
 * deliberate exception — which is why §5 gives it a CONCRETE bound rather than
 * a "bounded" one: "there is no generic output cap in studio", so nothing else
 * on the path would stop a lookup over a large table from writing that table
 * into the run log, once per attempt, re-parsed on every read of the log.
 *
 * Behaviour at the cap is settled by §5 and is not this constant's to choose:
 * **truncate and mark, never fail** — "a lookup is a read for a decision, and a
 * bounded answer is usable where an error is not".
 */
export const LOOKUP_ROW_CAP = 1000;

/**
 * §5's other `lookup` bound: how many bytes of materialised rows may reach the
 * outputs, whichever of the two binds first.
 *
 * MEASURED ON THE DURABLE FORM, NOT ON THE SOURCE VALUES, and the difference is
 * the whole point of the constant. The obvious implementation — reuse the pump's
 * `byteSizeOf`, which sizes VALUES because that is what §5 defines `bytesRead`
 * to be — does not bound what this exists to bound. `byteSizeOf` charges a
 * `null` 0 and charges nothing at all for key names, and a lookup's column count
 * is bounded lookup-side by nothing (`XLSX_MAX_COLUMNS` is 16,384). So a
 * 1000-row × 4000-column sheet of blanks measures 0 bytes on the value
 * definition, passes the cap untouched, and still writes a payload of hundreds
 * of megabytes into `run_events.payload` — a column `db/schema.ts` declares as
 * plain `text(..., { mode: 'json' })` with no size limit and no CHECK.
 *
 * So the gate is the UTF-8 length of the row AS SERIALISED — keys, punctuation
 * and nulls included — measured on the already-normalised row, which is exactly
 * the string drizzle's `JSON.stringify` will hand the insert. That makes
 * `truncated` an honest statement about the LOG, which is the fact §5 asks it to
 * protect, and it is why the `bytes` output is named `bytes` rather than
 * `copy`'s `bytesRead`: they are different quantities and sharing a name would
 * be the drift, not the consistency.
 *
 * 1 MiB, per §5. It is a bound on ONE node's outputs, not on the run.
 *
 * WHAT IT DOES NOT BOUND, said out loud rather than left to be discovered: it
 * caps what is ADMITTED, not what is MATERIALISED. The row is normalised and
 * serialised in full before the check that rejects it, so peak memory for a
 * lookup is governed by the largest single ROW in the source. The file kinds
 * cannot reach that (`XLSX_MAX_CELL_CHARS` and `delimited`'s bounds already cap
 * a cell), but a sqlite `BLOB` or a postgres `bytea` has no ceiling. Filed as
 * #1224 — it is an availability gap rather than a correctness one, and the fix
 * probably belongs at the READER seam where the file kinds already put it.
 */
export const LOOKUP_BYTE_CAP = 1024 * 1024;
