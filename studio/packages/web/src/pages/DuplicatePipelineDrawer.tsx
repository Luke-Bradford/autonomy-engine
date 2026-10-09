import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from 'react';
import type { Pipeline, PipelineVersion } from '@autonomy-studio/shared';
import { copyName, duplicatePipeline } from '../api/pipelines';
import { LabelledControl } from '../lib/LabelledControl';
import { FormDrawer } from '../lib/form/FormDrawer';
import { Section } from '../lib/Section';
import { FORM_SECTION_HINTS } from '../lib/form/sectionHints';
import { RequiredMark } from '../lib/form/RequiredMark';
import { FieldError } from '../lib/form/FieldError';
import { FormErrors } from '../lib/form/FormErrors';
import { nameCheck, useFieldValidation } from '../lib/form/fieldValidation';
import { saveRefusal } from '../lib/form/saveErrors';
import type { UnsavedChangesGuard } from '../lib/form/useDrawerForm';
import { versionOf, versionOptions, type DuplicatePipelineForm } from './duplicatePipelineForm';
import { usePipelineVersions } from './pipeline/usePipelineVersions';

const FIELD_LABELS: ReadonlyMap<string, string> = new Map([['name', 'Name']]);

/**
 * #1569 OR37 slice 8 — the pipelines grid's ⋯ → Duplicate… and Clone from
 * version…, ONE drawer: a name and the source version, Latest by default.
 *
 * Latest is read when the copy is made (`duplicatePipeline` without `from`), so
 * a save landing while this is open is what gets copied — the "(vN)" beside it
 * is what was latest when the list was read. A chosen version is copied exactly
 * as stored and records `cloned from <name> vN` on the copy, as the version
 * history's Clone does. A chosen version needs the list read; Latest does not.
 */
export function DuplicatePipelineDrawer({
  source,
  form,
  update,
  guard,
  returnFocusTo,
  onClose,
  onCreated,
  onBusyChange,
}: {
  /** The row as the list holds it now: its name, folder and concurrency. */
  source: Pipeline;
  form: DuplicatePipelineForm;
  /** An updater, applied to the form as it is when it lands. */
  update: (fn: (prev: DuplicatePipelineForm) => DuplicatePipelineForm) => void;
  guard: UnsavedChangesGuard;
  returnFocusTo: RefObject<HTMLElement | null>;
  onClose: () => void;
  onCreated: (created: Pipeline) => Promise<void>;
  /** Told when a copy starts and ends, and `false` when the drawer goes. */
  onBusyChange: (busy: boolean) => void;
}) {
  const { from, pickVersion } = form;
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const versionRef = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    onBusyChange(saving);
    return () => onBusyChange(false);
  }, [saving, onBusyChange]);

  // After the drawer's own focus on its first field (a parent's effect runs
  // after its children's), so "Clone from version…" lands on the version.
  useEffect(() => {
    if (pickVersion) versionRef.current?.focus();
    // Mount-only: where this open was asked to start.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { load, retry } = usePipelineVersions(form.pipelineId, (versions) => {
    // A preset the picker does not offer as itself — gone, or the head (which
    // is offered as Latest) — is not a choice anyone made: back to Latest.
    update((prev) =>
      prev.from !== 'latest' && !versions.slice(1).some((v) => v.version === prev.from)
        ? { ...prev, from: 'latest' }
        : prev,
    );
  });

  const name = form.name ?? copyName(source.name, versionOf(from));
  const checks = useMemo(() => nameCheck(name.trim()), [name]);
  const labelOf = useCallback((key: string) => FIELD_LABELS.get(key), []);
  const validation = useFieldValidation(checks, labelOf);
  const nameErrorId = useId();

  const versions = load.status === 'ready' ? load.versions : null;
  const noneSaved = versions !== null && versions.length === 0;
  // A chosen version is copied from the list, so it waits for the list.
  const waiting = from !== 'latest' && load.status === 'loading';
  const shownError =
    error ?? (load.status === 'error' ? `Could not read the versions: ${load.message}` : null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!validation.attempt()) return;
    let chosen: PipelineVersion | undefined;
    if (from !== 'latest') {
      if (waiting) return;
      chosen = versions?.find((v) => v.version === from);
      if (chosen === undefined) {
        // Never Latest in its place: that would copy a version nobody picked.
        setError(`v${String(from)} could not be read. Retry, or pick Latest.`);
        return;
      }
    }
    setSaving(true);
    try {
      await onCreated(await duplicatePipeline(source, name, chosen));
    } catch (err) {
      setError(saveRefusal(err, validation));
    } finally {
      // A no-op once the drawer has closed; it matters when the copy failed.
      setSaving(false);
    }
  }

  const title = pickVersion ? 'Clone from version' : 'Duplicate';
  return (
    <FormDrawer
      title={`${title} — ${source.name}`}
      formLabel={`${title} ${source.name}`}
      className="connection-form"
      guard={guard}
      onRequestClose={onClose}
      onSubmit={(e) => void onSubmit(e)}
      busy={saving}
      returnFocusTo={returnFocusTo}
      validation={validation}
      // One alert for the form: a failed read, until a submit says more.
      status={<FormErrors validation={validation} message={shownError} />}
      actions={
        <>
          <button type="button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={saving || waiting}>
            {saving ? 'Creating…' : pickVersion ? 'Clone' : 'Duplicate'}
          </button>
        </>
      }
    >
      <Section heading="Copy" help={FORM_SECTION_HINTS.pipeline.duplicate}>
        <label>
          <span>
            Name
            <RequiredMark />
          </span>
          <input
            type="text"
            value={name}
            onChange={(e) => {
              const typed = e.target.value;
              update((prev) => ({ ...prev, name: typed }));
            }}
            required
            {...validation.attrsFor('name', nameErrorId)}
          />
        </label>
        <FieldError id={nameErrorId} message={validation.errorFor('name')} />
        <LabelledControl label="Version">
          {(id) => (
            <select
              id={id}
              ref={versionRef}
              className="form-select--fit"
              value={from === 'latest' ? 'latest' : String(from)}
              aria-busy={load.status === 'loading'}
              disabled={saving || noneSaved}
              onChange={(e) => {
                const picked = e.target.value === 'latest' ? 'latest' : Number(e.target.value);
                setError(null);
                update((prev) => ({ ...prev, from: picked }));
              }}
            >
              {versionOptions(load, from).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
        </LabelledControl>
        {load.status === 'error' && (
          <button
            type="button"
            className="form-select--fit"
            onClick={() => {
              // The button goes with the error: focus waits on the picker.
              versionRef.current?.focus();
              setError(null);
              retry();
            }}
          >
            Retry
          </button>
        )}
      </Section>
    </FormDrawer>
  );
}
