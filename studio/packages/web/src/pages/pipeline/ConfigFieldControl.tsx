import { useId, useState, type ReactNode, type RefObject } from 'react';
import type { Node, RefSuggestion } from '@autonomy-studio/shared';
import { Toolbar } from '../../lib/PageHeader';
import { CheckboxField } from '../../lib/form/CheckboxField';
import {
  configFieldTitle,
  fieldSize,
  describeNumberRule,
  emptyControlValue,
  enumDefaultLabel,
  enumOptionLabel,
  isRowKind,
  isRowList,
  numberKeypad,
  placeRowCandidate,
  rowActionName,
  rowCellName,
  rowTitle,
} from './configForm';
import type { ConfigField, FieldInput, ObjectListRow } from './configForm';
import {
  ExpressionPicker,
  type ExampleChoices,
  type FieldOptions,
  type FunctionOption,
} from './ExpressionPicker';
import type { WrapSpan } from './expressionInsert';
import { fieldPickerProps, useCaretInsert } from './useCaretInsert';
import { useRowMoves } from './useRowMoves';
import { ExpressionEditor } from './ExpressionEditor';
import { LabelledControl } from '../../lib/LabelledControl';
import { JsonEditor } from '../../lib/form/JsonEditor';
import { RequiredMark } from '../../lib/form/RequiredMark';
import { AutoGrowTextarea } from '../../lib/form/AutoGrowTextarea';
import { UnitLabel, WithUnit } from '../../lib/form/UnitInput';
import { midSentence } from '../../lib/words';
import {
  RemoveRowButton,
  RowActions,
  RowTable,
  type RowTableColumn,
} from '../../lib/form/RowTable';
import { AboutHelp } from '../../lib/HelpDisclosure';
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
  /**
   * The functions whose worked examples the field accepts as a whole `${call}`
   * inserted in its mode (#1413), each keeping only those examples. Per
   * OPENING: it validates the whole doc once per example.
   */
  examples: (target: PickerTarget) => ExampleChoices;
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

/**
 * #1694 OR42 F10 — the lines a top-level text box grows to while it is edited;
 * a table cell's box grows to the same (`.row-table td textarea`, index.css).
 */
export const EDIT_ROWS = 8;

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
 * so a TITLED field still shows its key: at the end of its `?` note, or, for a
 * field with no `?` (#1694 OR42, a `?` only where the catalog wrote a note), as
 * the label's hover title. The title is for reading the form, the key is the
 * thread connecting the form, the doc and the error message.
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
  actions,
}: {
  field: ConfigField;
  value: FieldInput;
  onChange: (next: FieldInput) => void;
  picker?: FieldPicker;
  /** Server-known values for THIS field, supplied by the owning panel (#1218). */
  choices?: FieldChoices;
  /**
   * What to CALL this control, when the field's own name is not the whole
   * story. A cell inside a row list is "Column mapping row 2 sink", not `sink`: three
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
  /**
   * #1694 OR42 — the owning panel's own acts on a row list (Copy's *Auto-map
   * columns*), in the list's toolbar beside its Add button. Ignored elsewhere.
   */
  actions?: ReactNode;
}) {
  const shown = name ?? field.name;
  // A cell's `name` already says where it sits; only a top-level field is titled.
  const titled = name === undefined ? field.label : undefined;
  const label = name === undefined ? configFieldTitle(field) : name;
  // #1477 OR29 — a cell sits under its table's column header, which shows what
  // its label said. The label stays, out of sight, as the control's NAME
  // ("Column mapping row 2 sink"), so every spec and screen reader still reaches it.
  const cell = name !== undefined;
  const required = !field.optional;
  const hintId = useId();
  // #1396 — a top-level number field leads its hint with what it admits
  // ("Whole number from 1 to 65535."), which is why its label needs no
  // " — number". A cell has no hint slot, and keeps the suffix. With no note
  // (#1694 OR42) the rule is still its description, out of sight (`ruleOnly`).
  const numberField = name === undefined && field.kind === 'number';
  const rule = numberField ? describeNumberRule(field.numberRule ?? { integer: false }) : null;
  // #1694 OR42 — a `?` only where the catalog wrote a note: a field whose
  // label says it all ("Temperature", "Content") has none. A `?` holding just
  // the key, or just a rule its error line states on a bad value, was noise.
  // Where there is a note it still leads with the rule and ends with the key.
  const description = titled?.description;
  const hintBody =
    description === undefined ? null : (
      <>
        {rule !== null && <>{rule}. </>}
        {description} <code>{field.name}</code>
      </>
    );
  // With no `?`, a titled label still carries its key, on hover.
  const keyTitle = titled !== undefined && hintBody === null ? field.name : undefined;
  const seen = (text: ReactNode) =>
    cell ? (
      <span className="visually-hidden">{text}</span>
    ) : keyTitle === undefined ? (
      text
    ) : (
      <span title={keyTitle}>{text}</span>
    );
  // #1477 OR29 — a labelled field's explanation is behind a `?` beside its label
  // (labels, not prose), as a row list's already was. The note keeps `hintId`, so
  // the control's description is unchanged. #1694 OR42 — a checkbox's too, beside
  // its label (`CheckboxField`), which wraps the box.
  const help =
    hintBody === null ? undefined : (
      <AboutHelp name={label} noteId={hintId}>
        {hintBody}
      </AboutHelp>
    );
  const errorId = useId();
  const error = validation?.error;
  // A number field with no `?` is still described by its rule, so a screen
  // reader hears "Number from 0 to 1." where the eye sees a number box.
  const ruleOnly = hintBody === null && rule !== null;
  const shownHintId = hintBody === null && !ruleOnly ? undefined : hintId;
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
    insert,
    functionOptions,
  } = useCaretInsert<HTMLInputElement | HTMLTextAreaElement>();
  const text = typeof value === 'string' ? value : '';
  const [sawLineBreak, setSawLineBreak] = useState(false);
  // React's derived-state pattern: latch during render, never un-latch. A
  // render-phase set re-renders BEFORE anything commits, so a value that
  // arrives holding a line break never mounts an input even once.
  if (!sawLineBreak && /[\r\n]/.test(text)) setSawLineBreak(true);
  const oneLine = field.kind === 'text' && field.singleLine === true && !sawLineBreak;
  // #1694 OR42 F10 — a top-level control's size class; a cell is sized by its
  // table's column instead. Item 5 — a unit is drawn inside a one-line box as
  // a suffix (`30` `s`) and leaves the label, which keeps it out of sight.
  const size = cell ? undefined : fieldSize(field);
  const unit = !cell && (field.kind === 'number' || oneLine) ? field.label?.unit : undefined;
  const shownLabel =
    unit === undefined ? label : <UnitLabel title={field.label?.title ?? field.name} unit={unit} />;

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
          help={hintBody === null ? undefined : { id: hintId, body: hintBody }}
          actions={actions}
        />
        {errorSlot}
      </>
    );
  }

  if (field.kind === 'boolean') {
    return (
      // #1694 OR42 — its hint behind a `?` beside the box, like every other
      // field's, keeping `hintId` so the box's description is unchanged.
      <CheckboxField
        label={seen(label)}
        name={label}
        checked={value === true}
        onChange={onChange}
        {...(hintBody === null ? {} : { about: hintBody, noteId: hintId })}
        {...(describedBy === undefined ? {} : { describedBy })}
      />
    );
  }

  if (field.kind === 'enumSet') {
    // #1600 OR41 C8a — a set of choices as a grid of tick boxes (Get
    // metadata's field list). The control's text holds the ticks one per line.
    // A group named like a row list's: a `<label for>` cannot name a group.
    const ticked = new Set(typeof value === 'string' ? value.split('\n') : []);
    const toggle = (option: string, on: boolean) => {
      const next = new Set(ticked);
      if (on) next.add(option);
      else next.delete(option);
      onChange((field.enumOptions ?? []).filter((o) => next.has(o)).join('\n'));
    };
    return (
      <div
        className="config-field config-choice-set"
        role="group"
        aria-label={label}
        aria-describedby={describedBy}
        {...checkedAs(true)}
      >
        <div className="object-list-label help-row">
          <span>
            {seen(label)}
            {required && !cell && <RequiredMark />}
          </span>
          {help}
        </div>
        <div className="config-choices">
          {(field.enumOptions ?? []).map((option) => (
            <CheckboxField
              key={option}
              label={enumOptionLabel(field, option)}
              name={enumOptionLabel(field, option)}
              checked={ticked.has(option)}
              onChange={(on) => toggle(option, on)}
            />
          ))}
        </div>
        {errorSlot}
      </div>
    );
  }

  if (field.kind === 'enum') {
    return (
      <LabelledControl
        className="config-field"
        help={help}
        label={
          <>
            {seen(label)}
            {required && !cell && <RequiredMark />}
          </>
        }
      >
        {(id) => (
          <>
            <select
              id={id}
              data-size={size}
              value={typeof value === 'string' ? value : ''}
              aria-required={required || undefined}
              aria-describedby={describedBy}
              {...checked}
              onChange={(e) => onChange(e.target.value)}
            >
              {/* #1694 OR42 item 9 — blank in an optional table cell, where
                  the same placeholder in every row was noise and empty means
                  the default (On error's "Fail the row"). A required cell keeps
                  it: there, empty is a gap to fill. #1732 — a top-level
                  field the schema defaults names that default instead. */}
              <option value="">
                {cell && !required ? '' : (enumDefaultLabel(field) ?? '— none —')}
              </option>
              {(field.enumOptions ?? []).map((option) => (
                <option key={option} value={option}>
                  {enumOptionLabel(field, option)}
                </option>
              ))}
            </select>
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
    // #1477 OR29 — paired by `htmlFor`, not wrapped, like every other kind: the
    // property dock's grid puts the label in a column of its own.
    return (
      <LabelledControl
        className="config-field"
        help={help}
        label={
          <>
            {seen(numberField ? shownLabel : `${label} — number`)}
            {required && !cell && <RequiredMark />}
          </>
        }
      >
        {(id) => (
          <>
            <WithUnit unit={unit}>
              <input
                id={id}
                type="text"
                className="number-input"
                data-size={size}
                inputMode={numberKeypad(field.numberRule)}
                value={typeof value === 'string' ? value : ''}
                spellCheck={false}
                placeholder={field.defaultText}
                aria-required={required || undefined}
                aria-describedby={describedBy}
                {...checked}
                onChange={(e) => onChange(e.target.value)}
              />
            </WithUnit>
            {ruleOnly && (
              <span id={hintId} className="visually-hidden">
                {rule}.
              </span>
            )}
            {errorSlot}
          </>
        )}
      </LabelledControl>
    );
  }

  const format = textFormat(field);

  return (
    <LabelledControl
      className="config-field"
      help={help}
      label={
        <>
          {seen(format === null ? shownLabel : `${label} — ${format}`)}
          {required && !cell && <RequiredMark />}
        </>
      }
    >
      {(id) => (
        <>
          {oneLine ? (
            <WithUnit unit={unit}>
              <input
                id={id}
                type="text"
                className="config-field-line"
                data-size={size}
                // #1694 OR42 F10 — an S or M box holding a `${}` widens to the
                // value column while it has focus (index.css).
                data-expr={text.includes('${') ? '' : undefined}
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
            </WithUnit>
          ) : field.kind === 'json' ? (
            <JsonEditor
              id={id}
              label={label}
              ref={inputRef as RefObject<HTMLTextAreaElement | null>}
              value={text}
              onSelect={onSelect}
              // A cell keeps its two lines; a top-level box expands on edit
              // like a text one (#1694 OR42 F10).
              {...(cell ? { rows: 2 } : { restRows: 1, maxRows: EDIT_ROWS })}
              placeholder={field.defaultText}
              aria-required={required || undefined}
              aria-describedby={describedBy}
              {...checked}
              onValueChange={onChange}
            />
          ) : cell ? (
            <textarea
              id={id}
              ref={inputRef as RefObject<HTMLTextAreaElement | null>}
              value={text}
              onSelect={onSelect}
              // A cell opens one line tall, and grows with its text
              // (`field-sizing`, index.css) so a multi-line value still shows.
              rows={1}
              spellCheck={false}
              placeholder={field.defaultText}
              aria-required={required || undefined}
              aria-describedby={describedBy}
              {...checked}
              onChange={(e) => onChange(e.target.value)}
            />
          ) : (
            // #1694 OR42 F10 — expand on edit: one line at rest, up to eight
            // while it has focus, so no field is permanently tall.
            <AutoGrowTextarea
              id={id}
              ref={inputRef as RefObject<HTMLTextAreaElement | null>}
              value={text}
              onSelect={onSelect}
              restRows={1}
              maxRows={EDIT_ROWS}
              spellCheck={false}
              placeholder={field.defaultText}
              aria-required={required || undefined}
              aria-describedby={describedBy}
              {...checked}
              onChange={(e) => onChange(e.target.value)}
            />
          )}
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
              // A cell's name opens with its list's title, which reads mid-sentence
              // in "Insert reference into column mapping row 1 expression".
              fieldName={cell ? midSentence(shown) : shown}
              // #1477 OR29 — glyphs at the top level too: two worded buttons
              // stacked under every expression box were 44px a field.
              compact
              keepFocus={cell}
              {...fieldPickerProps(
                { insert, functionOptions },
                picker,
                target ?? topLevelTarget(field.name),
                text,
                onChange,
              )}
              // #1694 OR42 F10 — ⤢ opens the field in a full-size editor. A
              // top-level field only: a cell's toggles show only while its box
              // has focus, and a row has no room for a third.
              after={
                cell ? undefined : (
                  <ExpressionEditor
                    // Titled as the field's label reads ("Task"), not its key.
                    fieldName={label}
                    value={text}
                    onChange={onChange}
                    picker={picker}
                    target={target ?? topLevelTarget(field.name)}
                    singleLine={oneLine}
                  />
                )
              }
            />
          )}
        </>
      )}
    </LabelledControl>
  );
}

/** How a text-shaped field's value is written, when the label must say so. */
function textFormat(field: ConfigField): string | null {
  return field.kind === 'json' ? 'JSON' : field.kind === 'stringList' ? 'one per line' : null;
}

/**
 * A row list's column for one cell (#1477 OR29): what the cell's label said —
 * its title, how its value is written, and whether it is required.
 */
function cellColumn(cell: ConfigField): RowTableColumn {
  const format = cell.kind === 'number' ? 'number' : textFormat(cell);
  return {
    key: cell.name,
    header: (
      <>
        {format === null ? rowTitle(cell) : `${rowTitle(cell)} — ${format}`}
        {!cell.optional && <RequiredMark />}
      </>
    ),
    width:
      cell.kind === 'boolean'
        ? 'check'
        : cell.kind === 'enum'
          ? 'short'
          : cell.kind === 'text' && cell.singleLine === true
            ? 'name'
            : 'long',
  };
}

/**
 * A list of rows, one per element of an array-of-objects config field (#1169,
 * data-movement spec §13).
 *
 * §13 calls this a "table", and since #1477 OR29 a `<table>` is what it is
 * (`RowTable`). It was once a stack of `.contract-row` cards, because the
 * property panel was a fixed 320px column and five cells across it were about
 * 60px each. The dock is wider now (a 589px tab at 1440x900), the table scrolls
 * sideways rather than crushing its cells in a narrow right-hand dock, and a
 * header row replaces a label repeated on every cell. Each cell's control keeps
 * its own name — "Column mapping row 2 sink", its list, its row and its cell,
 * in words (#1594 OR40 S4b-2, `rowCellName`), not schema keys.
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
  help,
  actions,
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
  /**
   * #1477 OR29 — the list's hint, behind a `?` beside its label rather than a
   * paragraph under the table. `id` is what `describedBy` names: a closed
   * `<details>`' note is still the group's description.
   */
  help?: { id: string; body: ReactNode };
  /** #1694 OR42 — more acts for the toolbar, after Add. */
  actions?: ReactNode;
}) {
  const cells = field.elementFields ?? [];
  const columns = cells.map(cellColumn);
  const labelId = useId();
  const { moves, move, groupRef } = useRowMoves(rows, onChange, (index, direction) =>
    rowActionName(field, index, direction),
  );

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

  // #1694 OR42 item 4 — what a secret list or an output schema's rows hold is
  // behind the list's `?`, after the field's own note, not a paragraph under
  // its toolbar (labels, not prose). A list with no note of its own gets one.
  const listNote =
    field.recordValue === 'secret' ? (
      <>Each row names a secret from the Secrets page. Never type the secret&apos;s value here.</>
    ) : field.kind === 'outputSchema' ? (
      <>
        Each row is one field of the structured output. Constraints take the rest of the
        field&apos;s JSON Schema, such as <code>{'{"enum": ["a", "b"]}'}</code>.
      </>
    ) : null;
  const ownNoteId = useId();
  const aboutId = help?.id ?? ownNoteId;
  const about: ReactNode =
    help === undefined ? (
      listNote
    ) : listNote === null ? (
      help.body
    ) : (
      <>
        {help.body} {listNote}
      </>
    );
  const describedByAll =
    help === undefined && listNote !== null
      ? [describedBy, aboutId].filter(Boolean).join(' ')
      : describedBy;

  return (
    <div
      className="config-field object-list"
      role="group"
      aria-label={label}
      aria-describedby={describedByAll}
      {...checked}
      ref={groupRef}
    >
      {/* A `div`: the `?` is a `<details>`, which a span may not hold. */}
      <div className="object-list-label help-row">
        <span
          id={labelId}
          title={help === undefined && label !== field.name ? field.name : undefined}
        >
          {label}
        </span>
        {required && <RequiredMark />}
        {about !== null && (
          <AboutHelp name={label} noteId={aboutId}>
            {about}
          </AboutHelp>
        )}
      </div>
      {/* #1694 OR42 — the list's acts ABOVE its rows, sized to their text. */}
      <Toolbar align="start">
        <button type="button" onClick={() => onChange([...rows, {}])}>
          {`Add ${midSentence(rowTitle(field))} row`}
        </button>
        {actions}
      </Toolbar>
      {rows.length === 0 ? <p className="page-hint">No rows.</p> : null}
      {rows.length > 0 ? (
        <RowTable columns={columns} labelledBy={labelId}>
          {rows.map((row, index) => (
            <tr key={index}>
              {cells.map((cell, c) => {
                const held = row[cell.name];
                return (
                  <td key={cell.name} data-width={columns[c]?.width}>
                    <ConfigFieldControl
                      key={`${cell.name}:${rows.length}:${moves}`}
                      field={cell}
                      name={rowCellName(field, index, cell)}
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
                  </td>
                );
              })}
              <RowActions>
                <button
                  type="button"
                  aria-label={rowActionName(field, index, 'up')}
                  disabled={index === 0}
                  onClick={() => move(index, index - 1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={rowActionName(field, index, 'down')}
                  disabled={index === rows.length - 1}
                  onClick={() => move(index, index + 1)}
                >
                  ↓
                </button>
                <RemoveRowButton
                  label={rowActionName(field, index, 'remove')}
                  onRemove={() => onChange(rows.filter((_, i) => i !== index))}
                />
              </RowActions>
            </tr>
          ))}
        </RowTable>
      ) : null}
    </div>
  );
}
