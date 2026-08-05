import { useEffect, useRef, useState } from 'react';
import type { PendingExternalWait, PipelineVersion } from '@autonomy-studio/shared';
import { completeExternalWait, listExternalWaits } from '../../api/runs';
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
 *
 * **#901 — the operator can now COMPLETE a wait here, and that is why `drafts` is
 * lifted to the caller.** Everything else in this component SHOULD die on the
 * epoch remount; a half-typed callback body must not. The two collide directly: a
 * run with two parallel `foreach` webhook waits remounts when an external caller
 * settles wait A, which under the rule above would silently discard what the
 * operator had typed into wait B. Unsaved input is the one thing here that is not
 * derived from the server, so it is the one thing that lives above the key.
 * A key's PRESENCE in `drafts` is also what "this editor is open" means — one
 * lifted fact rather than two that could disagree about which wait is being
 * edited. `submitting`/`error` stay local on purpose: when the wait set changes
 * underneath, a stale error is exactly what the remount should clear.
 *
 * TWO DEFERRALS, named rather than dropped (#914). The body is a RAW JSON textarea,
 * not a per-field form derived from `config.outputs` — the contract is already
 * rendered as a sentence by `describeCallbackBody`, so the data for a form exists;
 * it is polish, and the textarea is the path. And the expiry is an absolute time
 * that does not tick, so a wait about to expire looks like one with an hour left —
 * the same missing-clock problem as #890, which the two should solve together.
 */
export function PendingCallbacks({
  runId,
  doc,
  nameOf,
  drafts,
  onDraftChange,
  onDraftClear,
}: {
  runId: string;
  /** The bound version, or null when it would not resolve (U11 — the page survives it). */
  doc: PipelineVersion | null;
  /** The ONE name this view gives a node (#878), keyed on DOC ids. */
  nameOf: (nodeId: string) => string | null;
  /** #901 — in-progress callback bodies by `waitKey`; present ⇒ that editor is open. */
  drafts: Record<string, string>;
  onDraftChange: (key: string, value: string) => void;
  onDraftClear: (key: string) => void;
}) {
  /* `null` is NOT-YET-LOADED and `[]` is loaded-and-empty, and they read
     differently below: a genuinely empty list while parked means the wait settled
     between the status frame and this fetch — a real race worth saying out loud
     rather than rendering as a spinner that never resolves. */
  const [waits, setWaits] = useState<PendingExternalWait[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  /* #901 — the wait currently being sent, and the per-wait refusal to show beside
     its editor. Keyed by `waitKey` rather than booleans so two open editors cannot
     share one spinner or one error. */
  const [sending, setSending] = useState<Record<string, true>>({});
  const [sendError, setSendError] = useState<Record<string, string>>({});
  /* #901 — the wait we completed but are still watching the list settle for. Only
     reachable when the completion frame does NOT arrive (a dead socket); normally
     the epoch remount clears this whole component first. Without it a successful
     send on a dead socket is indistinguishable from a click that did nothing. */
  const [sent, setSent] = useState<Record<string, true>>({});
  /* Focus has to go somewhere when an editor opens and closes. The textarea takes
     it on open via `autoFocus`; on close it comes back here, to the control that
     opened it — otherwise a keyboard or screen-reader user is dropped to <body>. */
  const triggers = useRef<Record<string, HTMLButtonElement | null>>({});

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

  /**
   * #901 — send one wait's body, having first proved it is JSON.
   *
   * The parse happens HERE, not at the server, and that is deliberate: `apiFetch`
   * would `JSON.stringify` the raw textarea STRING and send a JSON string where the
   * route wants an object, and a genuinely malformed body would come back as
   * Fastify's framework 400, which the shared error contract flattens to "Malformed
   * request" — useless to someone staring at their own typo. `JSON.parse`'s own
   * message names the position.
   *
   * An empty editor means `{}` — the webhook that declares no outputs accepts it,
   * and one that declares some will be refused by name. What it must NOT do is let
   * an absent body reach the route, which requires `payload` precisely so that
   * "sent nothing" cannot be silently read as "completed with no outputs".
   */
  /** Close one editor: the draft AND the refusal that was shown against it. */
  function closeEditor(key: string) {
    onDraftClear(key);
    /* The error has to go with it. `sendError` is otherwise cleared only by the
       epoch remount or by the next send, and Cancel-then-reopen is neither — so a
       refusal from a body that no longer exists would sit above an empty editor
       claiming the wait was not completed. */
    clearError(key);
    triggers.current[key]?.focus();
  }

  function clearError(key: string) {
    setSendError((e) => {
      const rest = { ...e };
      delete rest[key];
      return rest;
    });
  }

  async function send(wait: PendingExternalWait, key: string) {
    const raw = (drafts[key] ?? '').trim();
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = raw === '' ? {} : JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('the callback body must be a JSON object, e.g. {"decision": "approve"}');
      }
      payload = parsed as Record<string, unknown>;
    } catch (err: unknown) {
      setSendError((e) => ({ ...e, [key]: messageOf(err) }));
      return;
    }

    setSending((x) => ({ ...x, [key]: true }));
    clearError(key);
    try {
      await completeExternalWait(runId, {
        nodeId: wait.nodeId,
        attemptId: wait.attemptId,
        payload,
      });
      /* The completion frame bumps the caller's wait epoch and remounts this
         component, which is what actually refreshes the list — so this only drops
         the draft, and does so for the case where that frame never arrives (a dead
         socket). No second refetch: the epoch owns freshness here. */
      setSent((x) => ({ ...x, [key]: true }));
      closeEditor(key);
    } catch (err: unknown) {
      /* Shown against THIS wait. A 422 means the node is still parked and the body
         is fixable, so the editor deliberately stays open with the text intact. */
      setSendError((e) => ({ ...e, [key]: messageOf(err) }));
    } finally {
      setSending((x) => {
        const rest = { ...x };
        delete rest[key];
        return rest;
      });
    }
  }

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
          {waits.map((wait, i) => {
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
            /* `undefined` ⇒ the editor is closed; `''` is an OPEN editor the
               operator has emptied, which means `{}` and is not the same thing. */
            const draft = drafts[key];
            /* DOM ids off the list INDEX, not off `waitKey`. `waitKey` is
               `JSON.stringify([nodeId, attemptId])` — quotes, commas, brackets, and
               a node id is unconstrained author text — which is fine as a React key
               and illegal in an HTML id. Slugifying it was worse than it looked: the
               obvious `[^a-zA-Z0-9_-]+ -> '-'` is NOT injective (a space and a
               literal hyphen collapse to the same character), so two waits could
               claim one id and `label[for]` would resolve both to the first — the
               exact bug the slug was meant to prevent. The index is unique by
               construction over the list actually being rendered. */
            const fieldId = `wait-body-${i}`;
            const hintId = `wait-hint-${i}`;
            const errorId = `wait-error-${i}`;
            /* The name the operator sees for THIS wait, reused in the controls'
               accessible names. With two parked waits the page would otherwise have
               two buttons called "Complete wait" and two identically-labelled
               textareas, which is unusable by ear even though it looks fine. */
            const label = name ?? wait.nodeId;
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
                {bodyHint !== null && (
                  <p className="page-hint" id={hintId}>
                    {bodyHint}
                  </p>
                )}
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

                {/* #901 — the act, beside the URL that used to be the only option.
                    The URL stays: an operator handing the wait to an EXTERNAL system
                    still needs it, and that is what A13's seam is for. This is for
                    the case the seam served badly — the operator deciding it
                    themselves, who had to leave the app to POST their own callback. */}
                {draft === undefined ? (
                  <button
                    type="button"
                    ref={(el) => {
                      triggers.current[key] = el;
                    }}
                    /* `aria-label` rather than a visually-hidden span: the name
                       computation trims each text node before joining them, so
                       "Complete wait" + " for X" comes out as one word run without
                       the space. Measured, not assumed — the split version made the
                       button unfindable by its own accessible name. */
                    aria-label={`Complete wait for ${label}`}
                    onClick={() => onDraftChange(key, '')}
                  >
                    Complete wait
                  </button>
                ) : (
                  <div className="external-wait-complete">
                    <label htmlFor={fieldId}>
                      Callback body (JSON) for {label} — empty means <code>{'{}'}</code>
                    </label>
                    <textarea
                      id={fieldId}
                      rows={4}
                      spellCheck={false}
                      /* Focus follows the click that opened the editor. Without it
                         the operator has to hunt for the field they just asked for,
                         and a keyboard user is left on a button that no longer
                         exists. Safe from stealing focus on a background remount:
                         this element only MOUNTS when the draft opens. */
                      autoFocus
                      value={draft}
                      placeholder={'{\n  "decision": "approve"\n}'}
                      /* The contract sentence and the refusal both DESCRIBE this
                         field — unlinked, a screen-reader user tabbing here hears
                         the label and nothing about what the body must contain or
                         why the last attempt was rejected. */
                      aria-describedby={
                        [
                          bodyHint !== null ? hintId : null,
                          sendError[key] !== undefined ? errorId : null,
                        ]
                          .filter((x) => x !== null)
                          .join(' ') || undefined
                      }
                      aria-invalid={sendError[key] !== undefined ? true : undefined}
                      onChange={(e) => onDraftChange(key, e.target.value)}
                    />
                    {sendError[key] !== undefined && (
                      <p role="alert" className="error" id={errorId}>
                        The wait was not completed: {sendError[key]}
                      </p>
                    )}
                    <div className="form-actions">
                      <button
                        type="button"
                        disabled={sending[key] === true}
                        onClick={() => void send(wait, key)}
                      >
                        {sending[key] === true ? 'Completing…' : 'Complete this wait'}
                      </button>
                      <button
                        type="button"
                        disabled={sending[key] === true}
                        onClick={() => closeEditor(key)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                {sent[key] === true && draft === undefined && (
                  /* Only ever seen when the completion frame did NOT arrive to
                     remount this component — normally the wait is gone before this
                     could render. Says the send SUCCEEDED, which is otherwise
                     indistinguishable from a click that did nothing. */
                  <p role="status">Completed — waiting for the run to catch up.</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
