import { describe, expect, it } from 'vitest';
import { RUN_TYPE_LABEL, RUN_TYPES, runTypeOf, type RunType } from './runType';

describe('runTypeOf', () => {
  it('reads a run with a source run as a rerun from failed, and any other run as original', () => {
    expect(runTypeOf({ rerunOf: 'run_source' })).toBe('rerun_from_failed');
    // Also the reading of a rerun whose source run was DELETED: `runs.rerun_of`
    // is `ON DELETE SET NULL`, so the row no longer carries the fact and the
    // classifier does not invent it back (`runType.ts` records the limitation).
    expect(runTypeOf({ rerunOf: null })).toBe('original');
  });

  it('labels every type', () => {
    const labels = RUN_TYPES.map((t: RunType) => RUN_TYPE_LABEL[t]);
    expect(labels).toEqual(['Original', 'Rerun from failed']);
  });
});
