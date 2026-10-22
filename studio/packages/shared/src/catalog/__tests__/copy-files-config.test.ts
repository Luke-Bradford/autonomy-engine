import { describe, expect, it } from 'vitest';
import {
  COPY_MAX_PARALLEL_COPIES,
  copyFilesConfigSchema,
  copyFilesIncrementalIssues,
} from '../copy-files-config.js';
import { getActivity } from '../registry.js';
import { COPY_FILES_ACTIVITY_TYPE } from '../types.js';
import { activityNodeErrors } from '../../engine/activity-config-check.js';
import type { Node } from '../../schemas/pipeline.js';
import { fieldLabelOf } from '../../schemas/field-presentation.js';

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
      load: 'full',
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
      logTo: 'run',
      logMode: 'reliable',
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
    // Copy file / Move file outputs (#1600 C1b), the run's measures (C6f-1) and
    // how many copies ran at once (C6f-2).
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
        'logPath',
        'source',
        'throughput',
        'usedParallelCopies',
        'watermark',
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
    // #1600 C5b — Modified between, drawn under Load Full only.
    modifiedStart: '2026-10-01T00:00:00Z',
    modifiedEnd: '2026-10-02T00:00:00Z',
  };
  const combos = (['file', 'folder', 'list'] as const).flatMap((pathType) =>
    (['keep', 'delete', 'move'] as const).flatMap((afterCopy) =>
      (['preserve', 'flatten', 'merge'] as const).flatMap((copyBehavior) =>
        (['full', 'incremental'] as const).map((load) => ({
          pathType,
          afterCopy,
          copyBehavior,
          load,
        })),
      ),
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
      [
        ...Object.keys(held),
        'recursive',
        'skipMissingFiles',
        'skipInconsistentFiles',
        'logTo',
        'logFolder',
        'logMode',
      ].sort(),
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
      'logTo',
      'logFolder',
      'logMode',
    ]);
    expect(tabs[2]!.bindings).toEqual(['logConnection']);
  });
});

describe('copy_files session log mode (#1600 OR41 C6c-2)', () => {
  it('is Reliable by default, and Best effort for a folder log', () => {
    expect(copyFilesConfigSchema.parse({ sourcePath: 'in' }).logMode).toBe('reliable');
    expect(
      issues({ sourcePath: 'in', logTo: 'folder', logFolder: 'logs', logMode: 'bestEffort' }),
    ).toEqual([]);
  });

  it.each([{}, { logLevel: 'off' }])('refuses Best effort without a folder log (%j)', (extra) => {
    expect(issues({ sourcePath: 'in', ...extra, logMode: 'bestEffort' })).toEqual([
      'logMode: only read when the session log is written to a folder',
    ]);
  });

  it('is drawn for a folder log', () => {
    const entry = getActivity(COPY_FILES_ACTIVITY_TYPE)!;
    expect(entry.appliesWhen?.logMode).toEqual([{ field: 'logTo', in: ['folder'] }]);
  });
});

describe('copy_files session log to a folder (#1600 OR41 C6c-1a)', () => {
  it('writes to the run log by default, and to a folder on the log connection', () => {
    const cfg = copyFilesConfigSchema.parse({ sourcePath: 'in' });
    expect(cfg.logTo).toBe('run');
    expect(cfg.logFolder).toBeUndefined();
    expect(issues({ sourcePath: 'in', logTo: 'folder', logFolder: 'logs' })).toEqual([]);
  });

  it.each([
    [{ logTo: 'folder' }, 'logFolder: needed to write the session log to a folder'],
    [{ logFolder: 'logs' }, 'logFolder: only read when the session log is written to a folder'],
    [
      { logLevel: 'off', logTo: 'folder', logFolder: 'logs' },
      'logLevel: the session log is off, but it is set to write to a folder',
    ],
  ])('refuses %j', (extra, message) => {
    expect(issues({ sourcePath: 'in', ...extra })).toEqual([message]);
  });

  it('draws Write to while the log is on, and the folder (and its connection) for Folder', () => {
    const entry = getActivity(COPY_FILES_ACTIVITY_TYPE)!;
    expect(entry.appliesWhen?.logTo).toEqual([{ field: 'logLevel', in: ['warning', 'info'] }]);
    expect(entry.appliesWhen?.logFolder).toEqual([{ field: 'logTo', in: ['folder'] }]);
    expect(entry.logConnectionKinds).toEqual(['fs']);
    // Its own description: the folder is on the LOG connection, not the same one.
    expect(fieldLabelOf(copyFilesConfigSchema.shape.logFolder)?.description).toMatch(
      /log connection/,
    );
  });

  it('declares logPath, and keeps the outputs a node saved before C6c-1a declares', () => {
    const entry = getActivity(COPY_FILES_ACTIVITY_TYPE)!;
    const names = entry.outputs.map((o) => o.name);
    expect(names).toContain('logPath');
    expect(entry.outputs.find((o) => o.name === 'logPath')?.optional).toBe(true);
    // #1600 C5b — the snapshot before C6c-1a is the second: C5b's leads.
    const former = entry.formerOutputs![1]!.map((o) => o.name);
    expect(former).toEqual(names.filter((n) => n !== 'logPath' && n !== 'watermark'));
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

  it('takes dynamic content at save (UI STANDARD rule 4)', () => {
    const node = {
      id: 'c',
      type: COPY_FILES_ACTIVITY_TYPE,
      connectionIds: { source: 's', sink: 's' },
      config: { sourcePath: 'in', parallelCopies: '${pipeline().parameters.n}' },
    } as unknown as Node;
    expect(activityNodeErrors(node)).toEqual([]);
    // And the same check refuses a literal out of range, so it is not vacuous.
    const literal = { ...node, config: { sourcePath: 'in', parallelCopies: 0 } } as Node;
    expect(activityNodeErrors(literal)).toHaveLength(1);
  });
});

describe('copy_files log connection at save (#1600 OR41 C6c-1a)', () => {
  const node = (config: Record<string, unknown>, log?: string, type = COPY_FILES_ACTIVITY_TYPE) =>
    ({
      id: 'c',
      type,
      position: { x: 0, y: 0 },
      connectionIds: { source: 's', sink: 's', ...(log !== undefined && { log }) },
      config: { sourcePath: 'in', ...config },
    }) as Node;

  it('accepts a log connection beside Write to Folder, and Folder before one is bound', () => {
    expect(activityNodeErrors(node({ logTo: 'folder', logFolder: 'logs' }, 'l'))).toEqual([]);
    // A missing log connection is a binding still to pick, refused at dispatch:
    // an import strips a literal end, and save must not then refuse the version.
    expect(activityNodeErrors(node({ logTo: 'folder', logFolder: 'logs' }))).toEqual([]);
  });

  it('refuses a log connection the session log would not use', () => {
    expect(activityNodeErrors(node({}, 'l'))).toEqual([
      "node 'c': connectionIds.log: the log connection is only used when the session log is written to a folder",
    ]);
    // A `${}` Write to is decided at dispatch.
    expect(activityNodeErrors(node({ logTo: '${pipeline().parameters.to}' }, 'l'))).toEqual([]);
  });

  it('refuses a log connection on an activity that has none', () => {
    // #1600 OR41 C6c-1b — a rows Copy has one now, so Lookup stands in.
    const rows = node({}, 'l', 'lookup');
    expect(activityNodeErrors(rows).filter((e) => e.includes('connectionIds.log'))).toEqual([
      "node 'c': connectionIds.log: this activity has no log connection",
    ]);
  });
});

/**
 * #1600 OR41 C5b — Load Incremental on a Files as-is copy: *Modified since last
 * successful run*. The window is studio's, so the explicit Modified between and
 * a Merge (one file holding only the new files) are refused beside it.
 */
describe('copy_files Load Incremental (C5b)', () => {
  it('saves Incremental on a folder, a file list and one file', () => {
    for (const pathType of ['folder', 'file']) {
      expect(issues({ sourcePath: 'in', pathType, load: 'incremental' })).toEqual([]);
    }
    expect(
      issues({ sourcePath: 'in', pathType: 'list', fileListPath: 'l', load: 'incremental' }),
    ).toEqual([]);
  });

  it.each([
    [{ modifiedStart: '2026-10-01T00:00:00Z' }, 'modifiedStart'],
    [{ modifiedEnd: '2026-10-01T00:00:00Z' }, 'modifiedEnd'],
    [{ copyBehavior: 'merge', sinkFileName: 'all.bin' }, 'copyBehavior'],
    [{ copyBehavior: 'flatten' }, 'copyBehavior'],
  ])('refuses %j under Incremental', (config, field) => {
    const found = issues({ sourcePath: 'in', load: 'incremental', ...config });
    expect(found).toEqual([expect.stringMatching(new RegExp(`^${field}: .*Incremental`))]);
    // Under Full each is what it was.
    expect(issues({ sourcePath: 'in', ...config })).toEqual([]);
  });

  it('keeps Load literal at save', () => {
    const errs = copyFilesIncrementalIssues({
      sourcePath: 'in',
      load: '${pipeline().parameters.l}',
    });
    expect(errs).toEqual([
      { field: 'load', message: 'Load stays literal, because it decides which fields apply' },
    ]);
  });

  it('draws Load after Source path on the Source tab, and Modified between only under Full', () => {
    const entry = getActivity(COPY_FILES_ACTIVITY_TYPE)!;
    expect(entry.tabs?.find((t) => t.key === 'source')?.fields?.slice(0, 2)).toEqual([
      'sourcePath',
      'load',
    ]);
    expect(entry.appliesWhen?.['modifiedStart']).toEqual([{ field: 'load', in: ['full'] }]);
    expect(entry.appliesWhen?.['modifiedEnd']).toEqual([{ field: 'load', in: ['full'] }]);
    expect(entry.outputs.at(-1)).toMatchObject({ name: 'watermark', optional: true });
    // A node saved before C5b keeps the contract it was saved with.
    expect(entry.formerOutputs![0]!.map((o) => o.name)).toEqual(
      entry.outputs.map((o) => o.name).filter((n) => n !== 'watermark'),
    );
  });
});
