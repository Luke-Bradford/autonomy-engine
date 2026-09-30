import { createContext, useContext, useEffect } from 'react';
import { useLocation } from 'react-router';
import { normalizePath, type PublishedLabels } from './routeHandle';

/**
 * #1392 — how a page tells the shell what its breadcrumb (and the tab title)
 * should call it.
 *
 * The shell used to show the id for a detail route (`pipe_…`, `run_…`),
 * because it deliberately subscribes to no page-domain store and so could not
 * know the name. That stays true: the PAGE already loads its resource, so the
 * page publishes the name, keyed by its own pathname, and the shell only reads
 * a map of strings. No shell code learns what a pipeline or a run is.
 *
 * Keyed by pathname rather than held as a single "current label" so a label can
 * never outlive its page onto the next one: a stale entry for another path is
 * simply not looked up, and the hook removes its own entry on unmount anyway.
 */
export interface ShellLabelApi {
  publish(pathname: string, label: string | undefined): void;
}

/** `null` outside `AppShell` — a page rendered alone (a unit test) publishes nowhere. */
export const ShellLabelContext = createContext<ShellLabelApi | null>(null);

/**
 * The pure update behind `ShellLabelApi.publish`. Returns `prev` itself when
 * nothing changes, so a re-publish of the same label does not re-render the
 * shell (and, through it, the page that published it).
 */
export function withLabel(
  prev: PublishedLabels,
  pathname: string,
  label: string | undefined,
): PublishedLabels {
  const key = normalizePath(pathname);
  if (label === undefined || label === '') {
    if (!(key in prev)) return prev;
    const next = { ...prev };
    delete next[key];
    return next;
  }
  return prev[key] === label ? prev : { ...prev, [key]: label };
}

/**
 * Publish `label` as this page's breadcrumb, for as long as the page is mounted
 * and the label is defined. `undefined` (still loading, or the resource is
 * missing) leaves the route's own fallback crumb in place.
 */
export function useShellLabel(label: string | undefined): void {
  const api = useContext(ShellLabelContext);
  const { pathname } = useLocation();
  useEffect(() => {
    if (!api || label === undefined) return;
    api.publish(pathname, label);
    return () => api.publish(pathname, undefined);
  }, [api, pathname, label]);
}
