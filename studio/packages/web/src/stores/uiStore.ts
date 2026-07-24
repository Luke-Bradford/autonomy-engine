import { createStore, type StoreApi } from 'zustand/vanilla';
import { DEFAULT_THEME_MODE, type ThemeMode } from '../theme/fluentTheme';

/**
 * Local UI state — the shell's own preferences, deliberately separate from the
 * domain stores (`canvasStore`) and from URL state. U1 seeds it with the theme
 * mode; U2 adds the secondary pane's width/collapse alongside.
 */
export interface UiState {
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
}

export type UiStore = StoreApi<UiState>;

export const THEME_STORAGE_KEY = 'autonomy-studio.theme';

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

function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark';
}

/**
 * An unrecognised stored value is treated as absent rather than trusted — the
 * mode indexes `THEMES`, so a garbage string would resolve to `undefined` and
 * crash the provider.
 */
function readStoredTheme(storage: PreferenceStorage | undefined): ThemeMode {
  try {
    const raw = storage?.getItem(THEME_STORAGE_KEY);
    return isThemeMode(raw) ? raw : DEFAULT_THEME_MODE;
  } catch {
    return DEFAULT_THEME_MODE;
  }
}

function writeStoredTheme(storage: PreferenceStorage | undefined, mode: ThemeMode): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Persistence is best-effort; the in-memory mode still drives this session.
  }
}

/**
 * Factory (matching `createCanvasStore`'s shape) so a test can supply its own
 * storage and keep its state to itself — the ambient `localStorage` is not
 * usable in the test environment, and injecting it keeps these cases testing
 * the store's logic rather than the DOM implementation underneath. The app uses
 * the `uiStore` singleton below: one shell, one set of preferences.
 */
export function createUiStore(storage: PreferenceStorage | undefined = ambientStorage()): UiStore {
  return createStore<UiState>((set) => ({
    themeMode: readStoredTheme(storage),
    setThemeMode: (mode) => {
      writeStoredTheme(storage, mode);
      set({ themeMode: mode });
    },
  }));
}

export const uiStore = createUiStore();
