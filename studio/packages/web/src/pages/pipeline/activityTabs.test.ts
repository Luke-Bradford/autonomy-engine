import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getActivity, type ActivityCatalogEntry } from '@autonomy-studio/shared';
import { applicableFieldNames, nodeTypeTabs } from './activityTabs';
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
      { key: 'sink', label: 'Sink', fields: ['mode'], bindings: ['sinkConnection', 'sinkDataset'] },
      { key: 'mapping', label: 'Mapping', fields: ['mapping'], bindings: [] },
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
  const copyFiles = getActivity('copy_files');
  if (copyFiles === undefined) throw new Error('copy_files is catalogued');
  const fields = fieldsOf(copyFiles);
  const all = fields.map((f) => f.name);
  const hidden = (config: Record<string, unknown>, inputs = seedFieldInputs(fields, config)) =>
    all.filter((n) => !applicableFieldNames(copyFiles, all, fields, inputs, config).includes(n));

  it('reads each control at its schema default while it is empty', () => {
    // Folder, Keep, Preserve: no file list, no move-to, no file name.
    expect(hidden({})).toEqual(['fileListPath', 'moveTo', 'sinkFileName']);
  });

  it('follows the draft as the controls change', () => {
    expect(hidden({ pathType: 'file' })).toEqual([
      'wildcard',
      'fileListPath',
      'recursive',
      'moveTo',
    ]);
    expect(hidden({ pathType: 'list', afterCopy: 'move' })).toEqual([
      'wildcard',
      'recursive',
      'sinkFileName',
    ]);
    // Either condition of File name: one file, or a merge.
    expect(hidden({ copyBehavior: 'merge' })).toEqual(['fileListPath', 'moveTo']);
    const typed = { ...seedFieldInputs(fields, {}), pathType: 'list' };
    expect(hidden({}, typed)).toEqual(['wildcard', 'recursive', 'moveTo', 'sinkFileName']);
  });

  it('draws a field whose control is an expression', () => {
    // No enum control takes one today, but a typed field that does (UI STANDARD
    // rule 4) must not hide what it may yet select.
    const typed = { ...seedFieldInputs(fields, {}), pathType: '${pipeline().parameters.kind}' };
    expect(hidden({}, typed)).toEqual(['moveTo']);
  });

  it('still draws a field that holds a value where it cannot apply', () => {
    // Stored: the schema refuses it, and the author must be able to clear it.
    expect(hidden({ pathType: 'file', wildcard: '*.csv' })).toEqual([
      'fileListPath',
      'recursive',
      'moveTo',
    ]);
    // Typed, then its control moved away: it stays until it is cleared.
    const typed = { ...seedFieldInputs(fields, {}), afterCopy: 'keep', moveTo: 'done' };
    expect(hidden({}, typed)).toEqual(['fileListPath', 'sinkFileName']);
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
    expect(shown({ path: '.', fieldList: ['size', 'exists'] })).toEqual(['path', 'fieldList']);
    expect(shown({ path: '.', fieldList: ['exists', 'childItems'] })).toEqual([
      'path',
      'fieldList',
      ...CHILD,
    ]);
    // Nothing ticked is known to hold none, not unknown.
    expect(shown({ path: '.' })).toEqual(['path', 'fieldList']);
  });

  it('keeps a stored child setting in view so it can be removed', () => {
    expect(shown({ path: '.', fieldList: ['size'], childFilter: '*.csv' })).toEqual([
      'path',
      'fieldList',
      'childFilter',
    ]);
  });
});
