import { describe, expect, it } from 'vitest';
import {
  backEdgeDefect,
  closesForwardCycle,
  containerMembership,
  crossesContainerBoundary,
  FILE_WRITE_ACTIVITY_TYPE,
  type Container,
  type Edge,
  type Node,
} from '@autonomy-studio/shared';
import { connectRejection, precomputeConnect, type ConnectGraph } from './connectRules';

/**
 * U6b — the connect-time rules, unit-tested.
 *
 * These are the rules a connection DRAG is measured against, so every one of
 * them has to be decidable before the edge exists. The specs below pin two
 * things: which candidates are refused, and that the REASON is specific enough
 * to render (a refusal the operator cannot see is a control that silently does
 * nothing — U6a).
 */

function node(id: string, type = 'agent_task'): Node {
  return { id, type, config: {}, position: { x: 0, y: 0 } };
}
function edge(
  from: string,
  to: string,
  on: Edge['on'] = 'success',
  extra: Partial<Edge> = {},
): Edge {
  return { id: `${from}->${to}:${on}`, from, to, on, ...extra } as Edge;
}
function graph(nodes: Node[], edges: Edge[] = [], containers: Container[] = []): ConnectGraph {
  return { nodes, edges, containers };
}
/** The rejection for a plain forward `success` candidate. */
function reject(g: ConnectGraph, from: string, to: string) {
  return connectRejection(precomputeConnect(g), { from, to, condition: { on: 'success' } });
}

const CHAIN = graph([node('a'), node('b'), node('c')], [edge('a', 'b'), edge('b', 'c')]);

describe('connectRejection', () => {
  it('accepts a legal forward edge', () => {
    expect(reject(CHAIN, 'a', 'c')).toBeNull();
  });

  it('refuses a self-loop', () => {
    expect(reject(CHAIN, 'a', 'a')?.reason).toBe('self-loop');
  });

  /**
   * Every message names the ACTIVITY, never the internal node id.
   *
   * This spec exists because the browser caught what these fixtures hid: real
   * ids come from `newLocalId` (`n_7c44a16f-98f1-4958-…`), so the refusal panel
   * shipped its first draft reading *"'n_7c44a16f-…' → 'n_9c4bb103-…' would close
   * a forward cycle"*. Fixtures named `'a'` and `'b'` make an
   * `expect(message).toContain("'a'")` assertion pass either way — which is
   * exactly how a message can be "tested" and still be unreadable. So the ids
   * here are deliberately id-SHAPED, and the assertion is that they do NOT
   * appear.
   */
  it('names endpoints by ACTIVITY, and never leaks a raw node id', () => {
    const ids = ['n_7c44a16f-98f1-4958', 'n_9c4bb103-23dc-4965'] as const;
    const g = graph(
      [node(ids[0], 'http_request'), node(ids[1], FILE_WRITE_ACTIVITY_TYPE)],
      [edge(ids[0], ids[1])],
    );
    for (const [from, to] of [
      [ids[1], ids[0]], // cycle
      [ids[0], ids[1]], // duplicate
      [ids[0], ids[0]], // self-loop
    ] as const) {
      const message = reject(g, from, to)?.message ?? '';
      expect(message).not.toBe('');
      for (const id of ids) expect(message, `leaks ${id}`).not.toContain(id);
    }
    expect(reject(g, ids[1], ids[0])?.message).toContain("'HTTP Request 1'");
    expect(reject(g, ids[1], ids[0])?.message).toContain("'Write File 1'");
    expect(reject(g, ids[0], ids[0])?.message).toContain("'HTTP Request 1'");
  });

  /**
   * #878 — the same defect one turn on. Naming both ends "HTTP Request" is
   * literally true and no more actionable than the two uuids the label replaced,
   * and a chain of same-type activities is a graph an operator really builds.
   */
  it('tells two endpoints of the SAME activity type apart', () => {
    const ids = ['n_7c44a16f-98f1-4958', 'n_9c4bb103-23dc-4965'] as const;
    const g = graph(
      [node(ids[0], 'http_request'), node(ids[1], 'http_request')],
      [edge(ids[0], ids[1])],
    );
    const message = reject(g, ids[1], ids[0])?.message ?? '';
    expect(message).toContain("'HTTP Request 1'");
    expect(message).toContain("'HTTP Request 2'");
    for (const id of ids) expect(message, `leaks ${id}`).not.toContain(id);
  });

  /**
   * An endpoint with no node — a container id, which IS a legal edge endpoint —
   * has no activity to name, and must degrade to the id rather than to `undefined`
   * or an invented label.
   */
  it('falls back to the raw id for an endpoint that is not a node', () => {
    expect(reject(CHAIN, 'ghost', 'a')?.message).toContain("'ghost'");
  });

  it('refuses an endpoint that is not on the canvas', () => {
    expect(reject(CHAIN, 'a', 'ghost')?.reason).toBe('unknown-endpoint');
    expect(reject(CHAIN, 'ghost', 'a')?.reason).toBe('unknown-endpoint');
    expect(reject(CHAIN, 'ghost', 'a')?.message).toContain("'ghost'");
  });

  it('refuses a DUPLICATE (same from/to/condition), and names the condition', () => {
    const r = reject(CHAIN, 'a', 'b');
    expect(r?.reason).toBe('duplicate');
    expect(r?.message).toContain('success');
  });

  /**
   * The same pair with a DIFFERENT condition is not a duplicate — the doc
   * allows `a -success-> b` and `a -failure-> b` side by side. The canvas
   * cannot DRAW the second one today (a drawn edge is always `success` until
   * U19 gives each outcome its own source handle), but the rule must not be the
   * thing that forbids it, or U19 inherits a false refusal.
   */
  it('does NOT treat a different condition on the same pair as a duplicate', () => {
    expect(
      connectRejection(precomputeConnect(CHAIN), {
        from: 'a',
        to: 'b',
        condition: { on: 'failure' },
      }),
    ).toBeNull();
  });

  it('distinguishes a business branch from an operational outcome of the same name', () => {
    // `cases: ['success']` is a legal switch doc (U6a), so `branch:success` and
    // `op:success` are different edges and only one of them is taken.
    const g = graph([node('a'), node('b')], [edge('a', 'b', 'branch', { branch: 'success' })]);
    expect(
      connectRejection(precomputeConnect(g), { from: 'a', to: 'b', condition: { on: 'success' } }),
    ).toBeNull();
    expect(
      connectRejection(precomputeConnect(g), {
        from: 'a',
        to: 'b',
        condition: { on: 'branch', branch: 'success' },
      })?.reason,
    ).toBe('duplicate');
  });

  it('refuses an edge that would close a forward cycle, and points at the back-edge path', () => {
    const r = reject(CHAIN, 'c', 'a');
    expect(r?.reason).toBe('forward-cycle');
    // The engine's own guidance: a loop is a back-edge with a cap. Without it
    // the refusal reads as "this tool cannot express a loop".
    expect(r?.message).toContain('back-edge');
    expect(r?.message).toContain('maxBounces');
    expect(r?.message).toContain('loop');
  });

  it('exempts a BACK-edge from the cycle rule — that is how a loop is authored', () => {
    expect(
      connectRejection(precomputeConnect(CHAIN), {
        from: 'c',
        to: 'a',
        condition: { on: 'success' },
        back: true,
      }),
    ).toBeNull();
  });

  it('a self-loop is refused as a self-loop even as a back-edge (ancestry can never hold)', () => {
    expect(
      connectRejection(precomputeConnect(CHAIN), {
        from: 'a',
        to: 'a',
        condition: { on: 'success' },
        back: true,
      })?.reason,
    ).toBe('self-loop');
  });

  /**
   * The cycle rule delegates to the shared `closesForwardCycle`, which is a
   * DELTA over the save gate's own DAG rule. Asserted here as an equivalence so
   * this module can never grow its own second opinion about what a cycle is.
   */
  it('its cycle verdict IS the shared predicate, not a local re-derivation', () => {
    const pairs: [string, string][] = [
      ['a', 'c'],
      ['c', 'a'],
      ['b', 'a'],
      ['a', 'b'],
    ];
    for (const [from, to] of pairs) {
      const shared = closesForwardCycle(CHAIN, CHAIN.containers, from, to);
      const local = reject(CHAIN, from, to)?.reason === 'forward-cycle';
      // `a -> b` is a duplicate, so it is refused EARLIER than the cycle rule;
      // the equivalence claim is only about candidates the earlier rules pass.
      if (reject(CHAIN, from, to)?.reason === 'duplicate') continue;
      expect(local).toBe(shared);
    }
  });

  /**
   * A container-mediated path is not a CYCLE — the point this spec was written
   * for (U6b), and still true.
   *
   * Its original parenthetical, "(the save gate accepts it, so this must)", was
   * NOT true and is corrected here. `validatePipelineDoc` refuses this very doc:
   * *"edge 'e2': crosses a container boundary 'b' (child of 'C') → 'C'"*. The
   * spec only ever demonstrated that the cycle rule stays quiet, while the gate
   * refused the save for a different reason the canvas could not yet see — the
   * draw-it-then-learn-it-is-unsavable gap U6b set out to close and could not,
   * because container membership was not rendered. U6c renders it, so the rule
   * lands and the expectation becomes a REFUSAL with the specific reason.
   */
  it('a container-mediated path is not a cycle — it is refused as a BOUNDARY crossing', () => {
    const g = graph(
      [node('a'), node('b'), node('t')],
      [edge('a', 'b'), edge('C', 't')],
      [{ id: 'C', kind: 'stage', children: ['a', 'b'] }],
    );
    expect(closesForwardCycle(g, g.containers, 'b', 'C')).toBe(false);
    expect(reject(g, 'b', 'C')?.reason).toBe('container-boundary');
  });
});

/**
 * U6c — the container-BOUNDARY rule.
 *
 * U6b deliberately left this out and named U6c/U6d as its owner: the rule was
 * real and the save gate already enforced it, but container membership was not
 * RENDERED, so a refusal's cause would have been invisible — the operator would
 * have been told two activities cannot connect with no way to see the box that
 * explains why. U6c draws the box, so the rule can now be stated.
 */
describe('connectRejection — container boundaries', () => {
  const CONTAINED = graph(
    [node('inside'), node('sibling'), node('outside')],
    [],
    [{ id: 'C', kind: 'stage', children: ['inside', 'sibling'] }],
  );

  it('refuses a child connecting OUT to a top-level node', () => {
    expect(reject(CONTAINED, 'inside', 'outside')?.reason).toBe('container-boundary');
  });

  it('refuses a top-level node connecting IN to a child', () => {
    expect(reject(CONTAINED, 'outside', 'inside')?.reason).toBe('container-boundary');
  });

  it('allows two children of the same container', () => {
    expect(reject(CONTAINED, 'inside', 'sibling')).toBeNull();
  });

  it('allows a top-level node to connect to the CONTAINER itself', () => {
    expect(reject(CONTAINED, 'outside', 'C')).toBeNull();
  });

  it('refuses children of DIFFERENT containers', () => {
    const g = graph(
      [node('a'), node('b')],
      [],
      [
        { id: 'C', kind: 'stage', children: ['a'] },
        { id: 'D', kind: 'stage', children: ['b'] },
      ],
    );
    expect(reject(g, 'a', 'b')?.reason).toBe('container-boundary');
  });

  /**
   * A back-edge may legally cross — a child back-edging to its enclosing
   * container is the loop idiom, and the save gate exempts it (`if (e.back)
   * continue`). The exemption is the CALLER's, because the shared predicate is
   * condition-only, so it has to be pinned at this level too.
   */
  it('exempts a back-edge to the ENCLOSING container', () => {
    const pre = precomputeConnect(CONTAINED);
    const candidate = { from: 'inside', to: 'C', condition: { on: 'success' } as const };
    expect(connectRejection(pre, candidate)?.reason).toBe('container-boundary');
    expect(connectRejection(pre, { ...candidate, back: true })).toBeNull();
  });

  /**
   * The exemption is from the BOUNDARY rule, not a blanket pass (U6e).
   *
   * This case is why the assertion above had to change its target: it used to
   * cross to a sibling-level node (`inside` → `outside`) and expect `null`,
   * which pinned the INCOMPLETENESS — `back: true` turned two rules off and
   * nothing back on, so the canvas would have been free to author an edge the
   * save gate refuses for ancestry. The docblock above always described the
   * enclosing-container idiom; the fixture just never matched it.
   */
  it('does not let back-ness excuse a crossing that is no loop at all', () => {
    const pre = precomputeConnect(CONTAINED);
    const candidate = { from: 'inside', to: 'outside', condition: { on: 'success' } as const };
    expect(connectRejection(pre, candidate)?.reason).toBe('container-boundary');
    expect(connectRejection(pre, { ...candidate, back: true })?.reason).toBe('back-ancestry');
  });

  /**
   * ORDER IS THE MESSAGE, the same principle the U6b rules are ordered by. A
   * candidate that both crosses a boundary and closes a cycle is reported as the
   * boundary crossing: it is the narrower, more actionable fact, and it is the
   * one the operator can see on screen now that the box is drawn.
   */
  it('reports the boundary crossing in preference to a cycle', () => {
    const g = graph(
      [node('a'), node('b')],
      [edge('b', 'a')],
      [{ id: 'C', kind: 'stage', children: ['a'] }],
    );
    expect(closesForwardCycle(g, g.containers, 'a', 'b')).toBe(true);
    expect(reject(g, 'a', 'b')?.reason).toBe('container-boundary');
  });

  /**
   * The naming defect U6b's browser pass found, in its container form. A
   * container id is minted the same way a node id is, so a message that fell
   * through to the raw id would read *"…leaves 'c_7c44a16f-98f1-…'"*. There is no
   * activity to name a container by, so it is named by its KIND — which is also
   * exactly what the box on screen is labelled with, so the sentence points at
   * something the operator can see.
   */
  it('names a container by KIND, never by its raw id', () => {
    const id = 'c_7c44a16f-98f1-4958-9a1e-0d4f2b6c8e11';
    const g = graph(
      [
        node('n_9c4bb103-23dc-4c1a-bb2e-1f7a5d3e9c22'),
        node('n_1a2b3c4d-5e6f-4708-9a0b-c1d2e3f4a5b6'),
      ],
      [],
      [
        {
          id,
          kind: 'loop',
          children: ['n_9c4bb103-23dc-4c1a-bb2e-1f7a5d3e9c22'],
          exitWhen: '${true}',
        },
      ],
    );
    const message = reject(
      g,
      'n_9c4bb103-23dc-4c1a-bb2e-1f7a5d3e9c22',
      'n_1a2b3c4d-5e6f-4708-9a0b-c1d2e3f4a5b6',
    )?.message;
    expect(message).toBeDefined();
    expect(message).toContain('loop');
    expect(message).not.toContain(id);
  });

  /**
   * Naming by KIND is right until there are two of a kind, and then it says
   * nothing: *"they are in different containers (the stage container and the
   * stage container)"* reads as a contradiction. The id cannot be the
   * disambiguator — the test above exists precisely because a raw `c_<uuid>` is
   * unreadable — so the sentence disambiguates by what the operator CAN see on
   * the canvas: the two nodes it already names.
   */
  it('does not name two containers of the same kind identically', () => {
    const g = graph(
      [node('a'), node('b')],
      [],
      [
        { id: 'c_11111111-1111-4111-8111-111111111111', kind: 'stage', children: ['a'] },
        { id: 'c_22222222-2222-4222-8222-222222222222', kind: 'stage', children: ['b'] },
      ],
    );
    const message = reject(g, 'a', 'b')?.message;
    expect(message).toBeDefined();
    expect(message).not.toContain('the stage container and the stage container');
    expect(message).toContain('different stage containers');
    expect(message).not.toContain('c_11111111');
    expect(message).not.toContain('c_22222222');
  });

  /** Two DIFFERENT kinds still name both, since the kinds already distinguish them. */
  it('names both kinds when the two containers differ', () => {
    const g = graph(
      [node('a'), node('b')],
      [],
      [
        { id: 'C', kind: 'loop', children: ['a'], exitWhen: '${true}' },
        { id: 'D', kind: 'stage', children: ['b'] },
      ],
    );
    const message = reject(g, 'a', 'b')?.message;
    expect(message).toContain('the loop container');
    expect(message).toContain('the stage container');
  });

  /**
   * The fix-up suggestion has to match the case it is appended to. "Connect the
   * container itself instead, so the outside step waits for the whole container
   * to finish" is right when ONE end is enclosed — and false when both are,
   * because then there is no outside step to wait.
   */
  it('does not offer an "outside step" when BOTH ends are enclosed', () => {
    const g = graph(
      [node('a'), node('b')],
      [],
      [
        { id: 'C', kind: 'loop', children: ['a'], exitWhen: '${true}' },
        { id: 'D', kind: 'stage', children: ['b'] },
      ],
    );
    const message = reject(g, 'a', 'b')?.message;
    expect(message).toBeDefined();
    expect(message).not.toContain('outside step');
    expect(message).toContain('Connect the containers themselves instead');
  });

  /** ...and the one-sided case, which the suggestion was written for, keeps it. */
  it('keeps the "outside step" suggestion when only one end is enclosed', () => {
    const message = reject(CONTAINED, 'inside', 'outside')?.message;
    expect(message).toContain('Connect the container itself instead');
    expect(message).toContain('outside step');
  });

  /**
   * Equivalence with the shared predicate, the same anti-drift assertion the
   * cycle rule carries: this module must never grow a second opinion about what
   * a boundary is.
   */
  it('its boundary verdict IS the shared predicate', () => {
    const owner = containerMembership(CONTAINED.containers).owner;
    const pairs: [string, string][] = [
      ['inside', 'outside'],
      ['outside', 'inside'],
      ['inside', 'sibling'],
      ['outside', 'C'],
      ['inside', 'C'],
    ];
    for (const [from, to] of pairs) {
      const shared = crossesContainerBoundary(owner, from, to);
      const local = reject(CONTAINED, from, to)?.reason === 'container-boundary';
      expect(local).toBe(shared);
    }
  });
});

/**
 * U6e — a `back: true` CANDIDATE.
 *
 * Until this ticket the flag only ever EXEMPTED a candidate: it turned off the
 * container-boundary and forward-DAG rules and then accepted whatever was left,
 * with no back-edge rule of its own. That was harmless while nothing could
 * author one; it stops being harmless the moment the canvas offers to.
 *
 * The only caller is the offer's enabled-ness check in `FlowCanvas` — a DRAG
 * always carries `DRAWN_EDGE_CONDITION` with `back` unset — so these reasons
 * look unreachable from a gesture and are not. Deleting them as dead would put
 * back the ability to author an unsavable version.
 */
describe('connectRejection — back-edge candidates (U6e)', () => {
  /** The rejection for a candidate the operator has asked to make a back-edge. */
  function rejectBack(g: ConnectGraph, from: string, to: string) {
    return connectRejection(precomputeConnect(g), {
      from,
      to,
      condition: { on: 'success' },
      back: true,
    });
  }

  it('accepts the retry loop the forward rule refuses', () => {
    expect(reject(CHAIN, 'c', 'a')?.reason).toBe('forward-cycle');
    expect(rejectBack(CHAIN, 'c', 'a')).toBeNull();
  });

  it('accepts a child back-edging to its own enclosing container', () => {
    const g = graph(
      [node('w'), node('after')],
      [edge('L', 'after')],
      [{ id: 'L', kind: 'loop', exitWhen: '${true}', children: ['w'] }],
    );
    // The forward candidate is refused for crossing the boundary; the back one
    // is the loop idiom, and is the ONLY way to author it.
    expect(reject(g, 'w', 'L')?.reason).toBe('container-boundary');
    expect(rejectBack(g, 'w', 'L')).toBeNull();
  });

  it('refuses a target that is not an ancestor, naming both ends', () => {
    const g = graph([node('a'), node('b'), node('c')], [edge('a', 'b')]);
    const r = rejectBack(g, 'b', 'c');
    expect(r?.reason).toBe('back-ancestry');
    expect(r?.message).toContain('c');
  });

  /**
   * Cycle-closure implies ancestry but NOT progress: the reset body is computed
   * over a NODE-only adjacency, so a cycle whose path runs through a container
   * endpoint leaves the source out of its own reset body. Without this arm the
   * offer would author a doc the save gate refuses.
   */
  it('refuses a container-mediated cycle whose bounce would reset nothing', () => {
    const g = graph(
      [node('a'), node('b'), node('x')],
      [edge('a', 'C'), edge('C', 'b')],
      [{ id: 'C', kind: 'stage', children: ['x'] }],
    );
    expect(reject(g, 'b', 'a')?.reason).toBe('forward-cycle');
    expect(rejectBack(g, 'b', 'a')?.reason).toBe('back-no-progress');
  });

  it('refuses a back-edge touching a PARALLEL foreach body', () => {
    const g = graph(
      [node('a'), node('item')],
      [edge('a', 'F')],
      [
        {
          id: 'F',
          kind: 'foreach',
          items: '${params.xs}',
          batchCount: 2,
          children: ['item'],
        } as Container,
      ],
    );
    expect(rejectBack(g, 'item', 'F')?.reason).toBe('back-parallel-body');
  });

  it('still refuses a self-loop, which back-ness cannot excuse', () => {
    // The ancestry rule would refuse this too, but the self-loop reason is the
    // one that can suggest a loop container, so it must stay the narrower answer.
    expect(rejectBack(CHAIN, 'a', 'a')?.reason).toBe('self-loop');
  });

  /**
   * A back-edge is NOT a duplicate of its forward twin — `authoringEdgeKey`
   * keys back-ness, deliberately, because the two are different edges (one is
   * in the forward graph, one is not) and `a → b` plus `b →back a` is the
   * ordinary retry loop. The duplicate rule still applies BETWEEN back-edges.
   */
  it('does not read a back-edge as a duplicate of its forward twin, but does of another back-edge', () => {
    expect(rejectBack(CHAIN, 'c', 'a')).toBeNull();
    const withBack = graph(
      CHAIN.nodes,
      [...CHAIN.edges, edge('c', 'a', 'success', { back: true, maxBounces: 3 })],
      [],
    );
    expect(rejectBack(withBack, 'c', 'a')?.reason).toBe('duplicate');
  });

  /**
   * Anti-drift, the shape the cycle and boundary rules already carry: this
   * module must never grow a second opinion about what a legal back-edge is.
   */
  it('its back-edge verdict IS the shared predicate', () => {
    const g = graph(
      [node('a'), node('b'), node('x')],
      [edge('a', 'C'), edge('C', 'b')],
      [{ id: 'C', kind: 'stage', children: ['x'] }],
    );
    const pairs: [string, string][] = [
      ['b', 'a'],
      ['b', 'x'],
      ['x', 'C'],
      ['a', 'b'],
    ];
    for (const [from, to] of pairs) {
      const shared = backEdgeDefect(g, g.containers, from, to);
      const local = rejectBack(g, from, to);
      expect(local === null, `${from}->${to} shared=${String(shared)}`).toBe(shared === null);
    }
  });
});
