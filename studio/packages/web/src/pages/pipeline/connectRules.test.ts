import { describe, expect, it } from 'vitest';
import {
  closesForwardCycle,
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
    expect(reject(g, ids[1], ids[0])?.message).toContain("'HTTP Request'");
    expect(reject(g, ids[1], ids[0])?.message).toContain("'Write File'");
    expect(reject(g, ids[0], ids[0])?.message).toContain("'HTTP Request'");
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

  it('a container-mediated path is not a cycle (the save gate accepts it, so this must)', () => {
    const g = graph(
      [node('a'), node('b'), node('t')],
      [edge('a', 'b'), edge('C', 't')],
      [{ id: 'C', kind: 'stage', children: ['a', 'b'] }],
    );
    expect(reject(g, 'b', 'C')).toBeNull();
  });
});
