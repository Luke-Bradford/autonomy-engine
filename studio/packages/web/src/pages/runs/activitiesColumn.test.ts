import { describe, expect, it } from 'vitest';
import type { RunActivityCounts } from '@autonomy-studio/shared';
import { activitiesCell, rowsWrittenCell } from './activitiesColumn';

const counts = (over: Partial<RunActivityCounts> = {}): RunActivityCounts => ({
  succeeded: 0,
  failed: 0,
  skipped: 0,
  reused: 0,
  unfinished: 0,
  ...over,
});

describe('#1484 activitiesCell', () => {
  it('draws the dense form the issue specifies, and says it in words', () => {
    expect(
      activitiesCell({
        status: 'failure',
        activities: counts({ succeeded: 8, failed: 1, skipped: 2 }),
      }),
    ).toEqual({ figure: '8 ✓ · 1 ✗ · 2 skipped', words: '8 succeeded, 1 failed, 2 skipped' });
  });

  it('always shows succeeded, so a run that did nothing reads 0 ✓', () => {
    expect(activitiesCell({ status: 'success', activities: counts() }).figure).toBe('0 ✓');
  });

  it('calls unfinished activities "in progress" on a live run and "not run" on an ended one', () => {
    const activities = counts({ succeeded: 1, unfinished: 3 });
    expect(activitiesCell({ status: 'running', activities }).figure).toBe('1 ✓ · 3 in progress');
    expect(activitiesCell({ status: 'cancelled', activities }).figure).toBe('1 ✓ · 3 not run');
  });

  it('names what a rerun reused from the earlier run', () => {
    expect(
      activitiesCell({ status: 'success', activities: counts({ succeeded: 2, reused: 3 }) }).words,
    ).toBe('2 succeeded, 3 reused from the earlier run');
  });

  it('draws the em-dash, never 0 ✓, when there are no counts', () => {
    expect(activitiesCell({ status: 'queued', activities: null }).figure).toBe('—');
  });
});

describe('#1484 rowsWrittenCell', () => {
  it('groups thousands, keeps a real 0, and draws the em-dash for no figure', () => {
    expect(rowsWrittenCell({ rowsWritten: 1234567 })).toBe('1,234,567');
    expect(rowsWrittenCell({ rowsWritten: 0 })).toBe('0');
    expect(rowsWrittenCell({ rowsWritten: null })).toBe('—');
  });
});
