import { describe, expect, it } from 'vitest';
import { lowerNodeOutputs } from '../lower.js';
import { getActivity } from '../registry.js';
import type { Node } from '../../schemas/pipeline.js';

function node(id: string, type: string, config: Record<string, unknown> = {}): Node {
  return { id, type, config, position: { x: 0, y: 0 } };
}

describe('lowerNodeOutputs', () => {
  it('seeds an absent config.outputs from the catalog for a known activity type', () => {
    const [lowered] = lowerNodeOutputs([node('a', 'http_request')]);
    // http_request declares status/body/headers (registry.ts).
    expect(lowered!.config['outputs']).toEqual([
      { name: 'status', type: 'number' },
      { name: 'body', type: 'string' },
      { name: 'headers', type: 'json' },
    ]);
  });

  it('leaves a node that already DECLARES config.outputs unchanged (author override wins)', () => {
    const declared = [{ name: 'custom', type: 'string' }];
    const [lowered] = lowerNodeOutputs([node('a', 'http_request', { outputs: declared })]);
    expect(lowered!.config['outputs']).toBe(declared);
  });

  it('leaves an explicit empty config.outputs ([]) unchanged — "declares nothing" is NOT absent', () => {
    const [lowered] = lowerNodeOutputs([node('a', 'http_request', { outputs: [] })]);
    expect(lowered!.config['outputs']).toEqual([]);
  });

  it('leaves an unknown activity type absent (no catalog entry to seed from)', () => {
    const n = node('a', 'not_a_real_activity');
    const [lowered] = lowerNodeOutputs([n]);
    expect(lowered!.config['outputs']).toBeUndefined();
    expect(lowered).toBe(n); // unchanged node returned as-is
  });

  it('leaves an uncatalogued call_pipeline node absent', () => {
    // A call_pipeline node carries a `call` config and is not in the catalog, so
    // its outputs come from the child projection, never a catalog default.
    const n: Node = {
      id: 'c',
      type: 'call_pipeline',
      config: {},
      position: { x: 0, y: 0 },
      call: { pipelineVersionId: 'pv_1', params: {} },
    };
    const [lowered] = lowerNodeOutputs([n]);
    expect(lowered!.config['outputs']).toBeUndefined();
    expect(lowered).toBe(n);
  });

  it('leaves a CATALOGUED execute_pipeline call node absent (child projection, not the catalog template)', () => {
    // #4 A9 — `execute_pipeline` IS now catalogued (with `outputs:[]`), so the
    // uncatalogued escape hatch above no longer protects a call node. Lowering
    // MUST still skip it: seeding `outputs:[]` would flip the node's contract from
    // `absent` (stores ALL child outputs) to `declared []` (stores NONE), silently
    // dropping every child output. The skip keys off `node.call`, not the type.
    const n: Node = {
      id: 'c',
      type: 'execute_pipeline',
      config: {},
      position: { x: 0, y: 0 },
      call: { pipelineVersionId: 'pv_1', params: {} },
    };
    const [lowered] = lowerNodeOutputs([n]);
    expect(lowered!.config['outputs']).toBeUndefined();
    expect(lowered).toBe(n);
  });

  it('deep-copies the catalog outputs so the shared registry cannot be mutated via the doc', () => {
    const [lowered] = lowerNodeOutputs([node('a', 'http_request')]);
    const seeded = lowered!.config['outputs'] as Array<{ name: string; type: string }>;
    const registryOutputs = getActivity('http_request')!.outputs;
    // Same contents, but fresh objects — mutating the doc must not reach the registry.
    expect(seeded).toEqual(registryOutputs);
    expect(seeded[0]).not.toBe(registryOutputs[0]);
    seeded[0]!.name = 'MUTATED';
    expect(getActivity('http_request')!.outputs[0]!.name).toBe('status');
  });

  it('seeds a node that is a container (loop/stage) child like any other', () => {
    // `lowerNodeOutputs` takes the FLAT `nodes[]` array and never sees
    // `containers` — a container references its children by id, so a child node
    // is just an ordinary entry here. There is no separate nested-node path:
    // membership is invisible to this helper, so a would-be loop/stage child is
    // seeded exactly like a top-level node.
    const [child] = lowerNodeOutputs([node('loop_child', 'http_request')]);
    expect(child!.config['outputs']).toEqual([
      { name: 'status', type: 'number' },
      { name: 'body', type: 'string' },
      { name: 'headers', type: 'json' },
    ]);
  });

  it('preserves the rest of the node config while seeding outputs', () => {
    const [lowered] = lowerNodeOutputs([node('a', 'http_request', { url: 'https://x' })]);
    expect(lowered!.config['url']).toBe('https://x');
    expect(lowered!.config['outputs']).toBeDefined();
  });
});
