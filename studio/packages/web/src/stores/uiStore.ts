import { createStore, type StoreApi } from 'zustand/vanilla';
import { RUN_PAGE_SIZES, type RunPageSize } from '@autonomy-studio/shared';
import {
  DEFAULT_DISPLAY_TIME_ZONE,
  parseDisplayTimeZone,
  type DisplayTimeZone,
} from '../lib/displayTime';
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
  /**
   * #1484 OR35 principle 4 — the zone every timestamp is shown in: `local` (the
   * default) or an IANA zone. Per viewer, because the instant is the same for
   * everyone and the wall clock is the reader's. A stored zone this browser
   * cannot format in reads as the default (`parseDisplayTimeZone`).
   */
  displayTimeZone: DisplayTimeZone;
  setDisplayTimeZone: (zone: DisplayTimeZone) => void;
  /**
   * #1484 OR35 M1 — the runs grid's column choice and widths, per viewer.
   * `runsGridHidden` names the columns the operator turned OFF, in column
   * order; storing the hidden set rather than the shown one means a column a
   * later release adds appears by default. With no stored choice it is
   * `RUN_GRID_DEFAULT_HIDDEN`. A required column is never in it. A link's
   * `hide` param overrides it for that visit without changing it (`RunsPage`);
   * a choice made in the picker writes both. `resetRunsGridColumns` resets the
   * widths as well.
   * `runsGridWidths` holds only the columns the operator resized, in px; an
   * absent column draws at its default.
   */
  runsGridHidden: readonly RunGridColumnId[];
  setRunsGridHidden: (hidden: readonly RunGridColumnId[]) => void;
  runsGridWidths: Partial<Record<RunGridColumnId, number>>;
  /** `null`, or a non-finite width, returns the column to its default. */
  setRunsGridWidth: (column: RunGridColumnId, width: number | null) => void;
  resetRunsGridColumns: () => void;
  /**
   * #1484 OR35 M1 — whether the runs list keeps itself current (`RunsPage`'s
   * Live toggle), and how many runs it reads per page. Per viewer, not in the
   * URL: both are about how this reader watches, not which runs a link names.
   */
  runsLive: boolean;
  setRunsLive: (live: boolean) => void;
  runsPageSize: RunPageSize;
  setRunsPageSize: (size: RunPageSize) => void;
  /**
   * #1484 OR35 M1 principle 5 — the runs list's last-used query, as the page's
   * `rememberedRunsQuery` spells it ('' for none). `RunsPage` restores it into a
   * bare visit to the list. Per viewer, and opaque here: the page owns which
   * params it holds and re-reads every value through the URL's own parsers.
   */
  runsLastQuery: string;
  setRunsLastQuery: (query: string) => void;
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

/**
 * #1484 OR35 M1 — the runs grid's columns, in the order they are drawn. The
 * store keeps their ids and width bounds, which it needs to clamp a stored
 * width on read; the labels and cells are the page's
 * (`pages/runs/runGridColumns.tsx`), keyed by these ids so a column added here
 * without a definition there fails the typecheck.
 */
export const RUN_GRID_COLUMNS = [
  'pipeline',
  'status',
  'triggeredBy',
  'started',
  'duration',
  'activities',
  'rowsWritten',
  'cost',
  'runId',
  'parent',
  'annotations',
] as const;
export type RunGridColumnId = (typeof RUN_GRID_COLUMNS)[number];

/**
 * Columns the picker cannot turn off. Pipeline is what an operator recognises a
 * run by (principle 3: every id has a name next to it). Run ID holds the row's
 * link to the RUN — the one a keyboard reaches and a middle-click opens (the
 * Pipeline and Parent links go elsewhere) — so a grid without it could be
 * entered with a mouse only.
 */
export const RUN_GRID_REQUIRED_COLUMNS: readonly RunGridColumnId[] = ['pipeline', 'runId'];

/**
 * The hidden set a viewer starts from: no stored choice, unreadable storage,
 * or Reset columns. Annotations starts off because every other column already
 * fills the grid's 1083px at 1440×900 (the widths below), and most runs carry
 * no tag; the runs list's annotation filter reaches them without it. A viewer
 * who already stored a choice keeps it, so for them the column appears, as any
 * column a later release adds does, and the grid scrolls sideways within
 * itself until they hide a column or narrow one.
 */
export const RUN_GRID_DEFAULT_HIDDEN: readonly RunGridColumnId[] = ['annotations'];

/**
 * Each column's floor and default width, in px. The default columns fill the
 * 1083px the grid has at 1440×900 beside the hub nav, leaving a few px to the
 * filler; the Activities default still draws `7 ✓ · 1 skipped` whole.
 * The floors keep each column's content legible: a status pill, a short run id
 * with its Copy button.
 */
export const RUN_GRID_COLUMN_WIDTHS: Record<RunGridColumnId, { min: number; default: number }> = {
  pipeline: { min: 120, default: 185 },
  status: { min: 72, default: 88 },
  triggeredBy: { min: 96, default: 136 },
  started: { min: 110, default: 124 },
  duration: { min: 56, default: 68 },
  activities: { min: 80, default: 128 },
  rowsWritten: { min: 56, default: 68 },
  cost: { min: 56, default: 68 },
  runId: { min: 110, default: 112 },
  parent: { min: 72, default: 100 },
  annotations: { min: 72, default: 120 },
};
export const RUN_GRID_COLUMN_MAX_WIDTH = 640;
export const RUN_GRID_RESIZE_STEP = 16;

/** A column width within that column's bounds; non-finite → its default (`clampWidth`'s rule). */
export function clampRunGridWidth(column: RunGridColumnId, width: number): number {
  const { min, default: fallback } = RUN_GRID_COLUMN_WIDTHS[column];
  return clampWidth(width, min, RUN_GRID_COLUMN_MAX_WIDTH, fallback);
}

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
export const DISPLAY_TIME_ZONE_STORAGE_KEY = 'autonomy-studio.display-time-zone';
/* Two keys, not one record, for the dock keys' reason above. */
export const RUN_GRID_HIDDEN_STORAGE_KEY = 'autonomy-studio.runs-grid-hidden';
export const RUN_GRID_WIDTHS_STORAGE_KEY = 'autonomy-studio.runs-grid-widths';
export const RUNS_LIVE_STORAGE_KEY = 'autonomy-studio.runs-live';
export const RUNS_PAGE_SIZE_STORAGE_KEY = 'autonomy-studio.runs-page-size';
export const RUNS_LAST_QUERY_STORAGE_KEY = 'autonomy-studio.runs-last-query';
/** Far above any query the list writes (ids, a kind list, a sort); a stored
 * value past it is not one the page wrote, so it reads as none. */
export const RUNS_LAST_QUERY_MAX_CHARS = 2048;

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

/** Up to three digits, then clamped: `parseDockSize`'s reasons, for a width under 1000px. */
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

/** One of the runs grid's page sizes; anything else — a size a later release
 *  dropped included — reads as absent, so the default applies. */
function parseRunPageSize(raw: string): RunPageSize | undefined {
  return RUN_PAGE_SIZES.find((size) => String(size) === raw);
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
  | 'historyOpen'
  | 'displayTimeZone'
  | 'runsLive'
  | 'runsPageSize'
  | 'runsLastQuery';

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
  const value = parseJson(raw);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { width, collapsed } = value as Record<string, unknown>;
  if (typeof width !== 'number' || !Number.isFinite(width)) return undefined;
  if (typeof collapsed !== 'boolean') return undefined;
  return { width: clampPaneWidth(width), collapsed };
}

function isRunGridColumn(value: unknown): value is RunGridColumnId {
  return RUN_GRID_COLUMNS.some((column) => column === value);
}

/**
 * The hidden set as it is kept: known ids only (a column a later release
 * renamed or removed is dropped, not trusted), never a required one, each once,
 * in column order. Applied on write as well as on read, so the store can never
 * hold a set the picker could not have produced.
 */
export function canonicalHidden(ids: readonly unknown[]): RunGridColumnId[] {
  return RUN_GRID_COLUMNS.filter(
    (column) => ids.includes(column) && !RUN_GRID_REQUIRED_COLUMNS.includes(column),
  );
}

/** `JSON.parse`, or `undefined` for text that is not JSON. */
function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function parseRunGridHidden(raw: string): RunGridColumnId[] | undefined {
  const value = parseJson(raw);
  return Array.isArray(value) ? canonicalHidden(value) : undefined;
}

/**
 * Each entry is judged on its own, so one column a later release dropped, or
 * one bad value, does not cost the operator every other width they set. A
 * width is clamped to its column's CURRENT bounds on the way in, for
 * `parsePane`'s reason.
 */
function parseRunGridWidths(raw: string): Partial<Record<RunGridColumnId, number>> | undefined {
  const value = parseJson(raw);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const widths: Partial<Record<RunGridColumnId, number>> = {};
  for (const [column, width] of Object.entries(value as Record<string, unknown>)) {
    if (isRunGridColumn(column) && typeof width === 'number' && Number.isFinite(width)) {
      widths[column] = clampRunGridWidth(column, width);
    }
  }
  return widths;
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

    const [displayTimeZone, setDisplayTimeZone] = pref(
      'displayTimeZone',
      DISPLAY_TIME_ZONE_STORAGE_KEY,
      parseDisplayTimeZone,
      DEFAULT_DISPLAY_TIME_ZONE,
    );

    const [historyOpen, setHistoryOpen] = pref(
      'historyOpen',
      HISTORY_OPEN_STORAGE_KEY,
      parseBoolean,
      false,
    );

    const [runsLive, setRunsLive] = pref('runsLive', RUNS_LIVE_STORAGE_KEY, parseBoolean, false);
    const [runsPageSize, setRunsPageSize] = pref(
      'runsPageSize',
      RUNS_PAGE_SIZE_STORAGE_KEY,
      parseRunPageSize,
      RUN_PAGE_SIZES[0],
    );
    const [runsLastQuery, setRunsLastQuery] = pref(
      'runsLastQuery',
      RUNS_LAST_QUERY_STORAGE_KEY,
      (raw) => (raw.length <= RUNS_LAST_QUERY_MAX_CHARS ? raw : undefined),
      '',
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
      displayTimeZone,
      runsLive,
      setRunsLive,
      runsPageSize,
      setRunsPageSize,
      runsLastQuery,
      setRunsLastQuery,
      /* Validated on the way IN as well as out: a zone the runtime cannot
         format in would make every timestamp on every page throw. */
      setDisplayTimeZone: (zone) => {
        if (parseDisplayTimeZone(zone) !== undefined) setDisplayTimeZone(zone);
      },

      runsGridHidden: readStored(
        storage,
        RUN_GRID_HIDDEN_STORAGE_KEY,
        parseRunGridHidden,
        RUN_GRID_DEFAULT_HIDDEN,
      ),
      setRunsGridHidden: (hidden) => {
        const runsGridHidden = canonicalHidden(hidden);
        writeStored(storage, RUN_GRID_HIDDEN_STORAGE_KEY, JSON.stringify(runsGridHidden));
        set({ runsGridHidden });
      },
      runsGridWidths: readStored(storage, RUN_GRID_WIDTHS_STORAGE_KEY, parseRunGridWidths, {}),
      setRunsGridWidth: (column, width) => {
        const runsGridWidths = { ...get().runsGridWidths };
        if (width === null || !Number.isFinite(width)) delete runsGridWidths[column];
        else runsGridWidths[column] = clampRunGridWidth(column, width);
        writeStored(storage, RUN_GRID_WIDTHS_STORAGE_KEY, JSON.stringify(runsGridWidths));
        set({ runsGridWidths });
      },
      resetRunsGridColumns: () => {
        writeStored(storage, RUN_GRID_HIDDEN_STORAGE_KEY, JSON.stringify(RUN_GRID_DEFAULT_HIDDEN));
        writeStored(storage, RUN_GRID_WIDTHS_STORAGE_KEY, '{}');
        set({ runsGridHidden: RUN_GRID_DEFAULT_HIDDEN, runsGridWidths: {} });
      },
    };
  });
}

export const uiStore = createUiStore();
