import { describe, expect, it } from 'vitest';
import type { Container, Edge, Node } from '@autonomy-studio/shared';
import {
  consequenceMessage,
  containerEditConsequence,
  containerLabels,
  readableIssue,
  routingChangeBetween,
  routingSentence,
  type ContainerEditDoc,
} from './containerRules';

const A: Node = { id: 'n_a', type: 'http_request', config: {}, position: { x: 0, y: 0 } };
const B: Node = { id: 'n_b', type: 'llm_call', config: {}, position: { x: 100, y: 0 } };
/** An activity the catalog does not know — the label falls back to its type. */
const C: Node = { id: 'n_c', type: 'not_in_catalog', config: {}, position: { x: 200, y: 0 } };

function doc(overrides: Partial<ContainerEditDoc> = {}): ContainerEditDoc {
  return { nodes: [A, B, C], edges: [], containers: [], params: [], ...overrides };
}

const D: Node = { id: 'n_d', type: 'http_request', config: {}, position: { x: 300, y: 0 } };

const AB: Edge = { id: 'e_ab', from: 'n_a', to: 'n_b', on: 'success' };
const STAGE: Container[] = [{ id: 'stage_1', kind: 'stage', children: ['n_b'] }];

describe('containerEditConsequence', () => {
  it('reports nothing for an edit that costs nothing', () => {
    // Two nodes already wired, both joining one stage: no boundary is crossed and
    // the routing is authored, so there is nothing to warn about.
    const next: Container[] = [{ id: 'stage_1', kind: 'stage', children: ['n_a', 'n_b'] }];
    const c = containerEditConsequence(doc({ edges: [AB] }), next);
    expect(c.newIssues).toEqual([]);
    expect(c.routingChange).toBeNull();
  });

  it('reports the boundary issue a half-enclosed edge introduces', () => {
    const next: Container[] = [{ id: 'stage_1', kind: 'stage', children: ['n_b'] }];
    const c = containerEditConsequence(doc({ edges: [AB] }), next);
    expect(c.newIssues).toHaveLength(1);
    expect(c.newIssues[0]).toContain('crosses a container boundary');
  });

  it('reports the one-child rule when a loop is emptied', () => {
    const before: Container[] = [
      { id: 'loop_1', kind: 'loop', children: ['n_a'], exitWhen: '${true}' },
    ];
    const next: Container[] = [{ id: 'loop_1', kind: 'loop', children: [], exitWhen: '${true}' }];
    const c = containerEditConsequence(doc({ containers: before }), next);
    expect(c.newIssues.some((i) => i.includes('makes no progress'))).toBe(true);
  });

  it('tolerates an issue the doc ALREADY has, so a broken doc can still be repaired', () => {
    // A phantom child is an existing issue. Moving an UNRELATED node into a new
    // stage must not be reported as though this edit caused it.
    const before: Container[] = [{ id: 'stage_1', kind: 'stage', children: ['n_ghost'] }];
    const next: Container[] = [...before, { id: 'stage_2', kind: 'stage', children: ['n_a'] }];
    const c = containerEditConsequence(doc({ containers: before }), next);
    expect(c.newIssues).toEqual([]);
  });

  /**
   * The consequence NO validator reports: on an edge-less doc `implicitRouting`
   * synthesises one success chain, and a container turns that into parallel
   * roots. `validateDoc` accepts both docs and says nothing.
   */
  it('reports the implicit-routing flip the first container causes', () => {
    const next: Container[] = [{ id: 'stage_1', kind: 'stage', children: ['n_b'] }];
    const c = containerEditConsequence(doc(), next);
    expect(c.newIssues).toEqual([]);
    expect(c.routingChange?.from).toEqual({ kind: 'chain', order: ['n_a', 'n_b', 'n_c'] });
    expect(c.routingChange?.to?.kind).toBe('partitioned');
  });

  it('reports no routing change once the doc has authored edges', () => {
    const next: Container[] = [{ id: 'stage_1', kind: 'stage', children: ['n_a', 'n_b'] }];
    expect(containerEditConsequence(doc({ edges: [AB] }), next).routingChange).toBeNull();
  });

  /**
   * #840 case 1 — the edit that used to fire NOTHING. Both sides are
   * `partitioned`, so the old kind-only comparison saw no change; what actually
   * changed is that `n_c` left the stage's body, which under a loop or foreach is
   * the difference between running once per round and running once.
   */
  it('reports a membership move on a doc that ALREADY has a container', () => {
    const before: Container[] = [{ id: 'stage_1', kind: 'stage', children: ['n_b', 'n_c'] }];
    const next: Container[] = [{ id: 'stage_1', kind: 'stage', children: ['n_b'] }];
    const change = containerEditConsequence(doc({ containers: before }), next).routingChange;
    expect(change).not.toBeNull();
    expect(change?.from?.kind).toBe('partitioned');
    expect(change?.to?.kind).toBe('partitioned');
  });

  /**
   * A pure REORDER of `children` is not a routing change — same members, same
   * buckets, same walk — and must not raise a dialog, or the warning becomes
   * noise the operator learns to dismiss.
   *
   * The fixture is four nodes for a reason. With three, the stage holds exactly
   * one container-root and exactly one follow, so a projection that DID leak
   * `children` order still emits one-element arrays that compare equal — the
   * test passes whether or not the property holds. Measured on the first version
   * of this test, which is why it is written out here: with `n_b` and `n_d` both
   * container-roots, the emitted `children` is `['n_b','n_d']` under one order
   * and `['n_d','n_b']` under the other unless the projection walks `doc.nodes`.
   */
  it('reports nothing for a pure reorder of a container’s children', () => {
    const four = { nodes: [A, B, C, D] };
    const before: Container[] = [{ id: 'stage_1', kind: 'stage', children: ['n_b', 'n_d'] }];
    const next: Container[] = [{ id: 'stage_1', kind: 'stage', children: ['n_d', 'n_b'] }];
    const change = containerEditConsequence(
      doc({ ...four, containers: before }),
      next,
    ).routingChange;
    expect(change).toBeNull();
  });
});

/**
 * #840 case 2 — `deleteContainer`'s edit does not come through
 * `containerEditConsequence` (it cascades EDGES too, which that function's
 * `nextContainers`-only signature cannot express), so the routing half is
 * exported separately for it to compose with its own destruction warning.
 * `containerRules` deliberately keeps the two confirmations apart.
 */
describe('routingChangeBetween', () => {
  const withStage: Container[] = [{ id: 'stage_1', kind: 'stage', children: ['n_b'] }];

  it('is null when the walk is unchanged', () => {
    expect(
      routingChangeBetween(doc({ containers: withStage }), doc({ containers: withStage })),
    ).toBeNull();
  });

  it('reports the flip back to a chain when the LAST container goes', () => {
    const change = routingChangeBetween(doc({ containers: withStage }), doc());
    expect(change?.from?.kind).toBe('partitioned');
    expect(change?.to).toEqual({ kind: 'chain', order: ['n_a', 'n_b', 'n_c'] });
  });

  it('reports a delete that is NOT of the last container', () => {
    // The ticket emphasises the last-container case, but a non-last delete moves
    // that container's children to the top level, which changes the walk too.
    const two: Container[] = [
      { id: 'stage_1', kind: 'stage', children: ['n_b'] },
      { id: 'stage_2', kind: 'stage', children: ['n_c'] },
    ];
    expect(
      routingChangeBetween(doc({ containers: two }), doc({ containers: [two[1]!] })),
    ).not.toBeNull();
  });

  /**
   * The delete CASCADE can remove the doc's last authored edge, which flips
   * routing from authored (`null`) to an inferred chain. So the comparison must
   * NOT short-circuit on `edges.length > 0`: that guard reads like an
   * optimisation and would silently kill this case.
   */
  it('reports routing becoming inferred when the cascade removes the last authored edge', () => {
    const wired: Edge = { id: 'e_a_stage', from: 'n_a', to: 'stage_1', on: 'success' };
    const change = routingChangeBetween(
      doc({ containers: withStage, edges: [wired] }),
      doc({ containers: [], edges: [] }),
    );
    expect(change?.from).toBeNull();
    expect(change?.to?.kind).toBe('chain');
  });
});

/**
 * The DEFENSIVE arm, tested directly because no caller can reach it: an edit
 * that gives a doc authored edges would stop routing being inferred at all.
 * `routingSentence` is exported, so "unreachable today" is a property of the
 * current callers rather than of the function — and an exported branch that has
 * never once been executed is where a typo lives forever.
 */
describe('routingSentence', () => {
  it('is null when nothing changed', () => {
    expect(routingSentence(null)).toBeNull();
  });

  it('states routing ceasing to be inferred, if a caller ever produces that', () => {
    const msg = routingSentence({ from: { kind: 'chain', order: ['n_a', 'n_b'] }, to: null });
    expect(msg).toContain('no longer inferred');
    expect(msg).toContain('Saving mints');
  });
});

describe('containerLabels', () => {
  it('numbers containers within their kind, in document order', () => {
    const labels = containerLabels([
      { id: 'c_1', kind: 'stage', children: [] },
      { id: 'c_2', kind: 'loop', children: [], exitWhen: '${true}' },
      { id: 'c_3', kind: 'stage', children: [] },
    ]);
    expect(labels.get('c_1')).toBe('stage 1');
    expect(labels.get('c_2')).toBe('loop 1');
    expect(labels.get('c_3')).toBe('stage 2');
  });
});

describe('readableIssue', () => {
  const containers: Container[] = [{ id: 'stage_1', kind: 'stage', children: ['n_b'] }];

  it('names a node by its activity, not by its minted id', () => {
    const out = readableIssue(
      `container 'stage_1': child 'n_a' is not a node in this pipeline`,
      [A, B, C],
      [],
      containers,
    );
    expect(out).toBe(`container 'stage 1': child 'HTTP Request 1' is not a node in this pipeline`);
  });

  it('names an edge by its ENDS, since an edge has no name of its own', () => {
    const out = readableIssue(
      `edge 'e_ab': crosses a container boundary`,
      [A, B, C],
      [AB],
      containers,
    );
    expect(out).toBe(`edge 'HTTP Request 1 → LLM Call 1': crosses a container boundary`);
  });

  /**
   * #878 — the defect this whole function exists to prevent, in its last form.
   * Before `activityLabels`, an issue naming two `http_request` nodes rendered
   * one word twice: literally true, and no more actionable than the two uuids it
   * replaced.
   */
  it('tells two activities of the SAME type apart', () => {
    const out = readableIssue(`edge 'n_a' → 'n_d' is broken`, [A, B, C, D], [], containers);
    expect(out).toBe(`edge 'HTTP Request 1' → 'HTTP Request 2' is broken`);
  });

  it('leaves a quoted token that resolves to nothing exactly as it was', () => {
    const out = readableIssue(`container 'unknown': something about 'stage'`, [A], [], containers);
    expect(out).toBe(`container 'unknown': something about 'stage'`);
  });

  /**
   * `exitWhen` and `items` are the only container config the New-container form
   * authors, and their validator writes the id UNQUOTED — so this is the first
   * error a beginner meets, and it arrived as a bare uuid until this pass existed.
   */
  it('rewrites the validator’s unquoted container.<id>.<field> location too', () => {
    const out = readableIssue(
      'container.stage_1.exitWhen: ${nodes.x.status} does not name an upstream node',
      [A],
      [],
      containers,
    );
    expect(out).toBe(
      "container 'stage 1' exitWhen: ${nodes.x.status} does not name an upstream node",
    );
  });

  it('falls back to the raw type for an activity the catalog does not know', () => {
    const out = readableIssue(`node 'n_c' is broken`, [C], [], []);
    expect(out).toBe(`node 'not_in_catalog 1' is broken`);
  });

  /**
   * #884 — the NODE half of the unquoted-location pass, and the reason this
   * function could not simply be pointed at the badge list. The if/fail/filter and
   * wait validators write `node.<id>.<field>` (`params.ts:2475`), so a bad
   * reference in a config field carried a raw uuid straight through the two passes
   * that existed before. (`scanNodeRefs` writes the PLURAL `nodes.<id>.config.…`
   * for an activity's own config — covered separately below.)
   */
  it('rewrites the unquoted node.<id>.<field> location', () => {
    const out = readableIssue(
      'node.n_a.condition: ${nodes.ghost.output.body} does not name an upstream node',
      [A, B, C],
      [],
      containers,
    );
    expect(out).toBe(
      "node 'HTTP Request 1' condition: ${nodes.ghost.output.body} does not name an upstream node",
    );
  });

  /**
   * The operator's OWN expression text, and the reason the location pass is
   * anchored at index 0.
   *
   * THE FIXTURE IS THE TEST. An earlier version of this case used a NODE-located
   * message, and was vacuous: `String.replace` with a non-global regex rewrites
   * only the FIRST match, and in that message the first `nodes.` occurrence IS the
   * location — so dropping the `^` changed nothing and the whole suite stayed
   * green. The anchor is only load-bearing when the first occurrence is in the
   * BODY, which needs a message located somewhere other than a node. A
   * CONTAINER-located one is the real shape: `validateExitWhen` writes
   * `container.<id>.exitWhen` and the operator's own `exitWhen` expression follows
   * it. Without the anchor that expression is corrupted into
   * `${node 'HTTP Request 1' output.done}` — a string that appears nowhere in
   * their config and is not even valid expression syntax.
   */
  it('leaves a ${nodes.<id>...} reference in the message BODY verbatim', () => {
    const out = readableIssue(
      'container.stage_1.exitWhen: ${nodes.n_a.output.done} does not name an upstream node',
      [A, B, C, D],
      [],
      containers,
    );
    // The span itself, unedited — the property the anchor exists for. #887's
    // gloss is APPENDED after it and changes no byte of it.
    expect(out).toContain('${nodes.n_a.output.done}');
    expect(out).toBe(
      "container 'stage 1' exitWhen: ${nodes.n_a.output.done} (HTTP Request 1) " +
        'does not name an upstream node',
    );
  });

  /**
   * The same protection for the shape that has NO location at all — the forward
   * cycle message opens on prose, so an unanchored pass would find its first
   * `nodes.` wherever one happened to appear.
   */
  it('rewrites nothing node-shaped in a message that has no location prefix', () => {
    const msg = 'the graph is unsound near ${nodes.n_a.output.done}';
    // Every byte of the original survives; #887's gloss only ever adds after it.
    expect(readableIssue(msg, [A, B, C, D], [], containers)).toBe(`${msg} (HTTP Request 1)`);
  });

  /**
   * The dot-less shape (`node.<id>:`, `params.ts:2501` and ten others) is the
   * majority of node locations, and it punctuates differently: consuming the id
   * must NOT leave a space before the colon.
   */
  it('rewrites a bare node.<id> location without stranding a space before the colon', () => {
    const out = readableIssue('node.n_a: connectionParams have no effect', [A], [], []);
    expect(out).toBe("node 'HTTP Request 1': connectionParams have no effect");
  });

  it('rewrites the PLURAL nodes.<id>.config location the LLM validators write', () => {
    const out = readableIssue('nodes.n_a.config.history: must be an array', [A], [], []);
    expect(out).toBe("node 'HTTP Request 1' config.history: must be an array");
  });

  it('leaves a location whose id resolves to nothing exactly as it was', () => {
    expect(readableIssue('node.n_gone.config.url: broken', [A], [], [])).toBe(
      'node.n_gone.config.url: broken',
    );
  });

  /**
   * `forwardCycleErrors` (`params.ts:2930`, message at `:2964`) names its ids in a third shape — a
   * brace-wrapped comma list, unquoted and mid-sentence — which neither location
   * pass nor the quoted pass can see. A forward cycle is among the most reachable
   * authoring errors, so this was the other message that would have reached the
   * badge list as raw uuids.
   */
  it('names every id in a brace-wrapped cycle list', () => {
    const out = readableIssue(
      'forward cycle detected involving {n_a, n_d, stage_1} — the forward graph must be a DAG',
      [A, B, C, D],
      [],
      containers,
    );
    expect(out).toBe(
      'forward cycle detected involving {HTTP Request 1, HTTP Request 2, stage 1} — ' +
        'the forward graph must be a DAG',
    );
  });

  /**
   * #887 — the commonest reference error named ONE end by the drawn name and the
   * other by a raw uuid. Pass 5 names both without editing either: the `${…}`
   * span is byte-identical and the name arrives as a parenthetical after it.
   *
   * Glossing rather than rewriting is the whole point — `${nodes.HTTP Request
   * 2.output.body}` would name a string that is in nobody's config and is not
   * valid syntax.
   */
  it('glosses a node reference INSIDE an expression, leaving the expression byte-identical', () => {
    const out = readableIssue(
      'nodes.n_a.config.url: ${nodes.n_d.output.body} does not name an upstream node ' +
        '(a self, downstream, or unrelated node has no output here)',
      [A, B, C, D],
      [],
      containers,
    );
    expect(out).toBe(
      "node 'HTTP Request 1' config.url: ${nodes.n_d.output.body} (HTTP Request 2) " +
        'does not name an upstream node (a self, downstream, or unrelated node has no output here)',
    );
  });

  /**
   * A `${…}` body may legally contain `}` inside a string literal — `findRefEnd`
   * closes the span at the first UNQUOTED brace, its own docblock citing
   * `default(params.a, "b}c")`.
   *
   * This is the case that makes `scanTemplateRefs` load-bearing rather than
   * tidy. A `\$\{[^}]*\}` regex closes the span early, at the brace inside the
   * literal, and splices the gloss INTO the operator's string — corrupting the
   * exact text pass 5 exists to preserve. The gloss must land after the REAL
   * closing brace.
   */
  it('finds the true span end when a string literal inside it contains a brace', () => {
    const out = readableIssue(
      'nodes.n_a.config.url: ${default(nodes.n_d.output.body, "{}")} is not guaranteed here',
      [A, B, C, D],
      [],
      containers,
    );
    expect(out).toBe(
      'node \'HTTP Request 1\' config.url: ${default(nodes.n_d.output.body, "{}")} ' +
        '(HTTP Request 2) is not guaranteed here',
    );
  });

  /** A composed reference is still a reference — `params.ts:3707` emits the author's own source. */
  it('glosses a composed reference, and no longer leaves the expression wholly alone', () => {
    const msg = 'nodes.n_a.config.url: ${default(nodes.n_d.output.body, "x")} is malformed';
    expect(readableIssue(msg, [A, B, C, D], [], containers)).toBe(
      msg
        .replace('nodes.n_a.config.url', "node 'HTTP Request 1' config.url")
        .replace('"x")}', '"x")} (HTTP Request 2)'),
    );
  });

  /**
   * The carve-out that keeps this honest, and that
   * `e2e/canvas-issue-legibility.spec.ts` depends on: an id naming nothing on the
   * canvas has no name to gloss, so the message is returned untouched rather than
   * annotated with a guess.
   */
  it('adds no gloss when the referenced id resolves to nothing', () => {
    const msg = 'nodes.n_a.config.url: ${nodes.ghost.output.body} does not name an upstream node';
    expect(readableIssue(msg, [A, B, C, D], [], containers)).toBe(
      msg.replace('nodes.n_a.config.url', "node 'HTTP Request 1' config.url"),
    );
  });

  it('leaves a non-node expression root alone', () => {
    const msg = 'nodes.n_a.config.url: ${params.endpoint} is malformed';
    expect(readableIssue(msg, [A, B, C, D], [], containers)).toBe(
      msg.replace('nodes.n_a.config.url', "node 'HTTP Request 1' config.url"),
    );
  });

  it('glosses every span in a message, not just the first', () => {
    const out = readableIssue(
      'nodes.n_a.config.url: ${nodes.n_b.output.v} and ${nodes.n_d.output.v} are both unreachable',
      [A, B, C, D],
      [],
      containers,
    );
    expect(out).toBe(
      "node 'HTTP Request 1' config.url: ${nodes.n_b.output.v} (LLM Call 1) and " +
        '${nodes.n_d.output.v} (HTTP Request 2) are both unreachable',
    );
  });

  it('names every distinct node a single span references', () => {
    const out = readableIssue(
      'nodes.n_a.config.url: ${default(nodes.n_b.output.v, nodes.n_d.output.v)} is malformed',
      [A, B, C, D],
      [],
      containers,
    );
    expect(out).toContain('(LLM Call 1, HTTP Request 2)');
  });

  /**
   * The redundancy, pinned DELIBERATELY.
   *
   * The `.status` message quotes the id a second time, and pass 4 has already
   * turned that copy into the name — so the gloss repeats it. That is kept
   * because binding the uuid to the name is precisely what the reader cannot do
   * unaided; suppressing it here would make the one message that spells the
   * binding out look like the one message that forgot to gloss.
   */
  it('glosses the .status shape too, redundantly with the quoted pass and on purpose', () => {
    const out = readableIssue(
      "nodes.n_a.config.url: ${nodes.n_d.status} is not settled here — 'n_d' may still be running",
      [A, B, C, D],
      [],
      containers,
    );
    expect(out).toBe(
      "node 'HTTP Request 1' config.url: ${nodes.n_d.status} (HTTP Request 2) is not " +
        "settled here — 'HTTP Request 2' may still be running",
    );
  });
});

describe('consequenceMessage', () => {
  it('is null when the edit costs nothing — no dialog for a routine move', () => {
    expect(
      consequenceMessage({ newIssues: [], routingChange: null }, [A, B, C], [], [], 'undo me'),
    ).toBeNull();
  });

  it('states the routing flip in the operator’s terms', () => {
    const msg = consequenceMessage(
      { newIssues: [], routingChange: routingChangeBetween(doc(), doc({ containers: STAGE })) },
      [A, B, C],
      [],
      [],
      'undo me',
    );
    expect(msg).toContain('parallel roots');
    expect(msg).toContain('Apply it anyway?');
  });

  /**
   * #840 — the two arms that did not exist. Both sentences are QUALITATIVE: they
   * name no activity. `activityLabels` (#878) now mints a name that could be
   * enumerated and `RoutingChange` carries the ids, so this is a scope decision
   * deferred to #881 rather than the hard constraint it was; the assertion stays
   * to pin the sentence that ships today.
   */
  it('states a routing change between two partitioned shapes', () => {
    const before: Container[] = [{ id: 'stage_1', kind: 'stage', children: ['n_b', 'n_c'] }];
    const msg = consequenceMessage(
      {
        newIssues: [],
        routingChange: routingChangeBetween(
          doc({ containers: before }),
          doc({ containers: STAGE }),
        ),
      },
      [A, B, C],
      [],
      STAGE,
      'undo me',
    );
    expect(msg).toContain('changes that inferred routing');
    expect(msg).not.toContain('HTTP Request');
  });

  it('states the flip back to a single sequence when the last container goes', () => {
    const msg = consequenceMessage(
      { newIssues: [], routingChange: routingChangeBetween(doc({ containers: STAGE }), doc()) },
      [A, B, C],
      [],
      [],
      'undo me',
    );
    expect(msg).toContain('one sequence');
    expect(msg).toContain('Saving mints');
  });

  it('humanises every issue it lists and names the way back out', () => {
    const containers: Container[] = [{ id: 'stage_1', kind: 'stage', children: ['n_b'] }];
    const msg = consequenceMessage(
      { newIssues: [`edge 'e_ab': crosses a container boundary`], routingChange: null },
      [A, B, C],
      [AB],
      containers,
      'You can undo it by setting the activity back to — none —.',
    );
    expect(msg).toContain('HTTP Request 1 → LLM Call 1');
    expect(msg).not.toContain('e_ab');
    expect(msg).toContain('— none —');
  });

  /**
   * The recovery sentence is the CALLER's, because the two edits do not share
   * one. Following "set it back to — none —" after CREATING a loop empties it,
   * which is a worse doc than the one being escaped — so the create path names
   * the container's own delete instead.
   */
  it('states the recovery the CALLER gave it, verbatim', () => {
    const msg = consequenceMessage(
      { newIssues: [`container 'stage_1': broken`], routingChange: null },
      [A],
      [],
      [{ id: 'stage_1', kind: 'stage', children: [] }],
      'You can undo it with the ✕ on the container box.',
    );
    expect(msg).toContain('✕ on the container box');
    expect(msg).not.toContain('— none —');
  });

  it('states BOTH consequences when an edit has both', () => {
    const msg = consequenceMessage(
      {
        newIssues: [`container 'stage_1': child 'n_x' is not a node in this pipeline`],
        routingChange: routingChangeBetween(doc(), doc({ containers: STAGE })),
      },
      [A, B, C],
      [],
      [{ id: 'stage_1', kind: 'stage', children: [] }],
      'undo me',
    );
    expect(msg).toContain('parallel roots');
    expect(msg).toContain('unsavable');
  });
});
