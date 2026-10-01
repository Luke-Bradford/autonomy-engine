import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import type { Node, RefSuggestion } from '@autonomy-studio/shared';
import {
  configFieldTitle,
  describeNumberRule,
  numberKeypad,
  emptyControlValue,
  isRowKind,
  isRowList,
  placeRowCandidate,
} from './configForm';
import type { ConfigField, FieldInput, ObjectListRow } from './configForm';
import { ExpressionPicker, type FieldOptions, type FunctionOption } from './ExpressionPicker';
import type { WrapSpan } from './expressionInsert';
import { useCaretInsert } from './useCaretInsert';
import { LabelledControl } from '../../lib/LabelledControl';
import { RequiredMark } from '../../lib/form/RequiredMark';
import { FieldError } from '../../lib/form/FieldError';
import { fieldAttrs } from '../../lib/form/fieldValidation';

/**
 * Everything the U8a flyout needs that only the OWNING panel can supply: the
 * references legal at this site, how to name them, and how to probe a field's
 * shape. Passed as one optional object so a control with no expression context
 * simply omits it. `ContainerPanel` passes one per expression field (#864).
 */
export type FieldPicker = {
  describe: (suggestion: RefSuggestion) => string;
  /** Resolved lazily, per OPENING — it runs the whole-doc validator repeatedly. */
  resolve: (target: PickerTarget) => FieldOptions;
  /**
   * The catalog functions `span` of `text` can be wrapped in without the field
   * earning a refusal it does not already have (#864). Per OPENING, like
   * `resolve`: it validates the whole doc once per catalog function.
   */
  wraps: (target: PickerTarget, text: string, span: WrapSpan) => FunctionOption[];
};

/**
 * Where ONE control's text sits in its node — the question the flyout has to
 * ask the whole-doc validator about every candidate (#1178).
 *
 * It used to be a top-level field NAME, and the candidate was built as
 * `{ ...config, [name]: value }`. A cell inside a row list has no such name —
 * `mapping[1].expression` is not a config key — so the control that knows the
 * position builds the candidate, and the owning panel only runs the validator.
 *
 * It places into the whole NODE, not its config, because a call node's fields
 * are not config at all: `call.pipelineVersionId` and `call.params[name]` live
 * on `Node.call` (#1012). A config position simply rebuilds `config`.
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
  place: (node: Readonly<Node>, value: string) => Node;
  baseline: 'stored' | 'probed';
  /**
   * The field takes a WHOLE `${}` or a literal, never a splice — for a reason
   * the doc validator cannot see, so `insertModeFor`'s probe would answer
   * "insert" and the flyout would build text the owning panel then refuses.
   *
   * One case is a call node's typed argument (#1012). The other is a node's
   * number/boolean/JSON parameter override (#1304), which `coerceOverride` coerces
   * the same way. For the call argument, `buildParams`
   * coerces any text that is not a whole-span `${}` against the child's declared
   * type, so `42${x}` in a `number` row saves clean as far as the validator is
   * concerned and is refused by Apply. The child's declarations are a property
   * of another pipeline's version — nothing the whole-doc validator is given —
   * so the panel that owns the coercion declares the constraint.
   */
  wholeValue?: true;
  /**
   * The top-level config key this target writes, when it is one — the FIELD
   * half of the reference site (#864). A `filter`'s `predicate` binds `${item}`
   * where its `items` does not, so which references exist depends on the field,
   * not only the node. Unset for a position INSIDE a field (a mapping cell, a
   * call argument), which reads the node-level scope.
   */
  field?: string;
};

/** A top-level config field's position: the one shape the flyout knew before #1178. */
const topLevelTarget = (name: string): PickerTarget => ({
  place: (node, value) => ({ ...node, config: { ...node.config, [name]: value } }),
  baseline: 'stored',
  field: name,
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
  /** An option's visible text, when the value alone does not say enough (#844
   *  V6: a variable's TYPE decides how a literal value is read). The option's
   *  VALUE is always the literal itself. */
  readonly describe?: (value: string) => string;
  /** Shown in place of the chooser when `values` is empty. Without it an empty
   *  list renders nothing, which cannot tell "nothing to choose" from "no
   *  chooser here". */
  readonly emptyHint?: string;
};

/**
 * One derived config control (U7).
 *
 * A string field renders as a `<textarea>`, because it may hold a multi-line
 * `${}` expression or prose (`prompt`, `body`, `content`, `task`). A field whose
 * SCHEMA is tagged `singleLine` (`shared/schemas/field-presentation.ts`, #852
 * item 4) — a `url`, a `path`, a model name — gets a one-line `<input>` instead.
 * The hint lives on the schema, not in a per-field-name list here, because that
 * list would be the magic-string table deriving the form exists to avoid.
 *
 * One exception keeps the textarea: a value that already holds a line break.
 * An `<input>`'s value sanitisation STRIPS line breaks, so showing such a value
 * (imported, or written through the JSON editor) in one would silently rewrite
 * it on the next keystroke. The choice is LATCHED for the mount, so deleting
 * that last line break does not swap the element out from under the caret.
 *
 * The label carries the field NAME unless the schema gives it a human title
 * (`presented`, #1396). The name is what the author writes in a
 * `${nodes.x.config…}` reference and what the server's validation errors cite,
 * so a TITLED field still shows its key, in the hint under the control: the
 * title is for reading the form, the key is the thread connecting the form,
 * the doc and the error message.
 *
 * #1396 — a REQUIRED field (one whose key may not be absent) carries a visual
 * asterisk, hidden from the accessible name, and `aria-required` on the
 * control. An optional field is unmarked. A row list is a `group`, which may not
 * carry `aria-required`, so it gets the asterisk alone.
 *
 * A `<textarea>` or `<select>` is paired with its label by `htmlFor`/`id` through
 * `LabelledControl`, never WRAPPED by it (#1227). A wrapping label's text
 * includes the control's own text — a textarea's value, every option of a
 * select — so Playwright's
 * `getByLabel('path', { exact: true })` resolves while the field is empty and
 * silently stops matching the moment it holds anything, and the non-exact form
 * starts matching on VALUES. The accessible name is unaffected either way; it is
 * the label's TEXT that a wrap contaminates. An `<input>` has no text content,
 * which is why the checkbox and the number field may keep the wrap. Same idiom,
 * for the same reason, as the trigger editors' selects (#857).
 */
export function ConfigFieldControl({
  field,
  value,
  onChange,
  picker,
  choices,
  name,
  target,
  validation,
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
  /**
   * #1396 — on a resource form: the field's key for the form's validation
   * (`data-field`) and its current error, shown in a reserved slot under the
   * hint and marked with `aria-invalid`. The canvas passes none, and renders
   * exactly as before.
   */
  validation?: { key: string; error: string | undefined };
}) {
  const shown = name ?? field.name;
  // A cell's `name` already says where it sits; only a top-level field is titled.
  const titled = name === undefined ? field.label : undefined;
  const label = name === undefined ? configFieldTitle(field) : name;
  const required = !field.optional;
  const hintId = useId();
  // #1396 — a top-level number field leads its hint with what it admits
  // ("Whole number from 1 to 65535."), which is why its label needs no
  // " — number". A cell has no hint slot, and keeps the suffix.
  const numberField = name === undefined && field.kind === 'number';
  const rule = numberField ? describeNumberRule(field.numberRule ?? { integer: false }) : null;
  const hint =
    titled === undefined && rule === null ? null : (
      <p id={hintId} className="field-hint">
        {rule !== null && (
          <>
            {rule}.{titled === undefined ? '' : ' '}
          </>
        )}
        {titled?.description !== undefined && <>{titled.description} </>}
        {/* An untitled field's label is already its key. */}
        {titled !== undefined && <code>{field.name}</code>}
      </p>
    );
  const errorId = useId();
  const error = validation?.error;
  const shownHintId = hint === null ? undefined : hintId;
  // #1396 — with `validation`, the field's key, invalid mark and a description
  // that leads with the error; without it (the canvas), the hint alone.
  const checkedAs = (group: boolean): Partial<ReturnType<typeof fieldAttrs>> =>
    validation === undefined
      ? {}
      : fieldAttrs({ key: validation.key, error, errorId, hintId: shownHintId, group });
  const checked = checkedAs(false);
  const describedBy = checked['aria-describedby'] ?? shownHintId;
  const errorSlot = validation === undefined ? null : <FieldError id={errorId} message={error} />;
  // ONE caret hook for whichever element renders, so its caret and `touched`
  // state survive the latch below; the casts at the JSX sites only narrow the
  // union to the element each site mounts.
  const {
    ref: inputRef,
    onSelect,
    insert: insertAtCaret,
    wrapOptions,
  } = useCaretInsert<HTMLInputElement | HTMLTextAreaElement>();
  const text = typeof value === 'string' ? value : '';
  const [sawLineBreak, setSawLineBreak] = useState(false);
  // React's derived-state pattern: latch during render, never un-latch. A
  // render-phase set re-renders BEFORE anything commits, so a value that
  // arrives holding a line break never mounts an input even once.
  if (!sawLineBreak && /[\r\n]/.test(text)) setSawLineBreak(true);
  const oneLine = field.kind === 'text' && field.singleLine === true && !sawLineBreak;

  if (isRowKind(field.kind)) {
    return (
      <>
        <ObjectListControl
          field={field}
          label={label}
          required={required}
          describedBy={describedBy}
          checked={checkedAs(true)}
          rows={isRowList(value) ? value : []}
          onChange={onChange}
          picker={picker}
        />
        {hint}
        {errorSlot}
      </>
    );
  }

  if (field.kind === 'boolean') {
    return (
      // The hint is a SIBLING of the label: inside it, it would join the
      // checkbox's name.
      <>
        <label className="contract-check">
          <input
            type="checkbox"
            checked={value === true}
            aria-describedby={describedBy}
            onChange={(e) => onChange(e.target.checked)}
          />
          {label}
        </label>
        {hint}
      </>
    );
  }

  if (field.kind === 'enum') {
    return (
      <LabelledControl
        className="config-field"
        label={
          <>
            {label}
            {required && <RequiredMark />}
          </>
        }
      >
        {(id) => (
          <>
            <select
              id={id}
              value={typeof value === 'string' ? value : ''}
              aria-required={required || undefined}
              aria-describedby={describedBy}
              {...checked}
              onChange={(e) => onChange(e.target.value)}
            >
              <option value="">— none —</option>
              {(field.enumOptions ?? []).map((option) => (
                <option key={option} value={option}>
                  {field.label?.options?.[option] ?? option}
                </option>
              ))}
            </select>
            {hint}
            {errorSlot}
          </>
        )}
      </LabelledControl>
    );
  }

  if (field.kind === 'number') {
    // A TEXT input, not `type="number"`: a number input reports an unparseable
    // entry as the empty string, which this form reads as "not set" — so a typo
    // would silently DELETE the setting instead of reporting "must be a number".
    return (
      <>
        <label>
          {numberField ? label : `${label} — number`}
          {required && <RequiredMark />}
          <input
            type="text"
            inputMode={numberKeypad(field.numberRule)}
            value={typeof value === 'string' ? value : ''}
            spellCheck={false}
            placeholder={field.defaultText}
            aria-required={required || undefined}
            aria-describedby={describedBy}
            {...checked}
            onChange={(e) => onChange(e.target.value)}
          />
        </label>
        {hint}
        {errorSlot}
      </>
    );
  }

  const format =
    field.kind === 'json' ? 'JSON' : field.kind === 'stringList' ? 'one per line' : null;

  return (
    <LabelledControl
      className="config-field"
      label={
        <>
          {format === null ? label : `${label} — ${format}`}
          {required && <RequiredMark />}
        </>
      }
    >
      {(id) => (
        <>
          {oneLine ? (
            <input
              id={id}
              type="text"
              className="config-field-line"
              ref={inputRef as RefObject<HTMLInputElement | null>}
              value={text}
              onSelect={onSelect}
              spellCheck={false}
              // A connection form's `user`/`host`/`url` is not the operator's
              // own login, and a textarea never offered autofill for it.
              autoComplete="off"
              placeholder={field.defaultText}
              aria-required={required || undefined}
              aria-describedby={describedBy}
              {...checked}
              onChange={(e) => onChange(e.target.value)}
            />
          ) : (
            <textarea
              id={id}
              ref={inputRef as RefObject<HTMLTextAreaElement | null>}
              value={text}
              onSelect={onSelect}
              rows={field.kind === 'json' || field.kind === 'stringList' ? 4 : 2}
              spellCheck={false}
              placeholder={field.defaultText}
              aria-required={required || undefined}
              aria-describedby={describedBy}
              {...checked}
              onChange={(e) => onChange(e.target.value)}
            />
          )}
          {hint}
          {errorSlot}
          {/* A SIBLING of the label, not a child, because a button INSIDE the label
          contaminates the text box's accessible name — which is exactly why
          `e2e/node-config-form.spec.ts` had to move off `getByLabel`. (It does
          NOT steal focus: per the HTML standard a label's activation behaviour
          does nothing for an event targeted at interactive content inside it,
          and Chromium leaves `activeElement` on BODY. An earlier version of this
          comment claimed otherwise — right decision, wrong reason.)

          Offered on `text` fields ONLY, never on a `literal` cell (a record
          key or a secret name, see `ConfigField.literal`), and the two kind
          exclusions are refusals rather than oversights:

          - `json` parses its text with `JSON.parse` on apply
            (`configForm.parseFieldInput`), so the bare `${...}` every other
            field takes is not valid JSON and the apply would simply fail. The
            QUOTED form would be right at a value slot and wrong inside an
            existing string literal — a distinction only a JSON-aware caret could
            make. No top-level activity field needs that caret any more: #852
            gave `messages`/`tools`/`outputSchema` row editors, and `history`,
            whose save gate wants one whole `${}`, is expression text
            (`authoredAsExpression`, #864 item 4). A json CELL inside a row (a
            tool's `parameters`, a property's `constraints`) still gets none.
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
          {/* #1218 — a chooser BESIDE the text box, never instead of it.
          The free-text box always survives: a workbook whose path is not
          readable yet has no list to offer, and a control that replaced the box
          would make such a dataset unauthorable. So this is purely additive, and
          its absence is the ordinary case rather than a failure.

          A `<select>` and not a `datalist`: `datalist` does not attach to a
          `<textarea>` (which most text fields here are, for the reason argued at
          the top of this file), and its options are unreachable by keyboard on
          several engines. A select is focusable, arrow-key navigable, and
          announces its own name — the accessibility floor this has to clear.

          Its value is BOUND to the current text when that text is one of the
          offered values, so the control reflects the field rather than sitting
          permanently on the placeholder — and falls back to the placeholder for
          a hand-typed value the list does not contain, which is a legitimate
          state and not an error. */}
          {choices && field.kind === 'text' && choices.values.length > 0 && (
            <LabelledControl className="config-field config-field-choices" label={choices.label}>
              {(choicesId) => (
                <select
                  id={choicesId}
                  value={choices.values.includes(text) ? text : ''}
                  onChange={(e) => {
                    if (e.target.value !== '') choices.onChoose(e.target.value);
                  }}
                >
                  <option value="">— choose —</option>
                  {choices.values.map((option) => (
                    <option key={option} value={option}>
                      {choices.describe?.(option) ?? option}
                    </option>
                  ))}
                </select>
              )}
            </LabelledControl>
          )}
          {choices &&
            field.kind === 'text' &&
            choices.values.length === 0 &&
            choices.emptyHint !== undefined && (
              <p className="page-hint config-field-choices-empty">{choices.emptyHint}</p>
            )}
          {picker && field.kind === 'text' && !field.literal && (
            <ExpressionPicker
              fieldName={shown}
              describe={picker.describe}
              resolve={() => picker.resolve(target ?? topLevelTarget(field.name))}
              onSelect={(insert, mode) => onChange(insertAtCaret(text, insert, mode))}
              wrap={{
                value: text,
                resolve: () =>
                  wrapOptions(
                    text,
                    (span) => picker.wraps(target ?? topLevelTarget(field.name), text, span),
                    onChange,
                  ),
              }}
            />
          )}
        </>
      )}
    </LabelledControl>
  );
}

/**
 * A list of rows, one per element of an array-of-objects config field (#1169,
 * data-movement spec §13).
 *
 * §13 calls this a "table", and a `<table>` is what it is NOT. The property
 * panel is a fixed 320px column (`index.css`, `grid-template-columns: 180px 1fr
 * 320px`) and a string control in it is a `<textarea>` or at best a full-width
 * `<input>` — five columns of either in that width is about 60px each, which is
 * not an authoring surface.
 * §13's requirement is the SHAPE of the surface (a row per mapping, carrying its
 * own target type and `onError`), and at this width a stacked row card is that
 * shape. `.contract-row` is the panel's existing idiom for it, already carrying
 * `ParamRow` and `OutputRow`, whose `` `param ${i + 1} name` `` naming
 * convention this follows so the three read alike to a screen reader and to a
 * spec.
 *
 * Every cell is a plain `ConfigFieldControl`, and gets the panel's `picker`
 * with a `target` naming the cell's own position (#1178): the candidate is this
 * list's DRAFT rows with one cell replaced, read by the same `parseRowCells` an
 * apply uses (keeping the cells that parse — see `cellTarget`). Which cells actually receive offers is the
 * validator's answer, not this control's — `source` and `sink` are held to a
 * literal by §8, so their lists come back empty and say so, and `expression` on
 * a row that already reads a `source` is refused by the XOR. No cell-name table:
 * the one exception is a cell the DERIVATION marks `literal` (a `keyValue`
 * row's key, or its secret name), which the validator cannot judge because it
 * never scans a record key.
 *
 * A `keyValue` field (#852 item 2) is rendered here too, as rows of key and
 * value: the same card, add and remove, read back as a record rather than a
 * list (`rowsToRecord`). So is an `outputSchema` (#852 item 3), one row per
 * property, read back as a schema (`rowsToOutputSchema`).
 *
 * Nothing offered is a per-ROW value, and nothing here may suggest one: §8 puts
 * substitution in the reducer, so a mapping's `expression` is one constant per
 * dispatch applied to every row (#1129).
 *
 * Rows are keyed by INDEX, which is sound here and is not the hazard #1092
 * describes: a cell control holds no draft of its own (only a caret ref), so a
 * removal cannot strand a half-typed value on the row that shifts up. It can
 * still move FOCUS to a different logical row, which is the part #1092 owns.
 *
 * A cell's key carries the ROW COUNT for the one piece of state a cell does
 * hold: an open expression flyout, whose options were resolved against the row
 * it was opened on. Without it, removing an earlier row would slide a later
 * row's content under that open list, and a choice made from it would be
 * written into a row it was never checked against. Any add or remove remounts
 * the cells, which closes every flyout. A MOVE (#1347) shifts rows the same
 * way with the count unchanged, so the key also carries a local move count.
 *
 * Move up / move down are buttons rather than drag handles because order is
 * the MEANING of some lists — an `llm_call` conversation is its turn order —
 * and a button is reachable from the keyboard, which drag alone is not.
 */
export function ObjectListControl({
  field,
  label,
  required = false,
  describedBy,
  checked,
  rows,
  onChange,
  picker,
}: {
  field: ConfigField;
  label: string;
  /** #1396 — draws the asterisk; a `group` may not carry `aria-required`. */
  required?: boolean;
  /** The id of the hint under the list, when the field is titled. */
  describedBy?: string;
  /** #1396 — the form's `data-field` key and invalid mark, on the group (`fieldAttrs`). */
  checked?: Partial<ReturnType<typeof fieldAttrs>>;
  rows: readonly ObjectListRow[];
  onChange: (next: readonly ObjectListRow[]) => void;
  picker?: FieldPicker;
}) {
  const cells = field.elementFields ?? [];
  const [moves, setMoves] = useState(0);
  const groupRef = useRef<HTMLDivElement>(null);
  // Where the last move put its row. The buttons are index-keyed, so the
  // focused one now belongs to the row that shifted the other way; focus
  // follows the moved row instead, so pressing again keeps moving it.
  const moved = useRef<{ index: number; direction: 'up' | 'down' } | null>(null);
  const move = (from: number, to: number) => {
    const next = [...rows];
    const [row] = next.splice(from, 1);
    if (row === undefined) return;
    next.splice(to, 0, row);
    moved.current = { index: to, direction: to < from ? 'up' : 'down' };
    setMoves((n) => n + 1);
    onChange(next);
  };
  useEffect(() => {
    const target = moved.current;
    moved.current = null;
    if (target === null) return;
    const byName = (direction: 'up' | 'down') =>
      Array.from(groupRef.current?.querySelectorAll('button') ?? []).find(
        (b) =>
          b.getAttribute('aria-label') ===
          `move ${field.name} row ${target.index + 1} ${direction}`,
      );
    // At either end the same direction is disabled, and a disabled button
    // cannot hold focus; the other direction is the row's only move left.
    const same = byName(target.direction);
    (same && !same.disabled ? same : byName(target.direction === 'up' ? 'down' : 'up'))?.focus();
  }, [moves, field.name]);

  // Each row is read by `parseRowCells`, the reader an apply uses, keeping the
  // cells that parse. An apply refuses the whole list on one bad cell; a
  // candidate cannot, because a freshly added row is the common case and its
  // `type` is `''`, which no enum accepts — so every draft row would be
  // unprobeable until complete. The bad cell is absent on BOTH sides of the
  // comparison (the baseline is placed the same way), so it cancels. Raw control
  // values would not do: a raw row is DENSE, every cell present as `''`, and the
  // XOR rule reads `source !== undefined` as "set".
  const cellTarget = (index: number, cell: string): PickerTarget => ({
    place: (node, value) => ({
      ...node,
      config: { ...node.config, [field.name]: placeRowCandidate(field, rows, index, cell, value) },
    }),
    baseline: 'probed',
  });

  return (
    <div
      className="config-field object-list"
      role="group"
      aria-label={label}
      aria-describedby={describedBy}
      {...checked}
      ref={groupRef}
    >
      <span className="object-list-label">
        {label}
        {required && <RequiredMark />}
      </span>
      {rows.length === 0 ? <p className="page-hint">No rows.</p> : null}
      {field.recordValue === 'secret' ? (
        <p className="page-hint">
          Each row names a secret from the Secrets page. Never type the secret&apos;s value here.
        </p>
      ) : null}
      {field.kind === 'outputSchema' ? (
        <p className="page-hint">
          Each row is one field of the structured output. Constraints take the rest of the
          field&apos;s JSON Schema, such as <code>{'{"enum": ["a", "b"]}'}</code>.
        </p>
      ) : null}
      {rows.map((row, index) => (
        <div className="contract-row" key={index}>
          {cells.map((cell) => {
            const held = row[cell.name];
            return (
              <ConfigFieldControl
                key={`${cell.name}:${rows.length}:${moves}`}
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
          <div className="object-list-row-actions">
            <button
              type="button"
              aria-label={`move ${field.name} row ${index + 1} up`}
              disabled={index === 0}
              onClick={() => move(index, index - 1)}
            >
              Up
            </button>
            <button
              type="button"
              aria-label={`move ${field.name} row ${index + 1} down`}
              disabled={index === rows.length - 1}
              onClick={() => move(index, index + 1)}
            >
              Down
            </button>
            <button
              type="button"
              aria-label={`remove ${field.name} row ${index + 1}`}
              onClick={() => onChange(rows.filter((_, i) => i !== index))}
            >
              Remove
            </button>
          </div>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...rows, {}])}>
        {`Add ${field.name} row`}
      </button>
    </div>
  );
}
