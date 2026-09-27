import { useStore } from 'zustand';
import { PIPELINE_DESCRIPTION_MAX_CHARS } from '@autonomy-studio/shared';
import type { createCanvasStore } from './canvasStore';
import { ContractSection } from './ContractEditor';

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
 */
export function PipelineGeneral({ store }: { store: Store }) {
  const description = useStore(store, (s) => s.description);
  const annotations = useStore(store, (s) => s.annotations);

  return (
    <>
      <section className="contract-section">
        <h4>General</h4>
        <label>
          Description
          <textarea
            aria-label="pipeline description"
            rows={3}
            maxLength={PIPELINE_DESCRIPTION_MAX_CHARS}
            value={description}
            onChange={(e) => store.getState().setDescription(e.target.value)}
          />
        </label>
      </section>
      <ContractSection
        heading="Annotations"
        hint="Tags that describe this pipeline — an environment, a team, a data domain. Saved with the version, like the rest of the pipeline."
        count={annotations.length}
        addLabel="Add annotation"
        onAdd={() => store.getState().addAnnotation()}
      >
        {annotations.map((text, i) => (
          <div className="contract-row" key={i}>
            <label>
              Annotation
              <input
                aria-label={`annotation ${i + 1}`}
                value={text}
                onChange={(e) => store.getState().updateAnnotation(i, e.target.value)}
              />
            </label>
            <button
              type="button"
              aria-label={`remove annotation ${i + 1}`}
              onClick={() => store.getState().removeAnnotation(i)}
            >
              Remove
            </button>
          </div>
        ))}
      </ContractSection>
    </>
  );
}
