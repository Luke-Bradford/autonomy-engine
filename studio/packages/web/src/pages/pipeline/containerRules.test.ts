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
    expect(out).toBe(`container 'stage 1': child 'HTTP Request' is not a node in this pipeline`);
  });

  it('names an edge by its ENDS, since an edge has no name of its own', () => {
    const out = readableIssue(
      `edge 'e_ab': crosses a container boundary`,
      [A, B, C],
      [AB],
      containers,
    );
    expect(out).toBe(`edge 'HTTP Request → LLM Call': crosses a container boundary`);
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
    expect(out).toBe(`node 'not_in_catalog' is broken`);
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
   * name no activity, because there is no identifying name to give one.
   * `activityLabel` is keyed on TYPE, so three `http_request` nodes are all
   * "HTTP Request" — enumerating them would be a confident false claim about
   * which activity moved, which is worse than describing the change in general.
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
    expect(msg).toContain('HTTP Request → LLM Call');
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
