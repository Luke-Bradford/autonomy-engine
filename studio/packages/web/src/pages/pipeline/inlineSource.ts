import {
  interpolationMode,
  restoreEscapes,
  sqlBindNames,
  type ConnectionKind,
  type InlineDataset,
  type SqlDialect,
  type SqlParameterValue,
} from '@autonomy-studio/shared';

import type { RowTableColumn } from '../../lib/form/RowTable';
import { NUMERIC_TEXT } from './paramRules';

/**
 * #1600 OR41 C1q-b — the pure rules behind the inline source's bind values
 * (`InlineSourceEditor`): the `:name`s an inline query binds, stored in its
 * `config.parameters` record keyed WITHOUT the colon.
 */

/** Why a typed bind-value name cannot be stored, or `null` when it can. */
export function bindNameProblem(name: string, others: readonly string[]): string | null {
  if (name === '') return 'Name it as it is written after : in the statement.';
  // Keys are stored WITHOUT the colon, so `:wm` would silently never bind.
  if (name.startsWith(':')) return 'Leave out the leading :.';
  if (/\s/.test(name)) return 'A name has no spaces.';
  // #1600 C10c — no `:name` holds one, and a Script direction's name with one
  // is refused at save: a name is wiring, never evaluated.
  if (name.includes('${')) return 'A name is literal: no ${} in it.';
  if (others.includes(name)) return `:${name} is already bound.`;
  return null;
}

/**
 * #1600 OR41 C1q-c — a bind value's type, one per member of
 * `SqlParameterValueSchema` (string | number | null), so every stored value has
 * a choice that shows it and every choice stores something the schema holds.
 */
export type BindType = 'text' | 'number' | 'null';

/** The type a stored value shows as. A `${}` is stored as text either way. */
export function bindTypeOf(value: unknown): BindType {
  if (typeof value === 'number') return 'number';
  return value === null ? 'null' : 'text';
}

/** Why a Number row's text stores nothing yet. */
const NOT_A_NUMBER = 'Not saved: enter a number, or a ${} value.';

/**
 * The value a row stores for its type and its box's text, or why it stores
 * nothing yet (the row keeps its stored value until then). A `${}` is stored as
 * typed whatever the type: a run resolves it keeping the type it resolves to. A
 * number is a plain decimal, the literal a `number` pipeline parameter accepts
 * (`NUMERIC_TEXT`), so `0x10` and `1e3` are not numbers here, nor is `150.`
 * while it is being typed. A stored number's own text (`1e-7`) reads back as
 * itself. An integer past 2^53 is refused rather than stored rounded.
 */
export function bindValueFor(
  type: BindType,
  text: string,
): { value: SqlParameterValue } | { problem: string } {
  if (type === 'null') return { value: null };
  if (type === 'text' || isDynamicBindText(text)) return { value: text };
  const t = text.trim();
  const n = Number(t);
  if (t === '' || !Number.isFinite(n)) return { problem: NOT_A_NUMBER };
  if (NUMERIC_TEXT.test(t)) {
    if (/^-?\d+$/.test(t) && !Number.isSafeInteger(n)) {
      return { problem: 'Not saved: too large to store exactly. Choose Text to keep every digit.' };
    }
    return { value: n };
  }
  return String(n) === t ? { value: n } : { problem: NOT_A_NUMBER };
}

/** Whether a box's text is a `${}` the run evaluates (the row's type then follows it). */
export function isDynamicBindText(text: string): boolean {
  return interpolationMode(text).mode !== 'literal';
}

/** The dialect a source connection's SQL is scanned in, when it is a store a query lives in. */
export function sqlDialectOf(kind: ConnectionKind | undefined): SqlDialect | undefined {
  return kind === 'sqlite' || kind === 'postgres' ? kind : undefined;
}

/** The `:name`s an inline query's statement uses, as its store's lexer finds them. */
export function statementBindNames(inline: InlineDataset, dialect: SqlDialect): string[] {
  const sql = inline.config['sql'];
  return typeof sql === 'string' ? sqlBindNames(sql, dialect) : [];
}

/**
 * The record with a blank text row added for each of `names` it does not hold,
 * after the rows it has. `Object.fromEntries`, as `renameKey`, so a
 * `:__proto__` in the statement becomes an own key rather than the prototype.
 */
export function withImportedBindNames(
  record: Readonly<Record<string, unknown>>,
  names: readonly string[],
): Record<string, unknown> {
  const missing = names.filter((n) => !Object.prototype.hasOwnProperty.call(record, n));
  return Object.fromEntries([...Object.entries(record), ...missing.map((n) => [n, ''] as const)]);
}

/** A bind value as its box's text: a stored `null` is an empty box. */
export function bindValueText(value: unknown): string {
  if (typeof value === 'string') return value;
  return typeof value === 'number' ? String(value) : '';
}

/**
 * The record with key `from` renamed to `to`, in place in the key order so the
 * row does not jump to the end of the table. Built with `Object.fromEntries`,
 * which defines own keys: assigning `next['__proto__']` would set the
 * prototype instead and the row would vanish with its value.
 */
export function renameKey(
  record: Readonly<Record<string, unknown>>,
  from: string,
  to: string,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k === from ? to : k, v]));
}

/**
 * #1725 — the order the rows show a record's keys in. `Object.keys` lists
 * integer-like keys (`1`, `10`, which sqlite binds) first whatever the insertion
 * order, so a row renamed to one would jump while its box, kept by position,
 * showed another row's name. `prev` is the order shown; names still present
 * keep their slot. One gone and one new is a rename (or its undo): the new name
 * takes the gone one's slot. Otherwise a new name goes after the last row of
 * the names the record lists before it: an undone Remove returns to its slot,
 * and Add and Import, which append to the record, go last. Returns `prev`
 * itself when nothing moved.
 */
export function reconcileKeyOrder(
  prev: readonly string[],
  keys: readonly string[],
): readonly string[] {
  const present = new Set(keys);
  const known = new Set(prev);
  const gone = prev.filter((k) => !present.has(k));
  const added = keys.filter((k) => !known.has(k));
  if (gone.length === 0 && added.length === 0) return prev;
  if (gone.length === 1 && added.length === 1) {
    return prev.map((k) => (k === gone[0] ? added[0]! : k));
  }
  const shown = prev.filter((k) => present.has(k));
  for (const k of added) {
    const before = keys.slice(0, keys.indexOf(k)).map((b) => shown.indexOf(b));
    shown.splice(Math.max(-1, ...before) + 1, 0, k);
  }
  return shown;
}

/** `p1`, `p2`, … — the first not already taken; the author renames it to the statement's `:name`. */
export function freshBindName(taken: readonly string[]): string {
  for (let i = 1; ; i += 1) if (!taken.includes(`p${i}`)) return `p${i}`;
}

/**
 * #1600 C1q-c — Preview. A bind value is DYNAMIC when the run would evaluate it,
 * decided by the run's own classifier (`interpolationMode`, which `substitute`
 * uses), so a `$${` escape is literal here exactly as it is there.
 */
function isDynamic(value: unknown): value is string {
  return typeof value === 'string' && isDynamicBindText(value);
}

/**
 * The bind names whose value is a `${}`: Preview asks for a value in its place.
 * With the store's dialect known, only the names the statement uses: a value
 * the statement never names is never bound, so it needs no preview value.
 */
export function dynamicBindNames(inline: InlineDataset, dialect?: SqlDialect): string[] {
  const parameters = parametersOf(inline);
  const used = dialect === undefined ? undefined : statementBindNames(inline, dialect);
  return Object.keys(parameters).filter(
    (name) => isDynamic(parameters[name]) && (used === undefined || used.includes(name)),
  );
}

/**
 * A typed preview value as the run would bind it. A `${}` resolves keeping its
 * type, so `5` binds as a number (text would compare unequal to an integer
 * column); anything that does not read back as the same finite number stays
 * text, so `007`, ` 5` and `NaN` are still text.
 */
export function previewBindValue(text: string): string | number {
  const n = Number(text);
  return text !== '' && Number.isFinite(n) && String(n) === text ? n : text;
}

/**
 * The inline source as Preview sends it: every bind value literal. A `${}` takes
 * the operator's preview value (blank binds as empty text), and a literal value
 * resolves its `$${` escapes as the run's substitution does.
 */
export function previewInline(
  inline: InlineDataset,
  values: Readonly<Record<string, string>>,
): InlineDataset {
  if (inline.config['parameters'] === undefined) return inline;
  const parameters = parametersOf(inline);
  const resolved = Object.fromEntries(
    Object.entries(parameters).map(([name, value]) => [
      name,
      isDynamic(value)
        ? previewBindValue(values[name] ?? '')
        : typeof value === 'string'
          ? restoreEscapes(interpolationMode(value).scanned)
          : value,
    ]),
  );
  return { kind: inline.kind, config: { ...inline.config, parameters: resolved } };
}

function parametersOf(inline: InlineDataset): Record<string, unknown> {
  const raw = inline.config['parameters'];
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/** A bind-value table's columns: Name, then Type when the values are typed (C1q-c), Value, and any extra. */
export function bindColumns(
  typed: boolean,
  extra: readonly RowTableColumn[] = [],
): RowTableColumn[] {
  return [
    { key: 'name', header: 'Name', width: 'short' },
    ...(typed ? [{ key: 'type', header: 'Type', width: 'short' } as const] : []),
    { key: 'value', header: 'Value', width: 'long' },
    ...extra,
  ];
}
