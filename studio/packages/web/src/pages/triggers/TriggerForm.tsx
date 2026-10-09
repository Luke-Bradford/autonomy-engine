import { useCallback, useId, useMemo, useState } from 'react';
import {
  CONCURRENCY_POLICY_LABELS,
  TRIGGER_MODE_DESCRIPTIONS,
  TRIGGER_MODE_LABELS,
  type ConcurrencyPolicy,
  type EventConfig,
  type Recurrence,
  type TriggerMode,
  type WindowConfig,
} from '@autonomy-studio/shared';
import { Link } from 'react-router';
import { RecurrenceEditor } from './RecurrenceEditor';
import { WindowEditor } from './WindowEditor';
import { RunWindowsEditor } from './RunWindowsEditor';
import { formToEvent } from './eventForm';
import { formToWindow } from './windowForm';
import { formToRunWindows } from './runWindowsForm';
import { formToRecurrence, type ScheduleKind } from './recurrenceForm';

import { pipelinePath } from '../author/pipelinePath';
import { usePolledResource } from '../../hooks/usePolledResource';
import { readPublishState } from '../pipeline/publishState';
import { activeVersionLabel } from '../pipeline/versionHistory';
import {
  activeBindingAdvice,
  bindingCreateFields,
  bindingPatchField,
  type PublishReading,
} from './binding';
import {
  createTrigger,
  updateTrigger,
  TriggerCreateSchema,
  TriggerWriteSchema,
  type TriggerCreateWrite,
  type TriggerWrite,
} from '../../api/triggers';
import { LabelledControl } from '../../lib/LabelledControl';
import { FormDrawer } from '../../lib/form/FormDrawer';
import { FormSection } from '../../lib/form/FormSection';
import { FORM_SECTION_HINTS } from '../../lib/form/sectionHints';
import { RequiredMark } from '../../lib/form/RequiredMark';
import { FieldError } from '../../lib/form/FieldError';
import { JsonEditor } from '../../lib/form/JsonEditor';
import { FormErrors } from '../../lib/form/FormErrors';
import { useFieldValidation } from '../../lib/form/fieldValidation';
import { saveRefusal, schemaRefusal } from '../../lib/form/saveErrors';
import { type UnsavedChangesGuard } from '../../lib/form/useDrawerForm';
import { KindSelect } from '../../lib/KindName';
import { TRIGGER_MODE_ICONS } from '../../lib/kindIcons';

import {
  MODES,
  POLICIES,
  type BindingOption,
  type PipelineOption,
  type FormState,
  withMode,
  parseParamsText,
  bindingKey,
  modeFields,
  triggerChecks,
} from './triggerFormState';

export function TriggerForm({
  form,
  bindings,
  pipelines,
  onChange,
  guard,
  returnFocusTo,
  onClose,
  onSaved,
}: {
  form: FormState;
  bindings: BindingOption[];
  pipelines: PipelineOption[];
  onChange: (next: FormState) => void;
  guard: UnsavedChangesGuard;
  returnFocusTo: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const bindingKindId = useId();
  const editing = form.id !== null;

  const checks = useMemo(() => triggerChecks(form), [form]);
  const labelOf = useCallback(
    (key: string): string | undefined => {
      switch (key) {
        case 'name':
          return 'Name';
        case 'pipelineVersionId':
          return form.binding.kind === 'active' ? undefined : 'Pipeline version';
        case 'bindToActive.pipelineId':
          return form.binding.kind === 'active' ? 'Pipeline' : undefined;
        case 'concurrency.max':
          return form.concurrencyPolicy === 'parallel' ? 'Max parallel runs' : undefined;
        case 'params':
          return 'Params (JSON)';
        default: {
          const fields = modeFields(form);
          return Object.hasOwn(fields, key) ? fields[key] : undefined;
        }
      }
    },
    [form],
  );
  const validation = useFieldValidation(checks, labelOf);
  const nameErrorId = useId();
  const bindingErrorId = useId();
  const maxErrorId = useId();
  const paramsErrorId = useId();
  const eventErrorId = useId();
  /* The version last chosen on the concrete side, so switching to bind-to-active
     and back does not silently discard it. Local to the form: it is undo state
     for a control, not part of what gets written. */
  const [lastConcrete, setLastConcrete] = useState<string | null>(
    form.binding.kind === 'concrete' ? form.binding.pipelineVersionId : null,
  );

  /*
   * #981 — the publish pair for the pipeline currently selected for
   * bind-to-active, read LAZILY: one `/active` + `/workspace/git` pair when a
   * pipeline is chosen, rather than one per pipeline up front (the N+1 shape
   * `listAllPipelineVersions` already documents on this page's other load).
   *
   * `usePolledResource` with no interval is a one-shot fetch that re-runs when
   * the memoized fetcher's identity changes and applies results latest-wins, so
   * switching pipelines mid-flight cannot land the old answer on the new choice.
   * The fetcher returns the pipelineId it read FOR, because `loading` is true
   * only on the FIRST load — on every switch after that it stays false while
   * `data` still holds the previous pipeline's reading, and a stale reading
   * shown against a different pipeline is exactly the wrong claim.
   *
   * A FAILED read is returned as a tagged `state: null` rather than left to
   * reject into `publish.error`, so that it carries the same pipeline tag every
   * other reading does. `usePolledResource` never clears `error` when a new
   * fetch starts, so an untagged error survives a pipeline switch and would say
   * "could not check" about a pipeline whose read has not even returned — the
   * identical staleness the `data` tag exists to prevent, one field over. An
   * ABORT is rethrown: that is this effect tearing down, not a failure to
   * report.
   */
  const activePipelineId = form.binding.kind === 'active' ? form.binding.pipelineId : null;
  const fetchPublishState = useCallback(
    async (signal: AbortSignal) => {
      if (activePipelineId === null) return null;
      try {
        return {
          pipelineId: activePipelineId,
          state: await readPublishState(activePipelineId, signal),
        };
      } catch (err) {
        if (signal.aborted) throw err;
        return { pipelineId: activePipelineId, state: null };
      }
    },
    [activePipelineId],
  );
  const publish = usePolledResource(fetchPublishState);

  // ONE authority: the tagged reading. `publish.error` is deliberately unread —
  // a failed read is already represented above, tagged with its pipeline.
  let reading: PublishReading = 'loading';
  if (publish.data !== null && publish.data.pipelineId === activePipelineId) {
    reading = publish.data.state ?? 'unread';
  }

  const activePipeline =
    activePipelineId === null
      ? null
      : (pipelines.find((p) => p.pipelineId === activePipelineId) ?? null);
  const advice =
    activePipeline === null
      ? null
      : activeBindingAdvice({
          pipelineName: activePipeline.name,
          reading,
          activeVersion: activeVersionLabel(
            reading === 'loading' || reading === 'unread' ? undefined : reading.active,
            activePipeline.versions,
          ),
        });

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    // #1396 — every field that is wrong now, the mode editors' included
    // (`modeChecks`), is shown beside itself first. The conversions below still
    // refuse in the footer, for what no control owns. (A half-typed date or
    // number, which reads as blank, never reaches here: `FormDrawer` refuses it,
    // so the converters below cannot drop it.)
    if (!validation.attempt()) return;

    const parsedParams = parseParamsText(form.paramsText);
    if (!parsedParams.ok) {
      validation.showRefusedFields({ params: parsedParams.message });
      return;
    }
    const params = parsedParams.params;

    // #1090 U14c — run windows convert UNCONDITIONALLY, unlike the three
    // mode-owned configs below: a window is not owned by a mode, so a mode
    // switch must neither clear it nor skip validating it. Sent on every save
    // for the usual PATCH reason — an omitted key means "untouched".
    const convertedWindows = formToRunWindows(form.runWindows);
    if (!convertedWindows.ok) {
      setError(`Invalid run windows — ${convertedWindows.reason}`);
      return;
    }
    const runWindows = convertedWindows.runWindows;

    // #439 U14b — the schedule half. A recurrence and a raw cron are mutually
    // exclusive at the write boundary (`assertRecurrenceConsistent`), and the
    // unselected side must be sent as an EXPLICIT null: on a PATCH an omitted
    // `recurrence` means "untouched", so a trigger switched from recurrence to
    // cron would otherwise keep its old recurrence and be refused. Both are
    // nulled outside schedule mode, so switching mode never leaves either
    // behind.
    let recurrence: Recurrence | null = null;
    let schedule: string | null = null;
    if (form.mode === 'schedule') {
      if (form.scheduleKind === 'recurrence') {
        const converted = formToRecurrence(form.recurrence);
        if (!converted.ok) {
          setError(`Invalid recurrence — ${converted.reason}`);
          return;
        }
        recurrence = converted.recurrence;
      } else {
        schedule = form.schedule.trim() === '' ? null : form.schedule.trim();
      }
    }

    // #854 — the event and tumbling halves, built exactly like the schedule one
    // above: declared null and assigned only inside their own mode branch, so a
    // mode switch clears what the trigger left behind BY CONSTRUCTION. Both are
    // then sent unconditionally, because on a PATCH an omitted key means
    // "untouched" — a stale `event`/`window` under a mode that does not match is
    // refused by `assertEventConsistent`/`assertWindowConsistent`, which is the
    // 400 that made these modes uneditable once configured.
    let eventConfig: EventConfig | null = null;
    let windowConfig: WindowConfig | null = null;
    if (form.mode === 'event') {
      const converted = formToEvent(form.event);
      if (!converted.ok) {
        setError(`Invalid event subscription — ${converted.reason}`);
        return;
      }
      eventConfig = converted.event;
    } else if (form.mode === 'tumbling') {
      const converted = formToWindow(form.window);
      if (!converted.ok) {
        setError(`Invalid tumbling window — ${converted.reason}`);
        return;
      }
      windowConfig = converted.window;
    }

    // The server's `assertBindableIfEnabled` is mirrored by `triggerChecks`,
    // beside the binding select, and so is already refused above.

    // #981 — the publish precondition, stated where it can still be acted on.
    // Only ever set when the reading SUCCEEDED and said there is nothing to bind
    // to; an unread pair never refuses, because the gate is the server's and
    // refusing on a failed read would block a create it would have accepted.
    if (advice?.refusal != null) {
      setError(advice.refusal);
      return;
    }

    // Mirror `assertEventConsistent` / `assertWindowConsistent` for a friendlier
    // message. `modeChecks` raises both beside their field first; these stay as
    // the backstop. Both are ENABLED-conditional on the server, and so are these: a
    // disabled trigger may legally store NO subscription and NO window at all.
    // That is narrower than "anything goes while disabled" — a form left partly
    // filled is still refused above, by the conversion, in either state, because
    // discarding half-typed config would be the silent loss this module exists
    // to prevent.
    if (form.enabled && form.mode === 'event' && eventConfig === null) {
      setError('An enabled event trigger must carry an event name (or disable it).');
      return;
    }
    if (form.enabled && form.mode === 'tumbling' && windowConfig === null) {
      setError(
        'An enabled tumbling trigger must carry a window — give it a start time (or disable it).',
      );
      return;
    }

    // Concurrency cross-field rule lives in the shared `ConcurrencyWriteSchema`:
    // `parallel` requires a positive `max`; the single-slot policies forbid it.
    const concurrency =
      form.concurrencyPolicy === 'parallel'
        ? { policy: 'parallel' as const, max: Number(form.concurrencyMax) }
        : { policy: form.concurrencyPolicy };

    const common = {
      name: form.name,
      params,
      mode: form.mode,
      schedule,
      recurrence,
      event: eventConfig,
      window: windowConfig,
      webhook: null,
      concurrency,
      runWindows,
      enabled: form.enabled,
    };

    /*
     * #981 — CREATE and PATCH are different bodies validated by different
     * schemas, and the split is deliberate rather than incidental. A create may
     * carry `bindToActive`; a PATCH is concrete-only, so that a patch can never
     * silently re-resolve a pinned binding (`TriggerCreateBodySchema`). Both
     * schemas are the SAME objects the route parses, so neither can drift.
     */
    if (editing && form.id) {
      // Bind-to-active is never OFFERED while editing, so this refusal is
      // unreachable today — it exists so that the day it becomes reachable is a
      // visible refusal rather than a silent unbind. See `bindingPatchField`.
      const patchBinding = bindingPatchField(form.binding);
      if (!patchBinding.ok) {
        setError(patchBinding.reason);
        return;
      }
      const patchBody: TriggerWrite = {
        ...common,
        pipelineVersionId: patchBinding.pipelineVersionId,
      };
      const parsed = TriggerWriteSchema.safeParse(patchBody);
      if (!parsed.success) {
        setError(schemaRefusal(parsed.error.issues, validation));
        return;
      }
      setSaving(true);
      try {
        if (form.mode === 'webhook') {
          // Editing a trigger that stays a webhook: OMIT `webhook` so an
          // already-provisioned secret is preserved (PATCH is partial; sending
          // `webhook:null` would clear it, and this form has no secret to
          // re-send — it is provisioned out-of-band via "Provision webhook secret").
          const { webhook: _webhook, ...patch } = parsed.data;
          void _webhook;
          await updateTrigger(form.id, patch);
        } else {
          // Switching AWAY from webhook mode: send `webhook:null` (already set
          // in the body) to actively clear any previously-provisioned secret,
          // so a stale secret can't persist on a non-webhook trigger or be
          // silently resurrected if the mode is later switched back.
          await updateTrigger(form.id, parsed.data);
        }
        await onSaved();
      } catch (err) {
        setError(saveRefusal(err, validation));
        setSaving(false);
      }
      return;
    }

    const createBody: TriggerCreateWrite = { ...common, ...bindingCreateFields(form.binding) };
    const parsedCreate = TriggerCreateSchema.safeParse(createBody);
    if (!parsedCreate.success) {
      setError(schemaRefusal(parsedCreate.error.issues, validation));
      return;
    }
    setSaving(true);
    try {
      await createTrigger(parsedCreate.data);
      await onSaved();
    } catch (err) {
      setError(saveRefusal(err, validation));
      setSaving(false);
    }
  }

  return (
    <FormDrawer
      title={editing ? 'Edit trigger' : 'New trigger'}
      formLabel="Trigger form"
      className="trigger-form"
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
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Create trigger'}
          </button>
        </>
      }
    >
      <FormSection title="Basics" hint={FORM_SECTION_HINTS.trigger.basics}>
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

        <label>
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => onChange({ ...form, enabled: e.target.checked })}
          />
          Enabled (fires on its schedule, event, window or webhook)
        </label>
      </FormSection>

      <FormSection title="Pipeline" hint={FORM_SECTION_HINTS.trigger.pipeline}>
        {/* #981 — the binding, in the two shapes the CREATE endpoint accepts. The
          choice is a radio pair rather than a third sentinel option inside the
          version select, because the two branches pick different KINDS of thing
          (a version vs a pipeline) and the create body differs structurally.
          Editing shows only the version select: PATCH is concrete-only, so
          bind-to-active has nothing to mean on an existing trigger — it was
          resolved once, at creation, and the stored row is a concrete id. */}
        {!editing && (
          <fieldset className="binding-kind">
            <legend>Binding</legend>
            <label>
              <input
                type="radio"
                name={bindingKindId}
                checked={form.binding.kind !== 'active'}
                // Switching back RESTORES the version that was picked before,
                // rather than dropping to unbound. Toggling a radio to look at
                // the other option is not an instruction to discard the choice
                // already made, and the version select is long enough that
                // re-finding an entry is real work.
                onChange={() =>
                  onChange({
                    ...form,
                    binding:
                      lastConcrete === null
                        ? { kind: 'unbound' }
                        : { kind: 'concrete', pipelineVersionId: lastConcrete },
                  })
                }
              />
              A specific version
            </label>
            <label>
              <input
                type="radio"
                name={bindingKindId}
                checked={form.binding.kind === 'active'}
                disabled={pipelines.length === 0}
                onChange={() =>
                  onChange({
                    ...form,
                    binding: { kind: 'active', pipelineId: pipelines[0]?.pipelineId ?? '' },
                  })
                }
              />
              The active published version
            </label>
          </fieldset>
        )}

        {form.binding.kind === 'active' ? (
          <LabelledControl label="Pipeline">
            {(id) => (
              <select
                id={id}
                // Re-narrowed: the render-prop is a closure, which the ternary's
                // narrowing of `form.binding` does not reach.
                value={form.binding.kind === 'active' ? form.binding.pipelineId : ''}
                onChange={(e) =>
                  onChange({ ...form, binding: { kind: 'active', pipelineId: e.target.value } })
                }
                {...validation.attrsFor('bindToActive.pipelineId', bindingErrorId)}
              >
                {pipelines.map((p) => (
                  <option key={p.pipelineId} value={p.pipelineId}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
          </LabelledControl>
        ) : (
          <LabelledControl label="Pipeline version">
            {(id) => (
              <select
                id={id}
                value={form.binding.kind === 'concrete' ? form.binding.pipelineVersionId : ''}
                onChange={(e) => {
                  setLastConcrete(e.target.value === '' ? null : e.target.value);
                  onChange({
                    ...form,
                    binding:
                      e.target.value === ''
                        ? { kind: 'unbound' }
                        : { kind: 'concrete', pipelineVersionId: e.target.value },
                  });
                }}
                {...validation.attrsFor('pipelineVersionId', bindingErrorId)}
              >
                <option value="">— unbound —</option>
                {bindings.map((b) => (
                  <option key={b.value} value={b.value}>
                    {b.label}
                  </option>
                ))}
              </select>
            )}
          </LabelledControl>
        )}
        <FieldError id={bindingErrorId} message={validation.errorFor(bindingKey(form))} />

        {advice && activePipeline && (
          <p className="page-hint" role="status">
            {advice.text}
            {/* The way OUT is offered only by the state that needs one. Rendered
              unconditionally it told a DB-only workspace to publish — which this
              app's own gate refuses without a connected repo — and told anyone
              mid-read to act on a reading that had not arrived. `refusal` is the
              honest discriminator: it is non-null exactly when the read SUCCEEDED
              and said there is nothing to bind to. */}
            {advice.refusal !== null && (
              <>
                {' '}
                <Link to={pipelinePath(activePipeline.pipelineId)}>
                  Open {activePipeline.name}
                </Link>{' '}
                {/* There is no route to the version-history panel — it is a toggle
                  on the canvas — so the link goes to the canvas and the prose
                  names the panel, rather than inventing URL state for a panel. */}
                and use the Version history panel to publish.
              </>
            )}
          </p>
        )}
      </FormSection>

      <FormSection title="Firing" hint={FORM_SECTION_HINTS.trigger.firing}>
        <LabelledControl label="Mode" hint={TRIGGER_MODE_DESCRIPTIONS[form.mode]}>
          {(id, hintId) => (
            <KindSelect icons={TRIGGER_MODE_ICONS} kind={form.mode}>
              <select
                id={id}
                aria-describedby={hintId}
                value={form.mode}
                onChange={(e) => onChange(withMode(form, e.target.value as TriggerMode))}
              >
                {MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {TRIGGER_MODE_LABELS[mode]}
                  </option>
                ))}
              </select>
            </KindSelect>
          )}
        </LabelledControl>

        {form.mode === 'schedule' && (
          <>
            {/* Labelled by `htmlFor`/`id` rather than wrapped: wrapping folds every
             * option's text into the control's accessible name (#857, #1227). */}
            <LabelledControl label="Schedule authored as">
              {(id) => (
                <select
                  id={id}
                  value={form.scheduleKind}
                  onChange={(e) =>
                    onChange({ ...form, scheduleKind: e.target.value as ScheduleKind })
                  }
                >
                  <option value="recurrence">Recurrence</option>
                  <option value="cron">Cron expression</option>
                </select>
              )}
            </LabelledControl>

            {form.scheduleKind === 'recurrence' ? (
              <RecurrenceEditor
                value={form.recurrence}
                onChange={(recurrence) => onChange({ ...form, recurrence })}
                validation={validation}
              />
            ) : (
              <label>
                Schedule (cron)
                <input
                  type="text"
                  value={form.schedule}
                  onChange={(e) => onChange({ ...form, schedule: e.target.value })}
                  placeholder="0 2 * * *"
                  spellCheck={false}
                />
              </label>
            )}
          </>
        )}

        {form.mode === 'event' && (
          <>
            <label>
              Event
              <input
                type="text"
                value={form.event.name}
                {...validation.attrsFor('event.name', eventErrorId)}
                onChange={(e) =>
                  onChange({ ...form, event: { ...form.event, name: e.target.value } })
                }
                placeholder="order.placed"
                spellCheck={false}
              />
            </label>
            <FieldError id={eventErrorId} message={validation.errorFor('event.name')} />
            <p className="page-hint">
              Fires when <code>POST /api/events</code> is called with this exact name. An enabled
              event trigger must carry one.
            </p>
            {/* The subscription schema has a catchall, so one authored through the
              API can carry keys this form has no control for. Say so — otherwise
              it looks like there is nothing else there, and the name field is a
              one-character path to destroying it. */}
            {Object.keys(form.event.extras).length > 0 && (
              <p className="page-hint" data-testid="event-preserved">
                This subscription also carries{' '}
                <code>{Object.keys(form.event.extras).sort().join(', ')}</code>, authored outside
                this form. There is no control for it here; it is preserved unchanged while this
                trigger stays in event mode, and the name cannot be cleared while it is there.
              </p>
            )}
          </>
        )}

        {form.mode === 'tumbling' && (
          <WindowEditor
            value={form.window}
            onChange={(window) => onChange({ ...form, window })}
            validation={validation}
          />
        )}

        {form.mode === 'continuous' && (
          <p className="page-hint">
            Continuous triggers are not dispatched yet — nothing schedules one. It can be saved and
            run with “Fire now”, but it will never fire on its own.
          </p>
        )}

        {form.mode === 'webhook' && (
          <p className="page-hint">
            Save the trigger, then choose “Provision webhook secret” from its row’s ⋯ menu to mint
            the signing secret.
          </p>
        )}

        <RunWindowsEditor
          value={form.runWindows}
          onChange={(runWindows) => onChange({ ...form, runWindows })}
          mode={form.mode}
          validation={validation}
        />
      </FormSection>

      <FormSection title="Concurrency" hint={FORM_SECTION_HINTS.trigger.concurrency}>
        <LabelledControl label="Concurrency">
          {(id) => (
            <select
              id={id}
              value={form.concurrencyPolicy}
              disabled={form.mode === 'tumbling'}
              onChange={(e) =>
                onChange({ ...form, concurrencyPolicy: e.target.value as ConcurrencyPolicy })
              }
            >
              {POLICIES.map((policy) => (
                <option key={policy} value={policy}>
                  {CONCURRENCY_POLICY_LABELS[policy]}
                </option>
              ))}
            </select>
          )}
        </LabelledControl>

        {form.mode === 'tumbling' && (
          <p className="page-hint">
            A tumbling trigger must use Queue (<code>queue</code>): Skip if running (
            <code>skip_if_running</code>) would drop a window&rsquo;s one materialization and strand
            it forever, and per-window parallelism is set by &ldquo;Max concurrent windows&rdquo;
            above rather than by the Parallel (<code>parallel</code>) policy.
          </p>
        )}

        {form.concurrencyPolicy === 'parallel' && (
          <label>
            <span>
              Max parallel runs
              <RequiredMark />
            </span>
            <input
              type="number"
              min={1}
              value={form.concurrencyMax}
              onChange={(e) => onChange({ ...form, concurrencyMax: e.target.value })}
              required
              {...validation.attrsFor('concurrency.max', maxErrorId)}
            />
          </label>
        )}
        {form.concurrencyPolicy === 'parallel' && (
          <FieldError id={maxErrorId} message={validation.errorFor('concurrency.max')} />
        )}
      </FormSection>

      <FormSection title="Parameters" hint={FORM_SECTION_HINTS.trigger.parameters}>
        <LabelledControl label="Params (JSON)">
          {(id) => (
            <JsonEditor
              id={id}
              label="Params (JSON)"
              value={form.paramsText}
              onValueChange={(paramsText) => onChange({ ...form, paramsText })}
              rows={4}
              {...validation.attrsFor('params', paramsErrorId)}
            />
          )}
        </LabelledControl>
        <FieldError id={paramsErrorId} message={validation.errorFor('params')} />
      </FormSection>
    </FormDrawer>
  );
}
