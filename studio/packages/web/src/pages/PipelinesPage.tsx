import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useStore } from 'zustand';
import type { Pipeline } from '@autonomy-studio/shared';
import { useBusyAction } from '../hooks/useBusyAction';
import { messageOf } from '../api/client';
import { downloadTextFile, exportFileName } from '../api/download';
import {
  archiveConfirmMessage,
  archivePipeline,
  createPipeline,
  deletePipeline,
  describeDeleteFailure,
  listArchivedPipelines,
  restorePipeline,
} from '../api/pipelines';
import { exportPipeline } from '../api/portability';
import { pipelinesStore, type PipelinesStore } from '../stores/pipelinesStore';
import { ImportPanel } from './ImportPanel';
import { pipelinePath } from './author/pipelinePath';

/**
 * Pipelines: list / create / delete, and open one on the authoring canvas.
 *
 * Since U4 this page is one of TWO views of the same list — the Factory
 * Resources pane beside it is the other, and both are mounted at once — so the
 * list lives in `pipelinesStore` rather than in this component. A create here
 * has to appear in the tree, and a delete in the tree has to disappear from
 * here; two independent `useState` copies could only be kept in step by luck.
 *
 * "Open" is a `<Link>` to the pipeline's own route, not local state. Before U4
 * the canvas replaced this page in place and had no address at all.
 *
 * The page is deliberately NOT reduced to a landing screen now that the pane
 * can do everything it does. The pane can be COLLAPSED (globally, and the
 * preference persists), and Author would then have no way to reach or create a
 * pipeline at all.
 */
export function PipelinesPage({ store = pipelinesStore }: { store?: PipelinesStore } = {}) {
  const status = useStore(store, (s) => s.status);
  const pipelines = useStore(store, (s) => s.pipelines);
  const loadError = useStore(store, (s) => s.error);
  const ensureFresh = useStore(store, (s) => s.ensureFresh);
  const retryIfFailed = useStore(store, (s) => s.retryIfFailed);
  const refresh = useStore(store, (s) => s.refresh);

  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);

  /**
   * #1058 — the ARCHIVED list, held here and deliberately NOT in
   * `pipelinesStore`. That store is the LIVE list, and it is shared with the
   * Factory Resources pane mounted beside this page; archived rows placed in it
   * would appear in that pane's tree as though they were still live.
   *
   * Its own status, not a bare array, for the reason the live list above is
   * gated on `status === 'ready'`: an empty list and a failed load are
   * different facts, and "No archived pipelines" is a lie about the second.
   * That matters more here than anywhere else on the page — this section IS the
   * way back out of archive, so a failure it renders as emptiness tells the
   * operator their pipeline is gone.
   *
   * `idle` doubles as "stale": archiving while the section is closed resets it,
   * so opening next refetches rather than showing a list missing the row that
   * was just archived. Nothing is fetched while it is closed.
   */
  const [showArchived, setShowArchived] = useState(false);
  const [archivedStatus, setArchivedStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle',
  );
  const [archived, setArchived] = useState<Pipeline[]>([]);
  const [archivedError, setArchivedError] = useState<string | null>(null);

  /**
   * #761 — this page is sticky for the same reason the Author pane was, by a
   * different route. It DOES remount on navigation, but `ensureFresh` refuses to
   * retry a failure, so the fresh mount was defeated on its own and the banner
   * survived every return to the page.
   *
   * For a route ELEMENT, a mount IS a route entry — React cannot distinguish a
   * first mount from a navigated-back one — so both calls belong in the one
   * effect. They cannot double-fetch: from `error`, `ensureFresh` stands down and
   * `retryIfFailed` loads; from `idle`/`ready`, `ensureFresh` loads and sets
   * `status:'loading'` synchronously, so `retryIfFailed` stands down. Exactly
   * one request either way.
   */
  useEffect(() => {
    ensureFresh();
    retryIfFailed();
  }, [ensureFresh, retryIfFailed]);

  const onCreate = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = name.trim();
      if (trimmed === '') return;
      setCreating(true);
      setActionMsg(null);
      try {
        await createPipeline({ name: trimmed });
        setName('');
        await refresh();
      } catch (err) {
        setActionMsg(`Could not create pipeline: ${messageOf(err)}`);
      } finally {
        setCreating(false);
      }
    },
    [name, refresh],
  );

  /**
   * Save the pipeline's export envelope to disk (#959). The fetch happens
   * first and its failure is REPORTED — a bare `<a download>` would have
   * written a 404 body to the operator's disk as a `.json` file with nothing
   * said (see `api/download.ts`).
   */
  /* #960 — per-row single-flight. The visible label deliberately does NOT
     change to "Exporting…": these buttons carry an `aria-label` naming the row,
     and a visible string absent from the accessible name violates WCAG 2.5.3
     (label in name). `disabled` + `aria-busy` is the affordance. */
  const { active: exporting, run: runExport } = useBusyAction();

  const onExport = useCallback(
    (p: Pipeline) =>
      runExport(p.id, async () => {
        setActionMsg(null);
        try {
          downloadTextFile(exportFileName('pipeline', p.name, p.id), await exportPipeline(p.id));
        } catch (err) {
          setActionMsg(`Could not export “${p.name}”: ${messageOf(err)}`);
        }
      }),
    [runExport],
  );

  const onDelete = useCallback(
    async (p: Pipeline) => {
      if (!window.confirm(`Delete pipeline "${p.name}"? This cannot be undone.`)) return;
      setActionMsg(null);
      try {
        await deletePipeline(p.id);
        await refresh();
      } catch (err) {
        // Shared with the Factory Resources row menu, which faces the same
        // 409 refusal — two hand-written copies had already drifted apart.
        setActionMsg(describeDeleteFailure(p.name, err));
      }
    },
    [refresh],
  );

  /**
   * Monotonic id of the most recently STARTED archived load. A load whose id is
   * no longer the latest has been superseded and drops its result on the floor.
   *
   * The same guard `pipelinesStore` holds for the live list (`latestLoad`), and
   * needed here for the same reason: two loads can be in flight at once and they
   * apply in COMPLETION order, so a slower OLDER answer can overwrite a newer
   * one. The concrete sequence — open the section, close it before it answers,
   * archive a pipeline (which invalidates the cache), reopen (a second load
   * fires and lands correctly), then the FIRST load finally resolves carrying a
   * list from before the archive and overwrites it. The section then renders
   * "No archived pipelines" over a pipeline that genuinely is archived, and
   * nothing refetches to self-correct.
   *
   * That is the precise lie this section's status triple exists to prevent, on
   * the one surface that is the way back out of archive — so it is worth a
   * counter rather than a comment. Two rapid Unarchive clicks race the same way.
   */
  const latestArchivedLoad = useRef(0);

  /**
   * Invalidate the archived set: mark it stale AND supersede any load already
   * in flight. The bump is the load-bearing half. Without it a load issued
   * before the invalidation can still land afterwards, pass the staleness
   * guard (nothing moved the counter), and write `ready` over this `idle` —
   * after which reopening sees a non-idle status and never refetches, so the
   * pre-invalidation answer sticks permanently.
   */
  const invalidateArchived = useCallback(() => {
    latestArchivedLoad.current += 1;
    setArchivedStatus('idle');
  }, []);

  /** Load the archived set, reporting a failure AS a failure (never as empty). */
  const loadArchived = useCallback(async () => {
    const id = (latestArchivedLoad.current += 1);
    setArchivedStatus('loading');
    setArchivedError(null);
    try {
      const items = await listArchivedPipelines();
      if (id !== latestArchivedLoad.current) return;
      setArchived(items);
      setArchivedStatus('ready');
    } catch (err) {
      // A superseded load's FAILURE is dropped too, not just its success: a late
      // rejection from an abandoned request must not bury the fresher answer
      // that replaced it under an error banner.
      if (id !== latestArchivedLoad.current) return;
      // The previous list is left in place: a refresh failure is not "we know
      // nothing", the same contract `pipelinesStore` holds for the live list.
      setArchivedStatus('error');
      setArchivedError(`Could not load archived pipelines: ${messageOf(err)}`);
    }
  }, []);

  /**
   * Whether the section is open, readable from an ASYNC callback. `onArchive`
   * runs across two awaits and must decide "refetch or invalidate" from
   * whether the section is open when it FINISHES, not when it was clicked —
   * the user can open or close it in between. Reading the state variable there
   * closes over the click-time value, which chose `invalidate` for a section
   * that was open by the time the invalidation landed, leaving it at `idle`
   * while open: no rows, no error, no "Loading…", and nothing to refetch it.
   */
  const showArchivedRef = useRef(showArchived);
  useEffect(() => {
    showArchivedRef.current = showArchived;
  }, [showArchived]);

  const onToggleArchived = useCallback(() => {
    const next = !showArchived;
    setShowArchived(next);
    // Fetch on OPEN, and only when there is nothing fresh to show — `idle` is
    // both "never loaded" and "invalidated by an archive". A closed section
    // never fetches.
    if (next && archivedStatus === 'idle') void loadArchived();
  }, [showArchived, archivedStatus, loadArchived]);

  /**
   * Archive: the soft-delete, and the ONLY way to retire a pipeline that has
   * ever run (`deletePipeline` is refused with a 409 once run history exists).
   *
   * The confirmation is where every consequence is named — the route discards
   * the `disabledTriggerIds` it computed, so nothing can be reported after the
   * fact even if we wanted to.
   */
  const onArchive = useCallback(
    async (p: Pipeline) => {
      if (!window.confirm(archiveConfirmMessage(p.name))) return;
      setActionMsg(null);
      try {
        await archivePipeline(p.id);
        // The row leaves the live list; the archived list it joins is now
        // stale. Refetch it when it is open, invalidate it when it is not.
        await refresh();
        if (showArchivedRef.current) await loadArchived();
        else invalidateArchived();
      } catch (err) {
        setActionMsg(`Could not archive “${p.name}”: ${messageOf(err)}`);
      }
    },
    [refresh, loadArchived, invalidateArchived],
  );

  /**
   * The way back. `restorePipeline` is the API verb; every string here says
   * UNARCHIVE, matching the canvas banner — "restore" already means restoring
   * an old VERSION on that screen (#903).
   */
  const onUnarchive = useCallback(
    async (p: Pipeline) => {
      setActionMsg(null);
      try {
        await restorePipeline(p.id);
        // Both lists change: the row leaves this one and rejoins the live one.
        await Promise.all([loadArchived(), refresh()]);
      } catch (err) {
        setActionMsg(`Could not unarchive “${p.name}”: ${messageOf(err)}`);
      }
    },
    [loadArchived, refresh],
  );

  return (
    <section aria-labelledby="pipelines-heading">
      <div className="page-header">
        <h2 id="pipelines-heading">Pipelines</h2>
      </div>
      <p className="page-hint">
        A pipeline is a graph of activities. Open one to build it on the canvas; saving creates a
        new immutable version that a trigger can bind to.
      </p>

      {loadError && (
        <p className="error" role="alert">
          {loadError}
        </p>
      )}
      {/* The page needs its OWN recovery control. `ensureFresh` deliberately
          does not retry from `error`, and the Factory Resources pane's Retry
          can be put away — pane collapse is a persisted GLOBAL preference, and
          a collapsed pane is `hidden`, so it is neither clickable nor
          focusable. Without this, a failed first load with a collapsed pane
          left no in-app way back at all. */}
      {status === 'error' && (
        <p>
          <button type="button" onClick={() => void refresh()}>
            Retry
          </button>
        </p>
      )}
      {/* Every message this carries is a FAILURE — a create, an export or a
          delete that did not happen — so it announces as an alert, matching
          the other three surfaces that report an export failure. */}
      {actionMsg && (
        <p className="error" role="alert">
          {actionMsg}
        </p>
      )}

      {/* Gated on a load having SUCCEEDED: an empty list and a failed load are
          different facts, and "no pipelines yet" is a lie about the second. */}
      {status === 'ready' && pipelines.length === 0 && <p>No pipelines yet — create one below.</p>}

      {pipelines.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th aria-label="actions" />
            </tr>
          </thead>
          <tbody>
            {pipelines.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>
                  {/* A link, so it can be middle-clicked, copied and bookmarked
                      — the navigation idiom U2 settled: `useNavigate` on a
                      button is only for navigating as the RESULT of an action. */}
                  <Link to={pipelinePath(p.id)} aria-label={`Open ${p.name}`}>
                    Open
                  </Link>
                  <button
                    type="button"
                    onClick={() => void onExport(p)}
                    aria-label={`Export ${p.name}`}
                    disabled={exporting.has(p.id)}
                    aria-busy={exporting.has(p.id)}
                  >
                    Export
                  </button>
                  {/* #1058 — sits BESIDE Delete on purpose. Delete is refused
                      with a 409 the moment the pipeline has run history, and
                      `describeDeleteFailure` (shared with the Factory Resources
                      pane, which has no Archive) says so without naming a way
                      out. The way out is this button, in the same row. */}
                  <button
                    type="button"
                    onClick={() => void onArchive(p)}
                    aria-label={`Archive ${p.name}`}
                  >
                    Archive
                  </button>
                  <button
                    type="button"
                    onClick={() => void onDelete(p)}
                    aria-label={`Delete ${p.name}`}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* #1058 — the ARCHIVED set. Behind a toggle rather than always on
          screen: it is a recovery surface, not part of the day-to-day list, and
          leaving it closed costs no request. Archiving is only safe to offer
          because this exists — "a refusal is safe exactly when the way back is
          reachable by the same person" (#907). It is also the way back from an
          archive this page did NOT perform: a git import soft-archives every
          resource absent from the branch. */}
      <section aria-labelledby="archived-heading">
        <h3 id="archived-heading">Archived</h3>
        <button type="button" onClick={onToggleArchived} aria-expanded={showArchived}>
          {showArchived ? 'Hide archived' : 'Show archived'}
        </button>

        {showArchived && (
          <>
            {archivedError && (
              <p className="error" role="alert">
                {archivedError}
              </p>
            )}
            {/* Its own Retry, for the same reason the live list has one: this
                section is the only in-app route back out of archive, so a
                failed load must not be a dead end. */}
            {archivedStatus === 'error' && (
              <p>
                <button type="button" onClick={() => void loadArchived()}>
                  Retry loading archived
                </button>
              </p>
            )}
            {archivedStatus === 'loading' && <p>Loading archived pipelines…</p>}
            {/* Gated on a load having SUCCEEDED — an empty list and a failed
                load are different facts, and this is the section where
                confusing them tells the operator their pipeline is gone. */}
            {archivedStatus === 'ready' && archived.length === 0 && <p>No archived pipelines.</p>}

            {archived.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th aria-label="actions" />
                  </tr>
                </thead>
                <tbody>
                  {archived.map((p) => (
                    <tr key={p.id}>
                      <td>{p.name}</td>
                      <td>
                        <button
                          type="button"
                          onClick={() => void onUnarchive(p)}
                          aria-label={`Unarchive ${p.name}`}
                        >
                          Unarchive
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </section>

      <form
        className="connection-form"
        aria-label="New pipeline"
        onSubmit={(e) => void onCreate(e)}
      >
        <h3>New pipeline</h3>
        <label>
          Name
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My pipeline"
          />
        </label>
        <div className="form-actions">
          <button type="submit" disabled={creating}>
            {creating ? 'Creating…' : 'Create pipeline'}
          </button>
        </div>
      </form>

      {/* The import surface lives here, on the list an imported pipeline lands
          in — but it takes ANY export envelope, because `POST /api/import` does
          (see `ImportPanel`). A connection or trigger file is imported and then
          reported with a pointer to its own section, rather than refused by a
          client-side rule the server does not have. */}
      <ImportPanel listKind="pipeline" onImported={refresh} />
    </section>
  );
}
