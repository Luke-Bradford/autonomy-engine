import { useMemo, useState } from 'react';
import { ChevronDownRegular, ChevronRightRegular } from '@fluentui/react-icons';
import type { StoreApi } from 'zustand';
import type { ActivityCategory } from '@autonomy-studio/shared';
import { setActivityDragType } from './activityDnd';
import { toolboxGroups } from './activityGroups';
import type { CanvasState } from './canvasStore';

/** The list element id a group's disclosure names via `aria-controls`. */
function listId(category: ActivityCategory): string {
  return `activity-toolbox-${category}`;
}

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
        placeholder="Filter…"
        aria-label="Filter activities"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {groups.length === 0 && (
        /* `role="status"` so the result CHANGE is announced. A silently empty
           column reads as "still loading" to someone who cannot see it. */
        <p className="activity-toolbox__empty" role="status">
          No activities match “{query.trim()}”.
        </p>
      )}

      {groups.map((group) => {
        const isCollapsed = collapsed.has(group.category);
        return (
          <div className="activity-toolbox__group" key={group.category}>
            <button
              type="button"
              className="icon-button activity-toolbox__disclosure"
              aria-expanded={!isCollapsed}
              aria-controls={listId(group.category)}
              aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${group.label}`}
              onClick={() => toggle(group.category)}
            >
              {isCollapsed ? <ChevronRightRegular /> : <ChevronDownRegular />}
              <span aria-hidden="true">{group.label}</span>
            </button>
            <ul
              id={listId(group.category)}
              className="activity-toolbox__list"
              aria-label={group.label}
              hidden={isCollapsed}
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
