import { formatTokenCount, type ExternalAgentTokens } from '@autonomy-studio/shared';

/**
 * #988 — how a REPORTED group's tokens read.
 *
 * A sibling of `tokenSummary`, not a second dialect of it: the wording ("not
 * reported", `n in · n out`) is copied deliberately so the reported table and
 * the metered one above it say unmeasured the same way. It cannot simply CALL
 * `tokenSummary`, which takes a `RunCost` — reported tokens carry no cost, no
 * response counts and no `complete` flag, and manufacturing a `RunCost` to reach
 * the helper would mean inventing exactly the money fields this surface refuses
 * to accept.
 *
 * The "neither side measured" check is keyed on THE SIDES, exactly as
 * `tokenSummary` does it — not on `measuredInvocations`. An earlier draft used
 * that count and a mutation test proved the branch dead: the two are equivalent
 * by construction (the SQL sets `measuredInvocations` from those very columns),
 * so the guard could never be the thing that fired. Keyed on the sides it is
 * load-bearing, and it collapses "input not reported · output not reported" to
 * the one short reading the metered table already uses.
 *
 * `measuredInvocations` earns its place elsewhere: a group is MANY invocations,
 * so "some of them reported" is a state a single row cannot have and a sum
 * cannot express. Two of five fires reporting tokens would otherwise render as
 * a confident total for all five.
 */
export function reportedTokenSummary(tokens: ExternalAgentTokens, invocations: number): string {
  if (tokens.inputTokens === null && tokens.outputTokens === null) return 'not reported';
  const parts = [
    tokens.inputTokens === null
      ? 'input not reported'
      : `${formatTokenCount(tokens.inputTokens)} in`,
    tokens.outputTokens === null
      ? 'output not reported'
      : `${formatTokenCount(tokens.outputTokens)} out`,
  ];
  /* Cache reads are appended only when measured, rather than given a "not
   * reported" of their own: unlike the two sides above they are OPTIONAL to the
   * reading — a reporter that sends none is not hiding anything, it simply does
   * not have a cache. They are worth showing when present because for a
   * subscription CLI they dominate the token count entirely. */
  if (tokens.cacheReadTokens !== null) {
    parts.push(`${formatTokenCount(tokens.cacheReadTokens)} cached`);
  }
  /* A PARTIALLY-measured group is stated as such. The figures are a real sum
   * over the invocations that reported, so presenting them unqualified beside a
   * larger invocation count would read as a total for all of them. */
  if (tokens.measuredInvocations < invocations) {
    parts.push(`${tokens.measuredInvocations} of ${invocations} measured`);
  }
  return parts.join(' · ');
}

/**
 * The one-line reading above the table.
 *
 * `inFlight` leads when anything is running, because "is my agent working right
 * now" is the question this section was added to answer — the panel reported a
 * confident zero while the autonomy loop was mid-fire, and a summary that opens
 * with a historical count would bury the live answer behind it.
 */
export function reportedActivitySummary(counts: {
  invocations: number;
  completed: number;
  notCompleted: number;
  unknown: number;
  inFlight: number;
}): string {
  const { invocations, completed, notCompleted, unknown, inFlight } = counts;
  const plural = invocations === 1 ? '' : 's';
  const head =
    inFlight > 0
      ? `${inFlight} of ${invocations} reported invocation${plural} running now`
      : `${invocations} reported invocation${plural}`;
  /* The partition is stated in full — `completed + notCompleted + unknown`
   * always equals `invocations` — so a reader can see that nothing fell out of
   * the count. `unknown` is named rather than folded into `notCompleted`,
   * which would report an invocation that is running fine as one that failed. */
  return `${head} — ${completed} completed, ${notCompleted} did not, ${unknown} unknown.`;
}
