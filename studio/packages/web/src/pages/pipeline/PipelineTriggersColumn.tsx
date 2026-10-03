import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Link } from 'react-router';
import type { TriggerNextFire, TriggerPublic } from '@autonomy-studio/shared';
import { DismissRegular } from '@fluentui/react-icons';
import { listTriggerNextFires, listTriggers } from '../../api/triggers';
import { useGuardedLoad } from '../../hooks/useGuardedLoad';
import { useTickingNow } from '../../hooks/useTickingNow';
import { useDrawerForm } from '../../lib/form/useDrawerForm';
import { TriggerModeName } from '../../lib/KindName';
import { TriggerForm } from '../triggers/TriggerForm';
import {
  blankForm,
  formForEdit,
  loadTriggerBindings,
  savePayloadSignature,
  triggersOfPipeline,
  type BindingOption,
  type PipelineOption,
} from '../triggers/triggerFormState';
import type { BindingSelection } from '../triggers/binding';
import { triggersPath } from '../triggers/triggersPath';
import { nextFireText } from './triggerColumnRules';

/**
 * #1476 OR28 slice 3 — this pipeline's triggers, in a column beside the editor:
 * Trigger ▾ → New trigger… / Edit triggers… create and edit them without leaving
 * the canvas. A column like version history (#1475), so opening it takes width
 * from the canvas and never moves its top (#1393).
 *
 * The form is the Triggers page's own (`TriggerForm`), opened in place of the
 * list. Its unsaved-changes guard holds NO route changes (`holdRoute: false`):
 * the editor already holds leaving its path, and the router consults only one
 * blocker, so this column reports `dirty` up and the editor folds it into that
 * one guard. In-column exits (Close, Cancel, another row's Edit) still go
 * through this guard's own prompt.
 *
 * Each row says when the trigger is next due (`nextFireText`), read from the
 * alarm the scheduler has armed. That read loads on its own: it only adds a
 * line of text, so its failure leaves the list as it was rather than taking
 * the list down with it.
 */
/** How often a shown next-fire time is re-checked against the clock. */
const NEXT_FIRE_TICK_MS = 30_000;

/**
 * A row's next-fire text. A leaf that owns its clock (`useTickingNow`), so a
 * time that passes while the column stays open turns into "now" rather than
 * sitting in the past; a row with nothing armed holds no timer.
 */
function NextFire({
  trigger,
  next,
}: {
  trigger: TriggerPublic;
  next: TriggerNextFire | undefined;
}) {
  if (next === undefined) return <NextFireLine text={nextFireText(trigger, undefined, 0)} />;
  return <TickingNextFire trigger={trigger} next={next} />;
}

function TickingNextFire({ trigger, next }: { trigger: TriggerPublic; next: TriggerNextFire }) {
  const now = useTickingNow(NEXT_FIRE_TICK_MS);
  return <NextFireLine text={nextFireText(trigger, next, now)} />;
}

function NextFireLine({ text }: { text: string | null }) {
  return text === null ? null : <>{` · ${text}`}</>;
}

export function PipelineTriggersColumn({
  pipelineId,
  headId,
  newBinding,
  newReason,
  newRequest,
  returnFocusTo,
  onClose,
  onDirtyChange,
}: {
  pipelineId: string;
  /** The latest saved version's id: a new one (a Save in the editor) reloads
   * the list, so its triggers and the form's version options stay current. */
  headId: string | null;
  /** What New trigger binds, or `null` when there is no saved version yet. */
  newBinding: BindingSelection | null;
  /** Why New trigger cannot be pressed (`newTriggerReason`), or `null`. */
  newReason: string | null;
  /** Bumped by the editor's Trigger ▾ → New trigger…; 0 = open on the list. */
  newRequest: number;
  /** The Trigger ▾ button: focus goes back to it when the column or a form closes. */
  returnFocusTo: RefObject<HTMLElement | null>;
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [triggers, setTriggers] = useState<TriggerPublic[] | null>(null);
  const [bindings, setBindings] = useState<BindingOption[]>([]);
  const [pipelines, setPipelines] = useState<PipelineOption[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [nextFires, setNextFires] = useState<Map<string, TriggerNextFire> | null>(null);
  const {
    form,
    setForm,
    openForm,
    seq: formSeq,
    guard,
    dirty,
    openerRef,
    openFrom,
    requestClose,
    closeIfLatest,
  } = useDrawerForm(savePayloadSignature, { holdRoute: false });

  // One load path, as on the Triggers page: both halves land together, and a
  // refresh after a save supersedes nothing it should not (`useGuardedLoad`).
  const guardedLoad = useGuardedLoad();
  // A second instance: one per state target (see `useGuardedLoad`).
  const guardedNextFiresLoad = useGuardedLoad();
  const refresh = useCallback(
    () =>
      Promise.all([
        guardedLoad((signal) => Promise.all([listTriggers(signal), loadTriggerBindings(signal)]), {
          onData: ([list, opts]) => {
            setTriggers(list);
            setBindings(opts.options);
            setPipelines(opts.pipelines);
            setLoadError(null);
          },
          onError: (err) => setLoadError(err instanceof Error ? err.message : String(err)),
        }),
        guardedNextFiresLoad(listTriggerNextFires, {
          onData: (list) => setNextFires(new Map(list.map((f) => [f.triggerId, f]))),
          // No times rather than wrong ones: a stale map could name a time the
          // scheduler has since moved.
          onError: () => setNextFires(null),
        }),
      ]),
    [guardedLoad, guardedNextFiresLoad],
  );
  useEffect(() => {
    void refresh();
  }, [refresh, headId]);

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  // Closing the column takes its draft with it, so it stops holding the editor.
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  // The editor's New trigger…, as a request through the guard: a dirty form
  // already open asks before it is replaced. Answered once the first load has
  // settled, so the form opens with its pipeline and version pickers filled
  // (and after the menu has handed focus back, so the form's Name field keeps
  // it). Each request is answered once, StrictMode's re-run included.
  const answeredRequest = useRef(0);
  const settled = triggers !== null || loadError !== null;
  useEffect(() => {
    if (!settled || newRequest <= answeredRequest.current) return;
    answeredRequest.current = newRequest;
    if (newBinding === null || newReason !== null) return;
    const opener = returnFocusTo.current;
    const open = () => openForm(blankForm(newBinding));
    if (opener === null) guard.request(open);
    else openFrom(opener, open);
    // Only a NEW request opens a form; the binding changing under an open one
    // (a version saved meanwhile) does not reopen it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newRequest, settled]);

  const pipeline = pipelines.find((p) => p.pipelineId === pipelineId) ?? null;
  const shown = useMemo(
    () => (triggers === null ? null : triggersOfPipeline(triggers, pipeline)),
    [triggers, pipeline],
  );
  // Every listed trigger is bound to one of `pipeline`'s versions (that is
  // what `triggersOfPipeline` matched on), so the lookup always finds it.
  const boundVersionText = (versionId: string | null): string => {
    const v = pipeline?.versions.find((x) => x.id === versionId);
    return v === undefined ? '' : `v${String(v.version)}`;
  };

  return (
    <aside
      className="pipeline-triggers"
      data-testid="pipeline-triggers"
      // Named by the list's heading even while it is hidden behind a form:
      // `aria-labelledby` reads hidden text.
      aria-labelledby="pipeline-triggers-heading"
    >
      {guard.routeHold}
      {/* Hidden, not unmounted, while a form is open: the Edit or New button
          that opened it must still be connected for focus to go back to it. */}
      <div className="pipeline-triggers__list-view" hidden={form !== null}>
        <div className="pipeline-triggers__header">
          <h3 id="pipeline-triggers-heading">Triggers</h3>
          <button
            type="button"
            className="icon-button editor-header__icon-button"
            aria-label="Close triggers"
            title="Close triggers"
            onClick={() => {
              onClose();
              returnFocusTo.current?.focus();
            }}
          >
            <DismissRegular aria-hidden="true" />
          </button>
        </div>
        {loadError !== null && (
          <p role="alert" className="error">
            {loadError}
          </p>
        )}
        {shown === null && loadError === null && <p>Loading triggers…</p>}
        {shown !== null && shown.length === 0 && (
          <p className="page-hint">No triggers fire this pipeline yet.</p>
        )}
        {shown !== null && shown.length > 0 && (
          <ul className="pipeline-triggers__list">
            {shown.map((t) => (
              <li key={t.id} className="pipeline-triggers__row">
                <div className="pipeline-triggers__summary">
                  <strong>{t.name}</strong>
                  <span className="pipeline-triggers__meta">
                    <TriggerModeName mode={t.mode} /> · {boundVersionText(t.pipelineVersionId)} ·{' '}
                    {t.enabled ? 'enabled' : 'disabled'}
                    {nextFires !== null && <NextFire trigger={t} next={nextFires.get(t.id)} />}
                  </span>
                </div>
                <button
                  type="button"
                  aria-label={`Edit: ${t.name}`}
                  onClick={(e) => openFrom(e.currentTarget, () => openForm(formForEdit(t)))}
                >
                  Edit
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="pipeline-triggers__actions">
          <button
            type="button"
            className="primary"
            disabled={newBinding === null || newReason !== null}
            title={newReason ?? undefined}
            onClick={(e) => {
              if (newBinding !== null) {
                openFrom(e.currentTarget, () => openForm(blankForm(newBinding)));
              }
            }}
          >
            New trigger
          </button>
          <Link to={triggersPath(pipelineId)}>All of this pipeline’s triggers →</Link>
        </div>
      </div>
      {form !== null && (
        <TriggerForm
          key={formSeq}
          form={form}
          bindings={bindings}
          pipelines={pipelines}
          onChange={setForm}
          guard={guard}
          returnFocusTo={openerRef}
          onClose={requestClose}
          onSaved={async () => {
            closeIfLatest(formSeq);
            await refresh();
          }}
        />
      )}
    </aside>
  );
}
