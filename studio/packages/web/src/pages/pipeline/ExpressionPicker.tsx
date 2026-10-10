import { useId, useRef, useState, type MouseEvent } from 'react';
import type { FunctionDoc, RefSuggestion } from '@autonomy-studio/shared';
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
 * One catalog function as the flyout lists it (#864), with its help text
 * (#1413): the signature names each parameter and ends in the return type, and
 * the description and examples say what it does. Each example keeps its bare
 * `call`, which is what inserting it writes.
 */
export type FunctionOption = { name: string } & Pick<
  FunctionDoc,
  'signature' | 'description' | 'examples'
>;

/**
 * The functions that offer an example a field accepts (#1413), each keeping
 * only those examples, and the mode the chosen one is inserted in — the same
 * mode, and the same filter, a reference gets in that field.
 */
export type ExampleChoices = { mode: InsertMode; functions: FunctionOption[] };

/**
 * The functions half, resolved per OPENING like {@link FieldOptions}, by where
 * the author's selection is when the list opens:
 *  - `examples` — in no `${}`, so a function's worked example is inserted there
 *    as a whole `${call}` (#1413);
 *  - `wrap` — in one, so a function is put around the expression at the caret
 *    (#864). The target is fixed when the list opens and `apply` closes over
 *    it, so the choice lands around what the author was pointing at, whatever
 *    focus did since;
 *  - `null` — neither fits: an end inside quoted text, a selection across
 *    expressions, or straight after a `$` (see `outsideExpressions`).
 */
export type FunctionsOptions =
  | { kind: 'wrap'; functions: FunctionOption[]; apply: (name: string) => void }
  | ({ kind: 'examples'; apply: (call: string) => void } & ExampleChoices)
  | null;

type Open =
  | { kind: 'refs'; options: FieldOptions }
  | { kind: 'functions'; options: FunctionsOptions; against: string };

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
 * because they are a different act. Inside a `${}` a function is put AROUND
 * the expression the caret is in (`toUpper(X)`); a bare `${name()}` would be
 * refused at save the moment it landed. Outside every `${}` (#1413) the list
 * offers each function's worked EXAMPLES instead, inserted at the caret as a
 * whole `${call}` the field accepts — a working start the author edits, which
 * inside an expression would nest. The two lists share one open state —
 * opening one closes the other, so the panel never carries both.
 */
export function ExpressionPicker({
  fieldName,
  describe,
  resolve,
  onSelect,
  functions: functionsProp,
  compact = false,
  keepFocus = false,
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
  functions?: { value: string; resolve: () => FunctionsOptions };
  /**
   * #1477 OR29 — the toggles as glyphs (`${}`, `ƒx`), on one row: for a table
   * cell, where two worded buttons under every box would make each row three
   * lines tall, and for a config field in the dock, where they were 44px of a
   * 228px tab. Their accessible names are unchanged; the glyph's hover says it
   * in words.
   */
  compact?: boolean;
  /**
   * A cell shows its toggles only while it has focus (index.css), and Safari
   * and Firefox on macOS do not focus a button on click: the box would blur on
   * mousedown, the toggles would hide, and the click would land on nothing. So
   * a cell's toggle's mousedown keeps focus where it is — in the box, which is
   * also where an insert goes. A top-level field's toggles are always shown,
   * and need none of that.
   */
  keepFocus?: boolean;
}) {
  const [open, setOpen] = useState<Open | null>(null);
  const onToggleDown = keepFocus ? (e: MouseEvent) => e.preventDefault() : undefined;
  const toggleRef = useRef<HTMLButtonElement>(null);
  const fnToggleRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const toggleId = useId();
  const fnListId = useId();
  const fnToggleId = useId();
  const options = open?.kind === 'refs' ? open.options : null;
  // An edit while the function list is open CLOSES it — the state is cleared,
  // not just hidden, or editing back to the same text (an undo) would revive a
  // list resolved against a span from before. Set during render, React's
  // pattern for state derived from a changed prop: it re-renders at once.
  if (open?.kind === 'functions' && open.against !== functionsProp?.value) setOpen(null);
  const functions = open?.kind === 'functions' ? open.options : undefined;
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
        // `preventDefault` marks the Escape as handled, so a form drawer around
        // the picker does not also read it as "close the whole form" (#1396).
        if (e.key === 'Escape' && (options !== null || functionsOpen)) {
          e.preventDefault();
          close();
        }
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
        onMouseDown={onToggleDown}
        title={compact ? 'Insert reference' : undefined}
        onClick={() => setOpen(options !== null ? null : { kind: 'refs', options: resolve() })}
      >
        {compact ? '${}' : 'Insert reference'}
      </button>
      {functionsProp && (
        <button
          type="button"
          id={fnToggleId}
          ref={fnToggleRef}
          className="expression-picker-toggle"
          aria-expanded={functionsOpen}
          aria-controls={functionsOpen ? fnListId : undefined}
          aria-label={`Functions for ${fieldName}`}
          onMouseDown={onToggleDown}
          title={compact ? 'Functions' : undefined}
          onClick={() =>
            setOpen(
              functionsOpen
                ? null
                : {
                    kind: 'functions',
                    options: functionsProp.resolve(),
                    against: functionsProp.value,
                  },
            )
          }
        >
          {compact ? 'ƒx' : 'Functions'}
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
              Put the cursor inside one {'${…}'} expression in {fieldName}, outside its quoted text,
              to wrap it in a function. To insert an example, put it in plain text: not inside or
              across a {'${…}'}, and not straight after a $.
            </p>
          ) : functions.kind === 'examples' ? (
            <>
              <p className="page-hint">
                {functions.mode === 'replace'
                  ? `${fieldName} takes one whole expression — inserting an example REPLACES its current value.`
                  : `Inserts a worked example at the cursor in ${fieldName}. To wrap an expression in a function instead, put the cursor inside its \${…}.`}
              </p>
              {functions.functions.length === 0 ? (
                // Reachable: a field with a narrow type, or one that refuses
                // `${}` outright, can accept no example at all.
                <p className="page-hint">
                  No function example fits {fieldName} — it would be refused at save.
                </p>
              ) : (
                <ul>
                  {functions.functions.map(({ name, signature, description, examples }) => (
                    <li key={name} className="expression-picker-example">
                      <FunctionHead
                        name={name}
                        signature={signature}
                        description={description}
                        descId={`${fnListId}-${name}-desc`}
                      />
                      {examples.map(({ call, result }, i) => (
                        <button
                          key={call}
                          type="button"
                          // Named by its visible text, `Insert ${call}` — what
                          // lands. The result is hidden from that name, so it
                          // does not read as part of the insert, and is read
                          // as the description, before what the function does.
                          aria-describedby={`${fnListId}-${name}-res${i} ${fnListId}-${name}-desc`}
                          onClick={() => {
                            functions.apply(call);
                            close();
                          }}
                        >
                          <span className="expression-picker-type">Insert {`\${${call}}`}</span>{' '}
                          <span
                            id={`${fnListId}-${name}-res${i}`}
                            className="expression-picker-type"
                            aria-hidden="true"
                          >
                            → {result}
                          </span>
                        </button>
                      ))}
                    </li>
                  ))}
                </ul>
              )}
            </>
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
                To insert an example instead, put the cursor outside every {'${…}'}.
              </p>
              <ul>
                {functions.functions.map(({ name, signature, description, examples }) => (
                  <li key={name}>
                    <button
                      type="button"
                      // The signature already begins with the name, so it is
                      // the whole accessible name — the two spans read back to
                      // back would say the name twice. It is the NAMED
                      // signature, the same text as the row's signature line.
                      aria-label={signature}
                      // What it does and its examples are the description,
                      // read after the name rather than folded into it.
                      aria-describedby={[
                        `${fnListId}-${name}-desc`,
                        ...examples.map((_, i) => `${fnListId}-${name}-ex${i}`),
                      ].join(' ')}
                      onClick={() => {
                        functions.apply(name);
                        close();
                      }}
                    >
                      <FunctionHead
                        name={name}
                        signature={signature}
                        description={description}
                        descId={`${fnListId}-${name}-desc`}
                      />
                      {examples.map(({ call, result }, i) => (
                        <span
                          key={call}
                          id={`${fnListId}-${name}-ex${i}`}
                          className="expression-picker-type"
                        >
                          Example: {call} → {result}
                        </span>
                      ))}
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
                <h3>{heading}</h3>
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
 * What one function row says about the function, whichever act the row is
 * for: its name, its named signature, and what it does — the last under
 * `descId`, which the row's buttons name as their description.
 */
function FunctionHead({
  name,
  signature,
  description,
  descId,
}: Pick<FunctionOption, 'name' | 'signature' | 'description'> & { descId: string }) {
  return (
    <>
      <span className="expression-picker-name">{name}</span>
      <span className="expression-picker-type">{signature}</span>
      <span id={descId}>{description}</span>
    </>
  );
}

/**
 * Display headings for the catalog's semantic kinds, in the order an author
 * reaches for them: what this activity is iterating, what the pipeline was
 * given and the state it carries, the workspace's globals, what ran before it,
 * and the run's own facts last.
 */
const GROUPS: { kind: RefSuggestion['kind']; heading: string }[] = [
  { kind: 'item', heading: 'Loop item' },
  { kind: 'param', heading: 'Pipeline parameters' },
  { kind: 'variable', heading: 'Pipeline variables' },
  { kind: 'global', heading: 'Global parameters' },
  { kind: 'nodeOutput', heading: 'Upstream outputs' },
  { kind: 'nodeStatus', heading: 'Upstream status' },
  { kind: 'run', heading: 'This run' },
  { kind: 'trigger', heading: 'Trigger' },
];
