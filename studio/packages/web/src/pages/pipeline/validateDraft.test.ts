import { describe, expect, it } from 'vitest';
import { ISSUE_LIST_CAP } from '@autonomy-studio/shared';
import { serverOnlyIssues, validationAnnouncement } from './validateDraft';

describe('serverOnlyIssues (#1476)', () => {
  it('keeps only the issues the editor does not already list, in the server’s order', () => {
    const client = new Set(["node 'a': unknown param 'x'"]);
    expect(
      serverOnlyIssues(
        {
          issues: [
            "node 'a': unknown param 'x'",
            "a call_pipeline node cannot call debug version 'pv_1'",
          ],
          totalIssues: 2,
        },
        client,
      ),
    ).toEqual({ raw: ["a call_pipeline node cannot call debug version 'pv_1'"], truncated: false });
  });

  it('says when the server cut its list', () => {
    expect(serverOnlyIssues({ issues: ['x'], totalIssues: 4 }, new Set())).toEqual({
      raw: ['x'],
      truncated: true,
    });
  });
});

describe('validation wording', () => {
  it('announces the count, or that there is nothing', () => {
    expect(validationAnnouncement(0)).toBe('Validation: no problems found.');
    expect(validationAnnouncement(1)).toBe('Validation: 1 problem — see Problems.');
    expect(validationAnnouncement(3)).toBe('Validation: 3 problems — see Problems.');
    expect(validationAnnouncement(2, true)).toBe(
      `Validation: 2 problems — see Problems. The save check listed only its first ${String(ISSUE_LIST_CAP)}; validate again once these are fixed.`,
    );
  });
});
