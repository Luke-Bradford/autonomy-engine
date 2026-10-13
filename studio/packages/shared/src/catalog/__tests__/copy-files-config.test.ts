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

  it('accepts a file name for one file, and for a merge', () => {
    expect(issues({ sourcePath: 'a', pathType: 'file', sinkFileName: 'b' })).toEqual([]);
    expect(issues({ sourcePath: 'in', copyBehavior: 'merge', sinkFileName: 'all' })).toEqual([]);
  });

  it('is a paired fs-to-fs entry with no datasets, kept out of the palette', () => {
    const entry = getActivity(COPY_FILES_ACTIVITY_TYPE)!;
    expect(entry).toMatchObject({
      title: 'Copy',
      inPalette: false,
      connectionKinds: ['fs'],
      sinkConnectionKinds: ['fs'],
      idempotent: false,
    });
    expect(entry.datasetKinds).toBeUndefined();
    // Every `copy` output too, so a reference keeps resolving across the toggle.
    const names = entry.outputs.map((o) => o.name);
    for (const o of getActivity('copy')!.outputs) expect(names).toContain(o.name);
  });
});
