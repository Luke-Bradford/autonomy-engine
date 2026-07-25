import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_CATEGORIES,
  ACTIVITY_CATEGORY_LABELS,
  catalog,
  isStructuralCallActivity,
} from '@autonomy-studio/shared';
import { toolboxGroups } from './activityGroups';

/** Every activity the toolbox is allowed to offer. */
const authorable = [...catalog.values()].filter((e) => !isStructuralCallActivity(e.type));

/** Flatten groups back to a type list, in render order. */
function typesOf(groups: ReturnType<typeof toolboxGroups>): string[] {
  return groups.flatMap((g) => g.entries.map((e) => e.type));
}

describe('toolboxGroups', () => {
  it('offers every generically-authorable activity and hides the structural-call one', () => {
    const types = typesOf(toolboxGroups(''));
    expect(types.sort()).toEqual(authorable.map((e) => e.type).sort());
    // The #4 A9 exclusion the flat palette carried: `execute_pipeline` stores its
    // settings in `node.call`, so the generic config form cannot author it (#425).
    expect(types).not.toContain('execute_pipeline');
  });

  it('renders groups in the shared ACTIVITY_CATEGORIES order, not catalog order', () => {
    const groups = toolboxGroups('');
    const rendered = groups.map((g) => g.category);
    // A subsequence of the declared order — every present category in order, and
    // no category the catalog does not populate.
    expect(rendered).toEqual(ACTIVITY_CATEGORIES.filter((c) => rendered.includes(c)));
    expect(rendered.length).toBeGreaterThan(1);
  });

  it('labels each group from the shared SSOT', () => {
    for (const group of toolboxGroups('')) {
      expect(group.label).toBe(ACTIVITY_CATEGORY_LABELS[group.category]);
    }
  });

  it('sorts entries alphabetically by title INSIDE a group', () => {
    // The catalog's own Map order is registry declaration order, which interleaves
    // categories (general at the top, more general entries after the control
    // block). Left alone, a group would list its activities in an order that
    // tracks nothing a user can see.
    for (const group of toolboxGroups('')) {
      const titles = group.entries.map((e) => e.title);
      expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b)));
    }
  });

  it('matches on title, case-insensitively', () => {
    const groups = toolboxGroups('hTtP');
    expect(typesOf(groups)).toContain('http_request');
    expect(groups.every((g) => g.entries.every((e) => /http/i.test(`${e.title} ${e.type}`)))).toBe(
      true,
    );
  });

  it('matches on the activity TYPE too, which is what an author who knows the docs types', () => {
    // "file_" appears in no title (`Read File`, `Write File`, …) — only in the type.
    const types = typesOf(toolboxGroups('file_'));
    expect(types).toContain('file_read');
    expect(types).toContain('file_write');
    expect(types.every((t) => t.startsWith('file_'))).toBe(true);
  });

  it('ignores surrounding whitespace so a trailing space does not empty the list', () => {
    expect(typesOf(toolboxGroups('  http  '))).toEqual(typesOf(toolboxGroups('http')));
    expect(typesOf(toolboxGroups('   '))).toEqual(typesOf(toolboxGroups('')));
  });

  it('OMITS a group whose every entry was filtered out', () => {
    const groups = toolboxGroups('http_request');
    expect(groups).toHaveLength(1);
    expect(groups[0]!.category).toBe('general');
    // An empty group would render a heading over nothing — a false "this category
    // has matches" signal, and dead vertical space in a 180px column.
    expect(groups.every((g) => g.entries.length > 0)).toBe(true);
  });

  it('returns NO groups when nothing matches (the empty state, not an empty heading list)', () => {
    expect(toolboxGroups('zzzz-no-such-activity')).toEqual([]);
  });

  it('never matches the structural-call activity even by an exact query', () => {
    // The exclusion is by TYPE, not by the filter happening not to hit it.
    expect(toolboxGroups('execute_pipeline')).toEqual([]);
    expect(toolboxGroups('Execute Pipeline')).toEqual([]);
  });
});
