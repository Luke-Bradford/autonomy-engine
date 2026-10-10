import { useStore } from 'zustand';
import { PIPELINE_DESCRIPTION_MAX_CHARS } from '@autonomy-studio/shared';
import { LabelledControl } from '../../lib/LabelledControl';
import type { createCanvasStore } from './canvasStore';
import { FORM_SECTION_HINTS } from '../../lib/form/sectionHints';
import { Section } from '../../lib/Section';
import { AutoGrowTextarea } from '../../lib/form/AutoGrowTextarea';
import { AnnotationRows } from '../../lib/form/AnnotationRows';

type Store = ReturnType<typeof createCanvasStore>;

/**
 * #1 F8a — the pipeline-level General tab: what the pipeline is for, and the
 * annotations (tags) it carries. Both live on the immutable version, so they are
 * saved with the canvas like everything else in the dock.
 *
 * Every control writes straight through to the store, as the contract rows do:
 * a draft held here would go stale under an undo or a version load and then
 * overwrite it on the next blur. Annotations are one text box per row (ADF's own
 * editor) rather than one textarea split on newlines, so an annotation is never
 * re-cut by the editor. Their refusals are save-gating issues (`propertyIssues`),
 * not rewrites: nothing here trims or de-duplicates what was typed.
 *
 * #1569 OR37 — the description is one line that grows to four and then
 * scrolls, inside the dock's own scroll, so typing never moves the canvas.
 */
export function PipelineGeneral({ store }: { store: Store }) {
  const description = useStore(store, (s) => s.description);
  const annotations = useStore(store, (s) => s.annotations);

  return (
    <>
      <Section heading="General" help={FORM_SECTION_HINTS.pipeline.general}>
        <LabelledControl label="Description">
          {(id) => (
            <AutoGrowTextarea
              id={id}
              aria-label="Pipeline description"
              maxLength={PIPELINE_DESCRIPTION_MAX_CHARS}
              value={description}
              onChange={(e) => store.getState().setDescription(e.target.value)}
            />
          )}
        </LabelledControl>
      </Section>
      <Section heading="Annotations" help={FORM_SECTION_HINTS.pipeline.annotations}>
        <AnnotationRows
          annotations={annotations}
          onAdd={() => store.getState().addAnnotation()}
          onUpdate={(i, text) => store.getState().updateAnnotation(i, text)}
          onRemove={(i) => store.getState().removeAnnotation(i)}
        />
      </Section>
    </>
  );
}
