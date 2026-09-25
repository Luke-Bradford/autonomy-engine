import { useEffect, useRef } from 'react';
import type { RefSuggestion } from '@autonomy-studio/shared';
import { emptyControlValue, isRowList, parseFieldInput } from './configForm';
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
  resolve: (target: PickerTarget) => FieldOptions;
};

/**
 * Where ONE control's text sits in its node's config — the question the flyout
 * has to ask the whole-doc validator about every candidate (#1178).
 *
 * It used to be a top-level field NAME, and the candidate was built as
 * `{ ...config, [name]: value }`. A cell inside a row list has no such name —
 * `mapping[1].expression` is not a config key — so the control that knows the
 * position builds the candidate, and the owning panel only runs the validator.
 *
 * `baseline` says what a candidate is compared against. A top-level field's
 * position always exists in the STORED config, so the stored doc is the answer.
 * A cell's row may exist only in the draft (added, not yet applied), and then
 * the stored doc lacks the row the candidate sits on: every candidate would
 * carry the draft row's own complaints and be refused for them. So a cell's
 * baseline is PROBED from its draft: the issues present both with the cell
 * EMPTY and with it holding a plain LITERAL. An issue present for both is not
 * about the cell's content, so a candidate may share it. Neither probe alone
 * is enough, and each fails on a real cell:
 *
 *  - the cell's CURRENT text: in a literal-only cell (`sink`) holding a `${}`
 *    it is the very refusal a candidate earns, so every candidate would pass;
 *  - EMPTY alone: `llm_call.tools[].name` refuses `''` with the same
 *    identifier message it gives `x${…}`, so the refusal cancels;
 *  - a LITERAL alone: an `expression` beside a `source` is refused by the XOR
 *    whatever it holds, so again the refusal cancels.
 */
export type PickerTarget = {
  place: (config: Readonly<Record<string, unknown>>, value: string) => Record<string, unknown>;
  baseline: 'stored' | 'probed';
};

/** A top-level config field's position: the one shape the flyout knew before #1178. */
const topLevelTarget = (name: string): PickerTarget => ({
  place: (config, value) => ({ ...config, [name]: value }),
  baseline: 'stored',
});

/**
 * Values the OWNING panel can offer for one field, when only it can know them
 * (#1218).
 *
 * Shaped like {@link FieldPicker} and passed the same way, for the same reason:
 * the derived form has no per-field-name table and must not grow one (see the
 * argument on the expression flyout below), so "which field gets choices, and
 * what are they" is the panel's answer, not this control's.
 *
 * `onChoose` rather than reusing `onChange`, because a choice can be worth MORE
 * than this field's value: picking an `excel` sheet by NAME must also blank
 * `sheetIndex`, since `excelDatasetConfigSchema` refuses a config carrying both
 * and the operator would otherwise be refused by the very control that offered
 * the value.
 *
 * NOT the expression flyout. That one inserts a `${}` REFERENCE at the caret
 * (`applyInsert`); these are literals that REPLACE the value, so sharing the
 * machinery would mean sharing semantics neither wants.
 */
export type FieldChoices = {
  /** What the chooser is called — the panel's words, since only it knows what
   *  the list IS ("Sheet in this workbook", not "choices"). */
  readonly label: string;
  readonly values: readonly string[];
  readonly onChoose: (value: string) => void;
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
  choices,
  name,
  target,
}: {
  field: ConfigField;
  value: FieldInput;
  onChange: (next: FieldInput) => void;
  picker?: FieldPicker;
  /** Server-known values for THIS field, supplied by the owning panel (#1218). */
  choices?: FieldChoices;
  /**
   * What to CALL this control, when the field's own name is not the whole
   * story. A cell inside a row list is `mapping row 2 sink`, not `sink`: three
   * `sink` boxes sharing one accessible name is not a surface anybody can drive
   * by keyboard, or assert on in a spec.
   */
  name?: string;
  /** Where this control sits in the config, when it is not a top-level field (#1178). */
  target?: PickerTarget;
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
        picker={picker}
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
      {/* #1218 — a chooser BESIDE the textarea, never instead of it.
          The free-text box always survives: a workbook whose path is not
          readable yet has no list to offer, and a control that replaced the box
          would make such a dataset unauthorable. So this is purely additive, and
          its absence is the ordinary case rather than a failure.

          A `<select>` and not a `datalist`: `datalist` does not attach to a
          `<textarea>` (which every text field here is, for the reason argued at
          the top of this file), and its options are unreachable by keyboard on
          several engines. A select is focusable, arrow-key navigable, and
          announces its own name — the accessibility floor this has to clear.

          Its value is BOUND to the current text when that text is one of the
          offered values, so the control reflects the field rather than sitting
          permanently on the placeholder — and falls back to the placeholder for
          a hand-typed value the list does not contain, which is a legitimate
          state and not an error. */}
      {choices && field.kind === 'text' && choices.values.length > 0 && (
        <label className="config-field-choices">
          {choices.label}
          <select
            value={choices.values.includes(text) ? text : ''}
            onChange={(e) => {
              if (e.target.value !== '') choices.onChoose(e.target.value);
            }}
          >
            <option value="">— choose —</option>
            {choices.values.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      )}
      {picker && field.kind === 'text' && (
        <ExpressionPicker
          fieldName={shown}
          describe={picker.describe}
          resolve={() => picker.resolve(target ?? topLevelTarget(field.name))}
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
 * Every cell is a plain `ConfigFieldControl`, and gets the panel's `picker`
 * with a `target` naming the cell's own position (#1178): the candidate is this
 * list's DRAFT rows with one cell replaced, read back through `parseFieldInput`
 * exactly as an apply would. Which cells actually receive offers is the
 * validator's answer, not this control's — `source` and `sink` are held to a
 * literal by §8, so their lists come back empty and say so, and `expression` on
 * a row that already reads a `source` is refused by the XOR. No cell-name table.
 *
 * Nothing offered is a per-ROW value, and nothing here may suggest one: §8 puts
 * substitution in the reducer, so a mapping's `expression` is one constant per
 * dispatch applied to every row (#1129).
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
  picker,
}: {
  field: ConfigField;
  label: string;
  rows: readonly ObjectListRow[];
  onChange: (next: readonly ObjectListRow[]) => void;
  picker?: FieldPicker;
}) {
  const cells = field.elementFields ?? [];

  // Each row is read back cell by cell, as an apply would, EXCEPT that a cell
  // which cannot parse yet is omitted rather than failing the whole list. A
  // freshly added row is the common case: its `type` is `''`, which no enum
  // accepts, so an all-or-nothing `parseFieldInput(field, rows)` would refuse
  // every draft row until it was complete. Omitting keeps the shape the
  // validator reads (`source === undefined` means "not set" to the XOR rule),
  // where placing the raw control values would not — a raw row is DENSE, every
  // cell present as `''`.
  const cellTarget = (index: number, cell: string): PickerTarget => ({
    place: (config, value) => ({
      ...config,
      [field.name]: rows.map((row, i) => {
        const read: Record<string, unknown> = {};
        for (const c of cells) {
          const raw =
            i === index && c.name === cell ? value : (row[c.name] ?? emptyControlValue(c));
          const parsed = parseFieldInput(c, raw);
          if (parsed.ok && !parsed.omit) read[c.name] = parsed.value;
        }
        return read;
      }),
    }),
    baseline: 'probed',
  });

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
                picker={picker}
                target={cellTarget(index, cell.name)}
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
