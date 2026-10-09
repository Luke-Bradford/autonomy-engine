import { useId, useMemo, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import {
  ChevronDownRegular,
  ChevronRightRegular,
  PanelLeftContractRegular,
  PanelLeftExpandRegular,
} from '@fluentui/react-icons';
import { useStore, type StoreApi } from 'zustand';
import type { ContainerKind } from '@autonomy-studio/shared';
import { setActivityDragType, setContainerDragKind } from './activityDnd';
import { ActivityGlyph } from './ActivityGlyph';
import { CONTAINER_GROUP_LABEL, containerToolboxEntries, toolboxGroups } from './activityGroups';
import type { CanvasState } from './canvasStore';
import { NEW_CONTAINER_CONFIRM, newContainerQuestion } from './containerRules';
import { useConfirm } from '../../lib/confirm/useConfirm';
import { uiStore } from '../../stores/uiStore';

/** The Containers group's collapse key — not a catalog category, so it cannot collide with one. */
const CONTAINERS_KEY = 'containers';

/**
 * The Activities toolbox (U5) — the canvas's searchable, categorized palette.
 *
 * Replaces the flat MVP palette (one ungrouped button per catalog entry). Each
 * entry can be ADDED two ways, and the pair is deliberate:
 *
 *  - **click / Enter / Space** adds the node at a staggered default position;
 *  - **drag onto the canvas** adds it where the pointer released.
 *
 * The click path is not a legacy leftover. HTML5 drag has no keyboard equivalent
 * at all, and WCAG 2.2 SC 2.5.7 (Dragging Movements) requires a single-pointer
 * alternative to every drag action — so the button IS the accessible path and the
 * drag is a progressive enhancement layered on it. That is also why each entry is
 * a real `<button>` carrying `draggable`, rather than a `<div>` with a drag
 * handler: the element is keyboard-focusable and activatable for free.
 *
 * It stays in the canvas grid's left column rather than moving into the Author
 * hub's secondary pane. The pane is GLOBAL and collapsible with a persisted
 * preference (U3), while the toolbox is meaningful only while a pipeline is open
 * — an operator who collapsed the pane to widen the canvas would lose the ability
 * to add activities to the canvas they just widened. (Same reasoning U4 used to
 * keep the pipelines PAGE alive alongside the pane tree.)
 *
 * #1475 OR27 — folded, the toolbox is an ICON RAIL, not gone: the same
 * entries as glyph-only buttons, still added by click or drag, so an operator
 * who gave the canvas the toolbox's width can still author on it (the reason
 * above, again). The fold is a per-viewer `uiStore` preference, like the
 * dock's; the divider that sizes the open toolbox is the canvas grid's
 * (`PipelineCanvas.tsx`).
 */
export function ActivityToolbox({ store, id }: { store: StoreApi<CanvasState>; id?: string }) {
  const [confirm, confirmDialog] = useConfirm();
  const rail = useStore(uiStore, (s) => s.toolboxCollapsed);
  const setRail = useStore(uiStore, (s) => s.setToolboxCollapsed);

  /** A container from the palette by click — the drop's confirm, so the two ways to add one agree. */
  async function addContainer(kind: ContainerKind, title: string) {
    const question = newContainerQuestion(store.getState(), kind, title);
    if (question !== null && !(await confirm({ message: question, ...NEW_CONTAINER_CONFIRM }))) {
      return;
    }
    store.getState().addContainer(kind);
  }

  /**
   * Instance-scoped id prefix for the disclosure↔list `aria-controls` pairing.
   *
   * A module-level constant would be fine for today's single toolbox, but two
   * mounted at once (a compare/side-by-side canvas is a plausible later ticket)
   * would emit duplicate DOM ids, and every disclosure's `aria-controls` would
   * then resolve to the FIRST toolbox's list — a silently wrong a11y
   * relationship, which is what `useId` exists to prevent.
   */
  const uid = useId();
  const listId = (key: string) => `${uid}-${key}`;
  const [query, setQuery] = useState('');
  /**
   * Which category groups the operator has collapsed.
   *
   * A set of the COLLAPSED ones, so the default (every group open) needs no
   * seeding from the catalog and a category added later is open by default
   * rather than silently hidden.
   */
  // Keyed by a catalog category, or `CONTAINERS_KEY` for the Containers group.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  /* The rail offers EVERYTHING: it has no filter box, so a query typed before
     folding would otherwise hide entries with nothing on screen saying why.
     The query is kept, and comes back with the filter. */
  const shownQuery = rail ? '' : query;
  const groups = useMemo(() => toolboxGroups(shownQuery), [shownQuery]);
  const containerEntries = useMemo(() => containerToolboxEntries(shownQuery), [shownQuery]);

  /**
   * A SEARCH SUSPENDS EVERY COLLAPSE — and, with it, the disclosures themselves.
   *
   * Without this, collapse "General" and then type `http`: the filter returns
   * exactly one group, so the "no matches" state does not render either — and
   * the operator sees a lone collapsed heading with nothing under it. Search,
   * which is the ticket's headline capability, silently appears to return
   * nothing. Results the user explicitly asked for must not stay behind a
   * disclosure they closed while looking at a different list.
   *
   * Suspended, not cleared: the collapsed SET is untouched, so clearing the
   * query restores exactly what the operator had rather than quietly discarding
   * it. The disclosure BUTTON is replaced by a static heading for the duration
   * (see the render below) — a toggle whose collapse cannot take effect can only
   * either lie about its own state or rewrite the preference invisibly, and
   * removing it while it has nothing to control retires both.
   */
  const searching = shownQuery.trim() !== '';

  function toggle(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  /** A group's heading and list — shared by the catalog groups and Containers. */
  function group(key: string, label: string, items: ReactNode) {
    const isCollapsed = collapsed.has(key);
    if (rail) {
      // No headings and no group collapse on the rail: a 48px column has no
      // room for a label, and a folded group there would hide entries with
      // nothing to say so. The list keeps its name for assistive tech.
      return (
        <div className="activity-toolbox__group" key={key}>
          <ul className="activity-toolbox__list" aria-label={label}>
            {items}
          </ul>
        </div>
      );
    }
    return (
      <div className="activity-toolbox__group" key={key}>
        {searching ? (
          /* A STATIC heading while searching — not a disclosure.
             Every group is expanded during a search, so a toggle here would
             be a control that cannot take effect, and one whose label is
             guaranteed to disagree with what the user sees: it would read
             "Collapse" over an expanded list, and clicking it would silently
             rewrite the saved preference without changing anything on
             screen. Removing the control while it has nothing to control
             retires that whole class rather than picking which of the two
             states it should lie about. The list keeps its `aria-label`, so
             the grouping is still conveyed. */
          <p className="activity-toolbox__heading">{label}</p>
        ) : (
          <button
            type="button"
            className="icon-button activity-toolbox__disclosure"
            aria-expanded={!isCollapsed}
            aria-controls={listId(key)}
            aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${label}`}
            onClick={() => toggle(key)}
          >
            {/* `aria-hidden`, like U4's identical pair: the button already
                carries an explicit `aria-label`, and a decorative glyph must
                not join the accessible name. */}
            {isCollapsed ? (
              <ChevronRightRegular aria-hidden="true" />
            ) : (
              <ChevronDownRegular aria-hidden="true" />
            )}
            <span aria-hidden="true">{label}</span>
          </button>
        )}
        <ul
          id={listId(key)}
          className="activity-toolbox__list"
          aria-label={label}
          hidden={isCollapsed && !searching}
        >
          {items}
        </ul>
      </div>
    );
  }

  /**
   * One entry — an activity or a container, open or on the rail. Open, its
   * visible title is its name and the hover says what it does (#1413). On the
   * rail the title moves into `aria-label`, and into the hover ahead of the
   * description, because the glyph is all that is drawn.
   */
  function item(entry: {
    key: string;
    title: string;
    description: string;
    icon: ReactNode;
    onDragStart: (dataTransfer: DataTransfer) => void;
    onClick: () => void;
  }) {
    return (
      <li key={entry.key}>
        <button
          type="button"
          className="activity-toolbox__item"
          draggable
          aria-label={rail ? entry.title : undefined}
          title={rail ? `${entry.title} — ${entry.description}` : entry.description}
          onDragStart={(e: DragEvent<HTMLButtonElement>) => {
            // A synthetic event can carry a null dataTransfer; a real
            // dragstart never does.
            if (e.dataTransfer) entry.onDragStart(e.dataTransfer);
          }}
          onClick={entry.onClick}
        >
          {/* Decorative — the button's text, or on the rail its
              `aria-label`, is its accessible name. */}
          <span aria-hidden="true" className="activity-toolbox__icon">
            {entry.icon}
          </span>
          {!rail && <span>{entry.title}</span>}
        </button>
      </li>
    );
  }

  return (
    <aside
      id={id}
      className={rail ? 'activity-toolbox activity-toolbox--rail' : 'activity-toolbox'}
      aria-label="Activities"
    >
      {confirmDialog}
      <div className="activity-toolbox__header">
        {!rail && <h3>Activities</h3>}
        {/* ONE toggle in both states, in the same slot, so React keeps the
            element and a keyboard user's focus stays on it across the fold. */}
        <button
          type="button"
          className="icon-button activity-toolbox__fold"
          aria-expanded={!rail}
          aria-label={rail ? 'Expand activities' : 'Collapse activities'}
          title={rail ? 'Expand activities' : 'Collapse activities'}
          onClick={() => setRail(!rail)}
        >
          {rail ? (
            <PanelLeftExpandRegular aria-hidden="true" />
          ) : (
            <PanelLeftContractRegular aria-hidden="true" />
          )}
        </button>
      </div>
      {!rail && (
        <input
          type="search"
          className="activity-toolbox__filter"
          placeholder="Filter"
          aria-label="Filter activities"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}

      {/* ALWAYS mounted, with only its TEXT changing. `role="status"` is a live
          region, and a live region inserted into the DOM in the same commit as
          its content is announced unreliably — screen readers watch a region
          they already know about. Rendering it conditionally would satisfy the
          visual requirement and quietly fail the one it exists for. (Neither the
          unit nor the e2e test can see this difference; it is a correctness
          decision, not a tested one.) */}
      <p className="activity-toolbox__empty" role="status">
        {groups.length === 0 && containerEntries.length === 0
          ? `No activities match “${query.trim()}”.`
          : ''}
      </p>

      {groups.map((g) =>
        group(
          g.category,
          g.label,
          g.entries.map((entry) =>
            item({
              key: entry.type,
              title: entry.title,
              description: entry.description,
              /* THE SAME GLYPH THE CANVAS DRAWS, and sharing it is the
                 point rather than an economy: the palette is where an
                 operator learns what a shape means, so a different icon
                 here would teach nothing. */
              icon: <ActivityGlyph type={entry.type} category={entry.category} />,
              onDragStart: (dataTransfer) => setActivityDragType(dataTransfer, entry.type),
              onClick: () => store.getState().addNode(entry.type),
            }),
          ),
        ),
      )}
      {/* #1420 — the containers, last: they hold activities, so an operator
          meets the activities first. A click or a drop adds an EMPTY box that
          activities are then dragged into, or moved into with the canvas
          context menu's Move into ▸ (#1597). */}
      {containerEntries.length > 0 &&
        group(
          CONTAINERS_KEY,
          CONTAINER_GROUP_LABEL,
          containerEntries.map((entry) =>
            item({
              key: entry.kind,
              title: entry.title,
              description: entry.description,
              icon: <entry.icon />,
              onDragStart: (dataTransfer) => setContainerDragKind(dataTransfer, entry.kind),
              onClick: () => void addContainer(entry.kind, entry.title),
            }),
          ),
        )}
    </aside>
  );
}
