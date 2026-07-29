import { describe, expect, it } from 'vitest';
import {
  PipelineVersionSchema,
  type Container,
  type Edge,
  type EdgeOn,
  type Node,
  type PipelineVersion,
} from '@autonomy-studio/shared';
import { PipelineVersionWriteSchema } from '../../api/pipelines';
import { canSave, pruneContainerChild, toVersionBody, validateCanvas } from './canvasDoc';

function node(id: string, config: Record<string, unknown> = {}): Node {
  return { id, type: 'http_request', config, position: { x: 0, y: 0 } };
}

function edge(id: string, from: string, to: string, on: EdgeOn = 'success'): Edge {
  return { id, from, to, on };
}

const loaded: PipelineVersion = PipelineVersionSchema.parse({
  id: 'plv_1',
  resourceId: 'res_plv1',
  pipelineId: 'pl_1',
  version: 2,
  params: [{ name: 'topic', type: 'string', required: true }],
  outputs: [{ name: 'result', type: 'string' }],
  nodes: [],
  edges: [],
  containers: [{ id: 'c1', kind: 'stage', children: [] }],
  catalogVersion: 1,
  createdAt: 1,
});

describe('toVersionBody', () => {
  // #485 — `toVersionBody` is the one HAND-LISTED PipelineVersion builder (the
  // import path spreads). Every `.default()` field is optional in the wire body
  // (`z.input`), so a future carry-forward field could be dropped here silently,
  // exactly as `containers` was on import. Beyond the per-field value checks,
  // this asserts the builder COVERS every field the wire body carries — minus
  // the ones it deliberately does not send — so a new field added to the schema
  // fails HERE until it is either carried or explicitly declared an omission.
  it('carries EVERY carry-forward field from the loaded version — a class guard (#485)', () => {
    const nodes = [node('a'), node('b')];
    const edges = [edge('e', 'a', 'b')];
    const body = toVersionBody(loaded, nodes, edges, loaded.containers);

    // The distinctive values survive (containers is non-empty here, so a
    // drop-to-`[]` default would be visible, not masked).
    expect(body.params).toEqual(loaded.params);
    expect(body.outputs).toEqual(loaded.outputs);
    expect(body.containers).toEqual(loaded.containers);
    expect(body.nodes).toEqual(nodes);
    expect(body.edges).toEqual(edges);

    // CLASS coverage. `catalogVersion` is the ONLY field `toVersionBody` omits
    // on purpose — the server re-stamps the current catalog on save (asserted by
    // the 'omits catalogVersion' test below). `pipelineId` is already absent from
    // `PipelineVersionWriteSchema`. Any OTHER schema field missing from the body
    // is the #485 defect.
    const DELIBERATELY_OMITTED = ['catalogVersion'];
    const carried = new Set(Object.keys(body));
    const missing = Object.keys(PipelineVersionWriteSchema.shape).filter(
      (key) => !DELIBERATELY_OMITTED.includes(key) && !carried.has(key),
    );
    expect(missing).toEqual([]);
  });

  it('omits catalogVersion so the server stamps the current one on save', () => {
    const body = toVersionBody(loaded, [], [], []);
    expect(body).not.toHaveProperty('catalogVersion');
  });

  it('first-run (no loaded version) yields empty params/outputs', () => {
    const body = toVersionBody(null, [node('a')], [], []);
    expect(body.params).toEqual([]);
    expect(body.outputs).toEqual([]);
    expect(body.containers).toEqual([]);
    expect(body.nodes).toHaveLength(1);
  });

  /**
   * #746 — containers come from the CANVAS, never from `loaded`.
   *
   * The bug was exactly this line reading `loaded?.containers`: the operator
   * could delete an enclosed activity and the save body still listed it as a
   * child, because membership was carried forward from the version the canvas
   * was opened on rather than taken from the graph on screen. `loaded` here is
   * deliberately non-empty and DIFFERENT from the argument, so a regression to
   * the carry-forward is red rather than masked by two equal values.
   */
  it('carries the CANVAS containers, not the loaded version (#746)', () => {
    const body = toVersionBody(loaded, [], [], []);
    expect(loaded.containers).toHaveLength(1); // the carry-forward source is not empty
    expect(body.containers).toEqual([]);
  });

  it('produces a body that parses cleanly through the shared write schema', () => {
    const body = toVersionBody(loaded, [node('a'), node('b')], [edge('e', 'a', 'b')], []);
    expect(() => PipelineVersionWriteSchema.parse(body)).not.toThrow();
  });
});

describe('pruneContainerChild (#746)', () => {
  const stage = (id: string, children: string[]): Container => ({ id, kind: 'stage', children });

  it('removes the id from every container that lists it', () => {
    const before = [stage('c1', ['a', 'b']), stage('c2', ['a'])];
    expect(pruneContainerChild(before, 'a').map((c) => c.children)).toEqual([['b'], []]);
  });

  /**
   * COPY-ON-WRITE at both levels — asserted by identity, because deep equality
   * cannot tell a preserved reference from an equal copy, and the reference is
   * the whole point: `FlowCanvas` memoises the boxes on this array and
   * `PipelineCanvas` compares it to detect a concurrent edit.
   */
  it('returns unlisted containers, and the whole array, BY REFERENCE', () => {
    const untouched = stage('c2', ['b']);
    const before = [stage('c1', ['a']), untouched];
    expect(pruneContainerChild(before, 'a')[1]).toBe(untouched);
    expect(pruneContainerChild(before, 'zzz')).toBe(before);
  });

  it('keeps a container that loses its last child, rather than dropping it', () => {
    expect(pruneContainerChild([stage('c1', ['a'])], 'a')).toEqual([stage('c1', [])]);
  });

  /**
   * Prunes ONE id, never "every child that is not a node". A general normalise
   * would silently repair legacy phantoms in a doc the operator never touched,
   * hiding a real defect report about a doc that arrived broken.
   */
  it('leaves OTHER phantom children alone', () => {
    expect(pruneContainerChild([stage('c1', ['a', 'ghost'])], 'a')[0]!.children).toEqual(['ghost']);
  });
});

describe('validateCanvas', () => {
  it('a valid two-node success chain has no issues', () => {
    const nodes = [node('a'), node('b')];
    const edges = [edge('e', 'a', 'b')];
    expect(validateCanvas(nodes, edges, [], [])).toEqual([]);
  });

  it('an empty doc has no issues', () => {
    expect(validateCanvas([], [], [], [])).toEqual([]);
  });

  it('surfaces a validateRefs error — a config ref to a non-existent node output', () => {
    // `a` references the output of a node that does not exist: validateRefs
    // rejects the ref ("does not name an upstream node").
    const nodes = [node('a', { url: '${nodes.ghost.output.body}' })];
    const issues = validateCanvas(nodes, [], [], []);
    expect(issues.length).toBeGreaterThan(0);
  });

  it('surfaces a validateDoc error — a forward cycle is refused', () => {
    const nodes = [node('a'), node('b')];
    const edges = [edge('e1', 'a', 'b'), edge('e2', 'b', 'a')];
    const issues = validateCanvas(nodes, edges, [], []);
    expect(issues.length).toBeGreaterThan(0);
  });
});

/**
 * #444. Save is now gated on `issues` because the SERVER refuses an invalid
 * doc — the badge used to say "you can still save", which stopped being true.
 * The predicate is extracted here (rather than asserted through a render) so it
 * is testable without mounting ReactFlow in jsdom; the rendered result is
 * covered by the browser-verify gate.
 */
describe('canSave (#444)', () => {
  const OK = { saving: false, ready: true, issues: [] as string[] };

  it('allows a save when the doc is valid and the canvas is ready', () => {
    expect(canSave(OK)).toBe(true);
  });

  it('REFUSES a save while the doc has issues — the server would 400 it anyway', () => {
    expect(canSave({ ...OK, issues: ['forward cycle detected involving {a, b}'] })).toBe(false);
  });

  it('still refuses while saving, or before the canvas is ready (unchanged)', () => {
    expect(canSave({ ...OK, saving: true })).toBe(false);
    expect(canSave({ ...OK, ready: false })).toBe(false);
  });
});
