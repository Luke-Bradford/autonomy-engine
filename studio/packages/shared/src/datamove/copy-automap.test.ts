import { describe, expect, it } from 'vitest';

import type { DatasetColumn } from '../schemas/dataset.js';

import { autoMapMapping, checkSinkCoverage } from './copy-automap.js';

function col(name: string, type: DatasetColumn['type'] = 'string', nullable = true): DatasetColumn {
  return { name, type, nullable };
}

describe('autoMapMapping (#1170, spec §6.3)', () => {
  it('matches a sink column to the source column of the same name', () => {
    const result = autoMapMapping([col('id', 'integer'), col('label')], [col('id', 'integer')], []);

    expect(result.rows).toEqual([{ source: 'id', sink: 'id', type: 'integer', onError: 'fail' }]);
    expect(result.unmatched).toEqual([]);
  });

  it('takes the TARGET type from the SINK column, never from the source', () => {
    // §6.1 — `type` is "the TARGET type — declared, never inferred". A source
    // declaring `string` and a sink declaring `integer` is the whole reason the
    // coercion matrix (§6.2) exists; auto-map must not quietly copy the source's.
    const result = autoMapMapping([col('n', 'string')], [col('n', 'integer')], []);

    expect(result.rows[0]?.type).toBe('integer');
  });

  it('matches case-insensitively and emits the SOURCE’s own spelling', () => {
    // The row is read against the source by name, so it must carry the name the
    // source actually uses -- `resolveSourceColumn` returns that spelling for
    // exactly this reason.
    const result = autoMapMapping([col('UserId', 'integer')], [col('userid', 'integer')], []);

    expect(result.rows).toEqual([
      { source: 'UserId', sink: 'userid', type: 'integer', onError: 'fail' },
    ]);
  });

  it('never guesses when a sink name matches more than one source column loosely', () => {
    const result = autoMapMapping([col('name'), col('NAME')], [col('Name')], []);

    expect(result.rows).toEqual([]);
    expect(result.ambiguous).toEqual(['Name']);
  });

  it('always writes onError: fail, never null', () => {
    // §6.2 refuses `onError: 'null'` where the sink column is `nullable: false`,
    // so the only value auto-map can write unattended is `fail`.
    const result = autoMapMapping([col('a')], [col('a', 'string', false)], []);

    expect(result.rows[0]?.onError).toBe('fail');
  });

  it('leaves a sink column alone when the source has no column of that name', () => {
    const result = autoMapMapping([col('a')], [col('a'), col('b')], []);

    expect(result.rows.map((r) => r.sink)).toEqual(['a']);
    expect(result.unmatched).toEqual(['b']);
  });

  it('is ADDITIVE: a sink column an existing row already claims is not mapped again', () => {
    const result = autoMapMapping([col('a'), col('b')], [col('a'), col('b')], ['a']);

    expect(result.rows.map((r) => r.sink)).toEqual(['b']);
    expect(result.alreadyMapped).toEqual(['a']);
  });

  it('folds CASE when deciding a sink column is already claimed', () => {
    // The load-bearing one. `refineMapping` dedupes sinks by EXACT string, but
    // the store resolves them folded and refuses the collision
    // (`sqlite.ts` -- "each sink column may be written by one mapping row").
    // An exact-only check here would add a second row for `ID` beside the
    // author's `id`, pass every save-time check, and fail `permanent` at
    // dispatch -- long after the author left the panel.
    const result = autoMapMapping([col('ID')], [col('ID')], ['id']);

    expect(result.rows).toEqual([]);
    expect(result.alreadyMapped).toEqual(['ID']);
  });

  it('emits ONE row when two declared sink columns fold together', () => {
    // `DatasetSchema.columns` has no uniqueness refine, so a hand-authored
    // declared list really can carry both spellings. Emitting both would author
    // the same collision the store refuses.
    const result = autoMapMapping([col('id'), col('ID')], [col('id'), col('ID')], []);

    expect(result.rows).toHaveLength(1);
    // Reported APART from a column the author's own row claims: this one is a
    // fault in the declared list, not something they did.
    expect(result.duplicateDeclared).toEqual(['ID']);
    expect(result.alreadyMapped).toEqual([]);
  });

  it('names a declared duplicate ONCE even where neither twin matches a source', () => {
    // Follow-up finding on PR #1179. Deciding "is this a declared duplicate"
    // from `claimed` alone only ever caught the matched case, because nothing
    // but a bound row adds a fold to `claimed`. Two unmatched twins were then
    // each reported under their own name — "id, ID have no source column" — when
    // the single thing to fix is that the list declares the column twice.
    const result = autoMapMapping([col('other')], [col('id'), col('ID')], []);

    expect(result.rows).toEqual([]);
    expect(result.unmatched).toEqual(['id']);
    expect(result.duplicateDeclared).toEqual(['ID']);
  });

  it('splits the two reasons apart when BOTH apply to the same fold', () => {
    // The reviewer's case on PR #1179: an author maps `id` once, and the
    // declared list carries `ID` *and* `Id`. Only the FIRST of those is
    // something the author's own row claims; the second is the declared list
    // duplicating itself. Bucketing both as `alreadyMapped` would tell the
    // author they mapped a column they have never typed.
    const result = autoMapMapping([col('id')], [col('ID'), col('Id')], ['id']);

    expect(result.rows).toEqual([]);
    expect(result.alreadyMapped).toEqual(['ID']);
    expect(result.duplicateDeclared).toEqual(['Id']);
  });

  it('does NOT trim — a declared name with padding is a different column', () => {
    // §6.3's parenthetical says "case-insensitive, trimmed", and the trimmed half
    // is deliberately not implemented: neither the source resolver nor the
    // store's sink resolver trims, so a trimmed match would emit a row whose
    // `sink` is `' id '` and which `resolveSinkColumns` cannot then bind to the
    // actual column `id` -- an unrunnable row, authored by the button.
    const result = autoMapMapping([col('id', 'integer')], [col(' id ', 'integer')], []);

    expect(result.rows).toEqual([]);
    expect(result.unmatched).toEqual([' id ']);
  });

  it('maps nothing when either side declares no columns', () => {
    expect(autoMapMapping([], [col('a')], []).rows).toEqual([]);
    expect(autoMapMapping([col('a')], [], []).rows).toEqual([]);
  });
});

describe('checkSinkCoverage (#1170, spec §13)', () => {
  it('names the declared sink columns no row writes', () => {
    const coverage = checkSinkCoverage([{ sink: 'a' }], [col('a'), col('b')]);

    expect(coverage.notWritten.map((c) => c.name)).toEqual(['b']);
    expect(coverage.undeclared).toEqual([]);
  });

  it('counts a row as writing its column case-insensitively', () => {
    const coverage = checkSinkCoverage([{ sink: 'ID' }], [col('id')]);

    expect(coverage.notWritten).toEqual([]);
  });

  it('names a row whose sink the dataset does not declare', () => {
    // The state the ADDITIVE rule creates: auto-map against one sink dataset,
    // re-bind to another, and the old rows stay -- naming columns the bound sink
    // no longer declares, with nothing on screen to say so.
    const coverage = checkSinkCoverage([{ sink: 'gone' }], [col('a')]);

    expect(coverage.undeclared).toEqual(['gone']);
  });

  it('counts an expression-only row as writing its sink column', () => {
    // An `expression` row produces the value without reading a source column, so
    // it claims its sink exactly as a source-bound row does.
    const coverage = checkSinkCoverage([{ sink: 'a' }], [col('a')]);

    expect(coverage.notWritten).toEqual([]);
  });

  it('names two rows that write the SAME column in different case', () => {
    // The hazard auto-map's own dedupe cannot reach, because an author can type
    // it. `refineMapping` dedupes sinks EXACTLY and lets this through; the store
    // refuses it at dispatch, on an immutable version.
    const coverage = checkSinkCoverage([{ sink: 'id' }, { sink: 'ID' }], [col('id', 'integer')]);

    expect(coverage.duplicateWrites).toEqual([{ first: 'id', second: 'ID' }]);
  });

  it('leaves an EXACT duplicate to refineMapping, which says it better', () => {
    const coverage = checkSinkCoverage([{ sink: 'id' }, { sink: 'id' }], [col('id', 'integer')]);

    expect(coverage.duplicateWrites).toEqual([]);
  });

  it('reports a NOT NULL column that nothing writes, so it can be flagged apart', () => {
    const coverage = checkSinkCoverage([], [col('a', 'string', false), col('b')]);

    expect(coverage.notWritten.filter((c) => !c.nullable).map((c) => c.name)).toEqual(['a']);
  });
});
