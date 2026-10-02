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
  /**
   * #1394 OR3 — whether the authoring canvas's MiniMap is folded away. One
   * preference for every pipeline: it is about the operator's screen, not the
   * graph.
   */
  minimapHidden: boolean;
  setMinimapHidden: (hidden: boolean) => void;
  /**
   * #1475 OR27 — the editor's property dock, one preference for every
   * pipeline (it is about the operator's screen, like the minimap).
   * `dockHeight` is px, or `null` for the default viewport-relative share that
   * applies until the operator first resizes it. The container-relative cap is
   * applied where the container is known (`dockMaxHeight` and the CSS), never
   * stored: a height taken on a tall monitor must not be cut down for good on a
   * laptop.
   */
  dockHeight: number | null;
  setDockHeight: (height: number | null) => void;
  dockOpen: boolean;
  setDockOpen: (open: boolean) => void;
  /**
   * #1475 OR27 — where the dock sits: under the canvas (ADF's layout, the
   * default) or beside it, which suits a wide screen. A per-viewer preference,
   * like the rest of the dock's. `dockWidth` is the right-hand dock's size, kept
   * apart from `dockHeight` so switching back restores each; `null` and the cap
   * follow `dockHeight`'s rules.
   */
  dockPosition: DockPosition;
  setDockPosition: (position: DockPosition) => void;
  dockWidth: number | null;
  setDockWidth: (width: number | null) => void;
  /** The Problems column inside the dock (#1393). */
  problemsOpen: boolean;
  setProblemsOpen: (open: boolean) => void;
  /**
   * #1475 OR27 — the Problems column's width in px, within
   * [`PROBLEMS_MIN_WIDTH`, `PROBLEMS_MAX_WIDTH`]. Like the dock's height, the
   * cap that depends on the dock's own width (`problemsMaxWidth`) is applied
   * where that width is known and never stored.
   */
  problemsWidth: number;
  setProblemsWidth: (width: number) => void;
  /**
   * #1475 OR27 — the dock tab last chosen, for an activity and for the
   * pipeline. One preference for every pipeline, so a reload or another
   * pipeline lands on the tab the operator was using, as selecting another
   * activity already did (#852).
   */
  dockNodeTab: NodeTab;
  setDockNodeTab: (tab: NodeTab) => void;
  dockPipelineTab: PipelineTab;
  setDockPipelineTab: (tab: PipelineTab) => void;
  /**
   * #1475 OR27 — the editor's Activities toolbox: its width in px, always
   * within [`TOOLBOX_MIN_WIDTH`, `TOOLBOX_MAX_WIDTH`], and whether it is folded
   * to its icon rail. The width is meaningful while folded — it is what
   * unfolding restores. One preference for every pipeline, like the dock's.
   */
  toolboxWidth: number;
  setToolboxWidth: (width: number) => void;
  toolboxCollapsed: boolean;
  setToolboxCollapsed: (collapsed: boolean) => void;
  /**
   * #1475 OR27 — whether the editor's version-history column is open. One
   * preference for every pipeline, like the dock's: it is about the operator's
   * screen, not the graph.
   */
  historyOpen: boolean;
  setHistoryOpen: (open: boolean) => void;
}

export type UiStore = StoreApi<UiState>;

/** #852 — an activity's dock tabs: its configuration, then ADF's "General" (run policy). */
export const NODE_TABS = ['settings', 'general'] as const;
export type NodeTab = (typeof NODE_TABS)[number];
/** #844 — the pipeline-level panel's tabs. */
export const PIPELINE_TABS = ['params', 'variables', 'outputs', 'general'] as const;
export type PipelineTab = (typeof PIPELINE_TABS)[number];

/** #1475 OR27 — the dock's places; the first is the default. */
export const DOCK_POSITIONS = ['bottom', 'right'] as const;
export type DockPosition = (typeof DOCK_POSITIONS)[number];

export const THEME_STORAGE_KEY = 'autonomy-studio.theme';
export const PANE_STORAGE_KEY = 'autonomy-studio.pane';
export const MINIMAP_STORAGE_KEY = 'autonomy-studio.minimap-hidden';
/* One key per dock preference, like the minimap's, rather than one record: a
   field added by a later slice must not make every stored record fail to parse
   and reset the others. */
export const DOCK_HEIGHT_STORAGE_KEY = 'autonomy-studio.dock-height';
export const DOCK_OPEN_STORAGE_KEY = 'autonomy-studio.dock-open';
export const DOCK_POSITION_STORAGE_KEY = 'autonomy-studio.dock-position';
export const DOCK_WIDTH_STORAGE_KEY = 'autonomy-studio.dock-width';
export const PROBLEMS_OPEN_STORAGE_KEY = 'autonomy-studio.problems-open';
export const TOOLBOX_WIDTH_STORAGE_KEY = 'autonomy-studio.toolbox-width';
export const TOOLBOX_COLLAPSED_STORAGE_KEY = 'autonomy-studio.toolbox-collapsed';
export const PROBLEMS_WIDTH_STORAGE_KEY = 'autonomy-studio.problems-width';
export const DOCK_NODE_TAB_STORAGE_KEY = 'autonomy-studio.dock-node-tab';
export const DOCK_PIPELINE_TAB_STORAGE_KEY = 'autonomy-studio.dock-pipeline-tab';
export const HISTORY_OPEN_STORAGE_KEY = 'autonomy-studio.history-open';

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
  return clampWidth(width, PANE_MIN_WIDTH, PANE_MAX_WIDTH, PANE_DEFAULT_WIDTH);
}

/** The rule above, for any width with fixed bounds: clamped, rounded, non-finite → `fallback`. */
function clampWidth(width: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(width)) return fallback;
  return Math.round(Math.min(max, Math.max(min, width)));
}

/**
 * #1475 OR27 — Activities toolbox bounds (the ticket's 140–360px). Unlike the
 * dock's ceiling these are FIXED, so the ceiling is stored as well as drawn,
 * the way the nav pane's is. `TOOLBOX_RAIL_WIDTH` is the folded icon rail's
 * track, the hub rail's 48px. `index.css` repeats `TOOLBOX_DEFAULT_WIDTH` as
 * the grid track's fallback, because CSS cannot import it.
 */
export const TOOLBOX_MIN_WIDTH = 140;
export const TOOLBOX_MAX_WIDTH = 360;
export const TOOLBOX_DEFAULT_WIDTH = 180;
export const TOOLBOX_RAIL_WIDTH = 48;
export const TOOLBOX_RESIZE_STEP = 16;

export function clampToolboxWidth(width: number): number {
  return clampWidth(width, TOOLBOX_MIN_WIDTH, TOOLBOX_MAX_WIDTH, TOOLBOX_DEFAULT_WIDTH);
}

/**
 * #1475 OR27 — Problems column bounds. The default is the fixed `20rem` column
 * it was before it could be resized (#1393). `index.css` repeats
 * `PROBLEMS_DEFAULT_WIDTH`, `PROBLEMS_MAX_WIDTH` and `PROBLEMS_MAX_SHARE` in the
 * column's width and `max-width` — CSS cannot import them — so change both
 * together.
 */
export const PROBLEMS_MIN_WIDTH = 200;
export const PROBLEMS_MAX_WIDTH = 480;
export const PROBLEMS_DEFAULT_WIDTH = 320;
export const PROBLEMS_MAX_SHARE = 0.5;
export const PROBLEMS_RESIZE_STEP = 16;

export function clampProblemsWidth(width: number): number {
  return clampWidth(width, PROBLEMS_MIN_WIDTH, PROBLEMS_MAX_WIDTH, PROBLEMS_DEFAULT_WIDTH);
}

/**
 * The widest Problems may be in a dock body `bodyWidth` px wide: at most
 * `PROBLEMS_MAX_SHARE` of it, so the properties beside it always keep the other
 * half, and never under `PROBLEMS_MIN_WIDTH`. Floored for `dockMaxHeight`'s
 * reason: a measured width is fractional, and this is committed and reported.
 */
export function problemsMaxWidth(bodyWidth: number): number {
  return Math.max(
    PROBLEMS_MIN_WIDTH,
    Math.floor(Math.min(PROBLEMS_MAX_WIDTH, bodyWidth * PROBLEMS_MAX_SHARE)),
  );
}

/**
 * #1475 — property-dock bounds. The minimum is the floor of the default share
 * (`.property-dock` in `index.css`), so a resized dock can never be smaller
 * than one nobody touched; folding it is how it gets out of the way.
 *
 * The maximum depends on the column the dock shares with the canvas: at most
 * `DOCK_MAX_SHARE` of it, and never so much that the canvas drops under
 * `CANVAS_MIN_HEIGHT`, which keeps `canvas-fills-viewport.spec.ts`'s 200px
 * floor (the flow sits inside a bordered wrapper). `DOCK_SPLITTER_SIZE` is
 * the divider's own track, in either position. `index.css` repeats these three as the dock's
 * `max-height` — CSS cannot import them — so change both together.
 */
export const DOCK_MIN_HEIGHT = 200;
export const DOCK_MAX_SHARE = 0.75;
export const CANVAS_MIN_HEIGHT = 220;
export const DOCK_SPLITTER_SIZE = 8;
export const DOCK_RESIZE_STEP = 16;

/**
 * The tallest the dock may be in a `.canvas-main` column `columnHeight` px
 * tall. Never below `DOCK_MIN_HEIGHT`: on a screen too short for both floors
 * the dock keeps its own, as the default share always has.
 *
 * FLOORED, not rounded: the column is measured with `getBoundingClientRect`,
 * which is fractional, and this value is both committed (End, maximise) and
 * reported (`aria-valuemax`). Rounding up could commit half a pixel more than
 * the CSS cap draws, and the divider would then report a size it is not.
 */
export function dockMaxHeight(columnHeight: number): number {
  return dockMaxSize(columnHeight, DOCK_MAX_SHARE, CANVAS_MIN_HEIGHT, DOCK_MIN_HEIGHT);
}

/**
 * #1475 OR27 — the right-hand dock's bounds, the same rules on the other axis.
 * The canvas floor is the 240px `.canvas-grid` already keeps for the canvas
 * beside version history, and the floor is a form's readable width. `index.css`
 * repeats these as the right-hand dock's `max-width` and the grid's `min-width`.
 */
export const DOCK_MIN_WIDTH = 320;
export const DOCK_MAX_WIDTH_SHARE = 0.6;
export const CANVAS_MIN_WIDTH = 240;

/** The widest a right-hand dock may be in a `.canvas-main` row `columnWidth` px wide. */
export function dockMaxWidth(columnWidth: number): number {
  return dockMaxSize(columnWidth, DOCK_MAX_WIDTH_SHARE, CANVAS_MIN_WIDTH, DOCK_MIN_WIDTH);
}

function dockMaxSize(column: number, share: number, canvasMin: number, dockMin: number): number {
  const byCanvasFloor = column - DOCK_SPLITTER_SIZE - canvasMin;
  return Math.max(dockMin, Math.floor(Math.min(column * share, byCanvasFloor)));
}

/**
 * A stored or committed dock height. Only the FLOOR is applied: the ceiling
 * belongs to the container (see `dockHeight`). Non-finite has no nearest value
 * and becomes "not resized", the default share.
 */
export function clampDockHeight(height: number): number | null {
  return clampDockSize(height, DOCK_MIN_HEIGHT);
}

/** `clampDockHeight`, for the right-hand dock's width. */
export function clampDockWidth(width: number): number | null {
  return clampDockSize(width, DOCK_MIN_WIDTH);
}

function clampDockSize(size: number, min: number): number | null {
  if (!Number.isFinite(size)) return null;
  return Math.round(Math.max(min, size));
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

function parseBoolean(raw: string): boolean | undefined {
  return raw === 'true' ? true : raw === 'false' ? false : undefined;
}

/**
 * Up to five digits only: `Number('')` is 0, `Number('1e9')` parses, and a
 * twenty-digit string is finite — none of which any divider stored. Five
 * digits is far beyond any screen, so the CSS cap is never the only bound.
 */
function parseDockSize(
  clamp: (size: number) => number | null,
): (raw: string) => number | undefined {
  return (raw) => (/^\d{1,5}$/.test(raw) ? (clamp(Number(raw)) ?? undefined) : undefined);
}

/** Up to three digits, then clamped: `parseDockSize`'s reasons, at a fixed-bound width's scale. */
function parseWidth(clamp: (width: number) => number): (raw: string) => number | undefined {
  return (raw) => (/^\d{1,3}$/.test(raw) ? clamp(Number(raw)) : undefined);
}

/**
 * One of a fixed set of strings, or absent. A tab a later release renamed or
 * removed must fall back to the default: an unknown key would select no tab
 * and hide every panel.
 */
function parseOneOf<T extends string>(choices: readonly T[]): (raw: string) => T | undefined {
  return (raw) => choices.find((choice) => choice === raw);
}

/** The preferences `createUiStore`'s `pref` stores as their own string. */
type StoredAsIs =
  | 'minimapHidden'
  | 'dockOpen'
  | 'dockPosition'
  | 'problemsOpen'
  | 'toolboxCollapsed'
  | 'dockNodeTab'
  | 'dockPipelineTab'
  | 'historyOpen';

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
    /* A preference stored as-is — an on/off flag, or one of a fixed set of
       strings: its stored value, and a setter that writes it through. One
       helper for every such preference, so none of them can be the one that
       forgets to persist. */
    const pref = <K extends StoredAsIs>(
      field: K,
      key: string,
      parse: (raw: string) => UiState[K] | undefined,
      fallback: UiState[K],
    ) =>
      [
        readStored(storage, key, parse, fallback),
        (value: UiState[K]) => {
          writeStored(storage, key, String(value));
          set({ [field]: value } as Pick<UiState, K>);
        },
      ] as const;
    const [minimapHidden, setMinimapHidden] = pref(
      'minimapHidden',
      MINIMAP_STORAGE_KEY,
      parseBoolean,
      false,
    );
    const [dockOpen, setDockOpen] = pref('dockOpen', DOCK_OPEN_STORAGE_KEY, parseBoolean, true);
    const [dockPosition, setDockPosition] = pref(
      'dockPosition',
      DOCK_POSITION_STORAGE_KEY,
      parseOneOf(DOCK_POSITIONS),
      'bottom',
    );
    const [problemsOpen, setProblemsOpen] = pref(
      'problemsOpen',
      PROBLEMS_OPEN_STORAGE_KEY,
      parseBoolean,
      true,
    );
    const [toolboxCollapsed, setToolboxCollapsed] = pref(
      'toolboxCollapsed',
      TOOLBOX_COLLAPSED_STORAGE_KEY,
      parseBoolean,
      false,
    );
    const [dockNodeTab, setDockNodeTab] = pref(
      'dockNodeTab',
      DOCK_NODE_TAB_STORAGE_KEY,
      parseOneOf(NODE_TABS),
      'settings',
    );
    const [dockPipelineTab, setDockPipelineTab] = pref(
      'dockPipelineTab',
      DOCK_PIPELINE_TAB_STORAGE_KEY,
      parseOneOf(PIPELINE_TABS),
      'params',
    );

    const [historyOpen, setHistoryOpen] = pref(
      'historyOpen',
      HISTORY_OPEN_STORAGE_KEY,
      parseBoolean,
      false,
    );

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

      minimapHidden,
      setMinimapHidden,

      dockHeight: readStored<number | null>(
        storage,
        DOCK_HEIGHT_STORAGE_KEY,
        parseDockSize(clampDockHeight),
        null,
      ),
      setDockHeight: (height) => {
        const dockHeight = height === null ? null : clampDockHeight(height);
        // An empty value reads back as "not resized" (`parseDockSize`).
        writeStored(
          storage,
          DOCK_HEIGHT_STORAGE_KEY,
          dockHeight === null ? '' : String(dockHeight),
        );
        set({ dockHeight });
      },
      dockOpen,
      setDockOpen,
      dockPosition,
      setDockPosition,
      dockWidth: readStored<number | null>(
        storage,
        DOCK_WIDTH_STORAGE_KEY,
        parseDockSize(clampDockWidth),
        null,
      ),
      setDockWidth: (width) => {
        const dockWidth = width === null ? null : clampDockWidth(width);
        writeStored(storage, DOCK_WIDTH_STORAGE_KEY, dockWidth === null ? '' : String(dockWidth));
        set({ dockWidth });
      },
      problemsOpen,
      setProblemsOpen,
      problemsWidth: readStored(
        storage,
        PROBLEMS_WIDTH_STORAGE_KEY,
        parseWidth(clampProblemsWidth),
        PROBLEMS_DEFAULT_WIDTH,
      ),
      setProblemsWidth: (width) => {
        const problemsWidth = clampProblemsWidth(width);
        writeStored(storage, PROBLEMS_WIDTH_STORAGE_KEY, String(problemsWidth));
        set({ problemsWidth });
      },
      dockNodeTab,
      setDockNodeTab,
      dockPipelineTab,
      setDockPipelineTab,

      toolboxWidth: readStored(
        storage,
        TOOLBOX_WIDTH_STORAGE_KEY,
        parseWidth(clampToolboxWidth),
        TOOLBOX_DEFAULT_WIDTH,
      ),
      setToolboxWidth: (width) => {
        const toolboxWidth = clampToolboxWidth(width);
        writeStored(storage, TOOLBOX_WIDTH_STORAGE_KEY, String(toolboxWidth));
        set({ toolboxWidth });
      },
      toolboxCollapsed,
      setToolboxCollapsed,
      historyOpen,
      setHistoryOpen,
    };
  });
}

export const uiStore = createUiStore();
