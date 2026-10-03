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

  it('compares only a bounded prefix of an oversized type for the hint', () => {
    // The first 64 characters are nearest `file_read`; the WHOLE string, whose
    // tail repeats `execute_pipeline`, is nearer that. So the hint names
    // `file_read` only when the compare is capped — uncapped, one 1 MB type
    // cost ~0.5 s of CPU at save.
    const type = 'file_read' + 'x'.repeat(55) + 'execute_pipeline'.repeat(10);
    expect(activityNodeErrors(node(type, {}))[0]).toMatch(/\(closest: file_read, /);
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
    // A whole-value expression may resolve to anything, so the non-system rule
    // on `messages` is left to dispatch.
    const opaque = { messages: '${params.history}' };
    expect(activityNodeErrors(node('llm_call', opaque))).toEqual([]);
    const opaqueRole = { messages: [{ role: '${params.role}', content: 'x' }] };
    expect(activityNodeErrors(node('llm_call', opaqueRole))).toEqual([]);
  });

  it('judges prompt XOR messages by presence, which no expression changes (#1491)', () => {
    // A whole-value expression never resolves to `undefined` (substitution
    // throws or yields a value), so a present key stays present and an absent
    // one absent: an expression ELSEWHERE in the config cannot decide the rule.
    const neither = { model: '${params.m}' };
    expect(activityNodeErrors(node('llm_call', neither))).toEqual([
      "node 'n1': config.prompt: llm_call requires exactly one of `prompt` or `messages`",
    ]);
    const both = {
      prompt: 'p',
      messages: [{ role: 'user', content: 'x' }],
      system: '${params.m}',
    };
    expect(activityNodeErrors(node('llm_call', both))).toEqual([
      "node 'n1': config.prompt: llm_call requires exactly one of `prompt` or `messages`",
    ]);
    // Nor does a whole-value `prompt` itself: it resolves to SOME value, so
    // the key is still present at dispatch.
    const wholePrompt = { prompt: '${params.p}', messages: [{ role: 'user', content: 'x' }] };
    expect(activityNodeErrors(node('llm_call', wholePrompt))).toEqual([
      "node 'n1': config.prompt: llm_call requires exactly one of `prompt` or `messages`",
    ]);
  });

  it('scopes the non-system rule to `messages`, not the whole config (#1491)', () => {
    const systemOnly = {
      messages: [{ role: 'system', content: 'x' }],
      model: '${params.m}',
    };
    expect(activityNodeErrors(node('llm_call', systemOnly))).toEqual([
      "node 'n1': config.messages: llm_call `messages` must contain at least one non-system (user/assistant) message",
    ]);
  });

  it('does not overflow the stack on a hostile nesting under a refinement issue', () => {
    // A root-level refinement's drop decision walks the whole config: past
    // MAX_CONFIG_DEPTH it stops rather than throw out of the save gate as a
    // 500, and a whole-value expression buried past the bound does not wave
    // the refinement through — the issue stands.
    const entry: ActivityCatalogEntry = {
      ...catalog.get('file_read')!,
      type: 'test_activity',
      dispatchConfigSchema: z
        .object({ n: z.number(), extra: z.unknown() })
        .refine((c) => c.n > 0, { message: 'n must be positive' }),
    };
    const injected: ActivityCatalog = new Map([['test_activity', entry]]);
    let deep: unknown = '${params.x}';
    for (let i = 0; i < 20_000; i += 1) deep = [deep];
    expect(activityNodeErrors(node('test_activity', { n: 0, extra: deep }), injected)).toEqual([
      "node 'n1': config: n must be positive",
    ]);
    // Within the bound, the same whole-value expression does drop it.
    const shallow = { n: 0, extra: ['${params.x}'] };
    expect(activityNodeErrors(node('test_activity', shallow), injected)).toEqual([]);
  });

  it('checks against an injected catalog, the one the executor dispatches with', () => {
    // A complete entry (a real one, re-keyed), so no cast hides a missing field.
    const entry: ActivityCatalogEntry = {
      ...catalog.get('file_read')!,
      type: 'test_activity',
      dispatchConfigSchema: z.object({ n: z.number() }),
    };
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
