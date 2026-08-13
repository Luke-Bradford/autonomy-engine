import { createElement } from 'react';
import { activityIcon } from './activityIcon';

/**
 * An activity's glyph, as a component — the form every caller should use.
 *
 * `activityIcon` RETURNS a component, and both assigning that to a capitalised
 * local in a render body and rendering it as `<Glyph />` are what
 * `react-hooks/static-components` refuses. The reason is real rather than
 * stylistic: an element type computed during render is a NEW type on every
 * pass, so React unmounts and remounts the subtree instead of updating it —
 * which on this canvas would remount an icon per node on every viewport change.
 *
 * `createElement` with a lower-case handle keeps the lookup out of the element
 * type's identity: the map returns the same component object for the same
 * `type`, so the element type is stable and React updates in place.
 *
 * Its own file, and not beside the map, because a module that exports both a
 * component and a plain function breaks Fast Refresh
 * (`react-refresh/only-export-components`) — the map is shared by the canvas,
 * the palette and a test, so it is the component that moves.
 */
export function ActivityGlyph({
  type,
  category,
  className,
}: {
  type: string;
  category?: string;
  className?: string;
}) {
  return createElement(activityIcon(type, category), { className });
}
