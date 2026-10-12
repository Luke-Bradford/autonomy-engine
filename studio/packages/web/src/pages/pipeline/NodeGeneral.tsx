import { useStore } from 'zustand';
import { DESCRIPTION_MAX_CHARS } from '@autonomy-studio/shared';
import { LabelledControl } from '../../lib/LabelledControl';
import { Section } from '../../lib/Section';
import { AutoGrowTextarea } from '../../lib/form/AutoGrowTextarea';
import { FORM_SECTION_HINTS } from '../../lib/form/sectionHints';
import type { createCanvasStore } from './canvasStore';
import { PolicyEditor } from './PolicyEditor';

/**
 * #1600 OR41 C0b (catalogue spec §3) — an activity's General tab: what the
 * activity is, then how it runs (`PolicyEditor`). Both dock branches, the call
 * node's and every other activity's, render this one component, so the tab
 * cannot differ between them.
 *
 * The description is two lines, as the spec draws it, and writes straight
 * through to the store (no Apply), as the pipeline's description does: a typing
 * burst is one undo step (`setNodeDescription`).
 */
export function NodeGeneral({
  store,
  nodeId,
}: {
  store: ReturnType<typeof createCanvasStore>;
  nodeId: string;
}) {
  const description = useStore(
    store,
    (s) => s.nodes.find((n) => n.id === nodeId)?.description ?? '',
  );
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
      </Section>
      <PolicyEditor store={store} nodeId={nodeId} />
    </>
  );
}
