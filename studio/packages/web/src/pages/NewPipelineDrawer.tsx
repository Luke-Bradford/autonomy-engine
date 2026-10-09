import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type FormEvent,
  type RefObject,
} from 'react';
import {
  PIPELINE_DESCRIPTION_MAX_CHARS,
  PipelineFolderSchema,
  type Pipeline,
} from '@autonomy-studio/shared';
import { newPipeline } from '../api/pipelines';
import { LabelledControl } from '../lib/LabelledControl';
import { AutoGrowTextarea } from '../lib/form/AutoGrowTextarea';
import { FormDrawer } from '../lib/form/FormDrawer';
import { Section } from '../lib/Section';
import { FORM_SECTION_HINTS } from '../lib/form/sectionHints';
import { RequiredMark } from '../lib/form/RequiredMark';
import { FieldError } from '../lib/form/FieldError';
import { FormErrors } from '../lib/form/FormErrors';
import { nameCheck, useFieldValidation, type FieldErrors } from '../lib/form/fieldValidation';
import { saveRefusal } from '../lib/form/saveErrors';
import type { UnsavedChangesGuard } from '../lib/form/useDrawerForm';
import { existingFolderSpelling } from './author/pipelineFolders';

/** The open New pipeline form, as typed. */
export interface NewPipelineForm {
  kind: 'new';
  name: string;
  folder: string;
  description: string;
}

const FIELD_LABELS: ReadonlyMap<string, string> = new Map([
  ['name', 'Name'],
  ['folder', 'Folder'],
]);

/**
 * Both are checked TRIMMED, as they are sent. A name of spaces is no name, and
 * the folder rule refuses an edge space the operator never meant to type. That
 * departs from `nameCheck`'s own no-trim rule on purpose: the card this replaced
 * and the pane's create both trimmed. The folder is checked here, beside its
 * field, because `createPipeline` parses its body in the browser and would
 * otherwise throw the same refusal as a bare schema error.
 */
function newPipelineChecks(form: NewPipelineForm): FieldErrors {
  const out: Record<string, string> = { ...nameCheck(form.name.trim()) };
  const folder = form.folder.trim();
  if (folder !== '') {
    const checked = PipelineFolderSchema.safeParse(folder);
    if (!checked.success) out.folder = checked.error.issues[0]?.message ?? 'Not a folder name.';
  }
  return out;
}

/**
 * #1569 OR37 — the Pipelines toolbar's "New pipeline", in the shared drawer:
 * name, folder and description. A description lives on the pipeline's VERSION,
 * so one typed here is written as an empty first version (`newPipeline`).
 */
export function NewPipelineDrawer({
  form,
  onChange,
  folderNames,
  guard,
  returnFocusTo,
  onClose,
  onCreated,
  onBusyChange,
}: {
  form: NewPipelineForm;
  onChange: (next: NewPipelineForm) => void;
  /** The live list's folders, offered to pick from. */
  folderNames: readonly string[];
  guard: UnsavedChangesGuard;
  returnFocusTo: RefObject<HTMLElement | null>;
  onClose: () => void;
  onCreated: (created: Pipeline) => Promise<void>;
  /** Told when a create starts and ends, and `false` when the drawer goes. */
  onBusyChange: (busy: boolean) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    onBusyChange(saving);
    return () => onBusyChange(false);
  }, [saving, onBusyChange]);
  const checks = useMemo(() => newPipelineChecks(form), [form]);
  const labelOf = useCallback((key: string) => FIELD_LABELS.get(key), []);
  const validation = useFieldValidation(checks, labelOf);
  const errorIds = { name: useId(), folder: useId() };
  const suggestions = useId();

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!validation.attempt()) return;
    const folder = form.folder.trim();
    setSaving(true);
    try {
      const created = await newPipeline(
        {
          name: form.name.trim(),
          folder: folder === '' ? null : existingFolderSpelling(folderNames, folder),
        },
        form.description,
      );
      await onCreated(created);
    } catch (err) {
      setError(saveRefusal(err, validation));
    } finally {
      // A no-op once the drawer has closed; it matters when the create failed.
      setSaving(false);
    }
  }

  return (
    <FormDrawer
      title="New pipeline"
      formLabel="New pipeline"
      className="connection-form"
      guard={guard}
      onRequestClose={onClose}
      onSubmit={(e) => void onSubmit(e)}
      busy={saving}
      returnFocusTo={returnFocusTo}
      validation={validation}
      status={<FormErrors validation={validation} message={error} />}
      actions={
        <>
          <button type="button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={saving}>
            {saving ? 'Creating…' : 'Create pipeline'}
          </button>
        </>
      }
    >
      <Section heading="Basics" help={FORM_SECTION_HINTS.pipeline.basics}>
        <LabelledControl
          label={
            <>
              Name
              <RequiredMark />
            </>
          }
        >
          {(id) => (
            <input
              id={id}
              type="text"
              value={form.name}
              onChange={(e) => onChange({ ...form, name: e.target.value })}
              placeholder="My pipeline"
              required
              {...validation.attrsFor('name', errorIds.name)}
            />
          )}
        </LabelledControl>
        <FieldError id={errorIds.name} message={validation.errorFor('name')} />
        <LabelledControl
          label={
            <>
              Folder
              {/* Picking an existing folder beats retyping it; a different case of
              one is filed under it anyway (`existingFolderSpelling`). */}
            </>
          }
        >
          {(id) => (
            <input
              id={id}
              type="text"
              list={suggestions}
              value={form.folder}
              onChange={(e) => onChange({ ...form, folder: e.target.value })}
              placeholder="None"
              {...validation.attrsFor('folder', errorIds.folder)}
            />
          )}
        </LabelledControl>
        <datalist id={suggestions}>
          {folderNames.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        <FieldError id={errorIds.folder} message={validation.errorFor('folder')} />
        <LabelledControl label="Description">
          {(id) => (
            <AutoGrowTextarea
              id={id}
              maxLength={PIPELINE_DESCRIPTION_MAX_CHARS}
              value={form.description}
              onChange={(e) => onChange({ ...form, description: e.target.value })}
              placeholder="None"
            />
          )}
        </LabelledControl>
      </Section>
    </FormDrawer>
  );
}
