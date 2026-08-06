import { describe, expect, it } from 'vitest';
import { ACTIVITY_CATEGORIES, ACTIVITY_CATEGORY_LABELS, catalog } from '@autonomy-studio/shared';
import { toolboxGroups } from './activityGroups';

/** Flatten groups back to a type list, in render order. */
function typesOf(groups: ReturnType<typeof toolboxGroups>): string[] {
  return groups.flatMap((g) => g.entries.map((e) => e.type));
}

describe('toolboxGroups', () => {
  it('offers EVERY catalogued activity, the structural-call one included (#425)', () => {
    const types = typesOf(toolboxGroups(''));
    expect(types.sort()).toEqual([...catalog.values()].map((e) => e.type).sort());
    // `execute_pipeline` stores its settings in `node.call`, which the generic
    // config form cannot author — but `CallPanel` can, so the palette no longer
    // hides the one activity that composes pipelines out of pipelines.
    expect(types).toContain('execute_pipeline');
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

  it('matches the structural-call activity by type AND by title (#425)', () => {
    // Searchable by both, like every other entry: the type is what an export
    // envelope and an error message name, the title is what the toolbox shows.
    expect(typesOf(toolboxGroups('execute_pipeline'))).toEqual(['execute_pipeline']);
    expect(typesOf(toolboxGroups('Execute Pipeline'))).toEqual(['execute_pipeline']);
  });
});
