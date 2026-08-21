import { COPY_ACTIVITY_TYPE, formatZodIssues, getActivity } from '@autonomy-studio/shared';
import { DatasetIoError } from './dataset-io-error.js';
import { writePostgresDatasetRows } from './postgres-sink.js';
import { defaultClientFactory, type PostgresClientFactory } from './postgres-session.js';
import { writeSqliteDatasetRows, type SinkValue } from './sqlite-sink.js';
import { sqliteConnectionConfigSchema } from './sqlite-store.js';
import type { ActivityContext, ResolvedDataset } from './types.js';

/**
 * #1196 M10 slice 3a — the SINK-KIND dispatch, and the one shared `refuseSink`.
 *
 * `copy.ts`'s registry docblock deferred exactly this module, and named its own
 * trigger: *"Build it when a second SINK exists (M10's postgres, or a CSV
 * writer), which is the condition that actually makes it pay."* That condition
 * has fired. Until now `sinkConnectionKinds` was `['sqlite']`, so a dispatch
 * table would have had one entry and nothing to choose between; three source
 * adapters each hardcoded the sqlite writer and each hand-wrote its own
 * "…but the sink connection is '<kind>'" sentence.
 *
 * With two sinks that stops working in both directions at once. Nine
 * source × sink pairings would need the same two-way switch written three
 * times, and the three refusal sentences would drift the moment one of them was
 * edited. Both live here now, and the refusal is derived from the CATALOG's
 * `sinkConnectionKinds` rather than a literal, so the rung and the entry that
 * makes a dispatch reachable cannot disagree.
 *
 * WHY IT IS A LEAF. It imports the two WRITERS, never the two ADAPTERS —
 * `sqlite-sink.ts`/`sqlite-store.ts` and `postgres-sink.ts`/`postgres-session.ts`
 * were extracted for precisely this, so that the adapters can import this module
 * without it importing them back. `copy.ts` still does not import it: the I/O
 * stays caller-supplied through `CopyIo`, because the SOURCE half is genuinely
 * the running adapter's and only the SINK half is a choice.
 */

/** The resolved SINK connection, as `ActivityContext` declares it. */
type ActivitySink = NonNullable<ActivityContext['sink']>;

/**
 * The store-agnostic `refuseSink` rung, built from the catalog.
 *
 * It stays a rung of `runCopyActivity`'s ladder rather than a check ahead of
 * dispatch for the reason that ladder's own docblock gives: ORDER IS A PROPERTY
 * OF THE LADDER. Ahead of dispatch it would run before the two preconditions
 * above it, so a copy that was missing a dataset end AND pointed at a foreign
 * store would be told about the store — a true statement about the second
 * problem, reported instead of the first.
 */
export function refuseForeignSink(connection: ActivitySink): string | null {
  const kinds = getActivity(COPY_ACTIVITY_TYPE)?.sinkConnectionKinds ?? [];
  if (kinds.includes(connection.kind)) return null;
  const allowed = kinds.map((k: string) => `'${k}'`).join(' or ');
  return `a copy writes into a ${allowed} store, but the sink connection is '${connection.kind}'`;
}

/** Everything a sink write needs that is not the store's own. */
export interface SinkWriteRequest {
  readonly dataset: ResolvedDataset;
  readonly connection: ActivitySink;
  /** The SINK connection's plaintext credential — `runActivity`'s FOURTH
   * argument, threaded through by whichever adapter is running. `null` for a
   * store that needs none; a store that DOES need one refuses on it itself,
   * rather than this seam guessing which stores are credentialled. */
  readonly sinkSecret: string | null;
  readonly columns: readonly string[];
  readonly mode: 'append' | 'overwrite';
  readonly onBatch: (rowsWritten: number) => void;
  readonly signal: AbortSignal | undefined;
  /** Injectable for the offline tests; the live path uses `pg.Client`. */
  readonly createClient?: PostgresClientFactory;
}

/**
 * Write into whichever store the SINK connection names.
 *
 * The sink connection is re-validated HERE, against the schema of the kind it
 * actually claims to be — never against the running adapter's own. §8 requires
 * it ("a file-backed sink must re-validate at dispatch rather than assume the
 * stored connection is well-formed"), and for a heterogeneous copy it is also
 * the only coherent option: an `fs` config has no database in it at all.
 */
export async function writeRowsToSink(
  request: SinkWriteRequest,
  batches: AsyncIterable<readonly Record<string, SinkValue>[]>,
): Promise<{ readonly rowsWritten: number }> {
  const { dataset, connection, columns, mode, onBatch, signal } = request;
  if (connection.kind === 'sqlite') {
    // THE TWO ARMS PARSE IN DIFFERENT PLACES, and the asymmetry is a decision
    // rather than leftover history. Here the parse is the arm's, because the
    // SENTENCE is what it buys: `writeSqliteDatasetRows`' own parse says
    // "invalid sqlite connection config", which reads as a complaint about the
    // connection the operator is copying FROM — the running adapter is the
    // SOURCE's, and on a heterogeneous copy that is a different store entirely.
    // The inner parse is not thereby dead: the writer is exported and directly
    // tested, and a validator that trusts its caller is one refactor away from
    // being wrong. The postgres arm below cannot do the same, because its
    // `writable` gate has to run before a session is opened — so its writer
    // holds the only parse, and says "postgres" in its own words.
    const parsed = sqliteConnectionConfigSchema.safeParse(connection.connectionConfig);
    if (!parsed.success) {
      throw new DatasetIoError(
        'permanent',
        `invalid sqlite sink connection config: ${formatZodIssues(parsed.error.issues)}`,
      );
    }
    return writeSqliteDatasetRows(
      {
        connectionConfig: parsed.data,
        datasetKind: dataset.kind,
        datasetConfig: dataset.config,
        columns,
        mode,
        onBatch,
        ...(signal === undefined ? {} : { signal }),
      },
      batches,
    );
  }
  if (connection.kind === 'postgres') {
    // NOT pre-parsed here, unlike sqlite's arm: `writePostgresDatasetRows` parses
    // its own config because the `writable` gate has to run before a session is
    // opened, and handing it a pre-parsed config would make that re-validation a
    // claim rather than a check (`fs.ts`'s wording, and its reason).
    return writePostgresDatasetRows(
      {
        createClient: request.createClient ?? defaultClientFactory,
        connectionConfig: connection.connectionConfig,
        secret: request.sinkSecret,
        datasetKind: dataset.kind,
        datasetConfig: dataset.config,
        columns,
        mode,
        onBatch,
        ...(signal === undefined ? {} : { signal }),
      },
      batches,
    );
  }
  // Unreachable through `refuseForeignSink` above, which the ladder runs first.
  // Kept as the fail-CLOSED backstop for a caller that bypassed the catalog: a
  // sink kind with no writer must refuse, never fall through to a default store.
  throw new DatasetIoError(
    'permanent',
    `no copy sink writer exists for a '${connection.kind}' store`,
  );
}
