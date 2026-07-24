import { createStore, type StoreApi } from 'zustand/vanilla';
import { DEFAULT_THEME_MODE, type ThemeMode } from '../theme/fluentTheme';

/**
 * Local UI state — the shell's own preferences, deliberately separate from the
 * domain stores (`canvasStore`) and from URL state. U1 seeded it with the theme
 * mode; U3 adds the secondary pane's width and collapse state alongside.
 */
export interface UiState {
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  /**
   * Width of the secondary pane in px, always within
   * [`PANE_MIN_WIDTH`, `PANE_MAX_WIDTH`]. Meaningful even while collapsed —
   * that is the width expanding restores.
   */
  paneWidth: number;
  paneCollapsed: boolean;
  setPaneWidth: (width: number) => void;
  setPaneCollapsed: (collapsed: boolean) => void;
}

export type UiStore = StoreApi<UiState>;

export const THEME_STORAGE_KEY = 'autonomy-studio.theme';
export const PANE_STORAGE_KEY = 'autonomy-studio.pane';

/**
 * Pane width bounds. The minimum is a readable list width; the maximum keeps
 * the workspace usable on a laptop screen. `PANE_RESIZE_STEP` is the keyboard
 * splitter's increment — the pane must be resizable without a pointer (the
 * spec's "keyboard-operable splitter" accessibility criterion).
 */
export const PANE_MIN_WIDTH = 180;
export const PANE_MAX_WIDTH = 480;
export const PANE_DEFAULT_WIDTH = 240;
export const PANE_RESIZE_STEP = 16;

/**
 * Out-of-range widths are CLAMPED rather than rejected, unlike the theme mode:
 * a number has a defensible nearest-valid value, so a user who dragged the
 * splitter to the edge gets the edge back. A non-finite input has no nearest
 * value and falls back to the default — `NaN` would otherwise propagate into
 * the grid track and collapse the pane to nothing.
 *
 * Rounded because the value becomes a px track: sub-pixel widths from a pointer
 * drag would otherwise be persisted and re-read forever.
 */
export function clampPaneWidth(width: number): number {
  if (!Number.isFinite(width)) return PANE_DEFAULT_WIDTH;
  return Math.round(Math.min(PANE_MAX_WIDTH, Math.max(PANE_MIN_WIDTH, width)));
}

/** The slice of the Web Storage API a stored preference actually needs. */
export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Web Storage is best-effort and is NOT guaranteed to exist: it is absent
 * outside a browser, THROWS on access under Safari private browsing / a
 * blocked-cookies policy, and the jsdom+Node test environment exposes a stub
 * with no methods at all. Every touch is therefore guarded and every failure
 * degrades to "no stored preference" — a lost preference is a nicety, taking
 * the shell down over one is not.
 */
export function ambientStorage(): PreferenceStorage | undefined {
  try {
    // Reading the property itself can throw, so this is inside the try.
    const storage: unknown = globalThis.localStorage;
    return typeof (storage as PreferenceStorage | undefined)?.getItem === 'function'
      ? (storage as PreferenceStorage)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read one stored preference, or the fallback.
 *
 * ONE implementation for every slice (project standard: export once, import
 * everywhere). The theme slice had this guard to itself until U3 needed a
 * second one, and a hand-rolled copy per preference is how one of them ends up
 * without the try/catch — which is a white screen, not a lost preference,
 * because `readStored` runs at module-eval time through the `uiStore` singleton.
 *
 * `parse` receives the RAW string and returns `undefined` for anything it does
 * not recognise. An unrecognised value is treated as ABSENT rather than
 * trusted: this is the same fail-closed posture the engine's config parsing
 * takes, and the reason a garbage theme string cannot reach `THEMES` and
 * resolve to `undefined`.
 */
function readStored<T>(
  storage: PreferenceStorage | undefined,
  key: string,
  parse: (raw: string) => T | undefined,
  fallback: T,
): T {
  try {
    const raw = storage?.getItem(key);
    return (raw === null || raw === undefined ? undefined : parse(raw)) ?? fallback;
  } catch {
    return fallback;
  }
}

/** Persistence is best-effort; a failure leaves the in-memory value in charge. */
function writeStored(storage: PreferenceStorage | undefined, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // Safari private browsing / a quota failure. The session still works.
  }
}

function parseThemeMode(raw: string): ThemeMode | undefined {
  return raw === 'light' || raw === 'dark' ? raw : undefined;
}

/** The pane preference as it is persisted — one record, written atomically. */
interface StoredPane {
  width: number;
  collapsed: boolean;
}

/**
 * `JSON.parse` answers `null` for the input `"null"` and an array for `"[]"`,
 * both of which `typeof`-report as `'object'` — so the shape check has to
 * exclude them explicitly or a stored `null` would sail through and throw on
 * first property access.
 *
 * The width is clamped HERE, on the way in, not only on write: the bounds can
 * change between releases, and a 900px width persisted by a build with a wider
 * maximum must not resurrect a pane that overruns today's shell.
 */
function parsePane(raw: string): StoredPane | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { width, collapsed } = value as Record<string, unknown>;
  if (typeof width !== 'number' || !Number.isFinite(width)) return undefined;
  if (typeof collapsed !== 'boolean') return undefined;
  return { width: clampPaneWidth(width), collapsed };
}

/**
 * Factory (matching `createCanvasStore`'s shape) so a test can supply its own
 * storage and keep its state to itself — the ambient `localStorage` is not
 * usable in the test environment, and injecting it keeps these cases testing
 * the store's logic rather than the DOM implementation underneath. The app uses
 * the `uiStore` singleton below: one shell, one set of preferences.
 */
export function createUiStore(storage: PreferenceStorage | undefined = ambientStorage()): UiStore {
  const pane = readStored(storage, PANE_STORAGE_KEY, parsePane, {
    width: PANE_DEFAULT_WIDTH,
    collapsed: false,
  });

  return createStore<UiState>((set, get) => {
    /* Both pane setters persist the WHOLE record, so the two fields can never
       drift apart in storage — a width that survived a write the collapse flag
       did not is a state neither the user nor the code asked for. */
    const persistPane = (next: StoredPane) =>
      writeStored(storage, PANE_STORAGE_KEY, JSON.stringify(next));

    return {
      themeMode: readStored(storage, THEME_STORAGE_KEY, parseThemeMode, DEFAULT_THEME_MODE),
      setThemeMode: (mode) => {
        writeStored(storage, THEME_STORAGE_KEY, mode);
        set({ themeMode: mode });
      },

      paneWidth: pane.width,
      paneCollapsed: pane.collapsed,
      setPaneWidth: (width) => {
        const paneWidth = clampPaneWidth(width);
        persistPane({ width: paneWidth, collapsed: get().paneCollapsed });
        set({ paneWidth });
      },
      setPaneCollapsed: (paneCollapsed) => {
        persistPane({ width: get().paneWidth, collapsed: paneCollapsed });
        set({ paneCollapsed });
      },
    };
  });
}

export const uiStore = createUiStore();
