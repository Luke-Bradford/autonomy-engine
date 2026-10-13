import { useStore } from 'zustand';
import {
  DESCRIPTION_MAX_CHARS,
  INACTIVE_STATE,
  InactiveMarkAsSchema,
  ContainerSchema,
  NodeSchema,
  fieldLabelOf,
  inactiveMarkAs,
  isInactive,
  userPropertiesApply,
  type InactiveMarkAs,
} from '@autonomy-studio/shared';
import { LabelledControl } from '../../lib/LabelledControl';
import { Section } from '../../lib/Section';
import { AutoGrowTextarea } from '../../lib/form/AutoGrowTextarea';
import { FieldCell, FieldGrid } from '../../lib/form/FieldGrid';
import { FORM_SECTION_HINTS } from '../../lib/form/sectionHints';
import type { FieldPicker } from './ConfigFieldControl';
import type { createCanvasStore } from './canvasStore';
import { NodeUserProperties } from './NodeUserProperties';
import { PolicyEditor } from './PolicyEditor';

/** #1600 C0c — the two fields' label, `?` text and option names, from the schema;
 * C0e — a container's own wording, from `ContainerSchema`. */
const LABELS = {
  node: {
    state: fieldLabelOf(NodeSchema.shape.state)!,
    markAs: fieldLabelOf(NodeSchema.shape.onInactiveMarkAs)!,
    basics: FORM_SECTION_HINTS.node.basics,
  },
  container: {
    state: fieldLabelOf(ContainerSchema.shape.state)!,
    markAs: fieldLabelOf(ContainerSchema.shape.onInactiveMarkAs)!,
    basics: FORM_SECTION_HINTS.node.containerBasics,
  },
};
/** The select's value for "active" — a form value only, never stored (absent `state` is active). */
const ACTIVE = 'active';

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
 * #1600 C0c — Activity state and Mark as (ADF's General tab). Both write
 * straight through too. Mark as stays visible but disabled while the activity
 * is active: the stored value is kept (ADF keeps it), and a kept value the form
 * hid would be config nobody could see.
 *
 * #1600 C0d — User properties, last, on an activity that records them
 * (`userPropertiesApply`): the save refuses them anywhere else. A node of
 * another kind that already holds some (an imported doc) still shows them, so
 * the refusal names config the author can see and remove.
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
  const showUserProperties = useStore(store, (s) => {
    const n = s.nodes.find((x) => x.id === nodeId);
    return n !== undefined && (userPropertiesApply(n) || n.userProperties !== undefined);
  });
  return (
    <>
      <GeneralBasics
        descriptionLabel="Activity description"
        description={description}
        onDescription={(text) => store.getState().setNodeDescription(nodeId, text)}
        inactive={inactive}
        onInactive={(off) => store.getState().setNodeInactive(nodeId, off)}
        markAs={markAs}
        onMarkAs={(v) => store.getState().setNodeMarkAs(nodeId, v)}
      />
      <PolicyEditor store={store} nodeId={nodeId} />
      {showUserProperties && <NodeUserProperties store={store} nodeId={nodeId} picker={picker} />}
    </>
  );
}

/**
 * #1600 OR41 C0e — the General tab's Basics: Description, Activity state and
 * Mark as. Presentational, so an activity (`NodeGeneral`) and a container
 * (`ContainerPanel`) show the same three controls; each owner writes through
 * to its own store action.
 */
export function GeneralBasics({
  owner = 'node',
  descriptionLabel,
  description,
  onDescription,
  inactive,
  onInactive,
  markAs,
  onMarkAs,
}: {
  /** Whose General tab this is: picks the `?` wording (#1600 C0e). */
  owner?: keyof typeof LABELS;
  /** The description field's accessible name (`Activity description`). */
  descriptionLabel: string;
  description: string;
  onDescription: (text: string) => void;
  inactive: boolean;
  onInactive: (inactive: boolean) => void;
  markAs: InactiveMarkAs;
  onMarkAs: (markAs: InactiveMarkAs) => void;
}) {
  const { state: stateLabel, markAs: markAsLabel, basics } = LABELS[owner];
  return (
    <Section heading="Basics" help={basics}>
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
      <FieldGrid className="field-stack">
        <FieldCell span="short">
          <LabelledControl
            label={stateLabel.title}
            about={{ name: stateLabel.title, note: stateLabel.description }}
          >
            {(id, describedBy) => (
              <select
                id={id}
                aria-describedby={describedBy}
                value={inactive ? INACTIVE_STATE : ACTIVE}
                onChange={(e) => onInactive(e.target.value === INACTIVE_STATE)}
              >
                <option value={ACTIVE}>Active</option>
                <option value={INACTIVE_STATE}>Inactive</option>
              </select>
            )}
          </LabelledControl>
        </FieldCell>
        <FieldCell span="short">
          <LabelledControl
            label={markAsLabel.title}
            about={{ name: markAsLabel.title, note: markAsLabel.description }}
          >
            {(id, describedBy) => (
              <select
                id={id}
                aria-describedby={describedBy}
                disabled={!inactive}
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
    </Section>
  );
}
