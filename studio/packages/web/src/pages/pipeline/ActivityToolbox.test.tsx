import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { answerConfirm } from '../../testing/confirmDialog';
import { ACTIVITY_CATEGORY_LABELS, catalog } from '@autonomy-studio/shared';
import { ActivityToolbox } from './ActivityToolbox';
import { ACTIVITY_DND_MIME, CONTAINER_DND_MIME } from './activityDnd';
import { CONTAINER_PALETTE } from './activityGroups';
import { createCanvasStore } from './canvasStore';
import { TOOLBOX_DEFAULT_WIDTH, uiStore } from '../../stores/uiStore';

function renderToolbox() {
  const store = createCanvasStore();
  store.getState().loadVersion(null);
  render(<ActivityToolbox store={store} />);
  return store;
}

/** The search box, addressed the way a user perceives it. */
function filterBox() {
  return screen.getByRole('searchbox', { name: 'Filter activities' });
}

/**
 * Every activity item currently offered, by accessible name.
 *
 * `queryAllByRole`, not `getAllByRole`: the empty-state assertion below expects
 * ZERO, and the `get*` form throws rather than returning `[]`.
 */
function offeredNames(): string[] {
  return screen
    .queryAllByRole('button')
    .filter((b) => b.hasAttribute('draggable'))
    .map((b) => b.textContent ?? '');
}

// #425 retired the structural-call exclusion, so every catalogued activity is
// authorable — the name is kept because it still says what the list MEANS.
const authorable = [...catalog.values()];

describe('ActivityToolbox', () => {
  it('offers every generically-authorable activity, grouped under its category heading', () => {
    renderToolbox();
    for (const entry of authorable) {
      expect(screen.getByRole('button', { name: entry.title })).toBeTruthy();
    }
    // Each group heading comes from the shared label SSOT, and each activity sits
    // INSIDE its own group's list — not merely somewhere on the page.
    const general = screen.getByRole('list', { name: ACTIVITY_CATEGORY_LABELS.general });
    expect(within(general).getByRole('button', { name: 'HTTP Request' })).toBeTruthy();
    const ai = screen.getByRole('list', { name: ACTIVITY_CATEGORY_LABELS.ai });
    expect(within(ai).getByRole('button', { name: 'LLM Call' })).toBeTruthy();
    expect(within(general).queryByRole('button', { name: 'LLM Call' })).toBeNull();
  });

  it('the hover on every activity says what it does (#1413)', () => {
    renderToolbox();
    for (const entry of authorable) {
      // The visible name stays the accessible NAME; the description rides the
      // title, which is the accessible DESCRIPTION.
      const button = screen.getByRole('button', { name: entry.title });
      expect(button.getAttribute('title')).toBe(entry.description);
    }
  });

  it('OFFERS execute_pipeline, and clicking it authors a call node — #425', () => {
    // The structural-call exclusion retired with #425: `CallPanel` authors the
    // `node.call` blob the generic config form could not, so the palette offers
    // the whole catalog and nothing is left unreachable from the canvas.
    const store = renderToolbox();
    expect(offeredNames()).toHaveLength(catalog.size + CONTAINER_PALETTE.length);
    fireEvent.click(screen.getByRole('button', { name: 'Execute Pipeline' }));
    expect(store.getState().nodes[0]!.type).toBe('execute_pipeline');
  });

  it('adds the activity on CLICK — the keyboard-operable path drag cannot provide', () => {
    // WCAG 2.2 SC 2.5.7 (Dragging Movements): every drag action needs a
    // single-pointer, non-drag alternative. It is also the only path a keyboard
    // user has, since HTML5 drag has no keyboard equivalent at all.
    const store = renderToolbox();
    fireEvent.click(screen.getByRole('button', { name: 'HTTP Request' }));
    expect(store.getState().nodes).toHaveLength(1);
    expect(store.getState().nodes[0]!.type).toBe('http_request');
  });

  it('is reachable and activatable by KEYBOARD alone', async () => {
    const user = userEvent.setup();
    const store = renderToolbox();
    const item = screen.getByRole('button', { name: 'HTTP Request' });
    item.focus();
    expect(document.activeElement).toBe(item);
    await user.keyboard('{Enter}');
    expect(store.getState().nodes).toHaveLength(1);
  });

  it('writes the activity type into the drag payload on dragstart', () => {
    renderToolbox();
    const dataTransfer = {
      setData: vi.fn(),
      effectAllowed: 'uninitialized',
    } as unknown as DataTransfer;
    fireEvent.dragStart(screen.getByRole('button', { name: 'HTTP Request' }), { dataTransfer });
    expect(dataTransfer.setData).toHaveBeenCalledWith(ACTIVITY_DND_MIME, 'http_request');
    expect(dataTransfer.effectAllowed).toBe('copy');
  });

  it('marks every offered item draggable', () => {
    renderToolbox();
    const items = screen
      .getAllByRole('button')
      .filter((b) => authorable.some((e) => e.title === b.textContent));
    expect(items).toHaveLength(authorable.length);
    for (const item of items) expect(item.getAttribute('draggable')).toBe('true');
  });

  it('narrows to matching activities as the filter is typed', async () => {
    const user = userEvent.setup();
    renderToolbox();
    await user.type(filterBox(), 'http');
    expect(screen.getByRole('button', { name: 'HTTP Request' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'LLM Call' })).toBeNull();
  });

  it('HIDES a category heading once the filter empties its group', async () => {
    const user = userEvent.setup();
    renderToolbox();
    expect(screen.getByRole('list', { name: ACTIVITY_CATEGORY_LABELS.ai })).toBeTruthy();
    await user.type(filterBox(), 'http');
    // A heading over nothing is a false "this category has matches" signal.
    expect(screen.queryByRole('list', { name: ACTIVITY_CATEGORY_LABELS.ai })).toBeNull();
    expect(screen.getByRole('list', { name: ACTIVITY_CATEGORY_LABELS.general })).toBeTruthy();
  });

  it('announces an empty result rather than rendering a blank column', async () => {
    const user = userEvent.setup();
    renderToolbox();
    await user.type(filterBox(), 'zzzz-no-such-activity');
    // `role="status"` so a screen reader hears the result change; a silently
    // empty column reads as "still loading" to someone who cannot see it.
    const empty = screen.getByRole('status');
    expect(empty.textContent).toMatch(/no activities/i);
    expect(offeredNames()).toHaveLength(0);
  });

  it('collapses and re-expands a category group, with the state exposed to assistive tech', async () => {
    const user = userEvent.setup();
    renderToolbox();
    const disclosure = screen.getByRole('button', {
      name: `Collapse ${ACTIVITY_CATEGORY_LABELS.general}`,
    });
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
    // The disclosure must NAME the list it controls, or the relationship exists
    // only visually.
    const controlled = disclosure.getAttribute('aria-controls');
    expect(controlled).toBeTruthy();
    expect(document.getElementById(controlled!)).toBeTruthy();

    await user.click(disclosure);
    expect(screen.queryByRole('button', { name: 'HTTP Request' })).toBeNull();
    const collapsed = screen.getByRole('button', {
      name: `Expand ${ACTIVITY_CATEGORY_LABELS.general}`,
    });
    expect(collapsed.getAttribute('aria-expanded')).toBe('false');

    await user.click(collapsed);
    expect(screen.getByRole('button', { name: 'HTTP Request' })).toBeTruthy();
  });

  it('a SEARCH overrides a collapsed group, so results are never hidden behind it', async () => {
    // Without this, collapsing General and then searching `http` shows a lone
    // collapsed heading and nothing else — and the empty state does not fire
    // either, because the group DID match. Search, the ticket's headline
    // capability, would silently appear to return nothing.
    const user = userEvent.setup();
    renderToolbox();
    await user.click(
      screen.getByRole('button', { name: `Collapse ${ACTIVITY_CATEGORY_LABELS.general}` }),
    );
    expect(screen.queryByRole('button', { name: 'HTTP Request' })).toBeNull();

    await user.type(filterBox(), 'http');
    expect(screen.getByRole('button', { name: 'HTTP Request' })).toBeTruthy();
  });

  it('restores the collapse once the search is cleared, rather than discarding it', async () => {
    // The suspension is at RENDER; the collapsed set is untouched. Clearing the
    // set instead would quietly throw away a preference the operator set.
    const user = userEvent.setup();
    renderToolbox();
    await user.click(
      screen.getByRole('button', { name: `Collapse ${ACTIVITY_CATEGORY_LABELS.general}` }),
    );
    await user.type(filterBox(), 'http');
    expect(screen.getByRole('button', { name: 'HTTP Request' })).toBeTruthy();

    await user.clear(filterBox());
    expect(screen.queryByRole('button', { name: 'HTTP Request' })).toBeNull();
    expect(
      screen.getByRole('button', { name: `Expand ${ACTIVITY_CATEGORY_LABELS.general}` }),
    ).toBeTruthy();
  });

  it('offers NO disclosure while searching — only a static heading', async () => {
    // A toggle whose collapse cannot take effect can only lie about its state or
    // rewrite the preference invisibly. While a search suspends the collapses
    // there is nothing for it to control, so it is not rendered at all.
    const user = userEvent.setup();
    renderToolbox();
    expect(
      screen.getByRole('button', { name: `Collapse ${ACTIVITY_CATEGORY_LABELS.general}` }),
    ).toBeTruthy();

    await user.type(filterBox(), 'http');
    expect(
      screen.queryByRole('button', { name: `Collapse ${ACTIVITY_CATEGORY_LABELS.general}` }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: `Expand ${ACTIVITY_CATEGORY_LABELS.general}` }),
    ).toBeNull();
    // The grouping is still conveyed — by the heading, and by the list's own
    // accessible name.
    expect(screen.getByText(ACTIVITY_CATEGORY_LABELS.general)).toBeTruthy();
    expect(screen.getByRole('list', { name: ACTIVITY_CATEGORY_LABELS.general })).toBeTruthy();

    // ...and it comes back when the search ends, in the state it had (this
    // group was never collapsed, so it reads "Collapse").
    await user.clear(filterBox());
    expect(
      screen.getByRole('button', { name: `Collapse ${ACTIVITY_CATEGORY_LABELS.general}` }),
    ).toBeTruthy();
  });

  it('a collapse set BEFORE a search survives the whole search round-trip untouched', async () => {
    // The interleaving that motivated removing the control: with a disclosure
    // still rendered during a search, its label read "Collapse" over an already-
    // expanded list, and clicking it deleted the category from the collapsed set
    // while changing nothing on screen — so the preference vanished silently the
    // moment the search was cleared. There is now no control to click, and this
    // pins the property that mattered.
    const user = userEvent.setup();
    renderToolbox();
    await user.click(
      screen.getByRole('button', { name: `Collapse ${ACTIVITY_CATEGORY_LABELS.general}` }),
    );

    await user.type(filterBox(), 'http');
    // Whatever the user does with the toolbox mid-search, no disclosure exists
    // to corrupt the preference.
    await user.click(screen.getByRole('button', { name: 'HTTP Request' }));
    await user.clear(filterBox());

    expect(
      screen.getByRole('button', { name: `Expand ${ACTIVITY_CATEGORY_LABELS.general}` }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'HTTP Request' })).toBeNull();
  });

  it('collapsing one group leaves the others open', async () => {
    const user = userEvent.setup();
    renderToolbox();
    await user.click(
      screen.getByRole('button', { name: `Collapse ${ACTIVITY_CATEGORY_LABELS.general}` }),
    );
    expect(screen.queryByRole('button', { name: 'HTTP Request' })).toBeNull();
    expect(screen.getByRole('button', { name: 'LLM Call' })).toBeTruthy();
  });

  describe('the Containers group (#1420) — ForEach, Until and Stage', () => {
    it('offers all three under their own heading, next to the activities', () => {
      renderToolbox();
      const group = screen.getByRole('list', { name: 'Containers' });
      for (const title of ['ForEach', 'Until', 'Stage']) {
        expect(within(group).getByRole('button', { name: title })).toBeTruthy();
      }
    });

    it('a click adds an EMPTY container of that kind and selects it', () => {
      const store = renderToolbox();
      fireEvent.click(screen.getByRole('button', { name: 'ForEach' }));
      const [c] = store.getState().containers;
      expect(c).toMatchObject({ kind: 'foreach', children: [] });
      expect(store.getState().selected).toEqual([{ kind: 'container', id: c!.id }]);
      fireEvent.click(screen.getByRole('button', { name: 'Until' }));
      expect(store.getState().containers[1]!.kind).toBe('loop');
    });

    it('a drag carries the container kind, not an activity type', () => {
      renderToolbox();
      const dataTransfer = {
        setData: vi.fn(),
        effectAllowed: 'uninitialized',
      } as unknown as DataTransfer;
      fireEvent.dragStart(screen.getByRole('button', { name: 'Stage' }), { dataTransfer });
      expect(dataTransfer.setData).toHaveBeenCalledWith(CONTAINER_DND_MIME, 'stage');
      expect(dataTransfer.setData).not.toHaveBeenCalledWith(ACTIVITY_DND_MIME, expect.anything());
    });

    it('filters with the search box, by title or by kind', async () => {
      renderToolbox();
      await userEvent.type(filterBox(), 'foreach');
      const group = screen.getByRole('list', { name: 'Containers' });
      expect(within(group).getByRole('button', { name: 'ForEach' })).toBeTruthy();
      expect(within(group).queryByRole('button', { name: 'Stage' })).toBeNull();
      await userEvent.clear(filterBox());
      await userEvent.type(filterBox(), 'loop');
      expect(screen.getByRole('button', { name: 'Until' })).toBeTruthy();
    });

    it('a search naming the group keeps all three', async () => {
      renderToolbox();
      await userEvent.type(filterBox(), 'contain');
      const group = screen.getByRole('list', { name: 'Containers' });
      expect(within(group).getAllByRole('button')).toHaveLength(3);
    });

    it('a click asks first when the box would change routing, and a No adds nothing', async () => {
      const user = userEvent.setup();
      const store = renderToolbox();
      // Two edge-less activities are an inferred CHAIN; the first container
      // turns that into parallel partitions (`implicitRouting`).
      store.getState().addNode('http_request');
      store.getState().addNode('http_request');
      fireEvent.click(screen.getByRole('button', { name: 'Stage' }));
      expect(await answerConfirm(user, 'cancel')).toContain('Add a Stage container?');
      expect(store.getState().containers).toEqual([]);
    });

    it('a Yes adds the box', async () => {
      const user = userEvent.setup();
      const store = renderToolbox();
      store.getState().addNode('http_request');
      store.getState().addNode('http_request');
      fireEvent.click(screen.getByRole('button', { name: 'Stage' }));
      await answerConfirm(user, 'accept');
      expect(store.getState().containers.map((c) => c.kind)).toEqual(['stage']);
    });

    it('adds at once, with no question, when routing would not change', () => {
      const store = renderToolbox();
      fireEvent.click(screen.getByRole('button', { name: 'Stage' }));
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(store.getState().containers.map((c) => c.kind)).toEqual(['stage']);
    });

    it('collapses like any other group', () => {
      renderToolbox();
      fireEvent.click(screen.getByRole('button', { name: 'Collapse Containers' }));
      expect(screen.queryByRole('button', { name: 'ForEach' })).toBeNull();
    });
  });
});

/**
 * #1475 OR27 — the toolbox folds to an icon rail rather than going away (U5:
 * activities stay addable while the canvas has the width). The fold is the
 * `uiStore` SINGLETON's, so every case puts it back.
 */
describe('ActivityToolbox icon rail (#1475)', () => {
  afterEach(() => {
    uiStore.getState().setToolboxCollapsed(false);
    uiStore.getState().setToolboxWidth(TOOLBOX_DEFAULT_WIDTH);
  });

  it('folds to the rail and back from ONE toggle, which keeps focus and persists the fold', async () => {
    renderToolbox();
    const toggle = screen.getByRole('button', { name: 'Collapse activities' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(toggle);

    expect(uiStore.getState().toolboxCollapsed).toBe(true);
    const expand = screen.getByRole('button', { name: 'Expand activities' });
    // The same element, so a keyboard user's focus is not dropped on the floor.
    expect(expand).toBe(toggle);
    expect(expand).toHaveFocus();
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('searchbox', { name: 'Filter activities' })).toBeNull();

    await userEvent.click(expand);
    expect(uiStore.getState().toolboxCollapsed).toBe(false);
    expect(filterBox()).toBeVisible();
  });

  it('offers every activity and container on the rail, named by its title, ignoring a typed filter', async () => {
    renderToolbox();
    await userEvent.type(filterBox(), 'http');
    act(() => uiStore.getState().setToolboxCollapsed(true));

    const rail = screen.getAllByRole('button');
    const offered = rail.filter((b) => b.hasAttribute('draggable'));
    expect(offered.map((b) => b.getAttribute('aria-label')).sort()).toEqual(
      [...authorable.map((d) => d.title), ...CONTAINER_PALETTE.map((c) => c.title)].sort(),
    );
    // A glyph only: the visible label is gone, the name stays.
    for (const item of offered) expect(item.textContent).toBe('');
    // Each still says what it does on hover (#1413).
    const http = screen.getByRole('button', { name: catalog.get('http_request')!.title });
    expect(http.getAttribute('title')).toContain(catalog.get('http_request')!.description);
  });

  it('adds an activity from the rail by click, the way the full toolbox does', async () => {
    uiStore.getState().setToolboxCollapsed(true);
    const store = renderToolbox();
    expect(screen.queryByRole('searchbox')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: catalog.get('http_request')!.title }));
    expect(store.getState().nodes.map((n) => n.type)).toEqual(['http_request']);
  });

  it('writes the drag payload from the rail', () => {
    uiStore.getState().setToolboxCollapsed(true);
    renderToolbox();
    expect(screen.queryByRole('searchbox')).toBeNull();
    const setData = vi.fn();
    fireEvent.dragStart(screen.getByRole('button', { name: catalog.get('http_request')!.title }), {
      dataTransfer: { setData, effectAllowed: '' },
    });
    expect(setData).toHaveBeenCalledWith(ACTIVITY_DND_MIME, 'http_request');
  });
});
