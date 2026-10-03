import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_THEME_MODE } from '../theme/fluentTheme';
import {
  CANVAS_MIN_HEIGHT,
  DOCK_HEIGHT_STORAGE_KEY,
  DOCK_MIN_HEIGHT,
  DOCK_OPEN_STORAGE_KEY,
  DOCK_SPLITTER_SIZE,
  CANVAS_MIN_WIDTH,
  DOCK_MIN_WIDTH,
  DOCK_POSITION_STORAGE_KEY,
  DOCK_WIDTH_STORAGE_KEY,
  dockMaxWidth,
  HISTORY_OPEN_STORAGE_KEY,
  MINIMAP_STORAGE_KEY,
  PROBLEMS_OPEN_STORAGE_KEY,
  DOCK_NODE_TAB_STORAGE_KEY,
  DOCK_PIPELINE_TAB_STORAGE_KEY,
  PROBLEMS_DEFAULT_WIDTH,
  PROBLEMS_MAX_WIDTH,
  PROBLEMS_MIN_WIDTH,
  PROBLEMS_WIDTH_STORAGE_KEY,
  problemsMaxWidth,
  dockMaxHeight,
  PANE_DEFAULT_WIDTH,
  PANE_MAX_WIDTH,
  PANE_MIN_WIDTH,
  PANE_STORAGE_KEY,
  RUN_GRID_COLUMN_MAX_WIDTH,
  RUN_GRID_COLUMN_WIDTHS,
  RUN_GRID_HIDDEN_STORAGE_KEY,
  RUN_GRID_WIDTHS_STORAGE_KEY,
  THEME_STORAGE_KEY,
  TOOLBOX_COLLAPSED_STORAGE_KEY,
  TOOLBOX_DEFAULT_WIDTH,
  TOOLBOX_MAX_WIDTH,
  TOOLBOX_MIN_WIDTH,
  TOOLBOX_WIDTH_STORAGE_KEY,
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

describe('uiStore minimap (#1394 OR3)', () => {
  it('is shown by default and ignores a garbage stored value', () => {
    expect(createUiStore(fakeStorage()).getState().minimapHidden).toBe(false);
    expect(
      createUiStore(fakeStorage({ [MINIMAP_STORAGE_KEY]: 'yes' })).getState().minimapHidden,
    ).toBe(false);
  });

  it('persists a fold, and a fresh store (a reload) keeps it', () => {
    const storage = fakeStorage();
    createUiStore(storage).getState().setMinimapHidden(true);
    expect(storage.data.get(MINIMAP_STORAGE_KEY)).toBe('true');
    expect(createUiStore(storage).getState().minimapHidden).toBe(true);
    createUiStore(storage).getState().setMinimapHidden(false);
    expect(createUiStore(storage).getState().minimapHidden).toBe(false);
  });
});

describe('uiStore version history (#1475 OR27)', () => {
  it('starts closed', () => {
    expect(createUiStore(fakeStorage()).getState().historyOpen).toBe(false);
  });

  it('persists open and closed across a new store on the same storage', () => {
    const storage = fakeStorage();
    createUiStore(storage).getState().setHistoryOpen(true);
    expect(storage.data.get(HISTORY_OPEN_STORAGE_KEY)).toBe('true');
    expect(createUiStore(storage).getState().historyOpen).toBe(true);
    createUiStore(storage).getState().setHistoryOpen(false);
    expect(createUiStore(storage).getState().historyOpen).toBe(false);
  });

  it('reads a garbage stored value as closed', () => {
    expect(
      createUiStore(fakeStorage({ [HISTORY_OPEN_STORAGE_KEY]: 'yes' })).getState().historyOpen,
    ).toBe(false);
  });
});

describe('uiStore property dock (#1475 OR27)', () => {
  it('starts open, with Problems open, at the default share', () => {
    const state = createUiStore(fakeStorage()).getState();
    expect(state.dockOpen).toBe(true);
    expect(state.problemsOpen).toBe(true);
    expect(state.dockHeight).toBeNull();
  });

  it('persists each preference across a new store on the same storage', () => {
    const storage = fakeStorage();
    const first = createUiStore(storage).getState();
    first.setDockHeight(333.6);
    first.setDockOpen(false);
    first.setProblemsOpen(false);
    const second = createUiStore(storage).getState();
    expect(second.dockHeight).toBe(334);
    expect(second.dockOpen).toBe(false);
    expect(second.problemsOpen).toBe(false);
  });

  it('keeps one preference when another key is garbage', () => {
    const state = createUiStore(
      fakeStorage({
        [DOCK_HEIGHT_STORAGE_KEY]: '360',
        [DOCK_OPEN_STORAGE_KEY]: 'maybe',
        [PROBLEMS_OPEN_STORAGE_KEY]: 'false',
      }),
    ).getState();
    expect(state.dockHeight).toBe(360);
    expect(state.dockOpen).toBe(true);
    expect(state.problemsOpen).toBe(false);
  });

  it.each(['', 'abc', '-50', '1e9', '12.5', 'NaN', '99999999999999999999'])(
    'reads a stored height of %j as not resized',
    (raw) => {
      expect(
        createUiStore(fakeStorage({ [DOCK_HEIGHT_STORAGE_KEY]: raw })).getState().dockHeight,
      ).toBeNull();
    },
  );

  it('raises a height under the floor to the floor, on write and on read', () => {
    const storage = fakeStorage({ [DOCK_HEIGHT_STORAGE_KEY]: '40' });
    const store = createUiStore(storage);
    expect(store.getState().dockHeight).toBe(DOCK_MIN_HEIGHT);
    store.getState().setDockHeight(10);
    expect(store.getState().dockHeight).toBe(DOCK_MIN_HEIGHT);
    expect(storage.data.get(DOCK_HEIGHT_STORAGE_KEY)).toBe(String(DOCK_MIN_HEIGHT));
  });

  /** The ceiling is the container's, so a tall-monitor height is kept as is. */
  it('stores a height above any one column, uncut', () => {
    const store = createUiStore(fakeStorage());
    store.getState().setDockHeight(1400);
    expect(store.getState().dockHeight).toBe(1400);
  });

  it('goes back to the default share, and stays there, on null', () => {
    const storage = fakeStorage();
    const store = createUiStore(storage);
    store.getState().setDockHeight(400);
    store.getState().setDockHeight(null);
    expect(store.getState().dockHeight).toBeNull();
    expect(createUiStore(storage).getState().dockHeight).toBeNull();
  });
});

describe('dockMaxHeight (#1475)', () => {
  it('caps the dock at three quarters of a tall column', () => {
    expect(dockMaxHeight(1000)).toBe(750);
  });

  it('keeps the canvas floor in a shorter column', () => {
    // 75% of 600 is 450, which would leave the canvas 142px.
    expect(dockMaxHeight(600)).toBe(600 - DOCK_SPLITTER_SIZE - CANVAS_MIN_HEIGHT);
  });

  /** A measured column is fractional; the cap must never round UP past what CSS draws. */
  it('floors a fractional cap to a whole pixel', () => {
    expect(dockMaxHeight(1000.9)).toBe(750);
    expect(dockMaxHeight(700.6)).toBe(472);
  });

  it('never goes under the dock floor', () => {
    expect(dockMaxHeight(300)).toBe(DOCK_MIN_HEIGHT);
  });
});

describe('uiStore dock position (#1475 OR27)', () => {
  it('starts at the bottom, at the default width', () => {
    const state = createUiStore(fakeStorage()).getState();
    expect(state.dockPosition).toBe('bottom');
    expect(state.dockWidth).toBeNull();
  });

  it('persists the position and the width across a new store on the same storage', () => {
    const storage = fakeStorage();
    const first = createUiStore(storage).getState();
    first.setDockPosition('right');
    first.setDockWidth(1234.4);
    const second = createUiStore(storage).getState();
    expect(second.dockPosition).toBe('right');
    // Four digits: 60% of a wide monitor is over 999px.
    expect(second.dockWidth).toBe(1234);
  });

  it('keeps the height when the width is set, and the other way round', () => {
    const store = createUiStore(fakeStorage());
    store.getState().setDockHeight(300);
    store.getState().setDockWidth(500);
    expect(store.getState().dockHeight).toBe(300);
    expect(store.getState().dockWidth).toBe(500);
  });

  it.each(['left', 'top', '', 'RIGHT'])('reads a stored position of %j as the bottom', (raw) => {
    expect(
      createUiStore(fakeStorage({ [DOCK_POSITION_STORAGE_KEY]: raw })).getState().dockPosition,
    ).toBe('bottom');
  });

  it.each(['', 'abc', '-50', '1e9', '12.5', '99999999999999999999'])(
    'reads a stored width of %j as not resized',
    (raw) => {
      expect(
        createUiStore(fakeStorage({ [DOCK_WIDTH_STORAGE_KEY]: raw })).getState().dockWidth,
      ).toBeNull();
    },
  );

  it('raises a width under the floor to the floor, on write and on read', () => {
    const storage = fakeStorage({ [DOCK_WIDTH_STORAGE_KEY]: '90' });
    const store = createUiStore(storage);
    expect(store.getState().dockWidth).toBe(DOCK_MIN_WIDTH);
    store.getState().setDockWidth(10);
    expect(storage.data.get(DOCK_WIDTH_STORAGE_KEY)).toBe(String(DOCK_MIN_WIDTH));
    store.getState().setDockWidth(null);
    expect(createUiStore(storage).getState().dockWidth).toBeNull();
  });
});

describe('dockMaxWidth (#1475)', () => {
  it('caps a right-hand dock at three fifths of a wide column', () => {
    expect(dockMaxWidth(1500)).toBe(900);
  });

  it('keeps the canvas floor in a narrower column, floored', () => {
    // 60% of 600.7 is 360, which would leave the canvas 232 beside the divider.
    expect(dockMaxWidth(600.7)).toBe(Math.floor(600.7 - DOCK_SPLITTER_SIZE - CANVAS_MIN_WIDTH));
  });

  it('never goes under the dock floor', () => {
    expect(dockMaxWidth(400)).toBe(DOCK_MIN_WIDTH);
  });
});

describe('uiStore Activities toolbox (#1475 OR27)', () => {
  it('starts expanded at the default width', () => {
    const state = createUiStore(fakeStorage()).getState();
    expect(state.toolboxWidth).toBe(TOOLBOX_DEFAULT_WIDTH);
    expect(state.toolboxCollapsed).toBe(false);
  });

  it('persists the width and the fold across a new store on the same storage', () => {
    const storage = fakeStorage();
    const first = createUiStore(storage).getState();
    first.setToolboxWidth(251.6);
    first.setToolboxCollapsed(true);
    expect(storage.data.get(TOOLBOX_WIDTH_STORAGE_KEY)).toBe('252');
    expect(storage.data.get(TOOLBOX_COLLAPSED_STORAGE_KEY)).toBe('true');
    const second = createUiStore(storage).getState();
    expect(second.toolboxWidth).toBe(252);
    expect(second.toolboxCollapsed).toBe(true);
  });

  it('clamps a width to its bounds on write and on read', () => {
    const store = createUiStore(fakeStorage());
    store.getState().setToolboxWidth(20);
    expect(store.getState().toolboxWidth).toBe(TOOLBOX_MIN_WIDTH);
    store.getState().setToolboxWidth(9000);
    expect(store.getState().toolboxWidth).toBe(TOOLBOX_MAX_WIDTH);
    // A bound tightened by a later release still applies to a stored value.
    expect(
      createUiStore(fakeStorage({ [TOOLBOX_WIDTH_STORAGE_KEY]: '900' })).getState().toolboxWidth,
    ).toBe(TOOLBOX_MAX_WIDTH);
  });

  it('keeps the default for a non-finite or garbage width', () => {
    const store = createUiStore(fakeStorage());
    store.getState().setToolboxWidth(Number.NaN);
    expect(store.getState().toolboxWidth).toBe(TOOLBOX_DEFAULT_WIDTH);
    for (const raw of ['', '1e3', '-200', 'wide', '12345']) {
      expect(
        createUiStore(fakeStorage({ [TOOLBOX_WIDTH_STORAGE_KEY]: raw })).getState().toolboxWidth,
      ).toBe(TOOLBOX_DEFAULT_WIDTH);
    }
    expect(
      createUiStore(fakeStorage({ [TOOLBOX_COLLAPSED_STORAGE_KEY]: 'yes' })).getState()
        .toolboxCollapsed,
    ).toBe(false);
  });
});

describe('uiStore Problems column (#1475 OR27)', () => {
  it('starts at the default width and persists a new one across a new store', () => {
    const storage = fakeStorage();
    const first = createUiStore(storage).getState();
    expect(first.problemsWidth).toBe(PROBLEMS_DEFAULT_WIDTH);
    first.setProblemsWidth(351.4);
    expect(storage.data.get(PROBLEMS_WIDTH_STORAGE_KEY)).toBe('351');
    expect(createUiStore(storage).getState().problemsWidth).toBe(351);
  });

  it('clamps a width to its bounds on write and on read', () => {
    const store = createUiStore(fakeStorage());
    store.getState().setProblemsWidth(10);
    expect(store.getState().problemsWidth).toBe(PROBLEMS_MIN_WIDTH);
    store.getState().setProblemsWidth(9000);
    expect(store.getState().problemsWidth).toBe(PROBLEMS_MAX_WIDTH);
    expect(
      createUiStore(fakeStorage({ [PROBLEMS_WIDTH_STORAGE_KEY]: '900' })).getState().problemsWidth,
    ).toBe(PROBLEMS_MAX_WIDTH);
  });

  it('keeps the default for a non-finite or garbage width', () => {
    const store = createUiStore(fakeStorage());
    store.getState().setProblemsWidth(Number.NaN);
    expect(store.getState().problemsWidth).toBe(PROBLEMS_DEFAULT_WIDTH);
    for (const raw of ['', '1e3', '-300', 'wide', '12345']) {
      expect(
        createUiStore(fakeStorage({ [PROBLEMS_WIDTH_STORAGE_KEY]: raw })).getState().problemsWidth,
      ).toBe(PROBLEMS_DEFAULT_WIDTH);
    }
  });

  it('caps at half the dock body, never above the max or under the min, floored', () => {
    expect(problemsMaxWidth(2000)).toBe(PROBLEMS_MAX_WIDTH);
    expect(problemsMaxWidth(701.8)).toBe(350);
    expect(problemsMaxWidth(300)).toBe(PROBLEMS_MIN_WIDTH);
  });
});

describe('uiStore dock tabs (#1475 OR27)', () => {
  it('starts on Settings and Parameters', () => {
    const state = createUiStore(fakeStorage()).getState();
    expect(state.dockNodeTab).toBe('settings');
    expect(state.dockPipelineTab).toBe('params');
  });

  it('persists each tab under its own key', () => {
    const storage = fakeStorage();
    const first = createUiStore(storage).getState();
    first.setDockNodeTab('general');
    first.setDockPipelineTab('variables');
    expect(storage.data.get(DOCK_NODE_TAB_STORAGE_KEY)).toBe('general');
    expect(storage.data.get(DOCK_PIPELINE_TAB_STORAGE_KEY)).toBe('variables');
    const second = createUiStore(storage).getState();
    expect(second.dockNodeTab).toBe('general');
    expect(second.dockPipelineTab).toBe('variables');
  });

  it('falls back to the default for a tab it does not know', () => {
    const state = createUiStore(
      fakeStorage({
        [DOCK_NODE_TAB_STORAGE_KEY]: 'params',
        [DOCK_PIPELINE_TAB_STORAGE_KEY]: 'Settings',
      }),
    ).getState();
    expect(state.dockNodeTab).toBe('settings');
    expect(state.dockPipelineTab).toBe('params');
  });
});

describe('uiStore runs grid columns (#1484 OR35 M1)', () => {
  it('starts with every column shown at its default width', () => {
    const state = createUiStore(fakeStorage()).getState();
    expect(state.runsGridHidden).toEqual([]);
    expect(state.runsGridWidths).toEqual({});
  });

  it('persists hidden columns in column order, deduplicated, across a new store', () => {
    const storage = fakeStorage();
    createUiStore(storage).getState().setRunsGridHidden(['cost', 'status', 'cost']);
    expect(storage.data.get(RUN_GRID_HIDDEN_STORAGE_KEY)).toBe('["status","cost"]');
    expect(createUiStore(storage).getState().runsGridHidden).toEqual(['status', 'cost']);
  });

  it('never hides a required column, on write or on read', () => {
    const store = createUiStore(fakeStorage());
    store.getState().setRunsGridHidden(['pipeline', 'runId', 'duration']);
    expect(store.getState().runsGridHidden).toEqual(['duration']);
    const read = createUiStore(
      fakeStorage({ [RUN_GRID_HIDDEN_STORAGE_KEY]: '["runId","pipeline","cost"]' }),
    ).getState();
    expect(read.runsGridHidden).toEqual(['cost']);
  });

  it('drops an unknown column id and reads garbage as nothing hidden', () => {
    expect(
      createUiStore(
        fakeStorage({ [RUN_GRID_HIDDEN_STORAGE_KEY]: '["retired","cost",7,null]' }),
      ).getState().runsGridHidden,
    ).toEqual(['cost']);
    for (const raw of ['', 'cost', '{"cost":true}', 'null', '"cost"']) {
      expect(
        createUiStore(fakeStorage({ [RUN_GRID_HIDDEN_STORAGE_KEY]: raw })).getState()
          .runsGridHidden,
      ).toEqual([]);
    }
  });

  it("persists a width per column, clamped to that column's own bounds", () => {
    const storage = fakeStorage();
    const store = createUiStore(storage);
    store.getState().setRunsGridWidth('status', 120.6);
    store.getState().setRunsGridWidth('runId', 5);
    store.getState().setRunsGridWidth('pipeline', 99999);
    expect(store.getState().runsGridWidths).toEqual({
      status: 121,
      runId: RUN_GRID_COLUMN_WIDTHS.runId.min,
      pipeline: RUN_GRID_COLUMN_MAX_WIDTH,
    });
    expect(createUiStore(storage).getState().runsGridWidths).toEqual(
      store.getState().runsGridWidths,
    );
  });

  it('forgets a width set to null, and a non-finite one', () => {
    const store = createUiStore(fakeStorage());
    store.getState().setRunsGridWidth('status', 120);
    store.getState().setRunsGridWidth('cost', 90);
    store.getState().setRunsGridWidth('status', null);
    store.getState().setRunsGridWidth('cost', Number.NaN);
    expect(store.getState().runsGridWidths).toEqual({});
  });

  it('reads each stored width on its own: a bad entry does not cost the good ones', () => {
    const state = createUiStore(
      fakeStorage({
        [RUN_GRID_WIDTHS_STORAGE_KEY]: JSON.stringify({
          status: 130,
          retired: 200,
          cost: 'wide',
          started: 1e9,
          duration: 1,
        }),
      }),
    ).getState();
    expect(state.runsGridWidths).toEqual({
      status: 130,
      started: RUN_GRID_COLUMN_MAX_WIDTH,
      duration: RUN_GRID_COLUMN_WIDTHS.duration.min,
    });
    for (const raw of ['', '[]', 'null', '120', '{']) {
      expect(
        createUiStore(fakeStorage({ [RUN_GRID_WIDTHS_STORAGE_KEY]: raw })).getState()
          .runsGridWidths,
      ).toEqual({});
    }
  });

  it('reset shows every column at its default width again, in storage too', () => {
    const storage = fakeStorage();
    const store = createUiStore(storage);
    store.getState().setRunsGridHidden(['cost']);
    store.getState().setRunsGridWidth('status', 140);
    store.getState().resetRunsGridColumns();
    expect(store.getState().runsGridHidden).toEqual([]);
    expect(store.getState().runsGridWidths).toEqual({});
    const reread = createUiStore(storage).getState();
    expect(reread.runsGridHidden).toEqual([]);
    expect(reread.runsGridWidths).toEqual({});
  });

  it('gives every column a default inside its own bounds', () => {
    for (const { min, default: width } of Object.values(RUN_GRID_COLUMN_WIDTHS)) {
      expect(width).toBeGreaterThanOrEqual(min);
      expect(width).toBeLessThanOrEqual(RUN_GRID_COLUMN_MAX_WIDTH);
    }
  });
});
