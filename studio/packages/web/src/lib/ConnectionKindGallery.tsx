import { useId, useState, type RefObject } from 'react';
import {
  CONNECTION_KIND_DESCRIPTIONS,
  CONNECTION_KIND_LABELS,
  type ConnectionKind,
} from '@autonomy-studio/shared';
import { ConnectionKindName } from './KindName';
import { detectConnection, type DetectedConnection } from './detectConnection';
import { DrawerShell } from './form/DrawerShell';
import { connectionKindGroups, type ConnectionKindDisabledReason } from './connectionKindGroups';

/**
 * #1477 — ADF's "New linked service" step for studio: every connection kind,
 * grouped and searchable, picked BEFORE the form opens. The ONE gallery every
 * "new connection" entry point uses (Manage → Connections now; the activity
 * Source/Sink pickers next), so a kind added to the enum appears everywhere.
 *
 * A kind that cannot be used where the gallery was opened is shown disabled
 * with its reason, not hidden. `aria-disabled` rather than `disabled`, so the
 * tile stays focusable and its reason can be read; the click is refused here.
 * The kind's description is the tile's tooltip and accessible description,
 * not text on the page (labels, not prose).
 */
export function ConnectionKindGallery({
  onPick,
  onDetect,
  disabledReason,
}: {
  onPick: (kind: ConnectionKind) => void;
  /** Given, the gallery offers paste-to-detect above the kinds. */
  onDetect?: (detected: DetectedConnection) => void;
  disabledReason?: ConnectionKindDisabledReason;
}) {
  const [query, setQuery] = useState('');
  const searchId = useId();
  const idBase = useId();
  const groups = connectionKindGroups(query, disabledReason);

  return (
    <div className="kind-gallery">
      {onDetect !== undefined && (
        <PasteToDetect onDetect={onDetect} disabledReason={disabledReason} />
      )}
      <div className="kind-gallery__search" role="search" aria-label="Connection kinds">
        <label htmlFor={searchId} className="visually-hidden">
          Search connection kinds
        </label>
        {/* `text`, not `search`: a search box clears itself on Escape, which
            must close the drawer instead. */}
        <input
          id={searchId}
          type="text"
          placeholder="Search"
          data-autofocus
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {groups.length === 0 && <p className="kind-gallery__empty">No connection kinds match</p>}
      {groups.map((group) => (
        <section
          key={group.key}
          className="kind-gallery__group"
          aria-labelledby={`${idBase}-${group.key}`}
        >
          <h4 id={`${idBase}-${group.key}`}>{group.label}</h4>
          <ul className="kind-gallery__tiles">
            {group.tiles.map(({ kind, disabledReason: reason }) => {
              const descriptionId = `${idBase}-${kind}-d`;
              const reasonId = `${idBase}-${kind}-r`;
              return (
                <li key={kind}>
                  <button
                    type="button"
                    className="kind-gallery__tile"
                    title={CONNECTION_KIND_DESCRIPTIONS[kind]}
                    aria-disabled={reason !== undefined ? true : undefined}
                    aria-describedby={
                      reason !== undefined ? `${reasonId} ${descriptionId}` : descriptionId
                    }
                    onClick={() => {
                      if (reason === undefined) onPick(kind);
                    }}
                  >
                    <ConnectionKindName kind={kind} />
                  </button>
                  {/* Beside the button, not in it: text inside would join the
                      button's name, and the name is the kind. */}
                  {reason !== undefined && (
                    <span id={reasonId} className="kind-gallery__reason">
                      {reason}
                    </span>
                  )}
                  <span id={descriptionId} className="visually-hidden">
                    {CONNECTION_KIND_DESCRIPTIONS[kind]}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

/**
 * #1477 — the shortcut above the kinds: paste a connection string, URL or
 * path, and the form opens on the kind it implies (`detectConnection`). A
 * kind refused here is reported, not opened, as its tile would be. The field
 * is cleared once it is used, because a postgres URL can carry a password.
 */
function PasteToDetect({
  onDetect,
  disabledReason,
}: {
  onDetect: (detected: DetectedConnection) => void;
  disabledReason?: ConnectionKindDisabledReason;
}) {
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const inputId = useId();
  const problemId = useId();

  const use = () => {
    const detected = detectConnection(text);
    if (detected === null) {
      setProblem('Not a path or URL studio recognises. Pick a kind below');
      return;
    }
    const reason = disabledReason?.(detected.kind);
    if (reason !== undefined) {
      setProblem(`${CONNECTION_KIND_LABELS[detected.kind]}: ${reason}`);
      return;
    }
    setText('');
    setProblem(null);
    onDetect(detected);
  };

  return (
    <div className="kind-gallery__paste">
      <label htmlFor={inputId} className="visually-hidden">
        Paste a path or URL
      </label>
      <input
        id={inputId}
        type="text"
        placeholder="Paste a path or URL"
        title="A postgres:// URL, an http(s):// URL, a SQLite file, or a folder or file path"
        autoComplete="off"
        spellCheck={false}
        value={text}
        aria-describedby={problem !== null ? problemId : undefined}
        onChange={(e) => {
          setText(e.target.value);
          setProblem(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            use();
          }
        }}
      />
      <button type="button" onClick={use} disabled={text.trim() === ''}>
        Use
      </button>
      <p id={problemId} role="status" className="kind-gallery__reason">
        {problem}
      </p>
    </div>
  );
}

/**
 * The gallery as the first step of a "New connection" drawer. Not a `<form>`:
 * picking a kind IS the act (a lone text field in a form would submit on
 * Enter), and there is nothing to lose, so no unsaved-changes guard.
 */
export function ConnectionKindDrawer({
  onPick,
  onDetect,
  onClose,
  returnFocusTo,
  disabledReason,
}: {
  onPick: (kind: ConnectionKind) => void;
  onDetect?: (detected: DetectedConnection) => void;
  onClose: () => void;
  returnFocusTo?: RefObject<HTMLElement | null>;
  disabledReason?: ConnectionKindDisabledReason;
}) {
  return (
    <DrawerShell
      title="New connection"
      onEscape={onClose}
      onClose={onClose}
      returnFocusTo={returnFocusTo}
    >
      <div className="form-drawer-body">
        <ConnectionKindGallery
          onPick={onPick}
          onDetect={onDetect}
          disabledReason={disabledReason}
        />
      </div>
      <div className="form-drawer-footer">
        <div className="form-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </DrawerShell>
  );
}
