import { describe, expect, it } from 'vitest';
import { getActivity } from '@autonomy-studio/shared';
import { nodeTypeTabs } from './activityTabs';
import { deriveConfigFields } from './configForm';
import {
  issueTarget,
  refusalLead,
  tabStatusMark,
  tabStatuses,
  type TabStatusInput,
} from './tabStatus';

function tabsOf(type: string) {
  const entry = getActivity(type);
  if (entry === undefined) throw new Error(`${type} is catalogued`);
  return nodeTypeTabs(entry, deriveConfigFields(entry.configSchema) ?? []);
}

const baseInput = (over: Partial<TabStatusInput>): TabStatusInput => ({
  nodeId: 'n',
  tabs: tabsOf('copy'),
  issues: [],
  applyIssues: [],
  pendingFields: new Set(),
  pendingSlots: new Set(),
  config: {},
  boundSlots: new Set(),
  ...over,
});

describe('issueTarget (#1477)', () => {
  it('reads a config field from each location form', () => {
    expect(issueTarget("node 'n': config.url: required", 'n')).toEqual({ field: 'url' });
    expect(issueTarget('nodes.n.config.mapping[2].sink: bad ref', 'n')).toEqual({
      field: 'mapping',
    });
    expect(issueTarget('nodes.n.config.headers.0.value: bad', 'n')).toEqual({ field: 'headers' });
    // Per-activity checks name the field with no `config.` (params.ts).
    expect(issueTarget('node.n.condition: must be a boolean', 'n')).toEqual({ field: 'condition' });
    expect(issueTarget('node.n.mapping[2].sink: unknown column', 'n')).toEqual({
      field: 'mapping',
    });
    expect(issueTarget('node.n: prompt: required', 'n')).toEqual({ field: 'prompt' });
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

  it('names nothing for a message about another node, or with no location to read', () => {
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
      baseInput({
        issues: [
          "node 'n': config.mode: bad",
          'nodes.n.connectionIds.sink: bad',
          "node 'n': config.mapping: required",
          "node 'n': policy.secureOutput is not supported",
        ],
      }),
    );
    expect(statuses.get('sink')?.problems).toBe(2);
    expect(statuses.get('mapping')?.problems).toBe(1);
    expect(statuses.get('general')?.problems).toBe(1);
    expect(statuses.has('source')).toBe(false);
  });

  it("counts a refused Apply's issues on their tabs", () => {
    const statuses = tabStatuses(baseInput({ applyIssues: [['mapping', 0, 'sink'], []] }));
    expect(statuses.get('mapping')?.problems).toBe(1);
    expect([...statuses.keys()]).toEqual(['mapping']);
  });

  it("names the tabs a refused Apply's issues are on, unless that is only the open one", () => {
    const tabs = tabsOf('copy');
    expect(refusalLead(tabs, [['mapping', 0], ['mode']], 'source')).toBe('On Sink, Mapping: ');
    expect(refusalLead(tabs, [['mapping', 0]], 'mapping')).toBe('');
    expect(refusalLead(tabs, [['mapping', 0], ['mode']], 'mapping')).toBe('On Sink, Mapping: ');
    expect(refusalLead(tabs, [[]], 'source')).toBe('');
  });

  it('marks the tab holding an unapplied field or a half-picked binding as pending', () => {
    const statuses = tabStatuses(
      baseInput({ pendingFields: new Set(['mode']), pendingSlots: new Set(['sourceConnection']) }),
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
    const base = (over: Partial<TabStatusInput>) =>
      baseInput({ boundSlots: new Set(request.bindings), ...over });

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

  it('calls a tab of bindings complete only once each is bound', () => {
    expect(tabStatuses(baseInput({})).has('source')).toBe(false);
    const half = tabStatuses(baseInput({ boundSlots: new Set(['sourceConnection']) }));
    expect(half.has('source')).toBe(false);
    const both = tabStatuses(
      baseInput({ boundSlots: new Set(['sourceConnection', 'sourceDataset']) }),
    );
    expect(both.get('source')).toEqual({ problems: 0, pending: false, complete: true });
  });

  it('withholds every ✓ while an issue sits on no tab', () => {
    const bound = new Set(['sourceConnection', 'sourceDataset'] as const);
    for (const issue of [
      "node 'n': type: unknown activity type 'x'",
      "node 'n': config.outputs is malformed",
      "node 'n' (set_variable) reads variable 'v', which it writes",
    ]) {
      expect(tabStatuses(baseInput({ boundSlots: bound, issues: [issue] })).has('source')).toBe(
        false,
      );
    }
    // ...and a refused Apply with no path is such an issue too.
    expect(tabStatuses(baseInput({ boundSlots: bound, applyIssues: [[]] })).has('source')).toBe(
      false,
    );
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
