import { WARNING_CODES, type CoercionOptions } from '@autonomy-studio/shared';
import { failed } from './activity-events.js';
import { DatasetIoError } from './dataset-io-error.js';
import { LOOKUP_BYTE_CAP, LOOKUP_ROW_CAP } from '../limits.js';
import type { SourceIo } from './source-io.js';
import type { ActivityContext, ActivityEvent } from './types.js';

/**
 * #996 M12 slice 2 (#1221, data-movement spec §5) — the `lookup` activity's run
 * path: read ONE dataset and materialise a BOUNDED set of rows into the node's
 * declared outputs.
 *
 * It lives beside `copy.ts` rather than inside it because the two share a READER
 * and nothing else: `lookup` has no mapping, no coercion toward a declared type,
 * no sink, no drift gate and no transaction. What they do share arrives through
 * {@link SourceIo}, which was lifted out of `CopyIo` for exactly this — the
 * ticket's requirement that `lookup` "must NOT be a second reader".
 *
 * WHY THIS FILE CARRIES A VALUE NORMALISER AT ALL, which is the part a reader
 * will not expect. `lookup` is the FIRST activity to put STORE values into
 * `node.succeeded.outputs`, and nothing on that path makes them JSON-safe:
 * `EngineEventSchema` declares `outputs: z.record(z.string(), z.unknown())`,
 * `validateOutputs`'s `matchesType` ends `case 'json': return true`, and
 * `storeOutputs` is key-filtering with no value transform. The values then reach
 * `run_events.payload`, which `db/schema.ts` declares
 * `text(..., { mode: 'json' })` — i.e. drizzle `JSON.stringify`s them on insert.
 *
 * Measured consequences on the values the three readers actually produce:
 *  - a `bigint` (which `sqlite.ts`'s `normaliseValue` deliberately KEEPS whenever
 *    the value exceeds `Number.MAX_SAFE_INTEGER`) makes `JSON.stringify` THROW,
 *    inside the insert transaction — so the append rolls back, the `node.succeeded`
 *    fact is lost permanently, and the whole run ends `interrupted` AFTER the read
 *    already happened;
 *  - a `Uint8Array` silently becomes `{"0":1,"1":2,…}`;
 *  - a `Date` persists as an ISO string but stays a `Date` in memory, so a
 *    downstream node in the SAME run and a reload of that run see different values.
 *
 * There is one OTHER walker on that path, and it is not a mitigation:
 * `redact.ts`'s `deepRedactSecrets` runs over `node.succeeded.outputs`, but only
 * when the node resolved config-sink secrets (`executor.ts` gates on a non-empty
 * plaintext list), which a `lookup` never does — and it would make things worse
 * rather than better, since rebuilding an object by `Object.entries` turns a
 * `Date` into `{}` and a `Buffer` into `{"0":1,…}`. Filed as #1223; it is
 * unreachable today precisely because the values below are already primitives
 * by the time anything else sees them.
 *
 * So the rows are normalised HERE, before they are yielded — the one point that
 * sees them and can still refuse. `portability/canonical.ts` argues the opposite
 * posture for its own surface (refuse a non-plain value, never convert) and the
 * distinction is worth naming rather than glossing: canonical's input is
 * Zod-parsed and plain BY CONSTRUCTION, so a `Date` there is a programming
 * fault. Adapter output is `unknown` and comes from an operator's store, where a
 * `Date` or a BLOB is ordinary data — refusing it would refuse the product.
 */

/** The bound that stopped a read short, or `null` when the source ran out first. */
type TruncationCause = 'rows' | 'bytes' | 'first-row';

/**
 * A value no honest JSON rendering exists for, named at the column and row that
 * produced it.
 *
 * `rowIndex` and `column` and NEVER the value itself: `activity.warned.reason`
 * and `node.failed.error` are prose fields that no redaction pass inspects
 * (`engine/types.ts` says so of `reason` in as many words), so quoting an
 * offending cell here would put row data into the run log through the one
 * channel that cannot scrub it.
 */
class LookupValueError extends Error {
  constructor(
    readonly column: string,
    readonly rowIndex: number,
    detail: string,
  ) {
    super(`row ${rowIndex}, column '${column}': ${detail}`);
    this.name = 'LookupValueError';
  }
}

/**
 * How deep a nested value may be before it is refused rather than walked.
 *
 * `redact.ts`'s `MAX_REDACT_DEPTH` is the precedent and the number is the same,
 * but the ACTION at the ceiling is deliberately the opposite. That walker
 * replaces an over-deep subtree with a sentinel because its job is never to leak
 * and never to crash; this one is establishing that a value can be persisted at
 * all, and substituting a sentinel would answer that question by inventing the
 * data. A postgres `jsonb` nested 100 deep is refused out loud instead.
 */
const MAX_VALUE_DEPTH = 100;

/** Whether `v` is a plain object — an object literal or `Object.create(null)`. */
function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Render one value in a form that survives `JSON.stringify` → `JSON.parse`
 * unchanged, or refuse it.
 *
 * The predicate is STRUCTURAL round-trippability, never `typeof`, and that is a
 * correction rather than a preference. `postgres.ts` overrides only
 * `OID_TIMESTAMP`/`OID_DATE` and delegates the rest to `pg.types.getTypeParser`,
 * whose default parsers return plain objects and arrays for `json`/`jsonb` and
 * for every array type. Those are perfectly round-trippable, so a rule refusing
 * "any object" would fail an entirely ordinary schema — a table with a `jsonb`
 * column — on its first row. Meanwhile the value that genuinely must be refused,
 * an `XlsxCellFault`, IS a plain object, so the same rule would have let exactly
 * the wrong one through.
 */
function logSafe(value: unknown, column: string, rowIndex: number, depth = 0): unknown {
  const refuse = (detail: string): never => {
    throw new LookupValueError(column, rowIndex, detail);
  };
  if (depth >= MAX_VALUE_DEPTH) {
    return refuse(`the value nests deeper than ${MAX_VALUE_DEPTH} levels`);
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    // `NaN`/`±Infinity` are REACHABLE — postgres `float8` holds all three, and
    // `pg` hands them back as the JS values. `JSON.stringify` renders each as
    // `null`, which would turn a real reading into an indistinguishable absence:
    // #473's shape exactly, and the one direction this file must never take. The
    // string that NAMES the value is lossless and honest, on the same reasoning
    // as `bigint` below.
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === 'bigint') {
    // Exact decimal, never `Number(value)`. `sqlite.ts:175` opens the store with
    // `defaultSafeIntegers(true)` precisely because the default `number` mode
    // reads `9007199254740993` back as `…992`, "a SILENT one-off corruption", and
    // keeps the `bigint` only where narrowing would lose information. Narrowing
    // it here would reintroduce the corruption at the last possible moment.
    return value.toString();
  }
  if (value instanceof Date) {
    // An unrepresentable instant has no honest string — `toISOString()` throws
    // RangeError on it — so it is refused rather than rendered as something.
    if (Number.isNaN(value.getTime())) return refuse('the value is an invalid Date');
    return value.toISOString();
  }
  if (value instanceof Uint8Array) {
    // Base64, not the `{"0":1,…}` that `JSON.stringify` produces for a bare
    // `Uint8Array` (and not the `{"type":"Buffer","data":[…]}` a Node `Buffer`
    // produces): both round-trip back as a plain OBJECT, never as bytes, which
    // is loss wearing the shape of success.
    return Buffer.from(value).toString('base64');
  }
  if (Array.isArray(value)) {
    return value.map((v) => logSafe(v, column, rowIndex, depth + 1));
  }
  if (typeof value === 'object') {
    // Refused BY NAME, and before the plain-object arm, because an
    // `XlsxCellFault` IS a plain object. The reader has no per-row error channel
    // (`xlsx-read.ts`), so it travels a `{ xlsxFault, detail }` object that
    // `coerceValue` rejects for every target — which fails the ROW for a copy.
    // A lookup has no per-row failure channel either, and dropping the row
    // silently is the wrong answer for a read whose whole purpose is a DECISION:
    // a decision made over a set that quietly lost its bad rows is worse than
    // one that did not run. So the activity refuses.
    if ('xlsxFault' in value) {
      const fault = (value as { xlsxFault: unknown }).xlsxFault;
      return refuse(`the source cell is unreadable (${String(fault)})`);
    }
    if (!isPlainObject(value)) {
      return refuse(`values of type ${value.constructor?.name ?? 'object'} cannot be persisted`);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // `Object.defineProperty`, not `out[k] = v`, for `redact.ts`'s reason: a
      // key literally named `__proto__` is a real own property after
      // `JSON.parse`, and plain assignment would treat it as the prototype
      // accessor and lose it.
      Object.defineProperty(out, k, {
        value: logSafe(v, column, rowIndex, depth + 1),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return out;
  }
  // `undefined`, `function`, `symbol`. Only the first is plausible from a
  // reader, and it is refused rather than folded to `null` — an absent value is
  // a different fact from a null one, which is the distinction M12 slice 1
  // (#1220) went to some trouble to preserve one layer up.
  return refuse(`a value of type ${typeof value} cannot be persisted`);
}

/**
 * One source row, normalised.
 *
 * A key whose value is `undefined` is OMITTED rather than carried, so the
 * materialised row is identical before and after the log round-trip:
 * `JSON.stringify` drops such a key, and a row that changed shape on persist
 * would make `rows` mean one thing to a downstream node in this run and another
 * to anything reading the run back. (`logSafe` never returns `undefined` — it
 * refuses — so this arm is about a key the READER omitted a value for.)
 */
function logSafeRow(
  raw: Record<string, unknown>,
  rowIndex: number,
  nullValue: string | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    // §6.4's NULL SENTINEL, applied at the COLUMN value and not inside the
    // recursion: it is a fact about how a FILE spells NULL in a field, so
    // matching it against a string nested inside a `jsonb` document would be
    // applying a delimited-file rule to a database value. `dateFormat` — the
    // other half of `CoercionOptions` — is deliberately not consulted at all:
    // it describes how to parse a string TOWARD a declared target type, and a
    // lookup declares none.
    const sentinelled = nullValue !== undefined && value === nullValue ? null : value;
    Object.defineProperty(out, column, {
      value: logSafe(sentinelled, column, rowIndex),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return out;
}

/** §5's declared outputs, exactly the four the catalog entry declares. */
function lookupOutputs(
  rows: readonly Record<string, unknown>[],
  bytes: number,
  truncated: boolean,
): Record<string, unknown> {
  return { rows, rowCount: rows.length, bytes, truncated };
}

/** The prose for a truncation, naming WHICH bound bound — never a row value. */
function truncationReason(cause: TruncationCause, rowCount: number, bytes: number): string {
  if (cause === 'rows') {
    return (
      `the source has more rows than a lookup may materialise: stopped at the ` +
      `${LOOKUP_ROW_CAP}-row cap, so 'rows' is a prefix. Narrow the dataset's query ` +
      `or filter to the rows the decision needs.`
    );
  }
  if (cause === 'first-row') {
    return (
      `the FIRST row alone exceeds the ${LOOKUP_BYTE_CAP}-byte cap, so NO rows were ` +
      `materialised — 'rows' is empty for this reason and not because the source is. ` +
      `Select fewer or narrower columns.`
    );
  }
  return (
    `the source is larger than a lookup may materialise: stopped at the ` +
    `${LOOKUP_BYTE_CAP}-byte cap after ${rowCount} row(s) totalling ${bytes} bytes, so ` +
    `'rows' is a prefix. Select fewer or narrower columns.`
  );
}

/** Map a thrown lookup failure onto its terminal event. */
function lookupFailure(err: unknown): ActivityEvent {
  // A value nothing can persist is the operator's data, not a transient store
  // condition — retrying reads the same cell again.
  if (err instanceof LookupValueError) {
    return failed('permanent', `lookup cannot materialise a value — ${err.message}`);
  }
  // The store's OWN verdict on its own failure passes through unchanged, exactly
  // as `copyFailure` does: a `SQLITE_BUSY` reported here as `permanent` would
  // send an operator to fix a dataset that is correct and deny a retry that
  // would have worked.
  if (err instanceof DatasetIoError) return failed(err.kind, err.message);
  // Fail-safe: an unrecognised throw is a programming fault, never something to
  // blind-retry against an operator's store.
  return failed('permanent', err instanceof Error ? err.message : String(err));
}

/**
 * Run one `lookup`, streaming at most one warning and exactly one terminal event.
 *
 * THE CAP IS CHECKED BEFORE A ROW IS ADMITTED, never after, and that ordering is
 * the slice's second settled decision. Admit-then-stop would bound the payload
 * at "the cap plus one row", and a row is bounded by nothing — a sqlite BLOB or
 * a postgres `text` column is arbitrarily large — so the bound §5 asks for would
 * not exist. Checking first costs the case where the FIRST row alone is over the
 * cap, which then yields zero rows from a non-empty source.
 *
 * That cost buys the property that makes the outputs honest: `rows: []` with
 * `truncated: false` means the source is genuinely EMPTY, and `rows: []` with
 * `truncated: true` means at least one row exists and none fit. The two declared
 * outputs distinguish the cases between them, with no third output and no
 * ambiguity — and the warning says which happened in words.
 *
 * §5's "truncate and mark, NEVER fail" is honoured throughout: every path here
 * that hits a bound still SUCCEEDS, with a bounded, marked answer.
 */
export async function* runLookupActivity(
  ctx: ActivityContext,
  io: SourceIo,
): AsyncGenerator<ActivityEvent> {
  const source = ctx.datasets?.source;
  if (source === undefined) {
    // The catalog's `datasetKinds` is what makes the dispatch seam resolve a
    // source before an adapter runs. Re-stated rather than trusted: an activity
    // is reachable through any entry naming this connection kind, and an entry
    // that forgot to declare `datasetKinds` would otherwise arrive here with
    // nothing to read and report success over zero rows.
    yield failed('permanent', 'lookup requires a source dataset — the rows it reads');
    return;
  }
  if (ctx.signal.aborted) {
    yield failed('cancelled', 'lookup aborted');
    return;
  }

  // There is no dispatch-config parse, and its absence is deliberate: a `lookup`
  // node has NO settings (`configSchema` is an empty object). Everything that
  // shapes the read — the table, the query and its parameters, the file path,
  // the sheet, the header row — is the DATASET's, and the dataset's config is
  // re-validated by the reader at dispatch as §8 requires. A parse here would
  // have nothing to check.
  let coercion: CoercionOptions;
  try {
    coercion = io.sourceCoercion(source);
  } catch (err) {
    // It parses the source dataset's config and may throw on one it cannot read.
    // Derived HERE, before the read, so such a config reports itself rather than
    // arriving as whatever opening the store failed with.
    yield lookupFailure(err);
    return;
  }

  const rows: Record<string, unknown>[] = [];
  let bytes = 0;
  let cause: TruncationCause | null = null;

  try {
    outer: for await (const batch of io.readBatches({ dataset: source, signal: ctx.signal })) {
      for (const raw of batch) {
        if (rows.length >= LOOKUP_ROW_CAP) {
          cause = 'rows';
          break outer;
        }
        const row = logSafeRow(raw, rows.length, coercion.nullValue);
        // Measured on the row AS SERIALISED — keys, punctuation and nulls
        // included — because that is the string drizzle will hand the insert.
        // See `LOOKUP_BYTE_CAP` for why the pump's value-only `byteSizeOf` does
        // not bound what this is here to bound.
        // `Buffer.byteLength`, not `shared`'s `utf8ByteLength`: that one is not
        // on the package's public surface, and the barrel says why — the
        // evaluator's helpers "would make engine-internal machinery part of
        // `@autonomy-studio/shared`'s API by accident". Widening it for a
        // server-only measurement would be the accident. Node's is exact UTF-8
        // and this file only ever runs on the server.
        const size = Buffer.byteLength(JSON.stringify(row), 'utf8');
        if (bytes + size > LOOKUP_BYTE_CAP) {
          cause = rows.length === 0 ? 'first-row' : 'bytes';
          break outer;
        }
        rows.push(row);
        bytes += size;
      }
    }
  } catch (err) {
    yield lookupFailure(err);
    return;
  }

  if (cause !== null) {
    yield {
      type: 'warned',
      code: WARNING_CODES.LOOKUP_TRUNCATED,
      reason: truncationReason(cause, rows.length, bytes),
    };
  }
  yield { type: 'succeeded', outputs: lookupOutputs(rows, bytes, cause !== null) };
}
