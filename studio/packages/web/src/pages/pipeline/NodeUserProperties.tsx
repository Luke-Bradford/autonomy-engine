import { useStore } from 'zustand';
import { MAX_USER_PROPERTIES, type UserProperty } from '@autonomy-studio/shared';
import { Section } from '../../lib/Section';
import { RemoveRowButton, RowActions, RowList, type RowTableColumn } from '../../lib/form/RowTable';
import type { FieldPicker, PickerTarget } from './ConfigFieldControl';
import type { createCanvasStore } from './canvasStore';
import { PickableInput } from './PickableInput';

const COLUMNS: readonly RowTableColumn[] = [
  { key: 'name', header: 'Name', width: 'short' },
  { key: 'value', header: 'Value', width: 'long' },
];
const NONE: readonly UserProperty[] = [];

/**
 * #1600 OR41 C0d (catalogue spec §3; ADF "user properties") — an activity's user
 * properties: up to `MAX_USER_PROPERTIES` name/value rows, each value a literal
 * or dynamic content (the ƒx picker), resolved when the activity runs and shown
 * as columns in the activity runs grid. Rows write straight through to the store, as the
 * description does. Refusals (an empty or duplicate name) are the save's, shown
 * in the tab's issues, so nothing here trims or de-duplicates what was typed.
 */
export function NodeUserProperties({
  store,
  nodeId,
  picker,
}: {
  store: ReturnType<typeof createCanvasStore>;
  nodeId: string;
  picker: FieldPicker | undefined;
}) {
  const rows = useStore(store, (s) => s.nodes.find((n) => n.id === nodeId)?.userProperties ?? NONE);
  return (
    <UserPropertiesSection
      rows={rows}
      write={(next, coalesceKey) =>
        store.getState().setNodeUserProperties(nodeId, next, coalesceKey)
      }
      pick={
        picker && {
          picker,
          // The row is written through on every keystroke, so the stored doc
          // always holds this position: the picker probes it in place.
          targetFor: (i) => ({
            place: (n, text) => ({
              ...n,
              userProperties: (n.userProperties ?? []).map((r, j) =>
                j === i ? { ...r, value: text } : r,
              ),
            }),
            baseline: 'stored',
          }),
        }
      }
    />
  );
}

/**
 * The User properties section, whoever owns the rows: an activity
 * (`NodeUserProperties`) or a container (#1673, its General tab). `write` gets
 * the whole next list; `coalesceKey` names the cell being typed in, so one
 * burst of typing is one undo step. Without `pick` a value is still a literal
 * or typed `${}`, checked by the save, with no ƒx flyout.
 */
export function UserPropertiesSection({
  rows,
  write,
  pick,
}: {
  rows: readonly UserProperty[];
  write: (next: readonly UserProperty[], coalesceKey?: string) => void;
  pick?: { picker: FieldPicker; targetFor: (row: number) => PickerTarget } | undefined;
}) {
  const update = (i: number, patch: Partial<UserProperty>, cell: 'name' | 'value') =>
    write(
      rows.map((r, j) => (j === i ? { ...r, ...patch } : r)),
      `${i}:${cell}`,
    );
  return (
    <Section heading="User properties" help={null}>
      <RowList
        columns={COLUMNS}
        label="User properties"
        count={rows.length}
        addLabel="Add user property"
        onAdd={() => write([...rows, { name: '', value: '' }])}
        addDisabled={rows.length >= MAX_USER_PROPERTIES}
        addTitle={`Up to ${MAX_USER_PROPERTIES}, shown as columns in the activity runs grid`}
        addDisabledNote={`Limit of ${MAX_USER_PROPERTIES} reached`}
      >
        {rows.map((row, i) => (
          <tr key={i}>
            <td>
              <input
                aria-label={`User property ${i + 1} name`}
                value={row.name}
                onChange={(e) => update(i, { name: e.target.value }, 'name')}
              />
            </td>
            <td>
              <PickableInput
                value={row.value}
                onChange={(text) => update(i, { value: text }, 'value')}
                picker={pick?.picker}
                pickerName={row.name === '' ? `user property ${i + 1}` : row.name}
                target={pick?.targetFor(i)}
              >
                <span className="visually-hidden">{`User property ${i + 1} value`}</span>
              </PickableInput>
            </td>
            <RowActions>
              <RemoveRowButton
                label={`Remove user property ${i + 1}`}
                onRemove={() => write(rows.filter((_, j) => j !== i))}
              />
            </RowActions>
          </tr>
        ))}
      </RowList>
    </Section>
  );
}
