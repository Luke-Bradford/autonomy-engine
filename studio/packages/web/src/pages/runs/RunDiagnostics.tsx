import { useCallback, useEffect, useRef } from 'react';
import type { RunDiagnostic } from '@autonomy-studio/shared';
import { getRunDiagnostics } from '../../api/runs';
import { usePolledResource } from '../../hooks/usePolledResource';
import { formatWhen } from './format';

/**
 * #1065 — the reducer's EXPLANATIONS for this run: the WHY beside the what.
 *
 * Everything else on this page reports the run's DECISIONS — the event feed is
 * the durable log of them, the node table is their per-node roll-up, the graph
 * paints them onto the doc. None of it says why a decision was reached. #497
 * built the whole channel for that (the `run_diagnostics` table, the fold-site
 * writer, the truncation marker, `GET /api/runs/:id/diagnostics`) and stopped
 * one step short: nothing in the web app ever called the route. So a run whose
 * edge was ignored or whose container child was neutralized rendered as a graph
 * behaving nothing like the one its author drew, with no hint why — the precise
 * failure `reduce.ts` says these diagnostics exist to prevent.
 *
 * THE CAP MARKER IS NOT A DIAGNOSTIC, and separating it is the one piece of
 * logic here that is load-bearing rather than presentational. `RUN_DIAGNOSTIC_CAP`
 * truncates at 500 and writes a `phase: 'cap'` row whose `seq: -1` sentinel sits
 * below every real seq specifically so "this list is incomplete" is read BEFORE
 * the list it qualifies. Its own message ends "(see the diagnostics below)",
 * which is true only under this layout — rendered inline, or at the bottom, the
 * server's own sentence would become false. So it is partitioned out and shown
 * above, never as a row.
 *
 * Partitioned on `phase === 'cap'` rather than on `seq === -1`: the phase is the
 * semantic fact, the sentinel is the storage trick that makes it sort first, and
 * a client keying off the latter would break silently if the ordering were ever
 * expressed some other way.
 *
 * A REJECTED lookup is rendered, never swallowed. An empty diagnostics section
 * and a failed one look identical if the failure is dropped, which would let a
 * lookup error read as "this run was clean" — an absent fact manufactured into a
 * benign one, the #473/F13a rule this codebase applies everywhere else.
 */
export function RunDiagnostics({ runId, settled }: { runId: string; settled: boolean }) {
  const fetcher = useCallback((signal: AbortSignal) => getRunDiagnostics(runId, signal), [runId]);
  /* NO `intervalMs`. This page already rides a per-run WebSocket, and polling is
     deliberately not this app's default; the settle refetch below and the manual
     button are the two moments the list can change usefully. */
  const { data, error, loading, lastUpdatedAt, refresh } = usePolledResource(fetcher);

  /*
   * REFRESH when the run terminalizes, via `refresh()` rather than by remounting
   * on a `key`. The distinction is not stylistic. `RunDetailPage` derives
   * `status` from the REST row and the replayed stream, both of which arrive in
   * effects — so the first render of an ALREADY-FINISHED run has `status:
   * 'pending'` and `settled: false`, and settling is therefore a transition
   * almost every view of a terminal run goes through. A `key` change would reset
   * this component's state on that transition, blanking a populated section back
   * to "Reading…" and re-issuing the request. `refresh()` keeps `data` on screen
   * while the new response is in flight, and `usePolledResource` scopes
   * `loading` to the FIRST load for exactly this reason.
   *
   * (`PendingCallbacks` does key on a remount, and its reason does not transfer:
   * it holds a revealed capability token that must not outlive its wait. Nothing
   * here is a secret.)
   *
   * Guarded on the false→true EDGE, not on `settled` being true, so a run that is
   * already settled by the time this mounts does not fire a second request on top
   * of its own first load.
   */
  const wasSettled = useRef(settled);
  useEffect(() => {
    if (settled && !wasSettled.current) refresh();
    wasSettled.current = settled;
  }, [settled, refresh]);

  const cap = data?.find((d) => d.phase === 'cap') ?? null;
  /* The list the operator reads, with the marker removed. The empty state below
     keys off THIS rather than off `data`, so the section cannot render "nothing
     to explain" underneath a warning saying explanations were dropped. */
  const rows = data?.filter((d) => d.phase !== 'cap') ?? [];

  return (
    <section aria-labelledby="run-diagnostics-heading">
      <div className="page-header">
        <h3 id="run-diagnostics-heading">Why this run behaved as it did</h3>
        <button type="button" onClick={refresh}>
          Refresh diagnostics
        </button>
      </div>

      {error !== null ? (
        /* Rendered INSTEAD of the list, not beside it: `usePolledResource` leaves
           `data` untouched on a rejection, so a stale list under an error banner
           would present a superseded reading as the current one. */
        <p role="alert" className="error">
          The reducer’s explanations for this run could not be read: {error}. This says nothing
          about the run itself — its decisions are in the event log below, which is unaffected.
        </p>
      ) : loading && data === null ? (
        <p className="notice">Reading the run’s diagnostics…</p>
      ) : (
        <>
          {/* FIRST, above the list — see the docblock. Rendered verbatim: the
              server composes this sentence (`capMarkerMessage`), and restating it
              here would be a second copy free to drift from the cap it names. */}
          {cap !== null && (
            <p className="error">
              <strong>Some explanations were dropped.</strong> {cap.message}
            </p>
          )}

          {/* Gated on the cap too, not on `rows` alone. "Nothing to explain" is a
              claim about the RUN; "the list is empty" is a claim about this
              response, and the two come apart exactly when the marker is the only
              row — where the honest reading is the opposite one, that so much was
              explained the recorder gave up. The server makes that combination
              unreachable today (the marker is only ever written alongside a real
              row), but a render that can express a self-contradiction is one
              refactor away from doing it. */}
          {rows.length === 0 && cap === null ? (
            <p className="page-hint">
              The reducer neutralized nothing on this run, so it has nothing to explain. This is
              what a well-formed pipeline looks like — an entry here means something the author
              wrote did not take effect.
            </p>
          ) : rows.length === 0 ? null : (
            <table>
              <thead>
                <tr>
                  {/* The SAME number as the Events table's Seq column below, which
                      is the whole reason it is shown: a diagnostic is a statement
                      about the log position it was derived at, and that position is
                      how an operator finds the decision it explains. */}
                  <th scope="col">Seq</th>
                  <th scope="col">Explanation</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <DiagnosticRow key={d.id} diagnostic={d} />
                ))}
              </tbody>
            </table>
          )}

          {!settled && (
            <p className="page-hint">
              This run has not finished, so this is a snapshot — the reducer may explain more before
              it ends. The list refreshes when the run settles.
            </p>
          )}

          {lastUpdatedAt !== null && (
            <p className="page-hint">Read {formatWhen(lastUpdatedAt)}.</p>
          )}
        </>
      )}
    </section>
  );
}

/**
 * One explanation.
 *
 * `phase` is engine vocabulary — `fold` means "derived by folding the event at
 * this seq", `resume` means "derived by `resume()` over the projection as of
 * it". Neither means anything to an operator, so the common case (`fold`) is
 * UNMARKED and only `resume` is called out, in the one form that is useful:
 * these are the explanations that came from re-deriving after an interruption
 * rather than from the event itself, which is why they can exist at a seq whose
 * event looks unremarkable.
 *
 * `ts` is deliberately not shown. It is stamped when the row was RECORDED
 * (`Date.now()` in the writer), not when the explained decision happened, so
 * presenting it as the diagnostic's moment would be quietly false. `seq` is the
 * honest anchor and the one that cross-references the event feed.
 */
function DiagnosticRow({ diagnostic }: { diagnostic: RunDiagnostic }) {
  return (
    <tr>
      <td>{diagnostic.seq}</td>
      <td>
        {diagnostic.message}
        {diagnostic.phase === 'resume' && (
          <>
            {' '}
            <span className="page-hint">(derived when the run was resumed)</span>
          </>
        )}
      </td>
    </tr>
  );
}
