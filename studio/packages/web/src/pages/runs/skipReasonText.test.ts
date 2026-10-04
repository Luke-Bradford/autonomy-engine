import { describe, expect, it } from 'vitest';
import { skipReasonText } from './skipReasonText';

const NAMES: Record<string, string> = { a: 'Copy Data 1', c: 'If 1', lp: 'Until 1', fe: 'ForEach 1' };
const nameOf = (id: string) => NAMES[id] ?? null;

describe('#1484 M2 skipReasonText', () => {
  it('names the activity that failed, by its name in the version that ran', () => {
    expect(skipReasonText({ kind: 'upstream', from: 'a', outcome: 'failure' }, nameOf)).toBe(
      'upstream failed: Copy Data 1',
    );
  });

  it('says a branch was not taken', () => {
    expect(skipReasonText({ kind: 'branch', from: 'c', taken: 'true' }, nameOf)).toBe(
      'branch not taken',
    );
  });

  it('reads a failure handler that was not needed as such, not as an error', () => {
    expect(skipReasonText({ kind: 'upstream', from: 'a', outcome: 'success' }, nameOf)).toBe(
      'not needed: Copy Data 1 succeeded',
    );
    expect(skipReasonText({ kind: 'upstream', from: 'a', outcome: 'skipped' }, nameOf)).toBe(
      'upstream skipped: Copy Data 1',
    );
  });

  it('names the loop that timed out and the ForEach item that failed, by canvas node', () => {
    expect(skipReasonText({ kind: 'timeout', containerId: 'lp' }, nameOf)).toBe(
      'loop timed out: Until 1',
    );
    expect(skipReasonText({ kind: 'doomed', containerId: 'fe', blame: 'a@1' }, nameOf)).toBe(
      'ForEach stopped: Copy Data 1 failed',
    );
  });

  it('falls back to the id when the version has no name for it', () => {
    expect(skipReasonText({ kind: 'upstream', from: 'gone', outcome: 'failure' }, nameOf)).toBe(
      'upstream failed: gone',
    );
  });
});
