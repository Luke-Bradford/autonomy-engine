import { webDarkTheme, webLightTheme, type Theme } from '@fluentui/react-components';

/** The two shipped themes. `uiStore.themeMode` selects between them (U1). */
export type ThemeMode = 'light' | 'dark';

export const THEMES: Record<ThemeMode, Theme> = {
  light: webLightTheme,
  dark: webDarkTheme,
};

/**
 * The mode used when the user has expressed no preference — `uiStore` falls
 * back to it when stored storage is absent, unreadable, or holds a value that
 * is not a `ThemeMode`. It stays DARK deliberately: seeding from the OS's
 * `prefers-color-scheme` instead would silently flip the shipped MVP's
 * dark-only look to light for anyone on a light-mode machine. A Settings
 * surface (U15) is where an explicit "follow system" option would belong.
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
 * match the Fluent theme. Deliberately side-effect-minimal and idempotent — no
 * state, no listeners; reactivity lives in `AppThemeProvider`, which calls this
 * whenever `uiStore.themeMode` changes.
 */
export function syncColorScheme(mode: ThemeMode): void {
  const root = document.documentElement;
  root.dataset.theme = mode;
  root.style.colorScheme = mode;
}
