import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_CATEGORIES,
  ACTIVITY_CATEGORY_LABELS,
  catalog,
  COPY_ACTIVITY_TYPE,
} from '@autonomy-studio/shared';
import { containerToolboxEntries, toolboxGroups } from './activityGroups';

/** Flatten groups back to a type list, in render order. */
function typesOf(groups: ReturnType<typeof toolboxGroups>): string[] {
  return groups.flatMap((g) => g.entries.map((e) => e.type));
}

describe('toolboxGroups', () => {
  // #1600 OR41 C1a — `copy_files` is Copy in Files as-is mode, reached by the
  // dock's toggle: the toolbox offers ONE Copy, under any search.
  it('never offers an inPalette:false type, even searched by its type id', () => {
    expect(typesOf(toolboxGroups(''))).not.toContain('copy_files');
    expect(typesOf(toolboxGroups('copy_files'))).toEqual([]);
    expect(typesOf(toolboxGroups('copy'))).toContain('copy');
  });

  it('offers EVERY catalogued activity, the structural-call one included (#425)', () => {
    const types = typesOf(toolboxGroups(''));
    expect(types.sort()).toEqual(
      [...catalog.values()]
        .filter((e) => e.inPalette !== false)
        .map((e) => e.type)
        .sort(),
    );
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
    expect(
      groups.every((g) =>
        g.entries.every((e) => /http/i.test(`${e.title} ${e.type} ${e.description}`)),
      ),
    ).toBe(true);
  });

  it('matches on the activity TYPE too, which is what an author who knows the docs types', () => {
    // "file_" appears in no title (`Write file`, `Delete file`, …) — only in the type.
    const types = typesOf(toolboxGroups('file_'));
    expect(types).toContain('file_write');
    expect(types.every((t) => t.startsWith('file_'))).toBe(true);
  });

  it('#1600 OR41 C7b — offers ONE Lookup, which a search for reading a file finds', () => {
    const all = typesOf(toolboxGroups(''));
    expect(all).toContain('lookup');
    // Whole file as text is Lookup's other mode, chosen in the dock.
    expect(all).not.toContain('file_read');
    expect(typesOf(toolboxGroups('read file'))).toContain('lookup');
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
    expect(typesOf(toolboxGroups('Execute pipeline'))).toEqual(['execute_pipeline']);
  });

  // #1449 — an author searches for what they want DONE, which is what the
  // description says; the title only names the result.
  it('matches on the description, every word somewhere in the entry', () => {
    // "mapping" is in no title or type — only Copy data's description.
    expect(typesOf(toolboxGroups('mapping'))).toEqual([COPY_ACTIVITY_TYPE]);
    // Words are matched separately, across title and description, so the order
    // an author types them in does not matter.
    expect(typesOf(toolboxGroups('copy rows'))).toEqual([COPY_ACTIVITY_TYPE]);
    expect(typesOf(toolboxGroups('  ROWS   copy '))).toEqual([COPY_ACTIVITY_TYPE]);
    // Every word must match: "copy file" keeps Copy data, whose description
    // names both rows and files (#1600 C1a), and "zebra" then drops it.
    // Copy file and Move file are retired from the palette (#1600 C1b).
    expect(typesOf(toolboxGroups('copy file'))).toContain(COPY_ACTIVITY_TYPE);
    expect(typesOf(toolboxGroups('copy file'))).not.toContain('file_copy');
    expect(typesOf(toolboxGroups('move file'))).not.toContain('file_move');
    // List directory is retired too (#1600 C8b): a folder search finds Get metadata.
    expect(typesOf(toolboxGroups('list directory'))).not.toContain('file_list');
    expect(typesOf(toolboxGroups('folder'))).toContain('get_metadata');
    expect(typesOf(toolboxGroups('copy file zebra'))).toEqual([]);
  });
});

describe('containerToolboxEntries (#1449)', () => {
  it('matches a container on its description too', () => {
    expect(containerToolboxEntries('each item').map((e) => e.kind)).toEqual(['foreach']);
    expect(containerToolboxEntries('condition').map((e) => e.kind)).toEqual(['loop']);
  });

  it('keeps all three for a search naming the group', () => {
    expect(containerToolboxEntries('contain')).toHaveLength(3);
  });
});
