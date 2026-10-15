import { useId, useState } from 'react';
import type { Node } from '@autonomy-studio/shared';
import type { FieldPicker, PickerTarget } from './ConfigFieldControl';
import { PickableInput } from './PickableInput';
import { formatDefaultInput } from './paramRules';
import {
  coerceOverride,
  overrideNote,
  overrideRowKeys,
  overrideRowProblem,
  takesWholeValue,
  type OverrideResource,
} from './paramOverrides';
import { configFieldTitle, type ConfigField } from './configForm';
import {
  RemoveRowButton,
  RowActions,
  RowNotes,
  RowTable,
  type RowTableColumn,
} from '../../lib/form/RowTable';

const COLUMNS: readonly RowTableColumn[] = [
  { key: 'name', header: 'Name', width: 'name' },
  { key: 'value', header: 'Value', width: 'long' },
];

/**
 * #1304 — one bound end's per-dispatch overrides: the singular connection's
 * `connectionParams`, or one dataset end's `datasetParams`.
 *
 * #1694 OR42 item 8 — a name/value table of every setting the resource declares
 * overridable, as ADF lists a dataset's parameters under *Dataset properties*.
 * A blank value is no override: the row's placeholder shows the resource's own
 * value, which the run uses. Typing writes the override; clearing the box
 * removes it. So there is no Add control, and an empty-string override cannot be
 * authored here (one arriving by import still shows, flagged, with its ✕).
 * A stored key the resource does not declare is a row too, flagged, so nothing
 * stored is hidden.
 *
 * Each row writes straight through to the store as it is typed. The owning panel
 * coalesces a row's burst into one undo step, removal included, so there is no
 * Apply button to forget. The rules live in `paramOverrides.ts`, and this
 * component only renders them.
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
   * "undeclared", so only the stored rows show, unflagged.
   */
  resource: OverrideResource | null;
  value: Readonly<Record<string, unknown>> | undefined;
  /** The whole end's next overrides. `coalesceKey` names the row being typed into. */
  onChange: (next: Record<string, unknown> | undefined, coalesceKey?: string) => void;
  picker: FieldPicker | undefined;
  /** Puts one key's value into a node, for the flyout's whole-doc probe. */
  place: (node: Readonly<Node>, key: string, value: unknown) => Node;
}) {
  const legendId = useId();
  const current = value ?? {};
  const keys = overrideRowKeys(resource, current);
  const note =
    resource === null
      ? `The bound ${noun} is not one this workspace lists, so its overridable settings cannot be checked here.`
      : overrideNote(resource);
  // An unparameterised resource has nothing to show, as ADF shows no Dataset
  // properties for one.
  if (keys.length === 0 && note === null) return null;

  const write = (key: string, next: unknown) => {
    const rest = { ...current };
    if (next === undefined) delete rest[key];
    else rest[key] = next;
    onChange(Object.keys(rest).length > 0 ? rest : undefined, key);
  };

  return (
    <fieldset className="param-overrides">
      <legend id={legendId}>{legend}</legend>
      {keys.length > 0 && (
        <RowTable columns={COLUMNS} labelledBy={legendId}>
          {keys.map((key) => {
            const field = resource?.fields.find((f) => f.name === key);
            return (
              <OverrideRow
                key={key}
                name={key}
                stored={current[key]}
                inherited={
                  resource !== null && Object.hasOwn(resource.config, key)
                    ? resource.config[key]
                    : undefined
                }
                field={field}
                problem={
                  resource === null || !Object.hasOwn(current, key)
                    ? null
                    : overrideRowProblem(resource, key, current[key])
                }
                picker={picker}
                place={place}
                onValue={(next) => write(key, next)}
              />
            );
          })}
        </RowTable>
      )}
      {note !== null && <p className="contract-advisory">{note}</p>}
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
  inherited,
  field,
  problem,
  picker,
  place,
  onValue,
}: {
  name: string;
  /** `undefined` while the row holds no override. */
  stored: unknown;
  /** The resource's own value for the key, shown as the placeholder. */
  inherited: unknown;
  field: ConfigField | undefined;
  problem: string | null;
  picker: FieldPicker | undefined;
  place: (node: Readonly<Node>, key: string, value: unknown) => Node;
  /** The row's next stored value; `undefined` removes the override. */
  onValue: (next: unknown) => void;
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

  const label = overrideLabel(field, name);
  const target: PickerTarget = {
    place: (node, text) => place(node, name, coerceOverride(field, text)),
    // The row is written through on every keystroke, so the stored doc holds
    // this position whenever it holds text. An empty row is absent from the
    // doc, which is also the empty cell's baseline.
    baseline: 'stored',
    // No `field`: that names a top-level CONFIG key whose scope differs
    // (a filter's `${item}`), and an override is read in the node's scope.
    // A number/boolean/JSON setting takes one value: a whole `${}` or a
    // literal. A splice like `5${x}` would be a string, which dispatch refuses.
    ...(takesWholeValue(field) ? { wholeValue: true as const } : {}),
  };

  return (
    <>
      <tr>
        <th scope="row" className="param-override-name">
          {label}
        </th>
        <td>
          <PickableInput
            value={draft}
            placeholder={formatDefaultInput(inherited)}
            onChange={(text) => {
              setDraft(text);
              onValue(text === '' ? undefined : coerceOverride(field, text));
            }}
            picker={picker}
            pickerName={name}
            target={target}
          >
            <span className="visually-hidden">{label}</span>
          </PickableInput>
        </td>
        <RowActions>
          {stored !== undefined && (
            <RemoveRowButton
              label={`Remove override ${label}`}
              onRemove={() => {
                setDraft('');
                onValue(undefined);
              }}
            />
          )}
        </RowActions>
      </tr>
      {problem !== null && (
        <RowNotes span={COLUMNS.length + 1}>
          <p className="contract-advisory">{problem}</p>
        </RowNotes>
      )}
    </>
  );
}

/**
 * #1396 — an override names its setting the way the resource's own form does
 * ("Timeout (ms)"), falling back to the key for a setting the resource's kind
 * no longer declares.
 */
function overrideLabel(field: ConfigField | undefined, key: string): string {
  return field === undefined ? key : configFieldTitle(field);
}

/** Structural equality for the JSON values an override can hold. */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
