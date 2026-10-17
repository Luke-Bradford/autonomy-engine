/**
 * #1736 — a read of a Get metadata field output the node does not tick. The
 * output contract is fixed (every field optional), so the read saves and
 * resolves to null at run, where ADF fails the reference. A warning, through
 * the `advisories` sink (#1669), never an error.
 */
import { describe, expect, it } from 'vitest';
import { validatePipelineDoc } from '../validate-pipeline.js';
import type { Edge, Node } from '../../index.js';

const pos = { x: 0, y: 0 };
const meta = (fieldList: string[]): Node => ({
  id: 'meta',
  type: 'get_metadata',
  connectionId: 'conn_fs',
  config: { path: 'in', fieldList },
  position: pos,
});
const reader = (task: string): Node => ({
  id: 'r',
  type: 'agent_task',
  config: { task },
  position: pos,
});
const edges: Edge[] = [{ id: 'e', from: 'meta', to: 'r', on: 'success' }];

function warn(nodes: Node[], es: Edge[] = edges): string[] {
  const advisories: string[] = [];
  expect(
    validatePipelineDoc(
      { params: [], variables: [], nodes, edges: es, containers: [] },
      { advisories },
    ),
  ).toEqual([]);
  return advisories;
}

describe('a read of an unticked Get metadata field (#1736)', () => {
  it('warns, names the field by its title, and still saves', () => {
    const w = warn([meta(['exists']), reader('${nodes.meta.output.size}')]);
    expect(w).toEqual([
      "nodes.r.config.task: ${nodes.meta.output.size} — node 'meta' does not tick Size in " +
        "its Field list, so this reads null; tick it, or make it default()'s first argument",
    ]);
  });

  it('a ticked field does not warn', () => {
    expect(warn([meta(['exists', 'size']), reader('${nodes.meta.output.size}')])).toEqual([]);
  });

  it("as default()'s first argument it does not warn: default() takes the fallback on null", () => {
    expect(warn([meta(['exists']), reader('${default(nodes.meta.output.size, 0)}')])).toEqual([]);
  });

  it('path is always filled, so reading it does not warn', () => {
    expect(warn([meta(['exists']), reader('${nodes.meta.output.path}')])).toEqual([]);
  });

  it('the same read twice in one field warns once', () => {
    const w = warn([
      meta(['exists']),
      reader('${nodes.meta.output.size} / ${nodes.meta.output.size}'),
    ]);
    expect(w).toHaveLength(1);
  });

  it('an inactive node says only that it is inactive', () => {
    const w = warn([
      { ...meta(['exists']), state: 'inactive' },
      reader('${nodes.meta.output.size}'),
    ]);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("node 'meta' is inactive");
  });

  it('a read that is already an error is not also a warning', () => {
    const advisories: string[] = [];
    const errs = validatePipelineDoc(
      {
        params: [],
        variables: [],
        nodes: [meta(['exists']), reader('${nodes.meta.output.size}')],
        containers: [],
        edges: [{ id: 'e', from: 'meta', to: 'r', on: 'failure' }],
      },
      { advisories },
    );
    expect(errs.join('\n')).toContain('is not guaranteed here');
    expect(advisories).toEqual([]);
  });

  it('without a sink nothing is collected and nothing changes', () => {
    expect(
      validatePipelineDoc({
        params: [],
        variables: [],
        nodes: [meta(['exists']), reader('${nodes.meta.output.size}')],
        edges,
        containers: [],
      }),
    ).toEqual([]);
  });
});
