/* The module's own SOURCE. Vite's `?raw` rather than `fs` — the web package's
   vitest environment is jsdom, where `import.meta.url` is an http URL and
   `readFile` cannot resolve it. */
import source from './ports.ts?raw';
import { describe, expect, it } from 'vitest';
import { EdgeOnSchema, type Node } from '@autonomy-studio/shared';
import {
  branchConditionsOf,
  conditionFromConnection,
  conditionLabel,
  CONNECTION_RADIUS,
  decodeConditionValue,
  declaredConditionsOf,
  DRAWN_EDGE_CONDITION,
  encodeCondition,
  HANDLE_SIZE,
  nodeBoxHeight,
  OPERATIONAL_CONDITIONS,
  orientDrawnEnds,
  SOURCE_PORT_PITCH,
  sourcePortOffset,
  sourcePortsOf,
  TARGET_PORT_ID,
} from './ports';

/**
 * U6b/U19 — the port contract, pinned where it is cheap.
 *
 * These look small because the failures they prevent are silent: an edge
 * declaring a `sourceHandle` no handle has is simply not rendered by React Flow
 * (no error, no warning, no line on the canvas), and an unauthorable
 * `DRAWN_EDGE_CONDITION` would make every DRAWN edge fail the save gate — after
 * the operator drew it.
 */

function node(id: string, type: string, config: Record<string, unknown> = {}): Node {
  return { id, type, config } as Node;
}

describe('canvas ports', () => {
  it('gives every port a DISTINCT non-empty id', () => {
    // React Flow resolves `sourceHandle`/`targetHandle` by id within a node, so
    // two ports sharing one make the pair ambiguous — and U19 puts up to a
    // dozen source ports on a single node.
    const ids = sourcePortsOf(node('a', 'http_request'), []).map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(TARGET_PORT_ID);
    expect(ids.every((id) => id.length > 0)).toBe(true);
  });

  /**
   * A gesture started on the TARGET port describes the same edge, reversed.
   *
   * React Flow normalises this before deciding validity, but hands
   * `onConnectEnd` the raw (origin, release) pair — so without this the refusal
   * REASON is computed for the opposite edge. On `a → b`: drawing the duplicate
   * backwards gets explained as a cycle, and drawing a cycle-closer backwards
   * yields NO message at all, because the reversed candidate is legal.
   */
  it('orients a connection source→target whichever port the drag started on', () => {
    expect(orientDrawnEnds('a', 'b', 'source')).toEqual({ from: 'a', to: 'b' });
    expect(orientDrawnEnds('b', 'a', 'target')).toEqual({ from: 'a', to: 'b' });
  });

  it('treats an unknown start port as a forward drag rather than guessing', () => {
    // `fromHandle` is typed nullable on RF's final connection state. Falling
    // back to "as reported" keeps the common gesture correct; inverting on
    // unknown would break it.
    expect(orientDrawnEnds('a', 'b', undefined)).toEqual({ from: 'a', to: 'b' });
  });

  it('draws edges on a condition the engine actually accepts', () => {
    // Not just "some string": the drawn condition has to survive `EdgeOnSchema`,
    // or every connection authors a doc the #444 write gate refuses.
    expect(DRAWN_EDGE_CONDITION.on).not.toBe('branch');
    expect(EdgeOnSchema.safeParse(DRAWN_EDGE_CONDITION.on).success).toBe(true);
    expect(OPERATIONAL_CONDITIONS).toContain(DRAWN_EDGE_CONDITION.on);
  });
});

describe('the condition⇄port codec', () => {
  it('round-trips every operational outcome', () => {
    for (const on of OPERATIONAL_CONDITIONS) {
      expect(decodeConditionValue(encodeCondition({ on }))).toEqual({ on });
    }
  });

  it('round-trips a branch label, keeping the two arms distinguishable', () => {
    // A `switch` case label is an ARBITRARY string, so `cases: ['success']` is a
    // legal doc: without the tag the two arms would encode identically and
    // picking the business branch would author the operational outcome.
    expect(encodeCondition({ on: 'branch', branch: 'success' })).not.toBe(
      encodeCondition({ on: 'success' }),
    );
    expect(decodeConditionValue(encodeCondition({ on: 'branch', branch: 'success' }))).toEqual({
      on: 'branch',
      branch: 'success',
    });
  });

  /**
   * The port id becomes a DOM attribute React Flow builds a CSS selector from —
   * `doc.querySelector('.react-flow__handle[data-id="…"]')`, on every pointer
   * move of every connection drag (`@xyflow/system` 0.0.79, index.js:2566).
   *
   * A `switch` case label is arbitrary and `validateSwitchConfig` reserves only
   * `default`, so a label containing a quote would inject a `SyntaxError` into
   * that selector and break connecting CANVAS-WIDE, not just on that node. It is
   * escaped to a selector-safe alphabet for exactly that reason; the human string
   * survives on
   * `SourcePort.label`.
   */
  it('encodes a branch label so it cannot break the selector React Flow builds', () => {
    for (const branch of ['a"b', "a'b", 'a b', 'a]b', 'a:b', 'a%b', 'a\\b']) {
      const id = encodeCondition({ on: 'branch', branch });
      expect(id).not.toMatch(/["'\\\s\]]/);
      expect(decodeConditionValue(id)).toEqual({ on: 'branch', branch });
    }
  });

  /**
   * A lone surrogate is a legally SAVABLE case label — `configSchema` is
   * `z.array(z.string())` and `validateSwitchConfig` refuses only `''` and the
   * reserved `default` — and `encodeURIComponent` throws a `URIError` on one.
   * The encoder is not allowed to throw: it runs inside a `useMemo` over EVERY
   * node on the canvas and again over every node on the run monitor, so one
   * malformed string in one imported doc would blank both views rather than
   * spoil one port.
   */
  it('never throws on a label a URI encoder would reject, and still round-trips it', () => {
    const lone = 'a\uD800b';
    const id = encodeCondition({ on: 'branch', branch: lone });
    expect(id).not.toMatch(/["'\\\s\]]/);
    expect(decodeConditionValue(id)).toEqual({ on: 'branch', branch: lone });
  });

  it('refuses a value that is not a condition rather than casting it', () => {
    // The value arrives from the DOM. A cast would put an off-enum string
    // straight into the doc.
    expect(decodeConditionValue('nonsense')).toBeNull();
    expect(decodeConditionValue('op:invented')).toBeNull();
    expect(decodeConditionValue('branch:')).toBeNull();
    // Malformed percent-escapes make `decodeURIComponent` THROW; a port id is
    // attacker-adjacent (git-imported doc) and must degrade, never crash.
    expect(decodeConditionValue('branch:%zz')).toBeNull();
  });

  it('labels a condition by its ROUTING KEY, not by the literal "branch"', () => {
    expect(conditionLabel({ on: 'failure' })).toBe('failure');
    expect(conditionLabel({ on: 'branch', branch: 'true' })).toBe('true');
  });
});

describe('declaredConditionsOf', () => {
  it('offers the four operational outcomes on an ordinary activity', () => {
    expect(declaredConditionsOf(node('a', 'http_request'))).toEqual(
      OPERATIONAL_CONDITIONS.map((on) => ({ on })),
    );
  });

  it("adds an `if`'s two arms", () => {
    const offered = declaredConditionsOf(node('a', 'if'));
    expect(offered.filter((c) => c.on === 'branch')).toEqual([
      { on: 'branch', branch: 'true' },
      { on: 'branch', branch: 'false' },
    ]);
  });

  it("adds a `switch`'s configured cases plus `default`", () => {
    const offered = declaredConditionsOf(
      node('a', 'switch', { on: '${x}', cases: ['red', 'blue'] }),
    );
    expect(offered.filter((c) => c.on === 'branch').map((c) => conditionLabel(c))).toEqual([
      'red',
      'blue',
      'default',
    ]);
  });

  it('offers the operational outcomes for a CONTAINER, which is not a node', () => {
    // A container is a legal edge endpoint (`connectRules`) but has no `Node`
    // to declare branches from. `undefined` must degrade to "no branches",
    // never throw and never invent one.
    expect(declaredConditionsOf(undefined)).toEqual(OPERATIONAL_CONDITIONS.map((on) => ({ on })));
  });
});

/**
 * The TRI-STATE both surfaces now read, pinned at the one place that decides it.
 *
 * `declaredConditionsOf` (the node's ports) and `EdgePanel`'s option list are
 * both derived from this, so that `declaredBranchesOf` is consulted once per
 * question and the two cannot come to disagree about what a source offers. What
 * only THIS function can express is
 * the difference between `null` — "this source can never emit a branch", which
 * hides the panel's branch group entirely — and a list, which shows it. The
 * canvas flattens `null` to "no branch ports", so the distinction is invisible
 * from `declaredConditionsOf` and has to be asserted here.
 */
describe('branchConditionsOf', () => {
  it('is null for an activity that can never emit a branch', () => {
    expect(branchConditionsOf(node('a', 'http_request'))).toBeNull();
  });

  it('is null for an absent source — a container, or a deleted node', () => {
    expect(branchConditionsOf(undefined)).toBeNull();
  });

  it('is the declared labels for a branching source', () => {
    expect(branchConditionsOf(node('a', 'if'))).toEqual([
      { on: 'branch', branch: 'true' },
      { on: 'branch', branch: 'false' },
    ]);
  });

  /* An EMPTY label is savable through the API (`declaredBranchesOf` filters on
     `typeof c === 'string'`, `validateSwitchConfig` additionally refuses `''`),
     and would draw a port with no visible text whose id no longer decodes. */
  it('drops an empty case label rather than drawing a nameless port', () => {
    const offered = branchConditionsOf(node('a', 'switch', { on: '${x}', cases: ['', 'red'] }));
    expect(offered?.map((c) => conditionLabel(c))).toEqual(['red', 'default']);
  });
});

describe('sourcePortsOf', () => {
  it('gives a port to every condition the source declares', () => {
    const ports = sourcePortsOf(node('a', 'if'), []);
    expect(ports.map((p) => p.label)).toEqual([...OPERATIONAL_CONDITIONS, 'true', 'false']);
    expect(ports.every((p) => !p.orphaned)).toBe(true);
  });

  /**
   * The silent failure this whole function exists to stop.
   *
   * `declaredBranchesOf` reads a `switch`'s `config.cases` LIVE, so renaming a
   * case in the node panel un-declares a branch an existing edge still routes
   * on. Without a port for it React Flow resolves that edge's `sourceHandle` to
   * nothing and simply does not draw the line — no error, no warning. The edge
   * is still in the doc, and `validateCanvas` is already badging the doc
   * unsavable; the canvas must not be the surface that hides it.
   */
  it('keeps a port for a condition an existing edge USES but the source no longer declares', () => {
    const ports = sourcePortsOf(node('a', 'switch', { on: '${x}', cases: ['red'] }), [
      { on: 'branch', branch: 'blue' },
    ]);
    const orphan = ports.find((p) => p.label === 'blue');
    expect(orphan).toBeDefined();
    expect(orphan?.orphaned).toBe(true);
    // ...and it is the LAST one, so an orphan never reorders the declared set.
    expect(ports.at(-1)).toBe(orphan);
  });

  it('does not duplicate a used condition that IS declared', () => {
    const ports = sourcePortsOf(node('a', 'http_request'), [{ on: 'failure' }, { on: 'failure' }]);
    expect(ports.filter((p) => p.label === 'failure')).toHaveLength(1);
    expect(ports).toHaveLength(OPERATIONAL_CONDITIONS.length);
  });

  it('ids each port with the encoded condition, so `toFlowEdge` can name it', () => {
    const ports = sourcePortsOf(node('a', 'if'), []);
    for (const p of ports) {
      expect(p.id).toBe(encodeCondition(p.condition));
      expect(decodeConditionValue(p.id)).toEqual(p.condition);
    }
  });
});

describe('port geometry', () => {
  it('spaces the ports symmetrically about the node centre', () => {
    expect(sourcePortOffset(0, 1)).toBe(0);
    expect(sourcePortOffset(0, 2)).toBe(-SOURCE_PORT_PITCH / 2);
    expect(sourcePortOffset(1, 2)).toBe(SOURCE_PORT_PITCH / 2);
    const four = [0, 1, 2, 3].map((i) => sourcePortOffset(i, 4));
    expect(four).toEqual([-1.5, -0.5, 0.5, 1.5].map((m) => m * SOURCE_PORT_PITCH));
  });

  /**
   * React Flow's `getClosestHandle` snaps a drag to any handle within
   * `connectionRadius`, skipping only the EXACT handle the drag started on
   * (`@xyflow/system` 0.0.79, index.js:2332). With sibling ports closer together
   * than that radius, starting a drag on `success` snaps to `failure` — the
   * gesture then reads as node-to-itself and pops the self-connect refusal for a
   * mis-click, and a backwards drag onto the column silently authors the wrong
   * outcome. The radius must therefore stay under HALF the pitch.
   */
  it('keeps the connection radius under half the port pitch', () => {
    expect(CONNECTION_RADIUS).toBeLessThan(SOURCE_PORT_PITCH / 2);
  });

  /**
   * Asserted against the GEOMETRY, not against `nodeBoxHeight`'s own arithmetic.
   * Restating the formula would pass for any formula, including the off-by-one
   * that shipped in the first draft of this file; what has to be true is that
   * the outermost dot fits inside the box `containerHandles` states and the CSS
   * draws.
   */
  it('grows the node box until every port FITS inside it', () => {
    for (const count of [1, 4, 8, 20]) {
      const outermost = Math.abs(sourcePortOffset(0, count));
      expect(outermost * 2 + HANDLE_SIZE).toBeLessThanOrEqual(nodeBoxHeight(count));
    }
    // Monotonic: a source that declares more outcomes is never drawn smaller.
    expect(nodeBoxHeight(8)).toBeGreaterThan(nodeBoxHeight(4));
    /* An ordinary activity — the four operational outcomes and nothing else —
       keeps the box it had before U19. Node placement staggers a new node only
       40px diagonally, so growing every node is what pushes each one into the
       previous one's port column. */
    expect(nodeBoxHeight(OPERATIONAL_CONDITIONS.length)).toBe(nodeBoxHeight(0));
  });
});

describe('conditionFromConnection', () => {
  /**
   * The one decision U19 moves out of the property panel and into the gesture.
   *
   * Extracted as a pure function because the gesture itself is NOT unit-testable
   * — jsdom measures every element as zero and React Flow culls unmeasured
   * nodes, so a `FlowCanvas` test asserting on a simulated drag asserts on
   * nothing. The gesture is covered by the e2e spec; the DECISION is covered
   * here.
   */
  it('reads the outcome off the port the drag started from', () => {
    expect(conditionFromConnection({ sourceHandle: encodeCondition({ on: 'failure' }) })).toEqual({
      on: 'failure',
    });
    expect(
      conditionFromConnection({ sourceHandle: encodeCondition({ on: 'branch', branch: 'true' }) }),
    ).toEqual({ on: 'branch', branch: 'true' });
  });

  /**
   * REFUSE, never guess. React Flow types `sourceHandle` as nullable and reads
   * it straight off a DOM attribute, so this arm is reachable rather than
   * defensive. Falling back to `success` here would author an outcome the
   * operator did not draw — and `isValidConnection` would have judged a
   * different candidate than the store authors, which is the exact disagreement
   * `DRAWN_EDGE_CONDITION` was made a single constant to prevent.
   */
  it('refuses a connection whose port says nothing decodable', () => {
    expect(conditionFromConnection({ sourceHandle: null })).toBeNull();
    expect(conditionFromConnection({ sourceHandle: undefined })).toBeNull();
    expect(conditionFromConnection({ sourceHandle: 'out' })).toBeNull();
  });
});

/**
 * The one-way dependency `edgeCondition → ports` that both modules' docblocks
 * claim, asserted against the SOURCE rather than left as a comment.
 *
 * U19 moved the condition⇄port codec here and `edgeCondition.ts` re-exports it,
 * so any value this module imports back from that one closes a genuine runtime
 * cycle. It closed once already: `usedConditionsBySource` called `conditionOf`,
 * which then still lived in `edgeCondition.ts`, and BOTH files carried a comment
 * saying no such import existed. It did not break, because each side is only
 * reached inside a function body rather than at module-evaluation time — which
 * is a property of today's call sites, not a guarantee.
 *
 * The repo has no `import/no-cycle` rule (that needs `eslint-plugin-import`,
 * which is not a dependency here), so this reads the file. A type-only import is
 * fine and expected: TypeScript erases it, so it is absent from the module graph
 * the browser actually evaluates.
 */
describe('module-graph direction', () => {
  it('imports NOTHING but types from edgeCondition — the other way is the re-export', () => {
    /* One statement per match: an import contains no `;` of its own, so
       `[^;]*` cannot run past the end of one — while it still spans the
       newlines of a multi-line brace list. */
    const statements = source.match(/^import[^;]*;$/gm) ?? [];
    const back = statements.filter((s) => s.includes("from './edgeCondition'"));
    // Present, or the assertion below would pass vacuously on a renamed path.
    expect(back).toHaveLength(1);
    expect(back[0]).toMatch(/^import type /);
  });
});
