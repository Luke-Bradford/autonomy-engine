import type { SubjectIssue } from './containerRules';
import { issueCountLabel } from './issueContext';

/**
 * #863 — the property panel's list of what is wrong with the selected element:
 * the node, container or edge the validator's message is ABOUT
 * (`issueSubject`). The dock's Problems column carries every issue; this is
 * the same text, shown where the fix is made.
 *
 * Plain visible text, not a live region, as `PolicyEditor`'s list is: the
 * dock header's status line already announces that the save is blocked, and the page
 * refuses a further announcer (#1249).
 */
export function SubjectIssues({
  issues,
  listedElsewhere,
}: {
  issues: readonly SubjectIssue[];
  /**
   * Issues on this element that another section of the panel lists beside the
   * fields causing them (`PolicyEditor`), so they are COUNTED here — the header
   * then agrees with the canvas badge — and pointed at rather than repeated.
   * `where` names the section AND how to reach it (e.g. its tab).
   */
  listedElsewhere?: { count: number; where: string };
}) {
  const elsewhere = listedElsewhere?.count ?? 0;
  const total = issues.length + elsewhere;
  if (total === 0) return null;
  return (
    <div className="subject-issues">
      <strong className="error">{issueCountLabel(total)}</strong> — fix these to save.
      <ul className="plain-list">
        {issues.map((issue, i) => (
          // Indexed: messages are not unique (see the Problems column).
          <li key={`${String(i)}-${issue.raw}`}>{issue.text}</li>
        ))}
        {elsewhere > 0 && (
          <li>
            {/* #852 — no "below": the section named may sit on another tab of
                the dock, so the caller's `where` says where it is. */}
            {elsewhere} more under {listedElsewhere?.where}.
          </li>
        )}
      </ul>
    </div>
  );
}
