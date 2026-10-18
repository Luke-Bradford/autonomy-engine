import { describe, expect, it } from 'vitest';
import type { EngineEvent, Node } from '../types.js';
import { createEngine } from '../reduce.js';
import { COPY_ACTIVITY_TYPE } from '../../catalog/types.js';

/**
 * #1600 OR41 C3b — a copy's Pre-copy script is handed to the sink as it was
 * written. Save refuses a `${` in it (§8), and this makes the rule hold by
 * construction too, for a doc that reached the store some other way: the
 * reducer never evaluates the statement, only its bind values.
 */
describe("prepInput leaves a copy's Pre-copy script unsubstituted (C3b)", () => {
  const copy = (config: Record<string, unknown>): Node => ({
    id: 'c',
    type: COPY_ACTIVITY_TYPE,
    config,
    position: { x: 0, y: 0 },
  });
  const started: EngineEvent = {
    type: 'run.started',
    runId: 'r1',
    pipelineVersionId: 'pv1',
    params: {},
  };

  it('passes the script raw and substitutes its bind values', () => {
    const eng = createEngine({
      nodes: [
        copy({
          mapping: [],
          preCopyScript: "delete from t where r = :r or note = '${run.runId}'",
          preCopyScriptParameters: { r: '${run.runId}' },
          note: '${run.runId}',
        }),
      ],
      edges: [],
    });
    const cmd = eng
      .reduce(eng.seedState(), started)
      .commands.find((c) => c.type === 'dispatchNode') as {
      preparedInput: Record<string, unknown>;
    };
    expect(cmd.preparedInput).toEqual({
      mapping: [],
      preCopyScript: "delete from t where r = :r or note = '${run.runId}'",
      preCopyScriptParameters: { r: 'r1' },
      note: 'r1',
    });
  });

  it('adds no key to a copy that has no script', () => {
    const eng = createEngine({ nodes: [copy({ mapping: [] })], edges: [] });
    const cmd = eng
      .reduce(eng.seedState(), started)
      .commands.find((c) => c.type === 'dispatchNode') as {
      preparedInput: Record<string, unknown>;
    };
    expect(cmd.preparedInput).toEqual({ mapping: [] });
  });
});
