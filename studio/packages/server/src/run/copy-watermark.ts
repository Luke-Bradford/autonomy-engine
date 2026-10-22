import { canonicalStringify, type SqlParameterValue } from '@autonomy-studio/shared';
import type { ResolvedDataset } from '../connectors/types.js';
import {
  getCopyWatermark,
  putCopyWatermark,
  type CopyWatermarkKey,
} from '../repo/copy-watermarks.js';
import type { Db } from '../repo/types.js';
import { sha256Hex } from '../util/hash.js';

/**
 * #1600 OR41 C5a — Watermark from Automatic, the executor's half: which stored
 * watermark a copy reads (its key), the lease that keeps two attempts from
 * copying the same rows at once, and the `commit` the copy calls once its sink
 * has committed.
 */

/**
 * The copy a watermark belongs to, as a hash: the resolved source (connection,
 * dataset kind and config, a query's bind values included), the watermark
 * column and the resolved sink (connection, dataset kind and config). One node
 * that reads different sources (a `${}` connection, a parameterised query, a
 * child pipeline called with other parameters) so keeps a watermark per source
 * instead of advancing one past rows it never read, and pointing it at another
 * sink table starts that table from nothing. The query timeout is left out: it
 * changes how long a read may take, not what it reads.
 */
export function copyWatermarkKey(input: {
  readonly source: { readonly connectionId: string | undefined; readonly dataset: ResolvedDataset };
  readonly sink: {
    readonly connectionId: string | undefined;
    readonly dataset: ResolvedDataset | undefined;
  };
  readonly column: string;
}): string {
  const end = (connectionId: string | undefined, dataset: ResolvedDataset | undefined) => {
    if (dataset === undefined) return { connectionId: connectionId ?? null };
    const config: Record<string, unknown> = { ...dataset.config };
    delete config['queryTimeoutSeconds'];
    return { connectionId: connectionId ?? null, kind: dataset.kind, config };
  };
  return sha256Hex(
    canonicalStringify({
      source: end(input.source.connectionId, input.source.dataset),
      column: input.column,
      sink: end(input.sink.connectionId, input.sink.dataset),
    }),
  );
}

/**
 * The keys an attempt holds from reading its old watermark until it ends. One
 * process runs every attempt, so a set is the whole lock. Two runs copying the
 * same source at once would both read the same old watermark and both copy the
 * rows above it.
 */
const held = new Set<string>();

export interface CopyWatermarkLease {
  readonly old: SqlParameterValue;
  readonly commit: (next: SqlParameterValue) => void;
  readonly release: () => void;
}

/**
 * Take the lease on `key` and read its stored watermark, or `'busy'` when
 * another attempt holds it. `release` is idempotent; the caller calls it when
 * the attempt ends, on every path.
 */
export function acquireCopyWatermark(
  db: Db,
  key: CopyWatermarkKey & { readonly column: string; readonly runId: string },
): CopyWatermarkLease | 'busy' {
  const id = canonicalStringify([key.pipelineId, key.nodeId, key.copyKey]);
  if (held.has(id)) return 'busy';
  held.add(id);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    held.delete(id);
  };
  try {
    const stored = getCopyWatermark(db, key);
    return {
      old: stored.found ? stored.value : null,
      commit: (next) => {
        // A null new watermark means nothing was ever above null: no row.
        if (next === null) return;
        putCopyWatermark(db, { ...key, value: next });
      },
      release,
    };
  } catch (err) {
    release();
    throw err;
  }
}
