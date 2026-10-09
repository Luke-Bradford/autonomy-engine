import { describe, expect, it } from 'vitest';
import { getActivity } from '@autonomy-studio/shared';
import { nodeTypeTabs } from './activityTabs';
import { deriveConfigFields } from './configForm';
import { issueTarget, tabStatusMark, tabStatuses, type TabStatusInput } from './tabStatus';

function tabsOf(type: string) {
  const entry = getActivity(type);
  if (entry === undefined) throw new Error(`${type} is catalogued`);
  return nodeTypeTabs(entry, deriveConfigFields(entry.configSchema) ?? []);
}

const base = (over: Partial<TabStatusInput>): TabStatusInput => ({
  nodeId: 'n',
  tabs: tabsOf('copy'),
  issues: [],
  applyIssues: [],
  pendingFields: new Set(),
  pendingSlots: new Set(),
  config: {},
  ...over,
});

describe('issueTarget (#1477)', () => {
  it('reads a config field from each location form', () => {
    expect(issueTarget("node 'n': config.url: required", 'n')).toEqual({ field: 'url' });
    expect(issueTarget('nodes.n.config.mapping[2].sink: bad ref', 'n')).toEqual({
      field: 'mapping',
    });
    expect(issueTarget('nodes.n.config.headers.0.value: bad', 'n')).toEqual({ field: 'headers' });
  });

  it('reads the run policy and each binding slot', () => {
    expect(issueTarget("node 'n': policy.secureInput is not supported", 'n')).toEqual({
      policy: true,
    });
    expect(issueTarget('nodes.n.connectionIds.sink: unknown function', 'n')).toEqual({
      slot: 'sinkConnection',
    });
    expect(issueTarget('nodes.n.datasetIds.source: bad', 'n')).toEqual({ slot: 'sourceDataset' });
    expect(issueTarget('node.n: datasetParams.sink need datasetIds', 'n')).toEqual({
      slot: 'sinkDataset',
    });
    expect(issueTarget('node.n: connectionParams need a connectionId', 'n')).toEqual({
      slot: 'connection',
    });
    expect(issueTarget('nodes.n.connectionId: bad', 'n')).toEqual({ slot: 'connection' });
  });

  it('names nothing for a message about the node as a whole, or another node', () => {
    expect(issueTarget("node 'n': type: unknown activity type 'x'", 'n')).toBeUndefined();
    expect(issueTarget("node 'n' (set_variable) reads variable 'v'", 'n')).toBeUndefined();
    expect(issueTarget("node 'other': config.url: required", 'n')).toBeUndefined();
    // An id that merely STARTS with this node's id is another node.
    expect(issueTarget('nodes.n2.config.url: bad', 'n')).toBeUndefined();
  });

  it('keeps a dotted node id whole', () => {
    expect(issueTarget('nodes.a.b.config.url: bad', 'a.b')).toEqual({ field: 'url' });
  });
});

describe('tabStatuses (#1477)', () => {
  it('counts an issue on the tab that holds its field or binding, and policy on General', () => {
    const statuses = tabStatuses(
      base({
        issues: [
          "node 'n': config.mode: bad",
          'nodes.n.connectionIds.sink: bad',
          "node 'n': config.mapping: required",
          "node 'n': policy.secureOutput is not supported",
          "node 'n': type: whole-node issue",
        ],
      }),
    );
    expect(statuses.get('sink')?.problems).toBe(2);
    expect(statuses.get('mapping')?.problems).toBe(1);
    expect(statuses.get('general')?.problems).toBe(1);
    expect(statuses.has('source')).toBe(false);
  });

  it("counts a refused Apply's issues on their tabs", () => {
    const statuses = tabStatuses(base({ applyIssues: [['mapping', 0, 'sink'], []] }));
    expect(statuses.get('mapping')?.problems).toBe(1);
    expect([...statuses.keys()]).toEqual(['mapping']);
  });

  it('marks the tab holding an unapplied field or a half-picked binding as pending', () => {
    const statuses = tabStatuses(
      base({ pendingFields: new Set(['mode']), pendingSlots: new Set(['sourceConnection']) }),
    );
    expect(statuses.get('sink')?.pending).toBe(true);
    expect(statuses.get('source')?.pending).toBe(true);
    expect(statuses.has('mapping')).toBe(false);
  });

  it('is complete only when every required field on the tab holds a value', () => {
    const http = tabsOf('http_request');
    const request = http.find((t) => t.fields.some((f) => !f.optional));
    if (request === undefined) throw new Error('http_request has a required field');
    const required = request.fields.filter((f) => !f.optional).map((f) => f.name);

    const empty = tabStatuses(base({ tabs: http, config: {} }));
    expect(empty.get(request.key)?.complete).toBeUndefined();

    const config = Object.fromEntries(required.map((name) => [name, 'x']));
    expect(tabStatuses(base({ tabs: http, config })).get(request.key)?.complete).toBe(true);

    const blank = { ...config, [required[0]!]: '  ' };
    expect(tabStatuses(base({ tabs: http, config: blank })).has(request.key)).toBe(false);

    const pending = tabStatuses(
      base({ tabs: http, config, pendingFields: new Set([required[0]!]) }),
    );
    expect(pending.get(request.key)).toEqual({ problems: 0, pending: true, complete: false });
  });

  it('never calls a tab of bindings alone complete', () => {
    const statuses = tabStatuses(base({ config: {} }));
    expect(statuses.has('source')).toBe(false);
  });
});

describe('tabStatusMark (#1477)', () => {
  it('shows what to act on next: problems, then pending, then complete', () => {
    expect(tabStatusMark({ problems: 2, pending: true, complete: false })).toEqual({
      glyph: '⚠ 2',
      tone: 'error',
      description: '2 problems, unapplied changes',
    });
    expect(tabStatusMark({ problems: 1, pending: false, complete: false })?.description).toBe(
      '1 problem',
    );
    expect(tabStatusMark({ problems: 0, pending: true, complete: false })?.glyph).toBe('•');
    expect(tabStatusMark({ problems: 0, pending: false, complete: true })?.glyph).toBe('✓');
    expect(tabStatusMark(undefined)).toBeUndefined();
  });
});
