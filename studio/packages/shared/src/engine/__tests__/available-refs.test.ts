import { describe, expect, it } from 'vitest';
import { availableRefs, validatePipelineDoc, type RefSuggestion } from '../params.js';
import type { Container, Edge, Node, Param } from '../../index.js';

/**
 * U8a — the reference CATALOG behind the expression-insert flyout.
 *
 * The governing property is NO FALSE OFFER: a picker that hands the author a
 * reference the save-gate then refuses is worse than no picker, because the
 * author has no way to tell which of the offered items are real. So the
 * load-bearing test here is not a list of expected strings — it is a
 * CONSISTENCY test that feeds every suggestion back through
 * `validatePipelineDoc` (the same SSOT the canvas badge and the server write
 * gate call) and demands the doc stay exactly as clean as it was.
 *
 * The probe writes the suggestion into a NON-EMPTY field, mid-string, because
 * that is what insert-at-cursor actually produces — overwriting the field would
 * silently exempt the interpolated case, which is the one an insert creates.
 */

type Doc = {
  params: Param[];
  nodes: Node[];
  edges: Edge[];
  containers: Container[];
};

function node(id: string, over: Partial<Node> = {}): Node {
  return { id, type: 'agent_task', config: {}, position: { x: 0, y: 0 }, ...over };
}

/** A node with a DECLARED output contract — the only kind whose names are enumerable. */
function producer(id: string, outputs: { name: string; type: string }[]): Node {
  return node(id, { config: { outputs } });
}

function doc(over: Partial<Doc> = {}): Doc {
  return { params: [], nodes: [], edges: [], containers: [], ...over };
}

/** Every suggestion offered to every node of `d`, as `[nodeId, suggestion]` pairs. */
function allOffers(d: Doc): [string, RefSuggestion][] {
  return d.nodes.flatMap((n) =>
    availableRefs(d, { kind: 'node', nodeId: n.id }).map(
      (s) => [n.id, s] as [string, RefSuggestion],
    ),
  );
}

/** `d` with `text` spliced into a fresh, non-empty config field on `nodeId`. */
function withProbe(d: Doc, nodeId: string, text: string): Doc {
  return {
    ...d,
    nodes: d.nodes.map((n) =>
      n.id === nodeId ? { ...n, config: { ...n.config, probe: `before ${text} after` } } : n,
    ),
  };
}

// --- the fixture docs -------------------------------------------------------

/** a → b → c, two declared producers, a declared param and a SECRET one. */
const CHAIN = doc({
  params: [
    { name: 'topic', type: 'string', required: true },
    { name: 'apiKey', type: 'secret', required: true },
  ],
  nodes: [
    producer('a', [{ name: 'body', type: 'string' }]),
    producer('b', [{ name: 'count', type: 'number' }]),
    node('c'),
  ],
  edges: [
    { from: 'a', to: 'b', on: 'success' },
    { from: 'b', to: 'c', on: 'success' },
  ],
});

/** `a` reaches `b` only on FAILURE — so a's output is reachable but not guaranteed. */
const FAILURE_BRANCH = doc({
  nodes: [producer('a', [{ name: 'body', type: 'string' }]), node('b')],
  edges: [{ from: 'a', to: 'b', on: 'failure' }],
});

/** A foreach body child, which is the only site where `${item}` is bound. */
const FOREACH = doc({
  nodes: [producer('src', [{ name: 'rows', type: 'json' }]), node('body'), node('after')],
  edges: [
    { from: 'src', to: 'loop', on: 'success' },
    { from: 'loop', to: 'after', on: 'success' },
  ],
  containers: [
    {
      id: 'loop',
      kind: 'foreach',
      children: ['body'],
      join: 'all',
      items: '${nodes.src.output.rows}',
    },
  ],
});

/** `plain` carries NO outputs key — an `absent` contract, whose names are unknowable. */
const ABSENT_CONTRACT = doc({
  nodes: [node('plain'), node('reader')],
  edges: [{ from: 'plain', to: 'reader', on: 'success' }],
});

const FIXTURES: [string, Doc][] = [
  ['a linear chain', CHAIN],
  ['a failure branch', FAILURE_BRANCH],
  ['a foreach body', FOREACH],
  ['an absent output contract', ABSENT_CONTRACT],
];

// --- the property ------------------------------------------------------------

describe('availableRefs — no false offer', () => {
  for (const [name, d] of FIXTURES) {
    it(`${name}: every offered reference survives validatePipelineDoc`, () => {
      const offers = allOffers(d);
      // Guard against a vacuous pass: a catalog that returned nothing would
      // satisfy the property trivially.
      expect(offers.length).toBeGreaterThan(0);

      for (const [nodeId, suggestion] of offers) {
        const before = validatePipelineDoc(d);
        const after = validatePipelineDoc(withProbe(d, nodeId, suggestion.insert));
        expect(after, `${nodeId} ← ${suggestion.insert}`).toEqual(before);
      }
    });
  }

  it('the fixtures are themselves clean, so an unchanged issue set means CLEAN', () => {
    for (const [name, d] of FIXTURES) expect(validatePipelineDoc(d), name).toEqual([]);
  });
});

// --- what is offered, and what is deliberately not ---------------------------

const refsFor = (d: Doc, nodeId: string) =>
  availableRefs(d, { kind: 'node', nodeId }).map((s) => s.ref);

describe('availableRefs — the catalog', () => {
  it('offers a declared param and REFUSES a secret-typed one', () => {
    const refs = refsFor(CHAIN, 'c');
    expect(refs).toContain('params.topic');
    // A secret never enters the `${}` language at all — its only sink is the
    // executor env channel, and `checkRefRoot` refuses the ref outright.
    expect(refs).not.toContain('params.apiKey');
  });

  it('offers an upstream output, and never a self, downstream or unrelated one', () => {
    expect(refsFor(CHAIN, 'c')).toContain('nodes.a.output.body');
    expect(refsFor(CHAIN, 'c')).toContain('nodes.b.output.count');
    // `a` runs FIRST — nothing upstream of it, and never itself.
    expect(refsFor(CHAIN, 'a')).not.toContain('nodes.a.output.body');
    expect(refsFor(CHAIN, 'a')).not.toContain('nodes.b.output.count');
  });

  it('offers a non-guaranteed output pre-wrapped in default(), not bare', () => {
    const offered = availableRefs(FAILURE_BRANCH, { kind: 'node', nodeId: 'b' });
    const out = offered.find((s) => s.ref === 'nodes.a.output.body');
    expect(out).toBeDefined();
    // Reachable only on a failure branch: legal ONLY inside `default()`'s first
    // argument, so the catalog hands over the wrapped form.
    expect(out?.availability).toBe('needs-default');
    expect(out?.insert).toBe('${default(nodes.a.output.body, "")}');
  });

  it('offers a settled node STATUS, never wrapped in default()', () => {
    const offered = availableRefs(FAILURE_BRANCH, { kind: 'node', nodeId: 'b' });
    const status = offered.find((s) => s.ref === 'nodes.a.status');
    expect(status?.availability).toBe('available');
    // `default()` rescues a MISSING value; an unsettled status THROWS instead,
    // so wrapping one would manufacture a doc that saves and then fails at run.
    expect(status?.insert).toBe('${nodes.a.status}');
  });

  it('offers a container as a first-class producer (a foreach declares results)', () => {
    expect(refsFor(FOREACH, 'after')).toContain('nodes.loop.output.results');
  });

  it('offers no output name for an ABSENT contract, but still offers its status', () => {
    const refs = refsFor(ABSENT_CONTRACT, 'reader');
    expect(refs.some((r) => r.startsWith('nodes.plain.output.'))).toBe(false);
    expect(refs).toContain('nodes.plain.status');
  });

  it('binds ${item} to a foreach body child and to nobody else', () => {
    expect(refsFor(FOREACH, 'body')).toContain('item');
    expect(refsFor(FOREACH, 'after')).not.toContain('item');
    expect(refsFor(CHAIN, 'c')).not.toContain('item');
  });

  it('offers the run and trigger fields, but never the context-scoped ones', () => {
    const refs = refsFor(CHAIN, 'a');
    expect(refs).toContain('run.runId');
    expect(refs).toContain('trigger.body');
    // Window fields are legal ONLY in a tumbling trigger's param bindings, and
    // `tool.args.*` only inside an llm_call tool expression — neither is a node
    // config scope, so offering either here would be a false offer.
    expect(refs).not.toContain('trigger.windowStart');
    expect(refs.some((r) => r.startsWith('tool.'))).toBe(false);
  });

  it('returns nothing for a node id the doc does not contain', () => {
    expect(availableRefs(CHAIN, { kind: 'node', nodeId: 'ghost' })).toEqual([]);
  });
});
