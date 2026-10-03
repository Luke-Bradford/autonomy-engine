import type { BadgePart } from './editorState';

/**
 * #1476 OR28 — which version the editor is on, and which one is live, readable
 * at a glance from the toolbar row.
 *
 * The detail is a native `title` for the mouse and visually-hidden text for a
 * screen reader. No tab stop: nothing here is actionable, so a sighted keyboard
 * user reads the label alone — the same trade the toolbar's `title` reasons
 * make. No live region either: announcing "Draft" on the first edit of every
 * session would be noise.
 */
export function EditorStateBadge({
  editing,
  live,
  git,
}: {
  editing: BadgePart;
  live: BadgePart | null;
  /** The repo's branches, when one is connected (`gitState`). */
  git: BadgePart | null;
}): React.JSX.Element {
  return (
    <div className="editor-state-badge" role="group" aria-label="Pipeline state">
      <Part part={editing} name="editing" />
      {live !== null && <Part part={live} name="live" />}
      {git !== null && <Part part={git} name="git" />}
    </div>
  );
}

function Part({
  part,
  name,
}: {
  part: BadgePart;
  name: 'editing' | 'live' | 'git';
}): React.JSX.Element {
  return (
    <span
      className="editor-state-badge__part"
      data-part={name}
      data-tone={part.tone}
      title={part.detail}
    >
      {/* The name in its own span so a long branch name can ellipsise inside
          the pill rather than widen the toolbar row, while the label — the
          state — is never cut. The full text is in the detail. */}
      {part.name !== undefined && <span className="editor-state-badge__name">{part.name}</span>}
      {part.name !== undefined && part.label !== '' && ' · '}
      {part.label}
      {part.current === true && (
        <>
          <span aria-hidden="true"> ✓</span>
          <span className="visually-hidden"> (on the canvas)</span>
        </>
      )}
      <span className="visually-hidden">. {part.detail}</span>
    </span>
  );
}
