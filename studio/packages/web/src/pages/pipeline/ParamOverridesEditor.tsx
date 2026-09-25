import { useState } from 'react';
import type { Node } from '@autonomy-studio/shared';
import type { FieldPicker, PickerTarget } from './ConfigFieldControl';
import { PickableInput } from './PickableInput';
import { formatDefaultInput } from './paramRules';
import {
  addableKeys,
  coerceOverride,
  overrideNote,
  overrideRowProblem,
  takesWholeValue,
  type OverrideResource,
} from './paramOverrides';
import type { ConfigField } from './configForm';
import { LabelledControl } from '../../lib/LabelledControl';

/**
 * #1304 — one bound end's per-dispatch overrides: the singular connection's
 * `connectionParams`, or one dataset end's `datasetParams`.
 *
 * Each row writes straight through to the store as it is typed. The owning panel
 * coalesces a row's burst into one undo step, so there is no Apply button to
 * forget. The rules live in `paramOverrides.ts`, and this component only
 * renders them.
 */
export function ParamOverridesEditor({
  legend,
  noun,
  resource,
  value,
  onChange,
  picker,
  place,
}: {
  legend: string;
  noun: 'connection' | 'dataset';
  /**
   * `null` when the bound id is not among the rows this workspace lists. That
   * covers a deleted row, another owner's row, or an id written as a `${}`. With
   * no allowlist to check against, every row would be falsely flagged
   * "undeclared", so rows show unflagged and nothing can be added.
   */
  resource: OverrideResource | null;
  value: Readonly<Record<string, unknown>> | undefined;
  /** The whole end's next overrides. `coalesceKey` names the row being typed into. */
  onChange: (next: Record<string, unknown> | undefined, coalesceKey?: string) => void;
  picker: FieldPicker | undefined;
  /** Puts one key's value into a node, for the flyout's whole-doc probe. */
  place: (node: Readonly<Node>, key: string, value: unknown) => Node;
}) {
  const current = value ?? {};
  const addable = resource === null ? [] : addableKeys(resource, current);
  const [choice, setChoice] = useState('');
  const picked = addable.includes(choice) ? choice : (addable[0] ?? '');
  const note =
    resource === null
      ? `The bound ${noun} is not one this workspace lists, so its overridable settings cannot be checked here.`
      : overrideNote(resource, current);

  const remove = (key: string) => {
    const rest = { ...current };
    delete rest[key];
    onChange(Object.keys(rest).length > 0 ? rest : undefined);
  };

  const add = () => {
    if (resource === null || picked === '') return;
    // Start from the resource's own value, so a new row changes nothing until
    // it is edited. With no stored value the row starts blank and is flagged.
    const initial = Object.hasOwn(resource.config, picked) ? resource.config[picked] : '';
    onChange({ ...current, [picked]: initial });
  };

  return (
    <fieldset className="param-overrides">
      <legend>{legend}</legend>
      {Object.entries(current).map(([key, stored]) => {
        const field = resource?.fields.find((f) => f.name === key);
        return (
          <OverrideRow
            key={key}
            name={key}
            stored={stored}
            field={field}
            problem={resource === null ? null : overrideRowProblem(resource, key, stored)}
            picker={picker}
            place={place}
            onValue={(next) => onChange({ ...current, [key]: next }, key)}
            onRemove={() => remove(key)}
          />
        );
      })}
      {note !== null && <p className="contract-advisory">{note}</p>}
      {addable.length > 0 && (
        <div className="param-override-add">
          <LabelledControl label={`Add ${noun} override`}>
            {(id) => (
              <select id={id} value={picked} onChange={(e) => setChoice(e.target.value)}>
                {addable.map((key) => (
                  <option key={key} value={key}>
                    {key}
                  </option>
                ))}
              </select>
            )}
          </LabelledControl>
          <button type="button" onClick={add}>
            Add override
          </button>
        </div>
      )}
    </fieldset>
  );
}

/**
 * One override. The input shows a local DRAFT, not the stored value. A number
 * row stores `12.5` for the text `12.50`, and rendering the stored value back
 * would snap the input to `12.5` while the operator is still typing. The draft follows
 * the store only when the store moves on its own (undo, a flyout insert), which
 * is the one case where the two disagree after coercion.
 */
function OverrideRow({
  name,
  stored,
  field,
  problem,
  picker,
  place,
  onValue,
  onRemove,
}: {
  name: string;
  stored: unknown;
  field: ConfigField | undefined;
  problem: string | null;
  picker: FieldPicker | undefined;
  place: (node: Readonly<Node>, key: string, value: unknown) => Node;
  onValue: (next: unknown) => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState(() => formatDefaultInput(stored));
  // Adjusted during render when `stored` changes (React's documented pattern for
  // state derived from a prop), not in an effect, which would first render the
  // stale draft and then cascade a second render.
  const [synced, setSynced] = useState(stored);
  if (synced !== stored) {
    setSynced(stored);
    if (!sameValue(coerceOverride(field, draft), stored)) setDraft(formatDefaultInput(stored));
  }

  const target: PickerTarget = {
    place: (node, text) => place(node, name, coerceOverride(field, text)),
    // The row is written through on every keystroke, so the stored doc always
    // holds this position.
    baseline: 'stored',
    // A number/boolean/JSON setting takes one value: a whole `${}` or a
    // literal. A splice like `5${x}` would be a string, which dispatch refuses.
    ...(takesWholeValue(field) ? { wholeValue: true as const } : {}),
  };

  return (
    <div className="param-override-row">
      <PickableInput
        value={draft}
        onChange={(text) => {
          setDraft(text);
          onValue(coerceOverride(field, text));
        }}
        picker={picker}
        pickerName={name}
        target={target}
      >
        {name}
      </PickableInput>
      <button type="button" onClick={onRemove} aria-label={`Remove override ${name}`}>
        Remove
      </button>
      {/* A sibling of the input's label, not inside it, so the flag does not
          become part of the input's accessible name. */}
      {problem !== null && <p className="contract-advisory">{problem}</p>}
    </div>
  );
}

/** Structural equality for the JSON values an override can hold. */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
