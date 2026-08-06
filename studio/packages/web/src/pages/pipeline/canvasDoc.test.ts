import { describe, expect, it } from 'vitest';
import {
  type Edge,
  type EdgeOn,
  type Node,
  type Output,
  type Param,
} from '@autonomy-studio/shared';
import { PipelineVersionWriteSchema } from '../../api/pipelines';
import { canSave, toVersionBody, validateCanvas } from './canvasDoc';

function node(id: string, config: Record<string, unknown> = {}): Node {
  return { id, type: 'http_request', config, position: { x: 0, y: 0 } };
}

function edge(id: string, from: string, to: string, on: EdgeOn = 'success'): Edge {
  return { id, from, to, on };
}

describe('toVersionBody', () => {
  const params: Param[] = [{ name: 'topic', type: 'string', required: true }];
  const outputs: Output[] = [{ name: 'result', type: 'string' }];

  // #485 — `toVersionBody` is the one HAND-LISTED PipelineVersion builder (the
  // import path spreads). Every `.default()` field is optional in the wire body
  // (`z.input`), so a field could be dropped here silently, exactly as
  // `containers` was on import. Beyond the per-field value checks, this asserts
  // the builder COVERS every field the wire body carries — minus the ones it
  // deliberately does not send — so a new field added to the schema fails HERE
  // until it is either sent or explicitly declared an omission.
  it('sends EVERY field the wire body carries — a class guard (#485)', () => {
    const nodes = [node('a'), node('b')];
    const edges = [edge('e', 'a', 'b')];
    const containers = [{ id: 'c1', kind: 'stage' as const, children: [] }];
    const body = toVersionBody(nodes, edges, containers, params, outputs, 'pv_basis');

    // Every value is DISTINCT, so a transposed argument is red rather than
    // masked by two equal empty arrays. Five positional array parameters is
    // exactly the shape an ordering slip hides in.
    expect(body.params).toEqual(params);
    expect(body.outputs).toEqual(outputs);
    expect(body.containers).toEqual(containers);
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
    expect(toVersionBody([], [], [], [], [], null)).not.toHaveProperty('catalogVersion');
  });

  /**
   * U16 — the typed contract comes from the CANVAS, and `loaded` is gone.
   *
   * `params`/`outputs` were carried forward from the opened version until this
   * ticket, for want of an editor. That is the same defect shape as #746's
   * containers: once a UI can edit a field, sourcing it from the version the
   * canvas was OPENED on discards the operator's edit at the moment they save
   * it. The regression is now unrepresentable here — `loaded` is not a
   * parameter — so what this pins is that the body reflects its arguments even
   * when they are EMPTY, which is the state a carry-forward would have filled.
   */
  it('sends empty params/outputs when the canvas declares none', () => {
    const body = toVersionBody([node('a')], [], [], [], [], null);
    expect(body.params).toEqual([]);
    expect(body.outputs).toEqual([]);
    expect(body.nodes).toHaveLength(1);
  });

  it('produces a body that parses cleanly through the shared write schema', () => {
    const body = toVersionBody(
      [node('a'), node('b')],
      [edge('e', 'a', 'b')],
      [],
      params,
      outputs,
      'pv_basis',
    );
    expect(() => PipelineVersionWriteSchema.parse(body)).not.toThrow();
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

  // #843 — the badge, and therefore `canSave`, now bars a param default the run
  // would reject. It arrives here for free through `validatePipelineDoc`, which
  // is the point of `validateCanvas` delegating rather than re-implementing:
  // the canvas gains a server rule without a line of client code.
  it('bars a param default the run would reject (#843)', () => {
    const bad: Param[] = [{ name: 'n', type: 'number', required: false, default: 'abc' }];
    expect(validateCanvas([node('a')], [], [], bad)).toEqual([
      "param 'n': expected a finite number",
    ]);
  });

  it('does NOT bar a numeric string, which `coerce` accepts', () => {
    const fine: Param[] = [{ name: 'n', type: 'number', required: false, default: '5' }];
    expect(validateCanvas([node('a')], [], [], fine)).toEqual([]);
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
