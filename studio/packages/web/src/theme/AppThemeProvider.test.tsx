import { describe, expect, it } from 'vitest';
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

describe('AppThemeProvider', () => {
  it('mounts the Fluent provider with the class the --xy-* bridge is keyed on', () => {
    const store = createUiStore();
    const { container } = render(
      <AppThemeProvider store={store}>
        <span>content</span>
      </AppThemeProvider>,
    );
    expect(container.querySelector(`.${FLUENT_ROOT_CLASS}`)).not.toBeNull();
    expect(screen.getByText('content')).toBeInTheDocument();
  });

  it('mirrors the store mode onto the document root before paint', () => {
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
