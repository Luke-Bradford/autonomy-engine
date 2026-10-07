import {
  ConcurrencyPolicySchema,
  TriggerModeSchema,
  type ConcurrencyPolicy,
  type TriggerMode,
  type PipelineVersion,
  type TriggerPublic,
} from '@autonomy-studio/shared';
import type { DisplayTimeZone } from '../../lib/displayTime';
import { blankEventForm, eventToForm, formToEvent, type EventFormState } from './eventForm';
import {
  blankWindowForm,
  formToWindow,
  windowToForm,
  WINDOW_FIELD_LABELS,
  WINDOW_FIELDS,
  type WindowFormState,
} from './windowForm';
import {
  blankRunWindowsForm,
  formToRunWindows,
  runWindowFields,
  runWindowsToForm,
  type RunWindowsFormState,
} from './runWindowsForm';
import {
  blankRecurrenceForm,
  formToRecurrence,
  RECURRENCE_FIELD_LABELS,
  RECURRENCE_FIELDS,
  recurrenceFieldShown,
  recurrenceToForm,
  type RecurrenceFormState,
  type ScheduleKind,
} from './recurrenceForm';

import { listAllPipelineVersions } from '../../api/pipelines';
import { bindingIsBound, type BindingSelection } from './binding';
import { notValidJson } from '../../lib/json/jsonText';
import { nameCheck, type FieldErrors } from '../../lib/form/fieldValidation';
import { payloadSignature } from '../pipeline/configForm';

export const MODES = TriggerModeSchema.options;
export const POLICIES = ConcurrencyPolicySchema.options;

/** A `pipelineVersionId` → human label, so a trigger's binding reads as
 * "Pipeline name v3" instead of an opaque id. Built once when the page loads. */
export interface BindingOption {
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
export interface PipelineOption {
  pipelineId: string;
  name: string;
  /** Every version of this pipeline this page knows about, for naming the active one. */
  versions: PipelineVersion[];
}

/**
 * Every pipeline's versions, as the form's binding options. The LOAD is shared
 * with the canvas's call-node target picker (`listAllPipelineVersions`); only
 * the option label is the trigger form's own. Used by the Triggers page and
 * the editor's Triggers column (#1476), so both offer the same pickers.
 */
export async function loadTriggerBindings(
  signal?: AbortSignal,
): Promise<{ options: BindingOption[]; pipelines: PipelineOption[] }> {
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
}

/**
 * #1476 OR28 — the triggers bound to one pipeline. A stored trigger names a
 * VERSION, so the match is on that pipeline's versions; `pipeline` null (not
 * among the loaded ones) matches nothing. Whether to filter at all is the
 * caller's: the Triggers page shows every trigger when it has no `?pipeline=`.
 */
export function triggersOfPipeline(
  triggers: readonly TriggerPublic[],
  pipeline: PipelineOption | null,
): TriggerPublic[] {
  const versionIds = new Set(pipeline?.versions.map((v) => v.id) ?? []);
  return triggers.filter(
    (t) => t.pipelineVersionId !== null && versionIds.has(t.pipelineVersionId),
  );
}

export type FormState = {
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
export function withMode(form: FormState, mode: TriggerMode): FormState {
  if (mode !== 'tumbling') return { ...form, mode };
  return { ...form, mode, concurrencyPolicy: 'queue', concurrencyMax: '' };
}

/**
 * #1396 — what Save would write, for the unsaved-changes guard. Only the
 * ACTIVE mode's config counts: Save sends every other mode's as `null`, so
 * typing an event name and then switching to manual changes nothing Save would
 * write, and is not an unsaved change.
 */
export function savePayloadSignature(form: FormState): string {
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

/** A new trigger's form. #1476 — the editor opens it already bound to the
 * pipeline it is editing; the Triggers page opens it unbound. #1524 — `zone` is
 * the viewer's display zone, which the start/end controls are written in. */
export function blankForm(
  zone: DisplayTimeZone,
  binding: BindingSelection = { kind: 'unbound' },
): FormState {
  return {
    id: null,
    name: '',
    binding,
    mode: 'manual',
    scheduleKind: 'recurrence',
    schedule: '',
    recurrence: blankRecurrenceForm(zone),
    event: blankEventForm(),
    window: blankWindowForm(zone),
    concurrencyPolicy: 'skip_if_running',
    concurrencyMax: '',
    enabled: false,
    paramsText: '{}',
    runWindows: blankRunWindowsForm(),
  };
}

export function formForEdit(t: TriggerPublic, zone: DisplayTimeZone): FormState {
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
      recurrence:
        t.recurrence !== null ? recurrenceToForm(t.recurrence, zone) : blankRecurrenceForm(zone),
      event: t.event !== null ? eventToForm(t.event) : blankEventForm(),
      window: t.window !== null ? windowToForm(t.window, zone) : blankWindowForm(zone),
      concurrencyPolicy: t.concurrency.policy,
      concurrencyMax: t.concurrency.max !== undefined ? String(t.concurrency.max) : '',
      enabled: t.enabled,
      paramsText: JSON.stringify(t.params, null, 2),
      runWindows: runWindowsToForm(t.runWindows),
    },
    t.mode,
  );
}

/** `params` must be a JSON object (`params` is a record); blank means `{}`. */
export function parseParamsText(
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
export function bindingKey(form: FormState): string {
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
export function modeFields(form: FormState): Readonly<Record<string, string>> {
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
export function modeChecks(form: FormState): FieldErrors {
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
export function triggerChecks(form: FormState): FieldErrors {
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
