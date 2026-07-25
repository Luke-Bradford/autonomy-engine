import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CommandBar } from './CommandBar';
import { PANE_ELEMENT_ID } from './SecondaryPane';
import { renderWithRouter } from '../testing/renderWithRouter';
import type { Crumb } from './routeHandle';

const MANAGE_TRIGGERS: Crumb[] = [
  { label: 'Manage', to: '/manage' },
  { label: 'Triggers', to: '/manage/triggers' },
];

function renderBar(
  crumbs: Crumb[] = MANAGE_TRIGGERS,
  pane?: Parameters<typeof CommandBar>[0]['pane'],
) {
  const view = renderWithRouter(<CommandBar crumbs={crumbs} pane={pane} />);
  return { ...view, trail: () => screen.getByRole('navigation', { name: 'Breadcrumb' }) };
}

describe('CommandBar breadcrumb', () => {
  it('renders the trail in order', () => {
    const { trail } = renderBar();
    expect(
      within(trail())
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Manage', 'Triggers']);
  });

  /**
   * Every crumb BUT the last is a link to its own matched path. The last is
   * where you already are: a link to the current page is a no-op the user
   * cannot tell apart from a broken one, so it is plain text carrying
   * `aria-current="page"` instead.
   */
  it('links every crumb except the last', () => {
    const { trail } = renderBar();
    const links = within(trail()).getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual(['Manage']);
    expect(links[0]).toHaveAttribute('href', '/manage');
  });

  it('marks the last crumb as the current page, and does not link it', () => {
    const { trail } = renderBar();
    const items = within(trail()).getAllByRole('listitem');
    expect(within(items[1]!).queryByRole('link')).toBeNull();
    expect(within(trail()).getByText('Triggers')).toHaveAttribute('aria-current', 'page');
  });

  /** A run id is a crumb like any other — the deepest, so it is not a link. */
  it('renders a three-deep trail with a dynamic leaf', () => {
    const { trail } = renderBar([
      { label: 'Monitor', to: '/monitor' },
      { label: 'Runs', to: '/monitor/runs' },
      { label: 'run_42', to: '/monitor/runs/run_42' },
    ]);
    expect(
      within(trail())
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Monitor', 'Runs', 'run_42']);
    expect(
      within(trail())
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual(['/monitor', '/monitor/runs']);
  });

  /**
   * A single crumb still gets `aria-current` and still is not a link — the Home
   * hub is exactly this case, and an off-by-one in "all but the last" would
   * show up here first.
   */
  it('handles a single-crumb trail', () => {
    const { trail } = renderBar([{ label: 'Home', to: '/' }]);
    expect(within(trail()).queryByRole('link')).toBeNull();
    expect(within(trail()).getByText('Home')).toHaveAttribute('aria-current', 'page');
  });

  /** No crumbs at all (a transient redirect route) must not render an empty landmark. */
  it('renders no breadcrumb landmark when there are no crumbs', () => {
    renderBar([]);
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull();
  });
});

describe('CommandBar pane toggle', () => {
  const toggle = () => screen.getByRole('button', { name: /navigation pane/i });

  it('is absent for a hub with no pane', () => {
    renderBar(MANAGE_TRIGGERS, undefined);
    expect(screen.queryByRole('button', { name: /navigation pane/i })).toBeNull();
  });

  /**
   * `aria-expanded` + `aria-controls` are the whole contract of a disclosure
   * button: they are what tells assistive tech that this control owns the pane
   * and what state the pane is in. The label changes with the state too, so the
   * meaning survives without the ARIA state being announced.
   */
  it('reports the expanded state and what it controls', async () => {
    const onToggle = vi.fn();
    renderBar(MANAGE_TRIGGERS, { collapsed: false, onToggle });

    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    expect(toggle()).toHaveAttribute('aria-controls', PANE_ELEMENT_ID);
    expect(toggle()).toHaveAccessibleName('Hide navigation pane');

    await userEvent.setup().click(toggle());
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('reports the collapsed state with the inverse label', () => {
    renderBar(MANAGE_TRIGGERS, { collapsed: true, onToggle: vi.fn() });
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(toggle()).toHaveAccessibleName('Show navigation pane');
  });
});
