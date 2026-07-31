import { describe, expect, it } from 'vitest';
import type { Container, Edge, Node } from '@autonomy-studio/shared';
import {
  consequenceMessage,
  containerEditConsequence,
  containerLabels,
  readableIssue,
  type ContainerEditDoc,
} from './containerRules';

const A: Node = { id: 'n_a', type: 'http_request', config: {}, position: { x: 0, y: 0 } };
const B: Node = { id: 'n_b', type: 'llm_call', config: {}, position: { x: 100, y: 0 } };
/** An activity the catalog does not know — the label falls back to its type. */
const C: Node = { id: 'n_c', type: 'not_in_catalog', config: {}, position: { x: 200, y: 0 } };

function doc(overrides: Partial<ContainerEditDoc> = {}): ContainerEditDoc {
  return { nodes: [A, B, C], edges: [], containers: [], params: [], ...overrides };
}

const AB: Edge = { id: 'e_ab', from: 'n_a', to: 'n_b', on: 'success' };

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
    expect(c.routingChange).toEqual({ from: 'chain', to: 'partitioned' });
  });

  it('reports no routing change once the doc has authored edges', () => {
    const next: Container[] = [{ id: 'stage_1', kind: 'stage', children: ['n_a', 'n_b'] }];
    expect(containerEditConsequence(doc({ edges: [AB] }), next).routingChange).toBeNull();
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

  it('falls back to the raw type for an activity the catalog does not know', () => {
    const out = readableIssue(`node 'n_c' is broken`, [C], [], []);
    expect(out).toBe(`node 'not_in_catalog' is broken`);
  });
});

describe('consequenceMessage', () => {
  it('is null when the edit costs nothing — no dialog for a routine move', () => {
    expect(
      consequenceMessage({ newIssues: [], routingChange: null }, [A, B, C], [], []),
    ).toBeNull();
  });

  it('states the routing flip in the operator’s terms', () => {
    const msg = consequenceMessage(
      { newIssues: [], routingChange: { from: 'chain', to: 'partitioned' } },
      [A, B, C],
      [],
      [],
    );
    expect(msg).toContain('parallel roots');
    expect(msg).toContain('Apply it anyway?');
  });

  it('humanises every issue it lists and names the way back out', () => {
    const containers: Container[] = [{ id: 'stage_1', kind: 'stage', children: ['n_b'] }];
    const msg = consequenceMessage(
      { newIssues: [`edge 'e_ab': crosses a container boundary`], routingChange: null },
      [A, B, C],
      [AB],
      containers,
    );
    expect(msg).toContain('HTTP Request → LLM Call');
    expect(msg).not.toContain('e_ab');
    expect(msg).toContain('— none —');
  });

  it('states BOTH consequences when an edit has both', () => {
    const msg = consequenceMessage(
      {
        newIssues: [`container 'stage_1': child 'n_x' is not a node in this pipeline`],
        routingChange: { from: 'chain', to: 'partitioned' },
      },
      [A, B, C],
      [],
      [{ id: 'stage_1', kind: 'stage', children: [] }],
    );
    expect(msg).toContain('parallel roots');
    expect(msg).toContain('unsavable');
  });
});
