import { useCallback, useState } from 'react';
import {
  RUN_SINCE_WINDOWS,
  formatTokenCount,
  formatUsd,
  type AiActivitySnapshot,
  type RunSince,
} from '@autonomy-studio/shared';
import { fetchAccountQuota, fetchAiActivity } from '../../api/monitor';
import { usePolledResource } from '../../hooks/usePolledResource';
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
        <div>
          <dt>Runs executing</dt>
          {/* `running` ONLY. `queued` has not started and `waiting` has released
              its slot — presenting them as one "live" number would report
              activity that is not happening. */}
          <dd>{runs.running}</dd>
        </div>
        <div>
          <dt>Queued</dt>
          <dd>{runs.queued}</dd>
        </div>
        <div>
          <dt>Waiting</dt>
          <dd>{runs.waiting}</dd>
        </div>
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
          <dd>
            {formatUsd(totals.totalCostEstimate)}
            {/* An incomplete window is a LOWER BOUND and says so, rather than
                presenting a partial sum as the whole truth. */}
            {!totals.complete && <span className="cost-qualifier"> at least</span>}
          </dd>
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
                <td>
                  {formatUsd(m.cost.totalCostEstimate)}
                  {!m.cost.complete && <span className="cost-qualifier"> at least</span>}
                </td>
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
            {RUN_SINCE_WINDOWS.map((w) => (
              <option key={w} value={w}>
                {w}
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
