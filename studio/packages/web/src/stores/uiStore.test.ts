import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_THEME_MODE } from '../theme/fluentTheme';
import {
  PANE_DEFAULT_WIDTH,
  PANE_MAX_WIDTH,
  PANE_MIN_WIDTH,
  PANE_STORAGE_KEY,
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
 * U3 — the secondary pane's width and collapse state.
 *
 * Stored as one JSON record rather than two keys: they are written together
 * (the shell reads both on mount) and a half-applied preference — a width that
 * survived a write the collapse flag did not — is a state neither the user nor
 * the code asked for.
 */
describe('uiStore secondary pane', () => {
  it('starts at the default width, expanded, when nothing is stored', () => {
    const state = createUiStore(fakeStorage()).getState();
    expect(state.paneWidth).toBe(PANE_DEFAULT_WIDTH);
    expect(state.paneCollapsed).toBe(false);
  });

  it('honours a valid stored record', () => {
    const storage = fakeStorage({
      [PANE_STORAGE_KEY]: JSON.stringify({ width: 300, collapsed: true }),
    });
    const state = createUiStore(storage).getState();
    expect(state.paneWidth).toBe(300);
    expect(state.paneCollapsed).toBe(true);
  });

  it.each([
    ['unparseable JSON', '{not json'],
    ['a JSON scalar rather than a record', '42'],
    ['null, which typeof-reports as "object"', 'null'],
    ['an array, which also typeof-reports as "object"', '[240, false]'],
    ['a record with the wrong field types', '{"width":"300","collapsed":"yes"}'],
    ['a null width, which is not a number at all', '{"width":null,"collapsed":true}'],
    // `1e999` overflows to Infinity, which IS `typeof 'number'` — so this is
    // the only input that reaches the finiteness check, and the only one that
    // kills it. The `null` case above was mislabelled "non-finite" and is
    // rejected one guard earlier; both are kept because they fail differently.
    // Note the `collapsed: true` in both: a fallback that only reset the WIDTH
    // would still pass an assertion on width alone.
    ['a width that overflows to Infinity', '{"width":1e999,"collapsed":true}'],
  ])('falls back to the defaults for %s', (_label, raw) => {
    const state = createUiStore(fakeStorage({ [PANE_STORAGE_KEY]: raw })).getState();
    expect(state.paneWidth).toBe(PANE_DEFAULT_WIDTH);
    expect(state.paneCollapsed).toBe(false);
  });

  /**
   * A width out of range is CLAMPED, not discarded: unlike the theme mode, a
   * number has a defensible nearest-valid value, and a user who dragged the
   * splitter to the edge should get the edge back rather than the default.
   * Clamping on READ as well as on write matters because the bounds can change
   * between releases — a 900px width stored by a build with a wider maximum
   * must not resurrect a pane that overruns today's shell.
   */
  it.each([
    ['below the minimum', PANE_MIN_WIDTH - 50, PANE_MIN_WIDTH],
    ['above the maximum', PANE_MAX_WIDTH + 200, PANE_MAX_WIDTH],
  ])('clamps a stored width %s', (_label, stored, expected) => {
    const storage = fakeStorage({
      [PANE_STORAGE_KEY]: JSON.stringify({ width: stored, collapsed: false }),
    });
    expect(createUiStore(storage).getState().paneWidth).toBe(expected);
  });

  it.each([
    ['below the minimum', PANE_MIN_WIDTH - 50, PANE_MIN_WIDTH],
    ['above the maximum', PANE_MAX_WIDTH + 200, PANE_MAX_WIDTH],
    ['fractional, from a pointer drag', 260.4, 260],
  ])('clamps a set width %s', (_label, requested, expected) => {
    const store = createUiStore(fakeStorage());
    store.getState().setPaneWidth(requested);
    expect(store.getState().paneWidth).toBe(expected);
  });

  /** A NaN from a bad measurement must not become the pane's width. */
  it('ignores a non-finite set width rather than storing NaN', () => {
    const store = createUiStore(fakeStorage());
    store.getState().setPaneWidth(Number.NaN);
    expect(store.getState().paneWidth).toBe(PANE_DEFAULT_WIDTH);
  });

  it('persists width and collapse together on either setter', () => {
    const storage = fakeStorage();
    const store = createUiStore(storage);

    store.getState().setPaneWidth(300);
    expect(JSON.parse(storage.data.get(PANE_STORAGE_KEY)!)).toEqual({
      width: 300,
      collapsed: false,
    });

    store.getState().setPaneCollapsed(true);
    expect(JSON.parse(storage.data.get(PANE_STORAGE_KEY)!)).toEqual({
      width: 300,
      collapsed: true,
    });
  });

  it('round-trips through a fresh store, which is what a reload does', () => {
    const storage = fakeStorage();
    const first = createUiStore(storage);
    first.getState().setPaneWidth(320);
    first.getState().setPaneCollapsed(true);

    const reloaded = createUiStore(storage).getState();
    expect(reloaded.paneWidth).toBe(320);
    expect(reloaded.paneCollapsed).toBe(true);
  });

  it('survives a storage that throws on read', () => {
    const storage: PreferenceStorage = {
      getItem: vi.fn(() => {
        throw new Error('SecurityError');
      }),
      setItem: vi.fn(),
    };
    const state = createUiStore(storage).getState();
    expect(state.paneWidth).toBe(PANE_DEFAULT_WIDTH);
    expect(state.paneCollapsed).toBe(false);
  });

  it('survives a storage that throws on write', () => {
    const storage: PreferenceStorage = {
      getItem: () => null,
      setItem: vi.fn(() => {
        throw new Error('QuotaExceededError');
      }),
    };
    const store = createUiStore(storage);
    expect(() => store.getState().setPaneCollapsed(true)).not.toThrow();
    expect(store.getState().paneCollapsed).toBe(true);
  });

  /** The two slices share one store but must not share one storage key. */
  it('keeps the theme preference and the pane preference in separate keys', () => {
    const storage = fakeStorage();
    const store = createUiStore(storage);
    store.getState().setThemeMode('light');
    store.getState().setPaneWidth(300);

    expect(storage.data.get(THEME_STORAGE_KEY)).toBe('light');
    expect(createUiStore(storage).getState().themeMode).toBe('light');
    expect(createUiStore(storage).getState().paneWidth).toBe(300);
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
