/**
 * #1669 — the editor's WARNINGS for inactive activities (#1600 C0c). Both are
 * docs that save and then fail or skip at run, so they go to the `advisories`
 * sink and never into the returned errors: no gate changes.
 */
import { describe, expect, it } from 'vitest';
import { validatePipelineDoc } from '../validate-pipeline.js';
import type { Container, Edge, Node } from '../../index.js';

const pos = { x: 0, y: 0 };
const doc = (nodes: Node[], edges: Edge[] = [], containers: Container[] = []) => ({
  params: [],
  variables: [],
  nodes,
  edges,
  containers,
});
const off = (n: Node, markAs?: 'success' | 'failure' | 'skipped'): Node => ({
  ...n,
  state: 'inactive',
  ...(markAs !== undefined ? { onInactiveMarkAs: markAs } : {}),
});
const src: Node = {
  id: 'src',
  type: 'agent_task',
  config: { task: 't', outputs: [{ name: 'v', type: 'string' }] },
  position: pos,
};
const reader = (task: string): Node => ({
  id: 'r',
  type: 'agent_task',
  config: { task },
  position: pos,
});
const ok = (from: string, to: string): Edge => ({ id: `${from}-${to}`, from, to, on: 'success' });
const branch = (from: string, to: string, b: string): Edge => ({
  id: `${from}-${to}-${b}`,
  from,
  to,
  on: 'branch',
  branch: b,
});

/** Validate with a sink, asserting the warnings never become errors. */
function warn(d: ReturnType<typeof doc>): string[] {
  const advisories: string[] = [];
  expect(validatePipelineDoc(d, { advisories })).toEqual([]);
  return advisories;
}

describe("a read of an inactive node's output (#1669)", () => {
  it('a bare read warns, names the read, and still saves', () => {
    const w = warn(doc([off(src), reader('${nodes.src.output.v}')], [ok('src', 'r')]));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("nodes.r.config.task: ${nodes.src.output.v} — node 'src' is inactive");
    expect(w[0]).toContain("default()'s first argument");
  });

  it('the same read twice in one field warns once', () => {
    const w = warn(
      doc([off(src), reader('${nodes.src.output.v} and ${nodes.src.output.v}')], [ok('src', 'r')]),
    );
    expect(w).toHaveLength(1);
  });

  it("as default()'s first argument it does not warn", () => {
    expect(
      warn(doc([off(src), reader("${default(nodes.src.output.v, 'fb')}")], [ok('src', 'r')])),
    ).toEqual([]);
  });

  it('the same read from an ACTIVE producer does not warn', () => {
    expect(warn(doc([src, reader('${nodes.src.output.v}')], [ok('src', 'r')]))).toEqual([]);
  });

  it('marked Failed or Skipped it does not warn: the dependent reader is skipped and never reads', () => {
    for (const m of ['failure', 'skipped'] as const) {
      expect(warn(doc([off(src, m), reader('${nodes.src.output.v}')], [ok('src', 'r')]))).toEqual(
        [],
      );
    }
  });

  it('a status read does not warn: an inactive node has a status', () => {
    expect(warn(doc([off(src), reader('${nodes.src.status}')], [ok('src', 'r')]))).toEqual([]);
  });

  it('a read that is already an error is not also a warning', () => {
    // Only a failure edge: `src`'s output is not guaranteed at `r`, so the bare
    // read is refused, and saying it twice would bury the error.
    const advisories: string[] = [];
    const errs = validatePipelineDoc(
      doc(
        [off(src), reader('${nodes.src.output.v}')],
        [{ id: 'e', from: 'src', to: 'r', on: 'failure' }],
      ),
      { advisories },
    );
    expect(errs.length).toBeGreaterThan(0);
    expect(advisories).toEqual([]);
  });

  it("a container's items read warns too", () => {
    const listed: Node = {
      ...src,
      config: { task: 't', outputs: [{ name: 'rows', type: 'json' }] },
    };
    const body: Node = { id: 'body', type: 'agent_task', config: { task: 't' }, position: pos };
    const w = warn(
      doc(
        [off(listed), body],
        [ok('src', 'loop')],
        [
          {
            id: 'loop',
            kind: 'foreach',
            children: ['body'],
            join: 'all',
            items: '${nodes.src.output.rows}',
          },
        ],
      ),
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("node 'src' is inactive");
  });

  it('the sink never changes the errors, of a clean doc or a refused one', () => {
    const clean = doc([off(src), reader('${nodes.src.output.v}')], [ok('src', 'r')]);
    const refused = doc(
      [off(src), reader('${nodes.src.output.v} ${params.nope}')],
      [ok('src', 'r')],
    );
    for (const d of [clean, refused]) {
      const advisories: string[] = [];
      expect(validatePipelineDoc(d, { advisories })).toEqual(validatePipelineDoc(d));
      expect(advisories).toHaveLength(1);
    }
    expect(validatePipelineDoc(refused).length).toBeGreaterThan(0);
  });
});

describe('an inactive if/switch (#1669)', () => {
  const ifNode: Node = {
    id: 'c',
    type: 'if',
    config: { condition: '${true}' },
    position: pos,
  };
  const sw: Node = { id: 'c', type: 'switch', config: { on: '${1}', cases: ['x'] }, position: pos };
  const a: Node = { id: 'a', type: 'agent_task', config: { task: 't' }, position: pos };
  const b: Node = { id: 'b', type: 'agent_task', config: { task: 't' }, position: pos };

  it('an inactive if with branch edges warns once, not once per edge', () => {
    const w = warn(doc([off(ifNode), a, b], [branch('c', 'a', 'true'), branch('c', 'b', 'false')]));
    expect(w).toEqual([
      "node 'c': inactive, so it records no branch and none of its branch edges fires",
    ]);
  });

  it('an inactive switch with a branch edge warns', () => {
    expect(warn(doc([off(sw), a], [branch('c', 'a', 'x')]))).toHaveLength(1);
  });

  it('an ACTIVE if does not warn', () => {
    expect(warn(doc([ifNode, a], [branch('c', 'a', 'true')]))).toEqual([]);
  });

  it('an inactive if with only a success edge does not warn: that edge still fires', () => {
    expect(warn(doc([off(ifNode), a], [ok('c', 'a')]))).toEqual([]);
  });
});
