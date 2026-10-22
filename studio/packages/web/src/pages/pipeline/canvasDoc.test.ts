import { describe, expect, it } from 'vitest';
import {
  type ConnectionPublic,
  type Edge,
  type EdgeOn,
  type Node,
  type Output,
  type Param,
} from '@autonomy-studio/shared';
import { PipelineVersionWriteSchema } from '../../api/pipelines';
import {
  canSave,
  descriptionIssues,
  userPropertiesIssues,
  nodePolicyIssues,
  policyIssues,
  saveDisabledReason,
  toVersionBody,
  validateCanvas,
  writeAccessWarnings,
} from './canvasDoc';

function node(id: string, config: Record<string, unknown> = {}): Node {
  return {
    id,
    type: 'http_request',
    config: { url: 'https://example.test/x', ...config },
    position: { x: 0, y: 0 },
  };
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
    const variables = [{ name: 'count', type: 'number' as const, default: 0 }];
    const annotations = ['prod'];
    const body = toVersionBody(
      nodes,
      edges,
      containers,
      params,
      outputs,
      variables,
      'Nightly load',
      annotations,
      'pv_basis',
    );

    // Every value is DISTINCT, so a transposed argument is red rather than
    // masked by two equal empty arrays. Five positional array parameters is
    // exactly the shape an ordering slip hides in.
    expect(body.params).toEqual(params);
    expect(body.outputs).toEqual(outputs);
    expect(body.containers).toEqual(containers);
    expect(body.nodes).toEqual(nodes);
    expect(body.edges).toEqual(edges);
    expect(body.variables).toEqual(variables);
    expect(body.description).toBe('Nightly load');
    expect(body.annotations).toEqual(annotations);

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
    expect(toVersionBody([], [], [], [], [], [], '', [], null)).not.toHaveProperty(
      'catalogVersion',
    );
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
    const body = toVersionBody([node('a')], [], [], [], [], [], '', [], null);
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
      [],
      'Nightly load',
      ['prod'],
      'pv_basis',
    );
    expect(() => PipelineVersionWriteSchema.parse(body)).not.toThrow();
  });
});

describe('validateCanvas', () => {
  it('a valid two-node success chain has no issues', () => {
    const nodes = [node('a'), node('b')];
    const edges = [edge('e', 'a', 'b')];
    expect(validateCanvas(nodes, edges, [], [], [], [])).toEqual([]);
  });

  it('an empty doc has no issues', () => {
    expect(validateCanvas([], [], [], [], [], [])).toEqual([]);
  });

  // #1480 — a version saved before the gate checked config still opens (reads
  // never validate), and Problems lists what a new save must fix: the same
  // validator the server gate runs, so the badge and the 400 agree.
  it('lists a config the adapter would refuse, as a version saved before #1480 holds', () => {
    const copy: Node = {
      id: 'load',
      type: 'copy',
      config: { mapping: [{ source: 'id', sink: 'id', type: 'integer' }], mode: 'merge' },
      position: { x: 0, y: 0 },
    };
    expect(validateCanvas([copy], [], [], [], [], [])).toEqual([
      expect.stringMatching(/^node 'load': config\.mode: /),
    ]);
  });

  // #844 V2 — the badge must agree with the server gate about `${vars.x}`,
  // which it can only do when it is handed the declared variables.
  it('accepts a declared ${vars.x} read, and badges an undeclared one', () => {
    const nodes = [{ ...node('a'), config: { url: '${vars.base}' } }];
    const base = [{ name: 'base', type: 'string' as const, default: 'https://a.test' }];
    expect(validateCanvas(nodes, [], [], [], base, [])).toEqual([]);
    expect(validateCanvas(nodes, [], [], [], [], [])).toEqual([
      expect.stringMatching(/\$\{vars\.base\} is not a declared variable/),
    ]);
  });

  // #844 GL3 — and about `${global.x}`, which it can only do when it is handed
  // the workspace's globals: any badge blocks Save.
  it('accepts a ${global.x} the workspace has, and badges one it does not', () => {
    const nodes = [{ ...node('a'), config: { url: '${global.apiUrl}/x' } }];
    const globals = [{ name: 'apiUrl', type: 'string' as const }];
    expect(validateCanvas(nodes, [], [], [], [], globals)).toEqual([]);
    expect(validateCanvas(nodes, [], [], [], [], [])).toEqual([
      expect.stringMatching(/\$\{global\.apiUrl\} is not a global parameter of this workspace/),
    ]);
    // Typed by the global's type, as the server types it.
    const typed = [{ ...node('a'), config: { url: '${not(global.apiUrl)}' } }];
    expect(validateCanvas(typed, [], [], [], [], globals).join(' ')).toMatch(/must be a boolean/);
  });

  it('surfaces a validateRefs error — a config ref to a non-existent node output', () => {
    // `a` references the output of a node that does not exist: validateRefs
    // rejects the ref ("does not name an upstream node").
    const nodes = [node('a', { url: '${nodes.ghost.output.body}' })];
    const issues = validateCanvas(nodes, [], [], [], [], []);
    expect(issues.length).toBeGreaterThan(0);
  });

  it('surfaces a validateDoc error — a forward cycle is refused', () => {
    const nodes = [node('a'), node('b')];
    const edges = [edge('e1', 'a', 'b'), edge('e2', 'b', 'a')];
    const issues = validateCanvas(nodes, edges, [], [], [], []);
    expect(issues.length).toBeGreaterThan(0);
  });

  // #843 — the badge, and therefore `canSave`, now bars a param default the run
  // would reject. It arrives here for free through `validatePipelineDoc`, which
  // is the point of `validateCanvas` delegating rather than re-implementing:
  // the canvas gains a server rule without a line of client code.
  it('bars a param default the run would reject (#843)', () => {
    const bad: Param[] = [{ name: 'n', type: 'number', required: false, default: 'abc' }];
    expect(validateCanvas([node('a')], [], [], bad, [], [])).toEqual([
      "param 'n': expected a finite number",
    ]);
  });

  it('does NOT bar a numeric string, which `coerce` accepts', () => {
    const fine: Param[] = [{ name: 'n', type: 'number', required: false, default: '5' }];
    expect(validateCanvas([node('a')], [], [], fine, [], [])).toEqual([]);
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

/**
 * #1141 — the REASON a save is refused, and the single place the refusal lives.
 *
 * `canSave` is derived from this, so the two can no longer disagree: before
 * #1141 the canvas wrote the four-term predicate out by hand at each of the two
 * buttons that save, and one of them (the conflict banner's override) had been
 * written with `issues` left out.
 *
 * The order mirrors `undoDisabledReason`/`arrangeDisabledReason` — busy, then
 * previewing, then not-ready, then the control's own availability — so the three
 * neighbouring controls answer in one grammar.
 */
describe('saveDisabledReason (#1141)', () => {
  const OK = { saving: false, ready: true, issues: [] as string[], previewing: null };

  it('gives no reason when a save can go ahead', () => {
    expect(saveDisabledReason(OK)).toBeNull();
  });

  it('names the ISSUES as the reason, and points at the badge list that lists them', () => {
    // The whole ticket: this arm is what the conflict banner's override was
    // missing, so an invalid doc reached `PipelineVersionWriteSchema.parse` and
    // came back as a raw ZodError.
    const reason = saveDisabledReason({ ...OK, issues: ["node 'c' needs a call config"] });
    expect(reason).toBe('Fix the 1 validation issue(s) in the Problems panel to save.');
  });

  it('counts the issues rather than saying "some"', () => {
    expect(saveDisabledReason({ ...OK, issues: ['a', 'b', 'c'] })).toBe(
      'Fix the 3 validation issue(s) in the Problems panel to save.',
    );
  });

  it('names the preview, the load and the save in flight', () => {
    expect(saveDisabledReason({ ...OK, previewing: 2 })).toBe(
      'Leave the preview to save your working graph.',
    );
    expect(saveDisabledReason({ ...OK, ready: false })).toBe('Wait for the pipeline to load.');
    expect(saveDisabledReason({ ...OK, saving: true })).toBe(
      'Wait for the save in flight to finish.',
    );
  });

  it('answers the BUSY reason first, so a save in flight is never reported as a stale doc', () => {
    // Reachable: the doc can badge while a save started before the edit is
    // still in flight. `previewing` x `saving` is NOT reachable (the banner's
    // Preview button is locked while saving), so no cell here asserts it.
    expect(saveDisabledReason({ saving: true, ready: true, issues: ['x'], previewing: null })).toBe(
      'Wait for the save in flight to finish.',
    );
    expect(
      saveDisabledReason({ saving: false, ready: false, issues: ['x'], previewing: null }),
    ).toBe('Wait for the pipeline to load.');
  });
});

describe('policyIssues + nodePolicyIssues (#1312)', () => {
  const withPolicy = (id: string, policy: Node['policy'], type = 'http_request'): Node => ({
    ...node(id),
    type,
    policy,
  });

  it('reports the write schema refusals the server would 400 on, attributed to the node', () => {
    expect(policyIssues([withPolicy('a', { retry: 2, retryIntervalSeconds: 60 })])).toEqual([]);
    const issues = policyIssues([
      withPolicy('a', { retryIntervalSeconds: 60 }),
      withPolicy('b', { retry: -1 }),
      withPolicy('c', { timeoutSeconds: 40_000_000 }),
      node('d'),
    ]);
    expect(issues).toHaveLength(3);
    expect(issues[0]).toMatch(
      /^node 'a': policy\.retryIntervalSeconds: .*has no effect without retry/,
    );
    expect(issues[1]).toMatch(/^node 'b': policy\.retry: /);
    expect(issues[2]).toMatch(/^node 'c': policy\.timeoutSeconds: .*one year/);
  });

  it('a pathless issue (an unknown key) reads `policy:` rather than `policy.:`', () => {
    const [issue] = policyIssues([withPolicy('a', { bogus: 1 } as Node['policy'])]);
    expect(issue).toMatch(/^node 'a': policy: /);
  });

  // COUPLING: `nodePolicyIssues` keys on the validator's MESSAGE FORMAT. These
  // cases run the REAL validator, so a reworded `validateSecurePolicy` or ref
  // refusal fails here instead of silently emptying the panel's list.
  it('picks out the secure-policy refusal validateDoc raises for this node', () => {
    const nodes = [withPolicy('i', { secureOutput: true }, 'if'), node('x')];
    const issues = validateCanvas(nodes, [], [], [], [], []);
    expect(nodePolicyIssues(issues, 'i', [])).toEqual([
      expect.stringMatching(/^node 'i': policy\.secureOutput is not supported on 'if'/),
    ]);
    expect(nodePolicyIssues(issues, 'x', [])).toEqual([]);
  });

  it('#1600 C0a — picks out the timeout refusal validateDoc raises for this node', () => {
    const nodes = [withPolicy('i', { timeoutSeconds: 60 }, 'if'), node('x')];
    const issues = validateCanvas(nodes, [], [], [], [], []);
    expect(nodePolicyIssues(issues, 'i', [])).toEqual([
      expect.stringMatching(/^node 'i': policy\.timeoutSeconds is not supported on 'if'/),
    ]);
    expect(nodePolicyIssues(issues, 'x', [])).toEqual([]);
  });

  it('picks out a downstream ref refused because this node (or its container) is secure', () => {
    const producer = withPolicy('p', { secureOutput: true });
    const consumer = node('c', { url: '${nodes.p.output.body}' });
    const issues = validateCanvas([producer, consumer], [edge('e', 'p', 'c')], [], [], [], []);
    expect(nodePolicyIssues(issues, 'p', [])).toEqual([
      expect.stringContaining("node 'p' has secure outputs"),
    ]);
    // The consumer's own panel is not where a producer's policy is explained.
    expect(nodePolicyIssues(issues, 'c', [])).toEqual([]);
    // A secure child makes its container secure; the child's panel owns that.
    const viaBox = ["node 'c': ${nodes.box.output.x} — node 'box' has secure outputs (…)"];
    expect(nodePolicyIssues(viaBox, 'p', ['box'])).toEqual(viaBox);
    expect(nodePolicyIssues(viaBox, 'p', [])).toEqual([]);
  });

  it("includes this node's own write-schema policy issues", () => {
    const issues = policyIssues([withPolicy('a', { retryIntervalSeconds: 60 })]);
    expect(nodePolicyIssues(issues, 'a', [])).toEqual(issues);
    expect(nodePolicyIssues(issues, 'ab', [])).toEqual([]);
  });
});

describe('descriptionIssues (#1600 OR41 C0b)', () => {
  it("names the node whose description the write schema would refuse, in the schema's words", () => {
    const at = (id: string, description: string): Node => ({ ...node(id), description });
    expect(descriptionIssues([at('a', 'x'.repeat(4000)), node('b')])).toEqual([]);
    expect(descriptionIssues([at('a', 'x'.repeat(4001))])).toEqual([
      "node 'a': description: the description can be at most 4000 characters",
    ]);
  });
});

describe('userPropertiesIssues (#1600 OR41 C0d)', () => {
  it("names the node and the row the write schema would refuse, in the schema's words", () => {
    const at = (id: string, userProperties: Node['userProperties']): Node => ({
      ...node(id),
      userProperties,
    });
    const five = Array.from({ length: 5 }, (_, i) => ({ name: `p${i}`, value: '' }));
    expect(userPropertiesIssues([at('a', five), node('b')])).toEqual([]);
    expect(userPropertiesIssues([at('a', [...five, { name: 'p5', value: '' }])])).toEqual([
      "node 'a': userProperties: an activity can have at most 5 user properties",
    ]);
    expect(
      userPropertiesIssues([
        at('a', [
          { name: 'x', value: '' },
          { name: 'x', value: '' },
        ]),
      ]),
    ).toEqual([
      "node 'a': userProperties[1].name: duplicate user property name 'x' (user property names must be unique within the activity)",
    ]);
  });
});

describe('writeAccessWarnings (#1600 OR41 C1b)', () => {
  const conn = (id: string, writable?: boolean, kind = 'fs'): ConnectionPublic =>
    ({
      id,
      name: `Conn ${id}`,
      kind,
      config: { roots: ['/d'], ...(writable === undefined ? {} : { writable }) },
    }) as unknown as ConnectionPublic;
  const copy = (
    id: string,
    connectionIds: { source: string; sink: string; log?: string },
    afterCopy = 'keep',
    extra: Partial<Node> = {},
  ): Node => ({
    ...node(id, { pathType: 'file', sourcePath: 'a', afterCopy }),
    type: 'copy_files',
    connectionIds,
    ...extra,
  });
  const connections = [
    conn('ro'),
    conn('rw', true),
    conn('no', false),
    conn('db', undefined, 'sqlite'),
  ];

  it('#1600 OR41 C10a — names a Script with a Non-query block on a sqlite connection that does not allow writes', () => {
    const script = (id: string, connectionId: string, type: string): Node => ({
      ...node(id, { blocks: [{ type, sql: 'delete from t' }] }),
      type: 'script',
      connectionId,
    });
    const scripts = [...connections, conn('dbrw', true, 'sqlite')];
    expect(
      writeAccessWarnings(
        [
          script('a', 'db', 'nonQuery'),
          script('b', 'db', 'query'),
          script('c', 'dbrw', 'nonQuery'),
        ],
        scripts,
      ),
    ).toEqual([
      "node 'a': the connection 'Conn db' does not allow writes, which a Non-query block needs",
    ]);
  });

  it('#1600 OR41 C10b-1 — names a Script with a Non-query block on a postgres connection that does not allow writes', () => {
    const script = (id: string, connectionId: string): Node => ({
      ...node(id, { blocks: [{ type: 'nonQuery', sql: 'delete from t' }] }),
      type: 'script',
      connectionId,
    });
    expect(
      writeAccessWarnings(
        [script('a', 'pg'), script('b', 'pgrw')],
        [conn('pg', undefined, 'postgres'), conn('pgrw', true, 'postgres')],
      ),
    ).toEqual([
      "node 'a': the connection 'Conn pg' does not allow writes, which a Non-query block needs",
    ]);
  });

  it('#1600 OR41 C6c-1a — names a folder log with no log connection, or one that does not allow writes', () => {
    const logged = (id: string, log?: string) =>
      copy(id, { source: 'rw', sink: 'rw', ...(log !== undefined && { log }) }, 'keep', {
        config: { pathType: 'file', sourcePath: 'a', logTo: 'folder', logFolder: 'l' },
      });
    expect(
      writeAccessWarnings([logged('a'), logged('b', 'ro'), logged('c', 'rw')], connections),
    ).toEqual([
      "node 'a': the session log is written to a folder, and no log connection is bound",
      "node 'b': the log connection 'Conn ro' does not allow writes, which a folder log needs",
    ]);
    // Not while the log is off or goes to the run log.
    const off = copy('d', { source: 'rw', sink: 'rw' }, 'keep', {
      config: { pathType: 'file', sourcePath: 'a', logLevel: 'off', logTo: 'folder' },
    });
    expect(
      writeAccessWarnings([off, copy('e', { source: 'rw', sink: 'rw' })], connections),
    ).toEqual([]);
  });

  it('#1600 OR41 C6c-1b — names a rows Copy folder log the same way, and nothing else of it', () => {
    const rows = (id: string, log?: string, config: Record<string, unknown> = {}): Node => ({
      ...node(id, { logTo: 'folder', logFolder: 'l', ...config }),
      type: 'copy',
      // A read-only fs source is no fault of a rows Copy's: it only reads it.
      connectionIds: { source: 'ro', sink: 'db', ...(log !== undefined && { log }) },
    });
    expect(
      writeAccessWarnings(
        [
          rows('a'),
          rows('b', 'ro'),
          rows('c', 'rw'),
          rows('d', undefined, { logTo: 'run' }),
          // A rows Copy has no After copy: a stray key is not a files copy's warning.
          rows('e', 'rw', { afterCopy: 'delete' }),
        ],
        connections,
      ),
    ).toEqual([
      "node 'a': the session log is written to a folder, and no log connection is bound",
      "node 'b': the log connection 'Conn ro' does not allow writes, which a folder log needs",
    ]);
  });

  it('names a copy whose sink does not allow writes, absent or false', () => {
    expect(
      writeAccessWarnings(
        [copy('a', { source: 'rw', sink: 'ro' }), copy('b', { source: 'rw', sink: 'no' })],
        connections,
      ),
    ).toEqual([
      "node 'a': the sink connection 'Conn ro' does not allow writes, which a files copy needs",
      "node 'b': the sink connection 'Conn no' does not allow writes, which a files copy needs",
    ]);
  });

  it('names a Delete whose connection does not allow writes (C9a), and skips an inactive one', () => {
    const del = (id: string, connectionId: string, extra: Partial<Node> = {}): Node => ({
      ...node(id, { path: 'in' }),
      type: 'delete',
      connectionId,
      ...extra,
    });
    expect(
      writeAccessWarnings(
        [
          del('a', 'ro'),
          del('b', 'rw'),
          del('c', 'ro', { state: 'inactive' }),
          del('d', '${pipeline.parameters.c}'),
        ],
        connections,
      ),
    ).toEqual(["node 'a': the connection 'Conn ro' does not allow writes, which a delete needs"]);
  });

  it('names the source only when After copy removes it, and once when it is the sink too', () => {
    expect(writeAccessWarnings([copy('a', { source: 'ro', sink: 'rw' })], connections)).toEqual([]);
    expect(
      writeAccessWarnings([copy('a', { source: 'ro', sink: 'rw' }, 'move')], connections),
    ).toEqual([
      "node 'a': After copy removes the source, which needs writes allowed on the source connection 'Conn ro'",
    ]);
    expect(
      writeAccessWarnings([copy('a', { source: 'ro', sink: 'ro' }, 'delete')], connections),
    ).toEqual([
      "node 'a': the sink connection 'Conn ro' does not allow writes, which a files copy needs",
    ]);
  });

  it('skips writable, unknown, dynamic and non-file connections, other types and inactive nodes', () => {
    expect(
      writeAccessWarnings(
        [
          copy('a', { source: 'rw', sink: 'rw' }, 'delete'),
          copy('b', { source: 'x', sink: '${pipeline.parameters.c}' }),
          copy('c', { source: 'db', sink: 'db' }),
          copy('d', { source: 'ro', sink: 'ro' }, 'keep', { state: 'inactive' }),
          { ...copy('e', { source: 'ro', sink: 'ro' }), type: 'copy' },
        ],
        connections,
      ),
    ).toEqual([]);
  });
});
