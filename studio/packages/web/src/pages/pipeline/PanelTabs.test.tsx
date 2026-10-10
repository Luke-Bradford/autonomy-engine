import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { PanelTabs } from './PanelTabs';

/**
 * #1594 OR40 S5c — the strip's keyboard model is its own roving tabindex, not
 * Tabster's arrow-navigation mover. The mover put focusable `aria-hidden`
 * dummies beside the tabs (axe `aria-hidden-focus`), so it is switched off
 * and these tests pin what replaces it.
 */
afterEach(cleanup);

const TABS = [
  { key: 'general', label: 'General', content: <p>general body</p> },
  { key: 'source', label: 'Source', content: <p>source body</p> },
  { key: 'sink', label: 'Sink', content: <p>sink body</p> },
] as const;

function renderTabs(selected?: string) {
  render(
    <FluentProvider theme={webLightTheme}>
      <PanelTabs
        label="Activity settings"
        selected={selected as (typeof TABS)[number]['key'] | undefined}
        tabs={[...TABS] as [(typeof TABS)[number], ...(typeof TABS)[number][]]}
      />
    </FluentProvider>,
  );
  return {
    list: screen.getByRole('tablist', { name: 'Activity settings' }),
    tab: (name: string) => screen.getByRole('tab', { name }),
  };
}

describe('PanelTabs keyboard model', () => {
  it('has no Tabster mover and no focusable aria-hidden dummy', () => {
    const { list } = renderTabs();
    expect(list.hasAttribute('data-tabster')).toBe(false);
    expect(document.querySelector('[data-tabster-dummy]')).toBeNull();
  });

  it('puts only the selected tab in the tab order, and follows the selection', () => {
    const { tab } = renderTabs();
    expect(['General', 'Source', 'Sink'].map((n) => tab(n).tabIndex)).toEqual([0, -1, -1]);
    fireEvent.click(tab('Sink'));
    expect(tab('Sink').getAttribute('aria-selected')).toBe('true');
    expect(['General', 'Source', 'Sink'].map((n) => tab(n).tabIndex)).toEqual([-1, -1, 0]);
  });

  it('moves focus with the arrows and wraps at both ends, without selecting', () => {
    const { tab } = renderTabs();
    tab('General').focus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tab('Source'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tab('General'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(tab('Sink'));
    expect(tab('General').getAttribute('aria-selected')).toBe('true');
  });

  it('goes to the first and last tab with Home and End', () => {
    const { tab } = renderTabs();
    tab('Source').focus();
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(document.activeElement).toBe(tab('Sink'));
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(document.activeElement).toBe(tab('General'));
  });

  it('ignores other keys, and a modified arrow (Alt+Left is the browser Back)', () => {
    const { tab } = renderTabs();
    tab('Source').focus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    for (const mod of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'] as const) {
      fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft', [mod]: true });
    }
    expect(document.activeElement).toBe(tab('Source'));
  });

  it('flips the arrows right to left', () => {
    const { list, tab } = renderTabs();
    list.style.direction = 'rtl';
    tab('General').focus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(tab('Source'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tab('General'));
  });

  it('selects the focused tab with Enter or Space', async () => {
    const user = userEvent.setup();
    const { tab } = renderTabs();
    tab('General').focus();
    await user.keyboard('{ArrowRight}{Enter}');
    expect(tab('Source').getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{ArrowRight} ');
    expect(tab('Sink').getAttribute('aria-selected')).toBe('true');
    expect(['General', 'Source', 'Sink'].map((n) => tab(n).tabIndex)).toEqual([-1, -1, 0]);
  });

  it('keeps the strip reachable when the choice names no offered tab', () => {
    const { tab } = renderTabs('gone');
    expect(['General', 'Source', 'Sink'].map((n) => tab(n).tabIndex)).toEqual([0, -1, -1]);
  });
});
