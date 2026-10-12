import { useStore } from 'zustand';
import {
  DESCRIPTION_MAX_CHARS,
  INACTIVE_STATE,
  InactiveMarkAsSchema,
  NodeSchema,
  fieldLabelOf,
  inactiveMarkAs,
  isInactive,
  userPropertiesApply,
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

/** #1600 C0c — the two fields' label, `?` text and option names, from the schema. */
const STATE_LABEL = fieldLabelOf(NodeSchema.shape.state)!;
const MARK_AS_LABEL = fieldLabelOf(NodeSchema.shape.onInactiveMarkAs)!;
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
      <Section heading="Basics" help={FORM_SECTION_HINTS.node.basics}>
        <LabelledControl label="Description">
          {(id) => (
            <AutoGrowTextarea
              id={id}
              aria-label="Activity description"
              maxRows={2}
              maxLength={DESCRIPTION_MAX_CHARS}
              value={description}
              onChange={(e) => store.getState().setNodeDescription(nodeId, e.target.value)}
            />
          )}
        </LabelledControl>
        <FieldGrid className="field-stack">
          <FieldCell span="short">
            <LabelledControl
              label={STATE_LABEL.title}
              about={{ name: STATE_LABEL.title, note: STATE_LABEL.description }}
            >
              {(id, describedBy) => (
                <select
                  id={id}
                  aria-describedby={describedBy}
                  value={inactive ? INACTIVE_STATE : ACTIVE}
                  onChange={(e) =>
                    store.getState().setNodeInactive(nodeId, e.target.value === INACTIVE_STATE)
                  }
                >
                  <option value={ACTIVE}>Active</option>
                  <option value={INACTIVE_STATE}>Inactive</option>
                </select>
              )}
            </LabelledControl>
          </FieldCell>
          <FieldCell span="short">
            <LabelledControl
              label={MARK_AS_LABEL.title}
              about={{ name: MARK_AS_LABEL.title, note: MARK_AS_LABEL.description }}
            >
              {(id, describedBy) => (
                <select
                  id={id}
                  aria-describedby={describedBy}
                  disabled={!inactive}
                  value={markAs}
                  onChange={(e) =>
                    store
                      .getState()
                      .setNodeMarkAs(nodeId, InactiveMarkAsSchema.parse(e.target.value))
                  }
                >
                  {InactiveMarkAsSchema.options.map((v) => (
                    <option key={v} value={v}>
                      {MARK_AS_LABEL.options?.[v] ?? v}
                    </option>
                  ))}
                </select>
              )}
            </LabelledControl>
          </FieldCell>
        </FieldGrid>
      </Section>
      <PolicyEditor store={store} nodeId={nodeId} />
      {showUserProperties && <NodeUserProperties store={store} nodeId={nodeId} picker={picker} />}
    </>
  );
}
