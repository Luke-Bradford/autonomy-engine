import type { DataType, DatasetColumn } from '../schemas/dataset.js';
import { coerceValue, type CoercionOptions } from './coerce.js';

/**
 * #1401 OR10 — the schema a preview INFERS from the rows it shows: what Import
 * schema fills a file dataset's columns from, and the column list a Preview
 * shows above its rows.
 *
 * The rule is the copy's own coercion matrix, so an inferred type is one the
 * copy will actually read every sampled value as: a column is the first type on
 * the ladder that every sampled non-null value coerces to through
 * `coerceValue`. A store's own date is a timestamp and its bytes binary.
 * Integer comes before boolean, so a column of `0`s and `1`s is
 * a number column, not a flag. A date or timestamp is tried only when the
 * dataset declares `dateFormat` (one with a time token is a timestamp), because
 * the matrix never guesses a date and an inference that did would promise the
 * operator a read the copy then refuses.
 *
 * `nullable` says only what the SAMPLE showed: a null, a missing key or the
 * dataset's `nullValue`. A sample with none cannot prove the store forbids one;
 * the operator reviews what Import schema fills before saving it.
 */
export function inferDatasetColumns(
  rows: readonly Record<string, unknown>[],
  coercion: CoercionOptions = {},
): DatasetColumn[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const name of Object.keys(row)) {
      if (!seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
  }
  const ladder = typeLadder(coercion);
  return names.map((name) => {
    const values: unknown[] = [];
    let nullable = false;
    for (const row of rows) {
      const value = row[name];
      if (value === undefined || value === null || isNullSentinel(value, coercion)) {
        nullable = true;
      } else {
        values.push(value);
      }
    }
    if (values.length === 0) return { name, type: 'string', nullable: true };
    return { name, type: typeOf(values, ladder, coercion), nullable };
  });
}

/**
 * A store's own `Date` is a timestamp and its bytes are binary, whatever the
 * ladder says: `date` would accept a `Date` by dropping its time, which is a
 * loss the inference must not choose. Otherwise the ladder's first type every
 * value reads as, or `string` when none does (a column mixing kinds).
 */
function typeOf(
  values: readonly unknown[],
  ladder: readonly DataType[],
  coercion: CoercionOptions,
): DataType {
  if (values.every((v) => v instanceof Date)) return 'timestamp';
  if (values.every((v) => v instanceof Uint8Array)) return 'binary';
  return (
    ladder.find((target) => values.every((v) => coerceValue(v, target, coercion).ok)) ?? 'string'
  );
}

/** A time token in a declared format makes its column a timestamp, not a date. */
const TIME_TOKEN = /HH|mm|ss|fff/;

function typeLadder(coercion: CoercionOptions): readonly DataType[] {
  const ladder: DataType[] = ['integer', 'number', 'boolean'];
  if (coercion.dateFormat !== undefined) {
    ladder.push(TIME_TOKEN.test(coercion.dateFormat) ? 'timestamp' : 'date');
  }
  ladder.push('string');
  return ladder;
}

function isNullSentinel(value: unknown, coercion: CoercionOptions): boolean {
  return (
    typeof value === 'string' && coercion.nullValue !== undefined && value === coercion.nullValue
  );
}
