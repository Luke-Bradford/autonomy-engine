import { utf8ByteLength } from '../engine/functions.js';
import type { DataType } from '../schemas/dataset.js';
import {
  coerceValue,
  type CoercedValue,
  type CoercionFailureCode,
  type CoercionOptions,
} from './coerce.js';
import { indexSourceColumns, resolveSourceColumn, SOURCE_DRIFT_MESSAGES } from './schema-drift.js';

/**
 * #996 M5 slice 3 (#1129) — the copy PUMP (data-movement spec §5, §6, §9).
 *
 * The middle of the copy: source batches in, sink batches out. Slice 1 decided
 * what one VALUE becomes (`coerce.ts`), slice 2 decided how a batch LANDS
 * (`server/src/connectors/sqlite.ts`); this decides what a ROW becomes and what
 * the run log gets to say about it afterwards.
 *
 * PURE, and in `shared` rather than beside the connector, because none of it is
 * store-specific: it never opens anything, never touches a clock, and works on
 * plain records. It is what M7's CSV source and M10's postgres sink will reuse
 * unchanged. The one store-shaped thing it knows is that a value may arrive as a
 * `Uint8Array`, which `coerce.ts` already had to know for the same reason.
 *
 * THE SPLIT THIS MODULE IS BUILT AROUND — a per-row failure and a copy-wide
 * refusal are different events and are never conflated:
 *
 *   - a per-ROW failure is about DATA: this cell said `"1.5"` where an integer
 *     was declared. §6.2 fails that row, names the reason, and the copy carries
 *     on. `rowsFailed` is a declared output precisely so this is visible.
 *   - a copy-wide REFUSAL is about the MAPPING: an empty mapping, a source
 *     column that does not exist, a case-insensitive match with two candidates,
 *     a constant that cannot coerce. Every one of those is invariant across
 *     rows, so reporting them per row produces "node succeeded, rowsRead
 *     1000000, rowsWritten 0" — a copy that wrote nothing and said so only in a
 *     counter. They throw `CopyMappingError` before a single row moves, which
 *     §4's failure table classifies `permanent`.
 *
 * This mirrors the posture `resolveSinkColumns` already took on the sink side
 * (refuse missing and colliding columns copy-wide, naming all of them, before
 * the transaction opens). Deliberately mirrored rather than imported: `server`
 * depends on `shared` and not the reverse, and a third policy invented at M7
 * would be the drift. If you change one, change both.
 *
 * ONE CONSEQUENCE OF RESOLVING AGAINST DATA, stated because it is a decision
 * rather than an oversight: the source's column names come from its first row,
 * so a copy from a currently-EMPTY table validates nothing and succeeds with
 * `rowsRead: 0`. A mapping naming a column that does not exist then looks fine
 * until data arrives. Checking a mapping against a dataset's DECLARED schema
 * before dispatch is §7's drift gate (M6) — a different check, at a different
 * time, on a different input, and deliberately not faked here from one row.
 *
 * CANCELLATION is not handled here and that is deliberate (§10). The reader and
 * the writer each throw `DatasetIoError('cancelled')` at their own batch
 * boundaries, which are the same boundaries; a third check in the middle would
 * be a redundant guard whose only distinct behaviour would be a different error
 * type for the same event.
 */

/** Why a copy was refused before it moved a row. Bounded, like `CoercionFailureCode`. */
export type CopyMappingErrorCode =
  | 'empty_mapping'
  | 'duplicate_sink_column'
  | 'missing_source_column'
  | 'ambiguous_source_column'
  | 'uncoercible_constant';

/**
 * A copy-wide refusal.
 *
 * Carries no `ConnectorErrorKind` — this package has no connector vocabulary.
 * Slice 4 (#1130) catches it at the adapter and re-throws it as `permanent`,
 * which is what §4's table says a mapping failure is: retrying it would repeat
 * it exactly.
 */
export class CopyMappingError extends Error {
  readonly code: CopyMappingErrorCode;

  constructor(code: CopyMappingErrorCode, message: string) {
    super(message);
    this.name = 'CopyMappingError';
    this.code = code;
  }
}

/**
 * One mapping entry as the PUMP sees it, which is not quite as the schema
 * declares it (`catalog/copy-config.ts`).
 *
 * `expression` is `unknown` here, not `string`. Substitution happens in the
 * reducer (§8) and a whole-value reference PRESERVES ITS NATIVE TYPE
 * (`engine/params.ts:740`), so `"${params.limit}"` reaches this module as a
 * number and `"${params.enabled}"` as a boolean. Typing it `string` would be a
 * lie that `coerceValue` — which takes `unknown` for exactly this reason — would
 * then have to be lied to as well.
 */
export interface CopyPumpMappingEntry {
  readonly source?: string;
  readonly expression?: unknown;
  readonly sink: string;
  readonly type: DataType;
  readonly onError: 'fail' | 'null';
}

/** The first row that failed, kept for prose an operator can act on. */
export interface CopyRowFailure {
  /** 0-based, across the whole copy rather than within its batch. */
  readonly rowIndex: number;
  readonly sink: string;
  readonly code: CoercionFailureCode;
  readonly reason: string;
}

/**
 * §5's declared outputs, as ONE record both halves of the copy feed.
 *
 * Caller-owned and mutated in place rather than returned, because a copy that
 * throws must still be able to say how far it got: §10 requires that a cancel
 * "never leave a silent partial", and a returned summary is exactly what a
 * throw discards. The sink already reports its progress the same way, through a
 * running-total callback, and this is the record it reports INTO.
 */
export interface CopyCounters {
  rowsRead: number;
  /**
   * Written by the SINK half, never by the pump. A pump-side guess would be
   * wrong in the one case that matters — the sink's transaction rolling back
   * after the pump has handed it every row.
   */
  rowsWritten: number;
  /** Rows NOT written because a mapped value failed coercion under `onError: 'fail'`. */
  rowsFailed: number;
  /**
   * Source bytes as measured AT THIS BOUNDARY: the values the reader
   * materialised, all of them, including columns the mapping ignores (they were
   * read regardless). It is not the store's on-disk size and not the wire size,
   * and M7's CSV source will read a rather different number of file bytes than
   * this counts in parsed values — which is why §5 defines it rather than
   * leaving each source to derive one.
   */
  bytesRead: number;
  /**
   * Always `false` in v1, and honestly so: §5 gives `copy` no cap, on the
   * reasoning that a streamed copy is memory-bounded regardless of size. It is
   * declared because it is a REQUIRED output a pipeline may branch on, and M12's
   * `lookup` — the one activity that materialises rows, with `LOOKUP_ROW_CAP`
   * and `LOOKUP_BYTE_CAP` — owns the first `true`.
   */
  truncated: boolean;
  /**
   * Failures tallied by their bounded code, which is what slice 1 declared the
   * code FOR: "a summary that can say '410 not_integral, 2 unparseable_date'
   * needs a bounded code, not unbounded per-row prose".
   */
  failuresByCode: Partial<Record<CoercionFailureCode, number>>;
  firstFailure?: CopyRowFailure;
}

export function newCopyCounters(): CopyCounters {
  return {
    rowsRead: 0,
    rowsWritten: 0,
    rowsFailed: 0,
    bytesRead: 0,
    truncated: false,
    failuresByCode: {},
  };
}

export interface CopyPumpOptions {
  readonly mapping: readonly CopyPumpMappingEntry[];
  /** Mutated in place. The caller holds it, so the callback below needs no argument. */
  readonly counters: CopyCounters;
  /**
   * `nullValue` / `dateFormat` (§6.4), read off the SOURCE dataset's config by
   * the store's `CopyIo.sourceCoercion` and threaded here — the wiring M7 slice
   * 3 (#1167) discharged. `delimited` declares both (#1163); the SQL kinds
   * declare neither and supply `{}`, which is a true statement about them
   * rather than a stub (§2.6: "a database column already has a type and a real
   * `NULL`, so there is nothing to declare").
   *
   * Still OPTIONAL here, and only here: this is a pure function's parameter and
   * `{}` is its honest identity. The channel it arrives through is REQUIRED —
   * an optional one is a channel a store can decline, and a store that declined
   * it would copy with the operator's declared sentinel silently doing nothing.
   */
  readonly coercion?: CoercionOptions;
  /**
   * Progress, PER BATCH and never per row (§5 — "one event per row would
   * reproduce the log-volume problem this section forbids"). Called after the
   * consumer has taken the batch, so a tick that reads `counters.rowsWritten`
   * sees the sink's number for that batch rather than the previous one's; and
   * called for a batch that yielded nothing too, because a copy whose rows are
   * all failing is exactly the one that must not look hung.
   */
  readonly onBatch?: () => void;
}

/** How one sink column gets its value, resolved ONCE for the whole copy. */
type ColumnPlan =
  | {
      readonly kind: 'source';
      readonly sink: string;
      readonly key: string;
      readonly entry: CopyPumpMappingEntry;
    }
  | { readonly kind: 'constant'; readonly sink: string; readonly value: CoercedValue };

function byteSizeOf(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return utf8ByteLength(value);
  if (value instanceof Uint8Array) return value.byteLength;
  if (typeof value === 'boolean') return 1;
  // A SQLite `INTEGER` is at most 8 bytes and a `REAL` is exactly 8. That stops
  // being the whole story at M10 (postgres `numeric` is arbitrary precision), at
  // which point this wants a per-source measurement rather than a constant.
  if (typeof value === 'number' || typeof value === 'bigint') return 8;
  // Everything else, which as of M11 slice 2 (#1215) is no longer hypothetical:
  // the `excel` reader yields `Date` values for date-typed cells and
  // `XlsxCellFault` objects for error cells, so this arm is now REACHED and
  // charges both 0. Recorded rather than quietly fixed here — the sentence this
  // replaces ("a kind no v1 source produces") became false the moment that
  // reader shipped, and #1214 owns the sizing decision, which needs a
  // per-source measurement rather than a constant chosen in this diff. 0 stays
  // the honest placeholder in the meantime, on this comment's own original
  // rule: `bytesRead` is a measurement, and a made-up number is worse than a
  // missing one.
  return 0;
}

/**
 * Resolve the mapping against the source's actual column names, once.
 *
 * Case-insensitivity mirrors the sink's `NOCASE` identity (§7): SQLite column
 * names compare case-insensitively, so a mapping written `name` against a column
 * declared `Name` is the same column, not a missing one. An EXACT match always
 * wins, so a source that really does have both `name` and `Name` binds each to
 * itself; only a mapping that matches neither exactly and both loosely is
 * ambiguous, and that is refused rather than resolved by declaration order.
 */
function planColumns(
  mapping: readonly CopyPumpMappingEntry[],
  sourceKeys: readonly string[],
  coercion: CoercionOptions,
): ColumnPlan[] {
  // M6 (#1148): the SHARED resolver, so the dispatch-time gate
  // (`checkSourceDrift`) and this binding-time check cannot disagree about what
  // "the same column" means. Everything below is unchanged behaviour — the
  // exact-match preference, the ambiguity refusal and `onError: 'null'`
  // absorbing an absent column all moved WITH the predicate, not around it.
  const index = indexSourceColumns(sourceKeys);

  const plans: ColumnPlan[] = [];
  const missing: string[] = [];
  const ambiguous: string[] = [];
  const uncoercible: string[] = [];

  for (const entry of mapping) {
    if (entry.source === undefined) {
      const constant = constantPlan(entry, coercion);
      if ('reason' in constant) uncoercible.push(constant.reason);
      else plans.push(constant.plan);
      continue;
    }
    const resolved = resolveSourceColumn(entry, index);
    if (resolved.kind === 'bound') {
      plans.push({ kind: 'source', sink: entry.sink, key: resolved.key, entry });
      continue;
    }
    if (resolved.kind === 'ambiguous') {
      ambiguous.push(entry.source);
      continue;
    }
    // Absent. `onError: 'null'` is the column's own opt-out and covers this:
    // the operator said "if this column cannot produce a value, write null".
    if (resolved.kind === 'null') {
      plans.push({ kind: 'constant', sink: entry.sink, value: null });
      continue;
    }
    missing.push(entry.source);
  }

  // Ambiguity first: it is a mapping that cannot be resolved at all, where a
  // missing column at least has a legitimate `onError: 'null'` answer.
  if (ambiguous.length > 0) {
    throw new CopyMappingError(
      'ambiguous_source_column',
      SOURCE_DRIFT_MESSAGES.ambiguous(ambiguous),
    );
  }
  if (missing.length > 0) {
    throw new CopyMappingError('missing_source_column', SOURCE_DRIFT_MESSAGES.missing(missing));
  }
  if (uncoercible.length > 0) {
    throw new CopyMappingError('uncoercible_constant', uncoercible.join('; '));
  }
  return plans;
}

/**
 * Plan one `expression` column, whose value is the same for every row.
 *
 * REPORTS rather than throws, so a mapping with two broken constants names both
 * — the same completeness `planColumns` gives missing and ambiguous columns.
 * An authoring session that fixes one problem only to be told about the next is
 * the experience that rule exists to avoid.
 */
function constantPlan(
  entry: CopyPumpMappingEntry,
  coercion: CoercionOptions,
): { plan: ColumnPlan } | { reason: string } {
  const result = coerceValue(entry.expression, entry.type, coercion);
  if (result.ok) return { plan: { kind: 'constant', sink: entry.sink, value: result.value } };
  if (entry.onError === 'null')
    return { plan: { kind: 'constant', sink: entry.sink, value: null } };
  // Failing this per row would produce a copy in which EVERY row fails for the
  // same reason — a million identical failures reported as data trouble when it
  // is one authoring mistake.
  return {
    reason: `the expression mapped to \`${entry.sink}\` cannot be a ${entry.type}: ${result.reason}`,
  };
}

function recordFailure(counters: CopyCounters, failure: CopyRowFailure): void {
  counters.rowsFailed += 1;
  counters.failuresByCode[failure.code] = (counters.failuresByCode[failure.code] ?? 0) + 1;
  if (counters.firstFailure === undefined) counters.firstFailure = failure;
}

/**
 * Stream source batches into sink batches, mapping and coercing each row.
 *
 * One sink batch per source batch, and never an empty one — the reader holds the
 * same property, and a sink round that writes nothing is a transaction's worth
 * of work for no rows.
 *
 * The mapping is assumed already validated by `CopyMappingSchema` (the XOR
 * between `source` and `expression`, and the duplicate-`sink` refusal, are its
 * to enforce and are not re-checked here). The empty-mapping refusal below is
 * NOT a duplicate of that, but #1172 did more than narrow the gap and the
 * honest statement is worth more than a comfortable one: `mappingArray` now
 * refuses `[]`, and EVERY live caller reaches this function through
 * `connectors/copy.ts`'s `runCopyActivity`, which parses that schema first.
 * `fs.ts` (M7's CSV source) and `sqlite.ts` both call it — so as of today this
 * branch is unreachable in production and is exercised only by `pump.test.ts`.
 *
 * It STAYS anyway, and not as a reflex. This module is `shared` and takes its
 * mapping from whoever holds one; it is not entitled to assume a schema ran,
 * and the only guard behind it is the sink's own zero-column check — the
 * downstream guard this branch has already been bitten by relying on once. A
 * future direct caller (M10's postgres sink, a non-`runCopyActivity` adapter)
 * would land on it. Prospective, therefore, not currently load-bearing: a
 * reader deleting it should know it costs nothing today, and why it is kept.
 */
export async function* pumpCopyRows(
  batches: AsyncIterable<readonly Record<string, unknown>[]>,
  opts: CopyPumpOptions,
): AsyncGenerator<readonly Record<string, CoercedValue>[], void, undefined> {
  if (opts.mapping.length === 0) {
    throw new CopyMappingError('empty_mapping', 'the copy maps no columns');
  }
  // The schema refuses a duplicate `sink` (`catalog/copy-config.ts`), and this
  // module is not entitled to assume the schema ran: it is `shared`, M7's CSV
  // source and M10's postgres sink reuse it, and #1130's adapter builds the
  // mapping. Without this, two entries writing `id` are LAST-WRITER-WINS —
  // silent data loss, which is the one outcome this file exists to prevent, and
  // relying on a guard the caller might not have run is the exact defect this
  // branch already paid for once (`f0bc0dea`).
  const duplicated = new Set<string>();
  const seenSinks = new Set<string>();
  for (const entry of opts.mapping) {
    if (seenSinks.has(entry.sink)) duplicated.add(entry.sink);
    seenSinks.add(entry.sink);
  }
  if (duplicated.size > 0) {
    throw new CopyMappingError(
      'duplicate_sink_column',
      `more than one mapping writes ${[...duplicated].map((c) => `\`${c}\``).join(', ')}`,
    );
  }
  const { counters } = opts;
  const coercion = opts.coercion ?? {};
  let plans: ColumnPlan[] | undefined;

  for await (const batch of batches) {
    const out: Record<string, CoercedValue>[] = [];

    for (const row of batch) {
      // Resolved from the first row's key set, which for every v1 source is the
      // statement's column list and therefore uniform. A later row that lacks a
      // resolved key is NOT a mapping problem — it is one row missing a value,
      // and it takes the per-row `absent_value` path below.
      plans ??= planColumns(opts.mapping, Object.keys(row), coercion);

      for (const value of Object.values(row)) counters.bytesRead += byteSizeOf(value);
      counters.rowsRead += 1;

      const mapped: Record<string, CoercedValue> = {};
      let failed = false;
      for (const plan of plans) {
        if (plan.kind === 'constant') {
          mapped[plan.sink] = plan.value;
          continue;
        }
        const result = coerceValue(row[plan.key], plan.entry.type, coercion);
        if (result.ok) {
          mapped[plan.sink] = result.value;
          continue;
        }
        if (plan.entry.onError === 'null') {
          mapped[plan.sink] = null;
          continue;
        }
        recordFailure(counters, {
          rowIndex: counters.rowsRead - 1,
          sink: plan.sink,
          code: result.code,
          reason: result.reason,
        });
        failed = true;
        break; // the row is lost either way; the first reason is the one reported
      }
      if (!failed) out.push(mapped);
    }

    if (out.length > 0) yield out;
    opts.onBatch?.();
  }
}
