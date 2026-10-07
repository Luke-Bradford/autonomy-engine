import type { BadgePart } from './editorState';

/**
 * #1476 OR28 — which version the editor is on, and which one is live, readable
 * at a glance from the toolbar row.
 *
 * The detail is a native `title` for the mouse and visually-hidden text for a
 * screen reader. The pills are no tab stop: they are not actionable, so a
 * sighted keyboard user reads the label alone — the same trade the toolbar's
 * `title` reasons make. The one exception is a part's `link` (the git part's
 * open pull request), which IS actionable and so is a real link. No live
 * region either: announcing "Draft" on the first edit of every session would
 * be noise.
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

/**
 * #1476 OR28 slice 8 — the same parts, compact, in a pipelines-list row. Named
 * for its pipeline, since a list holds many; the ✓ there means the live version
 * is the latest saved one, as there is no canvas to be on.
 */
export function RowStateBadge({
  pipelineName,
  editing,
  live,
  git,
}: {
  pipelineName: string;
  editing: BadgePart | null;
  live: BadgePart | null;
  git: BadgePart | null;
}): React.JSX.Element {
  const current = 'the latest version';
  return (
    <div
      className="editor-state-badge editor-state-badge--row"
      role="group"
      aria-label={`${pipelineName} state`}
    >
      {editing !== null && <Part part={editing} name="editing" current={current} />}
      {live !== null && <Part part={live} name="live" current={current} />}
      {git !== null && <Part part={git} name="git" current={current} />}
    </div>
  );
}

function Part({
  part,
  name,
  current = 'on the canvas',
}: {
  part: BadgePart;
  name: 'editing' | 'live' | 'git';
  /** What the ✓ says aloud. */
  current?: string;
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
      {part.link !== undefined && (
        <>
          {(part.name !== undefined || part.label !== '') && ' · '}
          {/* Opens the host's page in a new tab, away from an editor that
              may hold unsaved work. */}
          <a
            className="editor-state-badge__link"
            href={part.link.href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={part.link.name}
          >
            {part.link.label}
          </a>
        </>
      )}
      {part.current === true && (
        <>
          <span aria-hidden="true"> ✓</span>
          <span className="visually-hidden"> ({current})</span>
        </>
      )}
      <span className="visually-hidden">. {part.detail}</span>
    </span>
  );
}
