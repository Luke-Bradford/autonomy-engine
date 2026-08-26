import { describe, expect, it } from 'vitest';
import { NAME_LIST_LIMIT, formatNameList } from './dependencyCheck';

/**
 * #1211 — these tests moved here with `formatNameList` itself. Left in
 * `strandedDatasets.test.ts` they would have exercised this module through the
 * dataset module's import, so a later change that stopped `strandedDatasets`
 * re-exporting it would still have looked covered.
 */
describe('formatNameList', () => {
  it('spells out a short list', () => {
    expect(formatNameList(['a', 'b'])).toBe('a, b');
  });

  it('counts the tail past the limit rather than running on', () => {
    const many = Array.from({ length: NAME_LIST_LIMIT + 3 }, (_, i) => `d${i}`);
    const out = formatNameList(many);
    expect(out).toContain('and 3 more');
    expect(out).not.toContain(`d${NAME_LIST_LIMIT}`);
  });

  it('says nothing at all for an empty list — a caller must not render "" as a name', () => {
    expect(formatNameList([])).toBe('');
  });
});
