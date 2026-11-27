import { describe, expect, it } from 'vitest';
import { inferDatasetColumns } from './infer-columns.js';

/**
 * #1401 OR10 — the schema a preview infers from the rows it shows, which is
 * what Import schema fills a file dataset's columns from.
 */
describe('inferDatasetColumns', () => {
  it('picks the narrowest type every sampled value coerces to', () => {
    const rows = [
      { id: '1', price: '1.5', active: 'true', name: 'a' },
      { id: '2', price: '3', active: 'no', name: 'b' },
    ];
    expect(inferDatasetColumns(rows)).toEqual([
      { name: 'id', type: 'integer', nullable: false },
      { name: 'price', type: 'number', nullable: false },
      { name: 'active', type: 'boolean', nullable: false },
      { name: 'name', type: 'string', nullable: false },
    ]);
  });

  it('reads 0 and 1 as integers, not booleans', () => {
    expect(inferDatasetColumns([{ flag: '0' }, { flag: '1' }])).toEqual([
      { name: 'flag', type: 'integer', nullable: false },
    ]);
  });

  it('reads native values the database reader returns', () => {
    const rows = [
      { n: 3, x: 2.5, b: false },
      { n: 4, x: 1, b: true },
    ];
    expect(inferDatasetColumns(rows)).toEqual([
      { name: 'n', type: 'integer', nullable: false },
      { name: 'x', type: 'number', nullable: false },
      { name: 'b', type: 'boolean', nullable: false },
    ]);
  });

  it('marks a column nullable when a sampled value is null or the null sentinel', () => {
    const rows = [
      { a: '1', b: 'x' },
      { a: null, b: '\\N' },
    ];
    expect(inferDatasetColumns(rows, { nullValue: '\\N' })).toEqual([
      { name: 'a', type: 'integer', nullable: true },
      { name: 'b', type: 'string', nullable: true },
    ]);
  });

  it('never guesses a date without a declared format', () => {
    expect(inferDatasetColumns([{ d: '2026-01-02' }])).toEqual([
      { name: 'd', type: 'string', nullable: false },
    ]);
  });

  it('reads a date or timestamp through the declared format', () => {
    expect(inferDatasetColumns([{ d: '02/01/2026' }], { dateFormat: 'dd/MM/yyyy' })).toEqual([
      { name: 'd', type: 'date', nullable: false },
    ]);
    expect(
      inferDatasetColumns([{ t: '02/01/2026 13:45' }], { dateFormat: 'dd/MM/yyyy HH:mm' }),
    ).toEqual([{ name: 't', type: 'timestamp', nullable: false }]);
  });

  it('reads a store date as a timestamp and store bytes as binary', () => {
    const rows = [
      { at: new Date('2026-01-02T03:04:05Z'), blob: new Uint8Array([1, 2]) },
      { at: new Date('2026-01-03T00:00:00Z'), blob: new Uint8Array([3]) },
    ];
    expect(inferDatasetColumns(rows)).toEqual([
      { name: 'at', type: 'timestamp', nullable: false },
      { name: 'blob', type: 'binary', nullable: false },
    ]);
  });

  it('falls back to string for a column that mixes kinds no one type reads', () => {
    expect(inferDatasetColumns([{ a: 1 }, { a: new Date(0) }])).toEqual([
      { name: 'a', type: 'string', nullable: false },
    ]);
  });

  it('calls a column with no non-null value a nullable string', () => {
    expect(inferDatasetColumns([{ a: null }])).toEqual([
      { name: 'a', type: 'string', nullable: true },
    ]);
  });

  it('keeps first-seen column order across rows and treats a missing key as null', () => {
    expect(inferDatasetColumns([{ a: '1' }, { b: '2', a: '3' }])).toEqual([
      { name: 'a', type: 'integer', nullable: false },
      { name: 'b', type: 'integer', nullable: true },
    ]);
  });

  it('answers nothing for no rows', () => {
    expect(inferDatasetColumns([])).toEqual([]);
  });
});
