import { useCallback, useId, useMemo, useState, type RefObject } from 'react';
import {
  CONNECTION_KINDS,
  CONNECTION_KIND_DESCRIPTIONS,
  CONNECTION_KIND_LABELS,
  CONNECTION_SECRET_USE,
  connectionConfigAdvisory,
  connectionKindRequiresSecret,
  DESCRIPTION_MAX_CHARS,
  type ConnectionKind,
  type ConnectionProbeResult,
  type ConnectionDependentsResponse,
  type ConnectionPublic,
  type Dataset,
} from '@autonomy-studio/shared';
import { messageOf } from '../../api/client';
import {
  ConnectionWriteSchema,
  createConnection,
  testDraftConnection,
  testSavedConnection,
  updateConnection,
  type ConnectionWrite,
} from '../../api/connections';
import { kindChangeAdvisory, strandedByKindChange, type StrandCheck } from './strandedDatasets';
import {
  kindChangeDisablesTriggers,
  triggerDisableAdvisory,
  type TriggerCheck,
} from './dependentTriggers';
import { nodeCheckOf, nodeKindAdvisory } from './dependentNodes';
import { configDraftErrors, configKeyLabel, readConfigDraft } from '../pipeline/configForm';
import { ConfigEditor } from '../pipeline/ConfigEditor';
import { useConfigEditor } from '../pipeline/useConfigEditor';
import { LabelledControl } from '../../lib/LabelledControl';
import { FormDrawer } from '../../lib/form/FormDrawer';
import { FormSection } from '../../lib/form/FormSection';
import { AutoGrowTextarea } from '../../lib/form/AutoGrowTextarea';
import { AnnotationRows } from '../../lib/form/AnnotationRows';
import { FORM_SECTION_HINTS } from '../../lib/form/sectionHints';
import { SecretInput } from '../../lib/form/SecretInput';
import { RequiredMark } from '../../lib/form/RequiredMark';
import { FieldError } from '../../lib/form/FieldError';
import { FormErrors } from '../../lib/form/FormErrors';
import { nameCheck, useFieldValidation } from '../../lib/form/fieldValidation';
import { saveRefusal, schemaRefusal } from '../../lib/form/saveErrors';
import { type UnsavedChangesGuard } from '../../lib/form/useDrawerForm';
import { OverridableKeysSection } from '../OverridableKeysField';
import { allowlistChanged, connectionAllowlistSubject } from '../overrideAllowlist';
import { KindSelect } from '../../lib/KindName';
import { CONNECTION_KIND_ICONS } from '../../lib/kindIcons';

import {
  connectionFields,
  metadataChanges,
  metadataChecks,
  type FormState,
} from './connectionFormState';
import { ProbeVerdict } from './ProbeVerdict';

const KINDS = CONNECTION_KINDS;

export function ConnectionForm({
  form,
  stored,
  datasets,
  datasetsUnavailable,
  dependents,
  dependentsUnavailable,
  onChange,
  guard,
  returnFocusTo,
  onClose,
  onSaved,
}: {
  form: FormState;
  stored: ConnectionPublic | undefined;
  datasets: Dataset[] | null;
  datasetsUnavailable: string | null;
  dependents: ConnectionDependentsResponse | null;
  dependentsUnavailable: string | null;
  onChange: (next: FormState) => void;
  guard: UnsavedChangesGuard;
  returnFocusTo: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** Receives the row the server stored: the editor binds a created one. */
  onSaved: (saved: ConnectionPublic) => void | Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /**
   * #1191 — the last probe's verdict, tagged with a SIGNATURE of the draft it
   * was taken against.
   *
   * A probe is a reading from one moment, and the moment expires: type a
   * different host after a green test and "Connected." is no longer about
   * anything on screen. Keeping the signature (rather than clearing on every
   * keystroke through an effect) means the verdict simply stops rendering when
   * the draft moves out from under it — the same reason the result is not
   * persisted and never derived from the stored row.
   */
  const [probe, setProbe] = useState<{
    result: ConnectionProbeResult;
    signature: string;
  } | null>(null);
  const [probing, setProbing] = useState(false);
  const editing = form.id !== null;

  /**
   * #1605 — a secret TYPED into this form belongs to the kind it was typed for.
   * Every kind sends its secret somewhere different (HTTP as a Bearer header to
   * the Base URL), so a PostgreSQL password left in the box across a Kind change
   * would be saved as, and sent by, the new kind. The editor's `onChange` is the
   * only path that moves `kind`, so the clear rides on it; a blank box (keep the
   * stored secret, on edit) has nothing to clear. Remembers the old kind for the
   * note until a secret is typed for the new one.
   */
  const [secretClearedFor, setSecretClearedFor] = useState<ConnectionKind | null>(null);
  const onEditorChange = (next: FormState) => {
    if (next.kind !== form.kind && next.secret !== '') {
      setSecretClearedFor(form.kind);
      onChange({ ...next, secret: '' });
      return;
    }
    onChange(next);
  };
  /**
   * What the Secret box now holds for this kind, when a Kind change made that
   * non-obvious. On edit, a blank box KEEPS the stored secret (the server never
   * clears `secretRef` on a kind change), so a stored PostgreSQL password would
   * become the HTTP connection's secret unless a new one is typed.
   */
  const secretNote = (() => {
    if (form.secret !== '') return null;
    if (secretClearedFor !== null && secretClearedFor !== form.kind) {
      return `Typed secret cleared: it was for ${CONNECTION_KIND_LABELS[secretClearedFor]}`;
    }
    if (stored !== undefined && stored.secretStatus === 'ready' && stored.kind !== form.kind) {
      return `The stored secret was set for ${CONNECTION_KIND_LABELS[stored.kind]} and is kept: type one for ${CONNECTION_KIND_LABELS[form.kind]}`;
    }
    return null;
  })();
  const editor = useConfigEditor({
    form,
    onChange: onEditorChange,
    setError,
    fieldsFor: connectionFields,
  });
  const { fields, jsonMode } = editor;

  /** #1477 — the Description and Annotations Save would send (only what was edited). */
  const metadata = useMemo(
    () =>
      metadataChanges({
        description: form.description,
        descriptionSeed: form.descriptionSeed,
        annotations: form.annotations,
        annotationsSeed: form.annotationsSeed,
      }),
    [form.description, form.descriptionSeed, form.annotations, form.annotationsSeed],
  );
  /**
   * #1396 — what is wrong with the draft now, by field, in the form's order.
   * The Name rule is the write schema's own (`min(1)`, so no trim: the form
   * must not refuse what the server accepts), and the config's are the parse
   * failures `readConfigDraft` would refuse — never the kind's schema rules,
   * which stay the advisory below.
   */
  const checks = useMemo(
    () => ({
      ...nameCheck(form.name),
      ...configDraftErrors(jsonMode, { jsonText: form.jsonText, inputs: form.inputs }, fields),
      // #1477 — the write shape's own refusals, by row.
      ...metadataChecks(metadata),
    }),
    // What the checks read, not `form` whole: a SECRET keystroke re-checks nothing.
    [form.name, form.jsonText, form.inputs, metadata, jsonMode, fields],
  );
  /** What to call a field key in the summary; `undefined` for a key this form does not show. */
  const labelOf = useCallback(
    (key: string) => formFieldLabel(key) ?? configKeyLabel(key, jsonMode, fields),
    [jsonMode, fields],
  );
  const validation = useFieldValidation(checks, labelOf);
  const nameErrorId = useId();
  const descriptionErrorId = useId();
  const annotationErrorId = useId();

  /**
   * Everything a probe's verdict depends on. The same inputs the advisory memo
   * below reads, plus whether a secret was TYPED — because a blank secret box
   * on an edit means "use the stored one", which is a materially different
   * probe from one carrying a new password.
   */
  const draftSignature = useMemo(
    () =>
      JSON.stringify([
        // `form.id` first, and belt-and-braces with the `key` above: were the
        // remount ever removed, an identical draft on a different connection
        // must still not inherit the previous row's verdict.
        form.id,
        form.kind,
        form.config,
        form.jsonText,
        form.inputs,
        form.secret !== '',
      ]),
    [form.id, form.kind, form.config, form.jsonText, form.inputs, form.secret],
  );

  /**
   * What this kind's own schema says about the draft — ADVISORY only.
   *
   * Never a gate: `routes/connections.ts` runs no per-kind validation, so a
   * config the adapter would reject (an `agent_cli` with no `command`, an `fs`
   * with no `roots`) is storable TODAY. Refusing it here would make an existing
   * row unsaveable after an unrelated rename, and the form must never refuse
   * what the server accepts. Saying so before dispatch is the whole point of
   * the ticket; refusing is a different, worse feature.
   */
  const advisory = useMemo(() => {
    // Both drafts, because the Kind select is reachable in EITHER mode. Going
    // silent in JSON mode left one seam open: switch kind with the textarea
    // showing and the JSON genuinely does not change, so a config shaped for
    // the OLD kind saved with nothing on screen to say so — the exact failure
    // this ticket exists to end, through the one path it did not cover.
    // `owned` — the schema-declared subset — so the kind's own `refine` rules see
    // precisely what their author intended. In JSON mode that IS the whole
    // object, because no form was in the way of it.
    const draft = readConfigDraft(jsonMode, form, fields);
    // An unreadable draft says nothing: submit reports the parse error, and a
    // per-field message already names a control that will not read back.
    if (!draft.ok) return null;
    const candidate = draft.owned;
    // The kind's own rules, INCLUDING the ones its shared schema cannot carry:
    // `fs`'s absolute-root check lives in the server adapter (`node:path`), so
    // a schema-only advisory would say nothing about the one path-safety key in
    // the catalog — the exact silent-until-dispatch failure this ticket ends.
    return connectionConfigAdvisory(form.kind, candidate);
    // The three draft fields plus `kind`, not `form` whole: `form` is a new
    // object on every keystroke, so depending on it would re-parse and
    // re-validate the config while the operator types a NAME or a SECRET.
    // Listing exactly what `readConfigDraft` reads keeps that honest — a fourth
    // field added to it must be added here.
  }, [jsonMode, form.config, form.jsonText, form.inputs, form.kind, fields]);

  /**
   * #1174 — what this kind change would strand, and never a claim it strands
   * nothing when the list was not read.
   *
   * `null` on a NEW connection (nothing can name a row that does not exist yet)
   * and on an unchanged kind, which is what keeps the note off the form for the
   * whole of a rename or a config edit.
   */
  const strandAdvisory = useMemo(() => {
    if (form.id === null || stored === undefined || stored.kind === form.kind) return null;
    const check: StrandCheck =
      datasetsUnavailable !== null
        ? { state: 'unavailable', detail: datasetsUnavailable }
        : datasets === null
          ? { state: 'loading' }
          : {
              state: 'known',
              names: strandedByKindChange(datasets, form.id, stored.kind, form.kind).map(
                (dataset) => dataset.name,
              ),
            };
    return kindChangeAdvisory(check, form.kind);
  }, [form.id, form.kind, stored, datasets, datasetsUnavailable]);

  /**
   * #1211 — what this kind change would SWITCH OFF, which is a state change
   * rather than the strand note's future-dispatch diagnostic, and so is drawn
   * whenever the change crosses the readiness boundary the server's reverse
   * gate fires on.
   *
   * Gated on `kindChangeDisablesTriggers` rather than on "the kind moved": a
   * kind change that leaves the connection READY — a repair, a move between two
   * credential-less kinds, or one that supplies the secret in the same edit —
   * disables nothing, and a note there would describe a write that does not
   * happen. The predicate runs the server's own readiness rule; see its
   * docblock for the single documented over-warn.
   */
  const triggerAdvisory = useMemo(() => {
    if (form.id === null || stored === undefined || stored.kind === form.kind) return null;
    if (!kindChangeDisablesTriggers(stored, form.kind, form.secret)) return null;
    const check: TriggerCheck =
      dependentsUnavailable !== null
        ? { state: 'unavailable', detail: dependentsUnavailable }
        : dependents === null
          ? { state: 'loading' }
          : {
              state: 'known',
              names: dependents.triggers.map((trigger) => trigger.name),
              dynamicNames: dependents.dynamic.map((trigger) => trigger.name),
            };
    return triggerDisableAdvisory(check);
  }, [form.id, form.kind, form.secret, stored, dependents, dependentsUnavailable]);

  /**
   * #1252 — the pipeline nodes this kind change breaks. Drawn on ANY kind move,
   * not only a readiness-crossing one: a kind that stays ready disables no
   * trigger, which is exactly when a broken node would otherwise go unsaid.
   */
  const nodeAdvisory = useMemo(() => {
    if (form.id === null || stored === undefined) return null;
    return nodeKindAdvisory(
      nodeCheckOf(dependents, dependentsUnavailable),
      stored.kind,
      form.kind,
      stored.kind !== form.kind && kindChangeDisablesTriggers(stored, form.kind, form.secret),
    );
  }, [form.id, form.kind, form.secret, stored, dependents, dependentsUnavailable]);

  /**
   * #1191 — probe what is ON SCREEN, not what is stored: the same
   * `readConfigDraft` the submit path uses, so "Test" and "Save" can never
   * disagree about which draft is live (the fields or the JSON textarea).
   *
   * An EDIT goes through the saved route so the server can fall back to the
   * stored secret when the input is blank — the whole reason the blank input
   * means "keep". A CREATE has no row to fall back to, so it sends the draft.
   */
  async function onTest() {
    setError(null);
    setProbe(null);

    // Only the config: a test needs no name.
    if (!validation.attempt((key) => key === 'config' || key.startsWith('config.'))) return;
    const draft = readConfigDraft(jsonMode, form, fields);
    if (!draft.ok) {
      setError(draft.message);
      return;
    }

    setProbing(true);
    try {
      const secret = form.secret !== '' ? { secret: form.secret } : {};
      const result =
        editing && form.id
          ? await testSavedConnection(form.id, { config: draft.config, ...secret })
          : await testDraftConnection({ kind: form.kind, config: draft.config, ...secret });
      setProbe({ result, signature: draftSignature });
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setProbing(false);
    }
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    // Read back whichever draft is on screen — never the other one, which is
    // why each mode toggle commits to `config` before switching. An ordinary
    // kind change does not (`changeConfigKind`): it rewrites neither draft, so an
    // operator's JSON is never edited under them. The advisory covers that seam.
    // #1396 — a field that will not read back is shown beside itself first.
    if (!validation.attempt()) return;
    // Past the checks this read cannot fail; it stays for the parsed config and,
    // should a check and its reader ever drift apart, a refusal anyway.
    const draft = readConfigDraft(jsonMode, form, fields);
    if (!draft.ok) {
      setError(draft.message);
      return;
    }
    const config = draft.config;

    // Build the write body; only include `secret` when the user typed one
    // (blank = keep the existing secret on edit, or none on create).
    const body: ConnectionWrite = {
      name: form.name,
      kind: form.kind,
      config,
      // #1477 — each only when edited, as `parameters` below.
      ...metadata,
      ...(form.secret !== '' ? { secret: form.secret } : {}),
      ...(allowlistChanged(form.parametersSeed, form.parameters)
        ? { parameters: form.parameters }
        : {}),
    };

    const parsed = ConnectionWriteSchema.safeParse(body);
    if (!parsed.success) {
      setError(schemaRefusal(parsed.error.issues, validation));
      return;
    }

    setSaving(true);
    try {
      const saved =
        editing && form.id
          ? await updateConnection(form.id, parsed.data)
          : await createConnection(parsed.data);
      await onSaved(saved);
    } catch (err) {
      setError(saveRefusal(err, validation));
      setSaving(false);
    }
  }

  const title = editing ? 'Edit connection' : 'New connection';
  return (
    <FormDrawer
      title={title}
      formLabel="Connection form"
      className="connection-form"
      guard={guard}
      onRequestClose={onClose}
      onSubmit={(e) => void onSubmit(e)}
      busy={saving || probing}
      returnFocusTo={returnFocusTo}
      validation={validation}
      /* In the footer, beside the buttons that produce them: on a long form the
         body's end is off screen, and a Save that failed must not look like a
         Save that did nothing. */
      status={
        <>
          <FormErrors validation={validation} message={error} />

          {probe !== null && probe.signature === draftSignature && (
            <ProbeVerdict result={probe.result} />
          )}
        </>
      }
      actions={
        <>
          <button type="button" onClick={onClose} disabled={saving || probing}>
            Cancel
          </button>
          {/* Never a submit: testing must not save. */}
          <button type="button" onClick={() => void onTest()} disabled={saving || probing}>
            {probing ? 'Testing…' : 'Test connection'}
          </button>
          <button type="submit" className="primary" disabled={saving || probing}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Create connection'}
          </button>
        </>
      }
    >
      <FormSection title="Basics" hint={FORM_SECTION_HINTS.connection.basics}>
        <label>
          <span>
            Name
            <RequiredMark />
          </span>
          <input
            type="text"
            value={form.name}
            onChange={(e) => onChange({ ...form, name: e.target.value })}
            required
            {...validation.attrsFor('name', nameErrorId)}
          />
        </label>
        <FieldError id={nameErrorId} message={validation.errorFor('name')} />

        {/* #1477 — ADF's linked-service order: Name, then Description. */}
        <LabelledControl label="Description">
          {(id) => (
            <AutoGrowTextarea
              id={id}
              maxLength={DESCRIPTION_MAX_CHARS}
              value={form.description}
              onChange={(e) => onChange({ ...form, description: e.target.value })}
              {...validation.attrsFor('description', descriptionErrorId)}
            />
          )}
        </LabelledControl>
        <FieldError id={descriptionErrorId} message={validation.errorFor('description')} />

        <LabelledControl
          label={
            <>
              Kind
              <RequiredMark />
            </>
          }
          hint={CONNECTION_KIND_DESCRIPTIONS[form.kind]}
        >
          {(id, hintId) => (
            <KindSelect icons={CONNECTION_KIND_ICONS} kind={form.kind}>
              <select
                id={id}
                aria-describedby={hintId}
                value={form.kind}
                aria-required
                onChange={(e) => editor.onKindChange(e.target.value as ConnectionKind)}
              >
                {KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {CONNECTION_KIND_LABELS[kind]}
                  </option>
                ))}
              </select>
            </KindSelect>
          )}
        </LabelledControl>

        {/* #1174 — outside the Config group, because it is a fact about OTHER
            resources rather than about this config, and outside the mode branch
            for the same reason the config advisory above is: the Kind select is
            reachable in both modes.

            A bare `.contract-advisory` paragraph with NO `role`. Every sibling
            advisory on this page is one, and the two live-region roles are both
            already claimed here in the singular — `role="status"` by the probe
            verdict (which this form's own e2e asserts the COUNT of) and
            `role="alert"` by the load error. A second of either turns those
            queries into strict-mode violations, and a strand note is not an
            interruption: it appears next to the control that caused it, in
            response to the operator's own gesture. */}
        {strandAdvisory !== null && <p className="contract-advisory">{strandAdvisory}</p>}

        {/* #1211 — a second bare `.contract-advisory`, for the same reasons the
            comment above gives: no `role`, because both live-region roles on this
            form are already claimed in the singular and a strand/disable note is
            not an interruption. Separate from the strand note rather than merged
            into it: one is about OTHER resources breaking later, this one is
            about a write the server performs on save, and the two are drawn on
            different conditions. */}
        {triggerAdvisory !== null && <p className="contract-advisory">{triggerAdvisory}</p>}
        {/* #1252 — its own note: the trigger one describes a write on save, this
            one runs that fail after it, and they are drawn on different
            conditions. */}
        {nodeAdvisory !== null && <p className="contract-advisory">{nodeAdvisory}</p>}
      </FormSection>

      <FormSection title="Connection" hint={FORM_SECTION_HINTS.connection.connection}>
        <ConfigEditor
          editor={editor}
          kindLabel={CONNECTION_KIND_LABELS[editor.kind]}
          className="connection-config"
          rows={8}
          advisory={advisory}
          errorFor={validation.errorFor}
        />
      </FormSection>

      <FormSection title="Authentication" hint={FORM_SECTION_HINTS.connection.authentication}>
        <SecretInput
          label="Secret"
          value={form.secret}
          onChange={(secret) => {
            setSecretClearedFor(null);
            onChange({ ...form, secret });
          }}
          placeholder={editing ? 'leave blank to keep the current secret' : 'optional'}
        />
        {/* #1605 — no `role`, for the reason the advisories above give: this
            form's single `role="status"` is the probe verdict. */}
        {secretNote !== null && <p className="page-hint">{secretNote}</p>}
        {/* Never a `required` input: on edit blank means KEEP the stored secret,
            and on create the server accepts a secretless row (it derives
            `needs_secret` and stores it). This says what the kind DOES with one. */}
        <p className="page-hint">
          {connectionKindRequiresSecret(form.kind)
            ? `Required — ${CONNECTION_KIND_LABELS[form.kind]} connections cannot dispatch without a secret. `
            : ''}
          {CONNECTION_SECRET_USE[form.kind]}
        </p>
      </FormSection>

      <OverridableKeysSection
        subject={connectionAllowlistSubject(form.kind)}
        seed={form.parametersSeed}
        value={form.parameters}
        onChange={(parameters) => onChange({ ...form, parameters })}
      />

      {/* #1477 — last, as in ADF's linked-service form. */}
      <FormSection title="Annotations" hint={FORM_SECTION_HINTS.connection.annotations}>
        <AnnotationRows
          annotations={form.annotations}
          onAdd={() => onChange({ ...form, annotations: [...form.annotations, ''] })}
          onUpdate={(index, text) =>
            onChange({
              ...form,
              annotations: form.annotations.map((old, i) => (i === index ? text : old)),
            })
          }
          onRemove={(index) =>
            onChange({ ...form, annotations: form.annotations.filter((_, i) => i !== index) })
          }
          field={(index) => {
            const key = `annotations.${index}`;
            const id = `${annotationErrorId}-${index}`;
            const message = validation.errorFor(key);
            return {
              attrs: validation.attrsFor(key, id),
              error: message ? <FieldError id={id} message={message} /> : null,
            };
          }}
        />
        <FieldError id={annotationErrorId} message={validation.errorFor('annotations')} />
      </FormSection>
    </FormDrawer>
  );
}

/**
 * The summary's name for a key this form owns outside the config — Name, and
 * (#1477) Description and each Annotation row; `undefined` for any other.
 */
function formFieldLabel(key: string): string | undefined {
  if (key === 'name') return 'Name';
  if (key === 'description') return 'Description';
  if (key === 'annotations') return 'Annotations';
  const row = /^annotations\.(\d+)$/.exec(key);
  return row ? `Annotation ${Number(row[1]) + 1}` : undefined;
}
