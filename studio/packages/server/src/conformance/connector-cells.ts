import {
  ConnectionKindSchema,
  catalog as activityCatalog,
  type ActivityCatalog,
  type ConnectionKind,
  type DatasetKind,
} from '@autonomy-studio/shared';
import { STORE_DATASET_KINDS } from './copy-endpoints.js';

/**
 * #1574 OR39 — the connector × capability matrix's REQUIRED cells, derived from
 * the code that declares them:
 *
 *  - every connection kind (the `ConnectionKind` enum, and every kind the
 *    adapter registry holds) has a draft and a saved probe;
 *  - every catalog activity a kind can bind, on each side it can bind it
 *    (`activity:` source / single connection, `sink:` paired sink, `log:` the
 *    session log's own connection);
 *  - every store kind that holds datasets (`STORE_DATASET_KINDS`) has preview
 *    and schema import.
 *
 * The matrix's guard compares this set with the cell table, both ways: a kind
 * or capability with no cell fails, and so does a cell nothing declares.
 */

export type Capability =
  | 'probe:draft'
  | 'probe:saved'
  | 'dataset:preview'
  | 'dataset:schema'
  | `activity:${string}`
  | `sink:${string}`
  | `log:${string}`;

/** A cell id, `<kind>/<capability>`: `fs/activity:file_read`. */
export type ConnectorCellId = `${ConnectionKind}/${Capability}`;

export function requiredConnectorCells(
  args: {
    kinds?: readonly string[];
    catalog?: ActivityCatalog;
    storeKinds?: Partial<Record<string, readonly DatasetKind[]>>;
  } = {},
): string[] {
  const kinds = args.kinds ?? ConnectionKindSchema.options;
  const catalog = args.catalog ?? activityCatalog;
  const storeKinds: Partial<Record<string, readonly DatasetKind[]>> =
    args.storeKinds ?? STORE_DATASET_KINDS;
  const cells: string[] = [];
  for (const kind of kinds) {
    cells.push(`${kind}/probe:draft`, `${kind}/probe:saved`);
    for (const entry of catalog.values()) {
      const k = kind as ConnectionKind;
      if (entry.connectionKinds.includes(k)) cells.push(`${kind}/activity:${entry.type}`);
      if (entry.sinkConnectionKinds?.includes(k)) cells.push(`${kind}/sink:${entry.type}`);
      if (entry.logConnectionKinds?.includes(k)) cells.push(`${kind}/log:${entry.type}`);
    }
    if ((storeKinds[kind]?.length ?? 0) > 0) {
      cells.push(`${kind}/dataset:preview`, `${kind}/dataset:schema`);
    }
  }
  return cells.sort();
}
