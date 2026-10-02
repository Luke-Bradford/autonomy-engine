import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { NavLink, useLocation, useMatch, useNavigate } from 'react-router';
import { useStore } from 'zustand';
import { Tooltip } from '@fluentui/react-components';
import {
  AddRegular,
  ChevronDownRegular,
  ChevronRightRegular,
  FolderRegular,
} from '@fluentui/react-icons';
import type { Pipeline } from '@autonomy-studio/shared';
import { messageOf } from '../../api/client';
import {
  createPipeline,
  deletePipeline,
  describeDeleteFailure,
  duplicatePipeline,
  movePipelineToFolder,
  renamePipeline,
} from '../../api/pipelines';
import { downloadPipelineExport } from '../../api/pipelineExport';
import { RowMoreMenu } from '../../lib/RowMoreMenu';
import { pipelinesStore, type PipelinesStore } from '../../stores/pipelinesStore';
import { pipelinePath } from './pipelinePath';
import type { Hub } from '../../shell/hubs';
import { useConfirm } from '../../lib/confirm/useConfirm';
import { useBusyAction } from '../../hooks/useBusyAction';
import { pipelineDeletePlan, readPipelineDependents } from '../pipelineDeleteConfirm';

/** The tree's own ids — the disclosure's `aria-controls` must name a real one. */
const PIPELINES_LIST_ID = 'factory-pipelines';
const NEW_PIPELINE_BUTTON_ID = 'factory-new-pipeline';

/** The route whose pipeline the canvas is currently editing, if any. */
const CANVAS_ROUTE = '/author/pipelines/:pipelineId';

/**
 * An in-progress text entry. Every action is "type one short label", so they
 * share one inline row rather than four dialogs.
 *
 * `create` and `duplicate` both MINT a pipeline, so their row sits at the top of
 * the tree where the new entry will appear; `rename` and `move` replace the row
 * they act on, which is where the user is already looking.
 *
 * For `move` (#1380) the text is the FOLDER, and empty is a real answer: it
 * means "no folder", where an empty pipeline name means nothing at all.
 */
type Draft =
  | { kind: 'create'; name: string }
  /* The whole source row, not just its id: a duplicate copies the source's
     `concurrency` cap and folder as well as its graph. */
  | { kind: 'duplicate'; source: Pipeline; name: string }
  | { kind: 'rename'; pipelineId: string; name: string }
  | { kind: 'move'; pipelineId: string; name: string };

/** The label on the draft row's confirm button — also how a test names it. */
const DRAFT_ACTION: Record<Draft['kind'], string> = {
  create: 'Create',
  duplicate: 'Duplicate',
  rename: 'Rename',
  move: 'Move',
};

/** The drafts that stand in for an existing row, rather than a new one. */
function replacesRow(draft: Draft): draft is Extract<Draft, { pipelineId: string }> {
  return draft.kind === 'rename' || draft.kind === 'move';
}

/** A folder and the (filtered) pipelines filed in it. */
interface FolderGroup {
  name: string;
  pipelines: Pipeline[];
}

/**
 * #1380 — split the list into folders, in name order, and the pipelines filed
 * nowhere, in the list's own order. A folder exists only while a pipeline is in
 * it: it is a label on the row, not a resource of its own.
 */
function groupByFolder(pipelines: readonly Pipeline[]): {
  folders: FolderGroup[];
  loose: Pipeline[];
} {
  const byName = new Map<string, Pipeline[]>();
  const loose: Pipeline[] = [];
  for (const p of pipelines) {
    if (p.folder === null) {
      loose.push(p);
      continue;
    }
    const filed = byName.get(p.folder);
    if (filed) filed.push(p);
    else byName.set(p.folder, [p]);
  }
  const folders = [...byName]
    .map(([name, filed]) => ({ name, pipelines: filed }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
  return { folders, loose };
}

interface FactoryResourcesProps {
  /** The Author hub, whose `sections[0]` is the tree's group header. */
  hub: Hub;
  /** Injected by tests; the app uses the shared singleton. */
  store?: PipelinesStore;
}

/**
 * Factory Resources — the Author hub's secondary-pane content (U4).
 *
 * A filter, a `+`, and one collapsible group of the workspace's pipelines, each
 * linking to its own canvas route and carrying a `⋯` menu of rename / duplicate
 * / delete.
 *
 * NOT an ARIA `tree`. A real `role="tree"` owes the user roving tabindex, typeahead
 * and arrow-key traversal, and a half-implemented tree is less usable than the
 * list it replaced. A disclosure button over a list of links is a well-trodden
 * pattern that browsers and screen readers already handle, and it keeps
 * `NavLink`'s `isActive` as the ONE source of "which one am I on" (the same reason
 * `@fluentui/react-nav` was rejected for the pane in U3: its `selectedValue` would
 * be a second opinion beside the router's).
 *
 * Folders (#1380) keep that shape rather than reopening it: each is the SAME
 * disclosure-over-a-list, one level down, so Tab still walks every control and
 * nothing depends on arrow keys. Folders are flat (a folder name may not contain
 * `/`), so this is the whole depth. Revisit if they ever nest, or when the tree
 * gains non-pipeline resources (U20) or a version picker under a pipeline (U22).
 *
 * The group HEADER is the hub's own section link, not a new label: `HUBS` stays
 * the single source of the pane's navigation, so the section still reaches the
 * list page and still supplies the breadcrumb.
 */
export function FactoryResources({ hub, store = pipelinesStore }: FactoryResourcesProps) {
  const [confirm, confirmDialog] = useConfirm();
  const navigate = useNavigate();
  const { key: locationKey } = useLocation();
  const editing = useMatch(CANVAS_ROUTE)?.params.pipelineId;

  const status = useStore(store, (s) => s.status);
  const pipelines = useStore(store, (s) => s.pipelines);
  const loadError = useStore(store, (s) => s.error);
  const ensureFresh = useStore(store, (s) => s.ensureFresh);
  const retryIfFailed = useStore(store, (s) => s.retryIfFailed);
  const refresh = useStore(store, (s) => s.refresh);

  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(true);
  /* #1380 — folders are open unless closed, so a new folder is never hidden. */
  const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(new Set());
  const folderIdPrefix = useId();
  const [draft, setDraft] = useState<Draft | null>(null);
  /**
   * Id of the control to hand focus back to when the DRAFT row closes.
   *
   * A ref, not state: nothing RENDERS from it, and reading it in the effect
   * below would otherwise force a `setState` inside that effect purely to clear
   * it — a cascading render for a value the UI never shows.
   *
   * Written only by `openDraft`, consumed only by the effect below. Drafts are
   * singular — there is at most one open — so this slot has no concurrency to
   * survive, which is exactly why the DELETE flow below does not share it.
   */
  const draftReturnFocus = useRef<string | null>(null);
  /**
   * Id of the row whose delete is in flight, if any.
   *
   * The row id rather than a focus target or a flag, and that is the whole
   * design: it makes the request SELF-INVALIDATING. The effect consumes it only
   * once that row is genuinely absent from the list, so a delete that failed
   * cannot be consumed by some later unrelated refresh — the row is still there.
   *
   * Deliberately NOT the save-and-restore-the-previous-value shape this started
   * out as. One slot holding two flows' state, unwound by whichever handler
   * happened to finish, produced three separate ordering bugs in review: a
   * failed delete leaving the slot armed for an unrelated mutation to trip; a
   * successful delete clobbering an open draft's target; and two concurrent
   * deletes where the first one's failure unwound to a value that predated the
   * second one's arming, stranding focus entirely. Two slots, one writer each,
   * and no unwinding retires that whole class rather than the next interleaving.
   */
  const deletingRow = useRef<string | null>(null);
  /**
   * How many mutations are in flight — a COUNT, not a boolean.
   *
   * The actions are not mutually exclusive: the row `⋯` menus stay live while a
   * draft is mid-submit, so a delete can be started on top of a duplicate. As a
   * boolean, whichever finished FIRST cleared the flag and lied about the other
   * still running — which re-enabled the draft's submit button under a request
   * that had not come back yet, so a second click minted a second copy.
   */
  const [pending, setPending] = useState(0);
  const busy = pending > 0;
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    ensureFresh();
  }, [ensureFresh]);

  /**
   * #761 — a NAVIGATION is a recovery opportunity.
   *
   * The effect above is mount-only (`ensureFresh` is a stable store fn), and
   * this pane does not unmount while the user moves around WITHIN Author — it
   * lives beside the `<Outlet/>`, not inside it. So a single transient 5xx used
   * to leave the banner up and the tree empty for the rest of the visit:
   * `ensureFresh` deliberately refuses to retry a failure, and nothing else ran.
   * The pane is the hub's primary navigation surface, so that reads as "the app
   * is broken" rather than "one request failed".
   *
   * Keyed on `location.key`, NOT on `pathname`. `key` is fresh for every history
   * entry, so it also catches a navigation to the path already showing — which is
   * the case the bug report actually described, and the one a user hits FIRST:
   * when the load that failed was the first one, the tree is empty, so the
   * group header (pointing at the active path) is the only link left in the pane.
   * Under a `pathname` key that click was inert and the pane stayed broken.
   *
   * NOT keyed on `status`. That would make this a hammer: a failed retry changes
   * `status`, which would re-run the effect, which would retry again — precisely
   * the storm the store's `error` guard exists to prevent. The status test
   * therefore lives INSIDE `retryIfFailed`, which is inert unless there is a
   * failure to retry, so navigating around a healthy server costs nothing.
   *
   * NOT `key={locationKey}` on the pane either: remounting it would refresh the
   * list by throwing away the operator's `query`, `expanded` and any open
   * `draft`.
   */
  useEffect(() => {
    retryIfFailed();
  }, [locationKey, retryIfFailed]);

  /**
   * The section the tree hangs beneath.
   *
   * A hub with custom pane content renders ONLY this one, so a hub that grew a
   * second section would silently lose it from the pane's navigation — the
   * exact class of quiet drop this project treats as a defect. Rather than
   * build speculative UI for a consumer that does not exist, `hubs.test.ts`
   * pins Author at exactly one section, so ADDING one fails loudly and lands
   * the decision on whoever adds it.
   */
  const section = hub.sections[0];

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return pipelines;
    return pipelines.filter((p) => p.name.toLowerCase().includes(needle));
  }, [pipelines, query]);

  /**
   * The draft as far as rendering is concerned.
   *
   * A rename whose pipeline disappears from under it — deleted in another tab,
   * then picked up by a refresh — would otherwise leave `draft` set with no row
   * to render it in: the editor silently vanishes and, because the focus effect
   * below needs a null draft, focus is never restored either. DERIVED rather
   * than reconciled in an effect: an effect would have to `setState` to fix
   * state it just observed, which is a cascading render for a fact the render
   * can simply compute.
   */
  const activeDraft = useMemo(
    () =>
      draft && replacesRow(draft) && !pipelines.some((p) => p.id === draft.pipelineId)
        ? null
        : draft,
    [draft, pipelines],
  );

  const grouped = useMemo(() => groupByFolder(visible), [visible]);
  /* Every folder in use, filter or not — what the move row offers to pick from. */
  const folderNames = useMemo(
    () => groupByFolder(pipelines).folders.map((f) => f.name),
    [pipelines],
  );

  /* Focus lives INSIDE the row being unmounted, so closing the draft — or
     deleting the row a menu was anchored to — would otherwise strand it on a
     removed element: focus falls to `<body>` and Tab restarts from the top of
     the document. The spec names focus restoration for panes explicitly, and
     the command bar's collapse toggle guards the same failure.

     An EFFECT rather than the handler, because React has not removed the row
     yet when the handler runs. It depends on `pipelines` as well as `draft`:
     a DELETE closes no draft, so the list changing is the only signal that the
     row is gone. */
  useEffect(() => {
    /* A draft owns focus for as long as it is open — it is where the user is
       looking, and its row still exists to hand focus back to. */
    if (activeDraft !== null) return;

    const target = draftReturnFocus.current;
    if (target !== null) {
      draftReturnFocus.current = null;
      /* A draft closing SUPERSEDES a completed delete: the delete's target is
         the `+` button, the draft's is the row it came from, and the latter is
         where the user's attention actually is. Dropping the delete's request
         rather than leaving it pending is what stops it firing later, on some
         unrelated refresh, once its row is long gone. */
      deletingRow.current = null;
      /* ...but the row it came from may itself be GONE. Only a `rename` or `move`
         draft replaces its row; a `duplicate` leaves the source row live and deletable
         underneath the open draft, and `activeDraft` never nulls out for it
         (that reconciliation is rename/move-only), so the delete's own restoration
         stands down and this branch is what eventually runs — against a `⋯`
         button that no longer exists. Falling back to the pane's one stable
         control is the difference between landing somewhere and stranding on
         `<body>`, which is the entire failure this mechanism exists to prevent. */
      const el = document.getElementById(target) ?? document.getElementById(NEW_PIPELINE_BUTTON_ID);
      el?.focus();
      return;
    }

    const deleted = deletingRow.current;
    /* Consumed only once the row is REALLY gone. A delete that failed leaves its
       row in the list, so this never fires for it — no unwinding needed, and no
       stale request for a later unrelated refresh to trip over. */
    if (deleted === null || pipelines.some((p) => p.id === deleted)) return;
    deletingRow.current = null;
    document.getElementById(NEW_PIPELINE_BUTTON_ID)?.focus();
  }, [activeDraft, pipelines]);

  const closeDraft = useCallback(() => {
    setDraft(null);
    setActionError(null);
  }, []);

  const openDraft = useCallback((next: Draft, focusBackTo: string) => {
    setDraft(next);
    draftReturnFocus.current = focusBackTo;
    setActionError(null);
  }, []);

  /**
   * Run one mutation, then refresh the shared list.
   *
   * The refresh is what keeps the pane and the pipelines page — mounted at the
   * same time, over the same data — from disagreeing. A FAILED mutation keeps
   * the draft row open with the typed name intact: re-typing a name to retry is
   * a punishment for the server's mistake.
   *
   * `pending` is stepped rather than set, so overlapping mutations each account
   * for themselves: the LAST one to finish is what drops the count to zero, not
   * the first.
   */
  const run = useCallback(
    async (action: () => Promise<unknown>, describe: (err: unknown) => string) => {
      setPending((n) => n + 1);
      setActionError(null);
      try {
        await action();
        await refresh();
        return true;
      } catch (err) {
        setActionError(describe(err));
        return false;
      } finally {
        setPending((n) => n - 1);
      }
    },
    [refresh],
  );

  const submitDraft = useCallback(async () => {
    if (!activeDraft) return;
    const draft = activeDraft;
    const name = draft.name.trim();
    if (name === '' && draft.kind !== 'move') return;
    /* A move into an EXISTING folder takes that folder's spelling: the pane
       groups by exact name, so `ops` typed beside `Ops` would otherwise split one
       folder in two — the same reason annotations refuse case-only duplicates. */
    const folder =
      draft.kind === 'move'
        ? (folderNames.find((f) => f.toLowerCase() === name.toLowerCase()) ?? name)
        : name;

    const ok = await run(
      () => {
        if (draft.kind === 'create') return createPipeline({ name });
        if (draft.kind === 'duplicate') return duplicatePipeline(draft.source, name);
        if (draft.kind === 'move') return movePipelineToFolder(draft.pipelineId, folder || null);
        return renamePipeline(draft.pipelineId, name);
      },
      (err) =>
        draft.kind === 'move'
          ? `Could not move to ${folder === '' ? 'the top level' : `“${folder}”`}: ${messageOf(err)}`
          : `Could not ${draft.kind} “${name}”: ${messageOf(err)}`,
    );
    if (!ok) return;
    closeDraft();
    /* A pipeline moved into a folder the user had collapsed would vanish from
       view the moment it arrived; open the folder it went to. */
    if (draft.kind === 'move' && folder !== '') {
      setCollapsedFolders((closed) => {
        if (!closed.has(folder)) return closed;
        const next = new Set(closed);
        next.delete(folder);
        return next;
      });
    }
  }, [activeDraft, closeDraft, folderNames, run]);

  /**
   * Export (#959). Deliberately NOT routed through `run`: `run` refreshes the
   * shared list because it exists for MUTATIONS, and an export changes nothing
   * — a refresh here would be a request that implies something moved. It is
   * single-flight per row through `useBusyAction` instead (#1470).
   */
  const { active: exporting, run: runExport } = useBusyAction();
  const onExport = useCallback(
    (p: Pipeline) =>
      // #1470 — single-flight per row: the menu can be reopened while the
      // download is still in flight, and choosing Export again is the second
      // click. Drawn disabled meanwhile, as the Pipelines table does.
      runExport(p.id, async () => {
        setActionError(null);
        try {
          await downloadPipelineExport(p);
        } catch (err) {
          setActionError(`Could not export “${p.name}”: ${messageOf(err)}`);
        }
      }),
    [runExport],
  );

  const onDelete = useCallback(
    async (p: Pipeline) => {
      // #1397 — read what the delete takes with it, so the question names it.
      const plan = pipelineDeletePlan(p.name, await readPipelineDependents(p.id));
      if (plan.kind === 'refused') {
        // No dialog opened, so the menu hands focus back to ⋯ itself.
        setActionError(plan.message);
        return;
      }
      const confirmed = await confirm({
        message: plan.message,
        confirmLabel: 'Delete',
        ...(plan.typeToConfirm !== undefined ? { typeToConfirm: plan.typeToConfirm } : {}),
        // The menu item that asked unmounts with its menu; Cancel lands back
        // on the row's ⋯ button, which is where the keyboard user came from.
        restoreFocus: () => document.getElementById(rowMenuId(p.id)),
      });
      if (!confirmed) return;
      /* The row — and the Fluent menu anchored to it — is about to be unmounted
         by the refresh, so focus needs somewhere to land. Fluent restores focus
         to its trigger on close, which by then is gone.

         Recorded BEFORE the await, not after: `run` refreshes the list as part
         of succeeding, so by the time it returns, the change the effect watches
         has already been committed. */
      deletingRow.current = p.id;
      const ok = await run(
        () => deletePipeline(p.id),
        (err) => describeDeleteFailure(p.name, err),
      );
      if (!ok) {
        /* Compare-and-clear, never a blind reset: with two deletes in flight the
           second one's id is in the slot, and clearing it outright would strand
           the focus IT is waiting on. Leaving a stale id would be harmless
           anyway — the effect ignores a row that is still listed — but dropping
           our own keeps the slot honest. */
        if (deletingRow.current === p.id) deletingRow.current = null;
        return;
      }
      /* Leaving the canvas mounted on a pipeline that no longer exists would
         show a stale graph over a 404 on the next load. Only when it IS the
         open one — deleting a different pipeline must not yank the user out of
         what they are editing.

         AFTER `run`, not inside it: a navigation that threw would otherwise be
         reported as "could not delete" for a delete that had already succeeded,
         and would skip the refresh, leaving the deleted row in the tree.

         `replace`, per the house rule `routes.tsx` states for exactly this: a
         pushed navigation leaves the dead pipeline's URL in history, so Back
         lands on "Pipeline not found". */
      if (editing === p.id) await navigate(section?.path ?? hub.path, { replace: true });
    },
    [confirm, editing, hub.path, navigate, run, section],
  );

  /** One pipeline's row — or the draft standing in for it (rename, move). */
  const renderRow = (p: Pipeline) =>
    activeDraft && replacesRow(activeDraft) && activeDraft.pipelineId === p.id ? (
      <li key={p.id}>
        <NameRow
          draft={activeDraft}
          busy={busy}
          folderNames={folderNames}
          onChange={(name) => setDraft({ ...activeDraft, name })}
          onSubmit={() => void submitDraft()}
          onCancel={closeDraft}
        />
      </li>
    ) : (
      <li key={p.id} className="factory-resources__row">
        <NavLink
          to={pipelinePath(p.id)}
          className={({ isActive }) =>
            `secondary-pane__link${isActive ? ' secondary-pane__link--active' : ''}`
          }
        >
          {p.name}
        </NavLink>
        {/* #1397 — the shared row menu. Its own label, because on the
            Pipelines page the table beside this pane has a menu for the same
            pipeline ("Actions for …"). Delete is last, separated, in red. */}
        <RowMoreMenu
          name={p.name}
          label={`More actions for ${p.name}`}
          id={rowMenuId(p.id)}
          className="factory-resources__icon-button"
          actions={[
            {
              label: 'Rename',
              onSelect: () =>
                openDraft({ kind: 'rename', pipelineId: p.id, name: p.name }, rowMenuId(p.id)),
            },
            {
              label: 'Move to folder…',
              onSelect: () =>
                openDraft(
                  { kind: 'move', pipelineId: p.id, name: p.folder ?? '' },
                  rowMenuId(p.id),
                ),
            },
            {
              label: 'Duplicate',
              onSelect: () => {
                setExpanded(true);
                openDraft(
                  { kind: 'duplicate', source: p, name: `${p.name} (copy)` },
                  rowMenuId(p.id),
                );
              },
            },
            { label: 'Export', onSelect: () => void onExport(p), disabled: exporting.has(p.id) },
          ]}
          destructive={{ label: 'Delete', onSelect: () => void onDelete(p) }}
        />
      </li>
    );

  const listLabel = section?.label ?? hub.label;

  return (
    <div className="factory-resources">
      <div className="factory-resources__toolbar">
        <input
          type="search"
          className="factory-resources__filter"
          aria-label="Filter pipelines"
          placeholder="Filter"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {/* Named twice over, like the rail's icon-only links: an `aria-label`
            so the accessible name is not "" from an `aria-hidden` glyph, and a
            tooltip for sighted pointer/keyboard users. */}
        <Tooltip content="New pipeline" relationship="label" positioning="below">
          <button
            id={NEW_PIPELINE_BUTTON_ID}
            type="button"
            className="icon-button factory-resources__icon-button"
            aria-label="New pipeline"
            /* Opening a create draft REPLACES whatever draft is open, so while a
               rename/duplicate is mid-submit this would throw away the name the
               user is waiting on — with the request still in flight.

               Gated on a draft actually being in flight, not on `busy` alone,
               and that is load-bearing rather than fussy: this button is also
               the focus-restoration target a delete hands back to, and a
               DISABLED element cannot take focus. The effect below only ever
               restores while `activeDraft === null` — precisely when this
               condition leaves the button enabled — so the two cannot collide.
               `disabled={busy}` would strand focus on `<body>` whenever two
               deletes overlapped. */
            disabled={busy && activeDraft !== null}
            onClick={() => {
              setExpanded(true);
              openDraft({ kind: 'create', name: '' }, NEW_PIPELINE_BUTTON_ID);
            }}
          >
            <AddRegular aria-hidden="true" />
          </button>
        </Tooltip>
      </div>

      <div className="factory-resources__group">
        <button
          type="button"
          className="icon-button factory-resources__disclosure"
          aria-expanded={expanded}
          aria-controls={PIPELINES_LIST_ID}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${listLabel}`}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? (
            <ChevronDownRegular aria-hidden="true" />
          ) : (
            <ChevronRightRegular aria-hidden="true" />
          )}
        </button>
        {section && (
          <NavLink
            to={section.path}
            end
            className={({ isActive }) =>
              `secondary-pane__link factory-resources__group-link${
                isActive ? ' secondary-pane__link--active' : ''
              }`
            }
          >
            {section.label}
          </NavLink>
        )}
      </div>

      <ul
        id={PIPELINES_LIST_ID}
        className="secondary-pane__list factory-resources__list"
        aria-label={listLabel}
        hidden={!expanded}
      >
        {activeDraft && !replacesRow(activeDraft) && (
          <li>
            <NameRow
              draft={activeDraft}
              busy={busy}
              folderNames={folderNames}
              onChange={(name) => setDraft({ ...activeDraft, name })}
              onSubmit={() => void submitDraft()}
              onCancel={closeDraft}
            />
          </li>
        )}

        {grouped.folders.map((folder, i) => {
          const open = !collapsedFolders.has(folder.name);
          /* An index, not the name: a folder name may hold a space, and an id
             is one token. */
          const listId = `${folderIdPrefix}-folder-${i}`;
          return (
            <li key={`folder:${folder.name}`} className="factory-resources__folder">
              <div className="factory-resources__folder-header">
                <button
                  type="button"
                  className="icon-button factory-resources__disclosure"
                  aria-expanded={open}
                  aria-controls={listId}
                  aria-label={`${open ? 'Collapse' : 'Expand'} folder ${folder.name}`}
                  onClick={() =>
                    setCollapsedFolders((closed) => {
                      const next = new Set(closed);
                      if (!next.delete(folder.name)) next.add(folder.name);
                      return next;
                    })
                  }
                >
                  {open ? (
                    <ChevronDownRegular aria-hidden="true" />
                  ) : (
                    <ChevronRightRegular aria-hidden="true" />
                  )}
                </button>
                <FolderRegular aria-hidden="true" className="factory-resources__folder-icon" />
                <span className="factory-resources__folder-name">{folder.name}</span>
              </div>
              <ul
                id={listId}
                className="secondary-pane__list factory-resources__folder-list"
                aria-label={`Folder ${folder.name}`}
                hidden={!open}
              >
                {folder.pipelines.map(renderRow)}
              </ul>
            </li>
          );
        })}

        {grouped.loose.map(renderRow)}
      </ul>

      {/* "There are none" and "we could not find out" are different facts, so
          the empty state is gated on a load having actually SUCCEEDED. */}
      {expanded && status === 'ready' && pipelines.length === 0 && !activeDraft && (
        <p className="factory-resources__empty">No pipelines yet — use + to create one.</p>
      )}
      {expanded && pipelines.length > 0 && visible.length === 0 && (
        <p className="factory-resources__empty">No pipelines match “{query.trim()}”.</p>
      )}

      {/* The two failures are reported SEPARATELY, and only one of them is an
          `alert`. A failed mutation is the direct result of something the user
          just did, so it interrupts; a failed LOAD is also being announced by
          the pipelines page mounted beside this pane, and two `role="alert"`s
          carrying one message means a screen reader says it twice. */}
      {loadError && <p className="factory-resources__error">{loadError}</p>}
      {status === 'error' && (
        <div className="factory-resources__empty">
          {/* Rendered whatever else has gone wrong. Gating this on
              `!actionError` meant a failed load followed by a failed create hid
              the only way back. */}
          <button type="button" onClick={() => void refresh()} disabled={busy}>
            Retry
          </button>
        </div>
      )}
      {actionError && (
        <p className="factory-resources__error" role="alert">
          {actionError}{' '}
          {/* A failed DELETE closes no draft row, so nothing else would ever
              clear this: the pane outlives every route change inside the hub,
              and the message would sit there indefinitely — including after the
              pipeline it names has been filtered out of view. */}
          <button
            type="button"
            className="factory-resources__dismiss"
            onClick={() => setActionError(null)}
          >
            Dismiss
          </button>
        </p>
      )}
      {confirmDialog}
    </div>
  );
}

/** The `⋯` trigger's id, so a closing draft row can hand focus back to it. */
function rowMenuId(pipelineId: string): string {
  return `factory-row-menu-${pipelineId}`;
}

interface NameRowProps {
  draft: Draft;
  busy: boolean;
  /** #1380 — the folders already in use, offered while moving. */
  folderNames: readonly string[];
  onChange: (name: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

/**
 * The inline name row shared by create / duplicate / rename.
 *
 * A row rather than a Fluent `Dialog`: the shell has deliberately hand-rolled
 * over Fluent's heavier surfaces where capability was not the blocker (U3's
 * breadcrumb, U2's rail), the U0 spike set a bundle budget a `Dialog` import
 * spends (#1397 has since paid it for confirmations, +6.35 kB gzip, where a
 * modal question IS the interaction), and renaming in place is what a resources
 * tree does — a modal to type six characters into is a worse interaction, not a
 * better one.
 *
 * `autoFocus` is correct here and not the usual anti-pattern: the row only
 * exists because the user just asked for it, and its whole purpose is to be
 * typed into.
 */
function NameRow({ draft, busy, folderNames, onChange, onSubmit, onCancel }: NameRowProps) {
  const suggestions = useId();
  const moving = draft.kind === 'move';
  const label = moving ? 'Folder' : 'Pipeline name';
  return (
    <form
      className="factory-resources__name-row"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <input
        type="text"
        aria-label={label}
        placeholder={moving ? 'Folder (empty for none)' : label}
        /* Picking an existing folder beats retyping it: two spellings of one
           folder would split it in two. */
        list={moving ? suggestions : undefined}
        value={draft.name}
        disabled={busy}
        autoFocus
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          /* Escape cancels. `stopPropagation` so it does not also travel up to
             any ancestor that treats Escape as "close me" — the pane sits
             inside no such surface today, but the row is portable and the cost
             is one call. */
          if (e.key === 'Escape') {
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      {moving && (
        <datalist id={suggestions}>
          {folderNames.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      )}
      {/* An empty folder means "no folder", so only a NAME must be non-empty. */}
      <button type="submit" disabled={busy || (!moving && draft.name.trim() === '')}>
        {DRAFT_ACTION[draft.kind]}
      </button>
      <button type="button" onClick={onCancel} disabled={busy}>
        Cancel
      </button>
    </form>
  );
}
