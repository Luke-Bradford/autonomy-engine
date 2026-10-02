import { describe, expect, it } from 'vitest';
import type { PipelineDependentsResponse } from '@autonomy-studio/shared';
import { pipelineDeletePlan } from './pipelineDeleteConfirm';

const none: PipelineDependentsResponse = {
  hasRuns: false,
  triggers: [],
  callers: [],
  dynamicCallers: [],
};

const caller = (pipelineId: string, pipelineName: string, nodeId: string, versionId = 'v') => ({
  pipelineId,
  pipelineName,
  versionId,
  version: 1,
  nodeId,
  nodeType: 'call_pipeline',
});

describe('pipelineDeletePlan', () => {
  it('a pipeline with nothing depending on it: the question, what goes, no typed name', () => {
    const plan = pipelineDeletePlan('Nightly', { state: 'known', value: none });
    expect(plan.kind).toBe('confirm');
    if (plan.kind !== 'confirm') return;
    expect(plan.message.split('\n\n')[0]).toBe('Delete pipeline "Nightly"?');
    expect(plan.message).toMatch(/every version is deleted with it/i);
    expect(plan.message).toMatch(/cannot be undone/i);
    expect(plan.message).toMatch(/connected to git/);
    expect(plan.typeToConfirm).toBeUndefined();
  });

  it('names the triggers the cascade deletes, and asks for the name', () => {
    const plan = pipelineDeletePlan('Nightly', {
      state: 'known',
      value: {
        ...none,
        triggers: [
          { id: 't1', name: 'At 2am' },
          { id: 't2', name: 'On push' },
        ],
      },
    });
    if (plan.kind !== 'confirm') throw new Error('expected a confirmation');
    expect(plan.message).toContain('also deletes 2 triggers bound to it (At 2am, On push)');
    expect(plan.typeToConfirm).toBe('Nightly');
  });

  it('names the calling nodes once each, though a caller can appear in two versions', () => {
    const plan = pipelineDeletePlan('Child', {
      state: 'known',
      value: {
        ...none,
        callers: [caller('p1', 'Parent', 'run child', 'v1'), caller('p1', 'Parent', 'run child', 'v2')],
      },
    });
    if (plan.kind !== 'confirm') throw new Error('expected a confirmation');
    expect(plan.message).toContain('1 pipeline node (Parent › run child) calls it and will fail');
    expect(plan.typeToConfirm).toBe('Child');
  });

  it('a call whose target is chosen at run time is named as a MAY, and still asks for the name', () => {
    const plan = pipelineDeletePlan('Child', {
      state: 'known',
      value: { ...none, dynamicCallers: [caller('p2', 'Router', 'dispatch')] },
    });
    if (plan.kind !== 'confirm') throw new Error('expected a confirmation');
    expect(plan.message).toContain('Router › dispatch');
    expect(plan.message).toMatch(/chosen at run time/);
    expect(plan.typeToConfirm).toBe('Child');
  });

  it('a failed read says what it could not check and adds no friction', () => {
    const plan = pipelineDeletePlan('Nightly', { state: 'unavailable', detail: 'offline' });
    if (plan.kind !== 'confirm') throw new Error('expected a confirmation');
    expect(plan.message).toMatch(/Could not check what depends on it \(offline\)/);
    expect(plan.typeToConfirm).toBeUndefined();
  });

  it('run history refuses up front instead of asking a question the server will refuse', () => {
    const plan = pipelineDeletePlan('Busy', {
      state: 'known',
      value: { ...none, hasRuns: true, triggers: [{ id: 't1', name: 'At 2am' }] },
    });
    expect(plan).toEqual({
      kind: 'refused',
      message: expect.stringMatching(/Cannot delete “Busy”: it has run history\. Archive it instead/),
    });
  });
});
