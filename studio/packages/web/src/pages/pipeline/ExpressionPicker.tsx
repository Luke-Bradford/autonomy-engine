import { useId, useRef, useState } from 'react';
import type { RefSuggestion } from '@autonomy-studio/shared';
import type { InsertMode } from './expressionInsert';

/**
 * The U8a expression-insert flyout: pick a `${}` reference instead of knowing
 * the syntax and the surrounding graph by heart.
 *
 * Before this, wiring one activity's output into another's input meant typing
 * `${nodes.<id>.output.<name>}` from memory — nothing in the app said which ids
 * existed, which of their outputs were declared, or which were readable from
 * where you were standing. The catalog behind this list is `availableRefs`,
 * which reads the SAME dominance analysis the save-gate reads, so every option
 * shown is one the doc will actually accept (its "no false offer" property).
 *
 * DELIBERATELY not a live region. The canvas already runs two polite announcers
 * and one assertive refusal, and `FlowCanvas` records the decision not to add a
 * third — so this is a plain disclosure: the toggle owns `aria-expanded`, the
 * list is `aria-labelledby` it, and Escape closes and hands focus back.
 */
export function ExpressionPicker({
  fieldName,
  suggestions,
  describe,
  resolveMode,
  onSelect,
}: {
  fieldName: string;
  suggestions: RefSuggestion[];
  /** How a suggestion is NAMED — web-side, because the node labels live here. */
  describe: (suggestion: RefSuggestion) => string;
  /**
   * Asked once per opening rather than per render: it probes the validator, and
   * a field's shape cannot change while the list is open.
   */
  resolveMode: () => InsertMode;
  onSelect: (text: string, mode: InsertMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<InsertMode>('insert');
  const toggleRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const toggleId = useId();

  // An activity whose every producer is downstream has nothing to offer; a
  // control that opens onto an empty list is worse than no control.
  if (suggestions.length === 0) return null;

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) toggleRef.current?.focus();
  };

  return (
    <div className="expression-picker">
      <button
        type="button"
        id={toggleId}
        ref={toggleRef}
        className="expression-picker-toggle"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={`Insert reference into ${fieldName}`}
        onClick={() => {
          if (!open) setMode(resolveMode());
          setOpen(!open);
        }}
      >
        Insert reference
      </button>

      {open && (
        <div
          id={listId}
          className="expression-picker-list"
          role="group"
          aria-labelledby={toggleId}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close(true);
          }}
        >
          <p className="page-hint">
            {mode === 'replace'
              ? `${fieldName} takes one whole expression — choosing a reference REPLACES its current value.`
              : `Inserted at the cursor in ${fieldName}.`}
          </p>
          {GROUPS.map(({ kind, heading }) => {
            const rows = suggestions.filter((s) => s.kind === kind);
            if (rows.length === 0) return null;
            return (
              <section key={kind}>
                <h4>{heading}</h4>
                <ul>
                  {rows.map((suggestion) => (
                    <li key={suggestion.ref}>
                      <button
                        type="button"
                        onClick={() => {
                          onSelect(suggestion.insert, mode);
                          close(true);
                        }}
                      >
                        <span className="expression-picker-name">{describe(suggestion)}</span>
                        <span className="expression-picker-type">{suggestion.type}</span>
                        {suggestion.availability === 'needs-default' && (
                          // Said plainly rather than hidden behind a longer
                          // string: the author asked for one reference and is
                          // about to receive a `default(...)` call, and the
                          // reason is a real property of their graph.
                          <span className="expression-picker-note">
                            only runs on some paths — wrapped in default()
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Display headings for the catalog's semantic kinds, in the order an author
 * reaches for them: what this activity is iterating, what the pipeline was
 * given, what ran before it, and the run's own facts last.
 */
const GROUPS: { kind: RefSuggestion['kind']; heading: string }[] = [
  { kind: 'item', heading: 'Loop item' },
  { kind: 'param', heading: 'Pipeline params' },
  { kind: 'nodeOutput', heading: 'Upstream outputs' },
  { kind: 'nodeStatus', heading: 'Upstream status' },
  { kind: 'run', heading: 'This run' },
  { kind: 'trigger', heading: 'Trigger' },
];
