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

export interface Hub {
  /** Stable id — also the React key. */
  id: HubId;
  /** Accessible name for the icon-only rail button, and its tooltip text. */
  label: string;
  /** The hub's entry path. Its route redirects on to the default child. */
  path: string;
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
  { id: 'home', label: 'Home', path: '/', Icon: HomeRegular, IconActive: HomeFilled },
  {
    id: 'author',
    label: 'Author',
    path: '/author',
    Icon: FlowchartRegular,
    IconActive: FlowchartFilled,
  },
  {
    id: 'monitor',
    label: 'Monitor',
    path: '/monitor',
    Icon: PulseRegular,
    IconActive: PulseFilled,
  },
  { id: 'manage', label: 'Manage', path: '/manage', Icon: WrenchRegular, IconActive: WrenchFilled },
];

/*
 * There is deliberately NO `hubIdForPath(pathname)` helper here. An earlier cut
 * of U2 had one, and a mutation check showed it was inert: `NavLink` already
 * computes the same answer and already sets `aria-current` from it, so the
 * helper was a second opinion that could only ever drift from the first. The
 * rail drives all three of its active-state channels off `NavLink`'s
 * `isActive`; `HubRail.test.tsx` pins the matching rules that behaviour
 * depends on.
 */
