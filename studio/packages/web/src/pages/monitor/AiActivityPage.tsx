import { useCallback, useState } from 'react';
import {
  formatTokenCount,
  type AiActivitySnapshot,
  type LiveRunCounts,
  type RunSince,
} from '@autonomy-studio/shared';
import { fetchAccountQuota, fetchAiActivity } from '../../api/monitor';
import { usePolledResource } from '../../hooks/usePolledResource';
import { costFigure, costHeadline } from '../runs/costReading';
import { RUN_SINCE_LABEL, RUN_SINCE_OPTIONS } from '../runs/runFilters';
import { formatElapsed, formatWhen } from '../runs/format';
import { QUOTA_UNAVAILABLE_TEXT, formatPct, readAccountQuota } from './quotaReading';

/**
 * #917 — Monitor → AI activity: what the connected AIs are doing, and how much
 * account quota is left.
 *
 * This is the surface the old prototype dashboard was still being kept alive
 * for. Every other cost view in the app is scoped to one run or one pipeline;
 * this is the cross-cutting one.
 *
 * TWO REFRESH CADENCES, deliberately, because the two panels cost different
 * things to read. AI activity is a local SQLite read over the run-event log, so
 * it polls. Quota reaches the PROVIDER, and the standing one-sampler invariant
 * means an open tab must not poll it on a timer — so it loads on mount, refreshes
 * on an explicit click, and always states when it was read. The asymmetry is
 * visible in the UI rather than hidden: the quota panel says "as of <time>", so
 * a reading the operator has not refreshed can never pass for a live one.
 */

/** Local reads are cheap; this is fast enough to feel live without being busy. */
const ACTIVITY_POLL_MS = 5_000;

/**
 * What each non-terminal status is CALLED, and the order the tiles read in.
 *
 * The wording carries the distinction the whole panel turns on: only `running`
 * is work actually happening. `pending` has a row but no drive yet, `queued` has
 * not started, and `waiting` is parked on an external wait having RELEASED its
 * concurrency slot — so none of the other three is evidence of an AI doing
 * anything, and summing them into one "live" number would claim otherwise.
 *
 * Typed as an exhaustive `Record<keyof LiveRunCounts, string>`: adding a status
 * to `LIVE_RUN_STATUSES` fails the typecheck here rather than quietly producing
 * a run the operator cannot see.
 */
const LIVE_RUN_LABEL: Record<keyof LiveRunCounts, string> = {
  running: 'Runs executing',
  pending: 'Pending',
  queued: 'Queued',
  waiting: 'Waiting',
};

/** Most-active first, so the number that means "something is happening" leads. */
const LIVE_RUN_ORDER = [
  'running',
  'pending',
  'queued',
  'waiting',
] as const satisfies readonly (keyof LiveRunCounts)[];

function useNow(): number {
  // The relative "resets in …" text is derived against a clock captured per
  // render rather than a ticking timer: the panel already re-renders on every
  // activity poll, which is far more often than a reset instant moves.
  return Date.now();
}

function QuotaPanel() {
  const fetcher = useCallback((signal: AbortSignal) => fetchAccountQuota(signal), []);
  // NO `intervalMs` — see the module docblock and `fetchAccountQuota`.
  const { data, error, loading, lastUpdatedAt, refresh } = usePolledResource(fetcher);
  const now = useNow();

  const reading = data === null ? null : readAccountQuota(data);

  return (
    <section aria-labelledby="quota-heading" className="monitor-panel">
      <div className="page-header">
        <h3 id="quota-heading">Account quota</h3>
        <button type="button" onClick={refresh}>
          Refresh quota
        </button>
      </div>
      <p className="page-hint">
        The subscription windows every connected Claude call draws on. Read on demand rather than on
        a timer — the provider allows one poller, so this asks only when you ask it to.
      </p>

      {error !== null && (
        <p role="alert" className="error">
          Could not reach the quota endpoint: {error}
        </p>
      )}

      {loading && data === null && error === null && <p className="notice">Reading quota…</p>}

      {/* An UNREADABLE quota says so, in words. It must never render as a
          percentage: "0%" would mean "wide open", the opposite of "unknown". */}
      {reading?.kind === 'unreadable' && (
        <p role="status" className="notice quota-unreadable">
          <strong>Quota UNREADABLE.</strong> {QUOTA_UNAVAILABLE_TEXT[reading.reason]}
        </p>
      )}

      {reading?.kind === 'reading' && (
        <table className="quota-table">
          <caption className="visually-hidden">Account quota by window</caption>
          <thead>
            <tr>
              <th scope="col">Window</th>
              <th scope="col">Used</th>
              <th scope="col">Headroom</th>
              <th scope="col">Resets</th>
            </tr>
          </thead>
          <tbody>
            {reading.windows.map((w) => (
              <tr key={w.label}>
                <th scope="row">{w.label}</th>
                <td>
                  {formatPct(w.usedPct)}
                  {w.overage && <span className="badge quota-overage"> on overage credit</span>}
                </td>
                <td>{formatPct(w.headroomPct)}</td>
                {/* The RESET INSTANT, not just a percentage: a bare "96%" is
                    what makes a correctly-working system look hung. */}
                <td>
                  {formatWhen(w.resetsAtMs)}
                  {w.resetsAtMs > now && (
                    <span className="quota-reset-relative">
                      {' '}
                      (in {formatElapsed(w.resetsAtMs - now)})
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {lastUpdatedAt !== null && (
        <p className="page-hint quota-as-of">Quota as of {formatWhen(lastUpdatedAt)}.</p>
      )}
    </section>
  );
}

function ActivityPanel({ snapshot }: { snapshot: AiActivitySnapshot }) {
  const { models, totals, agentCli, runs } = snapshot;
  const nothing = models.length === 0 && agentCli.invocations === 0;

  return (
    <>
      <dl className="monitor-tiles">
        {/* EVERY non-terminal status gets a tile, driven off the response's own
            keys rather than a hand-picked three. The server already seeds all of
            them from `LIVE_RUN_STATUSES` so a newly-added status cannot be
            dropped on the way out; listing three by hand here re-opened exactly
            that hole one layer up — `pending` was fetched and never shown, which
            is the silent-omission shape this panel's per-status split exists to
            refuse. `LIVE_RUN_LABEL` is an exhaustive Record, so a new member of
            `LiveRunCounts` is a TYPECHECK failure here, not an invisible run. */}
        {LIVE_RUN_ORDER.map((status) => (
          <div key={status}>
            <dt>{LIVE_RUN_LABEL[status]}</dt>
            <dd>{runs[status]}</dd>
          </div>
        ))}
        <div>
          <dt>Billed exchanges</dt>
          <dd>{totals.responseCount}</dd>
        </div>
        <div>
          <dt>Tokens</dt>
          <dd>
            {formatTokenCount(totals.inputTokens)} in / {formatTokenCount(totals.outputTokens)} out
          </dd>
        </div>
        <div>
          <dt>Spend</dt>
          {/* `costFigure`, not a hand-rolled amount, because the five-way reading
              it encodes is the money model's own vocabulary and getting it
              slightly different here would be a SECOND answer to the same
              question. Concretely: when exchanges happened but NONE could be
              priced, the sum is 0 and the honest headline is "Cost unknown" —
              writing `$0.00` with an "at least" beside it presents a total that
              was never measured, which `costKindOf` documents as worse than
              saying nothing at all. */}
          <dd>{costFigure(costHeadline(totals))}</dd>
        </div>
      </dl>

      {nothing ? (
        <p role="status" className="notice">
          No AI or agent activity in this window.
        </p>
      ) : (
        <table className="ai-model-table">
          <caption className="visually-hidden">
            Billed exchanges by connection kind and model
          </caption>
          <thead>
            <tr>
              <th scope="col">Connection kind</th>
              <th scope="col">Model</th>
              <th scope="col">Exchanges</th>
              <th scope="col">Tokens in / out</th>
              <th scope="col">Spend</th>
              <th scope="col">Last used</th>
            </tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <tr key={`${m.provider}/${m.model}`}>
                <td>{m.provider}</td>
                <td>{m.model}</td>
                <td>{m.cost.responseCount}</td>
                <td>
                  {formatTokenCount(m.cost.inputTokens)} / {formatTokenCount(m.cost.outputTokens)}
                </td>
                <td className="run-cost">{costFigure(costHeadline(m.cost))}</td>
                <td>{formatWhen(m.lastAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Agent-CLI use is counted apart from the token table because it is not
          token-metered — folding it in would print zeros for real work. */}
      <p className="agent-cli-summary">
        {agentCli.invocations === 0 ? (
          'No agent CLI subprocesses in this window.'
        ) : (
          <>
            {agentCli.invocations} agent CLI subprocess
            {agentCli.invocations === 1 ? '' : 'es'} — {agentCli.completed} completed,{' '}
            {agentCli.notCompleted} did not. Last at {formatWhen(agentCli.lastAt)}.
          </>
        )}
      </p>
    </>
  );
}

export function AiActivityPage() {
  const [since, setSince] = useState<RunSince>('1h');
  const fetcher = useCallback((signal: AbortSignal) => fetchAiActivity(since, signal), [since]);
  const { data, error, loading, lastUpdatedAt } = usePolledResource(fetcher, {
    intervalMs: ACTIVITY_POLL_MS,
  });

  return (
    <section aria-labelledby="ai-activity-heading">
      <div className="page-header">
        <h2 id="ai-activity-heading">AI activity</h2>
        <label className="ai-window-picker">
          Window{' '}
          <select
            value={since}
            onChange={(e) => setSince(e.target.value as RunSince)}
            aria-label="Activity window"
          >
            {/* The SAME vocabulary and prose the run list's own since-picker
                uses — two monitoring surfaces should not disagree about what
                "24h" is called, and a raw enum token is not a label. */}
            {RUN_SINCE_OPTIONS.map((w) => (
              <option key={w} value={w}>
                {RUN_SINCE_LABEL[w]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="page-hint">
        What your connected AIs and agent CLIs have actually been doing, across every run —
        including runs still in flight. Refreshes itself every few seconds.
      </p>

      {error !== null && (
        <p role="alert" className="error">
          Could not load AI activity: {error}
        </p>
      )}

      {loading && data === null && error === null && <p className="notice">Loading activity…</p>}

      {data !== null && <ActivityPanel snapshot={data} />}

      {lastUpdatedAt !== null && (
        <p className="page-hint">Activity as of {formatWhen(lastUpdatedAt)}.</p>
      )}

      <QuotaPanel />
    </section>
  );
}
