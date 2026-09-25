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

/** One catalog function as the flyout lists it (#864). */
export type FunctionOption = { name: string; signature: string };

/**
 * The functions half, resolved per OPENING like {@link FieldOptions}: what the
 * expression at the caret can be wrapped in, and how a choice is applied. The
 * wrap target is fixed when the list opens and `apply` closes over it, so the
 * choice lands around what the author was pointing at, whatever focus did
 * since. `null` means the caret is in no `${}` — there is nothing to wrap.
 */
export type WrapOptions = { functions: FunctionOption[]; apply: (name: string) => void } | null;

type Open =
  | { kind: 'refs'; options: FieldOptions }
  | { kind: 'functions'; wrap: WrapOptions; against: string };

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
 *
 * FUNCTIONS (#864) are a second disclosure beside the first, not rows in it,
 * because they are a different act: a reference is INSERTED at the caret, a
 * function is put AROUND the expression the caret is in (`toUpper(X)`). A bare
 * `${name()}` would be refused at save the moment it landed, so a function is
 * never inserted on its own. The two lists share one open state — opening one
 * closes the other, so the panel never carries both.
 */
export function ExpressionPicker({
  fieldName,
  describe,
  resolve,
  onSelect,
  wrap,
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
  /**
   * The functions half; omitted, the control offers references only. `value`
   * is the field's text NOW: the list is resolved against the text it opened
   * on, and its `apply` rewrites exactly that text — so an edit made while it
   * is open CLOSES it, rather than letting a choice put back what the author
   * had since changed.
   */
  wrap?: { value: string; resolve: () => WrapOptions };
}) {
  const [open, setOpen] = useState<Open | null>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const fnToggleRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const toggleId = useId();
  const fnListId = useId();
  const fnToggleId = useId();
  const options = open?.kind === 'refs' ? open.options : null;
  const functions =
    open?.kind === 'functions' && open.against === wrap?.value ? open.wrap : undefined;
  const functionsOpen = functions !== undefined;

  // Focus returns to the toggle that OPENED the list, which is where the
  // author's next keystroke is expected.
  const close = () => {
    const from = functionsOpen ? fnToggleRef : toggleRef;
    setOpen(null);
    from.current?.focus();
  };

  return (
    <div
      className="expression-picker"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && (options !== null || functionsOpen)) close();
      }}
    >
      <button
        type="button"
        id={toggleId}
        ref={toggleRef}
        className="expression-picker-toggle"
        aria-expanded={options !== null}
        // Only while the list EXISTS: `aria-controls` naming an absent element
        // is an invalid attribute value, which axe reports.
        aria-controls={options !== null ? listId : undefined}
        aria-label={`Insert reference into ${fieldName}`}
        onClick={() => setOpen(options !== null ? null : { kind: 'refs', options: resolve() })}
      >
        Insert reference
      </button>
      {wrap && (
        <button
          type="button"
          id={fnToggleId}
          ref={fnToggleRef}
          className="expression-picker-toggle"
          aria-expanded={functionsOpen}
          aria-controls={functionsOpen ? fnListId : undefined}
          aria-label={`Wrap an expression in ${fieldName} in a function`}
          onClick={() =>
            setOpen(
              functionsOpen
                ? null
                : { kind: 'functions', wrap: wrap.resolve(), against: wrap.value },
            )
          }
        >
          Wrap in function
        </button>
      )}

      {functions !== undefined && (
        <div
          id={fnListId}
          className="expression-picker-list"
          role="group"
          aria-labelledby={fnToggleId}
        >
          {functions === null ? (
            <p className="page-hint">
              Put the cursor inside a {'${…}'} expression in {fieldName}, or select part of one, to
              wrap it in a function.
            </p>
          ) : functions.functions.length === 0 ? (
            // Reachable: a field with a narrow type, or an expression that is
            // already refused, can leave no function that adds nothing new.
            <p className="page-hint">
              No function takes this expression without being refused at save.
            </p>
          ) : (
            <>
              <p className="page-hint">
                Wraps the expression at the cursor in {fieldName} — or the part of it you selected.
              </p>
              <ul>
                {functions.functions.map(({ name, signature }) => (
                  <li key={name}>
                    <button
                      type="button"
                      // The signature already begins with the name, so it is
                      // the whole accessible name — the two spans read back to
                      // back would say the name twice.
                      aria-label={signature}
                      onClick={() => {
                        functions.apply(name);
                        close();
                      }}
                    >
                      <span className="expression-picker-name">{name}</span>
                      <span className="expression-picker-type">{signature}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

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
