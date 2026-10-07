/**
 * #1569 OR37 — a data grid's column choice and widths, per viewer: the rules the
 * runs grid (#1484 OR35 M1) set down, for any grid. One spec per grid names its
 * columns; these functions are the only place the stored values are read,
 * written or clamped, so the runs and pipelines grids cannot drift apart.
 */
export interface GridColumnSpec<Id extends string> {
  /** Every column, in the order they are drawn. */
  columns: readonly Id[];
  /** Columns the picker cannot turn off. */
  required: readonly Id[];
  /** The hidden set a viewer starts from: no stored choice, or Reset columns. */
  defaultHidden: readonly Id[];
  /** Each column's floor and default width, in px. */
  widths: Record<Id, { min: number; default: number }>;
  maxWidth: number;
  /** One arrow-key step of a resize handle, in px. */
  step: number;
}

export type GridWidths<Id extends string> = Partial<Record<Id, number>>;

/** Every grid's resize ceiling and arrow-key step, in px. */
export const GRID_COLUMN_MAX_WIDTH = 640;
export const GRID_COLUMN_RESIZE_STEP = 16;

function isColumn<Id extends string>(spec: GridColumnSpec<Id>, value: unknown): value is Id {
  return spec.columns.some((column) => column === value);
}

/**
 * The hidden set as it is kept: known ids only (a column a later release
 * renamed or removed is dropped, not trusted), never a required one, each once,
 * in column order. Applied on write as well as on read, so a store can never
 * hold a set the picker could not have produced.
 */
export function canonicalGridHidden<Id extends string>(
  spec: GridColumnSpec<Id>,
  ids: readonly unknown[],
): Id[] {
  return spec.columns.filter((column) => ids.includes(column) && !spec.required.includes(column));
}

/** A column width within that column's bounds, rounded; non-finite → its default. */
export function clampGridWidth<Id extends string>(
  spec: GridColumnSpec<Id>,
  column: Id,
  width: number,
): number {
  const { min, default: fallback } = spec.widths[column];
  if (!Number.isFinite(width)) return fallback;
  return Math.round(Math.min(spec.maxWidth, Math.max(min, width)));
}

/** A column's drawn width: the viewer's, else its default. */
export function gridWidthOf<Id extends string>(
  spec: GridColumnSpec<Id>,
  widths: GridWidths<Id>,
  column: Id,
): number {
  return widths[column] ?? spec.widths[column].default;
}

/** `widths` with one column set; `null`, or a non-finite width, returns it to its default. */
export function withGridWidth<Id extends string>(
  spec: GridColumnSpec<Id>,
  widths: GridWidths<Id>,
  column: Id,
  width: number | null,
): GridWidths<Id> {
  const next = { ...widths };
  if (width === null || !Number.isFinite(width)) delete next[column];
  else next[column] = clampGridWidth(spec, column, width);
  return next;
}

/** `JSON.parse`, or `undefined` for text that is not JSON. */
export function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** A stored hidden set, or `undefined` (read as absent) for anything else. */
export function parseGridHidden<Id extends string>(
  spec: GridColumnSpec<Id>,
  raw: string,
): Id[] | undefined {
  const value = parseJson(raw);
  return Array.isArray(value) ? canonicalGridHidden(spec, value) : undefined;
}

/**
 * Stored widths. Each entry is judged on its own, so one column a later release
 * dropped, or one bad value, does not cost the viewer every other width they
 * set. A width is clamped to its column's CURRENT bounds on the way in.
 */
export function parseGridWidths<Id extends string>(
  spec: GridColumnSpec<Id>,
  raw: string,
): GridWidths<Id> | undefined {
  const value = parseJson(raw);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const widths: GridWidths<Id> = {};
  for (const [column, width] of Object.entries(value as Record<string, unknown>)) {
    if (isColumn(spec, column) && typeof width === 'number' && Number.isFinite(width)) {
      widths[column] = clampGridWidth(spec, column, width);
    }
  }
  return widths;
}

/**
 * The columns a grid draws, in column order: every column the viewer has not
 * turned off, AND any `pinned` one (the column the grid is sorted by) always.
 * A sort whose column is hidden would order the rows by something nobody can
 * see, and a shared link can carry any sort, so it is decided here, at the
 * draw. The viewer's hidden set is left as they chose it.
 */
export function visibleGridColumns<Id extends string>(
  spec: GridColumnSpec<Id>,
  hidden: readonly Id[],
  pinned: (column: Id) => boolean,
): Id[] {
  return spec.columns.filter((column) => !hidden.includes(column) || pinned(column));
}
