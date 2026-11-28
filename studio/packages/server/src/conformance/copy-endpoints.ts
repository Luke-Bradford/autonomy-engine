import {
  COPY_ACTIVITY_TYPE,
  getActivity,
  type ConnectionKind,
  type DatasetKind,
} from '@autonomy-studio/shared';
import { FS_DATASET_KINDS } from '../connectors/fs-connection.js';
import { POSTGRES_DATASET_KINDS } from '../connectors/postgres-session.js';
import { SQLITE_DATASET_KINDS } from '../connectors/sqlite-store.js';

/**
 * #1574 OR39 — which ends a Copy can have, DERIVED from the code that decides
 * it: the catalog's `copy` entry (which connection and dataset kinds each side
 * accepts) intersected with what each store says it holds. The copy matrix must
 * have a cell for every source × sink pair this yields, so a new store, a new
 * file format or a newly writable kind is forced into the matrix rather than
 * remembered.
 */

/** One end of a copy: a connection kind and a dataset kind on it, `fs:delimited`. */
export type CopyEndpoint = `${ConnectionKind}:${DatasetKind}`;

/**
 * The dataset kinds each store connection kind holds, from each store's own
 * list. A connection kind the copy catalog names that is missing here is a
 * store the matrix does not know how to address, and `copyEndpoints` throws.
 */
export const STORE_DATASET_KINDS: Partial<Record<ConnectionKind, readonly DatasetKind[]>> = {
  fs: FS_DATASET_KINDS,
  sqlite: SQLITE_DATASET_KINDS,
  postgres: POSTGRES_DATASET_KINDS,
};

export function copyEndpoints(
  storeKinds: Partial<Record<ConnectionKind, readonly DatasetKind[]>> = STORE_DATASET_KINDS,
): { sources: CopyEndpoint[]; sinks: CopyEndpoint[] } {
  const copy = getActivity(COPY_ACTIVITY_TYPE);
  if (copy?.datasetKinds?.sink === undefined || copy.sinkConnectionKinds === undefined) {
    throw new Error('the copy catalog entry no longer declares both sides');
  }
  const side = (
    connectionKinds: readonly ConnectionKind[],
    datasetKinds: readonly DatasetKind[],
  ): CopyEndpoint[] =>
    connectionKinds.flatMap((c) => {
      const held = storeKinds[c];
      if (held === undefined) {
        throw new Error(`copy accepts connection kind '${c}', and the matrix has no store for it`);
      }
      return held.filter((d) => datasetKinds.includes(d)).map((d): CopyEndpoint => `${c}:${d}`);
    });
  return {
    sources: side(copy.connectionKinds, copy.datasetKinds.source),
    sinks: side(copy.sinkConnectionKinds, copy.datasetKinds.sink),
  };
}
