/**
 * #1600 OR41 C0d — an activity's user properties are checked at save like any
 * other `${}` it holds: refs, types, secure outputs and variable reads. They are
 * refused on an activity that never reaches the executor, because only
 * `node.dispatched` records them — accepting them there would drop them silently.
 */
import { describe, expect, it } from 'vitest';
import type { Node } from '../types.js';
import { validatePipelineDoc } from '../validate-pipeline.js';
import { variableReadsOf } from '../params.js';

const pos = { x: 0, y: 0 };
const PROPS: Partial<Node> = { userProperties: [{ name: 'Source', value: 'orders.csv' }] };
const doc = (
  nodes: Node[],
  variables: { name: string; type: 'string'; default: string }[] = [],
) => ({
  params: [{ name: 'file', type: 'string' as const, required: false }],
  variables,
  nodes,
  edges: [],
  containers: [],
});
const errs = (...nodes: Node[]) => validatePipelineDoc(doc(nodes)).join('\n');
const agent = (over: Partial<Node> = {}): Node => ({
  id: 'a',
  type: 'agent_task',
  config: { task: 't' },
  position: pos,
  ...over,
});

describe('#1600 C0d — user properties at save', () => {
  it('accepts literals and resolvable refs on an execution activity', () => {
    expect(
      errs(
        agent({
          userProperties: [
            { name: 'Source', value: 'orders.csv' },
            { name: 'File', value: '${params.file}' },
            { name: 'Run', value: 'run ${run.runId}' },
          ],
        }),
      ),
    ).toBe('');
  });

  it('refuses a bad ref, naming the row', () => {
    expect(errs(agent({ userProperties: [{ name: 'File', value: '${params.nope}' }] }))).toContain(
      'nodes.a.userProperties[0].value',
    );
  });

  it('refuses a secret-typed parameter, which would put the secret in the run log', () => {
    expect(
      validatePipelineDoc({
        ...doc([agent({ userProperties: [{ name: 'Key', value: '${params.key}' }] })]),
        params: [{ name: 'key', type: 'secret' as const, required: false }],
      }).join('\n'),
    ).toContain('nodes.a.userProperties[0].value');
  });

  it('binds ${item} in a ForEach body, and refuses it outside one', () => {
    const inBody = agent({ id: 'b', userProperties: [{ name: 'Item', value: 'file ${item}' }] });
    const forEach = {
      id: 'fe',
      kind: 'foreach' as const,
      children: ['b'],
      items: '${createArray(1, 2)}',
    };
    expect(validatePipelineDoc({ ...doc([inBody]), containers: [forEach] }).join('\n')).toBe('');
    expect(errs(inBody)).toContain('nodes.b.userProperties[0].value');
  });

  it('refuses a read of a secure output, as every other field does', () => {
    const secure = agent({ id: 's', policy: { secureInput: true, secureOutput: true } });
    const reader = agent({
      id: 'r',
      userProperties: [{ name: 'Leak', value: '${nodes.s.output.result}' }],
    });
    expect(
      validatePipelineDoc({
        ...doc([secure, reader]),
        edges: [{ id: 'e', from: 's', to: 'r', on: 'success' }],
      }).join('\n'),
    ).toContain("node 's' has secure outputs");
  });

  it('counts a variable read in a user property', () => {
    const n = agent({ userProperties: [{ name: 'V', value: '${vars.v}' }] });
    const { reads, validatorErrors } = variableReadsOf(
      doc([n], [{ name: 'v', type: 'string', default: '' }]),
    );
    expect(validatorErrors).toEqual([]);
    expect([...(reads.get('a') ?? [])]).toContain('v');
  });

  it('takes them on an activity the engine evaluates, which records them on its own event (#1673)', () => {
    expect(errs(agent({ id: 'i', type: 'if', config: { condition: '${true}' }, ...PROPS }))).toBe(
      '',
    );
  });

  it('takes them on a pipeline call (#1673)', () => {
    expect(
      errs(
        agent({
          id: 'c',
          type: 'execute_pipeline',
          config: {},
          call: { pipelineVersionId: 'pv2', params: {} },
          ...PROPS,
        }),
      ),
    ).toBe('');
  });

  it('skips an inactive node, as every per-node rule does', () => {
    expect(
      errs(
        agent({
          state: 'inactive',
          type: 'if',
          config: { condition: '${true}' },
          userProperties: [{ name: 'File', value: '${params.nope}' }],
        }),
      ),
    ).toBe('');
  });
});
