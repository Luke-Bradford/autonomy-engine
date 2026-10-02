import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Node } from '../../schemas/pipeline.js';
import type { ActivityCatalog, ActivityCatalogEntry } from '../../catalog/types.js';
import { catalog } from '../../catalog/registry.js';
import { activityNodeErrors } from '../activity-config-check.js';
import { validatePipelineDoc } from '../validate-pipeline.js';

// #1480 — the save-time half of the dispatch-time config parse: a version that
// saves must be one the adapter will accept, so the two read ONE schema.

function node(type: string, config: Record<string, unknown>, extra: Partial<Node> = {}): Node {
  return { id: 'n1', type, config, ...extra } as Node;
}

const goodCopy = {
  mapping: [{ source: 'a', sink: 'a', type: 'string' }],
};

describe('activityNodeErrors (#1480)', () => {
  it('refuses an unknown activity type and names the closest catalog types', () => {
    const errors = activityNodeErrors(node('sql_execute', {}));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^node 'n1': type: unknown activity type 'sql_execute'/);
    expect(errors[0]).toMatch(/closest: /);
  });

  it('suggests the near-miss first', () => {
    const [error] = activityNodeErrors(node('file_reed', { path: 'a.txt' }));
    expect(error).toMatch(/closest: file_read\b/);
  });

  it('skips a structural call node, whose type the engine never dispatches on', () => {
    const call = { pipelineVersionId: 'pv_x' };
    expect(activityNodeErrors(node('call_pipeline', {}, { call } as Partial<Node>))).toEqual([]);
  });

  it('refuses a bad enum literal with the field path', () => {
    const errors = activityNodeErrors(node('copy', { ...goodCopy, mode: 'truncate' }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^node 'n1': config\.mode: /);
  });

  it('refuses a bad literal type with the field path', () => {
    const errors = activityNodeErrors(node('file_read', { path: 42 }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^node 'n1': config\.path: /);
  });

  it('refuses a missing required field', () => {
    // Named as what to do about it, not as Zod's "received undefined".
    expect(activityNodeErrors(node('http_request', {}))).toEqual([
      "node 'n1': config.url: required",
    ]);
  });

  it('accepts a `${}` expression where a literal of another type is expected', () => {
    expect(activityNodeErrors(node('copy', { ...goodCopy, mode: '${params.mode}' }))).toEqual([]);
    expect(activityNodeErrors(node('file_read', { path: '${params.p}' }))).toEqual([]);
    // An interpolated string resolves to a string too, so an enum cannot judge it.
    expect(activityNodeErrors(node('copy', { ...goodCopy, mode: 'app${params.x}' }))).toEqual([]);
  });

  it('accepts a whole subtree supplied by one expression', () => {
    expect(activityNodeErrors(node('copy', { mapping: '${params.mapping}' }))).toEqual([]);
  });

  it('still refuses an escaped `$${` literal, which reaches the adapter as text', () => {
    const errors = activityNodeErrors(node('copy', { ...goodCopy, mode: '$${x}' }));
    expect(errors).toHaveLength(1);
  });

  it('accepts a secret marker in a declared sink', () => {
    const config = { url: 'https://x', secretHeaders: { Authorization: { $secret: 'tok' } } };
    expect(activityNodeErrors(node('http_request', config))).toEqual([]);
  });

  it('accepts the lowered `config.outputs` contract every saved node carries', () => {
    const config = { path: 'a.txt', outputs: [{ name: 'text', type: 'string' }] };
    expect(activityNodeErrors(node('file_read', config))).toEqual([]);
  });

  it('keeps an object-level refinement unless a whole-value expression could change it', () => {
    // prompt XOR messages: an interpolated prompt is still a string, so the
    // refinement still judges presence correctly and must still refuse.
    const both = { prompt: 'hi ${params.x}', messages: [{ role: 'user', content: 'x' }] };
    expect(activityNodeErrors(node('llm_call', both)).length).toBeGreaterThan(0);
    // A whole-value expression may resolve to anything, so the refinement is
    // left to dispatch.
    const opaque = { prompt: 'hi', messages: '${params.history}' };
    expect(activityNodeErrors(node('llm_call', opaque))).toEqual([]);
  });

  it('checks against an injected catalog, the one the executor dispatches with', () => {
    const entry = {
      type: 'test_activity',
      dispatchConfigSchema: z.object({ n: z.number() }),
    } as unknown as ActivityCatalogEntry;
    const injected: ActivityCatalog = new Map([['test_activity', entry]]);
    expect(activityNodeErrors(node('test_activity', { n: 1 }), injected)).toEqual([]);
    expect(activityNodeErrors(node('test_activity', { n: 'x' }), injected)).toHaveLength(1);
    expect(activityNodeErrors(node('copy', goodCopy), injected)[0]).toMatch(/unknown activity/);
  });

  it('validates every dispatched activity with the schema its adapter parses', () => {
    // An executor-dispatched entry (it names connection kinds) with no
    // dispatch schema would be a type that saves anything — `lookup` alone is
    // deliberate (it has no config).
    const unchecked = [...catalog.values()]
      .filter((e) => e.kind !== 'control' && e.dispatchConfigSchema === undefined)
      .map((e) => e.type);
    expect(unchecked).toEqual(['lookup']);
  });
});

describe('validatePipelineDoc carries the check (#1480)', () => {
  it('refuses the operator-demo configs', () => {
    const doc = {
      params: [],
      edges: [],
      variables: [],
      containers: [],
      nodes: [
        node('sql_execute', {}),
        { ...node('copy', { ...goodCopy, mode: 'truncate' }), id: 'c' },
      ],
    };
    const issues = validatePipelineDoc(doc);
    expect(issues.some((i) => i.startsWith("node 'n1': type: unknown activity type"))).toBe(true);
    expect(issues.some((i) => i.startsWith("node 'c': config.mode: "))).toBe(true);
  });
});
