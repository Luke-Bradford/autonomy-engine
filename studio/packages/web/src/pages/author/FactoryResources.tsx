import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useMatch, useNavigate } from 'react-router';
import { useStore } from 'zustand';
import {
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Tooltip,
} from '@fluentui/react-components';
import {
  AddRegular,
  ChevronDownRegular,
  ChevronRightRegular,
  MoreHorizontalRegular,
} from '@fluentui/react-icons';
import type { Pipeline } from '@autonomy-studio/shared';
import { messageOf } from '../../api/client';
import {
  createPipeline,
  deletePipeline,
  describeDeleteFailure,
  duplicatePipeline,
  renamePipeline,
} from '../../api/pipelines';
import { pipelinesStore, type PipelinesStore } from '../../stores/pipelinesStore';
import { pipelinePath } from './pipelinePath';
import type { Hub } from '../../shell/hubs';

/** The tree's own ids — the disclosure's `aria-controls` must name a real one. */
const PIPELINES_LIST_ID = 'factory-pipelines';
const NEW_PIPELINE_BUTTON_ID = 'factory-new-pipeline';

/** The route whose pipeline the canvas is currently editing, if any. */
const CANVAS_ROUTE = '/author/pipelines/:pipelineId';

/**
 * An in-progress name entry. All three actions are "give me a name", so they
 * share one inline row rather than three dialogs.
 *
 * `create` and `duplicate` both MINT a pipeline, so their row sits at the top of
 * the tree where the new entry will appear; `rename` replaces the row it acts on,
 * which is where the user is already looking.
 */
type Draft =
  | { kind: 'create'; name: string }
  /* The whole source row, not just its id: a duplicate copies the source's
     `concurrency` cap as well as its graph. */
  | { kind: 'duplicate'; source: Pipeline; name: string }
  | { kind: 'rename'; pipelineId: string; name: string };

/** The label on the draft row's confirm button — also how a test names it. */
const DRAFT_ACTION: Record<Draft['kind'], string> = {
  create: 'Create',
  duplicate: 'Duplicate',
  rename: 'Rename',
};

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
 * and arrow-key traversal across a structure that is, today, one flat group — and
 * a half-implemented tree is less usable than the list it replaced. A disclosure
 * button over a list of links is a well-trodden pattern that browsers and screen
 * readers already handle, and it keeps `NavLink`'s `isActive` as the ONE source of
 * "which one am I on" (the same reason `@fluentui/react-nav` was rejected for the
 * pane in U3: its `selectedValue` would be a second opinion beside the router's).
 * When U5/U20 give the tree real nesting, revisit.
 *
 * The group HEADER is the hub's own section link, not a new label: `HUBS` stays
 * the single source of the pane's navigation, so the section still reaches the
 * list page and still supplies the breadcrumb.
 */
export function FactoryResources({ hub, store = pipelinesStore }: FactoryResourcesProps) {
  const navigate = useNavigate();
  const editing = useMatch(CANVAS_ROUTE)?.params.pipelineId;

  const status = useStore(store, (s) => s.status);
  const pipelines = useStore(store, (s) => s.pipelines);
  const loadError = useStore(store, (s) => s.error);
  const ensureFresh = useStore(store, (s) => s.ensureFresh);
  const refresh = useStore(store, (s) => s.refresh);

  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  /**
   * Id of the control to hand focus back to when the draft row closes.
   *
   * A ref, not state: nothing RENDERS from it, and reading it in the effect
   * below would otherwise force a `setState` inside that effect purely to clear
   * it — a cascading render for a value the UI never shows.
   */
  const returnFocusTo = useRef<string | null>(null);
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
      draft?.kind === 'rename' && !pipelines.some((p) => p.id === draft.pipelineId) ? null : draft,
    [draft, pipelines],
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
    if (activeDraft !== null) return;
    const target = returnFocusTo.current;
    if (target === null) return;
    returnFocusTo.current = null;
    document.getElementById(target)?.focus();
  }, [activeDraft, pipelines]);

  const closeDraft = useCallback(() => {
    setDraft(null);
    setActionError(null);
  }, []);

  const openDraft = useCallback((next: Draft, focusBackTo: string) => {
    setDraft(next);
    returnFocusTo.current = focusBackTo;
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
    if (name === '') return;

    const ok = await run(
      () => {
        if (draft.kind === 'create') return createPipeline({ name });
        if (draft.kind === 'duplicate') return duplicatePipeline(draft.source, name);
        return renamePipeline(draft.pipelineId, name);
      },
      (err) => `Could not ${draft.kind} “${name}”: ${messageOf(err)}`,
    );
    if (ok) closeDraft();
  }, [activeDraft, closeDraft, run]);

  const onDelete = useCallback(
    async (p: Pipeline) => {
      if (!window.confirm(`Delete pipeline “${p.name}”? This cannot be undone.`)) return;
      /* The row — and the Fluent menu anchored to it — is about to be unmounted
         by the refresh, so focus needs somewhere to land. Fluent restores focus
         to its trigger on close, which by then is gone.

         One slot, two independent restoration flows, so a delete claims it only
         when it is genuinely free to claim:

         - a DRAFT open on another row already owns the slot, and the effect
           below will not restore for this delete regardless — it stands down
           while `activeDraft !== null`. Arming here could therefore never help,
           and would permanently overwrite the draft's target, sending focus to
           `+` instead of back to the row the draft came from when it closes;
         - a delete that FAILS must leave the slot exactly as it found it. It
           removed no row, so there is nothing to hand focus back FROM, and
           nothing will ever consume the request either — the failure path skips
           the refresh the effect watches. Left armed it stays armed until the
           SHARED list next changes for an unrelated reason (the pipelines page,
           mounted beside this pane, creating or deleting) and steals focus then. */
      const focusBefore = returnFocusTo.current;
      if (activeDraft === null) returnFocusTo.current = NEW_PIPELINE_BUTTON_ID;
      const ok = await run(
        () => deletePipeline(p.id),
        (err) => describeDeleteFailure(p.name, err),
      );
      if (!ok) {
        returnFocusTo.current = focusBefore;
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
    [activeDraft, editing, hub.path, navigate, run, section],
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
            className="factory-resources__icon-button"
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
          className="factory-resources__disclosure"
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
        {activeDraft && activeDraft.kind !== 'rename' && (
          <li>
            <NameRow
              draft={activeDraft}
              busy={busy}
              onChange={(name) => setDraft({ ...activeDraft, name })}
              onSubmit={() => void submitDraft()}
              onCancel={closeDraft}
            />
          </li>
        )}

        {visible.map((p) =>
          activeDraft?.kind === 'rename' && activeDraft.pipelineId === p.id ? (
            <li key={p.id}>
              <NameRow
                draft={activeDraft}
                busy={busy}
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
              <Menu>
                <MenuTrigger disableButtonEnhancement>
                  <button
                    id={rowMenuId(p.id)}
                    type="button"
                    className="factory-resources__icon-button"
                    aria-label={`More actions for ${p.name}`}
                  >
                    <MoreHorizontalRegular aria-hidden="true" />
                  </button>
                </MenuTrigger>
                {/* Fluent's DEFAULT body portal — the U0 spike forbids
                    reparenting a surface into the React Flow viewport, and the
                    pane clips its own overflow, so an in-flow popover would be
                    sliced off at the pane's edge. */}
                <MenuPopover>
                  <MenuList>
                    <MenuItem
                      onClick={() =>
                        openDraft(
                          { kind: 'rename', pipelineId: p.id, name: p.name },
                          rowMenuId(p.id),
                        )
                      }
                    >
                      Rename
                    </MenuItem>
                    <MenuItem
                      onClick={() => {
                        setExpanded(true);
                        openDraft(
                          { kind: 'duplicate', source: p, name: `${p.name} (copy)` },
                          rowMenuId(p.id),
                        );
                      }}
                    >
                      Duplicate
                    </MenuItem>
                    <MenuItem onClick={() => void onDelete(p)}>Delete</MenuItem>
                  </MenuList>
                </MenuPopover>
              </Menu>
            </li>
          ),
        )}
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
  onChange: (name: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

/**
 * The inline name row shared by create / duplicate / rename.
 *
 * A row rather than a Fluent `Dialog`: the shell has deliberately hand-rolled
 * over Fluent's heavier surfaces where capability was not the blocker (U3's
 * breadcrumb, U2's rail), the U0 spike set a bundle budget that a first `Dialog`
 * import would spend, and renaming in place is what a resources tree does — a
 * modal to type six characters into is a worse interaction, not a better one.
 *
 * `autoFocus` is correct here and not the usual anti-pattern: the row only
 * exists because the user just asked for it, and its whole purpose is to be
 * typed into.
 */
function NameRow({ draft, busy, onChange, onSubmit, onCancel }: NameRowProps) {
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
        aria-label="Pipeline name"
        placeholder="Pipeline name"
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
      <button type="submit" disabled={busy || draft.name.trim() === ''}>
        {DRAFT_ACTION[draft.kind]}
      </button>
      <button type="button" onClick={onCancel} disabled={busy}>
        Cancel
      </button>
    </form>
  );
}
