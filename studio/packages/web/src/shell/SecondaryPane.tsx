import type { ComponentType } from 'react';
import { NavLink } from 'react-router';
import { FactoryResources } from '../pages/author/FactoryResources';
import type { Hub, HubId } from './hubs';

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
 * A hub's own pane surface, where a flat list of section links is not enough.
 *
 * The `<nav>` WRAPPER below stays whatever a hub renders inside it — its `id`,
 * its `hidden` and its `aria-label` are load-bearing (the command bar's
 * `aria-controls` and focus restoration point at that id, and `display: none`
 * on that element is what frees the shell's pane column). A hub surface that
 * brought its own container would have to re-earn all three.
 *
 * Only Author has one today. It is a typed map rather than an `if (hub.id ===
 * 'author')` because U10 puts the Monitor filters here next, and a map with a
 * `HubId` key cannot be given a hub that does not exist.
 */
const PANE_CONTENT: Partial<
  Record<HubId, { title: string; Content: ComponentType<{ hub: Hub }> }>
> = {
  // The Shell diagram labels the Author pane "Factory Resources", not the hub
  // name — it is a resource tree, not a section list, so it says what it holds.
  author: { title: 'Factory Resources', Content: FactoryResources },
};

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
 * The section list below is the DEFAULT body. A hub with a real surface of its
 * own declares one in `PANE_CONTENT` — U4 gave Author the Factory Resources
 * tree, which keeps the hub's section as its group header rather than replacing
 * the pane's navigation with a parallel one.
 * Notably NOT `@fluentui/react-nav`'s `Nav`/`NavItem` (which is installed):
 * its selection is controlled through a `selectedValue` prop, which would be a
 * SECOND opinion about where the user is, sitting beside the router's — exactly
 * the parallel matcher U2 wrote, proved inert, and deleted.
 */
export function SecondaryPane({ hub, collapsed }: SecondaryPaneProps) {
  const custom = PANE_CONTENT[hub.id];

  return (
    <nav
      id={PANE_ELEMENT_ID}
      className="secondary-pane"
      hidden={collapsed}
      /* Distinct from the rail's "Primary" and the command bar's "Breadcrumb":
         three nav landmarks on one screen are only navigable if each is named.
         Deliberately the HUB name even when the heading below says otherwise —
         the landmark answers "which of the page's navs is this", and "Author
         sections" is the stable answer whatever Author chooses to put in it. */
      aria-label={`${hub.label} sections`}
    >
      <h2 className="secondary-pane__title">{custom?.title ?? hub.label}</h2>
      {custom ? (
        <custom.Content hub={hub} />
      ) : (
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
      )}
    </nav>
  );
}
