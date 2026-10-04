import { describe, expect, it } from 'vitest';
import type { RunWindow } from '@autonomy-studio/shared';
import {
  newTriggerBinding,
  newTriggerReason,
  newTriggerTitle,
  nextFireText,
} from './triggerColumnRules';

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

describe('nextFireText (#1476 slice 4) — when a listed trigger is next due', () => {
  const now = Date.parse('2026-10-05T10:00:00Z'); // a Monday
  const at = Date.parse('2026-10-05T12:00:00Z');
  const when = '2026-10-05 12:00:00 UTC';
  const schedule = { enabled: true, mode: 'schedule' as const, runWindows: null };
  const tick = { triggerId: 't1', at, source: 'schedule' as const };

  it('names the next scheduled tick', () => {
    expect(nextFireText(schedule, tick, now, 'UTC')).toBe(`next scheduled ${when}`);
  });

  it('names when the next tumbling window closes', () => {
    expect(
      nextFireText({ ...schedule, mode: 'tumbling' }, { ...tick, source: 'window' }, now, 'UTC'),
    ).toBe(`next window closes ${when}`);
  });

  it('says a tick outside the run windows is skipped, and one inside is not', () => {
    const mornings: RunWindow[] = [{ start: '08:00', end: '11:00' }];
    const afternoons: RunWindow[] = [{ start: '11:00', end: '13:00' }];
    expect(nextFireText({ ...schedule, runWindows: mornings }, tick, now, 'UTC')).toBe(
      `next scheduled ${when}, outside its run windows so skipped`,
    );
    expect(nextFireText({ ...schedule, runWindows: afternoons }, tick, now, 'UTC')).toBe(
      `next scheduled ${when}`,
    );
  });

  it('a time already passed when it was read is due now', () => {
    expect(nextFireText(schedule, tick, at, 'UTC')).toBe('a scheduled tick is due now');
    expect(nextFireText(schedule, tick, at + 1, 'UTC')).toBe('a scheduled tick is due now');
    expect(
      nextFireText({ ...schedule, mode: 'tumbling' }, { ...tick, source: 'window' }, at + 1, 'UTC'),
    ).toBe('a closed window is due now');
  });

  it('an overdue tick is judged against the run windows when it was read, not when it fell due', () => {
    const afternoons: RunWindow[] = [{ start: '11:00', end: '13:00' }];
    const late = Date.parse('2026-10-05T13:30:00Z');
    expect(nextFireText({ ...schedule, runWindows: afternoons }, tick, late, 'UTC')).toBe(
      'a scheduled tick is due now, outside its run windows so skipped',
    );
  });

  it('an enabled clock trigger with nothing armed says so', () => {
    expect(nextFireText(schedule, undefined, now, 'UTC')).toBe('nothing scheduled');
    expect(nextFireText({ ...schedule, mode: 'tumbling' }, undefined, now, 'UTC')).toBe(
      'nothing scheduled',
    );
  });

  it('says nothing for a disabled trigger or a mode that does not fire on a clock', () => {
    expect(nextFireText({ ...schedule, enabled: false }, tick, now, 'UTC')).toBeNull();
    for (const mode of ['manual', 'webhook', 'event', 'continuous'] as const) {
      expect(nextFireText({ ...schedule, mode }, undefined, now, 'UTC')).toBeNull();
    }
  });
});
