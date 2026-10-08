import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useLatestSearchParams } from '../../lib/useLatestSearchParams';
import {
  CONTAINER_KIND_LABELS,
  RUN_SEARCH_MAX_CHARS,
  TERMINAL_RUN_ROW_STATUS,
  runStartIsReal,
  type ActivityRun,
  type ActivityRunChild,
  type ActivityRunGroup,
  type ActivityRunsBasis,
  type RunStatus,
  type SkipReason,
} from '@autonomy-studio/shared';
import { ariaSortOf } from '../../lib/urlSort';
import { When } from '../../lib/When';
import { countOf } from '../../lib/countOf';
import { LabelledControl } from '../../lib/LabelledControl';
import { HelpDisclosure } from '../../lib/HelpDisclosure';
import { withParams } from '../../lib/withParams';
import { useSearchBox } from '../../lib/useSearchBox';
import { FilterPicker, type FilterOption } from './FilterPicker';
import { SortButton } from '../../lib/SortButton';
import { RunDuration } from './RunHeader';
import { runStatusLabel } from './runStatus';
import {
  ACTIVITY_RUN_SORT_COLUMNS,
  ACTIVITY_RUNS_PARAMS,
  activityRunSortParams,
  activityRunsViewParams,
  isViewChanged,
  nextActivityRunSort,
  parseStatusKey,
  readActivityRunsView,
  statusKeyLabel,
  statusKeyOf,
  viewEntries,
  type ActivityRunStatusKey,
  type RowFacts,
} from './activityRunsView';
import { failureClass, formatCount, formatElapsed, formatOutputValue } from './format';
import { LiveElapsed } from './NodeDuration';
import { isSecureMarker } from './secureMarker';
import {
  containerStatusLabel,
  containerStatusPillClass,
  nodeStatusLabel,
  nodeStatusPillClass,
} from './nodeStatus';
import { runDetailPath } from './runPath';
import { ACTIVITY_RUN_COLUMNS, iterationLabel, iterationText } from './activityRunsColumns';
import { RUN_DRAWER_ID } from './RunDrawer';
import { activityRunEntries } from './activityRunsTree';
import { skipReasonText } from './skipReasonText';

/**
 * Bytes as the activity reported them, saying which way they moved. A copy's
 * `bytesRead` is the size of the values it read (data-movement spec §5), not
 * the source file's size on disk, so it says "data bytes" (#1482 item 4).
 */
function bytesText(row: ActivityRun): string {
  const parts: string[] = [];
  if (row.bytesRead !== null) parts.push(`${formatCount(row.bytesRead)} data bytes read`);
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

/** A skip's reason after its status pill: `skipped · upstream failed: Copy 1`. */
export function SkipWhy({
  status,
  reason,
  nameOf,
}: {
  status: string;
  reason: SkipReason | null;
  nameOf: (id: string) => string | null;
}) {
  if (status !== 'skipped' || reason === null) return null;
  return (
    <span className="activity-runs__why">
      {' · '}
      {skipReasonText(reason, nameOf)}
    </span>
  );
}

/**
 * #1299 — a running attempt's latest streamed value, after its status, so a
 * long copy's per-batch progress reads as progress rather than a hang. Once the
 * attempt settles its outputs are the truth, and the drawer shows them.
 *
 * #1312 — a secure node's stream is redacted name AND value; say so rather than
 * print the marker twice. The drawer explains the setting.
 */
function StreamedSoFar({ output }: { output: { name: string; value: unknown } | undefined }) {
  if (output === undefined) return null;
  return (
    <span className="activity-runs__why">
      {' · '}
      {isSecureMarker(output.name)
        ? 'output withheld: this node is secure'
        : `${output.name}: ${formatOutputValue(output.value)}`}
    </span>
  );
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

/** The params that put the table back in plain run order. */
const PLAIN_VIEW = activityRunsViewParams({ status: null, type: null, q: null, sort: null });

/**
 * #1484 M2 — an Execute Pipeline row's called run: its pipeline, how it stands
 * and how long it took (the child's own row, read with the activity runs). The
 * clock counts only while the page is live and the child unfinished, as the run
 * header's does, so an interrupted child never ticks forever.
 */
function ChildRunCell({ child, live }: { child: ActivityRunChild; live: boolean }) {
  return (
    <>
      <Link to={runDetailPath(child.id)}>{child.pipelineName ?? <code>{child.id}</code>}</Link>
      {' · '}
      <span className={`run-status run-status-${child.status}`}>
        {runStatusLabel(child.status)}
      </span>
      {runStartIsReal(child) && (
        <>
          {' · '}
          <RunDuration
            status={child.status}
            startedAt={child.startedAt}
            endedAt={child.finishedAt}
            counting={
              live && child.finishedAt === null && !TERMINAL_RUN_ROW_STATUS.has(child.status)
            }
          />
        </>
      )}
    </>
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

/** #1557 — what a log-only account leaves out (`projectActivityRunsFromLog`). */
const LOG_BASIS_NOTE =
  'The version this run used can no longer be read, so these rows come from the run log alone. ' +
  'Containers, ForEach items, skipped activities and retry numbers are missing, ' +
  'and each status is as the log recorded it.';

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
 *
 * It can be filtered by status, type and text, and sorted by a header click
 * (`activityRunsView.ts`); the view lives in the URL. A filter keeps a row's
 * group and item lines; a sort is one flat list.
 */
export function ActivityRunsTable({
  rows,
  groups,
  basis = 'version',
  error,
  runStatus,
  nameOf,
  typeOf,
  containerNameOf,
  selected = null,
  live = false,
  openKey = null,
  onOpen,
  latestOutputs,
}: {
  rows: readonly ActivityRun[] | null;
  groups: readonly ActivityRunGroup[];
  /** #1557 — `log` when the run's version no longer resolves and the rows
   * come from the log alone; the table says so. */
  basis?: ActivityRunsBasis | null;
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
  /** Whether the page would hear the run settle; a called run's duration
   * counts up only then (`streamStillLive`). */
  live?: boolean;
  /** The row the detail drawer shows, if it is open. */
  openKey?: string | null;
  /** Opens the detail drawer on a row; the activity's name is the button. */
  onOpen?: (key: string, opener: HTMLElement) => void;
  /** Each attempt's latest streamed value (`latestOutputByAttempt`), shown on
   * its row while it runs. */
  latestOutputs?: ReadonlyMap<string, { name: string; value: unknown }>;
}) {
  const selectedRow = useRef<HTMLTableRowElement>(null);
  /** A skip's cause may be an activity or a container. */
  const anyNameOf = (id: string) => nameOf(id) ?? containerNameOf(id);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const entries = useMemo(
    () => (rows === null ? [] : activityRunEntries(rows, groups)),
    [rows, groups],
  );
  const [searchParams, setSearchParams] = useLatestSearchParams();
  const view = readActivityRunsView(searchParams);
  /* Each control writes only its OWN params, so two quick changes cannot undo
     each other, and pushes a history entry, so Back steps out of a filter as
     it does on the runs list. */
  const setParams = (next: Record<string, string>) =>
    setSearchParams((prev) => withParams(prev, next));
  const [searchText, setSearchText] = useSearchBox(view.q, (next, replace) =>
    setSearchParams((prev) => withParams(prev, { [ACTIVITY_RUNS_PARAMS.q]: next }), { replace }),
  );
  // Clear drops text typed but not yet searched, too.
  const clearView = () => {
    setSearchText('');
    setParams(PLAIN_VIEW);
  };
  const labelOf = (key: ActivityRunStatusKey) => statusKeyLabel(key, runStatus);

  const factsOf = (row: ActivityRun): RowFacts => {
    const name = nameOf(row.activityId);
    const type = typeOf(row.activityId);
    const statusLabel = labelOf(statusKeyOf(row));
    const text = [
      name,
      row.nodeId,
      type,
      statusLabel,
      iterationText(row.iteration),
      row.branch,
      row.error?.message,
      row.childRun?.pipelineName,
      row.childRunId,
      row.skipReason === null ? null : skipReasonText(row.skipReason, anyNameOf),
      row.containerId === null ? null : containerNameOf(row.containerId),
    ]
      .filter((t) => t !== null && t !== undefined && t !== '')
      .join(' ')
      .toLowerCase();
    return { name, type, statusLabel, text };
  };
  const shown = viewEntries(entries, view, factsOf, labelOf);
  /* The filter's choices are what the WHOLE run has, not what the filter left,
     so a chosen status never drops out of its own list as the rows change. One
     choice per WORDING: keys that read alike are one status to the reader. */
  const statusOptions: FilterOption[] = [];
  const typeOptions: FilterOption[] = [];
  for (const row of rows ?? []) {
    const key = statusKeyOf(row);
    const label = labelOf(key);
    if (!statusOptions.some((o) => o.label === label)) statusOptions.push({ value: key, label });
    const type = typeOf(row.activityId);
    if (type !== null && !typeOptions.some((o) => o.value === type))
      typeOptions.push({ value: type, label: type });
  }
  typeOptions.sort((a, b) => a.label.localeCompare(b.label));
  // A linked key that reads like an offered one shows as that one.
  const pickedStatus =
    view.status === null
      ? undefined
      : (statusOptions.find((o) => o.label === labelOf(view.status!))?.value ?? view.status);
  const changed = isViewChanged(view) || searchText.trim() !== '';

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
  /* Each ask is answered ONCE. A new ask for a row the view hides puts the view
     back to plain run order, so "Show activity" lands on the row rather than on
     nothing; once the row is on screen it is scrolled to. Focus stays where the
     asker put it: "Show activity" opens the row's drawer too, which takes focus
     and hands it back to that button. A filter the viewer sets afterwards
     stands, even one that hides that row. */
  const askedShown = askedFor !== null && shown.some((e) => e.key === askedFor.key);
  const answeredAsk = useRef<{ key: string } | null>(null);
  /* The reset happens at most once per ask, so an ask whose row a later read
     no longer has can never keep wiping the viewer's view. */
  const resetFor = useRef<{ key: string } | null>(null);
  useEffect(() => {
    if (askedFor === null || askedFor === answeredAsk.current) return;
    if (!askedShown) {
      if (resetFor.current !== askedFor) {
        resetFor.current = askedFor;
        setSearchParams((prev) => withParams(prev, PLAIN_VIEW), { replace: true });
      }
      return;
    }
    answeredAsk.current = askedFor;
    // jsdom has no `scrollIntoView`.
    selectedRow.current?.scrollIntoView?.({ block: 'center' });
  }, [askedFor, askedShown, setSearchParams]);
  return (
    <section className="activity-runs" aria-labelledby="activity-runs-heading">
      <div className="activity-runs__bar">
        <h3 id="activity-runs-heading">Activity runs</h3>
        {rows !== null && rows.length > 0 && (
          <>
            <FilterPicker
              label={<span className="visually-hidden">Status</span>}
              allLabel="All statuses"
              value={pickedStatus}
              options={statusOptions}
              onChange={(v) =>
                setParams({ [ACTIVITY_RUNS_PARAMS.status]: parseStatusKey(v) ?? '' })
              }
            />
            <FilterPicker
              label={<span className="visually-hidden">Type</span>}
              allLabel="All types"
              value={view.type ?? undefined}
              options={typeOptions}
              onChange={(v) => setParams({ [ACTIVITY_RUNS_PARAMS.type]: v })}
            />
            <div role="search" className="activity-runs__search">
              <LabelledControl
                label={<span className="visually-hidden">Search activity runs</span>}
              >
                {(id) => (
                  <input
                    id={id}
                    type="search"
                    maxLength={RUN_SEARCH_MAX_CHARS}
                    placeholder="Search activity, item, error…"
                    value={searchText}
                    onChange={(e) => setSearchText(e.target.value)}
                  />
                )}
              </LabelledControl>
            </div>
            {changed && (
              <button type="button" onClick={clearView}>
                Clear
              </button>
            )}
          </>
        )}
      </div>
      {error !== null && (
        <p role="alert" className="error">
          Could not read the activity runs: {error}
        </p>
      )}
      {basis === 'log' && (
        <p className="activity-runs__basis">
          <span>
            Version unavailable: rows from the run log only
          </span>
          <HelpDisclosure label="About rows from the run log" noteId="activity-runs-basis-note">
            {LOG_BASIS_NOTE}
          </HelpDisclosure>
        </p>
      )}
      {rows === null ? (
        error === null && <p>Loading activity runs…</p>
      ) : entries.length === 0 ? (
        <p>No activity has run yet.</p>
      ) : shown.length === 0 ? (
        <p>No matches.</p>
      ) : (
        <div className="activity-runs__scroll">
          <table className="activity-runs__table">
            <thead>
              <tr>
                {ACTIVITY_RUN_COLUMNS.map((c) => {
                  const key = ACTIVITY_RUN_SORT_COLUMNS[c];
                  const active = key !== undefined && view.sort?.key === key;
                  return (
                    <th
                      key={c}
                      scope="col"
                      aria-sort={ariaSortOf(active ? (view.sort?.dir ?? null) : null)}
                    >
                      {key === undefined ? (
                        c
                      ) : (
                        <SortButton
                          dir={active ? view.sort!.dir : null}
                          onClick={() =>
                            setParams(activityRunSortParams(nextActivityRunSort(view.sort, key)))
                          }
                        >
                          {c}
                        </SortButton>
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {shown.map((entry) => {
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
                        <SkipWhy
                          status={group.status}
                          reason={group.skipReason}
                          nameOf={anyNameOf}
                        />
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
                          {iterationLabel(group.kind, {
                            ...iteration,
                            containerId: group.containerId,
                          })}
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
                // The class beside the message, as the drawer's Failure section names it.
                const cls =
                  row.error === null
                    ? ''
                    : failureClass(row.error.kind ?? undefined, row.error.code ?? undefined);
                return (
                  <tr
                    key={row.key}
                    data-activity-id={row.activityId}
                    data-depth={entry.depth}
                    data-open={row.key === openKey ? true : undefined}
                    {...(row.key === selected?.key
                      ? {
                          ref: selectedRow,
                          'aria-current': true,
                          className: 'activity-runs__selected',
                        }
                      : {})}
                  >
                    <td title={row.nodeId}>
                      {onOpen === undefined ? (
                        (name ?? <code>{row.nodeId}</code>)
                      ) : (
                        /* A real button: named by its own text and
                           keyboard-operable for free. */
                        <button
                          type="button"
                          className="activity-runs__open"
                          aria-expanded={row.key === openKey}
                          aria-controls={row.key === openKey ? RUN_DRAWER_ID : undefined}
                          onClick={(event) => onOpen(row.key, event.currentTarget)}
                        >
                          {name ?? <code>{row.nodeId}</code>}
                        </button>
                      )}
                      {/* A sorted list has no group lines, so a row says where it ran. */}
                      {view.sort !== null && row.containerId !== null && (
                        <span className="activity-runs__why">
                          {' · in '}
                          {containerNameOf(row.containerId) ?? row.containerId}
                        </span>
                      )}
                    </td>
                    <td>{typeOf(row.activityId) ?? ''}</td>
                    <td>
                      {row.reused ? (
                        <span className={nodeStatusPillClass('success', runStatus)}>reused</span>
                      ) : (
                        <span className={nodeStatusPillClass(row.status, runStatus)}>
                          {nodeStatusLabel(row.status, runStatus)}
                        </span>
                      )}
                      <SkipWhy status={row.status} reason={row.skipReason} nameOf={anyNameOf} />
                      {row.status === 'dispatched' && row.attemptId !== null && (
                        <StreamedSoFar output={latestOutputs?.get(row.attemptId)} />
                      )}
                    </td>
                    <td>
                      <When ms={row.startedAt} precision="ms" timeOfDay />
                    </td>
                    <td>
                      <When ms={row.finishedAt} precision="ms" timeOfDay />
                    </td>
                    <td className="num">
                      {row.durationMs !== null ? (
                        formatElapsed(row.durationMs)
                      ) : row.startedAt !== null && row.finishedAt === null && live ? (
                        /* #890 — an open attempt counts up while the page would
                           hear it settle; otherwise the cell waits for the
                           read model's figure. */
                        <LiveElapsed startedAtMs={row.startedAt} />
                      ) : (
                        ''
                      )}
                    </td>
                    <td className="num">{row.attempt ?? ''}</td>
                    <td>{iterationText(row.iteration)}</td>
                    <td>{row.branch ?? ''}</td>
                    <td className="num">{count(row.rowsRead)}</td>
                    <td className="num">{count(row.rowsWritten)}</td>
                    <td className="num">{bytesText(row)}</td>
                    <td>
                      {row.childRun !== null ? (
                        <ChildRunCell child={row.childRun} live={live} />
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
