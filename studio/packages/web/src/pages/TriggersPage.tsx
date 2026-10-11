import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type TriggerPublic } from '@autonomy-studio/shared';
import { Link } from 'react-router';
import { useLatestSearchParams } from '../lib/useLatestSearchParams';
import { useDisplayTimeZone } from '../lib/useDisplayTimeZone';
import { triggersPath } from './triggers/triggersPath';
import { RUN_FILTER_PARAMS } from './runs/runFilters';
import { messageOf } from '../api/client';
import { downloadTextFile, exportFileName } from '../api/download';
import { exportTrigger } from '../api/portability';
import { ImportPanel } from './ImportPanel';

import { runDetailPath, runLinkLabel } from './runs/runPath';
import { useBusyAction } from '../hooks/useBusyAction';
import { useGuardedLoad } from '../hooks/useGuardedLoad';
import { deleteTrigger, fireTrigger, listTriggers, provisionWebhookSecret } from '../api/triggers';
import { LostSaveAlert } from '../lib/form/FormErrors';
import { useDrawerForm } from '../lib/form/useDrawerForm';
import { TriggerModeName } from '../lib/KindName';
import { useConfirm } from '../lib/confirm/useConfirm';
import { useFocusAfterRemoval } from '../hooks/useFocusAfterRemoval';
import { RowMoreMenu, type RowMenuOrigin } from '../lib/RowMoreMenu';
import { TriggerForm } from './triggers/TriggerForm';
import {
  blankForm,
  formForEdit,
  loadTriggerBindings,
  savePayloadSignature,
  triggersOfPipeline,
  type BindingOption,
  type PipelineOption,
} from './triggers/triggerFormState';
import { PageHeader, pageHelpId } from '../lib/PageHeader';
import { FORM_SECTION_HINTS } from '../lib/form/sectionHints';
import { OneLine } from '../lib/OneLine';

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
  const [confirm, confirmDialog] = useConfirm();
  /* #1524 — the display zone a new or opened form's start/end controls are
     written in, like every timestamp around them. */
  const zone = useDisplayTimeZone();
  const [triggers, setTriggers] = useState<TriggerPublic[] | null>(null);
  // #1470 — a removed row hands focus to its neighbour's ⋯, else to this.
  const createRef = useRef<HTMLButtonElement>(null);
  const { restoreFocus: removalFocus, removing: removingRow } = useFocusAfterRemoval(
    triggers,
    createRef,
  );
  /* One removal per row at a time, spanning the dialog and the request: with
     the delete in flight the row's ⋯ still works, and a second Delete would
     ask again and 404 into the banner over a delete that succeeded (#1470).
     `ConnectionsPage.onDelete` states the race. */
  const { run: runRemove } = useBusyAction();
  const [bindings, setBindings] = useState<BindingOption[]>([]);
  const [pipelines, setPipelines] = useState<PipelineOption[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const {
    form,
    setForm,
    openForm,
    seq: formSeq,
    lostSave,
    saveFailedFor,
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
      guardedLoad((signal) => Promise.all([listTriggers(signal), loadTriggerBindings(signal)]), {
        onData: ([list, opts]) => {
          setTriggers(list);
          setBindings(opts.options);
          setPipelines(opts.pipelines);
          setLoadError(null);
        },
        onError: (err) => setLoadError(err instanceof Error ? err.message : String(err)),
      }),
    [guardedLoad],
  );

  // `refresh` is stable (so is the runner it closes over),
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
    (t: TriggerPublic, origin: RowMenuOrigin) =>
      runRemove(t.id, async () => {
        const confirmed = await confirm({
          message: `Delete trigger "${t.name}"?`,
          confirmLabel: 'Delete',
          restoreFocus: removalFocus(origin),
        });
        if (!confirmed) return;
        const forget = removingRow(t.id, origin);
        try {
          await deleteTrigger(t.id);
          // A form open on the trigger just deleted would save to nothing.
          closeWhere((open) => open.id === t.id);
          await refresh();
        } catch (err) {
          forget();
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      }),
    [removalFocus, removingRow, runRemove, confirm, refresh, closeWhere],
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
  /* #960 — per-row single-flight. Since #1397 Export is an item in the row's
     menu, which shows it disabled while that row's export is in flight; the
     guard still refuses a second start, whatever asks. */
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
  /* #1476 OR28 — `?pipeline=` narrows the list to one pipeline's triggers (the
     editor's Trigger ▾ → View triggers). A stored trigger names a VERSION, so
     the match is on that pipeline's versions — the ones this page already
     loads. `null` = unfiltered. The URL is the only authority, as on Runs. */
  const [searchParams] = useLatestSearchParams();
  const pipelineFilter = searchParams.get(RUN_FILTER_PARAMS.pipelineId);
  const filterPipeline =
    pipelineFilter === null
      ? null
      : (pipelines.find((p) => p.pipelineId === pipelineFilter) ?? null);
  const shownTriggers = useMemo(
    () =>
      triggers === null || pipelineFilter === null
        ? triggers
        : triggersOfPipeline(triggers, filterPipeline),
    [triggers, pipelineFilter, filterPipeline],
  );

  const visibleOutcomes = useMemo(
    () =>
      shownTriggers === null
        ? fireOutcomes
        : fireOutcomes.filter((o) => shownTriggers.some((t) => t.id === o.triggerId)),
    [fireOutcomes, shownTriggers],
  );

  return (
    <section aria-labelledby="triggers-heading" aria-describedby={pageHelpId('triggers-heading')}>
      <PageHeader
        title="Triggers"
        headingId="triggers-heading"
        help={FORM_SECTION_HINTS.trigger.page}
      >
        <button
          ref={createRef}
          type="button"
          onClick={(e) => drawer.openFrom(e.currentTarget, () => openForm(blankForm(zone)))}
        >
          New trigger
        </button>
      </PageHeader>

      <LostSaveAlert message={lostSave} />
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

          {pipelineFilter !== null && (
            <p className="page-hint" data-testid="trigger-pipeline-filter">
              Showing the triggers of{' '}
              {filterPipeline !== null ? <strong>{filterPipeline.name}</strong> : 'one pipeline'}.{' '}
              <Link to={triggersPath()}>Show all triggers</Link>
            </p>
          )}

          {shownTriggers !== null && shownTriggers.length === 0 && (
            <p>
              {pipelineFilter !== null
                ? 'No triggers are bound to this pipeline yet.'
                : 'No triggers yet. Create one to bind a pipeline version and fire it.'}
            </p>
          )}

          {shownTriggers !== null && shownTriggers.length > 0 && (
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
                {shownTriggers.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <OneLine title={t.name}>{t.name}</OneLine>
                    </td>
                    <td>
                      <TriggerModeName mode={t.mode} />
                    </td>
                    <td>
                      <OneLine title={labelFor(t.pipelineVersionId)}>
                        {labelFor(t.pipelineVersionId)}
                      </OneLine>
                    </td>
                    <td>{t.enabled ? 'yes' : 'no'}</td>
                    <td>
                      <div className="row-actions">
                        {/* #1247 — the busy treatment is `disabled` + `aria-busy`, and the
                        visible label deliberately does NOT flip to "Firing…". This
                        button carries an `aria-label` naming the row, so a visible
                        string absent from that accessible name violates WCAG 2.5.3
                        (label in name).

                        The label is `Fire now: <name>` and NOT `Fire <name> now`, which is
                        what it was and which failed the same rule for a second reason: 2.5.3
                        is a literal SUBSTRING test, and infixing the row name split the
                        visible "Fire now" in half. Lead-then-detail is the shape `runLinkLabel`
                        already uses, and it is the only one that survives the check — hence
                        the assertion in the spec. */}
                        <button
                          type="button"
                          onClick={() => void onFire(t)}
                          disabled={firing.has(t.id)}
                          aria-busy={firing.has(t.id)}
                          aria-label={`Fire now: ${t.name}`}
                        >
                          Fire now
                        </button>
                        {/* #1397 — Fire now is the row's one inline action; the
                            rest are in its menu, Delete last. */}
                        <RowMoreMenu
                          name={t.name}
                          actions={[
                            {
                              label: 'Edit',
                              onSelect: (origin) =>
                                drawer.openFrom(origin.element, () =>
                                  openForm(formForEdit(t, zone)),
                                ),
                            },
                            {
                              label: 'Export',
                              onSelect: () => void onExport(t),
                              disabled: exporting.has(t.id),
                            },
                            ...(t.mode === 'webhook'
                              ? [
                                  {
                                    label: 'Provision webhook secret',
                                    onSelect: () => void onProvisionSecret(t),
                                  },
                                ]
                              : []),
                          ]}
                          destructive={{
                            label: 'Delete',
                            onSelect: (origin) => void onDelete(t, origin),
                          }}
                        />
                      </div>
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
            onSaveFailed={saveFailedFor(formSeq)}
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
      {confirmDialog}
    </section>
  );
}
