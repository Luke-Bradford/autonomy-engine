import { describe, expect, it } from 'vitest';
import { copyFilesConfigSchema } from '../copy-files-config.js';
import { getActivity } from '../registry.js';
import { COPY_FILES_ACTIVITY_TYPE } from '../types.js';

/** #1600 OR41 C1a — the Copy · Files as-is config and its catalog entry. */
const issues = (input: unknown) =>
  (copyFilesConfigSchema.safeParse(input).error?.issues ?? []).map(
    (i) => `${i.path.join('.')}: ${i.message}`,
  );

describe('copy_files config', () => {
  it('needs only a source path; everything else has a default', () => {
    expect(copyFilesConfigSchema.parse({ sourcePath: 'in' })).toEqual({
      sourcePath: 'in',
      pathType: 'folder',
      wildcard: '*',
      recursive: true,
      afterCopy: 'keep',
      copyBehavior: 'preserve',
      ifExists: 'overwrite',
      logLevel: 'warning',
    });
    expect(issues({})).toEqual([expect.stringMatching(/^sourcePath: /)]);
  });

  it.each([
    [{ pathType: 'list' }, 'fileListPath: a file list needs a file list path'],
    [{ fileListPath: 'l.txt' }, 'fileListPath: a file list path is only read when'],
    [{ afterCopy: 'move' }, 'moveTo: moving the source needs a folder'],
    [{ moveTo: 'done' }, 'moveTo: a move-to folder is only used when'],
    [{ copyBehavior: 'merge' }, 'sinkFileName: merging into one file needs its file name'],
    [
      { copyBehavior: 'merge', pathType: 'file', sinkFileName: 'a' },
      'copyBehavior: merging needs a folder or a file list',
    ],
    [{ sinkFileName: 'a.txt' }, 'sinkFileName: a file name is only used for one file or a merge'],
    [{ modifiedStart: 'yesterday' }, 'modifiedStart: '],
  ])('refuses %j', (extra, message) => {
    expect(issues({ sourcePath: 'in', ...extra }).join('\n')).toContain(message);
  });

  it('refuses a wildcard it would never read, or one holding a folder separator', () => {
    expect(issues({ sourcePath: 'in', wildcard: 'sub/*.csv' })).toEqual([
      'wildcard: a wildcard matches file names only, so it cannot hold a folder separator',
    ]);
    expect(issues({ sourcePath: 'a.txt', pathType: 'file', wildcard: '*.csv' })).toEqual([
      'wildcard: a wildcard is only read when the path type is Folder',
    ]);
    // The default is not "set", so a file copy with it is fine.
    expect(issues({ sourcePath: 'a.txt', pathType: 'file' })).toEqual([]);
  });

  it('refuses a literal modified window that selects nothing, at save rather than at run', () => {
    expect(
      issues({
        sourcePath: 'in',
        modifiedStart: '2026-03-02T00:00:00Z',
        modifiedEnd: '2026-03-01T00:00:00Z',
      }),
    ).toEqual(['modifiedEnd: Modified before must be later than Modified from']);
    expect(
      issues({
        sourcePath: 'in',
        modifiedStart: '2026-03-01T00:00:00Z',
        modifiedEnd: '2026-03-01T00:00:00Z',
      }),
    ).toHaveLength(1);
  });

  it('accepts a file name for one file, and for a merge', () => {
    expect(issues({ sourcePath: 'a', pathType: 'file', sinkFileName: 'b' })).toEqual([]);
    expect(issues({ sourcePath: 'in', copyBehavior: 'merge', sinkFileName: 'all' })).toEqual([]);
  });

  it('is a paired fs-to-fs entry with no datasets, kept out of the palette', () => {
    const entry = getActivity(COPY_FILES_ACTIVITY_TYPE)!;
    expect(entry).toMatchObject({
      title: 'Copy data',
      inPalette: false,
      connectionKinds: ['fs'],
      sinkConnectionKinds: ['fs'],
      idempotent: false,
    });
    expect(entry.datasetKinds).toBeUndefined();
    // Files and bytes, never rows: a `rowsWritten` of 0 would count as "wrote
    // nothing" in the run's rows total. Plus `source` and `dest`, the retired
    // Copy file / Move file outputs (#1600 C1b).
    expect(entry.outputs.map((o) => o.name).sort()).toEqual(
      [
        'bytesRead',
        'bytesWritten',
        'dest',
        'filesDeleted',
        'filesMoved',
        'filesRead',
        'filesSkipped',
        'filesWritten',
        'source',
      ].sort(),
    );
  });
});

describe('copy_files appliesWhen (#1686)', () => {
  // The dock's view rule must agree with the schema's cross-field checks: over
  // every combination of the three controls, a field the schema refuses is one
  // the dock leaves out, and one it needs is one the dock draws. Include
  // subfolders is left out of the comparison: it has a default, so the schema
  // cannot tell it set from left (the superRefine's own note).
  const entry = getActivity(COPY_FILES_ACTIVITY_TYPE);
  const rules = entry?.appliesWhen ?? {};
  const held: Record<string, string> = {
    wildcard: '*.csv',
    fileListPath: 'list.txt',
    moveTo: 'done',
    sinkFileName: 'all.csv',
  };
  const combos = (['file', 'folder', 'list'] as const).flatMap((pathType) =>
    (['keep', 'delete', 'move'] as const).flatMap((afterCopy) =>
      (['preserve', 'flatten', 'merge'] as const).map((copyBehavior) => ({
        pathType,
        afterCopy,
        copyBehavior,
      })),
    ),
  );
  const applies = (name: string, controls: Record<string, string>) =>
    (rules[name] ?? []).some(
      (c) => 'in' in c && (c.in as readonly string[]).includes(controls[c.field]!),
    );
  const refusedOn = (name: string, config: Record<string, unknown>) =>
    issues(config).some((i) => i.startsWith(`${name}:`));

  it('covers every conditional field', () => {
    expect(Object.keys(rules).sort()).toEqual([...Object.keys(held), 'recursive'].sort());
  });

  it.each(Object.keys(held))('%s is drawn exactly where the schema accepts it', (name) => {
    for (const controls of combos) {
      const config = { sourcePath: 'in', ...controls, [name]: held[name] };
      expect(refusedOn(name, config), `${name} set, ${JSON.stringify(controls)}`).toBe(
        !applies(name, controls),
      );
      const without = { sourcePath: 'in', ...controls };
      if (refusedOn(name, without)) {
        expect(applies(name, controls), `${name} needed, ${JSON.stringify(controls)}`).toBe(true);
      }
    }
  });
});

describe('copy_files session log (#1600 OR41 C6b)', () => {
  it('defaults to Warnings, and refuses a level it does not know', () => {
    expect(copyFilesConfigSchema.parse({ sourcePath: 'in' }).logLevel).toBe('warning');
    expect(issues({ sourcePath: 'in', logLevel: 'debug' })).toHaveLength(1);
  });

  it('is drawn on the Settings tab, after Sink, as on a rows Copy', () => {
    const tabs = getActivity(COPY_FILES_ACTIVITY_TYPE)!.tabs!;
    expect(tabs.map((t) => t.key)).toEqual(['source', 'sink', 'settings']);
    expect(tabs[2]!.fields).toEqual(['logLevel']);
  });
});
