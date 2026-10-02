import { describe, expect, it } from 'vitest';
import type { GlobalParamType } from '../../schemas/pipeline.js';
import type { Container, EngineEvent, Node, SubstitutionContext } from '../types.js';
import { SubstituteError } from '../types.js';
import {
  GLOBAL_SNAPSHOT_MAX_BYTES,
  globalParamNameDefect,
  globalSnapshotDefect,
  substitute,
  validateRefs,
  validateTriggerBindings,
  variableReadsOf,
} from '../params.js';
import { validatePipelineDoc } from '../validate-pipeline.js';
import { createEngine } from '../reduce.js';

/**
 * #844 GL3 — READING workspace global parameters (spec
 * `2026-09-27-foundation-global-params.md` GL-D2/GL-D3). `${global.<name>}` is
 * a root of its own; the save gate is handed the owner's globals, and a run
 * reads only the values its `run.started` event logged.
 */

let seq = 0;
function node(id: string, config: Record<string, unknown> = {}, extra: Partial<Node> = {}): Node {
  seq += 1;
  return {
    id,
    type: 'agent_task',
    config: { task: 't', ...config },
    position: { x: seq, y: 0 },
    ...extra,
  };
}

const GLOBALS = new Map<string, GlobalParamType>([
  ['apiUrl', 'string'],
  ['retries', 'number'],
  ['live', 'boolean'],
  ['cfg', 'json'],
]);

function doc(nodes: Node[], containers: Container[] = []) {
  return { params: [], nodes, edges: [], containers, variables: [] };
}

function errorsOf(nodes: Node[], containers: Container[] = []): string {
  return validatePipelineDoc(doc(nodes, containers), { globals: GLOBALS }).join('\n');
}

function ctx(globals: Record<string, unknown>): SubstitutionContext {
  return {
    params: {},
    nodeOutputs: {},
    nodeStatuses: {},
    run: {},
    trigger: {},
    variables: {},
    globals,
  };
}

describe('${global.<name>} at run time', () => {
  it('resolves a global from the context', () => {
    expect(substitute('${global.apiUrl}', ctx({ apiUrl: 'https://x' }))).toBe('https://x');
    expect(substitute('n=${global.retries}', ctx({ retries: 3 }))).toBe('n=3');
    expect(substitute('${global.cfg.a[1]}', ctx({ cfg: { a: [1, 2] } }))).toBe(2);
  });

  // A run's globals are the snapshot its start took of exactly the reads its
  // version recorded, so an unknown one is an authoring error. It must not be
  // a `MissingValueError`, which `default()` would turn into a silent fallback.
  it('refuses an unknown global, and default() does not rescue it', () => {
    expect(() => substitute('${global.nope}', ctx({}))).toThrow(SubstituteError);
    expect(() => substitute('${default(global.nope, 1)}', ctx({}))).toThrow(
      /unknown global parameter reference/,
    );
  });

  it('does not read an inherited property as a global', () => {
    expect(() => substitute('${global.toString}', ctx({}))).toThrow(
      /unknown global parameter reference/,
    );
  });
});

describe('${global.<name>} at save time', () => {
  it('accepts a global of the workspace in a node config', () => {
    expect(errorsOf([node('a', { x: '${global.apiUrl}', y: 'n=${global.retries}' })])).toBe('');
  });

  it('refuses a name the workspace does not have', () => {
    expect(errorsOf([node('a', { x: '${global.missing}' })])).toMatch(
      /\$\{global\.missing\} is not a global parameter of this workspace/,
    );
  });

  // A reference matches EXACTLY: names are unique case-insensitively, but
  // `apiURL` is not a spelling of `apiUrl` the run could resolve.
  it('matches the name exactly', () => {
    expect(errorsOf([node('a', { x: '${global.apiURL}' })])).toMatch(/is not a global parameter/);
  });

  // A caller that passes no globals (every one before GL3) has NONE, so a read
  // is refused — never waved through.
  it('refuses every global read when no globals are passed', () => {
    expect(validatePipelineDoc(doc([node('a', { x: '${global.apiUrl}' })]))).toEqual([
      expect.stringMatching(/is not a global parameter/),
    ]);
    expect(validateRefs(doc([node('a', { x: '${global.apiUrl}' })]))).toEqual([
      expect.stringMatching(/is not a global parameter/),
    ]);
  });

  it('types a read by the global type', () => {
    expect(errorsOf([node('a', { x: '${not(global.retries)}' })])).toMatch(/must be a boolean/);
    expect(errorsOf([node('a', { x: '${not(global.live)}' })])).toBe('');
  });

  it('lets a json global take a tail, and refuses one on a scalar', () => {
    expect(errorsOf([node('a', { x: '${global.cfg.a[0]}' })])).toBe('');
    expect(errorsOf([node('a', { x: '${global.apiUrl.x}' })])).toMatch(/deep addressing/);
    expect(errorsOf([node('a', { x: '${global.retries[0]}' })])).toMatch(/deep addressing/);
  });

  // GL-D2: selecting a connection per environment is the main use of a global.
  it('is readable in a reference field', () => {
    expect(errorsOf([node('a', { connectionId: '${global.apiUrl}' })])).toBe('');
  });

  it('is readable in container fields', () => {
    const containers: Container[] = [
      { id: 'fe', kind: 'foreach', children: ['a'], items: '${global.cfg}' } as Container,
      {
        id: 'lp',
        kind: 'loop',
        children: ['b'],
        exitWhen: '${global.live}',
        maxRounds: 3,
      } as Container,
    ];
    expect(errorsOf([node('a'), node('b')], containers)).toBe('');
  });

  // GL-D2: a binding is evaluated before the run exists, and a tool expression
  // sees only its own arguments. Both closed root sets exclude `global`.
  it('is refused in a trigger param binding', () => {
    expect(validateTriggerBindings({ p: '${global.apiUrl}' }).join(' ')).toMatch(
      /may reference only \$\{trigger\.\*\}.*, not \$\{global\.\*\}/,
    );
  });

  it('is refused in an llm_call tool expression', () => {
    const tool = {
      name: 'adder',
      description: 'Adds.',
      parameters: { type: 'object', properties: { a: { type: 'number' } } },
      expression: '${global.retries}',
    };
    const llm = node('n', { prompt: 'hi', tools: [tool] }, { type: 'llm_call' });
    expect(validateRefs(doc([llm]), undefined, { globals: GLOBALS }).join(' ')).toMatch(
      /tool expression may reference only/,
    );
  });
});

describe('the reads a version records', () => {
  it('collects every global a node or container field reads, once', () => {
    const containers: Container[] = [
      { id: 'fe', kind: 'foreach', children: ['a'], items: '${global.cfg}' } as Container,
      {
        id: 'lp',
        kind: 'loop',
        children: ['b'],
        exitWhen: '${global.live}',
        maxRounds: 3,
      } as Container,
    ];
    const globalReads = new Set<string>();
    const { validatorErrors } = variableReadsOf(
      doc([node('a', { x: '${global.apiUrl} ${global.apiUrl}' }), node('b')], containers),
      { globals: GLOBALS, globalReads },
    );
    expect(validatorErrors).toEqual([]);
    expect([...globalReads].sort()).toEqual(['apiUrl', 'cfg', 'live']);
  });

  it('records nothing that is unknown', () => {
    const globalReads = new Set<string>();
    validatePipelineDoc(doc([node('a', { x: '${global.nope}' })]), {
      globals: GLOBALS,
      globalReads,
    });
    expect([...globalReads]).toEqual([]);
  });
});

describe('global names and the snapshot bound', () => {
  // zod's `z.record` DROPS a `__proto__` key and every event is parsed before
  // it is folded, so a snapshot holding one would lose it.
  it('refuses __proto__ as a name', () => {
    expect(globalParamNameDefect('__proto__')).toMatch(/reserved/);
    expect(globalParamNameDefect('proto')).toBeNull();
  });

  it('bounds a snapshot by its JSON size', () => {
    expect(globalSnapshotDefect({ a: 'x' })).toBeNull();
    const big = 'x'.repeat(GLOBAL_SNAPSHOT_MAX_BYTES);
    expect(globalSnapshotDefect({ a: big })).toMatch(/limit is 262144/);
  });
});

describe('RunState.globals', () => {
  const started = (globals?: Record<string, unknown>): EngineEvent => ({
    type: 'run.started',
    runId: 'r1',
    pipelineVersionId: 'pv1',
    params: {},
    ...(globals !== undefined ? { globals } : {}),
  });

  it('is empty before the run starts and for a log that logged none', () => {
    const eng = createEngine({ nodes: [node('a')], edges: [] });
    expect(eng.seedState().globals).toEqual({});
    expect(eng.reduce(eng.seedState(), started()).state.globals).toEqual({});
  });

  it('folds the logged snapshot and feeds it to a dispatched node', () => {
    const eng = createEngine({
      nodes: [node('a', { u: '${global.apiUrl}/x', c: '${global.cfg}' })],
      edges: [],
    });
    const ev = started({ apiUrl: 'https://h', cfg: { k: 1 } });
    const r = eng.reduce(eng.seedState(), ev);
    expect(r.state.globals).toEqual({ apiUrl: 'https://h', cfg: { k: 1 } });
    const cmd = r.commands.find((c) => c.type === 'dispatchNode') as {
      preparedInput: Record<string, unknown>;
    };
    expect(cmd.preparedInput).toEqual({ task: 't', u: 'https://h/x', c: { k: 1 } });
    expect(eng.projectRunState([ev])).toEqual(eng.projectRunState([ev]));
  });

  it('fails the dispatch loudly when the log lacks a read global', () => {
    const eng = createEngine({ nodes: [node('a', { u: '${global.apiUrl}' })], edges: [] });
    const r = eng.reduce(eng.seedState(), started());
    expect(r.commands).toContainEqual({
      type: 'finishRun',
      outcome: 'failure',
      reason: 'invalid_event',
    });
    expect(r.diagnostics.join(' ')).toMatch(/unknown global parameter reference/);
  });
});
