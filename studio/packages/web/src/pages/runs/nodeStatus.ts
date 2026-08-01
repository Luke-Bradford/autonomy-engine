import type { ContainerRunStatus, NodeRunStatus } from '@autonomy-studio/shared';

/**
 * U25 — the Monitor's ONE graph vocabulary: the engine's own `NodeRunStatus`
 * and `ContainerRunStatus`, plus how to draw each and how to word each.
 *
 * (The first sentence said "node-status" and named only `NodeRunStatus` until
 * #873, while the file had held `CONTAINER_TONES` since U11 — the drift that
 * let the container half ship a tone with no label for two tickets.)
 *
 * Before this module the run detail page answered the same question twice, in
 * two vocabularies. The graph folded the real reducer (10 statuses) while the
 * node table folded a private doc-free approximation with five words of its
 * own, so one page could say `retry_pending` in the graph and `retrying` in the
 * table for the identical node — and collapse a timer park, an awaited callback
 * and an in-flight child run into a single undifferentiated `waiting`.
 *
 * The vocabulary is now the ENGINE's everywhere and the wording is here, once.
 * Two surfaces cannot drift when neither owns the words.
 *
 * WHY ITS OWN MODULE, split out of `runProjection.ts`: that file imports
 * `createEngine` as a VALUE, and the label/tone maps are needed by the node
 * table, which renders with no doc and no reducer at all (see
 * `runSummary.ts`'s module doc on why the doc-free fold is kept). Everything
 * here is type-only against `@autonomy-studio/shared`, so reaching for a label
 * never reaches the reducer.
 */

/**
 * The hue GROUP a status is drawn in on the GRAPH. Ten node statuses share five
 * palette variables, so the groups are stated here once and the exact status is
 * ALSO rendered as text on the node — the colour narrows it to a family, the
 * label says which member, and nothing is silently collapsed.
 *
 * Chosen so the canvas and the run table cannot come to disagree
 * (`index.css` records the same commitment for the edge hues):
 *   - `neutral`  — nothing has happened to this node (`pending`, `ready`).
 *   - `running`  — the engine has dispatched it.
 *   - `holding`  — dispatched-and-parked: a retry backoff, a timer, an external
 *     callback, or a child run in flight. Distinct from `neutral` because the
 *     run IS advancing here; the old table collapsed three of these to one word.
 *   - `success` / `failure` — terminal.
 *   - `skipped` — terminal, but by ROUTING rather than execution. Grey like
 *     `neutral` and drawn DASHED, matching the settled edge encoding for a
 *     skipped edge, so "this did not run" reads the same everywhere.
 *
 * The TABLE's pills are keyed by the status itself rather than by these tones,
 * which is a deliberate difference and not an oversight: `holding` covers both
 * a retry backoff and a routine park, and #483 established that those two must
 * NOT share a colour in the table (amber earns an operator's attention, a park
 * does not). Collapsing them to one hue to make the two surfaces match would
 * have thrown information away to buy a symmetry the spec explicitly does not
 * ask for — it records that the palette mapping "is NOT injective ACROSS
 * surfaces". The WORD is what U25 reconciles; the hue stays each surface's own.
 */
export const ALL_TONES = [
  'neutral',
  'running',
  'holding',
  'success',
  'failure',
  'skipped',
] as const;
export type StatusTone = (typeof ALL_TONES)[number];

/**
 * Exhaustive BY CONSTRUCTION: `Record<NodeRunStatus, StatusTone>` fails to
 * compile the day the engine adds a status, which forces a deliberate choice
 * rather than a silent fallthrough to some default hue. (A `satisfies` on an
 * array would NOT catch a forgotten member — the engine's own `TERMINAL_NODE`
 * comment records that having been probed and found false.)
 */
const NODE_TONES: Record<NodeRunStatus, StatusTone> = {
  pending: 'neutral',
  ready: 'neutral',
  dispatched: 'running',
  success: 'success',
  failure: 'failure',
  skipped: 'skipped',
  waiting: 'holding',
  retry_pending: 'holding',
  wait_pending: 'holding',
  external_wait_pending: 'holding',
};

/** Same construction for containers; `active` is their `dispatched`. */
const CONTAINER_TONES: Record<ContainerRunStatus, StatusTone> = {
  pending: 'neutral',
  active: 'running',
  success: 'success',
  failure: 'failure',
  skipped: 'skipped',
};

export function nodeStatusTone(status: NodeRunStatus): StatusTone {
  return NODE_TONES[status];
}

export function containerStatusTone(status: ContainerRunStatus): StatusTone {
  return CONTAINER_TONES[status];
}

/**
 * What an OPERATOR is told a node is doing. Same exhaustive-`Record`
 * construction as the tones, and for the same reason: a new engine status must
 * be worded deliberately rather than leak its identifier onto the screen.
 *
 * Three rules produced this table:
 *
 *  1. **A status whose identifier already reads as English keeps it.**
 *     `pending`, `ready`, `success`, `failure`, `skipped` are not improved by
 *     paraphrase, and inventing synonyms for them would be a second vocabulary
 *     in the very module that exists to end one.
 *  2. **`dispatched` becomes "running".** The engine's word names the ENGINE's
 *     act — it handed the node to a driver. The operator is asking what the
 *     NODE is doing, and it is running. This is the one place the two readings
 *     genuinely differ, and the table already used "running" for it.
 *  3. **The three parks say WHAT they are parked on.** This is the ticket's
 *     "waiting + reason" at node level, and it needs no new field: the reason
 *     IS the status, and it was already distinguished in the engine and thrown
 *     away by every reader. A `wait` activity's timer, a `webhook`'s inbound
 *     callback and a `call_pipeline`'s child run are three different reasons a
 *     run is not advancing, and an operator staring at a stuck run needs to
 *     know which one — the difference between "wait for it", "something
 *     external owes us a call" and "go look at the child run".
 *
 * The parenthetical is part of the label rather than a separate column so that
 * every surface gets it for free — the table, the U24 drill-in panel and the
 * graph node all render this one string.
 */
const NODE_STATUS_LABELS: Record<NodeRunStatus, string> = {
  pending: 'pending',
  ready: 'ready',
  dispatched: 'running',
  success: 'success',
  failure: 'failure',
  skipped: 'skipped',
  waiting: 'waiting (child run)',
  retry_pending: 'retrying',
  wait_pending: 'waiting (timer)',
  external_wait_pending: 'waiting (callback)',
};

export function nodeStatusLabel(status: NodeRunStatus): string {
  return NODE_STATUS_LABELS[status];
}

/**
 * What an OPERATOR is told a CONTAINER is doing — the last surface still
 * printing an engine identifier (#873), and the third and final level of the
 * same reconciliation U25 did for nodes and #870 did for runs.
 *
 * Four of the five follow rule 1 above and keep their own identifiers. The one
 * that changes is `active`, and the argument for it is CROSS-LEVEL rather than
 * rule 2 alone. Rule 2 says the engine's word names the engine's act, which is
 * true here — `active` is a container's `dispatched`. But `active` is not
 * jargon the way `dispatched` is, so on its own that reads like a preference.
 * The fact that settles it: a node already says "running" (`dispatched` above)
 * and a run already says "running" (`runStatus.ts`), so a container saying
 * "active" put a THIRD word for "this is live" on one page, for the identical
 * idea, at the one level between the two that already agreed.
 *
 * The honest limit, stated here so the graph is not read as claiming more than
 * it knows: `active` covers "live, but every child is parked". A node
 * distinguishes its three parks by status; `ContainerRunStatusSchema` has no
 * park member, so a container structurally cannot, and a stage reading
 * "running" directly above a child reading "waiting (timer)" is correct rather
 * than contradictory — the box IS live, and what it is waiting on is the
 * child's fact to state. Inventing a container park word here would be a
 * vocabulary the engine cannot back.
 */
const CONTAINER_STATUS_LABELS: Record<ContainerRunStatus, string> = {
  pending: 'pending',
  active: 'running',
  success: 'success',
  failure: 'failure',
  skipped: 'skipped',
};

export function containerStatusLabel(status: ContainerRunStatus): string {
  return CONTAINER_STATUS_LABELS[status];
}
