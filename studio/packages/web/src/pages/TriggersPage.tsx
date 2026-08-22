import { useCallback, useEffect, useId, useState } from 'react';
import {
  ConcurrencyPolicySchema,
  TriggerModeSchema,
  formatZodIssues,
  type ConcurrencyPolicy,
  type EventConfig,
  type Recurrence,
  type TriggerMode,
  type WindowConfig,
  type PipelineVersion,
  type TriggerPublic,
} from '@autonomy-studio/shared';
import { Link } from 'react-router';
import { ApiError, messageOf } from '../api/client';
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
  type WindowFormState,
} from './triggers/windowForm';
import {
  blankRunWindowsForm,
  formToRunWindows,
  runWindowsToForm,
  type RunWindowsFormState,
} from './triggers/runWindowsForm';
import {
  blankRecurrenceForm,
  formToRecurrence,
  recurrenceToForm,
  type RecurrenceFormState,
  type ScheduleKind,
} from './triggers/recurrenceForm';

import { listAllPipelineVersions } from '../api/pipelines';
import { runDetailPath, runLinkLabel } from './runs/runPath';
import { pipelinePath } from './author/pipelinePath';
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
  const [form, setForm] = useState<FormState | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  // The id of the trigger whose "Fire now" is currently in flight, so the
  // button can be disabled to prevent a rapid double-click dispatching two
  // fires before `actionMsg` updates.
  const [firingId, setFiringId] = useState<string | null>(null);
  // The run id of the most recent successful "Fire now", so we can offer a
  // one-click jump to its live monitor (the last step of the MVP-bar flow).
  const [watchRunId, setWatchRunId] = useState<string | null>(null);
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
        await refresh();
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
      }
    },
    [refresh],
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
  const onExport = useCallback(async (t: TriggerPublic) => {
    setLoadError(null);
    try {
      downloadTextFile(exportFileName('trigger', t.name, t.id), await exportTrigger(t.id));
    } catch (err) {
      // `loadError`, not `actionMsg`: this page's `actionMsg` is a
      // `role="status"` notice (it carries "Fired X: started"), and a failed
      // export is an ERROR. `onDelete` already routes its failure here, so
      // this is the page's existing surface for "an action did not happen".
      setLoadError(`Could not export “${t.name}”: ${messageOf(err)}`);
    }
  }, []);

  const onFire = useCallback(
    async (t: TriggerPublic) => {
      // Guard against a double-click firing twice before the request resolves.
      if (firingId) return;
      setActionMsg(null);
      setWatchRunId(null);
      setFiringId(t.id);
      try {
        const result = await fireTrigger(t.id);
        const detail =
          result.outcome === 'started'
            ? `started (run ${result.runId ?? '?'})`
            : result.outcome === 'skipped'
              ? `skipped — ${result.reason ?? 'no reason given'}`
              : 'queued';
        setActionMsg(`Fired "${t.name}": ${detail}.`);
        if (result.outcome === 'started' && result.runId) setWatchRunId(result.runId);
      } catch (err) {
        setActionMsg(
          `Fire failed for "${t.name}": ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        setFiringId(null);
      }
    },
    [firingId],
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

  return (
    <section aria-labelledby="triggers-heading">
      <div className="page-header">
        <h2 id="triggers-heading">Triggers</h2>
        <button type="button" onClick={() => setForm(blankForm())}>
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

      {actionMsg && (
        <p role="status" className="notice">
          {actionMsg}
          {watchRunId && (
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
                to={runDetailPath(watchRunId)}
                aria-label={runLinkLabel('Watch live →', watchRunId)}
              >
                Watch live →
              </Link>
            </>
          )}
        </p>
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
                  <code>{t.mode}</code>
                </td>
                <td>{labelFor(t.pipelineVersionId)}</td>
                <td>{t.enabled ? 'yes' : 'no'}</td>
                <td>
                  <button
                    type="button"
                    onClick={() => void onFire(t)}
                    disabled={firingId === t.id}
                    aria-label={`Fire ${t.name} now`}
                  >
                    {firingId === t.id ? 'Firing…' : 'Fire now'}
                  </button>
                  <button type="button" onClick={() => setForm(formForEdit(t))}>
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => void onExport(t)}
                    aria-label={`Export ${t.name}`}
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

      {form && (
        <TriggerForm
          form={form}
          bindings={bindings}
          pipelines={pipelines}
          onChange={setForm}
          onClose={() => setForm(null)}
          onSaved={async () => {
            setForm(null);
            await refresh();
          }}
        />
      )}

      {/* The import surface lives on the list an imported trigger lands in —
          but it takes ANY export envelope, because `POST /api/import` does (see
          `ImportPanel`). A pipeline or connection file is imported and then
          reported with a pointer to its own section, rather than refused by a
          client-side rule the server does not have. */}
      <ImportPanel listKind="trigger" onImported={refresh} />
    </section>
  );
}

function TriggerForm({
  form,
  bindings,
  pipelines,
  onChange,
  onClose,
  onSaved,
}: {
  form: FormState;
  bindings: BindingOption[];
  pipelines: PipelineOption[];
  onChange: (next: FormState) => void;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const scheduleKindId = useId();
  const bindingKindId = useId();
  const editing = form.id !== null;
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

    // params must be a JSON object (`params` is a record).
    let params: Record<string, unknown>;
    try {
      const raw: unknown = JSON.parse(form.paramsText.trim() === '' ? '{}' : form.paramsText);
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('params must be a JSON object');
      }
      params = raw as Record<string, unknown>;
    } catch (err) {
      setError(`Invalid params JSON: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

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

    // Mirror the server's `assertBindableIfEnabled` for a friendlier message
    // (the server still enforces it). Bind-to-active counts as bound: the route
    // resolves it to a concrete id BEFORE running that assertion.
    if (form.enabled && !bindingIsBound(form.binding)) {
      setError('An enabled trigger must be bound to a pipeline version (or disable it).');
      return;
    }

    // #981 — the publish precondition, stated where it can still be acted on.
    // Only ever set when the reading SUCCEEDED and said there is nothing to bind
    // to; an unread pair never refuses, because the gate is the server's and
    // refusing on a failed read would block a create it would have accepted.
    if (advice?.refusal != null) {
      setError(advice.refusal);
      return;
    }

    // Mirror `assertEventConsistent` / `assertWindowConsistent` for a friendlier
    // message. Both are ENABLED-conditional on the server, and so are these: a
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
        setError(formatZodIssues(parsed.error.issues));
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
        setError(err instanceof ApiError || err instanceof Error ? err.message : String(err));
        setSaving(false);
      }
      return;
    }

    const createBody: TriggerCreateWrite = { ...common, ...bindingCreateFields(form.binding) };
    const parsedCreate = TriggerCreateSchema.safeParse(createBody);
    if (!parsedCreate.success) {
      setError(formatZodIssues(parsedCreate.error.issues));
      return;
    }
    setSaving(true);
    try {
      await createTrigger(parsedCreate.data);
      await onSaved();
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  return (
    <form className="trigger-form" onSubmit={(e) => void onSubmit(e)} aria-label="Trigger form">
      <h3>{editing ? 'Edit trigger' : 'New trigger'}</h3>

      <label>
        Name
        <input
          type="text"
          value={form.name}
          onChange={(e) => onChange({ ...form, name: e.target.value })}
          required
        />
      </label>

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
        <label>
          Pipeline
          <select
            value={form.binding.pipelineId}
            onChange={(e) =>
              onChange({ ...form, binding: { kind: 'active', pipelineId: e.target.value } })
            }
          >
            {pipelines.map((p) => (
              <option key={p.pipelineId} value={p.pipelineId}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <label>
          Pipeline version
          <select
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
          >
            <option value="">— unbound —</option>
            {bindings.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </select>
        </label>
      )}

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

      <label>
        Mode
        <select
          value={form.mode}
          onChange={(e) => onChange(withMode(form, e.target.value as TriggerMode))}
        >
          {MODES.map((mode) => (
            <option key={mode} value={mode}>
              {mode}
            </option>
          ))}
        </select>
      </label>

      {form.mode === 'schedule' && (
        <>
          {/* Labelled by `htmlFor`/`id` rather than wrapped: wrapping folds every
           * option's text into the control's accessible name (#857). */}
          <label htmlFor={scheduleKindId}>Schedule authored as</label>
          <select
            id={scheduleKindId}
            value={form.scheduleKind}
            onChange={(e) => onChange({ ...form, scheduleKind: e.target.value as ScheduleKind })}
          >
            <option value="recurrence">Recurrence</option>
            <option value="cron">Cron expression</option>
          </select>

          {form.scheduleKind === 'recurrence' ? (
            <RecurrenceEditor
              value={form.recurrence}
              onChange={(recurrence) => onChange({ ...form, recurrence })}
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
            Event name
            <input
              type="text"
              value={form.event.name}
              onChange={(e) =>
                onChange({ ...form, event: { ...form.event, name: e.target.value } })
              }
              placeholder="order.placed"
              spellCheck={false}
            />
          </label>
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
              <code>{Object.keys(form.event.extras).sort().join(', ')}</code>, authored outside this
              form. There is no control for it here; it is preserved unchanged while this trigger
              stays in event mode, and the name cannot be cleared while it is there.
            </p>
          )}
        </>
      )}

      {form.mode === 'tumbling' && (
        <WindowEditor value={form.window} onChange={(window) => onChange({ ...form, window })} />
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

      <label>
        Concurrency
        <select
          value={form.concurrencyPolicy}
          disabled={form.mode === 'tumbling'}
          onChange={(e) =>
            onChange({ ...form, concurrencyPolicy: e.target.value as ConcurrencyPolicy })
          }
        >
          {POLICIES.map((policy) => (
            <option key={policy} value={policy}>
              {policy}
            </option>
          ))}
        </select>
      </label>

      {form.mode === 'tumbling' && (
        <p className="page-hint">
          A tumbling trigger must use <code>queue</code>: <code>skip_if_running</code> would drop a
          window&rsquo;s one materialization and strand it forever, and per-window parallelism is
          set by &ldquo;Max concurrent windows&rdquo; above rather than by the <code>parallel</code>{' '}
          policy.
        </p>
      )}

      {form.concurrencyPolicy === 'parallel' && (
        <label>
          Max parallel runs
          <input
            type="number"
            min={1}
            value={form.concurrencyMax}
            onChange={(e) => onChange({ ...form, concurrencyMax: e.target.value })}
            required
          />
        </label>
      )}

      <label className="checkbox">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(e) => onChange({ ...form, enabled: e.target.checked })}
        />
        Enabled (fires automatically per its mode)
      </label>

      <label>
        Params (JSON)
        <textarea
          value={form.paramsText}
          onChange={(e) => onChange({ ...form, paramsText: e.target.value })}
          rows={4}
          spellCheck={false}
        />
      </label>

      <RunWindowsEditor
        value={form.runWindows}
        onChange={(runWindows) => onChange({ ...form, runWindows })}
        mode={form.mode}
      />

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      <div className="form-actions">
        <button type="submit" disabled={saving}>
          {saving ? 'Saving…' : editing ? 'Save changes' : 'Create trigger'}
        </button>
        <button type="button" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}
