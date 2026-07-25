import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ACTIVITY_CATEGORY_LABELS,
  catalog,
  isStructuralCallActivity,
} from '@autonomy-studio/shared';
import { ActivityToolbox } from './ActivityToolbox';
import { ACTIVITY_DND_MIME } from './activityDnd';
import { createCanvasStore } from './canvasStore';

const authorable = [...catalog.values()].filter((e) => !isStructuralCallActivity(e.type));

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

  it('hides execute_pipeline — the #4 A9 structural-call exclusion the flat palette carried', () => {
    renderToolbox();
    expect(screen.queryByRole('button', { name: 'Execute Pipeline' })).toBeNull();
    // The exclusion is real and removed exactly one entry, not the whole toolbox.
    expect(offeredNames()).toHaveLength(authorable.length);
    expect(authorable.length).toBe(catalog.size - 1);
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

  it('collapsing one group leaves the others open', async () => {
    const user = userEvent.setup();
    renderToolbox();
    await user.click(
      screen.getByRole('button', { name: `Collapse ${ACTIVITY_CATEGORY_LABELS.general}` }),
    );
    expect(screen.queryByRole('button', { name: 'HTTP Request' })).toBeNull();
    expect(screen.getByRole('button', { name: 'LLM Call' })).toBeTruthy();
  });
});
