import { useState, type ReactNode } from 'react';
import type { SqlParameterValue } from '@autonomy-studio/shared';
import { LabelledControl } from '../../lib/LabelledControl';
import { midSentence } from '../../lib/words';
import { RequiredMark } from '../../lib/form/RequiredMark';
import { AutoGrowTextarea } from '../../lib/form/AutoGrowTextarea';
import { RemoveRowButton, RowActions, RowNotes } from '../../lib/form/RowTable';
import { EDIT_ROWS, type FieldPicker, type PickerTarget } from './ConfigFieldControl';
import type { FieldSize } from './configForm';
import { ExpressionEditor } from './ExpressionEditor';
import { PickableInput } from './PickableInput';
import {
  bindNameProblem,
  bindTypeOf,
  bindValueFor,
  bindValueText,
  isDynamicBindText,
  type BindType,
} from './inlineSource';

/**
 * #1600 OR41 C10c — the pieces a literal SQL statement and its `:name` bind
 * values are authored with, shared by an inline query source (C1q-b,
 * `InlineSourceEditor`) and a Script block (`ScriptBlocksEditor`), so the two
 * are one editor rather than two copies of it.
 */

const BIND_TYPE_LABELS: Record<BindType, string> = {
  text: 'Text',
  number: 'Number',
  null: 'Null',
};

/**
 * A LITERAL statement: a box one line tall at rest, growing as it is typed,
 * with ⤢ for a larger editor. Neither offers `${}` (catalogue §8): the
 * statement is never evaluated, only its bind values are. `onChange`'s
 * `coalesce` merges a keystroke into the typing before it; OK in the larger
 * editor is its own undo step.
 */
export function LiteralSqlField({
  title,
  about,
  value,
  onChange,
  inputLabel,
}: {
  /** The field's visible label, and the larger editor's title. */
  title: string;
  about: { name: string; note: string } | undefined;
  value: string;
  onChange: (next: string, coalesce: boolean) => void;
  /** The box's accessible name, when it is not `title` (a block in a list). */
  inputLabel?: string;
}) {
  return (
    <LabelledControl
      label={
        <>
          {title}
          <RequiredMark />
        </>
      }
      about={about}
    >
      {(id, describedBy) => (
        <>
          <AutoGrowTextarea
            id={id}
            aria-describedby={describedBy}
            aria-label={inputLabel}
            aria-required
            restRows={1}
            maxRows={EDIT_ROWS}
            spellCheck={false}
            value={value}
            onChange={(e) => onChange(e.target.value, true)}
          />
          {/* No picker: the statement is literal, so its editor offers no `${}`.
              The wrapper is the toggle row a config field's ⤢ sits in. */}
          <div className="expression-picker">
            <ExpressionEditor
              // A list's box is named mid-sentence there, as a row cell's is.
              fieldName={inputLabel === undefined ? title : midSentence(inputLabel)}
              value={value}
              onChange={(next) => onChange(next, false)}
              singleLine={false}
            />
          </div>
        </>
      )}
    </LabelledControl>
  );
}

/**
 * *Import from statement*, and beside it which `:name`s are still unbound.
 * Said beside the button, not only in its hover: a disabled button gets no
 * hover in every browser (`RowList`).
 */
export function ImportFromStatement({
  used,
  unbound,
  onImport,
}: {
  /** Every `:name` the statement uses. */
  used: readonly string[];
  /** Those with no row yet. */
  unbound: readonly string[];
  onImport: () => void;
}) {
  return (
    <>
      <button
        type="button"
        disabled={unbound.length === 0}
        title="Add a row for each :name in the statement that has no value yet"
        onClick={onImport}
      >
        Import from statement
      </button>
      <span className="page-hint" role="status">
        {unbound.length > 0
          ? `Not bound: ${unbound.map((n) => `:${n}`).join(', ')}`
          : used.length > 0
            ? 'Every :name is bound'
            : 'No :name in the statement'}
      </span>
    </>
  );
}

/**
 * One `:name` and its value, with a Type when `typed` (C1q-c) and any `extra`
 * cells after the value (a Script parameter's Direction). The name box shows a
 * local DRAFT: a name that cannot be a key of the stored record
 * (`bindNameProblem`) is held here with its reason until it can be, and the
 * stored row keeps its last good name. The type and value are drafts too
 * (`bindValueFor`): a Number whose text is not a number yet is held with its
 * reason, and the stored value waits. Untyped, every value is text.
 */
export function BindValueRow({
  label,
  name,
  value,
  others,
  typed,
  picker,
  target,
  advisory,
  extra,
  columnCount,
  onRename,
  onValue,
  onRemove,
}: {
  /** The row's name in words ("Bind value 1"); each control's is this and its column. */
  label: string;
  name: string;
  value: unknown;
  others: readonly string[];
  typed: boolean;
  picker: FieldPicker | undefined;
  /** Where the ⓕ flyout places a value, by the row's STORED name. */
  target: PickerTarget;
  /** The row's note after a name or value problem (unused, refused at run). */
  advisory: string | null;
  /** Cells after Value. */
  extra?: ReactNode;
  /** The table's columns, so the notes row spans them and the actions cell. */
  columnCount: number;
  onRename: (to: string) => void;
  /** `coalesce` merges a keystroke into the typing before it; a type change is its own undo step. */
  onValue: (value: SqlParameterValue, coalesce: boolean) => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState(name);
  const [synced, setSynced] = useState(name);
  // The value box shows a DRAFT as the override rows do (`OverrideRow`): a
  // stored number is `150` for the text `150.`, and rendering it back would
  // snap the box while the author is still typing.
  const [valueDraft, setValueDraft] = useState(() => bindValueText(value));
  const [typeDraft, setTypeDraft] = useState<BindType>(() => (typed ? bindTypeOf(value) : 'text'));
  const [syncedValue, setSyncedValue] = useState(value);
  const resync = () => {
    setValueDraft(bindValueText(value));
    if (typed) setTypeDraft(bindTypeOf(value));
  };
  const own = bindValueFor(typeDraft, valueDraft);
  const drafted = 'value' in own && own.value === value;
  // The drafts follow the store only when it moves on its own (undo, a flyout
  // insert, or a row removed above this one, as rows are kept by position).
  if (syncedValue !== value) {
    setSyncedValue(value);
    if (!drafted) resync();
  }
  if (synced !== name) {
    setSynced(name);
    // A name this row's own rename stored is the draft already.
    if (name !== draft) {
      setDraft(name);
      if (!drafted) resync();
    }
  }
  // A stored name is judged too: an imported `:wm` says why it never binds.
  const problem = bindNameProblem(draft, others);
  const valueProblem = 'problem' in own ? own.problem : null;
  const dynamic = typeDraft !== 'null' && isDynamicBindText(valueDraft);
  const note = problem ?? valueProblem ?? advisory;
  return (
    <>
      <tr>
        <td>
          <input
            aria-label={`${label} name`}
            aria-invalid={problem !== null || undefined}
            spellCheck={false}
            value={draft}
            onChange={(e) => {
              const to = e.target.value;
              setDraft(to);
              if (bindNameProblem(to, others) === null) onRename(to);
            }}
          />
        </td>
        {typed && (
          <td>
            <select
              aria-label={`${label} type`}
              data-size={'s' satisfies FieldSize}
              value={dynamic ? 'expression' : typeDraft}
              disabled={dynamic}
              title={dynamic ? 'A ${} value keeps the type it resolves to' : undefined}
              onChange={(e) => {
                const t = e.target.value as BindType;
                setTypeDraft(t);
                const next = bindValueFor(t, valueDraft);
                if (t === 'null') setValueDraft('');
                if ('value' in next) onValue(next.value, false);
              }}
            >
              {dynamic && <option value="expression">Expression</option>}
              {(Object.keys(BIND_TYPE_LABELS) as BindType[]).map((t) => (
                <option key={t} value={t}>
                  {BIND_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </td>
        )}
        <td>
          {typeDraft === 'null' ? (
            <input aria-label={`${label} value`} disabled value="" placeholder="null" />
          ) : (
            <PickableInput
              value={valueDraft}
              onChange={(t) => {
                setValueDraft(t);
                const next = bindValueFor(typeDraft, t);
                if ('value' in next) onValue(next.value, true);
              }}
              picker={picker}
              pickerName={`:${name}`}
              target={target}
            >
              <span className="visually-hidden">{`${label} value`}</span>
            </PickableInput>
          )}
        </td>
        {extra}
        <RowActions>
          <RemoveRowButton
            label={`Remove ${label.charAt(0).toLowerCase()}${label.slice(1)}`}
            onRemove={onRemove}
          />
        </RowActions>
      </tr>
      {note !== null && (
        <RowNotes span={columnCount + 1}>
          <p className="contract-advisory">{note}</p>
        </RowNotes>
      )}
    </>
  );
}
