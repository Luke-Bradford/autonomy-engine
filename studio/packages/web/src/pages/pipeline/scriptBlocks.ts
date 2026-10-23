import {
  SCRIPT_PARAMETER_DIRECTIONS,
  type ScriptParameterDirection,
} from '@autonomy-studio/shared';
import type { ObjectListRow } from './configForm';
import { renameKey } from './inlineSource';

/**
 * #1600 OR41 C10c — the pure rules behind a Script block's parameter table
 * (`ScriptBlocksEditor`). A block stores two records keyed by `:name` without
 * the colon: `parameters` (the value bound, text that may be a `${}`) and
 * `parameterDirections` (`in`, `out` or `inOut`; a name not listed is In). The
 * table shows them as one row per name.
 *
 * The editor works on the dock's row-list DRAFT, where both records are a JSON
 * text cell each (the config form's `json` cell), so the Apply path, the JSON
 * view and the save gate are the generic list's, unchanged. A cell this module
 * cannot show as rows (text that is not JSON yet, a non-text value) makes the
 * block keep its JSON cells instead, so nothing stored is hidden or rewritten.
 *
 * Every record is built with `Object.fromEntries`, which defines own keys, so a
 * `:__proto__` is a name rather than the prototype (`renameKey`).
 */
export interface ScriptBlockParams {
  readonly parameters: Readonly<Record<string, string>>;
  readonly directions: Readonly<Record<string, ScriptParameterDirection>>;
}

/** The two cells of a block row this module reads and writes. */
const PARAMETERS_CELL = 'parameters';
const DIRECTIONS_CELL = 'parameterDirections';

function readRecord<T>(
  text: string | boolean | undefined,
  valid: (v: unknown) => v is T,
): Record<string, T> | null {
  if (text === undefined || text === '' || (typeof text === 'string' && text.trim() === '')) {
    return {};
  }
  if (typeof text !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const entries = Object.entries(parsed);
  return entries.every(([, v]) => valid(v)) ? Object.fromEntries(entries as [string, T][]) : null;
}

const isText = (v: unknown): v is string => typeof v === 'string';
const isDirection = (v: unknown): v is ScriptParameterDirection =>
  (SCRIPT_PARAMETER_DIRECTIONS as readonly unknown[]).includes(v);

/** A block row's parameters, or `null` when a cell cannot be shown as rows. */
export function readBlockParams(row: ObjectListRow): ScriptBlockParams | null {
  const parameters = readRecord(row[PARAMETERS_CELL], isText);
  const directions = readRecord(row[DIRECTIONS_CELL], isDirection);
  return parameters === null || directions === null ? null : { parameters, directions };
}

/** The row with both cells rewritten: the form's JSON text, or blank for none so the key is omitted. */
export function writeBlockParams(row: ObjectListRow, params: ScriptBlockParams): ObjectListRow {
  const cell = (record: Readonly<Record<string, unknown>>) =>
    Object.keys(record).length === 0 ? '' : JSON.stringify(record, null, 2);
  return {
    ...row,
    [PARAMETERS_CELL]: cell(params.parameters),
    [DIRECTIONS_CELL]: cell(params.directions),
  };
}

const has = (record: object, name: string) => Object.prototype.hasOwnProperty.call(record, name);

/** Every name, the parameters' first and then those with only a direction (an Out needs no value). */
export function blockParamNames(params: ScriptBlockParams): string[] {
  return [
    ...Object.keys(params.parameters),
    ...Object.keys(params.directions).filter((n) => !has(params.parameters, n)),
  ];
}

function without<T>(record: Readonly<Record<string, T>>, name: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== name));
}

function withEntry<T>(
  record: Readonly<Record<string, T>>,
  name: string,
  value: T,
): Record<string, T> {
  return has(record, name)
    ? Object.fromEntries(Object.entries(record).map(([k, v]) => [k, k === name ? value : v]))
    : Object.fromEntries([...Object.entries(record), [name, value]]);
}

export function renameBlockParam(
  params: ScriptBlockParams,
  from: string,
  to: string,
): ScriptBlockParams {
  return {
    parameters: renameKey(params.parameters, from, to) as Record<string, string>,
    directions: renameKey(params.directions, from, to) as Record<string, ScriptParameterDirection>,
  };
}

export function setBlockParamValue(
  params: ScriptBlockParams,
  name: string,
  value: string,
): ScriptBlockParams {
  return { ...params, parameters: withEntry(params.parameters, name, value) };
}

/**
 * In clears the name's entry: In is the default and needs none. A stored
 * explicit `in` on another name is left as it is, and a value an Out keeps is
 * never dropped (the run ignores it, ADF's rule, and the JSON still shows it).
 */
export function setBlockParamDirection(
  params: ScriptBlockParams,
  name: string,
  direction: ScriptParameterDirection,
): ScriptBlockParams {
  return {
    ...params,
    directions:
      direction === 'in'
        ? without(params.directions, name)
        : withEntry(params.directions, name, direction),
  };
}

export function removeBlockParam(params: ScriptBlockParams, name: string): ScriptBlockParams {
  return {
    parameters: without(params.parameters, name),
    directions: without(params.directions, name),
  };
}

/** A new row is a blank value, as an inline query's is; the author renames it to the SQL's `:name`. */
export function addBlockParam(params: ScriptBlockParams, name: string): ScriptBlockParams {
  return setBlockParamValue(params, name, '');
}

/** The SQL's `:name`s with no row yet. A name with only a direction is bound: an Out binds NULL. */
export function unboundBlockNames(params: ScriptBlockParams, used: readonly string[]): string[] {
  return used.filter((n) => !has(params.parameters, n) && !has(params.directions, n));
}

export function importBlockParams(
  params: ScriptBlockParams,
  names: readonly string[],
): ScriptBlockParams {
  return names.reduce((p, n) => (has(p.parameters, n) ? p : addBlockParam(p, n)), params);
}
