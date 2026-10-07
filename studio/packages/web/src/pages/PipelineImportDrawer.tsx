import { useEffect, useState, type RefObject } from 'react';
import { FormDrawer } from '../lib/form/FormDrawer';
import { FormSection } from '../lib/form/FormSection';
import { FORM_SECTION_HINTS } from '../lib/form/sectionHints';
import type { UnsavedChangesGuard } from '../lib/form/useDrawerForm';
import { ImportPanel } from './ImportPanel';
import { DemoPanel } from './DemoPanel';

/**
 * #1569 OR37 — the Pipelines toolbar's "Import", in the shared drawer: an
 * export file, or the bundled demo (#1481), which loads into this list and is
 * removed from it here. Nothing to submit — each section acts on its own — so
 * the footer is Close alone, held while an import, a load or a remove (its
 * question included) is in flight.
 */
export function PipelineImportDrawer({
  guard,
  returnFocusTo,
  onClose,
  onChanged,
  onBusyChange,
}: {
  guard: UnsavedChangesGuard;
  returnFocusTo: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** Reload the list after an import, a demo load or a demo remove. */
  onChanged: () => Promise<void>;
  /** Told when either section's act starts and ends, and `false` when the drawer goes. */
  onBusyChange: (busy: boolean) => void;
}) {
  const [importing, setImporting] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  const busy = importing || demoBusy;
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);
  return (
    <FormDrawer
      title="Import"
      formLabel="Import"
      className="connection-form"
      guard={guard}
      onRequestClose={onClose}
      onSubmit={(e) => e.preventDefault()}
      busy={busy}
      returnFocusTo={returnFocusTo}
      actions={
        <button type="button" onClick={onClose} disabled={busy}>
          Close
        </button>
      }
    >
      {/* Any export envelope, because `POST /api/import` takes any: a
          connection or trigger file is imported and then reported with a
          pointer to its own section (see `ImportPanel`). */}
      <FormSection title="From a file" hint={FORM_SECTION_HINTS.pipeline.importFile}>
        <ImportPanel
          listKind="pipeline"
          embedded
          onImported={onChanged}
          onBusyChange={setImporting}
        />
      </FormSection>
      <FormSection title="Demo workspace" hint={FORM_SECTION_HINTS.pipeline.demo}>
        <DemoPanel embedded onChanged={onChanged} onBusyChange={setDemoBusy} />
      </FormSection>
    </FormDrawer>
  );
}
