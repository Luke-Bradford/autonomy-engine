import { describe, expect, it } from 'vitest';
import { availableRefs } from '../params.js';
import { validatePipelineDoc } from '../validate-pipeline.js';
import type { Container, Edge, Node } from '../../index.js';

/**
 * #1420 (OR26) — a container's children can read what is upstream of the
 * container.
 *
 * A container activates only once its own incoming edges are satisfied
 * (`partitionReadiness` gates it like any top-level entity), and a child
 * dispatches only inside an active container. So everything the CONTAINER is
 * guaranteed is guaranteed to each child too. The static graph used to treat a
 * body child with no internal incoming edge as a ROOT — guaranteed nothing — so
 * the operator's own recipe, a per-file copy path built from
 * `${nodes.list.output.path}` inside a foreach over that listing, was refused
 * at save with "does not name an upstream node".
 */

function node(id: string, over: Partial<Node> = {}): Node {
  return { id, type: 'agent_task', config: {}, position: { x: 0, y: 0 }, ...over };
}
function producer(id: string): Node {
  return node(id, { config: { outputs: [{ name: 'path', type: 'string' }] } });
}
function edge(from: string, to: string, on: Edge['on'] = 'success'): Edge {
  return { id: `${from}->${to}`, from, to, on } as Edge;
}
function reader(id: string, ref: string): Node {
  return node(id, { config: { prompt: `read ${ref}` } });
}

const CONTAINERS: Record<Container['kind'], Omit<Container, 'children'>> = {
  stage: { id: 'box', kind: 'stage' },
  foreach: { id: 'box', kind: 'foreach', items: '${params.list}' },
  loop: { id: 'box', kind: 'loop', exitWhen: '${equals(1, 1)}', maxRounds: 2 },
};

function docWith(
  kind: Container['kind'],
  bodyRef: string,
  extra: { nodes?: Node[]; edges?: Edge[]; innerEdges?: Edge[] } = {},
) {
  return {
    params: [{ name: 'list', type: 'json' as const, required: false, default: [] }],
    variables: [],
    nodes: [producer('src'), reader('body', bodyRef), node('second'), ...(extra.nodes ?? [])],
    edges: [edge('src', 'box'), ...(extra.edges ?? []), ...(extra.innerEdges ?? [])],
    containers: [{ ...CONTAINERS[kind], children: ['body', 'second'] } as Container],
  };
}

describe('#1420 — a container child inherits the container’s upstream', () => {
  for (const kind of ['stage', 'foreach', 'loop'] as const) {
    it(`${kind}: a body root may read a node upstream of the container`, () => {
      expect(validatePipelineDoc(docWith(kind, '${nodes.src.output.path}'))).toEqual([]);
    });

    it(`${kind}: so may a child further down the body`, () => {
      const d = docWith(kind, '${nodes.src.output.path}', {
        innerEdges: [edge('second', 'body')],
      });
      expect(validatePipelineDoc(d)).toEqual([]);
    });

    it(`${kind}: a node NOT upstream of the container is still refused`, () => {
      const d = docWith(kind, '${nodes.side.output.path}', { nodes: [producer('side')] });
      expect(validatePipelineDoc(d).join('\n')).toMatch(/does not name an upstream node/);
    });

    it(`${kind}: a failure-only predecessor of the container is still not guaranteed`, () => {
      const d = docWith(kind, '${nodes.src.output.path}');
      d.edges = [edge('src', 'box', 'failure')];
      expect(validatePipelineDoc(d).join('\n')).toMatch(/not guaranteed here/);
    });

    it(`${kind}: a child cannot read its OWN container's output, even in default()`, () => {
      const d = docWith(kind, "${default(nodes.box.output.results, '')}");
      expect(validatePipelineDoc(d).join('\n')).toMatch(/does not name an upstream node/);
    });
  }

  it('the expression picker offers the upstream output inside the body', () => {
    const d = docWith('foreach', 'x');
    const refs = availableRefs(d, { kind: 'node', nodeId: 'body' }).map((s) => s.ref);
    expect(refs).toContain('nodes.src.output.path');
  });
});
