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

function edge(from: string, to: string, on: 'success' | 'failure' = 'success'): Edge {
  return { id: `${from}->${to}`, from, to, on };
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
  edges: [edge('a', 'b'), edge('b', 'c')],
});

/** `a` reaches `b` only on FAILURE — so a's output is reachable but not guaranteed. */
const FAILURE_BRANCH = doc({
  nodes: [producer('a', [{ name: 'body', type: 'string' }]), node('b')],
  edges: [edge('a', 'b', 'failure')],
});

/** A foreach body child, which is the only site where `${item}` is bound. */
const FOREACH = doc({
  nodes: [producer('src', [{ name: 'rows', type: 'json' }]), node('body'), node('after')],
  edges: [edge('src', 'loop'), edge('loop', 'after')],
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
  edges: [edge('plain', 'reader')],
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

// --- container expression fields (#864) --------------------------------------

/**
 * `src → lp → after`, where `lp` is a loop whose one child `check` declares the
 * boolean an exit condition actually reads. `src` is UPSTREAM of the loop — its
 * output is readable by `check`, but not by `exitWhen`, whose scope is the
 * loop's own children.
 */
const LOOP = doc({
  params: [
    { name: 'flag', type: 'boolean', required: true },
    { name: 'topic', type: 'string', required: true },
    { name: 'apiKey', type: 'secret', required: true },
  ],
  nodes: [
    producer('src', [{ name: 'body', type: 'string' }]),
    producer('check', [
      { name: 'done', type: 'boolean' },
      { name: 'count', type: 'number' },
    ]),
    node('after'),
  ],
  edges: [edge('src', 'lp'), edge('lp', 'after')],
  containers: [
    {
      id: 'lp',
      kind: 'loop',
      children: ['check'],
      join: 'all',
      exitWhen: '${nodes.check.output.done}',
      maxRounds: 3,
    },
  ],
});

/** `src` reaches the foreach only on FAILURE, so its rows are reachable, not guaranteed. */
const FOREACH_ON_FAILURE = doc({
  params: [{ name: 'list', type: 'json', required: true }],
  nodes: [producer('src', [{ name: 'rows', type: 'json' }]), node('body')],
  edges: [edge('src', 'fe', 'failure')],
  containers: [
    { id: 'fe', kind: 'foreach', children: ['body'], join: 'all', items: '${params.list}' },
  ],
});

const CONTAINER_FIXTURES: [string, Doc][] = [
  ['a loop', LOOP],
  ['a foreach body', FOREACH],
  ['a foreach reached on failure', FOREACH_ON_FAILURE],
];

const FIELDS = ['exitWhen', 'items'] as const;

/** Every offer at every container field site of `d`. */
function containerOffers(d: Doc): [string, (typeof FIELDS)[number], RefSuggestion][] {
  return d.containers.flatMap((c) =>
    FIELDS.flatMap((field) =>
      availableRefs(d, { kind: 'container', containerId: c.id, field }).map(
        (s) => [c.id, field, s] as [string, (typeof FIELDS)[number], RefSuggestion],
      ),
    ),
  );
}

/** `d` with a container's field set WHOLE to `text` — both fields are whole-value-only. */
function withField(d: Doc, containerId: string, field: string, text: string): Doc {
  return {
    ...d,
    containers: d.containers.map((c) => (c.id === containerId ? { ...c, [field]: text } : c)),
  };
}

/**
 * The per-field TYPE refusals — the half of the save gate `availableRefs` does
 * not claim to answer (a site names a field's SCOPE, not its type). The web
 * picker drops those offers by probing this same validator, which the
 * `survivors` tests below pin end to end.
 */
const TYPE_REFUSAL = /must be (a boolean|an array) expression/;

describe('availableRefs — no false offer at a container field (#864)', () => {
  for (const [name, d] of CONTAINER_FIXTURES) {
    it(`${name}: every offer is in scope for the field it is offered to`, () => {
      const offers = containerOffers(d);
      expect(offers.length).toBeGreaterThan(0);
      const before = validatePipelineDoc(d);
      for (const [id, field, suggestion] of offers) {
        const after = validatePipelineDoc(withField(d, id, field, suggestion.insert)).filter(
          (issue) => !TYPE_REFUSAL.test(issue),
        );
        expect(after, `${id}.${field} ← ${suggestion.insert}`).toEqual(before);
      }
    });
  }

  it('the container fixtures are themselves clean', () => {
    for (const [name, d] of CONTAINER_FIXTURES) expect(validatePipelineDoc(d), name).toEqual([]);
  });
});

const containerRefs = (d: Doc, containerId: string, field: (typeof FIELDS)[number]) =>
  availableRefs(d, { kind: 'container', containerId, field }).map((s) => s.ref);

/** What survives the save gate's own per-field check — what the picker ends up listing. */
const survivors = (d: Doc, containerId: string, field: (typeof FIELDS)[number]) =>
  availableRefs(d, { kind: 'container', containerId, field })
    .filter((s) => validatePipelineDoc(withField(d, containerId, field, s.insert)).length === 0)
    .map((s) => s.ref);

describe('availableRefs — the container field catalog (#864)', () => {
  it("exitWhen reads the loop's OWN children — never an upstream node, nor the loop", () => {
    const refs = containerRefs(LOOP, 'lp', 'exitWhen');
    expect(refs).toContain('nodes.check.output.done');
    expect(refs).toContain('nodes.check.status');
    expect(refs).not.toContain('nodes.src.output.body');
    expect(refs.some((r) => r.startsWith('nodes.lp.'))).toBe(false);
    expect(refs).not.toContain('item');
    expect(refs).not.toContain('params.apiKey');
  });

  it('exitWhen, after the save gate’s boolean check, is left with what could be a boolean', () => {
    // `trigger.body` is `any` (E7's deep-address escape hatch), so the check
    // cannot refuse it — the run-time `evalExitWhen` binds for that one.
    expect(survivors(LOOP, 'lp', 'exitWhen').sort()).toEqual([
      'nodes.check.output.done',
      'params.flag',
      'trigger.body',
    ]);
  });

  it('items reads the OUTER scope — upstream yes, its own body and ${item} never', () => {
    const refs = containerRefs(FOREACH, 'loop', 'items');
    expect(refs).toContain('nodes.src.output.rows');
    expect(refs.some((r) => r.startsWith('nodes.body.'))).toBe(false);
    expect(refs.some((r) => r.startsWith('nodes.loop.'))).toBe(false);
    expect(refs).not.toContain('item');
  });

  it('items, after the save gate’s array check, is left with what could be an array', () => {
    expect(survivors(FOREACH, 'loop', 'items').sort()).toEqual([
      'nodes.src.output.rows',
      'trigger.body',
    ]);
  });

  it('items offers NO default()-wrapped reference — its "" fallback is never an array', () => {
    const offered = availableRefs(FOREACH_ON_FAILURE, {
      kind: 'container',
      containerId: 'fe',
      field: 'items',
    });
    // `src` is reachable only on failure, so the node-site rule would offer it
    // wrapped. Here that wrapping saves clean and then fails the very run it
    // was meant to rescue: `evalForeachItems` refuses the string fallback.
    expect(offered.some((s) => s.availability === 'needs-default')).toBe(false);
    expect(offered.map((s) => s.ref)).not.toContain('nodes.src.output.rows');
    expect(offered.map((s) => s.ref)).toContain('params.list');
  });

  it('offers nothing for a field the container kind does not carry, or an unknown id', () => {
    expect(containerRefs(LOOP, 'lp', 'items')).toEqual([]);
    expect(containerRefs(FOREACH, 'loop', 'exitWhen')).toEqual([]);
    expect(containerRefs(LOOP, 'ghost', 'exitWhen')).toEqual([]);
  });
});

// --- a filter's per-FIELD `${item}` scope (#864) -----------------------------

/**
 * `src → pick`, a `filter` outside any foreach. Its `predicate` is the lambda
 * position of the composed `filter(items, predicate)`, so `${item}` is bound
 * there whatever the node's membership — and its `items` is not.
 */
const FILTER = doc({
  nodes: [
    producer('src', [
      { name: 'rows', type: 'json' },
      { name: 'label', type: 'string' },
    ]),
    node('pick', {
      type: 'filter',
      config: { items: '${nodes.src.output.rows}', predicate: '${item}' },
    }),
  ],
  edges: [edge('src', 'pick')],
});

/** The same filter as a foreach body child, where `items` binds `${item}` too. */
const FILTER_IN_FOREACH = doc({
  nodes: [
    producer('src', [{ name: 'rows', type: 'json' }]),
    node('pick', { type: 'filter', config: { items: '${item}', predicate: '${item}' } }),
  ],
  edges: [edge('src', 'fe')],
  containers: [
    {
      id: 'fe',
      kind: 'foreach',
      children: ['pick'],
      join: 'all',
      items: '${nodes.src.output.rows}',
    },
  ],
});

const FILTER_FIELDS = ['items', 'predicate'] as const;

const fieldRefs = (d: Doc, nodeId: string, field: string) =>
  availableRefs(d, { kind: 'node', nodeId, field }).map((s) => s.ref);

/** `d` with a node's config field set WHOLE to `text` — both filter fields are whole-value. */
function withConfig(d: Doc, nodeId: string, field: string, text: string): Doc {
  return {
    ...d,
    nodes: d.nodes.map((n) =>
      n.id === nodeId ? { ...n, config: { ...n.config, [field]: text } } : n,
    ),
  };
}

/** A filter's own TYPE refusals — `items` wants an array, `predicate` a boolean. */
const FILTER_TYPE_REFUSAL = /function 'filter': argument \d+ must be a/;

describe('availableRefs — a filter binds ${item} per FIELD (#864)', () => {
  for (const [name, d] of [
    ['a filter', FILTER],
    ['a filter in a foreach body', FILTER_IN_FOREACH],
  ] as const) {
    it(`${name}: every offer at a field site is in scope for that field`, () => {
      const before = validatePipelineDoc(d);
      expect(before, 'the fixture is clean').toEqual([]);
      let offered = 0;
      for (const field of FILTER_FIELDS) {
        for (const s of availableRefs(d, { kind: 'node', nodeId: 'pick', field })) {
          offered += 1;
          const after = validatePipelineDoc(withConfig(d, 'pick', field, s.insert)).filter(
            (issue) => !FILTER_TYPE_REFUSAL.test(issue),
          );
          expect(after, `pick.${field} ← ${s.insert}`).toEqual(before);
        }
      }
      expect(offered).toBeGreaterThan(0);
    });
  }

  it('offers ${item} in a filter predicate outside any foreach', () => {
    expect(fieldRefs(FILTER, 'pick', 'predicate')).toContain('item');
    // …and the offer really is legal there: `${item}` is the fixture's own
    // predicate, which the clean-fixture assertion above already saves.
  });

  it('does NOT offer ${item} in its items, nor at the node-level site', () => {
    expect(fieldRefs(FILTER, 'pick', 'items')).not.toContain('item');
    expect(refsFor(FILTER, 'pick')).not.toContain('item');
    // Refused at save, so this is the offer the per-field site must not make.
    expect(validatePipelineDoc(withConfig(FILTER, 'pick', 'items', '${item}'))).not.toEqual([]);
  });

  it('inside a foreach body, both fields bind ${item}', () => {
    expect(fieldRefs(FILTER_IN_FOREACH, 'pick', 'items')).toContain('item');
    expect(fieldRefs(FILTER_IN_FOREACH, 'pick', 'predicate')).toContain('item');
  });

  it('a predicate-named field on any OTHER activity binds nothing', () => {
    const other = withConfig(CHAIN, 'c', 'predicate', 'x');
    expect(fieldRefs(other, 'c', 'predicate')).not.toContain('item');
  });
});
