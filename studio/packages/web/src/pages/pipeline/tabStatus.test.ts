import { describe, expect, it } from 'vitest';
import { getActivity, validateDoc, type Node } from '@autonomy-studio/shared';
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
      general: true,
    });
    // #1600 C0b — the description sits on General too, above the run policy.
    expect(issueTarget("node 'n': description: the description can be at most 4000", 'n')).toEqual({
      general: true,
    });
    // #1600 C0d — and the user properties below it, by row or as a whole.
    expect(
      issueTarget("node 'n': userProperties[0].name: a user property needs a name", 'n'),
    ).toEqual({ general: true });
    expect(
      issueTarget('nodes.n.userProperties[1].value: ${params.x} is not a declared param', 'n'),
    ).toEqual({ general: true });
    // #1600 OR41 C6c-1a — the log end, from the ref scan and the save check.
    expect(issueTarget('nodes.n.connectionIds.log: unknown function', 'n')).toEqual({
      slot: 'logConnection',
    });
    expect(
      issueTarget(
        "node 'n': connectionIds.log: the log connection is only used when the session log is written to a folder",
        'n',
      ),
    ).toEqual({ slot: 'logConnection' });
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

  it("reads the variable guard's quoted field, and never a prose word as a field", () => {
    expect(
      issueTarget("node 'n' (set_variable): 'variable' must be a literal variable name", 'n'),
    ).toEqual({ field: 'variable' });
    expect(issueTarget('node.n: a wait needs a non-empty ${} seconds expression', 'n')).toBe(
      undefined,
    );
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

  it('#1600 C1q-b — puts every inline-source issue validateDoc raises on the Source dataset slot', () => {
    // The validator's own messages, not copies of them: a reworded message that
    // stops reaching the Source tab fails here.
    const copy = (id: string, extra: Partial<Node>): Node => ({
      id,
      type: 'copy',
      config: { mapping: [{ source: 'id', sink: 'id', type: 'integer' }], mode: 'append' },
      connectionIds: { source: 'c1', sink: 'c2' },
      position: { x: 0, y: 0 },
      ...extra,
    });
    const nodes: Node[] = [
      // not valid (an empty table name), and named beside a saved source
      copy('a', {
        datasetIds: { source: 'd1', sink: 'd2' },
        inlineDatasets: { source: { kind: 'table', config: { table: '' } } },
      }),
      // `${` in the SQL
      copy('b', {
        datasetIds: { sink: 'd2' },
        inlineDatasets: {
          source: {
            kind: 'query',
            config: { sql: 'SELECT ${params.x}' },
          },
        },
      }),
      // a sink alone
      copy('c', { datasetIds: { sink: 'd2' } }),
    ];
    const issues = validateDoc({ params: [], nodes, edges: [], containers: [], variables: [] });
    for (const id of ['a', 'b', 'c']) {
      const own = issues.filter((m) => issueTarget(m, id) !== undefined);
      expect(own.length, `issues for ${id}: ${issues.join(' | ')}`).toBeGreaterThan(0);
      for (const m of own) expect(issueTarget(m, id), m).toEqual({ slot: 'sourceDataset' });
    }
    expect(issues.filter((m) => /^node\.a: /.test(m))).toHaveLength(2);
    // A parameter value's expression issue is reported on its config path.
    expect(
      issueTarget("nodes.b.inlineDatasets.source.config.parameters.p: unknown param 'nope'", 'b'),
    ).toEqual({
      slot: 'sourceDataset',
    });
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
          "node 'n': description: the description can be at most 4000 characters",
        ],
      }),
    );
    expect(statuses.get('sink')?.problems).toBe(2);
    expect(statuses.get('mapping')?.problems).toBe(1);
    expect(statuses.get('general')?.problems).toBe(2);
    expect(statuses.has('source')).toBe(false);
  });

  it("counts a refused Apply's issues on their tabs", () => {
    const statuses = tabStatuses(baseInput({ applyIssues: [['mapping', 0, 'sink'], []] }));
    expect(statuses.get('mapping')?.problems).toBe(1);
    expect([...statuses.keys()]).toEqual(['mapping']);
  });

  it('counts a field the validator and a refused Apply both name once', () => {
    const statuses = tabStatuses(
      baseInput({ issues: ["node 'n': config.mapping: required"], applyIssues: [['mapping']] }),
    );
    expect(statuses.get('mapping')?.problems).toBe(1);
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
    // The ✓ describes the APPLIED node, so an edit on top of it keeps it.
    expect(pending.get(request.key)).toEqual({ problems: 0, pending: true, complete: true });
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
  it('puts problems or complete after the label, with the pending dot beside either', () => {
    expect(tabStatusMark({ problems: 2, pending: true, complete: false })).toEqual({
      mark: { glyph: '⚠ 2', tone: 'error' },
      pending: true,
      description: '2 problems, unapplied changes',
    });
    expect(tabStatusMark({ problems: 1, pending: false, complete: false })?.description).toBe(
      '1 problem',
    );
    expect(tabStatusMark({ problems: 0, pending: true, complete: false })).toEqual({
      pending: true,
      description: 'Unapplied changes',
    });
    expect(tabStatusMark({ problems: 0, pending: true, complete: true })).toEqual({
      mark: { glyph: '✓', tone: 'complete' },
      pending: true,
      description: 'Complete, unapplied changes',
    });
    expect(tabStatusMark(undefined)).toBeUndefined();
  });
});
