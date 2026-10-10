import { useId, useState } from 'react';
import { Link } from 'react-router';
import type { KeyboardEvent, ReactNode } from 'react';
import { newestFirst, type TransientNotice } from './noticeOrder';

/** A standing fact about the pipeline that carries the act resolving it. */
export interface StandingNotice {
  key: string;
  /** The rendered banner, whole — its role, its text and its buttons. */
  node: ReactNode;
}

function textsOf(notices: readonly TransientNotice[]): Record<string, string | null> {
  return Object.fromEntries(notices.map((n) => [n.key, n.text]));
}

/**
 * #1393 — ONE fixed-height line for every notice the editor raises, drawn in
 * the editor's toolbar row between the title and the actions (#1475). Each of
 * these used to be its own sibling above the canvas, so each one that came or
 * went resized the canvas and moved the dock under the operator's pointer; a
 * copy/paste did it twice, six seconds apart.
 *
 * Two slots, because the notices are two different things and the archived
 * canvas needs both at once (its save refusal is read beside the banner whose
 * button resolves it):
 * - STANDING — a fact that must be acted on (a refused save, an archived
 *   pipeline, a failed load). The first given is shown; the order is the
 *   caller's priority.
 * - TRANSIENT — the newest message about the last act. Newest, not a fixed
 *   priority: the save message never clears by itself, so a fixed order would
 *   bury every later copy/paste notice behind an old "Saved v2.".
 *
 * Anything not shown is counted on the `+N more` disclosure, which lists those
 * notices in full, with their buttons. Only those: a second copy of a shown
 * banner would put two alerts and two of each button on the page. A shown
 * notice that the line truncates carries its full text as a `title`. The list
 * is an overlay, rendered only while open, so it moves nothing.
 */
export function EditorStatusStrip({
  standing,
  transient,
}: {
  standing: readonly StandingNotice[];
  transient: readonly TransientNotice[];
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  // Render-phase derived state (DraftNumberField's precedent): the order must
  // be settled in the SAME render that shows the new text, or the strip would
  // paint the stale order for a frame.
  const [seen, setSeen] = useState(() => ({
    order: transient.map((n) => n.key),
    texts: textsOf(transient),
  }));
  const texts = textsOf(transient);
  const moved = transient.some((n) => n.text !== seen.texts[n.key]);
  const order = moved ? newestFirst(seen.order, seen.texts, transient) : seen.order;
  if (moved) setSeen({ order, texts });

  const live = order
    .map((key) => transient.find((n) => n.key === key))
    .filter((n): n is TransientNotice & { text: string } => n !== undefined && n.text !== null);
  const total = standing.length + live.length;
  const shown = (standing.length > 0 ? 1 : 0) + (live.length > 0 ? 1 : 0);
  const hidden = total - shown;
  if (open && hidden === 0) setOpen(false);
  const closeOnEscape = (e: KeyboardEvent) => {
    if (e.key === 'Escape') setOpen(false);
  };

  const message = (n: TransientNotice & { text: string }) => (
    <p key={n.key} className="notice" role={n.role} title={n.text}>
      {/* #1475 — the text truncates, the link does not: in the toolbar row the
          line is narrow, and an ellipsis over "Open run" would hide the act. */}
      <span className="editor-status-strip__text">{n.text}</span>
      {n.link && (
        <>
          {' '}
          <Link to={n.link.to}>{n.link.label}</Link>
        </>
      )}
    </p>
  );

  return (
    <div className="editor-status-strip" data-testid="editor-status-strip">
      <div className="editor-status-strip__standing">{standing[0]?.node}</div>
      <div className="editor-status-strip__transient">{live[0] && message(live[0])}</div>
      {hidden > 0 && (
        <button
          type="button"
          className="editor-status-strip__more"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          onClick={() => setOpen((o) => !o)}
          onKeyDown={closeOnEscape}
        >
          {`+${String(hidden)} more`}
        </button>
      )}
      {open && (
        <div
          id={listId}
          className="editor-status-strip__list"
          // Only catches Escape bubbling up from the messages' controls.
          role="presentation"
          onKeyDown={closeOnEscape}
        >
          {standing.slice(1).map((n) => (
            <div key={n.key}>{n.node}</div>
          ))}
          {live.slice(1).map(message)}
        </div>
      )}
    </div>
  );
}
