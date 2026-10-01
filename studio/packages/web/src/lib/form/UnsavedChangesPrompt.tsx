import { useId, type Ref } from 'react';
import type { UnsavedChangesGuard } from './useUnsavedChangesGuard';

/**
 * #1396 — the one "discard unsaved changes?" prompt. A resource drawer shows it
 * in its footer; the pipeline editor shows it over the canvas. One copy, so the
 * wording and the buttons never drift between the two.
 *
 * The host moves focus to `keepRef` when the prompt opens and handles Escape
 * (as Keep): where focus goes back to afterwards differs between them.
 */
export function UnsavedChangesPrompt({
  guard,
  keepRef,
}: {
  guard: UnsavedChangesGuard;
  keepRef: Ref<HTMLButtonElement>;
}) {
  const id = useId();
  return (
    <div
      className="unsaved-confirm"
      role="alertdialog"
      aria-label="Unsaved changes"
      aria-describedby={id}
    >
      <p id={id}>You have unsaved changes. Discard them?</p>
      <div className="form-actions">
        <button type="button" ref={keepRef} onClick={guard.keep}>
          Keep editing
        </button>
        <button type="button" className="danger" onClick={guard.discard}>
          Discard changes
        </button>
      </div>
    </div>
  );
}
