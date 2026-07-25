import { useId, useMemo, useState } from 'react';
import { ChevronDownRegular, ChevronRightRegular } from '@fluentui/react-icons';
import type { StoreApi } from 'zustand';
import type { ActivityCategory } from '@autonomy-studio/shared';
import { setActivityDragType } from './activityDnd';
import { toolboxGroups } from './activityGroups';
import type { CanvasState } from './canvasStore';

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
 */
export function ActivityToolbox({ store }: { store: StoreApi<CanvasState> }) {
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
  const listId = (category: ActivityCategory) => `${uid}-${category}`;
  const [query, setQuery] = useState('');
  /**
   * Which category groups the operator has collapsed.
   *
   * A set of the COLLAPSED ones, so the default (every group open) needs no
   * seeding from the catalog and a category added later is open by default
   * rather than silently hidden.
   */
  const [collapsed, setCollapsed] = useState<ReadonlySet<ActivityCategory>>(new Set());

  const groups = useMemo(() => toolboxGroups(query), [query]);

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
  const searching = query.trim() !== '';

  function toggle(category: ActivityCategory) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(category)) next.add(category);
      return next;
    });
  }

  return (
    <aside className="activity-toolbox" aria-label="Activities">
      <h3>Activities</h3>
      <input
        type="search"
        className="activity-toolbox__filter"
        placeholder="Filter"
        aria-label="Filter activities"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {/* ALWAYS mounted, with only its TEXT changing. `role="status"` is a live
          region, and a live region inserted into the DOM in the same commit as
          its content is announced unreliably — screen readers watch a region
          they already know about. Rendering it conditionally would satisfy the
          visual requirement and quietly fail the one it exists for. (Neither the
          unit nor the e2e test can see this difference; it is a correctness
          decision, not a tested one.) */}
      <p className="activity-toolbox__empty" role="status">
        {groups.length === 0 ? `No activities match “${query.trim()}”.` : ''}
      </p>

      {groups.map((group) => {
        const isCollapsed = collapsed.has(group.category);
        return (
          <div className="activity-toolbox__group" key={group.category}>
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
              <p className="activity-toolbox__heading">{group.label}</p>
            ) : (
              <button
                type="button"
                className="icon-button activity-toolbox__disclosure"
                aria-expanded={!isCollapsed}
                aria-controls={listId(group.category)}
                aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${group.label}`}
                onClick={() => toggle(group.category)}
              >
                {/* `aria-hidden`, like U4's identical pair: the button already
                    carries an explicit `aria-label`, and a decorative glyph must
                    not join the accessible name. */}
                {isCollapsed ? (
                  <ChevronRightRegular aria-hidden="true" />
                ) : (
                  <ChevronDownRegular aria-hidden="true" />
                )}
                <span aria-hidden="true">{group.label}</span>
              </button>
            )}
            <ul
              id={listId(group.category)}
              className="activity-toolbox__list"
              aria-label={group.label}
              hidden={isCollapsed && !searching}
            >
              {group.entries.map((entry) => (
                <li key={entry.type}>
                  <button
                    type="button"
                    className="activity-toolbox__item"
                    draggable
                    title={entry.type}
                    onDragStart={(e) => {
                      // A synthetic event can carry a null dataTransfer; a real
                      // dragstart never does.
                      if (e.dataTransfer) setActivityDragType(e.dataTransfer, entry.type);
                    }}
                    onClick={() => store.getState().addNode(entry.type)}
                  >
                    {entry.title}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </aside>
  );
}
