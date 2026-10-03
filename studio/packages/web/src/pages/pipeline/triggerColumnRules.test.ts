import { describe, expect, it } from 'vitest';
import { newTriggerBinding, newTriggerReason, newTriggerTitle } from './triggerColumnRules';

const head = { id: 'pv-3', version: 3 };
const published = { versionId: 'pv-2', commit: 'c0ffee', blob: 'b1' };

describe('newTriggerBinding (#1476 OR28) — what a trigger made in the editor starts bound to', () => {
  it('has nothing to bind before the first saved version', () => {
    expect(
      newTriggerBinding({ pipelineId: 'p1', head: null, active: null, gitConnected: false }),
    ).toBeNull();
  });

  it('binds to active in a DB-only workspace, which the server resolves to the latest version', () => {
    expect(
      newTriggerBinding({ pipelineId: 'p1', head, active: null, gitConnected: false }),
    ).toEqual({ kind: 'active', pipelineId: 'p1' });
  });

  it('binds to active in a git workspace once a version is published', () => {
    expect(
      newTriggerBinding({ pipelineId: 'p1', head, active: published, gitConnected: true }),
    ).toEqual({ kind: 'active', pipelineId: 'p1' });
  });

  it('pins the latest saved version when git is connected but nothing is published (active would 400)', () => {
    expect(newTriggerBinding({ pipelineId: 'p1', head, active: null, gitConnected: true })).toEqual(
      { kind: 'concrete', pipelineVersionId: 'pv-3' },
    );
  });

  it('pins the latest saved version while the publish state is unknown, never guessing active', () => {
    expect(
      newTriggerBinding({ pipelineId: 'p1', head, active: undefined, gitConnected: undefined }),
    ).toEqual({ kind: 'concrete', pipelineVersionId: 'pv-3' });
  });
});

describe('newTriggerReason / newTriggerTitle', () => {
  it('refuses while loading, when archived, and before a saved version', () => {
    expect(newTriggerReason({ ready: false, archived: false, headVersion: 3 })).toMatch(/load/);
    expect(newTriggerReason({ ready: true, archived: true, headVersion: 3 })).toMatch(/archived/);
    expect(newTriggerReason({ ready: true, archived: false, headVersion: null })).toMatch(
      /Save a version first/,
    );
    expect(newTriggerReason({ ready: true, archived: false, headVersion: 3 })).toBeNull();
  });

  it('says which version the trigger will fire, and that unsaved edits are left out', () => {
    expect(newTriggerTitle({ kind: 'active', pipelineId: 'p1' }, 3, true, false)).toBe(
      'Fires the published version.',
    );
    expect(newTriggerTitle({ kind: 'active', pipelineId: 'p1' }, 3, false, false)).toBe(
      'Fires the latest saved version (v3 now).',
    );
    expect(
      newTriggerTitle({ kind: 'concrete', pipelineVersionId: 'pv-3' }, 3, undefined, true),
    ).toBe('Fires v3, the latest saved version. Your unsaved edits are not included.');
  });
});
