import { describe, expect, it } from 'vitest';
import { activeHubId, crumbsFrom, readShellHandle, type ShellMatch } from './routeHandle';

/**
 * These are the PURE functions behind the shell chrome — "which hub am I in"
 * and "what does the breadcrumb say" — exercised here against hand-built
 * matches so the edge cases (an untyped handle, a missing param, a hub with no
 * crumb) are reachable without a router.
 *
 * A hand-built match list is a stub, and a stub route tree agrees with itself.
 * The counterweight is in `routes.test.tsx`, which mounts the REAL `ROUTES` and
 * asserts the rendered breadcrumb and pane for the paths that matter. Both
 * halves are needed: this file pins the logic, that one pins the wiring.
 */
function match(pathname: string, handle: unknown, params: Record<string, string> = {}): ShellMatch {
  return { pathname, params, handle };
}

describe('readShellHandle', () => {
  it.each([
    ['undefined (a route with no handle at all)', undefined],
    ['null', null],
    ['a string', 'monitor'],
    ['an array', ['monitor']],
    ['an object whose hub is not a HubId', { hub: 'moniter' }],
    ['an object whose crumb is neither string nor function', { crumb: 42 }],
  ])('rejects %s', (_label, handle) => {
    expect(readShellHandle(handle)).toBeUndefined();
  });

  it('accepts a hub handle', () => {
    expect(readShellHandle({ hub: 'monitor' })).toEqual({ hub: 'monitor' });
  });

  it('accepts a static crumb and a dynamic one', () => {
    expect(readShellHandle({ crumb: 'Runs' })).toEqual({ crumb: 'Runs' });
    const dynamic = { crumb: () => 'x' };
    expect(readShellHandle(dynamic)).toEqual(dynamic);
  });

  /**
   * A partially-valid handle is rejected WHOLE rather than having its bad field
   * dropped. `RouteObject.handle` is typed `any` by react-router, so a typo is
   * only ever caught here — and silently keeping the half that parsed would
   * hide it behind a breadcrumb that merely looks a bit short.
   */
  it('rejects a handle with one good field and one bad one', () => {
    expect(readShellHandle({ hub: 'monitor', crumb: 42 })).toBeUndefined();
  });
});

describe('activeHubId', () => {
  it('finds the hub declared on an ancestor route', () => {
    expect(
      activeHubId([
        match('/', undefined),
        match('/manage', { hub: 'manage' }),
        match('/manage/triggers', { crumb: 'Triggers' }),
      ]),
    ).toBe('manage');
  });

  it('is undefined when no match declares a hub', () => {
    expect(activeHubId([match('/', undefined), match('/nope', undefined)])).toBeUndefined();
  });

  /**
   * The DEEPEST declaration wins. Nothing nests hubs today, but "first match
   * wins" and "last match wins" are indistinguishable on a flat tree — so the
   * rule is pinned now rather than discovered later by a nested hub silently
   * lighting up its parent.
   */
  it('takes the deepest hub when more than one is declared', () => {
    expect(
      activeHubId([match('/manage', { hub: 'manage' }), match('/manage/x', { hub: 'author' })]),
    ).toBe('author');
  });
});

describe('crumbsFrom', () => {
  it('builds hub + section crumbs, each linking to its own matched path', () => {
    expect(
      crumbsFrom([
        match('/', undefined),
        match('/manage', { hub: 'manage' }),
        match('/manage/triggers', { crumb: 'Triggers' }),
      ]),
    ).toEqual([
      { label: 'Manage', to: '/manage' },
      { label: 'Triggers', to: '/manage/triggers' },
    ]);
  });

  /**
   * A hub crumb's label comes from `HUBS`, not from the handle — one source for
   * the rail's tooltip, the pane's heading and the breadcrumb, so renaming a
   * hub cannot leave one of the three behind.
   */
  it('resolves a hub label from the HUBS SSOT rather than the handle', () => {
    expect(crumbsFrom([match('/monitor', { hub: 'monitor' })])).toEqual([
      { label: 'Monitor', to: '/monitor' },
    ]);
  });

  it('calls a dynamic crumb with the match params', () => {
    expect(
      crumbsFrom([
        match('/monitor', { hub: 'monitor' }),
        match('/monitor/runs', { crumb: 'Runs' }),
        match(
          '/monitor/runs/run_42',
          { crumb: (p: { runId?: string }) => p.runId ?? '?' },
          {
            runId: 'run_42',
          },
        ),
      ]),
    ).toEqual([
      { label: 'Monitor', to: '/monitor' },
      { label: 'Runs', to: '/monitor/runs' },
      { label: 'run_42', to: '/monitor/runs/run_42' },
    ]);
  });

  /** Matches with no usable handle contribute nothing — no blank crumbs. */
  it('skips matches without a handle', () => {
    expect(crumbsFrom([match('/', undefined), match('/x', { nope: true })])).toEqual([]);
  });

  /**
   * A dynamic crumb whose param is missing yields NO crumb rather than an empty
   * one. An empty `<li>` in a breadcrumb is a clickable target with no
   * accessible name — worse than an absent crumb, and invisible in a screenshot.
   */
  it('drops a crumb whose dynamic label comes back empty', () => {
    expect(
      crumbsFrom([match('/monitor/runs/', { crumb: (p: { runId?: string }) => p.runId ?? '' })]),
    ).toEqual([]);
  });
});
