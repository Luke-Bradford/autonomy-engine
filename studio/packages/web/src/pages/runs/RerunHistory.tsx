import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { RunSummary } from '@autonomy-studio/shared';
import { listRuns } from '../../api/runs';
import { useGuardedLoad } from '../../hooks/useGuardedLoad';
import { formatWhen } from './format';
import { runDetailPath, runLinkLabel } from './runPath';

/**
 * How many reruns the row lists. A run can be rerun repeatedly (each rerun that
 * fails can be rerun again, and #896 only refuses a SECOND rerun while one is in
 * flight), so the list is unbounded in principle; the server pages it and this
 * row shows the newest page, saying so when there are more.
 */
export const RERUN_HISTORY_LIMIT = 20;

type Reruns =
  | { phase: 'loading' }
  | { phase: 'loaded'; items: RunSummary[]; more: boolean }
  | { phase: 'error' };

/**
 * RS6 — the rerun-history grouping: the DOWNWARD half of a run's lineage, as a
 * `<dt>`/`<dd>` pair inside the detail page's `run-meta` list. `Rerun of` walks
 * from a rerun to its source; this walks from a source to its reruns, so a chain
 * R1 → R2 → R3 is navigable both ways. Direct reruns only — each rerun's own
 * page carries the next link, rather than this row re-deriving a tree.
 *
 * Read through the server's `?rerunOf=` filter, not the run's event fold: a
 * rerun is a SEPARATE run, and nothing in R1's log records that R2 exists.
 *
 * ABSENT on a run nothing has rerun — the rule `Rerun of` and `Called by` set,
 * because a permanent empty row is noise on every ordinary run. A FAILED read is
 * the exception: hiding the row then would say "never rerun", which is the one
 * thing the page does not know, so it says it could not load them instead.
 * Plain text, not an alert — a lineage lookup is not an event to announce, and
 * the page already carries its own error regions (#1249).
 *
 * NO STATUS per rerun. This is a one-shot read of the REST row, so a pill would
 * freeze whatever the rerun was doing at mount — "running" long after it
 * finished. The link is the way to its live status; the start time identifies
 * it. (`ChildRuns` in the drill-in declines a status for the same reason.)
 * The order is the server's, newest first, and is not re-sorted here.
 */
export function RerunHistory({ runId }: { runId: string }) {
  const guardedLoad = useGuardedLoad();
  const [reruns, setReruns] = useState<Reruns>({ phase: 'loading' });

  useEffect(() => {
    void guardedLoad(
      (signal) => listRuns({ rerunOf: runId }, undefined, signal, RERUN_HISTORY_LIMIT),
      {
        onData: (page) =>
          setReruns({ phase: 'loaded', items: page.items, more: page.nextCursor !== null }),
        onError: () => setReruns({ phase: 'error' }),
      },
    );
  }, [guardedLoad, runId]);

  if (reruns.phase === 'loading') return null;
  if (reruns.phase === 'loaded' && reruns.items.length === 0) return null;

  return (
    <>
      <dt>Reruns</dt>
      <dd>
        {reruns.phase === 'error' ? (
          <span className="page-hint">Couldn&apos;t load this run&apos;s reruns.</span>
        ) : (
          <>
            <ul className="plain-list">
              {reruns.items.map((r) => (
                <li key={r.id}>
                  <Link to={runDetailPath(r.id)} aria-label={runLinkLabel('Rerun', r.id)}>
                    <code>{r.id}</code>
                  </Link>{' '}
                  <span className="rerun-history-when">started {formatWhen(r.startedAt)}</span>
                </li>
              ))}
            </ul>
            {reruns.more && (
              <p className="page-hint">Showing the {RERUN_HISTORY_LIMIT} newest reruns.</p>
            )}
          </>
        )}
      </dd>
    </>
  );
}
