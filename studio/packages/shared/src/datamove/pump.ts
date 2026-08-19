import { utf8ByteLength } from '../engine/functions.js';
import type { DataType } from '../schemas/dataset.js';
import {
  coerceValue,
  type CoercedValue,
  type CoercionFailureCode,
  type CoercionOptions,
} from './coerce.js';

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
 * CANCELLATION is not handled here and that is deliberate (§10). The reader and
 * the writer each throw `DatasetIoError('cancelled')` at their own batch
 * boundaries, which are the same boundaries; a third check in the middle would
 * be a redundant guard whose only distinct behaviour would be a different error
 * type for the same event.
 */

/** Why a copy was refused before it moved a row. Bounded, like `CoercionFailureCode`. */
export type CopyMappingErrorCode =
  | 'empty_mapping'
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
  /** `nullValue` / `dateFormat` (§6.4). No dataset field carries them yet — M7. */
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
  | { readonly kind: 'source'; readonly sink: string; readonly key: string; readonly entry: CopyPumpMappingEntry }
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
  // A kind no v1 source produces. 0 rather than a guessed size: `bytesRead` is
  // a measurement, and a made-up number is worse than a missing one.
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
  const exact = new Set(sourceKeys);
  const lowered = new Map<string, string[]>();
  for (const key of sourceKeys) {
    const lower = key.toLowerCase();
    const bucket = lowered.get(lower);
    if (bucket) bucket.push(key);
    else lowered.set(lower, [key]);
  }

  const plans: ColumnPlan[] = [];
  const missing: string[] = [];
  const ambiguous: string[] = [];

  for (const entry of mapping) {
    if (entry.source === undefined) {
      plans.push(constantPlan(entry, coercion));
      continue;
    }
    if (exact.has(entry.source)) {
      plans.push({ kind: 'source', sink: entry.sink, key: entry.source, entry });
      continue;
    }
    const candidates = lowered.get(entry.source.toLowerCase()) ?? [];
    if (candidates.length > 1) {
      ambiguous.push(entry.source);
      continue;
    }
    if (candidates.length === 1) {
      plans.push({ kind: 'source', sink: entry.sink, key: candidates[0] as string, entry });
      continue;
    }
    // Absent. `onError: 'null'` is the column's own opt-out and covers this:
    // the operator said "if this column cannot produce a value, write null".
    if (entry.onError === 'null') {
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
      `the source has more than one column matching ${ambiguous.map((c) => `\`${c}\``).join(', ')} case-insensitively; name the column exactly`,
    );
  }
  if (missing.length > 0) {
    throw new CopyMappingError(
      'missing_source_column',
      `the source has no column named ${missing.map((c) => `\`${c}\``).join(', ')}`,
    );
  }
  return plans;
}

function constantPlan(entry: CopyPumpMappingEntry, coercion: CoercionOptions): ColumnPlan {
  const result = coerceValue(entry.expression, entry.type, coercion);
  if (result.ok) return { kind: 'constant', sink: entry.sink, value: result.value };
  if (entry.onError === 'null') return { kind: 'constant', sink: entry.sink, value: null };
  // Failing this per row would produce a copy in which EVERY row fails for the
  // same reason — a million identical failures reported as data trouble when it
  // is one authoring mistake.
  throw new CopyMappingError(
    'uncoercible_constant',
    `the expression mapped to \`${entry.sink}\` cannot be a ${entry.type}: ${result.reason}`,
  );
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
 * NOT a duplicate of that: the schema permits `[]`, and the only other guard is
 * the sink's own zero-column check — which is the downstream guard this branch
 * has already been bitten by relying on once.
 */
export async function* pumpCopyRows(
  batches: AsyncIterable<readonly Record<string, unknown>[]>,
  opts: CopyPumpOptions,
): AsyncGenerator<readonly Record<string, CoercedValue>[], void, undefined> {
  if (opts.mapping.length === 0) {
    throw new CopyMappingError('empty_mapping', 'the copy maps no columns');
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
