import {
  copyDispatchInputSchema,
  CopyMappingError,
  newCopyCounters,
  pumpCopyRows,
  WARNING_CODES,
  type CoercedValue,
  type CopyCounters,
  type CopyPumpMappingEntry,
  type DatasetColumn,
} from '@autonomy-studio/shared';
import { failed } from './activity-events.js';
import { DatasetIoError } from './dataset-io-error.js';
import type { ActivityContext, ActivityEvent, ResolvedDataset } from './types.js';

/** The resolved SINK connection, as `ActivityContext` declares it. */
type ActivitySink = NonNullable<ActivityContext['sink']>;

/**
 * #996 M5 slice 4b (#1134) — the `copy` activity's run path: the one place the
 * M4 reader, slice 3's pump and slice 2's atomic sink are composed.
 *
 * It lives HERE rather than in `sqlite.ts` because none of it is store-specific.
 * The dispatch schema, the mapping refusals, the counters→outputs contract and
 * the failure mapping are the same for every store; only the reader and the
 * writer differ, and those arrive through {@link CopyIo}. M7's `delimited`
 * source over the `fs` connection reuses this file unchanged.
 *
 * WHY THE I/O IS CALLER-SUPPLIED rather than resolved here from `ctx.sink.kind`.
 * A registry keyed by sink kind reads better on paper and is the right shape
 * once a SECOND store exists — it is what stops M10's postgres turning source ×
 * sink into an import mesh. It is not built yet for one concrete reason: this
 * module would then have to import `sqlite.ts`, which imports this module to
 * delegate, and a module-evaluation cycle between an adapter and the activity it
 * dispatches is a fragile thing to introduce for a v1 with exactly one store.
 * When M7 or M10 adds the second, extracting the store I/O into its own module
 * and inverting this is mechanical — and at that point it buys something.
 */

/**
 * The store-specific halves of a copy, supplied by the dispatching adapter.
 *
 * Both halves are handed the RESOLVED dataset and (for the sink) the resolved
 * connection rather than reading them off `ctx` themselves. That is what lets an
 * adapter implement them without a cast: the refusal ladder below has already
 * proved both ends are present by the time either is called, and a seam that
 * took `ctx` would force every implementation to re-assert it with a `!` or an
 * `as`, which is the same claim made again with less evidence.
 */
export interface CopyIo {
  /**
   * The source, already bound to its connection + dataset config. Yields batches
   * of rows as the store reports them, yielding to the event loop between
   * batches (§9) — a bounded read is a SCHEDULING quantum, not just a read unit.
   */
  readonly readBatches: (args: {
    readonly dataset: ResolvedDataset;
    readonly signal: AbortSignal | undefined;
  }) => AsyncIterable<readonly Record<string, unknown>[]>;
  /**
   * The sink, already bound to its connection + dataset config. Drives the
   * batches it is given and resolves with the rows it durably wrote.
   *
   * `onBatch` reports a RUNNING TOTAL rather than a per-batch delta, matching
   * `SqliteDatasetWrite.onBatch`, so a copy that throws mid-write has still told
   * the counters how far it got.
   */
  readonly writeRows: (args: {
    readonly dataset: ResolvedDataset;
    readonly connection: ActivitySink;
    readonly columns: readonly string[];
    readonly mode: 'append' | 'overwrite';
    readonly onBatch: (rowsWritten: number) => void;
    readonly batches: AsyncIterable<readonly Record<string, CoercedValue>[]>;
    readonly signal: AbortSignal | undefined;
  }) => Promise<{ readonly rowsWritten: number }>;
}

/**
 * §5's five declared outputs, built from the counters both halves feed.
 *
 * Exactly these five, and no more: they are what the catalog entry declares in
 * 4c, and an output a pipeline can read but the catalog does not declare is
 * unreferencable — `${nodes.x.output.foo}` has nothing to validate against.
 * `failuresByCode` and `firstFailure` are therefore NOT outputs; they reach the
 * operator as the advisory below.
 */
function copyOutputs(counters: CopyCounters): Record<string, unknown> {
  return {
    rowsRead: counters.rowsRead,
    rowsWritten: counters.rowsWritten,
    rowsFailed: counters.rowsFailed,
    bytesRead: counters.bytesRead,
    truncated: counters.truncated,
  };
}

/**
 * The prose for a copy that dropped rows — "410 not_integral, 2 unparseable_date".
 *
 * §5 says the bounded `CoercionFailureCode` exists FOR this summary, and slice 1
 * tallies `failuresByCode` for it. Without it `rowsFailed: 412` reaches the
 * operator with no way to learn why, which is the silent-partial class §10
 * refuses — the rows are gone from the copy and nothing says what was wrong with
 * them.
 */
function failureSummary(counters: CopyCounters): string {
  const byCode = Object.entries(counters.failuresByCode)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code, n]) => `${n} ${code}`)
    .join(', ');
  const first = counters.firstFailure;
  const where =
    first === undefined
      ? ''
      : ` First at row ${first.rowIndex} into '${first.sink}': ${first.reason}.`;
  return `${counters.rowsFailed} row(s) were not written (${byCode}).${where}`;
}

/**
 * §6.2's refusal, deferred out of slice 1 because it needs the RESOLVED sink.
 *
 * `onError: 'null'` writes a null where a value fails to coerce. Against a
 * `nullable: false` column that turns a coercion failure into a CONSTRAINT
 * violation raised by the store — mid-transaction, after part of the copy is
 * already written. Refusing at dispatch is what keeps the failure at the
 * boundary where nothing has been written yet.
 *
 * It checks only sink columns the dataset DECLARES. An undeclared one is not
 * this rule's business: `ResolvedDataset.columns` is the declared contract, not
 * the write column list, and whether a column exists in the actual store is §7's
 * drift gate at write time (`resolveSinkColumns`). Silently widening this rule
 * into an existence check would duplicate that gate with weaker evidence.
 */
export function refuseNullOnNonNullable(
  mapping: readonly { readonly sink: string; readonly onError: 'fail' | 'null' }[],
  columns: readonly DatasetColumn[],
): string | null {
  const nonNullable = new Set(
    columns.filter((column) => !column.nullable).map((column) => column.name),
  );
  const offender = mapping.find((row) => row.onError === 'null' && nonNullable.has(row.sink));
  if (offender === undefined) return null;
  return (
    `mapping row for sink column '${offender.sink}' sets onError:'null', but the sink dataset ` +
    `declares that column NOT NULL — a coercion failure would reach the store as a constraint ` +
    `violation mid-copy, after part of the output is already written`
  );
}

/**
 * Map a thrown copy failure onto its terminal event.
 *
 * The unwrap is the load-bearing part. `pumpCopyRows` is an async generator, so
 * a `CopyMappingError` — including the ones it raises before reading a single
 * row — throws on the first `next()`, which happens INSIDE the sink's
 * `for await`, inside its try block. The sink therefore wraps it as a
 * `DatasetIoError` and keeps the original on `.cause`
 * (`copy-pipeline.test.ts` pins exactly this). Reading only the outer error
 * would report "the copy into 'x' failed" and lose the bounded mapping code,
 * which is the one piece of the message that tells an author what to fix.
 *
 * Everything else passes its `kind` through UNCHANGED. §4 makes the sink the
 * owner of that verdict — it is the layer that knows whether its transaction
 * rolled back — so re-classifying here would second-guess the only code with
 * the evidence.
 */
function copyFailure(err: unknown): ActivityEvent {
  const mapping =
    err instanceof CopyMappingError
      ? err
      : err instanceof DatasetIoError && err.cause instanceof CopyMappingError
        ? err.cause
        : null;
  if (mapping !== null) {
    return failed('permanent', `copy mapping refused (${mapping.code}): ${mapping.message}`);
  }
  if (err instanceof DatasetIoError) {
    const partial = err.partialWritePossible ? ' (the sink may hold a partial write)' : '';
    return failed(err.kind, `${err.message}${partial}`);
  }
  // Fail-safe: an unrecognised throw is a programming fault, never something to
  // blind-retry into an operator's store.
  return failed('permanent', err instanceof Error ? err.message : String(err));
}

/**
 * Run one `copy`, streaming its refusals and exactly one terminal event.
 *
 * The refusal ladder is ordered so that nothing opens a store until every fact
 * that can refuse the copy has been checked.
 */
export async function* runCopyActivity(
  ctx: ActivityContext,
  io: CopyIo,
): AsyncGenerator<ActivityEvent> {
  const source = ctx.datasets?.source;
  const sink = ctx.datasets?.sink;
  if (source === undefined || sink === undefined) {
    // 4a's dispatch seam resolves both ends before an adapter runs, and the
    // catalog's `datasetKinds` is what makes it do so. The adapter re-states the
    // requirement rather than trusting it: an activity is reachable through any
    // entry that names this connection kind, and a future entry that forgot to
    // declare a sink would otherwise reach here with `undefined` and copy
    // nothing while reporting success.
    yield failed('permanent', 'copy requires both a source and a sink dataset');
    return;
  }
  if (ctx.sink === undefined) {
    yield failed('permanent', 'copy requires a sink connection — the store it writes into');
    return;
  }

  const parsed = copyDispatchInputSchema.safeParse(ctx.input);
  if (!parsed.success) {
    yield failed('permanent', `invalid copy activity config: ${parsed.error.message}`);
    return;
  }
  const { mapping, mode } = parsed.data;

  const refusal = refuseNullOnNonNullable(mapping, sink.columns);
  if (refusal !== null) {
    yield failed('permanent', refusal);
    return;
  }

  // The sink's write column list is the mapping's OWN sink names — every row,
  // including expression-only ones, which write a constant and are as much a
  // written column as a copied one. It cannot be derived from the rows the pump
  // yields: a batch whose rows all failed yields nothing at all.
  const columns = mapping.map((row) => row.sink);
  const counters = newCopyCounters();

  try {
    const result = await io.writeRows({
      columns,
      mode,
      onBatch: (rowsWritten) => {
        counters.rowsWritten = rowsWritten;
      },
      dataset: sink,
      connection: ctx.sink,
      batches: pumpCopyRows(io.readBatches({ dataset: source, signal: ctx.signal }), {
        mapping: mapping as readonly CopyPumpMappingEntry[],
        counters,
      }),
      signal: ctx.signal,
    });
    counters.rowsWritten = result.rowsWritten;
    if (counters.rowsFailed > 0) {
      yield {
        type: 'warned',
        code: WARNING_CODES.COPY_ROWS_FAILED,
        reason: failureSummary(counters),
      };
    }
    yield { type: 'succeeded', outputs: copyOutputs(counters) };
  } catch (err) {
    // §10: "a cancel must never leave a silent partial". `node.failed` carries no
    // outputs, so a failed or cancelled copy would otherwise report how far it
    // got NOWHERE — the counters would die with the throw. Emitting them as
    // `output` events first is what makes a partial legible; the executor keeps
    // every buffered event regardless of which terminal follows.
    for (const [name, value] of Object.entries(copyOutputs(counters))) {
      yield { type: 'output', name, value };
    }
    if (counters.rowsFailed > 0) {
      yield {
        type: 'warned',
        code: WARNING_CODES.COPY_ROWS_FAILED,
        reason: failureSummary(counters),
      };
    }
    yield copyFailure(err);
  }
}
