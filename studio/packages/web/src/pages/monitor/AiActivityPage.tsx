import { useCallback, useState } from 'react';
import {
  type AiActivitySnapshot,
  type ExternalAgentActivity,
  type LiveRunCounts,
  type RunSince,
} from '@autonomy-studio/shared';
import { fetchAccountQuotaDisplay, fetchAiActivity } from '../../api/monitor';
import { usePolledResource } from '../../hooks/usePolledResource';
import { costFigure, costHeadline, tokenSummary } from '../runs/costReading';
import { RUN_SINCE_LABEL, RUN_SINCE_OPTIONS, isRunSince } from '../runs/runFilters';
import { formatElapsed, formatWhen } from '../runs/format';
import { TokenFlowChart } from './TokenFlowChart';
import { reportedActivitySummary, reportedTokenSummary } from './reportedActivity';
import {
  QUOTA_STALE_AFTER_MS,
  formatPct,
  quotaUnavailableText,
  readAccountQuotas,
  type ProviderQuotaReading,
  type QuotaWindowReading,
} from './quotaReading';

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
 * on an explicit click, and always states when it was last CHECKED. The asymmetry
 * is visible in the UI rather than hidden: a reading the operator has not
 * refreshed can never pass for a live one.
 *
 * #987 added the second freshness fact, and the two are deliberately different
 * things: "last checked" is when the BROWSER asked; a last-known reading states
 * how old the NUMBER is. When the provider is refusing they disagree by minutes,
 * which is exactly why the panel used to be useless — it said UNREADABLE and
 * stamped that with a reassuringly recent time.
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

/**
 * The per-window table. One definition, rendered for the live reading and for a
 * last-known one (#987) — so a stale reading is presented in exactly the same
 * terms as a live one and the ONLY difference between them is the labelling
 * around it, which is where the difference belongs.
 */
function QuotaWindowTable({ windows, now }: { windows: QuotaWindowReading[]; now: number }) {
  return (
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
        {windows.map((w) => (
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
              {/* `formatWhen` renders a null as an em-dash, which is the whole
                  handling an unreported reset instant needs (#1023). The guard
                  below has to test for null EXPLICITLY: `null > now` is `false`
                  at runtime, so the relative suffix would be correctly hidden
                  by accident — and a later refactor that coalesced the null to
                  a number would silently restore it against 1970. */}
              {formatWhen(w.resetsAtMs)}
              {w.resetsAtMs !== null && w.resetsAtMs > now && (
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
  );
}

/**
 * One provider's quota, whatever is known about it (#990).
 *
 * Named by provider, because a panel that says "Account quota" over two tables
 * and labels neither invites the reading it is not making. Absent providers
 * never reach here — they are omitted from the list upstream, which is what
 * keeps ABSENT distinct from UNREADABLE.
 */
function ProviderQuota({ entry, now }: { entry: ProviderQuotaReading; now: number }) {
  const { label, provider, reading } = entry;
  return (
    <div className="quota-provider">
      <h4>{label}</h4>

      {/* An UNREADABLE quota says so, in words, and keeps saying so even when a
          last-known number is shown beneath it. It must never render as a
          CURRENT percentage: "0%" would mean "wide open", the opposite of
          "unknown". */}
      {reading.kind === 'unreadable' && (
        <>
          <p role="status" className="notice quota-unreadable">
            <strong>{label} quota UNREADABLE.</strong>{' '}
            {quotaUnavailableText(provider, reading.reason)}
          </p>
          {/* #987 — the provider 429s most of the time, so without this the panel
              said UNREADABLE most of the time while a real number had been read
              minutes earlier. Shown with its AGE and never in place of the
              statement above; the spend guard's own endpoint carries none of
              this and still sees UNREADABLE. */}
          {reading.lastKnown !== undefined && (
            <div className="quota-last-known">
              <p className="page-hint">
                <strong>Last known reading</strong>, taken {formatElapsed(reading.lastKnown.ageMs)}{' '}
                ago — not a current figure.
                {reading.lastKnown.ageMs > QUOTA_STALE_AFTER_MS && (
                  <>
                    {' '}
                    The reader refreshes far more often than that, so it has been failing for a
                    while and this number may have moved.
                  </>
                )}
              </p>
              <QuotaWindowTable windows={reading.lastKnown.windows} now={now} />
            </div>
          )}
        </>
      )}

      {reading.kind === 'reading' && (
        <>
          {/* #990 — a SCRAPED reading states its own age. Codex has no usage
              endpoint, so its figure is whatever its CLI last wrote; shown
              beside claude's live one with no age it would read as equally
              current. A polled provider carries no `ageMs` and says nothing. */}
          {reading.ageMs !== undefined && (
            <p className="page-hint quota-scraped-age">
              Read from {label}&apos;s own session records {formatElapsed(reading.ageMs)} ago — it
              reports usage only when it runs, so this is as current as its last run.
            </p>
          )}
          <QuotaWindowTable windows={reading.windows} now={now} />
        </>
      )}
    </div>
  );
}

function QuotaPanel() {
  const fetcher = useCallback((signal: AbortSignal) => fetchAccountQuotaDisplay(signal), []);
  // NO `intervalMs` — see the module docblock and `fetchAccountQuotaDisplay`.
  const { data, error, loading, lastUpdatedAt, refresh } = usePolledResource(fetcher);
  const now = useNow();

  const providers = data === null ? [] : readAccountQuotas(data);

  return (
    <section aria-labelledby="quota-heading" className="monitor-panel">
      <div className="page-header">
        <h3 id="quota-heading">Account quota</h3>
        <button type="button" onClick={refresh}>
          Refresh quota
        </button>
      </div>
      <p className="page-hint">
        The subscription windows the AI providers connected to this host draw on. Read on demand
        rather than on a timer — the provider allows one poller, so this asks only when you ask it
        to. A provider you have not connected is not listed at all.
      </p>

      {error !== null && (
        <p role="alert" className="error">
          Could not reach the quota endpoint: {error}
        </p>
      )}

      {loading && data === null && error === null && <p className="notice">Reading quota…</p>}

      {providers.map((entry) => (
        <ProviderQuota key={entry.provider} entry={entry} now={now} />
      ))}

      {/* "Last CHECKED", not "quota as of": this stamps when the browser asked,
          which is a different fact from how old the number is — and when a
          last-known reading is on screen the two disagree by minutes. One
          freshness claim about the number, and it is the one attached to it. */}
      {lastUpdatedAt !== null && (
        <p className="page-hint quota-as-of">Last checked {formatWhen(lastUpdatedAt)}.</p>
      )}
    </section>
  );
}

/**
 * #988 — what agents studio did NOT launch have reported.
 *
 * A section of its own, below studio's own figures and summed into none of
 * them. The separation is the point of the ticket: the panel above meters
 * pipeline runs studio dispatched, so it read `0` while the autonomy loop that
 * builds studio was spending the operator's weekly window — honest numbers about
 * a scope nothing on the page had stated.
 */
function ReportedActivityPanel({ external }: { external: ExternalAgentActivity }) {
  return (
    <section aria-labelledby="reported-activity-heading" className="reported-activity">
      <h3 id="reported-activity-heading">Reported by external agents</h3>

      {external.invocations === 0 ? (
        /* Not merely "nothing here": an empty section on a monitoring page reads
           as "nothing is happening", and the whole defect was a reader drawing
           exactly that conclusion from a number that meant something narrower.
           So the empty state states the SCOPE and the mechanism — studio is told,
           it does not look. */
        <p className="notice">
          No external agent has reported activity in this window. Agents studio did not launch —
          the autonomy build loop, or any other CLI running beside it — report in through{' '}
          <code>POST /api/monitor/external-activity</code>; studio does not watch processes it did
          not start.
        </p>
      ) : (
        <>
          <p className="reported-activity-summary">{reportedActivitySummary(external)}</p>
          <table className="ai-model-table">
            <caption className="visually-hidden">
              Reported invocations by source, agent and model
            </caption>
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">Agent</th>
                <th scope="col">Model</th>
                <th scope="col">Invocations</th>
                <th scope="col">Running</th>
                <th scope="col">Tokens</th>
                <th scope="col">Last started</th>
              </tr>
            </thead>
            <tbody>
              {external.reporters.map((r) => (
                <tr key={`${r.source}/${r.agent}/${r.model ?? ''}`}>
                  <td>{r.source}</td>
                  <td>{r.agent}</td>
                  {/* A model the reporter did not name is said to be unknown, never
                      blanked: an empty cell reads as "no model", which is a claim. */}
                  <td>{r.model ?? 'not reported'}</td>
                  <td>{r.invocations}</td>
                  <td>{r.inFlight}</td>
                  <td>{reportedTokenSummary(r.tokens, r.invocations)}</td>
                  <td>{formatWhen(r.lastAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {external.truncated && (
            /* The counts above are computed ungrouped, so they still describe the
               whole window — only the breakdown is a prefix. Said out loud
               because a silently-cut table reads as the complete picture. */
            <p className="notice">
              Showing the busiest reporters only; the figures above cover every reporter in this
              window.
            </p>
          )}
        </>
      )}
    </section>
  );
}

function ActivityPanel({ snapshot }: { snapshot: AiActivitySnapshot }) {
  const { models, totals, agentCli, runs, external } = snapshot;
  /* #988 — reported activity counts toward "did anything happen". Without it
     this notice claims the window was idle while the reported table below it
     lists live invocations — the ticket's own symptom in a second form. The
     CHART and the model table stay gated on the metered rows alone (below):
     they plot billed exchanges, and reported work contributes none. */
  const nothing = models.length === 0 && agentCli.invocations === 0 && external.invocations === 0;
  const noMeteredActivity = models.length === 0 && agentCli.invocations === 0;

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
          {/* #1025 — `tokenSummary`, not a raw pair, because the SQL aggregate can
              now say whether anyone COUNTED each side. It could not before, so this
              printed `0 in / 0 out` for a window whose only AI use was agent-CLI
              work — `cliSpendFact` carries no token fields at all, and
              `coalesce(sum(…), 0)` delivered that absence as a confident zero.
              Same helper as the run and node panels, so one vocabulary answers
              "was this measured" everywhere. */}
          <dd>{tokenSummary(totals)}</dd>
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

      {nothing && (
        <p role="status" className="notice">
          No AI or agent activity in this window.
        </p>
      )}

      {!noMeteredActivity && (
        <>
          {/* Gated on the METERED rows, not on `nothing`, deliberately: a window
              with no activity would otherwise render a row of zero-height bars on
              a baseline, which states "no tokens" where the notice states
              "nothing happened" — and those are different claims. #988 split the
              two guards because reported activity now makes the notice false
              without making this chart any less empty: reported work is billed to
              no connection and plots no bar, so drawing a flat axis beside a
              table of live invocations would be that same false "no tokens". */}
          <TokenFlowChart
            series={snapshot.series}
            windowStart={snapshot.windowStart}
            generatedAt={snapshot.generatedAt}
          />
          <table className="ai-model-table">
            <caption className="visually-hidden">
              Billed exchanges by connection kind and model
            </caption>
            <thead>
              <tr>
                <th scope="col">Connection kind</th>
                <th scope="col">Model</th>
                <th scope="col">Exchanges</th>
                <th scope="col">Tokens</th>
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
                  {/* Per model, the same honesty as the tile above: a row whose
                      provider never sent `usage` reads as not reported rather than
                      as a measured zero. The header lost its "in / out" because
                      the cell now states each side by name. */}
                  <td>{tokenSummary(m.cost)}</td>
                  <td className="run-cost">{costFigure(costHeadline(m.cost))}</td>
                  <td>{formatWhen(m.lastAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
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

      <ReportedActivityPanel external={external} />
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
          {/* `onChange` VALIDATES rather than casts. `e.target.value` is a
              `string`, and `as RunSince` would assert instead of check — so any
              off-vocabulary value that ever reached the DOM would sail through
              to the request and come back a 400 with nothing to explain it.
              `isRunSince` is the same guard `RunsPage`'s since-picker uses. */}
          <select
            value={since}
            onChange={(e) => {
              if (isRunSince(e.target.value)) setSince(e.target.value);
            }}
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

      {/* #988 — the scope is now STATED. This page read "AI activity" and meant
          "AI activity studio itself dispatched", which is a narrower claim than
          its own title, and an operator watching the autonomy loop fire read the
          resulting zeros as "nothing is happening anywhere". Naming the actor is
          the fix; the section at the bottom is where everything else reports. */}
      <p className="page-hint">
        What your connected AIs and agent CLIs have been doing in THIS workspace's runs — including
        runs still in flight. Agents studio did not launch report in separately, below. Refreshes
        itself every few seconds.
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
