import type { ActivityRun } from '@autonomy-studio/shared';

/**
 * One `/activity-runs` row for a test: a settled `success` row with every fact
 * unreported, overridden by what the test is about. One builder, so a field the
 * schema gains is added once rather than to every test file that builds a row.
 */
export function activityRun(over: Partial<ActivityRun> = {}): ActivityRun {
  return {
    key: 'k',
    nodeId: 'a',
    activityId: 'a',
    containerId: null,
    attemptId: null,
    attempt: null,
    status: 'success',
    reused: false,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    iteration: null,
    branch: null,
    rowsRead: null,
    rowsWritten: null,
    bytesRead: null,
    bytesWritten: null,
    childRunId: null,
    childRun: null,
    error: null,
    skipReason: null,
    ...over,
  };
}
