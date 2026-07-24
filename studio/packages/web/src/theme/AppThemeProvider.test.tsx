import { afterEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { createUiStore } from '../stores/uiStore';
import { FLUENT_ROOT_CLASS } from './fluentTheme';
import { AppThemeProvider } from './AppThemeProvider';

/**
 * Fluent emits its `--colorXxx` design tokens as a rule scoped to the provider's
 * own root element, in a `<style id="fui-FluentProvider…">` tag. Collecting that
 * rule is how we prove a REAL re-theme happened: the provider's className cannot
 * show it (Fluent's theme class is `useId(...)`, a stable mount counter, so it is
 * identical across themes on one mounted provider and differs between two mounts
 * regardless of theme — asserting on it would be a test that either always fails
 * or always passes for the wrong reason).
 *
 * The rule is inserted through the CSSOM (`sheet.insertRule`), so the tag's
 * `textContent` is EMPTY — it has to be read off `sheet.cssRules`.
 */
function fluentTokenCss(): string {
  return [...document.querySelectorAll('style')]
    .flatMap((tag) => [...(tag.sheet?.cssRules ?? [])].map((rule) => rule.cssText))
    .filter((text) => text.includes('--colorNeutralBackground1'))
    .join('\n');
}

// The provider writes to the shared `document.documentElement` and has no
// unmount cleanup (the app is a single root, and clearing the attribute on
// unmount would be wrong for it), so reset the attribute between cases rather
// than letting one case's mode decide the next case's starting state.
afterEach(() => {
  delete document.documentElement.dataset.theme;
  document.documentElement.style.colorScheme = '';
});

describe('AppThemeProvider', () => {
  it('keeps the --xy-* bridge class on the token-bearing provider root', () => {
    const store = createUiStore();
    const { container } = render(
      <AppThemeProvider store={store}>
        <span>content</span>
      </AppThemeProvider>,
    );
    const root = container.querySelector(`.${FLUENT_ROOT_CLASS}`);
    expect(root).not.toBeNull();
    // Co-location is the load-bearing half (see providerBridge.test.tsx): the
    // bridge's `var(--colorXxx)` reads only resolve if our class sits on the
    // SAME element as Fluent's token class. Re-asserted here so the APP's
    // provider, not just a bare FluentProvider, is pinned to that contract.
    expect(root?.className).toMatch(/fui-FluentProvider/);
    expect(screen.getByText('content')).toBeInTheDocument();
  });

  // Named for what it proves: jsdom paints nothing, so no unit test can
  // distinguish `useLayoutEffect` from `useEffect` here (RTL's `act` flushes
  // both before the assertion). The before-paint rationale is a browser-verify
  // observation; this pins that a stored preference reaches the DOM at all.
  it('mirrors a stored preference onto the document root on mount', () => {
    const store = createUiStore();
    store.getState().setThemeMode('light');
    render(
      <AppThemeProvider store={store}>
        <span>content</span>
      </AppThemeProvider>,
    );
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
  });

  /**
   * The U1 contract: ONE store value drives BOTH mechanisms — Fluent's tokens
   * (and therefore, via the U0 bridge keyed on `.app-fluent-root`, React Flow's
   * `--xy-*` chrome) AND the `data-theme` attribute the MVP palette keys on.
   * A change that re-themed only one of the two would leave half the UI stranded
   * in the old mode; this is the regression guard for that.
   */
  it('re-themes Fluent AND flips data-theme when the store changes', () => {
    const store = createUiStore();
    store.getState().setThemeMode('dark');
    render(
      <AppThemeProvider store={store}>
        <span>content</span>
      </AppThemeProvider>,
    );

    const darkTokens = fluentTokenCss();
    expect(darkTokens).not.toBe('');
    expect(document.documentElement.dataset.theme).toBe('dark');

    act(() => {
      store.getState().setThemeMode('light');
    });

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
    // Same mounted provider, different token values.
    expect(fluentTokenCss()).not.toBe(darkTokens);
  });
});
