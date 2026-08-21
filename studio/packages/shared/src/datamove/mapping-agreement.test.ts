import { describe, expect, it } from 'vitest';
import type { DatasetColumn } from '../schemas/dataset.js';
import type { MappingRow } from './mapping-agreement.js';
import {
  classifySinkAgreement,
  classifySourceAgreement,
  projectMappingRows,
  splitUnwritten,
} from './mapping-agreement.js';

/**
 * Typed rather than an inline literal at each call: `classify*Agreement` takes a
 * `Pick<MappingRow, …>`, which excess-property-checks a FRESH literal — so an
 * inline `{ sink, source, onError }` is a type error at the source-side calls
 * even though a real caller's `MappingRow[]` is assignable. The helper is the
 * shape a caller actually holds.
 */
const row = (sink: string, source?: string, onError: 'fail' | 'null' = 'fail'): MappingRow => ({
  sink,
  source,
  onError,
});

const col = (name: string, nullable = true): DatasetColumn => ({
  name,
  type: 'string',
  nullable,
});

describe('projectMappingRows', () => {
  it('keeps only rows that claim a sink column, and reports how many it dropped', () => {
    // RAW literals, deliberately: this is the untyped blob the function takes
    // (a stored `Node.config.mapping`, or a half-typed panel draft), not
    // something that has already been through a schema.
    const projected = projectMappingRows([
      { sink: 'id', source: 'ID', onError: 'fail' },
      { sink: '', source: 'x' },
      { source: 'y' },
      { sink: 'name', source: '', onError: 'null' },
    ]);

    expect(projected.rows).toEqual([
      row('id', 'ID', 'fail'),
      { sink: 'name', source: undefined, onError: 'null' },
    ]);
    // The two sink-less rows are not silently discarded — the count is the
    // caller's only evidence they were there.
    expect(projected.unnamed).toBe(2);
  });

  it('folds an unrecognised onError to `fail` rather than inventing `null`', () => {
    // `null` is the LOSSY setting (a bad value becomes NULL instead of failing
    // the row), so an unreadable value must never resolve to it.
    expect(projectMappingRows([{ sink: 'id', onError: 'nonsense' }]).rows[0]?.onError).toBe('fail');
  });
});

describe('splitUnwritten', () => {
  it('separates a column that makes the copy unrunnable from one deliberately left alone', () => {
    const split = splitUnwritten([col('a', false), col('b', true)]);
    expect(split.required.map((c) => c.name)).toEqual(['a']);
    expect(split.optional.map((c) => c.name)).toEqual(['b']);
  });
});

describe('classifySourceAgreement', () => {
  it('agrees when every mapped source column is declared', () => {
    const verdict = classifySourceAgreement([row('id', 'id', 'fail')], ['id']);
    expect(verdict.agrees).toBe(true);
    expect(verdict.disagreements).toEqual([]);
  });

  it('disagrees when a mapped source column is not declared, naming it', () => {
    const verdict = classifySourceAgreement([row('id', 'gone', 'fail')], ['id']);
    expect(verdict.agrees).toBe(false);
    expect(verdict.disagreements).toEqual([{ kind: 'source_missing', columns: ['gone'] }]);
  });

  it('disagrees when a mapped source name matches more than one declared column', () => {
    const verdict = classifySourceAgreement([row('id', 'ID', 'fail')], ['Id', 'iD']);
    expect(verdict.agrees).toBe(false);
    expect(verdict.disagreements).toContainEqual({ kind: 'source_ambiguous', columns: ['ID'] });
  });

  it('treats an unread declared column as informational, never a disagreement', () => {
    // §7 row 4 — additive drift is allowed and warned, never refused.
    const verdict = classifySourceAgreement([row('id', 'id', 'fail')], ['id', 'added']);
    expect(verdict.agrees).toBe(true);
    expect(verdict.informational).toEqual([{ kind: 'source_unmapped', columns: ['added'] }]);
  });
});

describe('classifySinkAgreement', () => {
  it('agrees when every row writes a declared column and every NOT NULL column is written', () => {
    const verdict = classifySinkAgreement([row('id', 'id', 'fail')], [col('id', false)]);
    expect(verdict.agrees).toBe(true);
    expect(verdict.disagreements).toEqual([]);
  });

  it('disagrees when a row writes a column the dataset does not declare', () => {
    const verdict = classifySinkAgreement([row('ghost', 'id', 'fail')], [col('id')]);
    expect(verdict.agrees).toBe(false);
    expect(verdict.disagreements).toContainEqual({ kind: 'sink_undeclared', columns: ['ghost'] });
  });

  it('disagrees when a NOT NULL column is written by nothing', () => {
    const verdict = classifySinkAgreement(
      [row('id', 'id', 'fail')],
      [col('id'), col('required', false)],
    );
    expect(verdict.agrees).toBe(false);
    expect(verdict.disagreements).toContainEqual({
      kind: 'sink_required_unwritten',
      columns: ['required'],
    });
  });

  it('keeps a NULLABLE unwritten column informational — the copy still runs', () => {
    const verdict = classifySinkAgreement(
      [row('id', 'id', 'fail')],
      [col('id'), col('spare', true)],
    );
    expect(verdict.agrees).toBe(true);
    expect(verdict.informational).toContainEqual({
      kind: 'sink_optional_unwritten',
      columns: ['spare'],
    });
  });

  it('disagrees when two rows write one column under different spellings', () => {
    const verdict = classifySinkAgreement(
      [row('id', 'a', 'fail'), row('ID', 'b', 'fail')],
      [col('id')],
    );
    expect(verdict.agrees).toBe(false);
    expect(verdict.disagreements).toContainEqual({
      kind: 'sink_duplicate_write',
      columns: ['id', 'ID'],
    });
  });
});
