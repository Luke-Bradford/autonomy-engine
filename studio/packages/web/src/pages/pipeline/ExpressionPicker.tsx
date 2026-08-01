import { useId, useRef, useState } from 'react';
import type { RefSuggestion } from '@autonomy-studio/shared';
import type { InsertMode } from './expressionInsert';

/**
 * What the flyout offers for ONE field: the references that survive that
 * field's own checks, and how choosing one is applied.
 *
 * Resolved lazily — see `resolve` on the component — because computing it runs
 * the whole-doc validator once per candidate.
 */
export type FieldOptions = { mode: InsertMode; suggestions: RefSuggestion[] };

/**
 * The U8a expression-insert flyout: pick a `${}` reference instead of knowing
 * the syntax and the surrounding graph by heart.
 *
 * Before this, wiring one activity's output into another's input meant typing
 * `${nodes.<id>.output.<name>}` from memory — nothing in the app said which ids
 * existed, which of their outputs were declared, or which were readable from
 * where you were standing.
 *
 * IN-FLOW, not an overlay. `index.css` carries a note against `.content`
 * (`overflow-y: auto`) warning that an absolutely-positioned in-page overlay
 * must portal to body or be CLIPPED, and naming this ticket. Rather than
 * portalling — which buys a floating layer this list does not need — the list
 * opens in the flow of the panel and pushes the form below it down. Nothing can
 * clip it, there is no z-index to lose, and the panel's own scrolling reaches it.
 *
 * DELIBERATELY not a live region. The canvas already runs two polite announcers
 * and one assertive refusal, and `FlowCanvas` records the decision not to add a
 * third — so this is a plain disclosure: the toggle owns `aria-expanded`, the
 * list is `aria-labelledby` it, and Escape (handled on the WRAPPER, so it works
 * from the toggle where focus actually sits after opening) closes and returns.
 */
export function ExpressionPicker({
  fieldName,
  describe,
  resolve,
  onSelect,
}: {
  fieldName: string;
  /** How a suggestion is NAMED — web-side, because the node labels live here. */
  describe: (suggestion: RefSuggestion) => string;
  /**
   * Asked once per OPENING, never per render: it runs the whole-doc validator
   * once to settle the mode and once per candidate to drop the references this
   * field would refuse. A field's shape cannot change while the list is open.
   */
  resolve: () => FieldOptions;
  onSelect: (text: string, mode: InsertMode) => void;
}) {
  const [options, setOptions] = useState<FieldOptions | null>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const toggleId = useId();
  const open = options !== null;

  const close = () => {
    setOptions(null);
    toggleRef.current?.focus();
  };

  return (
    <div
      className="expression-picker"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) close();
      }}
    >
      <button
        type="button"
        id={toggleId}
        ref={toggleRef}
        className="expression-picker-toggle"
        aria-expanded={open}
        // Only while the list EXISTS: `aria-controls` naming an absent element
        // is an invalid attribute value, which axe reports.
        aria-controls={open ? listId : undefined}
        aria-label={`Insert reference into ${fieldName}`}
        onClick={() => setOptions(open ? null : resolve())}
      >
        Insert reference
      </button>

      {options !== null && (
        <div id={listId} className="expression-picker-list" role="group" aria-labelledby={toggleId}>
          <p className="page-hint">
            {options.mode === 'replace'
              ? `${fieldName} takes one whole expression — choosing a reference REPLACES its current value.`
              : `Inserted at the cursor in ${fieldName}.`}
          </p>
          {/* Reachable, and worth saying rather than showing an empty box: a
              field with a narrow type (a `filter`'s array or boolean) can refuse
              every reference this graph has to offer. */}
          {options.suggestions.length === 0 && (
            <p className="page-hint">
              No reference in this pipeline fits {fieldName} — it would be refused at save.
            </p>
          )}
          {GROUPS.map(({ kind, heading }) => {
            const rows = options.suggestions.filter((s) => s.kind === kind);
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
                          onSelect(suggestion.insert, options.mode);
                          close();
                        }}
                      >
                        <span className="expression-picker-name">{describe(suggestion)}</span>
                        <span className="expression-picker-type">{suggestion.declaredType}</span>
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
