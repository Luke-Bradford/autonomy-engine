import type {
  ActivityRun,
  ActivityRunGroup,
  ActivityRunIterationGroup,
} from '@autonomy-studio/shared';

/** One line of the activity-runs table, in display order. `parents` are the
 * keys of the group and iteration lines it sits under, outermost first, so a
 * collapsed one hides it. */
export type ActivityRunEntry =
  | { kind: 'group'; key: string; depth: 0; parents: []; group: ActivityRunGroup }
  | {
      kind: 'iteration';
      key: string;
      depth: 1;
      parents: [string];
      group: ActivityRunGroup;
      iteration: ActivityRunIterationGroup;
    }
  | { kind: 'row'; key: string; depth: 0 | 1 | 2; parents: string[]; row: ActivityRun };

const groupKey = (containerId: string) => `group:${containerId}`;
const iterationKey = (containerId: string, index: number) => `iter:${containerId}:${index}`;

/**
 * #1484 OR35 M2 — the table's lines: each container's group where the server
 * placed it among the rows (`position`), then its rows under it. A ForEach or
 * Until puts each item or round on a line of its own with that iteration's rows
 * under it; rows with no iteration (a Stage's, or what a rerun reused) sit
 * directly under the group. A row naming a container that is not a group stays
 * where it is, so nothing the server sent is dropped.
 *
 * Grouping is read off the server's `containerId` and `iteration`; nothing here
 * decides which container an activity is in.
 */
export function activityRunEntries(
  rows: readonly ActivityRun[],
  groups: readonly ActivityRunGroup[],
): ActivityRunEntry[] {
  const groupIds = new Set(groups.map((g) => g.containerId));
  const members = new Map<string, ActivityRun[]>();
  for (const row of rows) {
    if (row.containerId === null || !groupIds.has(row.containerId)) continue;
    const list = members.get(row.containerId) ?? [];
    list.push(row);
    members.set(row.containerId, list);
  }

  const out: ActivityRunEntry[] = [];
  const emitGroup = (group: ActivityRunGroup) => {
    const gKey = groupKey(group.containerId);
    out.push({ kind: 'group', key: gKey, depth: 0, parents: [], group });
    // Each row once into its iteration's bucket, so a ForEach of many items is
    // one pass over its rows rather than one per item.
    const byIndex = new Map(group.iterations.map((it) => [it.index, [] as ActivityRun[]]));
    for (const row of members.get(group.containerId) ?? []) {
      const bucket = row.iteration === null ? undefined : byIndex.get(row.iteration.index);
      if (bucket !== undefined) bucket.push(row);
      else out.push({ kind: 'row', key: row.key, depth: 1, parents: [gKey], row });
    }
    for (const iteration of group.iterations) {
      const iKey = iterationKey(group.containerId, iteration.index);
      out.push({ kind: 'iteration', key: iKey, depth: 1, parents: [gKey], group, iteration });
      for (const row of byIndex.get(iteration.index) ?? []) {
        out.push({ kind: 'row', key: row.key, depth: 2, parents: [gKey, iKey], row });
      }
    }
  };

  const sorted = [...groups].sort((a, b) => a.position - b.position);
  let next = 0;
  rows.forEach((row, i) => {
    while (next < sorted.length && sorted[next]!.position <= i) emitGroup(sorted[next++]!);
    if (row.containerId === null || !groupIds.has(row.containerId))
      out.push({ kind: 'row', key: row.key, depth: 0, parents: [], row });
  });
  while (next < sorted.length) emitGroup(sorted[next++]!);
  return out;
}

/**
 * #1484 M2 — the activity run a graph node opens. A node is one box however
 * many attempts and items it ran, so the box opens the run that explains how
 * it ended: the last run of any instance (an item, a round, the node itself)
 * whose LAST attempt failed, otherwise the node's last run. So a ForEach item
 * that failed is opened over a later item that succeeded, and a node that
 * recovered on a retry opens the attempt that succeeded rather than the one it
 * got past.
 *
 * Read off the rows alone, not the projected state: a parallel ForEach's items
 * are projected under their instance keys (`w@2`) and never under the box's
 * id, so the box has no state of its own to ask. Matched on `activityId`, the
 * canvas node, so a parallel item is found by the box it is drawn as. `null`
 * for a node with no run, which then offers nothing to open.
 */
export function activityRunOfNode(
  rows: readonly ActivityRun[],
  activityId: string,
): ActivityRun | null {
  const own = rows.filter((r) => r.activityId === activityId);
  // Each instance's last attempt, in run order: a retry supersedes its failure.
  const lastOf = new Map<string, ActivityRun>();
  for (const r of own) {
    lastOf.set(`${r.nodeId}\n${r.iteration?.containerId ?? ''}\n${r.iteration?.index ?? ''}`, r);
  }
  const failed = [...lastOf.values()].filter((r) => r.status === 'failure');
  return failed.at(-1) ?? own.at(-1) ?? null;
}
