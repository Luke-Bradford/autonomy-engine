import { ISSUE_LIST_CAP, type PipelineValidation } from '@autonomy-studio/shared';

/**
 * #1476 OR28 — what the server's Validate found that the editor's own badges
 * did not. The client runs `validatePipelineDoc` too, without the server's
 * database reads (the owner-scoped call-graph walk, the debug-callee refusal),
 * so the server's list is the client's plus those. Comparing RAW strings — the
 * gate's own wording, before `readableIssue` rewrites ids — is what makes the
 * two lists comparable, and keeps an issue from being listed twice.
 *
 * `truncated`: the server sent only the first `ISSUE_LIST_CAP` of its list. The
 * unsent tail cannot be compared, so it is neither counted (most of it is
 * usually what the editor already lists) nor read as "that was all of them":
 * the announcement says the list was cut.
 */
export function serverOnlyIssues(
  server: PipelineValidation,
  clientRaw: ReadonlySet<string>,
): { raw: string[]; truncated: boolean } {
  return {
    raw: server.issues.filter((issue) => !clientRaw.has(issue)),
    truncated: server.totalIssues > server.issues.length,
  };
}

/** What Validate announces: the count Problems now lists. */
export function validationAnnouncement(count: number, truncated = false): string {
  const found =
    count === 0
      ? 'Validation: no problems found.'
      : `Validation: ${String(count)} problem${count === 1 ? '' : 's'} — see Problems.`;
  return truncated
    ? `${found} The save check listed only its first ${String(ISSUE_LIST_CAP)}; validate again once these are fixed.`
    : found;
}
