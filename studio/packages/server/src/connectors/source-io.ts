import type { CoercionOptions, SqlParameterValue } from '@autonomy-studio/shared';
import type { ResolvedDataset } from './types.js';

/**
 * #996 M12 slice 2 (#1221) — the halves of a dataset READ, shared by every
 * activity that reads one.
 *
 * Lifted out of `CopyIo` when `lookup` arrived, rather than copied: §5 makes
 * `lookup` a SOURCE-ONLY consumer of the very reader `copy` already drives, and
 * the ticket is explicit that it "must NOT be a second reader". A `Pick<CopyIo,
 * …>` would have expressed the same subset while leaving `copy` the owner of a
 * contract it no longer solely uses, so the supertype is declared here and
 * `CopyIo extends` it — the direction that lets a third reader arrive without
 * either activity being its parent.
 *
 * It lives in its own leaf module because `copy.ts` and `lookup.ts` both import
 * it and neither may import the other. That is the same shape `copy-sink.ts`
 * took for the writer registry, and for the same reason.
 *
 * WHAT IS DELIBERATELY *NOT* HERE. `CopyIo.describeSource` stays on `CopyIo`,
 * and the split is a decision rather than an omission: it exists to run §7's
 * drift gate — the source's actual column names checked against the MAPPING,
 * "before the first row moves". A `lookup` declares no mapping, so there is
 * nothing to check it against; the dataset's own `columns` cannot stand in for
 * one, because `ResolvedDataset.columns` is "the DECLARED schema … an authoring
 * aid, never the drift gate". The refusals `describeSource` also carries
 * (duplicate and empty header names) are not lost with it: `source-columns.ts`
 * enforces those inside `readBatches` as well, deliberately, so they are
 * "caught in BOTH entry points".
 */
export interface SourceIo {
  /**
   * The source, already bound to its connection + dataset config. Yields batches
   * of rows as the store reports them, yielding to the event loop between
   * batches (§9) — a bounded read is a SCHEDULING quantum, not just a read unit.
   */
  readonly readBatches: (args: {
    readonly dataset: ResolvedDataset;
    readonly signal: AbortSignal | undefined;
    /**
     * Rows per pull, and so per event-loop yield. Optional, and every store
     * already had the knob (`readSqliteDatasetBatches` and its four siblings all
     * take `batchRows` and default to `COPY_BATCH_ROWS`) — #1224 threaded it
     * through this seam so a CONSUMER can choose, because the right batch size
     * is a property of what the reader is being read FOR.
     *
     * `copy` passes its Batch size (`writeBatchSize`, #1600 C3b), or leaves it
     * unset for the streaming default: every row it reads is a row it writes, so
     * a long pull is pure throughput. `lookup` asks for
     * {@link LOOKUP_BATCH_ROWS}, because it discards all but a bounded prefix
     * and a batch is otherwise the one quantity nothing bounds for it.
     */
    readonly batchRows?: number;
  }) => AsyncIterable<readonly Record<string, unknown>[]>;
  /**
   * #1600 OR41 C6f-3 — a partitioned read (ADF's Dynamic range), planned BEFORE
   * the copy writes anything: the plan's refusals (a source kind that cannot be
   * partitioned, a column that is not an integer) reach the operator before the
   * sink's transaction, its Pre-copy script or its Auto-create have run.
   * OPTIONAL: only a store that can read ranges at once implements it, and
   * `copy` refuses Dynamic range on a source without it.
   */
  readonly planPartitions?: (args: {
    readonly dataset: ResolvedDataset;
    readonly signal: AbortSignal | undefined;
    readonly batchRows?: number;
    readonly partition: PartitionedRead;
  }) => Promise<PartitionPlan>;
  /**
   * #1600 OR41 C5a — an Incremental read (catalogue §4.1 Load), planned BEFORE
   * the copy writes anything, as a partitioned read is: the new watermark is
   * read first, so a bad column refuses before the sink's transaction. OPTIONAL:
   * only a database store implements it, and `copy` refuses Load Incremental on
   * a source without it rather than copying every row.
   */
  readonly planIncremental?: (args: {
    readonly dataset: ResolvedDataset;
    readonly signal: AbortSignal | undefined;
    readonly batchRows?: number;
    readonly watermark: IncrementalRead;
  }) => Promise<IncrementalPlan>;
  /**
   * §6.4's per-source-dataset format facts (`nullValue`, `dateFormat`), read off
   * the SOURCE dataset's own config by the store that knows its shape.
   *
   * REQUIRED, and on this seam rather than on `CopyIo` — which is a correction
   * made when `lookup` arrived, not a widening. The first draft of this split
   * left it with `copy` on the reasoning that it "serves the mapping". That is
   * measurably false for one of its two members: `nullValue` is applied by
   * `coerceValue` (`datamove/coerce.ts`) against the raw value BEFORE any target
   * type is consulted, so an activity that never calls in loses it entirely. A
   * `delimited` dataset declaring `nullValue: '\N'` would then materialise the
   * literal string `'\N'` into a lookup's durable outputs while the SAME dataset
   * read by a copy nulls it — the operator's declared sentinel "silently doing
   * nothing", which is the exact failure `CopyIo.sourceCoercion`'s own docblock
   * requires this channel be REQUIRED to prevent.
   *
   * `dateFormat` is the asymmetric half and is stated so it reads as a decision:
   * it genuinely does NOT apply to a lookup, because it describes how to PARSE a
   * string toward a declared target type and a lookup declares none. A lookup
   * consumes `nullValue` from this options object and ignores `dateFormat`.
   *
   * SYNCHRONOUS and non-throwing in the ordinary case: it reads a config the
   * store has already validated, so it is a projection rather than a second
   * gate. A store whose config cannot be parsed here still throws rather than
   * defaulting to `{}` — see `delimitedCoercionFor`.
   */
  readonly sourceCoercion: (dataset: ResolvedDataset) => CoercionOptions;
}

/** #1600 OR41 C6f-3 — what a rows Copy asks a partitioned read for. */
export interface PartitionedRead {
  /** The partition column, as authored; the store quotes it. */
  readonly column: string;
  readonly lower?: number;
  readonly upper?: number;
  /** Degree of copy parallelism: the most ranges read at once. */
  readonly degree: number;
}

/**
 * #1600 OR41 C6f-3 — a planned partitioned read. `batches` reads every range
 * and is the one stream the pump takes. `close` releases what the plan holds
 * (the session that keeps the shared snapshot alive): it is idempotent, and its
 * caller calls it on EVERY path, because `batches` may never be iterated (the
 * sink can fail before it pulls a row) and then nothing else would.
 */
export interface PartitionPlan {
  /** The ranges read at once: ADF's `usedParallelCopies`. */
  readonly partitions: number;
  readonly batches: AsyncIterable<readonly Record<string, unknown>[]>;
  readonly close: () => Promise<void>;
}

/** #1600 OR41 C5a — what a rows Copy asks an Incremental read for. */
export interface IncrementalRead {
  /** The watermark column, as authored; the store quotes it. */
  readonly column: string;
  /** The old watermark; null reads every row up to the new one. */
  readonly old: SqlParameterValue;
}

/**
 * #1600 OR41 C5a — a planned Incremental read. `next` is the highest watermark
 * above `old` the source holds, and `batches` reads `old < column <= next`.
 * When nothing is above `old`, `next` is `old` and `batches` reads nothing, so
 * the watermark never moves back. A value is the store's text for it, or a
 * number where the store's integer (or SQLite real) is exact in one.
 */
export interface IncrementalPlan {
  readonly next: SqlParameterValue;
  readonly batches: AsyncIterable<readonly Record<string, unknown>[]>;
}

/** #1600 OR41 C5a — the plan when nothing is above the old watermark. */
export function emptyIncrementalPlan(old: SqlParameterValue): IncrementalPlan {
  return {
    next: old,
    batches: (async function* () {
      // Nothing above the old watermark: no read at all.
    })(),
  };
}
