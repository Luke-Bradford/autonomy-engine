import { describe, expect, it } from 'vitest';
import type { Container, Edge, Node, Param, PipelineVersion } from '../types.js';
import { SubstituteError } from '../types.js';
import { evalToolExpression, substitute, validateDoc, validateRefs } from '../params.js';
import { createEngine, type Engine, type EngineDoc } from '../reduce.js';
import type { EngineCommand, EngineEvent } from '../types.js';

// ===========================================================================
// #2 L10a — local tool contract: the `tool` expression root + deferred-eval
// `tools` subtree (save-time scoping, run-time evaluation, dispatch passthrough).
// ===========================================================================

// --- helpers ---------------------------------------------------------------

let seq = 0;
function node(id: string, config: Record<string, unknown> = {}, extra: Partial<Node> = {}): Node {
  seq += 1;
  return { id, type: 'agent_task', config, position: { x: seq, y: 0 }, ...extra };
}

function llm(id: string, config: Record<string, unknown>): Node {
  return node(id, config, { type: 'llm_call' });
}

function doc(
  nodes: Node[],
  edges: Edge[] = [],
  params: Param[] = [],
  containers: Container[] = [],
): Pick<PipelineVersion, 'params' | 'nodes' | 'edges' | 'containers'> {
  return { params, nodes, edges, containers };
}

/** A valid tool over two number args + one json arg. */
function adderTool(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    name: 'adder',
    description: 'Adds two numbers.',
    parameters: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
    },
    expression: '${add(tool.args.a, tool.args.b)}',
    ...over,
  };
}

// ===========================================================================
// evalToolExpression — the run-time half
// ===========================================================================

describe('evalToolExpression (#2 L10a)', () => {
  it('evaluates a whole-value expression over ${tool.args.*}', () => {
    expect(evalToolExpression('${add(tool.args.a, tool.args.b)}', { a: 2, b: 3 })).toBe(5);
  });

  it('preserves the native result type (array in, array out)', () => {
    expect(evalToolExpression('${take(tool.args.rows, 2)}', { rows: [1, 2, 3] })).toEqual([1, 2]);
  });

  it('binds ${item} inside a lambda arg over a tool-args array', () => {
    expect(
      evalToolExpression('${filter(tool.args.rows, greater(item, 2))}', { rows: [1, 2, 3, 4] }),
    ).toEqual([3, 4]);
  });

  it('deep-addresses into a json-typed arg', () => {
    expect(evalToolExpression('${tool.args.obj.inner}', { obj: { inner: 'x' } })).toBe('x');
  });

  it('throws on a non-whole-value expression (literal or interpolated)', () => {
    expect(() => evalToolExpression('plain text', {})).toThrow(SubstituteError);
    expect(() => evalToolExpression('n=${tool.args.a}', { a: 1 })).toThrow(SubstituteError);
  });

  it('throws on an unterminated ${', () => {
    expect(() => evalToolExpression('${add(tool.args.a', { a: 1 })).toThrow(SubstituteError);
  });

  it('throws on an arg name the tool call did not carry', () => {
    expect(() => evalToolExpression('${tool.args.missing}', { a: 1 })).toThrow(
      /declares no parameter named 'missing'/,
    );
  });

  it('refuses run-state roots — the env is args-only', () => {
    expect(() => evalToolExpression('${params.x}', {})).toThrow(SubstituteError);
    expect(() => evalToolExpression('${run.runId}', {})).toThrow(SubstituteError);
    expect(() => evalToolExpression('${nodes.a.output.x}', {})).toThrow(SubstituteError);
    expect(() => evalToolExpression('${item}', {})).toThrow(SubstituteError);
  });
});

describe('substitute — ${tool.*} is unbound outside a tool expression', () => {
  it('throws the context-scoping error for a ${tool.args.x} in ordinary config', () => {
    expect(() =>
      substitute('${tool.args.x}', {
        params: {},
        nodeOutputs: {},
        nodeStatuses: {},
        run: {},
        trigger: {},
      }),
    ).toThrow(/'tool' is only bound inside an llm_call tool expression/);
  });
});

// ===========================================================================
// validateRefs — the save-time half (scoped scan of tools[].expression)
// ===========================================================================

describe('validateRefs — llm_call tools (#2 L10a)', () => {
  it('accepts a valid tool expression over declared args', () => {
    const d = doc([llm('n', { prompt: 'hi', tools: [adderTool()] })]);
    expect(validateRefs(d)).toEqual([]);
  });

  it('rejects a ref to an undeclared tool parameter', () => {
    const d = doc([
      llm('n', { prompt: 'hi', tools: [adderTool({ expression: '${tool.args.missing}' })] }),
    ]);
    const errors = validateRefs(d);
    expect(errors.join(' ')).toMatch(/declares no parameter named 'missing'/);
  });

  it('rejects a run-state root inside a tool expression, even a declared param', () => {
    const d = doc(
      [llm('n', { prompt: 'hi', tools: [adderTool({ expression: '${params.p}' })] })],
      [],
      [{ name: 'p', type: 'string', required: false }],
    );
    const errors = validateRefs(d);
    expect(errors.join(' ')).toMatch(/tool expression may reference only/);
  });

  it('rejects ${tool.args.x} outside a tool expression (context-scoped)', () => {
    const d = doc([llm('n', { prompt: 'look at ${tool.args.a}', tools: [adderTool()] })]);
    const errors = validateRefs(d);
    expect(errors.join(' ')).toMatch(/context-scoped/);
  });

  it('still scans sibling config fields normally when tools are present', () => {
    const d = doc([llm('n', { prompt: 'about ${params.nope}', tools: [adderTool()] })]);
    const errors = validateRefs(d);
    expect(errors.join(' ')).toMatch(/params\.nope/);
  });

  it('rejects a non-whole-value tool expression', () => {
    const d = doc([
      llm('n', { prompt: 'hi', tools: [adderTool({ expression: 'sum: ${tool.args.a}' })] }),
    ]);
    const errors = validateRefs(d);
    expect(errors.join(' ')).toMatch(/whole-value/);
  });

  it('reports an unterminated ${ in a tool expression', () => {
    const d = doc([
      llm('n', { prompt: 'hi', tools: [adderTool({ expression: '${add(tool.args.a' })] }),
    ]);
    const errors = validateRefs(d);
    expect(errors.join(' ')).toMatch(/unterminated/);
  });

  it('does not crash on a malformed tools shape (validateDoc reports it)', () => {
    const d = doc([llm('n', { prompt: 'hi', tools: 'garbage' })]);
    expect(() => validateRefs(d)).not.toThrow();
  });
});

// ===========================================================================
// validateDoc — the tools config-surface diagnostics
// ===========================================================================

describe('validateDoc — llm_call tools surface (#2 L10a)', () => {
  it('accepts a valid tools declaration', () => {
    expect(validateDoc(doc([llm('n', { prompt: 'hi', tools: [adderTool()] })]))).toEqual([]);
  });

  it('rejects duplicate tool names', () => {
    const errors = validateDoc(
      doc([llm('n', { prompt: 'hi', tools: [adderTool(), adderTool()] })]),
    );
    expect(errors.join(' ')).toMatch(/duplicate tool name 'adder'/);
  });

  it('rejects toolChoice without tools', () => {
    const errors = validateDoc(doc([llm('n', { prompt: 'hi', toolChoice: 'auto' })]));
    expect(errors.join(' ')).toMatch(/toolChoice is only valid when tools are declared/);
  });

  it('rejects tools with structured output mode', () => {
    const errors = validateDoc(
      doc([
        llm('n', {
          prompt: 'hi',
          tools: [adderTool()],
          outputMode: 'structured',
          outputSchema: { type: 'object', properties: { x: { type: 'string' } } },
        }),
      ]),
    );
    expect(errors.join(' ')).toMatch(/tools are not supported with outputMode:'structured'/);
  });

  it('rejects a malformed ToolDef with a node-scoped diagnostic', () => {
    const errors = validateDoc(
      doc([llm('n', { prompt: 'hi', tools: [adderTool({ name: 'bad name' })] })]),
    );
    expect(errors.join(' ')).toMatch(/node\.n/);
    expect(errors.join(' ')).toMatch(/plain identifier/);
  });
});

// ===========================================================================
// prepInput — the tools subtree crosses dispatch RAW (deferred-eval)
// ===========================================================================

describe('reducer dispatch — tools subtree passes through unsubstituted (#2 L10a)', () => {
  function engine(nodes: Node[], edges: Edge[] = []): Engine {
    return createEngine({ nodes, edges, containers: [] } satisfies EngineDoc);
  }

  it('substitutes sibling config but re-attaches tools raw', () => {
    const tool = adderTool();
    const eng = engine([llm('n', { prompt: 'about ${params.topic}', tools: [tool] })]);
    let state = eng.seedState();
    const commands: EngineCommand[] = [];
    const apply = (ev: EngineEvent) => {
      const r = eng.reduce(state, ev);
      state = r.state;
      commands.push(...r.commands);
    };
    apply({ type: 'run.started', runId: 'r1', pipelineVersionId: 'pv1', params: { topic: 'x' } });
    const dispatch = commands.find((c) => c.type === 'dispatchNode');
    expect(dispatch?.type).toBe('dispatchNode');
    if (dispatch?.type === 'dispatchNode') {
      expect(dispatch.preparedInput.prompt).toBe('about x');
      // The tools subtree crosses RAW — `${tool.args.a}` inside the expression
      // must NOT have been walked by the blanket substitution (it would throw).
      expect(dispatch.preparedInput.tools).toEqual([tool]);
    }
  });
});
