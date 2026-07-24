import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_THEME_MODE } from '../theme/fluentTheme';
import { THEME_STORAGE_KEY, createUiStore, type PreferenceStorage } from './uiStore';

/**
 * The storage is INJECTED rather than read from the ambient `localStorage`:
 * this jsdom+Node environment exposes a `localStorage` stub with no methods, so
 * ambient-storage assertions would be testing the environment, not the store.
 * Each case gets its own storage, so nothing leaks between them.
 */
function fakeStorage(
  seed?: Record<string, string>,
): PreferenceStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed ?? {}));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

describe('uiStore theme mode', () => {
  it('falls back to DEFAULT_THEME_MODE when nothing is stored', () => {
    expect(createUiStore(fakeStorage()).getState().themeMode).toBe(DEFAULT_THEME_MODE);
  });

  it('falls back to DEFAULT_THEME_MODE when there is no storage at all', () => {
    expect(createUiStore(undefined).getState().themeMode).toBe(DEFAULT_THEME_MODE);
  });

  it('honours a valid stored preference', () => {
    const storage = fakeStorage({ [THEME_STORAGE_KEY]: 'light' });
    expect(createUiStore(storage).getState().themeMode).toBe('light');
  });

  it('ignores a garbage stored value rather than trusting it', () => {
    // A bad value would otherwise index THEMES to `undefined` and crash the
    // provider, so "unrecognised" must degrade to "absent".
    const storage = fakeStorage({ [THEME_STORAGE_KEY]: 'solarized' });
    expect(createUiStore(storage).getState().themeMode).toBe(DEFAULT_THEME_MODE);
  });

  it('persists the mode on set', () => {
    const storage = fakeStorage();
    const store = createUiStore(storage);
    store.getState().setThemeMode('light');
    expect(store.getState().themeMode).toBe('light');
    expect(storage.data.get(THEME_STORAGE_KEY)).toBe('light');
  });

  it('toggles between the two modes', () => {
    const store = createUiStore(fakeStorage());
    const first = store.getState().themeMode;
    store.getState().toggleThemeMode();
    expect(store.getState().themeMode).toBe(first === 'dark' ? 'light' : 'dark');
    store.getState().toggleThemeMode();
    expect(store.getState().themeMode).toBe(first);
  });

  // Safari private browsing throws on Web Storage access. Losing the stored
  // preference is acceptable; taking the shell down over it is not.
  it('survives a storage that throws on read', () => {
    const storage: PreferenceStorage = {
      getItem: vi.fn(() => {
        throw new Error('SecurityError');
      }),
      setItem: vi.fn(),
    };
    expect(createUiStore(storage).getState().themeMode).toBe(DEFAULT_THEME_MODE);
  });

  it('survives a storage that throws on write', () => {
    const storage: PreferenceStorage = {
      getItem: () => null,
      setItem: vi.fn(() => {
        throw new Error('QuotaExceededError');
      }),
    };
    const store = createUiStore(storage);
    expect(() => store.getState().setThemeMode('light')).not.toThrow();
    // The in-memory mode is still authoritative for the session.
    expect(store.getState().themeMode).toBe('light');
  });
});
