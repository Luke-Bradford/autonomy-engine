import type { ReactNode } from 'react';
import { useStore } from 'zustand';
import {
  DESCRIPTION_MAX_CHARS,
  InactiveMarkAsSchema,
  ContainerSchema,
  NodeSchema,
  fieldLabelOf,
  inactiveMarkAs,
  isInactive,
  type InactiveMarkAs,
} from '@autonomy-studio/shared';
import { LabelledControl } from '../../lib/LabelledControl';
import { Section } from '../../lib/Section';
import { AutoGrowTextarea } from '../../lib/form/AutoGrowTextarea';
import { FieldCell, FieldGrid } from '../../lib/form/FieldGrid';
import type { FieldPicker } from './ConfigFieldControl';
import { fieldSize, fieldSpan, type FieldSize } from './configForm';
import type { createCanvasStore } from './canvasStore';
import { NodeUserProperties } from './NodeUserProperties';
import { PolicyEditor } from './PolicyEditor';
import { activityModeSelect } from './activityModes';

/** #1600 C0c — Mark as's label and option names, from the schema;
 * C0e — a container's own wording, from `ContainerSchema`. */
const LABELS = {
  node: {
    markAs: fieldLabelOf(NodeSchema.shape.onInactiveMarkAs)!,
  },
  container: {
    markAs: fieldLabelOf(ContainerSchema.shape.onInactiveMarkAs)!,
  },
};

/**
 * #1600 OR41 C0b (catalogue spec §3) — an activity's General tab: what the
 * activity is, then how it runs (`PolicyEditor`). Both dock branches, the call
 * node's and every other activity's, render this one component, so the tab
 * cannot differ between them.
 *
 * The description is two lines, as the spec draws it, and writes straight
 * through to the store (no Apply), as the pipeline's description does: a typing
 * burst is one undo step (`setNodeDescription`).
 *
 * #1600 C0c — Mark as writes straight through too. #1694 OR42 — the activity
 * is switched off and on from the canvas (right-click Deactivate, the dock's
 * `⋯`), not here, so Mark as shows only while it is inactive, the one time it
 * does anything. Re-activating keeps the stored mark (ADF keeps it); the code
 * view shows it, and the next Deactivate resumes it.
 *
 * #1694 OR42 item 8 — a Copy node's *Copy mode* (Rows or Files as-is) leads
 * Basics; #1600 C7b — and a Lookup's *Read as* (Rows or Whole file as text).
 * Each shapes the whole activity (which tabs it has), so it is chosen here
 * rather than on the Source tab.
 *
 * #1600 C0d — User properties, last, on every activity: one the executor
 * dispatches records them on its dispatch, one the engine evaluates and a
 * pipeline call on their own event (#1673).
 */
export function NodeGeneral({
  store,
  nodeId,
  picker,
}: {
  store: ReturnType<typeof createCanvasStore>;
  nodeId: string;
  /** The ƒx picker for user-property values. */
  picker?: FieldPicker;
}) {
  const description = useStore(
    store,
    (s) => s.nodes.find((n) => n.id === nodeId)?.description ?? '',
  );
  const inactive = useStore(store, (s) => {
    const n = s.nodes.find((x) => x.id === nodeId);
    return n !== undefined && isInactive(n);
  });
  const markAs = useStore(store, (s) => {
    const n = s.nodes.find((x) => x.id === nodeId);
    return n === undefined ? 'success' : inactiveMarkAs(n);
  });
  // #1600 OR41 C1a — the one Copy palette item stands for two types; C7b, and
  // the one Lookup item.
  const type = useStore(store, (s) => s.nodes.find((x) => x.id === nodeId)?.type);
  return (
    <>
      <GeneralBasics
        lead={
          type === undefined ? undefined : (
            <ActivityModeField
              type={type}
              onChange={(next) => store.getState().setActivityMode(nodeId, next)}
            />
          )
        }
        descriptionLabel="Activity description"
        description={description}
        onDescription={(text) => store.getState().setNodeDescription(nodeId, text)}
        inactive={inactive}
        markAs={markAs}
        onMarkAs={(v) => store.getState().setNodeMarkAs(nodeId, v)}
      />
      <PolicyEditor store={store} nodeId={nodeId} />
      <NodeUserProperties store={store} nodeId={nodeId} picker={picker} />
    </>
  );
}

/**
 * #1600 OR41 C0e — the General tab's Basics: Description, and Mark as while
 * inactive (#1694 OR42). Presentational, so an activity (`NodeGeneral`) and a
 * container (`ContainerPanel`) show the same controls; each owner writes
 * through to its own store action.
 */
export function GeneralBasics({
  owner = 'node',
  lead,
  descriptionLabel,
  description,
  onDescription,
  inactive,
  markAs,
  onMarkAs,
}: {
  /** Whose General tab this is: picks the `?` wording (#1600 C0e). */
  owner?: keyof typeof LABELS;
  /** An activity-level choice shown before the description (Copy's mode). */
  lead?: ReactNode;
  /** The description field's accessible name (`Activity description`). */
  descriptionLabel: string;
  description: string;
  onDescription: (text: string) => void;
  inactive: boolean;
  markAs: InactiveMarkAs;
  onMarkAs: (markAs: InactiveMarkAs) => void;
}) {
  const { markAs: markAsLabel } = LABELS[owner];
  return (
    <Section heading="Basics" help={null}>
      {lead}
      <LabelledControl label="Description">
        {(id) => (
          <AutoGrowTextarea
            id={id}
            aria-label={descriptionLabel}
            maxRows={2}
            maxLength={DESCRIPTION_MAX_CHARS}
            value={description}
            onChange={(e) => onDescription(e.target.value)}
          />
        )}
      </LabelledControl>
      {inactive && (
        <FieldGrid className="field-stack">
          <FieldCell span="short">
            <LabelledControl
              label={markAsLabel.title}
              about={{ name: markAsLabel.title, note: markAsLabel.description }}
            >
              {(id, describedBy) => (
                <select
                  id={id}
                  data-size={'s' satisfies FieldSize}
                  aria-describedby={describedBy}
                  value={markAs}
                  onChange={(e) => onMarkAs(InactiveMarkAsSchema.parse(e.target.value))}
                >
                  {InactiveMarkAsSchema.options.map((v) => (
                    <option key={v} value={v}>
                      {markAsLabel.options?.[v] ?? v}
                    </option>
                  ))}
                </select>
              )}
            </LabelledControl>
          </FieldCell>
        </FieldGrid>
      )}
    </Section>
  );
}

/**
 * #1600 OR41 C1a — Copy's *Copy mode*: Rows (`copy`) or Files as-is
 * (`copy_files`); C7b — Lookup's *Read as*: Rows (`lookup`) or Whole file as
 * text (`file_read`). Nothing for a type with one mode. Switching swaps the
 * node's type and starts the other mode's settings fresh (`setActivityMode`);
 * Undo brings them back.
 */
function ActivityModeField({ type, onChange }: { type: string; onChange: (next: string) => void }) {
  const select = activityModeSelect(type);
  if (select === undefined) return null;
  // Sized by its option names, as a catalog enum is (UI standard rule 5).
  const asEnum = {
    kind: 'enum',
    enumOptions: select.types,
    label: { title: select.label, options: select.options },
  } as const;
  return (
    <FieldGrid className="field-stack">
      <FieldCell span={fieldSpan(asEnum)}>
        <LabelledControl label={select.label} about={{ name: select.label, note: select.note }}>
          {(id, describedBy) => (
            <select
              id={id}
              data-size={fieldSize(asEnum)}
              aria-describedby={describedBy}
              value={type}
              onChange={(e) => onChange(e.target.value)}
            >
              {select.types.map((t) => (
                <option key={t} value={t}>
                  {select.options[t]}
                </option>
              ))}
            </select>
          )}
        </LabelledControl>
      </FieldCell>
    </FieldGrid>
  );
}
