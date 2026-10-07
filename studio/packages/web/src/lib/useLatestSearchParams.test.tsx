import { act, render } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { useLatestSearchParams, type SetLatestSearchParams } from './useLatestSearchParams';
import { withParams } from './withParams';

/**
 * #1581 — writes made before the router re-renders build on each other. The
 * writes here run in ONE synchronous block, so no render can land between
 * them: exactly the gap a transition-committed navigation leaves open.
 */

type Handle = { set: SetLatestSearchParams; latest: () => URLSearchParams };

function Writer({ into }: { into: Handle[] }) {
  const [, set, latest] = useLatestSearchParams();
  into.push({ set, latest });
  return null;
}

function mount(initial = '/page', writers = 1) {
  const handles: Handle[][] = Array.from({ length: writers }, () => []);
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <>
            {handles.map((into, i) => (
              <Writer key={i} into={into} />
            ))}
          </>
        ),
      },
    ],
    { initialEntries: [initial] },
  );
  render(<RouterProvider router={router} />);
  const writer = (i: number): Handle => handles[i]!.at(-1)!;
  const params = () => new URLSearchParams(router.state.location.search);
  return { router, writer, params };
}

describe('useLatestSearchParams (#1581)', () => {
  it('keeps both of two writes made before a re-render', async () => {
    const { writer, params } = mount();
    await act(async () => {
      writer(0).set((prev) => withParams(prev, { sort: 'lastRun' }));
      writer(0).set((prev) => withParams(prev, { dir: 'asc' }));
      await Promise.resolve();
    });
    expect(params().toString()).toBe('sort=lastRun&dir=asc');
  });

  it('shares the record between writers in different components', async () => {
    const { writer, params } = mount('/page', 2);
    await act(async () => {
      writer(0).set((prev) => withParams(prev, { tab: 'gantt' }));
      writer(1).set((prev) => withParams(prev, { q: 'copy' }));
      await Promise.resolve();
    });
    expect(params().toString()).toBe('tab=gantt&q=copy');
  });

  it('reads the write back before the page has re-rendered with it', () => {
    const { writer } = mount('/page?a=1');
    act(() => {
      writer(0).set((prev) => withParams(prev, { b: '2' }));
      expect(writer(0).latest().toString()).toBe('a=1&b=2');
    });
  });

  it('follows a navigation it did not make once the router commits it', async () => {
    const { router, writer, params } = mount();
    await act(async () => {
      writer(0).set((prev) => withParams(prev, { sort: 'name' }));
      await Promise.resolve();
    });
    await act(async () => {
      await router.navigate('/page?view=gantt');
    });
    await act(async () => {
      writer(0).set((prev) => withParams(prev, { q: 'x' }));
      await Promise.resolve();
    });
    // Built on the committed URL, not on the stale `sort=name` record.
    expect(params().toString()).toBe('view=gantt&q=x');
  });

  it('makes no navigation for a write that changes nothing', async () => {
    const { router, writer } = mount('/page?a=1');
    const before = router.state.location.key;
    await act(async () => {
      writer(0).set((prev) => withParams(prev, { a: '1' }));
      await Promise.resolve();
    });
    expect(router.state.location.key).toBe(before);
  });

  it('writes an updater that edits prev in place and returns it', async () => {
    const { writer, params } = mount('/page?a=1');
    await act(async () => {
      writer(0).set((prev) => {
        prev.set('b', '2');
        return prev;
      });
      await Promise.resolve();
    });
    expect(params().toString()).toBe('a=1&b=2');
  });
});
