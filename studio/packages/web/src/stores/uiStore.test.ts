import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_THEME_MODE } from '../theme/fluentTheme';
import {
  THEME_STORAGE_KEY,
  ambientStorage,
  createUiStore,
  type PreferenceStorage,
} from './uiStore';

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

/**
 * `ambientStorage()` runs at module-eval time via the `uiStore` singleton, so
 * it is the one place in this file where an unguarded throw white-screens the
 * whole app during `main.tsx`'s import graph. Its guards must be exercised
 * directly: every case above injects a storage, so none of them would notice
 * this function losing its try/catch.
 */
describe('ambientStorage', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

  afterEach(() => {
    if (original) {
      Object.defineProperty(globalThis, 'localStorage', original);
    } else {
      Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });

  it('yields undefined when the property getter itself throws', () => {
    // Safari private browsing / a blocked-cookies policy: the ACCESS throws,
    // before any method is called.
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError');
      },
    });
    expect(() => ambientStorage()).not.toThrow();
    expect(ambientStorage()).toBeUndefined();
  });

  it('yields undefined for a stub that has no getItem', () => {
    // What this jsdom+Node environment actually provides: an object shaped
    // nothing like Storage. Handing it back would throw on first use.
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {},
    });
    expect(ambientStorage()).toBeUndefined();
  });

  it('yields undefined when there is no localStorage at all', () => {
    Reflect.deleteProperty(globalThis, 'localStorage');
    expect(ambientStorage()).toBeUndefined();
  });

  it('passes through a usable Storage implementation', () => {
    const real = { getItem: vi.fn(() => null), setItem: vi.fn() };
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: real });
    expect(ambientStorage()).toBe(real);
    // ...and the store then reads through it rather than ignoring it.
    createUiStore();
    expect(real.getItem).toHaveBeenCalledWith(THEME_STORAGE_KEY);
  });
});
