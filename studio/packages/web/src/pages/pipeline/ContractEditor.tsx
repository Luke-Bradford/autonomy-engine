import { useState, type ReactNode } from 'react';
import {
  OutputTypeSchema,
  ParamTypeSchema,
  VariableTypeSchema,
  paramDefaultDefect,
  variableDefaultDefects,
  variableNameDefect,
  type Output,
  type OutputType,
  type Param,
  type ParamType,
  type VariableDef,
} from '@autonomy-studio/shared';
import { LabelledControl } from '../../lib/LabelledControl';
import type { createCanvasStore } from './canvasStore';
import {
  coerceDefaultInput,
  coerceVariableDefault,
  formatDefaultInput,
  formatVariableDefault,
  paramDefaultNote,
  paramNameNote,
  withRequired,
  withVariableType,
} from './paramRules';

/**
 * The pipeline's declaration editors — Parameters, Variables and Outputs (U16,
 * #844 V3) — as ONE row shell with a slot for what each kind adds.
 *
 * Params and outputs were written as two near-copies of the same row (name,
 * type, description, remove), and V3's variables would have been the third. The
 * third-copy rule (2026-08-20) folds them instead: `ContractRow` owns the shared
 * chrome in one DOM order, `ContractSection` the heading/list/add frame, and
 * `useDefaultDraft` the draft-and-commit-on-blur default field params and
 * variables both need. The aria-labels (`param 1 name`, …) are unchanged, so
 * every spec written against the two old rows still addresses the same controls.
 */

type Store = ReturnType<typeof createCanvasStore>;
type Kind = 'param' | 'output' | 'variable' | 'global';

/** The row fields every declaration kind shares. */
interface Declared {
  name: string;
  type: string;
  description?: string;
}

/** Set or clear `description`. Blank is the ABSENT key, not `''`, as the schemas document. */
function withDescription<R extends Declared>(row: R, text: string): R {
  if (text) return { ...row, description: text };
  const { description: cleared, ...rest } = row;
  void cleared; // discard: lint has no ignoreRestSiblings here
  return rest as R;
}

export function ContractSection({
  heading,
  hint,
  count,
  addLabel,
  onAdd,
  children,
}: {
  heading: string;
  hint: ReactNode;
  count: number;
  addLabel: string;
  onAdd: () => void;
  children: ReactNode;
}) {
  return (
    <section className="contract-section">
      <h4>{heading}</h4>
      <p className="page-hint">{hint}</p>
      {count === 0 ? <p className="page-hint">None declared.</p> : null}
      {children}
      <button type="button" onClick={onAdd}>
        {addLabel}
      </button>
    </section>
  );
}

/**
 * One declaration row: Name, Type, then the kind's own controls (`children`),
 * then Description and Remove. `onType` receives the raw option text, and each
 * kind parses it with its OWN schema — parsing rather than casting is what
 * enforces, for example, that no output can be typed `secret`.
 *
 * `locked` (#844 GL2) freezes Name and Type on a row whose identity is already
 * stored — a saved global, whose name and type are immutable (GL-D1). Both
 * render READ-ONLY rather than disabled: a disabled control is skipped by
 * keyboard navigation and by some screen readers, and which global a row is
 * remains information worth reaching (the SecretsPage precedent). A `<select>`
 * has no read-only state, so a locked Type is a read-only input.
 */
export function ContractRow<R extends Declared>({
  kind,
  index,
  row,
  types,
  locked = false,
  removeLabel = 'Remove',
  onChange,
  onType,
  onRemove,
  children,
}: {
  kind: Kind;
  index: number;
  row: R;
  types: readonly string[];
  locked?: boolean;
  /** What Remove says — e.g. `Delete` where removing the row deletes a stored resource, as the Manage pages word it. */
  removeLabel?: string;
  onChange: (next: R) => void;
  onType: (raw: string) => void;
  onRemove: () => void;
  children?: ReactNode;
}) {
  const n = index + 1;
  return (
    <div className="contract-row">
      <label>
        Name
        <input
          aria-label={`${kind} ${n} name`}
          value={row.name}
          readOnly={locked}
          onChange={(e) => onChange({ ...row, name: e.target.value })}
        />
      </label>
      <LabelledControl label="Type">
        {(id) =>
          locked ? (
            <input id={id} aria-label={`${kind} ${n} type`} value={row.type} readOnly />
          ) : (
            <select
              id={id}
              aria-label={`${kind} ${n} type`}
              value={row.type}
              onChange={(e) => onType(e.target.value)}
            >
              {types.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          )
        }
      </LabelledControl>
      {children}
      <label>
        Description
        <input
          aria-label={`${kind} ${n} description`}
          value={row.description ?? ''}
          onChange={(e) => onChange(withDescription(row, e.target.value))}
        />
      </label>
      <button
        type="button"
        aria-label={`${removeLabel.toLowerCase()} ${kind} ${n}`}
        onClick={onRemove}
      >
        {removeLabel}
      </button>
    </div>
  );
}

/**
 * The default field's draft. It is the ONE control that cannot commit on every
 * keystroke: half-typed JSON is not JSON, so a commit-per-character would either
 * reject every intermediate state or store garbage. It holds a draft and the
 * caller commits on blur; every other control writes straight through.
 *
 * Re-synced whenever a DIFFERENT row object arrives at this index.
 *
 * The identity check is the load-bearing choice, and it replaces a compare of
 * the formatted default STRING that was wrong in a way worth recording. The rows
 * are keyed by array index, so a removal SHIFTS the rows after it into a row
 * that already holds draft text for the one that left. A string compare misses
 * that whenever the two defaults happen to format alike: with two number params
 * both defaulting to `1`, typing `9x` into row 1, blurring (the commit fails, so
 * nothing is written), then removing row 1 leaves row 1 rendering the SECOND
 * param while still showing the first one's draft and error — and the next
 * successful blur writes that value onto a param the operator never edited.
 *
 * The reason first given for the string compare — that a `json` default is a
 * fresh object every render, so identity would resync constantly — was simply
 * false. `map`/`filter` in the store preserve element identity for untouched
 * rows, so a new object arrives exactly when this row is REPLACED.
 *
 * It costs nothing in practice: every other control in the row takes focus to
 * reach, which blurs the default field and commits it first, so an uncommitted
 * draft cannot survive an edit to a sibling field anyway.
 */
function useDefaultDraft<R>(row: R, format: (row: R) => string) {
  const stored = format(row);
  const [draft, setDraft] = useState(stored);
  const [syncedRow, setSyncedRow] = useState(row);
  const [error, setError] = useState<string | null>(null);

  if (syncedRow !== row) {
    setSyncedRow(row);
    setDraft(stored);
    setError(null);
  }

  return {
    stored,
    draft,
    error,
    setError,
    edit(text: string) {
      setDraft(text);
      setError(null);
    },
  };
}

/** What the default field should look like it wants, per declared type. */
const DEFAULT_PLACEHOLDER: Record<ParamType, string> = {
  string: 'text',
  number: '42',
  boolean: 'true or false',
  json: '{"key": "value"}',
  secret: 'credential label',
};

const VARIABLE_PLACEHOLDER: Record<VariableDef['type'], string> = {
  string: 'empty text is a value',
  number: '0',
  boolean: 'true or false',
  array: '[]',
};

export function ParamRow({ store, index, param }: { store: Store; index: number; param: Param }) {
  const field = useDefaultDraft(param, (p) => formatDefaultInput(p.default, p.type));

  const defect = paramDefaultDefect(param);
  const nameNote = paramNameNote(param);
  const defaultNote = paramDefaultNote(param);
  const update = (next: Param) => store.getState().updateParam(index, next);

  function commitDefault(text: string) {
    // A blur that changed nothing must not write. Tabbing THROUGH the field
    // would otherwise mark the canvas dirty on an untouched doc — the same
    // no-op-write hazard `setNodeContainer` avoids — and, worse, would DELETE a
    // stored default of `''` or whitespace, which `coerceDefaultInput` reads as
    // "no default". An imported doc can legitimately hold one.
    if (text === field.stored) return;

    const parsed = coerceDefaultInput(param.type, text);
    if (!parsed.ok) {
      // Keep the operator's text on screen and say why it was not stored. The
      // alternative — silently reverting the field — loses what they typed.
      field.setError(parsed.error);
      return;
    }
    field.setError(null);
    if (parsed.has) update({ ...param, default: parsed.value });
    else clearDefault();
  }

  function clearDefault() {
    // NO default is the absence of the key, not `default: undefined` —
    // `resolveRunParams` reads it with `hasOwnProperty`.
    const { default: cleared, ...rest } = param;
    void cleared; // discard: lint has no ignoreRestSiblings here
    update(rest);
  }

  // #844 4c — a blank field says "no default", so `''` needs its own control.
  // Only a `string` has an empty value to offer (a `json` field takes `""`
  // typed; number/boolean/secret have none), and only a BLANK field needs it,
  // so the tick box appears on no other row: the clutter that ruled out a
  // has-default checkbox on every row does not arise.
  const emptyString = param.type === 'string' && field.draft === '';
  const isEmptyString = 'default' in param && param.default === '';

  return (
    <ContractRow
      kind="param"
      index={index}
      row={param}
      types={ParamTypeSchema.options}
      onChange={update}
      onType={(raw) => {
        const parsed = ParamTypeSchema.safeParse(raw);
        if (!parsed.success) return;
        // The stored default is deliberately KEPT across a type change, even
        // when it no longer fits: dropping it would destroy authored data on a
        // mis-click, and the save gate below names the mismatch in the author's
        // own words. Repair beats silent deletion.
        update({ ...param, type: parsed.data });
      }}
      onRemove={() => store.getState().removeParam(index)}
    >
      <label className="contract-check">
        <input
          type="checkbox"
          aria-label={`param ${index + 1} required`}
          checked={param.required}
          onChange={(e) => update(withRequired(param, e.target.checked))}
        />
        Required
      </label>
      {param.required && !('default' in param) ? (
        <p className="page-hint">A run must supply this param.</p>
      ) : (
        // The field is shown whenever a default EXISTS, required or not.
        //
        // Hiding it for a required param — on the belief that a required param's
        // default is never read — was wrong, and silently so. `resolveRunParams`
        // tests `hasOwnProperty(p, 'default')` BEFORE it tests `p.required`, so a
        // required param carrying a default resolves from that default and is
        // never asked for a value. A doc minted through the API can hold one (the
        // write path accepts any `default`), and hiding the field made that value
        // invisible, un-editable, and immune to the advisory below — while the
        // panel asserted the opposite of what the engine does.
        <label>
          Default
          <input
            aria-label={`param ${index + 1} default`}
            placeholder={DEFAULT_PLACEHOLDER[param.type]}
            value={field.draft}
            onChange={(e) => field.edit(e.target.value)}
            onBlur={(e) => commitDefault(e.target.value)}
          />
          <span className="page-hint">
            {param.required
              ? 'Required, but this stored default already satisfies it — a run is never asked for a value. Blank the field to make the param truly required.'
              : emptyString && isEmptyString
                ? 'The default is the empty string.'
                : 'Leave blank for no default.'}
          </span>
        </label>
      )}
      {emptyString && (!param.required || isEmptyString) ? (
        <label className="contract-check">
          <input
            type="checkbox"
            aria-label={`param ${index + 1} empty-string default`}
            checked={isEmptyString}
            onChange={(e) =>
              e.target.checked ? update({ ...param, default: '' }) : clearDefault()
            }
          />
          Empty string
        </label>
      ) : null}
      {field.error ? (
        <p className="error" role="alert">
          {field.error}
        </p>
      ) : null}
      {!field.error && defect ? (
        // #843 — a SAVE GATE now, not the advisory this used to be. The server
        // refuses this doc (`paramDefaultDefect`, reached through
        // `validateDoc`), so the badge already bars Save; this row-level copy of
        // the SAME sentence is where the fix is made. Word-for-word the same
        // string on purpose: an operator reading the badge can find the field it
        // is about.
        //
        // `role="alert"` like every other `.error` in this app. It does mean this
        // sentence is announced twice — the doc-level badge is a `role="status"`
        // carrying the same string — but the badge only says the DOC has issues,
        // while this one is attached to the control the operator just changed.
        // Announcing where the problem is beats staying silent on the field that
        // caused it.
        <p className="error" role="alert">
          {defect}
        </p>
      ) : null}
      {/* #844 — notes, not errors: each describes a doc that saves and runs.
          The default note is held back while the field shows a parse error,
          because it reads the STORED default the draft is replacing. No
          live-region role (#1249). */}
      {nameNote ? <p className="contract-advisory">{nameNote}</p> : null}
      {!field.error && defaultNote ? <p className="contract-advisory">{defaultNote}</p> : null}
    </ContractRow>
  );
}

/**
 * #844 V3 — one declared variable. Its default is REQUIRED and strict (spec
 * V-D1), which changes three things against `ParamRow`:
 *  - there is no blank-means-none: blank is `''` for a string and a parse error
 *    otherwise (`coerceVariableDefault`);
 *  - a type change converts the default or zeroes it (`withVariableType`)
 *    rather than keeping a value the gate would refuse;
 *  - a blur that changed nothing is skipped only when the STORED default is
 *    already legal. An imported doc can hold `"5"` under `number`, which shows
 *    as `5`; skipping that blur would leave the author unable to repair it
 *    without editing the text away and back.
 * The row's errors are the badge's own sentences (`variableNameDefect`,
 * `variableDefaultDefects`), so the two cannot drift.
 */
export function VariableRow({
  store,
  index,
  variable,
}: {
  store: Store;
  index: number;
  variable: VariableDef;
}) {
  const field = useDefaultDraft(variable, (v) => formatVariableDefault(v.default, v.type));
  const update = (next: VariableDef) => store.getState().updateVariable(index, next);
  const defaultDefects = variableDefaultDefects(variable);
  // A blank name is already reported as "variable #n has no name" by the save
  // gate's `nameIssues`; saying it cannot be referenced too would be noise.
  const nameDefect = variable.name.trim() ? variableNameDefect(variable) : null;

  function commitDefault(text: string) {
    if (text === field.stored && defaultDefects.length === 0) return;
    const parsed = coerceVariableDefault(variable.type, text);
    if (!parsed.ok) {
      field.setError(parsed.error);
      return;
    }
    field.setError(null);
    update({ ...variable, default: parsed.value });
  }

  return (
    <ContractRow
      kind="variable"
      index={index}
      row={variable}
      types={VariableTypeSchema.options}
      onChange={update}
      onType={(raw) => {
        const parsed = VariableTypeSchema.safeParse(raw);
        if (!parsed.success) return;
        update(withVariableType(variable, parsed.data));
      }}
      onRemove={() => store.getState().removeVariable(index)}
    >
      <label>
        Default
        <input
          aria-label={`variable ${index + 1} default`}
          placeholder={VARIABLE_PLACEHOLDER[variable.type]}
          value={field.draft}
          onChange={(e) => field.edit(e.target.value)}
          onBlur={(e) => commitDefault(e.target.value)}
        />
        <span className="page-hint">The value every run starts from.</span>
      </label>
      {field.error ? (
        <p className="error" role="alert">
          {field.error}
        </p>
      ) : null}
      {nameDefect ? (
        <p className="error" role="alert">
          {nameDefect}
        </p>
      ) : null}
      {!field.error
        ? defaultDefects.map((d) => (
            <p key={d} className="error" role="alert">
              {d}
            </p>
          ))
        : null}
    </ContractRow>
  );
}

export function OutputRow({
  store,
  index,
  output,
}: {
  store: Store;
  index: number;
  output: Output;
}) {
  const update = (next: Output) => store.getState().updateOutput(index, next);
  return (
    <ContractRow
      kind="output"
      index={index}
      row={output}
      types={OutputTypeSchema.options}
      onChange={update}
      onType={(raw) => {
        // `OutputTypeSchema` excludes `secret` — a declared secret output would
        // be a leak channel. Parsing rather than casting means the exclusion is
        // enforced here, not merely reflected by the options.
        const parsed = OutputTypeSchema.safeParse(raw);
        if (!parsed.success) return;
        update({ ...output, type: parsed.data as OutputType });
      }}
      onRemove={() => store.getState().removeOutput(index)}
    >
      <label className="contract-check">
        <input
          type="checkbox"
          aria-label={`output ${index + 1} optional`}
          checked={output.optional ?? false}
          onChange={(e) => {
            if (e.target.checked) {
              update({ ...output, optional: true });
            } else {
              // ABSENT means required in `OutputSchema`, so unchecking removes
              // the key rather than writing `optional: false`. Both read the
              // same, but only one matches what the schema documents.
              const { optional: cleared, ...rest } = output;
              void cleared;
              update(rest);
            }
          }}
        />
        Optional
      </label>
    </ContractRow>
  );
}
