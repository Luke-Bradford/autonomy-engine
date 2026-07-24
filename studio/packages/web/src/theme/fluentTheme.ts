import { webDarkTheme, webLightTheme, type Theme } from '@fluentui/react-components';

/** The two shipped themes; a user-facing toggle + persistence arrives in U1. */
export type ThemeMode = 'light' | 'dark';

export const THEMES: Record<ThemeMode, Theme> = {
  light: webLightTheme,
  dark: webDarkTheme,
};

/**
 * U0 mounts the Fluent provider in DARK to preserve the shipped MVP's dark-only
 * look; the light/dark toggle + persisted preference (and the Settings surface)
 * are U1/U15. Keeping the mode a single exported constant means U1 swaps in a
 * store value without touching the provider wiring.
 */
export const DEFAULT_THEME_MODE: ThemeMode = 'dark';

/**
 * The CSS class placed on the `<FluentProvider>` root element. The `--xy-*`
 * theme bridge (`xyThemeBridge.css`) is keyed on it so React Flow's chrome
 * overrides resolve against the Fluent `--color*` design tokens the provider
 * emits on that SAME element. This is load-bearing: Fluent scopes its tokens to
 * the provider root (NOT `:root`/`html`), so the bridge must live where the
 * tokens do. Keep this in sync with the selector in `xyThemeBridge.css`.
 */
export const FLUENT_ROOT_CLASS = 'app-fluent-root';

/**
 * Mirror the active Fluent mode onto the document root so the pre-Fluent
 * `index.css` variables and native form controls (scrollbars, date pickers)
 * match the Fluent theme. Deliberately side-effect-minimal — no state, no
 * listeners; the reactive toggle store is U1's job.
 */
export function syncColorScheme(mode: ThemeMode): void {
  const root = document.documentElement;
  root.dataset.theme = mode;
  root.style.colorScheme = mode;
}
