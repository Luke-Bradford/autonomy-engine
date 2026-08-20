import {
  checkSourceDrift,
  copyDispatchInputSchema,
  CopyMappingError,
  newCopyCounters,
  nocaseFold,
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
  /**
   * #1148 M6 (§7) — the source's ACTUAL column names, discovered WITHOUT reading
   * a row, so the gate below can run "before the first row moves".
   *
   * REQUIRED rather than optional, and that polarity is the point: an optional
   * describe is a gate a store can decline, and a store that declines it copies
   * with no source-side drift checking at all while reading exactly like one
   * that passed. M7's `delimited` source implements it from the CSV header row;
   * M10's postgres from its result-set description.
   *
   * It must classify its OWN failures — a store that cannot be REACHED is
   * `transient` and is not drift.
   */
  readonly describeSource: (args: {
    readonly dataset: ResolvedDataset;
    readonly signal: AbortSignal | undefined;
  }) => Promise<readonly string[]>;
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
  /**
   * The store-specific check on the SINK CONNECTION — returns a refusal reason,
   * or `null` to accept. Optional: a store with nothing to say about a sink
   * beyond "I can write it" simply omits it.
   *
   * It lives here, at a rung of the ladder below, rather than ahead of the
   * dispatch in the adapter, so that ORDER IS A PROPERTY OF THE LADDER and not
   * of where each caller happened to put its own guard. Ahead of dispatch it
   * ran before the two preconditions above it, so a copy that was missing a
   * dataset end AND pointed at a foreign store was told about the store — a
   * true statement about the second problem, reported instead of the first.
   */
  readonly refuseSink?: (connection: ActivitySink) => string | null;
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
  // Folded the way SQLite's NOCASE folds, via the SAME helper the pump plans
  // columns with. A case-sensitive check here would be the odd one out: a sink
  // declaring 'ID' and a mapping naming 'id' are ONE column to the store, so an
  // exact-match miss would let the null through to become the mid-transaction
  // constraint violation this rung exists to move to the boundary.
  const nonNullable = new Set(
    columns.filter((column) => !column.nullable).map((column) => nocaseFold(column.name)),
  );
  const offender = mapping.find(
    (row) => row.onError === 'null' && nonNullable.has(nocaseFold(row.sink)),
  );
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
  const sinkRefusal = io.refuseSink?.(ctx.sink) ?? null;
  if (sinkRefusal !== null) {
    yield failed('permanent', sinkRefusal);
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

  // §7's SOURCE half, and the reason M6 exists: until now the only source-column
  // check ran inside `planColumns`, from the FIRST ROW's key set. That meant it
  // fired from inside the sink's already-open write transaction, and did not
  // fire AT ALL against an empty source — a mapping naming a column the store
  // does not have reported SUCCESS over 0 rows.
  //
  // This rung sits AFTER the refusals above and BEFORE anything is opened for
  // writing, which is exactly what §7 means by "checked before the first row
  // moves". The pump's own check STAYS: it is the binding-time truth, it has
  // seen the rows, and it is what catches a source that changed between being
  // described and being read. They share one predicate (`schema-drift.ts`) so
  // they cannot disagree about what "the same column" means.
  let sourceColumns: readonly string[];
  try {
    sourceColumns = await io.describeSource({ dataset: source, signal: ctx.signal });
  } catch (err) {
    // Through the SAME mapper the copy body uses, so a store that could not be
    // REACHED keeps its own `kind`. Reporting a `SQLITE_BUSY` here as a
    // permanent mapping fault would send an operator to fix a mapping that is
    // correct, and would deny a retry that would have worked.
    yield copyFailure(err);
    return;
  }
  const drift = checkSourceDrift(mapping as readonly CopyPumpMappingEntry[], sourceColumns);
  if (drift.ambiguous.length > 0 || drift.missing.length > 0) {
    // Ambiguity first, and missing second, matching the order `planColumns`
    // reports them in: an ambiguous name cannot be resolved at all, where a
    // missing one at least has a legitimate `onError: 'null'` answer. The two
    // paths must read identically — an operator who sees one message at dispatch
    // and a differently-worded one at bind time has to work out whether they are
    // the same problem.
    const error =
      drift.ambiguous.length > 0
        ? new CopyMappingError(
            'ambiguous_source_column',
            `the source has more than one column matching ${drift.ambiguous.map((c) => `\`${c}\``).join(', ')} case-insensitively; name the column exactly`,
          )
        : new CopyMappingError(
            'missing_source_column',
            `the source has no column named ${drift.missing.map((c) => `\`${c}\``).join(', ')}`,
          );
    yield copyFailure(error);
    return;
  }

  // The sink's write column list is the mapping's OWN sink names — every row,
  // including expression-only ones, which write a constant and are as much a
  // written column as a copied one. It cannot be derived from the rows the pump
  // yields: a batch whose rows all failed yields nothing at all.
  const columns = mapping.map((row) => row.sink);
  const counters = newCopyCounters();

  // §7 row 4 — ALLOWED, so it never blocks the copy, and never silent either.
  // Yielded HERE, before the write, rather than beside the terminal like
  // `COPY_ROWS_FAILED`: that one is a fact the copy only learns by running,
  // while this one is already known. Emitting it once up front is what puts it
  // on the FAILING path too — and a copy that then failed for an unrelated
  // reason is exactly the one whose operator is reading the log. The executor
  // buffers every adapter event and replays them in order around the terminal
  // (`executor.ts`), so an early yield costs nothing in the run log's ordering.
  if (drift.unmapped.length > 0) {
    yield {
      type: 'warned',
      code: WARNING_CODES.COPY_SOURCE_COLUMNS_UNMAPPED,
      reason:
        `the source carries ${drift.unmapped.length} column(s) the mapping does not read: ` +
        `${drift.unmapped.map((c) => `'${c}'`).join(', ')}`,
    };
  }

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
    //
    // On the SUCCESS path they would be redundant with `succeeded.outputs`, so
    // they are emitted here only. §5 also asks for per-batch ticks during a long
    // copy; those are NOT emitted, and #1135 records why — `runAdapter` buffers
    // every event until the terminal (`executor.ts:788` collects, `:1283`
    // yields), so a tick cannot reach anyone before the copy has already
    // finished. Building the machinery would produce a record identical to the
    // one below.
    // `onBatch` ticks the RUNNING TOTAL of rows inserted into the still-OPEN
    // transaction, and the sink's own docblock is explicit that "a tick is
    // progress, not committed truth … an operator can legitimately see '500
    // rows' moments before the copy reports that it wrote none". Reporting that
    // tick as the final count would do exactly what it warns against, in the
    // worse direction: claiming rows landed on a run that wrote nothing.
    //
    // `partialWritePossible` is the sink's own verdict on that question — false
    // means it can PROVE the store is in its pre-copy state (a rolled-back
    // transaction, or a read that never wrote). Where it can prove it, the
    // honest count is 0. Where it cannot, the running total is the best evidence
    // there is and `copyFailure` says so in the message.
    if (err instanceof DatasetIoError && !err.partialWritePossible) {
      counters.rowsWritten = 0;
    }
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
