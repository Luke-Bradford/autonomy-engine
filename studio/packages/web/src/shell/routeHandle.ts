import { hubById, type HubId } from './hubs';

/** Params as react-router hands them to us: decoded, and possibly absent. */
export type RouteParams = Readonly<Record<string, string | undefined>>;

/**
 * What a route may declare for the shell chrome (U3).
 *
 * `handle` is react-router's own extension point, and pairing it with
 * `useMatches()` is the idiom react-router documents for breadcrumbs. That
 * matters here beyond convenience: U2 wrote a parallel path-matching helper for
 * the rail, found it inert under a mutation check, and deleted it precisely
 * because it could only ever become a second opinion that disagreed with the
 * router (see the closing comment in `hubs.ts`). Reading the ROUTER's own match
 * list is not that — it is the same single source, asked directly. This closes
 * the "revisit if U3's breadcrumb needs the matcher anyway" question the design
 * doc parks at the end of the U2 section: it does not.
 *
 * - `hub` marks a route as a hub root. It drives the secondary pane's contents
 *   and contributes a breadcrumb whose LABEL comes from `HUBS`, not from here.
 * - `crumb` is a leaf's breadcrumb label — a string, or a function of the
 *   match's params for a route whose label is part of the URL (`:runId`).
 */
export interface ShellRouteHandle {
  hub?: HubId;
  crumb?: string | ((params: RouteParams) => string);
}

/** One rendered breadcrumb entry. */
export interface Crumb {
  label: string;
  /** The matched pathname — where clicking this crumb goes. */
  to: string;
}

/**
 * The slice of react-router's `UIMatch` the shell reads.
 *
 * Declared structurally rather than imported so these functions can be unit
 * tested without constructing a router, and so `handle` keeps its honest
 * `unknown` type: react-router types `RouteObject.handle` as `any` on the
 * declaration side and `UIMatch['handle']` as `unknown` on the read side, so
 * nothing between the two catches a typo. `readShellHandle` is that check.
 */
export interface ShellMatch {
  pathname: string;
  params: RouteParams;
  handle: unknown;
}

function isHubId(value: unknown): value is HubId {
  return hubById(value as HubId) !== undefined;
}

/**
 * Narrow a route's `handle` to the shell's contract, or `undefined`.
 *
 * A partially-valid handle is rejected WHOLE. Dropping just the bad field would
 * leave a breadcrumb that is merely a bit short — the failure would render, not
 * throw, which is the shape of bug that ships. Since `RouteObject.handle` is
 * `any`, this function is the only place a `{ hub: 'moniter' }` typo can be
 * caught at all; the declarations in `routes.tsx` additionally use `satisfies
 * ShellRouteHandle` so the common case fails at compile time instead.
 */
export function readShellHandle(handle: unknown): ShellRouteHandle | undefined {
  if (typeof handle !== 'object' || handle === null || Array.isArray(handle)) return undefined;
  const { hub, crumb } = handle as Record<string, unknown>;

  if (hub !== undefined && !isHubId(hub)) return undefined;
  if (crumb !== undefined && typeof crumb !== 'string' && typeof crumb !== 'function') {
    return undefined;
  }
  if (hub === undefined && crumb === undefined) return undefined;

  return handle as ShellRouteHandle;
}

/**
 * Which hub the current route belongs to, from the DEEPEST match that declares
 * one. Nothing nests hubs today, but "first wins" and "last wins" are
 * indistinguishable on a flat tree, so the rule is pinned by a test rather than
 * left to be discovered by a nested hub lighting up its parent.
 */
export function activeHubId(matches: readonly ShellMatch[]): HubId | undefined {
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const hub = readShellHandle(matches[i]?.handle)?.hub;
    if (hub) return hub;
  }
  return undefined;
}

function crumbLabel(handle: ShellRouteHandle, params: RouteParams): string | undefined {
  if (handle.crumb !== undefined) {
    return typeof handle.crumb === 'function' ? handle.crumb(params) : handle.crumb;
  }
  return hubById(handle.hub)?.label;
}

/**
 * The breadcrumb trail for a match list, outermost first.
 *
 * Matches with no usable handle contribute nothing, and so does a dynamic crumb
 * whose label comes back empty: an empty `<li>` in a breadcrumb is a clickable
 * target with no accessible name, which is worse than an absent crumb and
 * invisible in a screenshot.
 */
export function crumbsFrom(matches: readonly ShellMatch[]): Crumb[] {
  const crumbs: Crumb[] = [];
  for (const match of matches) {
    const handle = readShellHandle(match.handle);
    if (!handle) continue;
    const label = crumbLabel(handle, match.params);
    if (label) crumbs.push({ label, to: match.pathname });
  }
  return crumbs;
}
