import {
  FlowchartFilled,
  FlowchartRegular,
  HomeFilled,
  HomeRegular,
  PulseFilled,
  PulseRegular,
  WrenchFilled,
  WrenchRegular,
  type FluentIcon,
} from '@fluentui/react-icons';

/**
 * The four hubs of the ADF-style shell, and the SINGLE source of truth for
 * them: the rail renders from this list, and `routes.tsx` builds its route tree
 * against the same `path`s. Adding a hub must not require editing two places
 * that can silently disagree — a rail entry pointing at a path with no route
 * renders a dead link, and a route with no rail entry is unreachable. The
 * `routes.test.tsx` case that walks this list and resolves every `path` against
 * the real route tree is what keeps the two honest.
 *
 * Icons are NAMED imports (the spec's bundle rule — never `import * as icons`).
 * Note the icon names in `@fluentui/react-icons` v2.0.334 carry NO size suffix:
 * it is `HomeRegular`, not `Home24Regular`; size comes from the rendered font
 * size, not the identifier.
 */
/**
 * The hub ids, as a union rather than a bare `string`: `HomePage` filters on
 * one of them, and a typo in a magic string would silently render the wrong
 * list (project standard — no magic strings for identifiers that have a typed
 * counterpart).
 */
export type HubId = 'home' | 'author' | 'monitor' | 'manage';

/**
 * One entry in a hub's secondary pane (U3).
 *
 * This is the hub's own navigation, one level below the rail. It is also the
 * SINGLE source of these labels: `routes.tsx` declares the matching crumb, and
 * `routes.test.tsx` pins the two equal, so a renamed section cannot leave a
 * stale breadcrumb behind.
 *
 * U4 replaces the Author hub's flat list with the Factory Resources tree; the
 * pane is the container, this list is what it holds until then.
 */
export interface HubSection {
  /** Link text in the pane, and the breadcrumb label for the same route. */
  label: string;
  /** Absolute path — must resolve to a real route (pinned in `routes.test.tsx`). */
  path: string;
}

export interface Hub {
  /** Stable id — also the React key. */
  id: HubId;
  /** Accessible name for the icon-only rail button, and its tooltip text. */
  label: string;
  /** The hub's entry path. Its route redirects on to the default child. */
  path: string;
  /**
   * The hub's pane entries, in display order. `sections[0]` is the hub's
   * landing page — the route tree's index redirect must agree with it, which
   * `routes.test.tsx` asserts rather than leaving to two literals in two files.
   *
   * EMPTY means the hub has no secondary pane at all (Home). The shell renders
   * no pane and gives its grid track no width, rather than insetting the
   * workspace behind an empty box.
   */
  sections: readonly HubSection[];
  /** Rendered when this hub is NOT active. */
  Icon: FluentIcon;
  /**
   * Rendered when this hub IS active. Fluent's convention is filled-when-
   * selected; it is a second, non-colour channel for "you are here" alongside
   * the rail's accent bar, which matters for the spec's a11y criterion that
   * status must never be colour-only.
   */
  IconActive: FluentIcon;
}

export const HUBS: readonly Hub[] = [
  {
    id: 'home',
    label: 'Home',
    path: '/',
    // No pane: Home IS the overview, so a sibling list of one entry pointing at
    // the page you are already on would be furniture. U15 builds the real Home.
    sections: [],
    Icon: HomeRegular,
    IconActive: HomeFilled,
  },
  {
    id: 'author',
    label: 'Author',
    path: '/author',
    sections: [{ label: 'Pipelines', path: '/author/pipelines' }],
    Icon: FlowchartRegular,
    IconActive: FlowchartFilled,
  },
  {
    id: 'monitor',
    label: 'Monitor',
    path: '/monitor',
    sections: [{ label: 'Runs', path: '/monitor/runs' }],
    Icon: PulseRegular,
    IconActive: PulseFilled,
  },
  {
    id: 'manage',
    label: 'Manage',
    path: '/manage',
    // Triggers was UNREACHABLE by clicking between U2 and U3: the rail reaches
    // Manage, Manage redirects to Connections, and no page linked on. The pane
    // is where a hub's second section becomes navigable at all.
    sections: [
      { label: 'Connections', path: '/manage/connections' },
      { label: 'Triggers', path: '/manage/triggers' },
    ],
    Icon: WrenchRegular,
    IconActive: WrenchFilled,
  },
];

/** Lookup by id — the shell resolves a route handle's `hub` through this. */
export function hubById(id: HubId | undefined): Hub | undefined {
  return HUBS.find((hub) => hub.id === id);
}

/*
 * There is deliberately NO `hubIdForPath(pathname)` helper here. An earlier cut
 * of U2 had one, and a mutation check showed it was inert: `NavLink` already
 * computes the same answer and already sets `aria-current` from it, so the
 * helper was a second opinion that could only ever drift from the first. The
 * rail drives all three of its active-state channels off `NavLink`'s
 * `isActive`; `HubRail.test.tsx` pins the matching rules that behaviour
 * depends on.
 */
