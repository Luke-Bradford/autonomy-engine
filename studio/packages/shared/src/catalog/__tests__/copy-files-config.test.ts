import { describe, expect, it } from 'vitest';
import { COPY_MAX_PARALLEL_COPIES, copyFilesConfigSchema } from '../copy-files-config.js';
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
      skipMissingFiles: true,
      skipForbiddenFiles: false,
      validateDataConsistency: false,
      skipInconsistentFiles: false,
      logLevel: 'warning',
      parallelCopies: 1,
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
    // Copy file / Move file outputs (#1600 C1b), and the run's measures (C6f-1).
    expect(entry.outputs.map((o) => o.name).sort()).toEqual(
      [
        'bytesRead',
        'bytesWritten',
        'consistency',
        'dest',
        'durationMs',
        'filesDeleted',
        'filesMoved',
        'filesRead',
        'filesSkipped',
        'filesWritten',
        'source',
        'throughput',
      ].sort(),
    );
  });
});

describe('copy_files appliesWhen (#1686)', () => {
  // The dock's view rule must agree with the schema's cross-field checks: over
  // every combination of the three controls, a field the schema refuses is one
  // the dock leaves out, and one it needs is one the dock draws. Include
  // subfolders and Skip missing files are left out of the comparison: each
  // defaults to on, so the schema cannot tell it set from left (the
  // superRefine's own note). #1600 C6e-2's Skip inconsistent files is too: its
  // control is Verify copied files, not one of the three, and its one-file
  // refusal is one an OR'd view rule cannot draw (the C6e-2 block below).
  const entry = getActivity(COPY_FILES_ACTIVITY_TYPE);
  const rules = entry?.appliesWhen ?? {};
  const held: Record<string, unknown> = {
    wildcard: '*.csv',
    fileListPath: 'list.txt',
    moveTo: 'done',
    sinkFileName: 'all.csv',
    skipForbiddenFiles: true,
    validateDataConsistency: true,
    parallelCopies: 4,
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
    expect(Object.keys(rules).sort()).toEqual(
      [...Object.keys(held), 'recursive', 'skipMissingFiles', 'skipInconsistentFiles'].sort(),
    );
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
    expect(tabs[2]!.fields).toEqual([
      'parallelCopies',
      'skipMissingFiles',
      'skipForbiddenFiles',
      'validateDataConsistency',
      'skipInconsistentFiles',
      'logLevel',
    ]);
  });
});

describe('copy_files fault tolerance (#1600 OR41 C6d-2)', () => {
  it('skips missing files and not forbidden ones by default, as in ADF', () => {
    const cfg = copyFilesConfigSchema.parse({ sourcePath: 'in' });
    expect(cfg.skipMissingFiles).toBe(true);
    expect(cfg.skipForbiddenFiles).toBe(false);
  });

  it('refuses Skip forbidden files on one file, which fails whatever it says', () => {
    expect(issues({ sourcePath: 'a.txt', pathType: 'file', skipForbiddenFiles: true })).toEqual([
      'skipForbiddenFiles: skipping a forbidden file needs a folder or a file list; one file fails instead',
    ]);
    expect(issues({ sourcePath: 'in', skipForbiddenFiles: true })).toEqual([]);
    expect(
      issues({
        sourcePath: 'in',
        pathType: 'list',
        fileListPath: 'l.txt',
        skipForbiddenFiles: true,
      }),
    ).toEqual([]);
    expect(issues({ sourcePath: 'a.txt', pathType: 'file', skipMissingFiles: false })).toEqual([]);
  });
});

describe('copy_files data consistency (#1600 OR41 C6e-2)', () => {
  it('verifies only under Preserve hierarchy, as in ADF', () => {
    expect(issues({ sourcePath: 'in', validateDataConsistency: true })).toEqual([]);
    expect(
      issues({ sourcePath: 'a.txt', pathType: 'file', validateDataConsistency: true }),
    ).toEqual([]);
    expect(
      issues({ sourcePath: 'in', copyBehavior: 'flatten', validateDataConsistency: true }),
    ).toEqual([
      'validateDataConsistency: verifying a files copy needs Copy behaviour Preserve hierarchy',
    ]);
    expect(
      issues({
        sourcePath: 'in',
        copyBehavior: 'merge',
        sinkFileName: 'all.txt',
        validateDataConsistency: true,
      }),
    ).toEqual([
      'validateDataConsistency: verifying a files copy needs Copy behaviour Preserve hierarchy',
    ]);
    expect(issues({ sourcePath: 'in', copyBehavior: 'flatten' })).toEqual([]);
  });

  it('skips an inconsistent file only with the check, and never on one file', () => {
    expect(
      issues({ sourcePath: 'in', validateDataConsistency: true, skipInconsistentFiles: true }),
    ).toEqual([]);
    expect(issues({ sourcePath: 'in', skipInconsistentFiles: true })).toEqual([
      'skipInconsistentFiles: skipping an inconsistent file needs Verify copied files, which finds it',
    ]);
    expect(
      issues({
        sourcePath: 'a.txt',
        pathType: 'file',
        validateDataConsistency: true,
        skipInconsistentFiles: true,
      }),
    ).toEqual([
      'skipInconsistentFiles: skipping an inconsistent file needs a folder or a file list; one file fails instead',
    ]);
  });

  it('draws Verify under Preserve, and its skip once it is on', () => {
    const entry = getActivity(COPY_FILES_ACTIVITY_TYPE)!;
    expect(entry.appliesWhen?.['validateDataConsistency']).toEqual([
      { field: 'copyBehavior', in: ['preserve'] },
    ]);
    expect(entry.appliesWhen?.['skipInconsistentFiles']).toEqual([
      { field: 'validateDataConsistency', in: ['true'] },
    ]);
  });
});

describe('copy_files Degree of copy parallelism (#1600 OR41 C6f-2)', () => {
  it('defaults to one at a time and takes 1 to COPY_MAX_PARALLEL_COPIES', () => {
    expect(copyFilesConfigSchema.parse({ sourcePath: 'in' }).parallelCopies).toBe(1);
    expect(issues({ sourcePath: 'in', parallelCopies: COPY_MAX_PARALLEL_COPIES })).toEqual([]);
    expect(issues({ sourcePath: 'in', parallelCopies: 0 })).toHaveLength(1);
    expect(issues({ sourcePath: 'in', parallelCopies: COPY_MAX_PARALLEL_COPIES + 1 })).toHaveLength(
      1,
    );
    expect(issues({ sourcePath: 'in', parallelCopies: 2.5 })).toHaveLength(1);
  });

  it('refuses more than one under Merge, which writes one file', () => {
    const merge = { sourcePath: 'in', copyBehavior: 'merge', sinkFileName: 'all.csv' };
    expect(issues({ ...merge, parallelCopies: 2 })).toEqual([
      'parallelCopies: a merge writes one file, so it copies one at a time; leave Degree of copy parallelism at 1',
    ]);
    expect(issues({ ...merge, parallelCopies: 1 })).toEqual([]);
  });

  it('is drawn under Preserve and Flatten', () => {
    expect(getActivity(COPY_FILES_ACTIVITY_TYPE)!.appliesWhen?.['parallelCopies']).toEqual([
      { field: 'copyBehavior', in: ['preserve', 'flatten'] },
    ]);
  });
});
