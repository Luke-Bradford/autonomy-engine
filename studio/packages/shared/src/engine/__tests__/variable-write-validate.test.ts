/**
 * #844 V5 — the SAVE-time half of variable writes (spec V-D4/V-D6/V-D8), through
 * `validatePipelineDoc`, the one function both the server write gate and the
 * canvas badge call: the `set_variable`/`append_variable` config rules, the
 * secure-policy refusal, the `allowNondeterministicVars` field, and the
 * determinism guard now wired behind the two validators.
 */
import { describe, expect, it } from 'vitest';
import type { VariableDef } from '../../schemas/pipeline.js';
import type { Container, Edge, Node } from '../types.js';
import { validatePipelineDoc } from '../validate-pipeline.js';

let seq = 0;
function node(id: string, config: Record<string, unknown> = {}, type = 'agent_task'): Node {
  seq += 1;
  return { id, type, config, position: { x: seq, y: 0 } };
}
const set = (id: string, variable: unknown, value: unknown): Node =>
  node(id, { variable, value }, 'set_variable');
const append = (id: string, variable: unknown, value: unknown): Node =>
  node(id, { variable, value }, 'append_variable');
function edge(from: string, to: string): Edge {
  return { id: `${from}->${to}`, from, to, on: 'success' };
}

const VARS: VariableDef[] = [
  { name: 'n', type: 'number', default: 0 },
  { name: 's', type: 'string', default: '' },
  { name: 'list', type: 'array', default: [] },
];
const validate = (nodes: Node[], edges: Edge[] = [], containers: Container[] = []) =>
  validatePipelineDoc({
    params: [{ name: 'x', type: 'number', required: false, default: 1 }],
    nodes,
    edges,
    containers,
    variables: VARS,
  });

describe('set_variable / append_variable config rules', () => {
  it('accepts a literal, a template for a string, and a typed whole-value', () => {
    expect(
      validate(
        [
          set('a', 'n', '5'),
          set('b', 's', 'x-${params.x}'),
          set('c', 'n', '${add(params.x, 1)}'),
          set('d', 'list', '${createArray(1)}'),
          append('e', 'list', 'plain text'),
          append('f', 'list', '${params.x}'),
        ],
        [edge('a', 'b'), edge('b', 'c'), edge('c', 'd'), edge('d', 'e'), edge('e', 'f')],
      ),
    ).toEqual([]);
  });

  it.each([
    ['an undeclared variable', set('w', 'ghost', '1'), "'ghost' is not a declared variable"],
    ['a ${} variable name', set('w', '${params.x}', '1'), 'must be the literal name'],
    ['a missing variable', node('w', { value: '1' }, 'set_variable'), 'must be the literal name'],
    ['append onto a non-array', append('w', 'n', '1'), 'append_variable needs an array variable'],
    ['a literal the coercion refuses', set('w', 'n', 'abc'), 'expected a finite number'],
    ['text around the braces for a number', set('w', 'n', 'n=${params.x}'), 'text around'],
    ['a literal for an array', set('w', 'list', '[1]'), 'not a literal'],
    ['a whole-value of the wrong type', set('w', 'n', "${concat('a', 'b')}"), 'is a string'],
    ['a structured value', set('w', 'n', 5), 'must be text'],
    ['a missing value', node('w', { variable: 'n' }, 'set_variable'), 'must be text'],
    // `substitute` classifies UNTRIMMED text, so padding makes this a template
    // at run time — save must agree rather than accept a write that always fails.
    ['a padded whole-value for a number', set('w', 'n', ' ${params.x} '), 'text around'],
  ])('refuses %s', (_label, n, fragment) => {
    const errs = validate([n]);
    expect(
      errs.some((e) => e.includes(fragment)),
      errs.join(' | '),
    ).toBe(true);
  });

  it('refuses a {$secret} marker in value — a variable is not a secret sink', () => {
    const errs = validate([set('w', 's', { $secret: 'token' })]);
    expect(errs.some((e) => e.includes('must be text'))).toBe(true);
    expect(errs).toContain('nodes.w.config.value: secret reference is not allowed here');
  });

  it.each([
    ['secureInput', set('w', 'n', '1')],
    ['secureOutput', append('w', 'list', '1')],
  ])('refuses policy.%s on a variable write', (flag, n) => {
    const errs = validate([{ ...n, policy: { [flag]: true } }]);
    expect(errs.some((e) => e.includes(`policy.${flag} is not supported`))).toBe(true);
  });
});

describe('the determinism guard runs behind the validators', () => {
  it('refuses two unordered writers, naming both', () => {
    const errs = validate(
      [node('root'), set('a', 'n', '1'), set('b', 'n', '2')],
      [edge('root', 'a'), edge('root', 'b')],
    );
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("variable 'n'");
    expect(errs[0]).toContain("'a'");
    expect(errs[0]).toContain("'b'");
  });

  it('does not run on a doc the validators refuse (its reader list may be incomplete)', () => {
    const errs = validate(
      [node('root'), set('a', 'n', '1'), set('b', 'n', '2'), set('bad', 'ghost', '1')],
      [edge('root', 'a'), edge('root', 'b')],
    );
    expect(errs).toEqual(["node.bad.variable: 'ghost' is not a declared variable"]);
  });

  it('refuses a write that reads its own variable (self-reference)', () => {
    const errs = validate([set('w', 'n', '${add(vars.n, 1)}')]);
    expect(errs.some((e) => e.includes("reads variable 'n', which it writes"))).toBe(true);
  });

  it('refuses a self-appending array too', () => {
    const errs = validate([append('w', 'list', '${vars.list}')]);
    expect(errs.some((e) => e.includes("reads variable 'list', which it writes"))).toBe(true);
  });
});

describe('allowNondeterministicVars', () => {
  const parallel = (extra: Partial<Container> = {}): Container => ({
    id: 'fe',
    kind: 'foreach',
    children: ['a'],
    items: '${createArray(1, 2)}',
    batchCount: 2,
    ...extra,
  });

  it('a writer in a parallel foreach body is refused without the opt-in', () => {
    const errs = validate([append('a', 'list', '${item}')], [], [parallel()]);
    expect(errs.some((e) => e.includes('parallel foreach'))).toBe(true);
  });

  it('the opt-in lifts exactly that rule', () => {
    expect(
      validate(
        [append('a', 'list', '${item}')],
        [],
        [parallel({ allowNondeterministicVars: true })],
      ),
    ).toEqual([]);
  });

  it('is refused on a loop or a stage', () => {
    for (const kind of ['loop', 'stage'] as const) {
      const c: Container = {
        id: 'c',
        kind,
        children: ['a'],
        allowNondeterministicVars: false,
        ...(kind === 'loop' ? { exitWhen: "${equals(nodes.a.status, 'success')}" } : {}),
      };
      const errs = validate([node('a')], [], [c]);
      expect(
        errs.some((e) => e.includes('allowNondeterministicVars is only meaningful on a foreach')),
        errs.join(' | '),
      ).toBe(true);
    }
  });
});
