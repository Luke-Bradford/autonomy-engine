import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getActivity, type ActivityCatalogEntry } from '@autonomy-studio/shared';
import { applicableFieldNames, nodeTypeTabs, offeredFieldOptions } from './activityTabs';
import { deriveConfigFields, seedFieldInputs } from './configForm';

const fieldsOf = (entry: ActivityCatalogEntry) => deriveConfigFields(entry.configSchema) ?? [];

const summary = (tabs: ReturnType<typeof nodeTypeTabs>) =>
  tabs.map((t) => ({
    key: t.key,
    label: t.label,
    fields: t.fields.map((f) => f.name),
    bindings: t.bindings,
  }));

function entryWith(overrides: Partial<ActivityCatalogEntry>): ActivityCatalogEntry {
  const base = getActivity('http_request');
  if (base === undefined) throw new Error('http_request is catalogued');
  return { ...base, ...overrides };
}

describe('nodeTypeTabs (#1477)', () => {
  it('reads the catalog declaration, in its order', () => {
    const copy = getActivity('copy');
    if (copy === undefined) throw new Error('copy is catalogued');
    expect(summary(nodeTypeTabs(copy, fieldsOf(copy)))).toEqual([
      {
        key: 'source',
        label: 'Source',
        fields: [],
        bindings: ['sourceConnection', 'sourceDataset'],
      },
      {
        key: 'sink',
        label: 'Sink',
        fields: [
          'tableOption',
          'mode',
          'keyColumns',
          'preCopyScript',
          'preCopyScriptParameters',
          'writeBatchSize',
        ],
        bindings: ['sinkConnection', 'sinkDataset'],
      },
      { key: 'mapping', label: 'Mapping', fields: ['mapping'], bindings: [] },
      // #1600 OR41 C6a — ADF's Settings tab, after Mapping.
      {
        key: 'settings',
        label: 'Settings',
        fields: [
          'skipIncompatibleRows',
          'validateDataConsistency',
          'logLevel',
          'logTo',
          'logFolder',
        ],
        bindings: ['logConnection'],
      },
    ]);
  });

  it('gives an uncatalogued type one Settings tab holding everything', () => {
    const fields = deriveConfigFields(z.object({ a: z.string(), b: z.number() })) ?? [];
    expect(summary(nodeTypeTabs(undefined, fields))).toEqual([
      { key: 'settings', label: 'Settings', fields: ['a', 'b'], bindings: [] },
    ]);
  });

  it('never drops a field or a binding the declaration forgot', () => {
    const entry = entryWith({ tabs: [{ key: 'auth', fields: ['secretHeaders'] }] });
    const [only] = nodeTypeTabs(entry, fieldsOf(entry));
    expect(only?.bindings).toEqual(['connection']);
    expect(only?.fields.map((f) => f.name)).toEqual([
      'secretHeaders',
      'url',
      'method',
      'headers',
      'body',
    ]);
  });

  it('draws a binding declared on two tabs once, on the first', () => {
    const entry = entryWith({
      tabs: [
        { key: 'request', bindings: ['connection'], fields: ['url', 'method', 'headers', 'body'] },
        { key: 'auth', bindings: ['connection'], fields: ['secretHeaders'] },
      ],
    });
    expect(nodeTypeTabs(entry, fieldsOf(entry)).map((t) => t.bindings)).toEqual([
      ['connection'],
      [],
    ]);
  });

  it('drops a name the schema lacks, a binding the entry cannot have, and an emptied tab', () => {
    const entry = entryWith({
      connectionKinds: [],
      tabs: [
        { key: 'request', bindings: ['connection', 'sinkDataset'], fields: ['nope'] },
        { key: 'auth', fields: ['url', 'method', 'headers', 'body', 'secretHeaders', 'url'] },
      ],
    });
    expect(summary(nodeTypeTabs(entry, fieldsOf(entry)))).toEqual([
      {
        key: 'auth',
        label: 'Auth',
        fields: ['url', 'method', 'headers', 'body', 'secretHeaders'],
        bindings: [],
      },
    ]);
  });
});

describe('applicableFieldNames (#1686)', () => {
  it('reads a boolean control as true or false (#1600 OR41 C9a, Delete empty folders)', () => {
    const del = getActivity('delete');
    if (del === undefined) throw new Error('delete is catalogued');
    const delFields = fieldsOf(del);
    const names = delFields.map((f) => f.name);
    const shown = (config: Record<string, unknown>, inputs = seedFieldInputs(delFields, config)) =>
      applicableFieldNames(del, names, delFields, inputs, config).includes('deleteEmptyFolders');
    expect(shown({})).toBe(false);
    // The checkbox as the author ticks it: a boolean draft over an unticked store.
    expect(shown({}, { ...seedFieldInputs(delFields, {}), recursive: true })).toBe(true);
    expect(shown({}, { ...seedFieldInputs(delFields, {}), recursive: false })).toBe(false);
  });

  it('shows a field conditioned `set` once its control holds a value (#1600 OR41 C3b)', () => {
    const copy = getActivity('copy');
    if (copy === undefined) throw new Error('copy is catalogued');
    const copyFields = fieldsOf(copy);
    const names = copyFields.map((f) => f.name);
    const shown = (config: Record<string, unknown>, inputs = seedFieldInputs(copyFields, config)) =>
      applicableFieldNames(copy, names, copyFields, inputs, config).includes(
        'preCopyScriptParameters',
      );
    expect(shown({})).toBe(false);
    // Typed, before any Apply.
    expect(shown({}, { ...seedFieldInputs(copyFields, {}), preCopyScript: 'delete from t' })).toBe(
      true,
    );
    expect(shown({ preCopyScript: 'delete from t' })).toBe(true);
    // A stored value is drawn regardless, so it can be seen and cleared.
    expect(shown({ preCopyScriptParameters: { d: 'x' } })).toBe(true);
  });

  const copyFiles = getActivity('copy_files');
  if (copyFiles === undefined) throw new Error('copy_files is catalogued');
  const fields = fieldsOf(copyFiles);
  const all = fields.map((f) => f.name);
  const hidden = (config: Record<string, unknown>, inputs = seedFieldInputs(fields, config)) =>
    all.filter((n) => !applicableFieldNames(copyFiles, all, fields, inputs, config).includes(n));

  it('reads each control at its schema default while it is empty', () => {
    // Folder, Keep, Preserve: no file list, no move-to, no file name, and
    // (#1600 C6e-2) no Skip inconsistent files while Verify copied files is off.
    expect(hidden({})).toEqual([
      'fileListPath',
      'moveTo',
      'sinkFileName',
      'skipInconsistentFiles',
      // #1600 C6c-1a — no Log folder while Write to is the run log.
      'logFolder',
    ]);
  });

  it('follows the draft as the controls change', () => {
    // #1600 C6d-2 — one file cannot skip one, as in ADF.
    expect(hidden({ pathType: 'file' })).toEqual([
      'wildcard',
      'fileListPath',
      'recursive',
      'moveTo',
      'skipMissingFiles',
      'skipForbiddenFiles',
      'skipInconsistentFiles',
      'logFolder',
    ]);
    expect(hidden({ pathType: 'list', afterCopy: 'move' })).toEqual([
      'wildcard',
      'recursive',
      'sinkFileName',
      'skipInconsistentFiles',
      'logFolder',
    ]);
    // Either condition of File name: one file, or a merge. #1600 C6e-2 — a
    // merge is not verified, as in ADF; C6f-2 — nor copied at once.
    expect(hidden({ copyBehavior: 'merge' })).toEqual([
      'fileListPath',
      'moveTo',
      'validateDataConsistency',
      'skipInconsistentFiles',
      'logFolder',
      'parallelCopies',
    ]);
    const typed = { ...seedFieldInputs(fields, {}), pathType: 'list' };
    expect(hidden({}, typed)).toEqual([
      'wildcard',
      'recursive',
      'moveTo',
      'sinkFileName',
      'skipInconsistentFiles',
      'logFolder',
    ]);
  });

  it('draws Skip inconsistent files once Verify copied files is on (#1600 C6e-2)', () => {
    expect(hidden({ copyBehavior: 'flatten' })).toContain('validateDataConsistency');
    expect(hidden({ validateDataConsistency: true })).not.toContain('skipInconsistentFiles');
    // Ticked, before any Apply.
    const ticked = { ...seedFieldInputs(fields, {}), validateDataConsistency: true };
    expect(hidden({}, ticked)).toEqual(['fileListPath', 'moveTo', 'sinkFileName', 'logFolder']);
  });

  it('draws a field whose control is an expression', () => {
    // No enum control takes one today, but a typed field that does (UI STANDARD
    // rule 4) must not hide what it may yet select.
    const typed = { ...seedFieldInputs(fields, {}), pathType: '${pipeline().parameters.kind}' };
    expect(hidden({}, typed)).toEqual(['moveTo', 'skipInconsistentFiles', 'logFolder']);
  });

  it('still draws a field that holds a value where it cannot apply', () => {
    // Stored: the schema refuses it, and the author must be able to clear it.
    expect(hidden({ pathType: 'file', wildcard: '*.csv' })).toEqual([
      'fileListPath',
      'recursive',
      'moveTo',
      'skipMissingFiles',
      'skipForbiddenFiles',
      'skipInconsistentFiles',
      'logFolder',
    ]);
    // #1600 C6d-2 — and a stored Skip forbidden files, which save refuses there.
    expect(hidden({ pathType: 'file', skipForbiddenFiles: true })).not.toContain(
      'skipForbiddenFiles',
    );
    // Typed, then its control moved away: it stays until it is cleared.
    const typed = { ...seedFieldInputs(fields, {}), afterCopy: 'keep', moveTo: 'done' };
    expect(hidden({}, typed)).toEqual([
      'fileListPath',
      'sinkFileName',
      'skipInconsistentFiles',
      'logFolder',
    ]);
  });

  it('draws every field of an entry with no rules', () => {
    const http = getActivity('http_request');
    if (http === undefined) throw new Error('http_request is catalogued');
    const names = fieldsOf(http).map((f) => f.name);
    expect(applicableFieldNames(http, names, fieldsOf(http), {}, {})).toEqual(names);
  });
});

describe('applicableFieldNames on a set of choices (#1600 OR41 C8a)', () => {
  const meta = getActivity('get_metadata');
  if (meta === undefined) throw new Error('get_metadata is catalogued');
  const fields = fieldsOf(meta);
  const all = fields.map((f) => f.name);
  const shown = (config: Record<string, unknown>) =>
    applicableFieldNames(meta, all, fields, seedFieldInputs(fields, config), config);
  const CHILD = ['childFilter', 'childType', 'recursive', 'modifiedStart', 'modifiedEnd'];

  it('draws the child item settings only while Child items is ticked', () => {
    expect(shown({ path: '.', fieldList: ['size', 'exists'] })).toEqual([
      'path',
      'fieldList',
      'waitUntil',
    ]);
    expect(shown({ path: '.', fieldList: ['exists', 'childItems'] })).toEqual([
      'path',
      'fieldList',
      ...CHILD,
      'waitUntil',
    ]);
    // Nothing ticked is known to hold none, not unknown.
    expect(shown({ path: '.' })).toEqual(['path', 'fieldList', 'waitUntil']);
  });

  it('keeps a stored child setting in view so it can be removed', () => {
    expect(shown({ path: '.', fieldList: ['size'], childFilter: '*.csv' })).toEqual([
      'path',
      'fieldList',
      'childFilter',
      'waitUntil',
    ]);
  });

  it('#1600 C8d — draws the timer settings only once Wait until is set, and Minimum size with its choice', () => {
    const base = { path: '.', fieldList: ['size'] };
    expect(shown({ ...base, waitUntil: 'off' })).toEqual(['path', 'fieldList', 'waitUntil']);
    const timer = ['checkEverySeconds', 'giveUpAfterSeconds'];
    expect(shown({ ...base, waitUntil: 'exists' })).toEqual([
      'path',
      'fieldList',
      'waitUntil',
      ...timer,
    ]);
    expect(shown({ ...base, waitUntil: 'minimumSize' })).toEqual([
      'path',
      'fieldList',
      'waitUntil',
      'minimumSize',
      ...timer,
    ]);
  });
});

describe('Get metadata on the bound connection kind (#1600 OR41 C8c)', () => {
  const meta = getActivity('get_metadata');
  if (meta === undefined) throw new Error('get_metadata is catalogued');
  const fields = fieldsOf(meta);
  const all = fields.map((f) => f.name);
  const shown = (config: Record<string, unknown>, kind: string | undefined) =>
    applicableFieldNames(meta, all, fields, seedFieldInputs(fields, config), config, kind);
  const fieldList = fields.find((f) => f.name === 'fieldList');
  if (fieldList === undefined) throw new Error('fieldList is a field');
  const offered = (kind: string | undefined, ticked: string[] = []) =>
    offeredFieldOptions(meta, fieldList, kind, ticked.join('\n'));

  it('draws the path on a file system connection, or while the kind is unknown, and not on a database', () => {
    expect(shown({ fieldList: ['exists'] }, 'fs')).toEqual(['path', 'fieldList', 'waitUntil']);
    expect(shown({ fieldList: ['exists'] }, undefined)).toEqual(['path', 'fieldList', 'waitUntil']);
    // C8d-2b — Wait until on a table too.
    expect(shown({ fieldList: ['exists'] }, 'sqlite')).toEqual(['fieldList', 'waitUntil']);
    expect(shown({ fieldList: ['exists'] }, 'postgres')).toEqual(['fieldList', 'waitUntil']);
    // A path a database node still holds stays in view, so it can be cleared.
    expect(shown({ path: 't', fieldList: ['exists'] }, 'sqlite')).toEqual([
      'path',
      'fieldList',
      'waitUntil',
    ]);
  });

  it("offers the kind's own fields, keeps any already ticked, and every field while the kind is unknown", () => {
    expect(offered('sqlite')).toEqual(['exists', 'structure', 'columnCount', 'rowCount']);
    expect(offered('fs')).toEqual([
      'exists',
      'itemName',
      'itemType',
      'size',
      'created',
      'lastModified',
      'contentMD5',
      'childItems',
      // C8c-2 — a delimited or Excel dataset's columns, on a file system too.
      'structure',
      'columnCount',
    ]);
    expect(offered('postgres', ['size'])).toEqual([
      'exists',
      'size',
      'structure',
      'columnCount',
      'rowCount',
    ]);
    expect(offered(undefined)).toBeUndefined();
    expect(offered('http')).toBeUndefined();
    expect(offeredFieldOptions(meta, { name: 'childType', enumOptions: ['all'] }, 'fs', '')).toBe(
      undefined,
    );
  });

  it('C8d-2b: a table waits until it exists or is not empty; a stored size stays offered', () => {
    const waitUntil = fields.find((f) => f.name === 'waitUntil');
    if (waitUntil === undefined) throw new Error('waitUntil is a field');
    const all = ['off', 'exists', 'nonEmpty', 'minimumSize'];
    for (const kind of ['sqlite', 'postgres']) {
      expect(offeredFieldOptions(meta, waitUntil, kind, 'off')).toEqual([
        'off',
        'exists',
        'nonEmpty',
      ]);
      expect(offeredFieldOptions(meta, waitUntil, kind, 'minimumSize')).toEqual(all);
    }
    expect(offeredFieldOptions(meta, waitUntil, 'fs', 'off')).toEqual(all);
    expect(offeredFieldOptions(meta, waitUntil, undefined, 'off')).toBeUndefined();
  });
});
