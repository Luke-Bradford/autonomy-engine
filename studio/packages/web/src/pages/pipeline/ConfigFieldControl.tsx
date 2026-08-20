import { useEffect, useRef } from 'react';
import type { RefSuggestion } from '@autonomy-studio/shared';
import { emptyControlValue, isRowList } from './configForm';
import type { ConfigField, FieldInput, ObjectListRow } from './configForm';
import { ExpressionPicker, type FieldOptions } from './ExpressionPicker';
import { applyInsert } from './expressionInsert';

/**
 * Everything the U8a flyout needs that only the OWNING panel can supply: the
 * references legal at this node, how to name them, and how to probe a field's
 * shape. Passed as one optional object so a panel with no expression context
 * (`ContainerPanel`, whose container fields are #864) simply omits it.
 */
export type FieldPicker = {
  describe: (suggestion: RefSuggestion) => string;
  /** Resolved lazily, per OPENING — it runs the whole-doc validator repeatedly. */
  resolve: (fieldName: string) => FieldOptions;
};

/**
 * One derived config control (U7).
 *
 * Every string field renders as a `<textarea>` rather than an `<input>`, and that
 * is a TRADEOFF taken knowingly rather than the only option. Any string setting
 * here may hold a multi-line `${}` expression or prose (`prompt`, `body`,
 * `content`, `task`), and nothing in a Zod `z.string()` distinguishes those from
 * a short one like `url` or `method` — so the uniform choice serves the fields
 * that need it and costs the short ones some vertical space. The alternatives
 * both have a real price: a per-field-name list of which strings are "long" is
 * the magic-string table that deriving the form from the schema exists to avoid,
 * and switching element on the CURRENT value's length would move focus as the
 * author types. A presentation hint on the schema is the principled fix if the
 * space ever bothers anyone (#852).
 *
 * The label carries the field NAME, not a prettified one: the name is what the
 * author writes in a `${nodes.x.config…}` reference and what the server's
 * validation errors cite, so renaming it for display would break the one thread
 * connecting the form, the doc and the error message.
 */
export function ConfigFieldControl({
  field,
  value,
  onChange,
  picker,
  name,
}: {
  field: ConfigField;
  value: FieldInput;
  onChange: (next: FieldInput) => void;
  picker?: FieldPicker;
  /**
   * What to CALL this control, when the field's own name is not the whole
   * story. A cell inside a row list is `mapping row 2 sink`, not `sink`: three
   * `sink` boxes sharing one accessible name is not a surface anybody can drive
   * by keyboard, or assert on in a spec.
   */
  name?: string;
}) {
  const shown = name ?? field.name;
  const label = field.optional ? `${shown} (optional)` : shown;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Where the caret must land after an insert. The textarea is CONTROLLED, so
  // the new value has to round-trip through the owner's state before the DOM
  // selection can be moved — setting it inline would be overwritten by the
  // re-render. Held in a ref rather than state so restoring it does not itself
  // cause one.
  const caret = useRef<number | null>(null);
  // Whether the author has ever put the caret in THIS field. A textarea nobody
  // has focused reports `selectionStart === 0`, which is indistinguishable from
  // a deliberate caret at the start — so without this, the commonest flow of all
  // (select a node, click Insert reference without clicking into the field
  // first) PREPENDS the reference to the value already there. Untouched means
  // "append", which is what an author who never placed a caret means.
  const touched = useRef(false);
  useEffect(() => {
    const at = caret.current;
    if (at === null || textareaRef.current === null) return;
    caret.current = null;
    textareaRef.current.focus();
    textareaRef.current.setSelectionRange(at, at);
  });

  if (field.kind === 'objectList') {
    return (
      <ObjectListControl
        field={field}
        label={label}
        rows={isRowList(value) ? value : []}
        onChange={onChange}
      />
    );
  }

  if (field.kind === 'boolean') {
    return (
      <label className="contract-check">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label}
      </label>
    );
  }

  if (field.kind === 'enum') {
    return (
      <label>
        {label}
        <select
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">— none —</option>
          {(field.enumOptions ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (field.kind === 'number') {
    // A TEXT input, not `type="number"`: a number input reports an unparseable
    // entry as the empty string, which this form reads as "not set" — so a typo
    // would silently DELETE the setting instead of reporting "must be a number".
    return (
      <label>
        {`${label} — number`}
        <input
          type="text"
          inputMode="decimal"
          value={typeof value === 'string' ? value : ''}
          spellCheck={false}
          placeholder={field.defaultText}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
    );
  }

  const hint = field.kind === 'json' ? 'JSON' : field.kind === 'stringList' ? 'one per line' : null;
  const text = typeof value === 'string' ? value : '';

  return (
    <div className="config-field">
      <label>
        {hint === null ? label : `${label} — ${hint}`}
        <textarea
          ref={textareaRef}
          value={text}
          onSelect={() => {
            touched.current = true;
          }}
          rows={field.kind === 'json' || field.kind === 'stringList' ? 4 : 2}
          spellCheck={false}
          placeholder={field.defaultText}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
      {/* A SIBLING of the label, not a child, because a button INSIDE the label
          contaminates the textarea's accessible name — which is exactly why
          `e2e/node-config-form.spec.ts` had to move off `getByLabel`. (It does
          NOT steal focus: per the HTML standard a label's activation behaviour
          does nothing for an event targeted at interactive content inside it,
          and Chromium leaves `activeElement` on BODY. An earlier version of this
          comment claimed otherwise — right decision, wrong reason.)

          Offered on `text` fields ONLY, and the two exclusions are refusals
          rather than oversights:

          - `json` parses its text with `JSON.parse` on apply
            (`configForm.parseFieldInput`), so the bare `${...}` every other
            field takes is not valid JSON and the apply would simply fail. The
            QUOTED form would be right at a value slot and wrong inside an
            existing string literal — a distinction only a JSON-aware caret could
            make. The four `llm_call` fields this most affects are getting richer
            editors under #852.
          - `stringList` today is `switch.cases` and `llm_call.stop` — an earlier
            version of this comment said `cases` "and nothing else in today's
            catalog (the only `z.array(z.string())` in the registry)", which was
            simply false (`llm-config.ts`, `stop: z.array(z.string().min(1))`).
            The argument below is about `cases` and has not been re-run for
            `stop`, which is one of the picker gaps #864 already owns. A switch's
            case labels are matched LITERALLY: `evalSwitchBranch` compares
            `rawCases.includes(out)` straight off `node.config` with no
            `substitute` call (`engine/reduce.ts`). So a `${}` inserted there
            saves clean — `validateRefs` scans it like any other string — and
            then silently never matches, routing every value to `default`. That
            is the worst shape of false offer: it passes every gate and fails at
            run looking like a benign fallthrough.

          Both are recorded on #864. */}
      {picker && field.kind === 'text' && (
        <ExpressionPicker
          fieldName={field.name}
          describe={picker.describe}
          resolve={() => picker.resolve(field.name)}
          onSelect={(insert, mode) => {
            // The selection survives the toggle click (focus moves, the caret
            // does not), so a mid-string insert lands where the author left it —
            // but only if they ever placed one. See `touched`.
            const el = textareaRef.current;
            const at = touched.current && el !== null ? el.selectionStart : text.length;
            const to = touched.current && el !== null ? el.selectionEnd : text.length;
            const next = applyInsert(text, at, to, insert, mode);
            caret.current = next.caret;
            onChange(next.value);
          }}
        />
      )}
    </div>
  );
}

/**
 * A list of rows, one per element of an array-of-objects config field (#1169,
 * data-movement spec §13).
 *
 * §13 calls this a "table", and a `<table>` is what it is NOT. The property
 * panel is a fixed 320px column (`index.css`, `grid-template-columns: 180px 1fr
 * 320px`) and every string control in it is a `<textarea>` — five columns of
 * textarea in that width is about 60px each, which is not an authoring surface.
 * §13's requirement is the SHAPE of the surface (a row per mapping, carrying its
 * own target type and `onError`), and at this width a stacked row card is that
 * shape. `.contract-row` is the panel's existing idiom for it, already carrying
 * `ParamRow` and `OutputRow`, whose `` `param ${i + 1} name` `` naming
 * convention this follows so the three read alike to a screen reader and to a
 * spec.
 *
 * Every cell is a plain `ConfigFieldControl`, and deliberately gets NO `picker`.
 * The flyout resolves its options by TOP-LEVEL CONFIG FIELD NAME
 * (`picker.resolve(field.name)`), so a cell would ask it about `sink` or
 * `source` — names no config field has — and ship a broken affordance in the
 * slice that defers the picker.
 *
 * Rows are keyed by INDEX, which is sound here and is not the hazard #1092
 * describes: a cell control holds no draft of its own (only a caret ref), so a
 * removal cannot strand a half-typed value on the row that shifts up. It can
 * still move FOCUS to a different logical row, which is the part #1092 owns.
 */
export function ObjectListControl({
  field,
  label,
  rows,
  onChange,
}: {
  field: ConfigField;
  label: string;
  rows: readonly ObjectListRow[];
  onChange: (next: readonly ObjectListRow[]) => void;
}) {
  const cells = field.elementFields ?? [];

  return (
    <div className="config-field object-list" role="group" aria-label={label}>
      <span className="object-list-label">{label}</span>
      {rows.length === 0 ? <p className="page-hint">No rows.</p> : null}
      {rows.map((row, index) => (
        <div className="contract-row" key={index}>
          {cells.map((cell) => {
            const held = row[cell.name];
            return (
              <ConfigFieldControl
                key={cell.name}
                field={cell}
                name={`${field.name} row ${index + 1} ${cell.name}`}
                value={held ?? emptyControlValue(cell)}
                onChange={(next) =>
                  onChange(
                    rows.map((r, i) =>
                      // A cell value is always a scalar — `deriveElementFields`
                      // refuses a cell that is itself a list — but the prop type
                      // is the whole union, so the impossible case is dropped
                      // rather than cast.
                      i === index && !isRowList(next) ? { ...r, [cell.name]: next } : r,
                    ),
                  )
                }
              />
            );
          })}
          <button
            type="button"
            aria-label={`remove ${field.name} row ${index + 1}`}
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          >
            Remove
          </button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...rows, {}])}>
        {`Add ${field.name} row`}
      </button>
    </div>
  );
}
