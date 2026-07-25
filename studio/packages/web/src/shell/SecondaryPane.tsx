import { NavLink } from 'react-router';
import type { Hub } from './hubs';

/**
 * The pane's DOM id. Exported because the command bar's toggle points
 * `aria-controls` at it — one constant rather than the same string typed in two
 * files, where a rename in one leaves a dangling reference in the other that
 * nothing renders and no test notices.
 */
export const PANE_ELEMENT_ID = 'secondary-pane';

interface SecondaryPaneProps {
  /** The hub whose sections this pane lists. Never a hub with no sections. */
  hub: Hub;
  collapsed: boolean;
}

/**
 * The shell's secondary pane (U3): the active hub's own navigation, one level
 * below the rail.
 *
 * Collapsed keeps the element MOUNTED and `hidden` rather than unmounting it,
 * for two reasons: the toggle's `aria-controls` must name an id that is in the
 * document, and `hidden` takes the pane out of the accessibility tree as well
 * as off the screen, so a screen reader is not offered links into a pane the
 * user has put away. The grid track is zeroed separately by `AppShell` — a
 * `hidden` element still occupies its track.
 *
 * Active state is `NavLink`'s `isActive` and nothing else, the same single
 * source the rail uses: it already sets `aria-current`, and its matching is
 * what the pane wants — a deeper route (`/monitor/runs/run_42`) keeps its
 * section (`Runs`) lit, and matching on a segment boundary means a future
 * `/manage/connections-v2` could not light `/manage/connections`.
 *
 * U4 replaces the Author hub's list with the Factory Resources tree; the pane
 * is the container, this is what it holds until each hub grows its own surface.
 * Notably NOT `@fluentui/react-nav`'s `Nav`/`NavItem` (which is installed):
 * its selection is controlled through a `selectedValue` prop, which would be a
 * SECOND opinion about where the user is, sitting beside the router's — exactly
 * the parallel matcher U2 wrote, proved inert, and deleted.
 */
export function SecondaryPane({ hub, collapsed }: SecondaryPaneProps) {
  return (
    <nav
      id={PANE_ELEMENT_ID}
      className="secondary-pane"
      hidden={collapsed}
      /* Distinct from the rail's "Primary" and the command bar's "Breadcrumb":
         three nav landmarks on one screen are only navigable if each is named. */
      aria-label={`${hub.label} sections`}
    >
      <h2 className="secondary-pane__title">{hub.label}</h2>
      <ul className="secondary-pane__list">
        {hub.sections.map((section) => (
          <li key={section.path}>
            <NavLink
              to={section.path}
              className={({ isActive }) =>
                `secondary-pane__link${isActive ? ' secondary-pane__link--active' : ''}`
              }
            >
              {section.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
