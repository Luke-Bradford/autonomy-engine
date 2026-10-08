import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getActivity, type ActivityCatalogEntry } from '@autonomy-studio/shared';
import { nodeTypeTabs } from './activityTabs';
import { deriveConfigFields } from './configForm';

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
