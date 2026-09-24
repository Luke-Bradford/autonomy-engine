import { describe, expect, it } from 'vitest';
import type { DependentNode, DynamicDependentNode } from '@autonomy-studio/shared';
import {
  deleteConfirmNodeClause,
  nodeKindAdvisory,
  nodesBrokenByKind,
  type NodeCheck,
} from './dependentNodes';

const LLM_KINDS: DependentNode['acceptedKinds'] = ['anthropic_api', 'openai_api', 'ollama'];

function node(overrides: Partial<DependentNode> = {}): DependentNode {
  return {
    pipelineId: 'p1',
    pipelineName: 'nightly etl',
    versionId: 'v1',
    version: 1,
    nodeId: 'summarise',
    nodeType: 'llm_call',
    acceptedKinds: LLM_KINDS,
    ...overrides,
  };
}

function dynamicNode(overrides: Partial<DynamicDependentNode> = {}): DynamicDependentNode {
  return {
    pipelineId: 'p1',
    pipelineName: 'nightly etl',
    versionId: 'v1',
    version: 1,
    nodeId: 'router',
    nodeType: 'llm_call',
    ...overrides,
  };
}

function known(nodes: DependentNode[], dynamicNodes: DynamicDependentNode[] = []): NodeCheck {
  return { state: 'known', nodes, dynamicNodes };
}

describe('nodesBrokenByKind (#1252)', () => {
  it('keeps a node the stored kind satisfies and the next kind does not', () => {
    expect(nodesBrokenByKind([node()], 'ollama', 'fs')).toEqual([node()]);
  });

  it('drops a node the next kind still satisfies', () => {
    expect(nodesBrokenByKind([node()], 'ollama', 'openai_api')).toEqual([]);
  });

  it('drops a node that was ALREADY broken — the edit is not what breaks it', () => {
    expect(nodesBrokenByKind([node()], 'fs', 'http')).toEqual([]);
  });
});

describe('nodeKindAdvisory (#1252)', () => {
  it('says nothing while the Kind select has not moved', () => {
    expect(nodeKindAdvisory({ state: 'loading' }, 'ollama', 'ollama', false)).toBeNull();
  });

  it('names each broken node once, by pipeline and node, however many versions carry it', () => {
    const text = nodeKindAdvisory(
      known([node(), node({ versionId: 'v2', version: 2 })]),
      'ollama',
      'fs',
      false,
    );
    expect(text).toContain('1 pipeline node (nightly etl › summarise)');
    expect(text).toContain('fs');
    // The point of #1252: nothing is disabled, so the schedule keeps firing.
    expect(text).toMatch(/stay enabled/);
  });

  it('counts two pipelines that share a name as two nodes', () => {
    const text = nodeKindAdvisory(
      known([node(), node({ pipelineId: 'p2', versionId: 'v9' })]),
      'ollama',
      'fs',
      false,
    );
    expect(text).toContain('2 pipeline nodes');
  });

  it('does not say the triggers stay enabled when the same save switches them off', () => {
    // The trigger note beside this one says they are disabled; both cannot hold.
    const text = nodeKindAdvisory(known([node()]), 'ollama', 'fs', true);
    expect(text).toContain('1 pipeline node (nightly etl › summarise)');
    expect(text).not.toMatch(/stay enabled/);
  });

  it('is an EARNED silence — only from a completed read with nothing broken', () => {
    expect(nodeKindAdvisory(known([node()]), 'ollama', 'openai_api', false)).toBeNull();
    expect(nodeKindAdvisory({ state: 'loading' }, 'ollama', 'fs', false)).toMatch(/Still checking/);
    expect(
      nodeKindAdvisory({ state: 'unavailable', detail: 'offline' }, 'ollama', 'fs', false),
    ).toMatch(/Could not check.*offline/);
  });

  it('speaks about a ${}-dynamic node rather than reading it as silence', () => {
    const text = nodeKindAdvisory(known([], [dynamicNode()]), 'ollama', 'fs', false);
    expect(text).toMatch(
      /1 pipeline node \(nightly etl › router\) chooses a connection at run time/,
    );
  });

  it('says "other" only when a named set precedes the dynamic one', () => {
    const text = nodeKindAdvisory(known([node()], [dynamicNode()]), 'ollama', 'fs', false);
    expect(text).toMatch(/1 other pipeline node \(nightly etl › router\)/);
  });
});

describe('deleteConfirmNodeClause (#1252)', () => {
  it('names every node that uses the connection, whatever its accepted kinds', () => {
    expect(deleteConfirmNodeClause(known([node(), node({ nodeId: 'load' })]))).toContain(
      '2 pipeline nodes (nightly etl › summarise, nightly etl › load)',
    );
  });

  it('is empty only on an earned empty', () => {
    expect(deleteConfirmNodeClause(known([]))).toBe('');
    expect(deleteConfirmNodeClause({ state: 'unavailable', detail: 'offline' })).toMatch(
      /Could not check.*offline/,
    );
  });
});
