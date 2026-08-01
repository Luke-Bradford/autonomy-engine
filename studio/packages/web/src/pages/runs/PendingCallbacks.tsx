import { useEffect, useState } from 'react';
import type { PendingExternalWait, PipelineVersion } from '@autonomy-studio/shared';
import { listExternalWaits } from '../../api/runs';
import { messageOf } from '../../api/client';
import { formatWhen } from './format';
import { describeCallbackBody, parkedDocNode, waitKey } from './externalWaits';

/**
 * #900 — the run monitor's pending inbound callbacks.
 *
 * A16 shipped the whole producer — the correlation row, the derived capability
 * token, the typed-output inbound contract, `GET /api/runs/:id/external-waits` —
 * and nothing in the web app called it. So a run parked on a human-approval
 * webhook was a dead end: the header said `waiting (callback)` and stopped, and
 * the operator had no way to learn where that callback goes.
 *
 * **This component is KEYED on the caller's wait epoch, and that key is the whole
 * of its freshness model.** `RunDetailPage` renders it as
 * `<PendingCallbacks key={waitEpoch} …>`, so any change to the run's pending-wait
 * set remounts it: the list is re-fetched, the error clears, and — the one that
 * matters — a revealed token cannot outlive the wait it belongs to. Nothing here
 * compares epochs or clears state on a transition, because a remount already did
 * it. The first cut of this feature lived inline on the page and hand-rolled that
 * protocol (a stamped list, a freshness comparison, an epoch-prefixed reveal key);
 * it was ~70 lines and it still had a hole. This is the same idea spelled the way
 * React spells it.
 *
 * The caller also owns the DECISION to render at all — only an EXTERNAL park owes
 * a callback (`owesCallback`), and a timer park must not reach this component,
 * which would otherwise ask the server a question it already knows the answer to
 * and then render an empty section under a heading claiming a callback is owed.
 */
export function PendingCallbacks({
  runId,
  doc,
  nameOf,
}: {
  runId: string;
  /** The bound version, or null when it would not resolve (U11 — the page survives it). */
  doc: PipelineVersion | null;
  /** The ONE name this view gives a node (#878), keyed on DOC ids. */
  nameOf: (nodeId: string) => string | null;
}) {
  /* `null` is NOT-YET-LOADED and `[]` is loaded-and-empty, and they read
     differently below: a genuinely empty list while parked means the wait settled
     between the status frame and this fetch — a real race worth saying out loud
     rather than rendering as a spinner that never resolves. */
  const [waits, setWaits] = useState<PendingExternalWait[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    listExternalWaits(runId, ac.signal).then(
      (pending) => {
        if (!ac.signal.aborted) setWaits(pending);
      },
      (err: unknown) => {
        /* Shown, never swallowed. Without this the section's absence would be
           indistinguishable from "this run owes no callback" — a failed lookup
           would read as a fact about the run. */
        if (ac.signal.aborted) return;
        setWaits([]);
        setError(messageOf(err));
      },
    );
    return () => ac.abort();
  }, [runId]);

  return (
    <>
      <h3>Waiting on a callback</h3>
      <p className="page-hint">
        This run is parked until an inbound callback resumes it. Until then nothing below advances;
        if no callback arrives the wait expires and the node fails, which is the path its{' '}
        <code>failure</code> edge takes.
      </p>

      {error !== null && (
        <p role="alert" className="error">
          The pending callbacks could not be loaded, so none are listed: {error}
        </p>
      )}

      {waits === null && error === null && <p>Loading the pending callbacks…</p>}

      {waits !== null && waits.length === 0 && error === null && (
        <p>No callback is pending. The run may have just been resumed.</p>
      )}

      {waits !== null && waits.length > 0 && (
        <ul className="external-waits" aria-label="Pending callbacks">
          {waits.map((wait) => {
            const key = waitKey(wait);
            /* The parked id is an INSTANCE key inside a parallel foreach (`w@1`),
               so it is resolved to its doc node before being named — `nameOf` is
               keyed on doc ids and would otherwise draw a blank on exactly the
               node the operator is being asked to unpark. */
            const docNode = parkedDocNode(doc, wait.nodeId);
            const name = docNode === null ? null : nameOf(docNode.id);
            /* Shown ONLY when it says something the name cannot: which foreach
               instance parked. On an ordinary node it is the same node twice, and
               on a canvas-authored one it is a raw `n_<uuid>` — the noise #884
               removed from the validator's messages. */
            const instance = docNode !== null && docNode.id !== wait.nodeId ? wait.nodeId : null;
            const bodyHint = describeCallbackBody(docNode);
            return (
              <li key={key}>
                <p>
                  <strong>{name ?? wait.nodeId}</strong>
                  {instance !== null && (
                    <>
                      {' · instance '}
                      <code>{instance}</code>
                    </>
                  )}
                  {' · expires '}
                  {formatWhen(wait.expiresAt)}
                </p>
                {bodyHint !== null && <p className="page-hint">{bodyHint}</p>}
                {revealed === key ? (
                  /* Reveal-on-demand, matching the webhook-secret block on the
                     triggers page — for the same reason and not merely for
                     consistency. The path carries a derived capability token:
                     holding it IS the authorization to complete this wait, so it
                     is a live credential and does not belong on screen (or in a
                     screen-share) unless it was asked for.

                     Deliberately TEXT and not an `<a href>`: this is a POST
                     target, so a link would navigate somewhere useless, and it
                     would leak the token to any external navigation through the
                     Referer header. */
                  <div role="status" className="secret-reveal">
                    <p>
                      POST to this path to resume the run. Anyone holding it can complete this wait,
                      so treat it as a secret — it is not an identifier.
                    </p>
                    <p>
                      <code>POST {wait.callbackPath}</code>
                    </p>
                    <button type="button" onClick={() => setRevealed(null)}>
                      Hide callback URL
                    </button>
                  </div>
                ) : (
                  <button type="button" onClick={() => setRevealed(key)}>
                    Show callback URL
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
