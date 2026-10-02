import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import {
  CONCURRENCY_POLICY_LABELS,
  ConcurrencyPolicySchema,
  TRIGGER_MODE_DESCRIPTIONS,
  TRIGGER_MODE_LABELS,
  TriggerModeSchema,
  type ConcurrencyPolicy,
  type EventConfig,
  type Recurrence,
  type TriggerMode,
  type WindowConfig,
  type PipelineVersion,
  type TriggerPublic,
} from '@autonomy-studio/shared';
import { Link } from 'react-router';
import { messageOf } from '../api/client';
import { downloadTextFile, exportFileName } from '../api/download';
import { exportTrigger } from '../api/portability';
import { ImportPanel } from './ImportPanel';
import { RecurrenceEditor } from './triggers/RecurrenceEditor';
import { WindowEditor } from './triggers/WindowEditor';
import { RunWindowsEditor } from './triggers/RunWindowsEditor';
import {
  blankEventForm,
  eventToForm,
  formToEvent,
  type EventFormState,
} from './triggers/eventForm';
import {
  blankWindowForm,
  formToWindow,
  windowToForm,
  WINDOW_FIELD_LABELS,
  WINDOW_FIELDS,
  type WindowFormState,
} from './triggers/windowForm';
import {
  blankRunWindowsForm,
  formToRunWindows,
  runWindowFields,
  runWindowsToForm,
  type RunWindowsFormState,
} from './triggers/runWindowsForm';
import {
  blankRecurrenceForm,
  formToRecurrence,
  RECURRENCE_FIELD_LABELS,
  RECURRENCE_FIELDS,
  recurrenceFieldShown,
  recurrenceToForm,
  type RecurrenceFormState,
  type ScheduleKind,
} from './triggers/recurrenceForm';

import { listAllPipelineVersions } from '../api/pipelines';
import { runDetailPath, runLinkLabel } from './runs/runPath';
import { pipelinePath } from './author/pipelinePath';
import { useBusyAction } from '../hooks/useBusyAction';
import { useGuardedLoad } from '../hooks/useGuardedLoad';
import { usePolledResource } from '../hooks/usePolledResource';
import { readPublishState } from './pipeline/publishState';
import { activeVersionLabel } from './pipeline/versionHistory';
import {
  activeBindingAdvice,
  bindingCreateFields,
  bindingIsBound,
  bindingPatchField,
  type BindingSelection,
  type PublishReading,
} from './triggers/binding';
import {
  createTrigger,
  deleteTrigger,
  fireTrigger,
  listTriggers,
  provisionWebhookSecret,
  updateTrigger,
  TriggerCreateSchema,
  TriggerWriteSchema,
  type TriggerCreateWrite,
  type TriggerWrite,
} from '../api/triggers';
import { LabelledControl } from '../lib/LabelledControl';
import { FormDrawer } from '../lib/form/FormDrawer';
import { FormSection } from '../lib/form/FormSection';
import { RequiredMark } from '../lib/form/RequiredMark';
import { FieldError } from '../lib/form/FieldError';
import { JsonEditor } from '../lib/form/JsonEditor';
import { notValidJson } from '../lib/json/jsonText';
import { FormErrors } from '../lib/form/FormErrors';
import { nameCheck, useFieldValidation, type FieldErrors } from '../lib/form/fieldValidation';
import { saveRefusal, schemaRefusal } from '../lib/form/saveErrors';
import { useDrawerForm, type UnsavedChangesGuard } from '../lib/form/useDrawerForm';
import { payloadSignature } from './pipeline/configForm';
import { KindSelect, TriggerModeName } from '../lib/KindName';
import { TRIGGER_MODE_ICONS } from '../lib/kindIcons';

const MODES = TriggerModeSchema.options;
const POLICIES = ConcurrencyPolicySchema.options;

/** A `pipelineVersionId` → human label, so a trigger's binding reads as
 * "Pipeline name v3" instead of an opaque id. Built once when the page loads. */
interface BindingOption {
  value: string; // pipelineVersionId
  label: string; // `${pipeline.name} v${version}`
}

/**
 * #981 — a pipeline that can be bind-to-active'd, for the second control.
 *
 * Derived from the same `listAllPipelineVersions` load, which means a pipeline
 * with NO versions never appears. That is correct rather than incidental: it has
 * nothing to publish and nothing to be latest, so both branches of
 * `resolveBindToActive` would refuse it (the DB-only branch with its own "has no
 * versions" 400). Excluding it is the honest analogue of not offering a binding
 * that cannot exist.
 */
interface PipelineOption {
  pipelineId: string;
  name: string;
  /** Every version of this pipeline this page knows about, for naming the active one. */
  versions: PipelineVersion[];
}

type FormState = {
  id: string | null; // null = creating, otherwise editing this trigger
  name: string;
  binding: BindingSelection;
  mode: TriggerMode;
  /** #439 U14b — which of the two mutually-exclusive schedule authoring modes is
   * active. The server refuses a write carrying BOTH a `recurrence` and a raw
   * cron `schedule`, so the form always sends the unselected side as an
   * explicit `null` rather than omitting it (on a PATCH, omitting means
   * "untouched", which would leave the old one in place and 400). */
  scheduleKind: ScheduleKind;
  schedule: string; // raw cron, for `scheduleKind === 'cron'`; '' = null
  recurrence: RecurrenceFormState; // for `scheduleKind === 'recurrence'`
  /** #854 — the other two configurable modes. Held alongside the schedule half
   * for the same reason: the write boundary refuses config that does not match
   * the mode, so every save sends the modes it is NOT in as an explicit null. */
  event: EventFormState;
  window: WindowFormState;
  concurrencyPolicy: ConcurrencyPolicy;
  concurrencyMax: string; // only meaningful for `parallel`; '' = unset
  enabled: boolean;
  paramsText: string; // JSON object
  /** #1090 U14c — the structured run-window state. Mode-INDEPENDENT (unlike
   * `recurrence`/`event`/`window`): a run window is stored and honoured for
   * every mode that consults one, so it is never settled by `withMode`. */
  runWindows: RunWindowsFormState;
};

/**
 * #854 — switching INTO tumbling settles the one concurrency policy the write
 * boundary allows there: `assertWindowConsistent` refuses a tumbling trigger
 * whose policy is anything but `queue`, so the control is settled in STATE
 * rather than coerced at save time, and shows what will actually be written.
 * Switching away leaves it — `queue` is legal in every mode.
 */
function withMode(form: FormState, mode: TriggerMode): FormState {
  if (mode !== 'tumbling') return { ...form, mode };
  return { ...form, mode, concurrencyPolicy: 'queue', concurrencyMax: '' };
}

/**
 * #1396 — what Save would write, for the unsaved-changes guard. Only the
 * ACTIVE mode's config counts: Save sends every other mode's as `null`, so
 * typing an event name and then switching to manual changes nothing Save would
 * write, and is not an unsaved change.
 */
function savePayloadSignature(form: FormState): string {
  const modeConfig =
    form.mode === 'schedule'
      ? form.scheduleKind === 'recurrence'
        ? { recurrence: form.recurrence }
        : { schedule: form.schedule }
      : form.mode === 'event'
        ? { event: form.event }
        : form.mode === 'tumbling'
          ? { window: form.window }
          : null;
  return payloadSignature([
    form.name,
    form.binding,
    form.mode,
    modeConfig,
    form.concurrencyPolicy,
    form.concurrencyPolicy === 'parallel' ? form.concurrencyMax : null,
    form.enabled,
    form.paramsText,
    form.runWindows,
  ]);
}

function blankForm(): FormState {
  return {
    id: null,
    name: '',
    binding: { kind: 'unbound' },
    mode: 'manual',
    scheduleKind: 'recurrence',
    schedule: '',
    recurrence: blankRecurrenceForm(),
    event: blankEventForm(),
    window: blankWindowForm(),
    concurrencyPolicy: 'skip_if_running',
    concurrencyMax: '',
    enabled: false,
    paramsText: '{}',
    runWindows: blankRunWindowsForm(),
  };
}

function formForEdit(t: TriggerPublic): FormState {
  // A recurrence-backed trigger also carries a `schedule` — the cron DERIVED
  // from it. Loading that into the raw-cron field would make every save author
  // both, which the server refuses; so the recurrence, when present, wins and
  // the cron field stays empty.
  //
  // Everything else opens on the CRON side, including a schedule trigger that
  // has no schedule at all (a legal stored row: nothing server-side forces one).
  // Opening THAT on the recurrence builder would be the wrong default, because
  // the builder has no "nothing selected" state — its blank form is a valid
  // daily recurrence — so merely renaming such a trigger would silently grant it
  // a midnight cron it never had. The blank cron field round-trips to `null`,
  // which is what was actually stored.
  const hasRecurrence = t.recurrence !== null;
  // The LOAD path settles the same invariants the mode-switch path does. A
  // stored tumbling trigger can carry a non-`queue` policy — the import and
  // workspace-apply write paths preserve `concurrency` verbatim and never run
  // `assertWindowConsistent` — and the Concurrency select is DISABLED under
  // tumbling. Loading such a row without settling would pin a disabled control
  // on a value the server refuses, so every save 400s and the one control that
  // could repair it is the one that was switched off. A repair affordance must
  // ENFORCE the repair, not merely display it.
  return withMode(
    {
      id: t.id,
      name: t.name,
      binding:
        t.pipelineVersionId === null
          ? { kind: 'unbound' }
          : { kind: 'concrete', pipelineVersionId: t.pipelineVersionId },
      mode: t.mode,
      scheduleKind: hasRecurrence ? 'recurrence' : 'cron',
      schedule: hasRecurrence ? '' : (t.schedule ?? ''),
      recurrence: t.recurrence !== null ? recurrenceToForm(t.recurrence) : blankRecurrenceForm(),
      event: t.event !== null ? eventToForm(t.event) : blankEventForm(),
      window: t.window !== null ? windowToForm(t.window) : blankWindowForm(),
      concurrencyPolicy: t.concurrency.policy,
      concurrencyMax: t.concurrency.max !== undefined ? String(t.concurrency.max) : '',
      enabled: t.enabled,
      paramsText: JSON.stringify(t.params, null, 2),
      runWindows: runWindowsToForm(t.runWindows),
    },
    t.mode,
  );
}

/**
 * The outcome of one "Fire now", kept per TRIGGER (#1247).
 *
 * WHY THIS IS A LIST AND NOT A SLOT. The page used to report a fire through one
 * `actionMsg` string and one `watchRunId`, which is only sound while exactly one
 * fire can be in flight — and the guard that enforced that was the bug: a
 * page-wide `if (firingId) return;` made "Fire now" on a second trigger a silent
 * no-op on an ENABLED button. Removing the guard without this is the worse
 * trade, because the later outcome would overwrite the earlier one and the thing
 * lost is a run link the operator was already offered.
 *
 * BOUNDED BY LIVE TRIGGER COUNT, NOT BY CLICKS. `triggerId` is the identity: re-firing
 * the same trigger REPLACES its entry in place rather than appending a second
 * one, so a session of repeated fires cannot grow the notice without limit and
 * an entry does not jump position under the operator as they re-fire it. An
 * entry whose trigger no longer exists is dropped at render — see `visibleOutcomes`.
 */
interface FireOutcome {
  triggerId: string;
  text: string;
  /** Non-null only for an `outcome: 'started'` fire — a `skipped`/`queued`/failed fire has no run to watch. */
  runId: string | null;
}

/**
 * Triggers page: the third MVP-bar step ("create a trigger and fire it"). Full
 * CRUD over `/api/triggers`, plus a manual "Fire now" and, for a webhook
 * trigger, one-time secret provisioning. A trigger binds ONE immutable pipeline
 * version (or is deliberately unbound); an ENABLED trigger must be bound (the
 * server refuses otherwise — mirrored here for a friendlier message).
 */
export function TriggersPage() {
  const [triggers, setTriggers] = useState<TriggerPublic[] | null>(null);
  const [bindings, setBindings] = useState<BindingOption[]>([]);
  const [pipelines, setPipelines] = useState<PipelineOption[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const {
    form,
    setForm,
    openForm,
    seq: formSeq,
    guard,
    openerRef,
    closeWhere,
    ...drawer
  } = useDrawerForm(savePayloadSignature);
  // Since #1247 this carries `onProvisionSecret`'s failure ONLY — a fire reports
  // through `fireOutcomes`, because a fire's outcome has to survive another
  // trigger being fired beside it and a single slot cannot do that.
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  // One entry per trigger fired this session, newest state per trigger. See
  // `FireOutcome` for why this is keyed by trigger rather than being a slot.
  const [fireOutcomes, setFireOutcomes] = useState<readonly FireOutcome[]>([]);
  const guardedLoad = useGuardedLoad();
  const [webhookSecret, setWebhookSecret] = useState<{
    triggerName: string;
    secret: string;
    deliveryUrl: string;
  } | null>(null);

  // Every pipeline's versions, as binding options. The LOAD is shared with the
  // canvas's call-node target picker (`listAllPipelineVersions`); only the
  // option label is this page's own.
  const loadBindings = useCallback(
    async (
      signal?: AbortSignal,
    ): Promise<{ options: BindingOption[]; pipelines: PipelineOption[] }> => {
      const all = await listAllPipelineVersions(signal);
      const options = all.map(({ pipeline, version }) => ({
        value: version.id,
        label: `${pipeline.name} v${version.version}`,
      }));
      // #981 — the same rows, grouped, for the bind-to-active control. A Map
      // keeps first-seen order (the order `listAllPipelineVersions` returns) so
      // the two controls agree on how pipelines are ordered.
      const byPipeline = new Map<string, PipelineOption>();
      for (const { pipeline, version } of all) {
        const existing = byPipeline.get(pipeline.id);
        if (existing) existing.versions.push(version);
        else
          byPipeline.set(pipeline.id, {
            pipelineId: pipeline.id,
            name: pipeline.name,
            versions: [version],
          });
      }
      return { options, pipelines: [...byPipeline.values()] };
    },
    [],
  );

  // The ONE load path: the mount effect below and every post-mutation refetch
  // go through it. That is what ORDERS them — #1062: the New trigger button is
  // not gated behind the list having arrived, so a create could complete while
  // the initial load was still in flight, and the mount load would then land
  // second and write the list as it was before the trigger existed.
  //
  // It reloads the BINDINGS as well as the triggers, and that is load-bearing
  // rather than incidental. `useGuardedLoad`'s ticket is monotonic across every
  // load one instance guards, so pointing it at a triggers-only refresh AND a
  // triggers-plus-bindings mount load would make the refresh supersede the
  // mount result WHOLE: `bindings` and `pipelines` are written nowhere else, so
  // they would stay empty for the rest of the page's life with no retry path —
  // every bound row reading as a raw version id, the version picker offering
  // nothing, bind-to-active permanently disabled. One fetcher, one counter, one
  // group of state that moves together. The cost is that each mutation re-pays
  // `listAllPipelineVersions` (N+1 by design, at MVP scale); the gain beyond
  // correctness is that a version minted elsewhere since mount now shows up.
  //
  // Failures are caught here rather than by the caller (as they were before) so
  // a refresh failure after e.g. a create — where the form has already
  // unmounted — still surfaces as `loadError` instead of being swallowed by the
  // gone form's handler. Both halves land or neither does, exactly as the
  // `Promise.all` this replaces behaved.
  const refresh = useCallback(
    () =>
      guardedLoad((signal) => Promise.all([listTriggers(signal), loadBindings(signal)]), {
        onData: ([list, opts]) => {
          setTriggers(list);
          setBindings(opts.options);
          setPipelines(opts.pipelines);
          setLoadError(null);
        },
        onError: (err) => setLoadError(err instanceof Error ? err.message : String(err)),
      }),
    [guardedLoad, loadBindings],
  );

  // `refresh` is stable (so are the runner and `loadBindings` it closes over),
  // so this is the initial load and nothing more.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const labelFor = useCallback(
    (versionId: string | null): string => {
      if (versionId === null) return 'unbound';
      return bindings.find((b) => b.value === versionId)?.label ?? versionId;
    },
    [bindings],
  );

  const onDelete = useCallback(
    async (t: TriggerPublic) => {
      if (!window.confirm(`Delete trigger "${t.name}"?`)) return;
      try {
        await deleteTrigger(t.id);
        // A form open on the trigger just deleted would save to nothing.
        closeWhere((open) => open.id === t.id);
        await refresh();
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
      }
    },
    [refresh, closeWhere],
  );

  /**
   * Save the trigger's export envelope to disk (#959). The fetch happens first
   * and its failure is REPORTED — a bare `<a download>` would have written a
   * 404 body to the operator's disk as a `.json` file with nothing said (see
   * `api/download.ts`).
   *
   * SECURITY: the envelope carries no `webhook.secretRef`, and no binding —
   * both come back as attention items on import, which the panel below
   * renders. That is the server's guarantee, not this page's.
   */
  /* #960 — per-row single-flight. The visible label deliberately does NOT
     change to "Exporting…": these buttons carry an `aria-label` naming the row,
     and a visible string absent from the accessible name violates WCAG 2.5.3
     (label in name). `disabled` + `aria-busy` is the affordance. */
  const { active: exporting, run: runExport } = useBusyAction();

  const onExport = useCallback(
    (t: TriggerPublic) =>
      runExport(t.id, async () => {
        setLoadError(null);
        try {
          downloadTextFile(exportFileName('trigger', t.name, t.id), await exportTrigger(t.id));
        } catch (err) {
          // `loadError`, not the outcome notice: that notice is `role="log"` and
          // reports what an action DID (a fire's result, a provisioning failure),
          // whereas a failed export is an ERROR and belongs in the page's
          // `role="alert"` surface. `onDelete` already routes its failure there,
          // so this is the page's existing home for "an action did not happen".
          // (Was described here as `actionMsg`'s `role="status"` notice "carrying
          // Fired X: started" — #1247 moved fire outcomes to `fireOutcomes` and
          // the region to `log`, so both halves of that had stopped being true.)
          setLoadError(`Could not export “${t.name}”: ${messageOf(err)}`);
        }
      }),
    [runExport],
  );

  /* #1247 — per-ROW single-flight, through the same hook as `onExport` above.
     The guard this replaced was page-wide (`if (firingId) return;`) while the
     `disabled` beside it was per-row, so firing a second trigger while the first
     was in flight was a silent no-op on an enabled button. `useBusyAction`'s
     docblock argues the shape; this is the call site it named. */
  const { active: firing, run: runFire } = useBusyAction();

  const onFire = useCallback(
    (t: TriggerPublic) =>
      runFire(t.id, async () => {
        /* Clearing `actionMsg` is KEPT from the single-slot version: it holds a
           provisioning failure, and starting a new action should not leave a
           stale error from a previous one on screen. What is deliberately NOT
           cleared is any OTHER trigger's `fireOutcomes` entry — that is another
           action's result, and discarding it is the defect this ticket fixes.
           The asymmetry is the point: clear what this action owns, nothing else. */
        setActionMsg(null);
        const record = (outcome: FireOutcome) =>
          setFireOutcomes((prev) =>
            prev.some((o) => o.triggerId === outcome.triggerId)
              ? // Replace IN PLACE. Appending would move a re-fired trigger's
                // entry to the end, reordering the notice under the operator.
                prev.map((o) => (o.triggerId === outcome.triggerId ? outcome : o))
              : [...prev, outcome],
          );
        try {
          const result = await fireTrigger(t.id);
          const detail =
            result.outcome === 'started'
              ? `started (run ${result.runId ?? '?'})`
              : result.outcome === 'skipped'
                ? `skipped — ${result.reason ?? 'no reason given'}`
                : 'queued';
          record({
            triggerId: t.id,
            text: `Fired "${t.name}": ${detail}.`,
            runId: result.outcome === 'started' ? (result.runId ?? null) : null,
          });
        } catch (err) {
          // Caught HERE rather than left to `useBusyAction`, which re-throws
          // whatever `act` throws — see its "THE CALLER OWNS ERROR REPORTING".
          record({
            triggerId: t.id,
            text: `Fire failed for "${t.name}": ${messageOf(err)}`,
            runId: null,
          });
        }
      }),
    [runFire],
  );

  const onProvisionSecret = useCallback(async (t: TriggerPublic) => {
    setActionMsg(null);
    setWebhookSecret(null);
    try {
      const result = await provisionWebhookSecret(t.id);
      setWebhookSecret({
        triggerName: t.name,
        secret: result.secret,
        deliveryUrl: result.deliveryUrl,
      });
    } catch (err) {
      setActionMsg(
        `Could not provision a webhook secret for "${t.name}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, []);

  /* An outcome belongs to a trigger ROW, so when that row goes away its outcome
     and its "Watch live" link go with it — otherwise a fired-then-deleted trigger
     leaves a message in the notice naming a trigger the table no longer lists,
     for the rest of the session. The old single-slot code hid this by losing the
     message on the next fire, which is the very defect #1247 removes, so the
     bound has to be made explicit instead.

     DERIVED, not pruned inside `onDelete`: that covers every way a trigger can
     disappear (deleted in another session, gone by the next `refresh`), not just
     the one this page performs. `triggers === null` is the pre-load state ONLY —
     `refresh` replaces the list and never returns it to null — so this cannot
     transiently hide a live outcome mid-refresh. */
  const visibleOutcomes = useMemo(
    () =>
      triggers === null
        ? fireOutcomes
        : fireOutcomes.filter((o) => triggers.some((t) => t.id === o.triggerId)),
    [fireOutcomes, triggers],
  );

  return (
    <section aria-labelledby="triggers-heading">
      <div className="page-header">
        <h2 id="triggers-heading">Triggers</h2>
        <button
          type="button"
          onClick={(e) => drawer.openFrom(e.currentTarget, () => openForm(blankForm()))}
        >
          New trigger
        </button>
      </div>

      <p className="page-hint">
        A trigger binds one pipeline version to a firing mode (manual, schedule, webhook…) and a
        concurrency policy. Fire it now, or enable it to fire automatically. An enabled trigger must
        be bound to a pipeline version.
      </p>

      {loadError && (
        <p role="alert" className="error">
          {loadError}
        </p>
      )}

      {/* ONE region for both, rather than a second live region beside the three
          this page already has (#1249 tracks the app-wide count).

          `role="log"` and NOT `role="status"`, which is this file's first use of
          it and therefore needs saying: `status` is implicitly
          `aria-atomic="true"`, so a screen reader re-reads the WHOLE region on
          every change — with a list that grows by one entry per trigger fired,
          the fifth fire would re-announce outcomes one to five. `log` declares
          `aria-live="polite"` without the atomic default, which is exactly the
          "announce what was added" semantics an append-style outcome list wants.

          `ImportPanel`'s `ImportOutcome` already renders `div.notice` wrapping
          several `<p>`s, so the container shape is this page's idiom rather than
          something new. `useTransientNotice` was considered and rejected: it
          auto-clears, which would evaporate a run link the operator was given. */}
      {(actionMsg || visibleOutcomes.length > 0) && (
        <div role="log" className="notice">
          {actionMsg && <p>{actionMsg}</p>}
          {visibleOutcomes.map((outcome) => (
            <p key={outcome.triggerId}>
              {outcome.text}
              {outcome.runId && (
                <>
                  {' '}
                  {/* The lead is this control's OWN visible text, which is what makes the
                  accessible name contain it — see `runLinkLabel` for why that shape
                  holds by construction. The run id is appended because "Watch live"
                  alone does not say WHICH run, and this notice can name a different
                  one each fire.

                  The arrow belongs in the lead, and that is deliberate rather than
                  tidy: "contains" is a LITERAL substring test, the visible text is
                  `Watch live →`, and a lead that dropped the arrow — or used any
                  other glyph, which is what an em dash here did — breaks containment
                  on the arrow alone. `ImportPanel`'s `Manage → Connections` links
                  already carry an arrow in their accessible name, so this is the
                  idiom rather than an exception to it. */}
                  <Link
                    to={runDetailPath(outcome.runId)}
                    aria-label={runLinkLabel('Watch live →', outcome.runId)}
                  >
                    Watch live →
                  </Link>
                </>
              )}
            </p>
          ))}
        </div>
      )}

      {webhookSecret && (
        <div role="status" className="secret-reveal">
          <p>
            Webhook secret for <strong>{webhookSecret.triggerName}</strong> — copy it now, it is
            shown only once:
          </p>
          <p>
            <code>{webhookSecret.secret}</code>
          </p>
          <p>
            Sign deliveries to <code>{webhookSecret.deliveryUrl}</code>.
          </p>
          <button type="button" onClick={() => setWebhookSecret(null)}>
            Dismiss
          </button>
        </div>
      )}

      {/* #1396 — the list and the form side by side; the form is a column, not
          an overlay, so the row actions stay reachable while it is open. */}
      {guard.routeHold}
      <div className={form ? 'drawer-layout-open' : undefined}>
        <div>
          {triggers === null && !loadError && <p>Loading triggers…</p>}

          {triggers !== null && triggers.length === 0 && (
            <p>No triggers yet. Create one to bind a pipeline version and fire it.</p>
          )}

          {triggers !== null && triggers.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Mode</th>
                  <th scope="col">Bound to</th>
                  <th scope="col">Enabled</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {triggers.map((t) => (
                  <tr key={t.id}>
                    <td>{t.name}</td>
                    <td>
                      <TriggerModeName mode={t.mode} />
                    </td>
                    <td>{labelFor(t.pipelineVersionId)}</td>
                    <td>{t.enabled ? 'yes' : 'no'}</td>
                    <td>
                      {/* #1247 — the busy treatment is `disabled` + `aria-busy`, and the
                      visible label deliberately does NOT flip to "Firing…". Verbatim
                      the rule `onExport` states earlier in this file: this button carries an
                      `aria-label` naming the row, so a visible string absent from that
                      accessible name violates WCAG 2.5.3 (label in name). Its sibling
                      in this same cell already resolves it this way, and two busy
                      treatments on two buttons in one `<td>` is the defect #1242 closed.

                      The label is `Fire now: <name>` and NOT `Fire <name> now`, which is
                      what it was and which failed the same rule for a second reason: 2.5.3
                      is a literal SUBSTRING test, and infixing the row name split the
                      visible "Fire now" in half. Lead-then-detail is the shape `runLinkLabel`
                      and the Export button beside it already use, and it is the only one
                      that survives the check — hence the assertion in the spec. */}
                      <button
                        type="button"
                        onClick={() => void onFire(t)}
                        disabled={firing.has(t.id)}
                        aria-busy={firing.has(t.id)}
                        aria-label={`Fire now: ${t.name}`}
                      >
                        Fire now
                      </button>
                      <button
                        type="button"
                        onClick={(e) =>
                          drawer.openFrom(e.currentTarget, () => openForm(formForEdit(t)))
                        }
                        aria-label={`Edit ${t.name}`}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => void onExport(t)}
                        aria-label={`Export ${t.name}`}
                        disabled={exporting.has(t.id)}
                        aria-busy={exporting.has(t.id)}
                      >
                        Export
                      </button>
                      {t.mode === 'webhook' && (
                        <button
                          type="button"
                          onClick={() => void onProvisionSecret(t)}
                          aria-label={`Provision webhook secret for ${t.name}`}
                        >
                          Webhook secret
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void onDelete(t)}
                        aria-label={`Delete ${t.name}`}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {form && (
          <TriggerForm
            /* Keyed on the open counter, so the error, the remembered version
               and the publish reading of one draft never render against the
               next (see `useDrawerForm`). */
            key={formSeq}
            form={form}
            bindings={bindings}
            pipelines={pipelines}
            onChange={setForm}
            guard={guard}
            returnFocusTo={openerRef}
            onClose={drawer.requestClose}
            onSaved={async () => {
              drawer.closeIfLatest(formSeq);
              await refresh();
            }}
          />
        )}
      </div>

      {/* The import surface lives on the list an imported trigger lands in —
          but it takes ANY export envelope, because `POST /api/import` does (see
          `ImportPanel`). A pipeline or connection file is imported and then
          reported with a pointer to its own section, rather than refused by a
          client-side rule the server does not have. */}
      <ImportPanel listKind="trigger" onImported={refresh} />
    </section>
  );
}

/** `params` must be a JSON object (`params` is a record); blank means `{}`. */
function parseParamsText(
  text: string,
): { ok: true; params: Record<string, unknown> } | { ok: false; message: string } {
  try {
    const raw: unknown = JSON.parse(text.trim() === '' ? '{}' : text);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, message: 'must be a JSON object, e.g. {"day": "2026-10-01"}' };
    }
    return { ok: true, params: raw as Record<string, unknown> };
  } catch {
    return {
      ok: false,
      message: notValidJson(text),
    };
  }
}

/** #1396 — the binding control's field key: the version select, or bind-to-active's pipeline. */
function bindingKey(form: FormState): string {
  return form.binding.kind === 'active' ? 'bindToActive.pipelineId' : 'pipelineVersionId';
}

/**
 * #1396 — the mode editors' fields on screen now, each with what the error
 * summary calls it. Keyed by the payload path a control authors
 * (`recurrence.schedule.hours`), so a server refusal on that path lands beside
 * it too. ONE table for `modeChecks` and `labelOf`: a check is only ever raised
 * on a key this names, because a check with no control on screen would refuse
 * Save with nothing to show or focus.
 */
function modeFields(form: FormState): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  if (form.mode === 'schedule' && form.scheduleKind === 'recurrence') {
    for (const field of RECURRENCE_FIELDS) {
      if (recurrenceFieldShown(field, form.recurrence.frequency)) {
        out[`recurrence.${field}`] = RECURRENCE_FIELD_LABELS[field];
      }
    }
  } else if (form.mode === 'event') {
    out['event.name'] = 'Event';
  } else if (form.mode === 'tumbling') {
    for (const field of WINDOW_FIELDS) out[`window.${field}`] = WINDOW_FIELD_LABELS[field];
  }
  // Run windows are not owned by a mode: shown, and converted, in every one.
  // The list is a field (an issue no row owns), and so is each row's control.
  out.runWindows = 'Run windows';
  for (const { field, label } of runWindowFields(form.runWindows)) {
    out[`runWindows.${field}`] = label;
  }
  return out;
}

/**
 * #1396 — what is wrong with the mode editors now, beside the control it is
 * about. Only the ACTIVE mode's builder is consulted, as Save does; run windows
 * always are. A refusal no control owns (`fields` empty, or a path this form
 * has no control for) is left to Save's footer message.
 *
 * The builders refuse in either enabled state (a half-filled window is refused
 * on a disabled trigger too, rather than discarded). Only the "must carry one"
 * rules are enabled-conditional, as `assertEventConsistent` /
 * `assertWindowConsistent` are, and they never displace a builder's own message.
 */
function modeChecks(form: FormState): FieldErrors {
  const out: Record<string, string> = {};
  const put = (prefix: string, fields: Readonly<Partial<Record<string, string>>>) => {
    for (const [path, message] of Object.entries(fields)) {
      if (message !== undefined) out[`${prefix}.${path}`] = message;
    }
  };
  if (form.mode === 'schedule' && form.scheduleKind === 'recurrence') {
    const converted = formToRecurrence(form.recurrence);
    if (!converted.ok) put('recurrence', converted.fields);
  } else if (form.mode === 'event') {
    const converted = formToEvent(form.event);
    if (!converted.ok) put('event', converted.fields);
    else if (form.enabled && converted.event === null) {
      out['event.name'] = 'An enabled event trigger must carry an event name (or disable it).';
    }
  } else if (form.mode === 'tumbling') {
    const converted = formToWindow(form.window);
    if (!converted.ok) put('window', converted.fields);
    else if (form.enabled && converted.window === null) {
      out['window.startTime'] =
        'An enabled tumbling trigger must carry a window — give it a start time (or disable it).';
    }
  }
  const windows = formToRunWindows(form.runWindows);
  if (!windows.ok) {
    // On the rows' controls; an issue no row owns (none the schema raises
    // today) marks the list, once the rows' own refusals are fixed.
    if (Object.keys(windows.fields).length > 0) put('runWindows', windows.fields);
    else out.runWindows = windows.reason;
  }

  const shown = modeFields(form);
  return Object.fromEntries(Object.entries(out).filter(([key]) => Object.hasOwn(shown, key)));
}

/**
 * #1396 — what is wrong with the trigger form now, in the form's order: its
 * own fields, then the mode editors' (`modeChecks`), then concurrency and
 * params.
 *
 * - Name: the write schema's `min(1)`.
 * - The binding: an enabled trigger must be bound (the server's
 *   `assertBindableIfEnabled`, mirrored for a message that sits beside the
 *   select). Bind-to-active counts as bound.
 * - Max parallel runs: read as Save reads it (`Number`), so `1e2` passes as it
 *   always has; `0`, `-1`, `1.5` and an empty box are what the input's `min=1`
 *   and step used to refuse before the form took over its own checks.
 * - Params: a JSON object.
 */
function triggerChecks(form: FormState): FieldErrors {
  const out: Record<string, string> = { ...nameCheck(form.name) };
  if (form.enabled && !bindingIsBound(form.binding)) {
    out[bindingKey(form)] =
      'An enabled trigger must be bound to a pipeline version (or disable it).';
  }
  Object.assign(out, modeChecks(form));
  if (form.concurrencyPolicy === 'parallel') {
    const max = Number(form.concurrencyMax);
    if (form.concurrencyMax.trim() === '' || !Number.isInteger(max) || max < 1) {
      out['concurrency.max'] = 'Enter a whole number, 1 or more.';
    }
  }
  const params = parseParamsText(form.paramsText);
  if (!params.ok) out.params = params.message;
  return out;
}

function TriggerForm({
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
          // re-send — it is provisioned out-of-band via "Webhook secret").
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
      <FormSection title="Basics">
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

        <label className="checkbox">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => onChange({ ...form, enabled: e.target.checked })}
          />
          Enabled (fires on its schedule, event, window or webhook)
        </label>
      </FormSection>

      <FormSection title="Pipeline">
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

      <FormSection title="Firing">
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
            Save the trigger, then use “Webhook secret” on its row to mint the signing secret.
          </p>
        )}

        <RunWindowsEditor
          value={form.runWindows}
          onChange={(runWindows) => onChange({ ...form, runWindows })}
          mode={form.mode}
          validation={validation}
        />
      </FormSection>

      <FormSection title="Concurrency">
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

      <FormSection title="Parameters">
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
