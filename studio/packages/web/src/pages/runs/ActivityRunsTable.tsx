import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import {
  CONTAINER_KIND_LABELS,
  type ActivityRun,
  type ActivityRunGroup,
  type ActivityRunIterationGroup,
  type RunStatus,
} from '@autonomy-studio/shared';
import { When } from '../../lib/When';
import { countOf } from '../../lib/countOf';
import { failureClass, formatCount, formatElapsed } from './format';
import {
  containerStatusLabel,
  containerStatusPillClass,
  nodeStatusLabel,
  nodeStatusPillClass,
} from './nodeStatus';
import { runDetailPath } from './runPath';
import { ACTIVITY_RUN_COLUMNS, iterationText } from './activityRunsColumns';
import { activityRunEntries } from './activityRunsTree';

/** Bytes as the activity reported them, saying which way they moved. */
function bytesText(row: ActivityRun): string {
  const parts: string[] = [];
  if (row.bytesRead !== null) parts.push(`${formatCount(row.bytesRead)} read`);
  if (row.bytesWritten !== null) parts.push(`${formatCount(row.bytesWritten)} written`);
  return parts.join(' · ');
}

const count = (n: number | null) => (n === null ? '' : formatCount(n));

/** A group's Iteration cell: how many items a ForEach had, or rounds an Until ran. */
function groupIterations(group: ActivityRunGroup): string {
  if (group.itemCount !== null) return countOf(group.itemCount, 'item');
  if (group.kind === 'loop') return countOf(group.iterations.length, 'round');
  return '';
}

/** An iteration line's label: `Item 2 of 2 · orders_b.csv`, or `Round 3`. */
function iterationLabel(group: ActivityRunGroup, it: ActivityRunIterationGroup): string {
  const { index, count, item } = it;
  const text = iterationText({ containerId: group.containerId, index, count, item });
  return group.kind === 'loop' ? `Round ${text}` : `Item ${text}`;
}

function Toggle({
  open,
  onToggle,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" className="activity-runs__toggle" aria-expanded={open} onClick={onToggle}>
      <span aria-hidden="true" className="activity-runs__chevron">
        {open ? '▾' : '▸'}
      </span>
      {children}
    </button>
  );
}

/** The Start, End and Duration cells, as a group or an iteration states them. */
function Times({
  at,
}: {
  at: { startedAt: number | null; finishedAt: number | null; durationMs: number | null };
}) {
  return (
    <>
      <td>
        <When ms={at.startedAt} precision="ms" timeOfDay />
      </td>
      <td>
        <When ms={at.finishedAt} precision="ms" timeOfDay />
      </td>
      <td className="num">{at.durationMs === null ? '' : formatElapsed(at.durationMs)}</td>
    </>
  );
}

/** The activity columns a group or iteration line has nothing for, between
 * its Iteration cell and its Error cell. */
const BETWEEN_ITERATION_AND_ERROR = ACTIVITY_RUN_COLUMNS.slice(
  ACTIVITY_RUN_COLUMNS.indexOf('Iteration') + 1,
  ACTIVITY_RUN_COLUMNS.indexOf('Error'),
);

/**
 * #1484 OR35 M2 — the run's activity runs: one row per attempt of each activity,
 * per iteration, directly under the run's header (the server's projection,
 * `GET /api/runs/:id/activity-runs`). Dense on purpose: 32px rows, 13px text,
 * numbers right-aligned. An empty cell is a fact the activity did not report,
 * not a zero.
 *
 * Containers are GROUP lines with their rows under them, and a ForEach or Until
 * has a line per item or round (`activityRunsTree.ts`). Every group and
 * iteration starts open and can be collapsed.
 *
 * Names and types come from the version that ran (`nameOf`, `typeOf`,
 * `containerNameOf`), never from the server, which names nothing.
 */
export function ActivityRunsTable({
  rows,
  groups,
  error,
  runStatus,
  nameOf,
  typeOf,
  containerNameOf,
  selected = null,
}: {
  rows: readonly ActivityRun[] | null;
  groups: readonly ActivityRunGroup[];
  error: string | null;
  runStatus: RunStatus;
  nameOf: (activityId: string) => string | null;
  typeOf: (activityId: string) => string | null;
  containerNameOf: (containerId: string) => string | null;
  /**
   * #1484 M2 — the row the failure banner's "Show activity" asked for. A new
   * object on every ask, so asking again for the same row scrolls to it again.
   * It is marked `aria-current` and takes focus; the drawer slice will own a
   * real selection model.
   */
  selected?: { key: string } | null;
}) {
  const selectedRow = useRef<HTMLTableRowElement>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const entries = useMemo(
    () => (rows === null ? [] : activityRunEntries(rows, groups)),
    [rows, groups],
  );
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  /* A NEW ask opens the group and item its row is in, during the render that
     receives it, so the effect below finds the row on screen. An ask for a row
     not read yet waits for it. Only a new ask opens anything: a later collapse
     by the viewer stands. */
  const [askedFor, setAskedFor] = useState<{ key: string } | null>(null);
  if (selected !== askedFor) {
    const asked = selected === null ? undefined : entries.find((e) => e.key === selected.key);
    if (selected === null || asked !== undefined) {
      setAskedFor(selected);
      const parents: readonly string[] = asked?.parents ?? [];
      if (parents.some((k) => collapsed.has(k))) {
        setCollapsed(new Set([...collapsed].filter((k) => !parents.includes(k))));
      }
    }
  }
  useEffect(() => {
    if (askedFor === null) return;
    const tr = selectedRow.current;
    // jsdom has no `scrollIntoView`.
    tr?.scrollIntoView?.({ block: 'center' });
    tr?.focus({ preventScroll: true });
  }, [askedFor]);
  return (
    <section className="activity-runs" aria-labelledby="activity-runs-heading">
      <h3 id="activity-runs-heading">Activity runs</h3>
      {error !== null && (
        <p role="alert" className="error">
          Could not read the activity runs: {error}
        </p>
      )}
      {rows === null ? (
        error === null && <p>Loading activity runs…</p>
      ) : entries.length === 0 ? (
        <p>No activity has run yet.</p>
      ) : (
        <div className="activity-runs__scroll">
          <table className="activity-runs__table">
            <thead>
              <tr>
                {ACTIVITY_RUN_COLUMNS.map((c) => (
                  <th key={c} scope="col">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                if (entry.parents.some((k) => collapsed.has(k))) return null;
                if (entry.kind === 'group') {
                  const { group } = entry;
                  const open = !collapsed.has(entry.key);
                  return (
                    <tr
                      key={entry.key}
                      className="activity-runs__group"
                      data-container-id={group.containerId}
                      data-depth={entry.depth}
                    >
                      <td title={group.containerId}>
                        <Toggle open={open} onToggle={() => toggle(entry.key)}>
                          {containerNameOf(group.containerId) ?? group.containerId}
                        </Toggle>
                      </td>
                      <td>{CONTAINER_KIND_LABELS[group.kind]}</td>
                      <td>
                        {group.reused ? (
                          <span className={nodeStatusPillClass('success', runStatus)}>reused</span>
                        ) : (
                          <span className={containerStatusPillClass(group.status, runStatus)}>
                            {containerStatusLabel(group.status, runStatus)}
                          </span>
                        )}
                      </td>
                      <Times at={group} />
                      <td />
                      <td>{groupIterations(group)}</td>
                      {BETWEEN_ITERATION_AND_ERROR.map((c) => (
                        <td key={c} />
                      ))}
                      <td className="activity-runs__error" title={group.reason ?? undefined}>
                        {group.reason !== null && <code>{group.reason}</code>}
                      </td>
                    </tr>
                  );
                }
                if (entry.kind === 'iteration') {
                  const { group, iteration } = entry;
                  const open = !collapsed.has(entry.key);
                  return (
                    <tr
                      key={entry.key}
                      className="activity-runs__iteration"
                      data-container-id={group.containerId}
                      data-iteration={iteration.index}
                      data-depth={entry.depth}
                    >
                      <td>
                        <Toggle open={open} onToggle={() => toggle(entry.key)}>
                          {iterationLabel(group, iteration)}
                        </Toggle>
                      </td>
                      <td />
                      <td>
                        <span className={containerStatusPillClass(iteration.status, runStatus)}>
                          {containerStatusLabel(iteration.status, runStatus)}
                        </span>
                      </td>
                      <Times at={iteration} />
                      <td />
                      <td />
                      {BETWEEN_ITERATION_AND_ERROR.map((c) => (
                        <td key={c} />
                      ))}
                      <td />
                    </tr>
                  );
                }
                const { row } = entry;
                const name = nameOf(row.activityId);
                const errorLine = row.error?.message.split('\n')[0] ?? '';
                // The class beside the message, as the node table words it.
                const cls =
                  row.error === null
                    ? ''
                    : failureClass(row.error.kind ?? undefined, row.error.code ?? undefined);
                return (
                  <tr
                    key={row.key}
                    data-activity-id={row.activityId}
                    data-depth={entry.depth}
                    {...(row.key === selected?.key
                      ? {
                          ref: selectedRow,
                          tabIndex: -1,
                          'aria-current': true,
                          className: 'activity-runs__selected',
                        }
                      : {})}
                  >
                    <td title={row.nodeId}>{name ?? <code>{row.nodeId}</code>}</td>
                    <td>{typeOf(row.activityId) ?? ''}</td>
                    <td>
                      {row.reused ? (
                        <span className={nodeStatusPillClass('success', runStatus)}>reused</span>
                      ) : (
                        <span className={nodeStatusPillClass(row.status, runStatus)}>
                          {nodeStatusLabel(row.status, runStatus)}
                        </span>
                      )}
                    </td>
                    <td>
                      <When ms={row.startedAt} precision="ms" timeOfDay />
                    </td>
                    <td>
                      <When ms={row.finishedAt} precision="ms" timeOfDay />
                    </td>
                    <td className="num">
                      {row.durationMs === null ? '' : formatElapsed(row.durationMs)}
                    </td>
                    <td className="num">{row.attempt ?? ''}</td>
                    <td>{iterationText(row.iteration)}</td>
                    <td>{row.branch ?? ''}</td>
                    <td className="num">{count(row.rowsRead)}</td>
                    <td className="num">{count(row.rowsWritten)}</td>
                    <td className="num">{bytesText(row)}</td>
                    <td>
                      {row.childRun !== null ? (
                        <Link to={runDetailPath(row.childRun.id)}>
                          {row.childRun.pipelineName ?? <code>{row.childRun.id}</code>}
                        </Link>
                      ) : row.childRunId !== null ? (
                        <code>{row.childRunId}</code>
                      ) : null}
                    </td>
                    <td className="activity-runs__error" title={row.error?.message}>
                      {cls === '' ? errorLine : `${errorLine} (${cls})`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
