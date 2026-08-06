import type { RunSummary } from '@autonomy-studio/shared';
import { TERMINAL_RUN_ROW_STATUS } from '@autonomy-studio/shared';
import { costFigure, costHeadline, unsettledSentence } from './costReading';

/**
 * #931 (U27 slice 2) — what ONE CELL of the run list's Cost column says.
 *
 * The column exists because cost was previously reachable only by opening a run,
 * so comparing what two runs cost meant opening both. What it must NOT do is buy
 * that convenience by shedding the honesty the detail page pays for: `costFigure`
 * already answers three of its five readings with WORDS rather than a number
 * (`No billed exchange` · `No marginal cost` · `Cost unknown`), which is exactly
 * the right shape for a cell — it is the same authority, not a compact
 * re-statement of it that could disagree.
 *
 * What a cell CANNOT carry is the detail page's paragraph of caveats, so this
 * decides which of them still change what the number MEANS at a glance, and
 * therefore have to survive the compression:
 *
 *  - **Not settled.** A live run's figure is spend-SO-FAR. Rendered bare it reads
 *    with exactly the confidence of a final total — the failure
 *    `unsettledSentence` exists to prevent — so this one gets VISIBLE text, not a
 *    hover. It is also the reason `RunSummary` is allowed to carry a cost at all:
 *    that schema's own docblock forbids a field that is "immediately wrong", and
 *    a moving figure is only a true statement of spend-so-far while it says so.
 *  - **A rerun's figure is INCREMENTAL.** A rerun-from-failed does not re-run its
 *    successful prefix (RS6 copies the frontier and emits no `activity.metered`
 *    for it), so its total is what it RE-EXECUTED. Understating is the safe
 *    direction — nothing is double-counted and the source run keeps its own spend
 *    — but only once it is legible, and this list is where a rerun sits directly
 *    beside the run it came from, looking cheaper for no visible reason. Nothing
 *    else in the row says a run is a rerun (the Trigger cell's em-dash means
 *    "rerun OR deleted trigger", deliberately), so the cell has to.
 *
 * The caveats `readCost` adds and this drops — floor-not-census exchange counts,
 * per-side token reporting — qualify facts the column does not show. They are
 * dropped rather than defaulted: see `costKindOf`, which is why the classification
 * takes the narrow `RunCost` the SQL aggregate can actually produce.
 */
export interface CostCell {
  /** The headline, from the same authority the detail page uses. */
  figure: string;
  /**
   * Whether to render the visible "so far" qualifier: the run has not reached a
   * terminal row status, so more may still be billed to it.
   */
  unsettled: boolean;
  /**
   * The full caveat sentence(s) for the cell's `title`, or `null` when the figure
   * needs no qualifying. Demoting secondary detail to a title is this table's
   * existing convention (the pipeline cell hides the version id there, the
   * duration cell the finish timestamp); the DIFFERENCE here is that `unsettled`
   * is deliberately not demoted, because it changes what the number means rather
   * than adding to it.
   */
  note: string | null;
}

/**
 * A rerun keyed on `rerunOf`, which is the only evidence the LIST has — the run
 * detail page keys the same fact on the fold (`reusedSpend`, from
 * `run.reseeded`'s copied nodes), because there it renders in cases the REST read
 * does not. Both are true; they differ in what is in hand.
 *
 * Note it is a different predicate from `runOriginOf`'s "manual" (`triggerId` and
 * `parentRunId` both null), which a rerun also satisfies. That one answers "who
 * started this", this one "did it reuse work" — a rerun is manual AND
 * incremental, and neither predicate implies the other's meaning.
 *
 * Worded to stay TRUE when the copied frontier was EMPTY (the first node failed,
 * so nothing was reusable): "any work it reused" is then vacuous, where "excludes
 * the work it reused" would assert something that did not happen.
 */
function rerunNote(rerunOf: string): string {
  return `A rerun from failure: it re-executed only from the failure onward, so any work it reused was billed to run ${rerunOf} and is not counted here.`;
}

/** Everything the cell reads — a `RunSummary`, narrowed to the three facts. */
export type CostCellRun = Pick<RunSummary, 'cost' | 'status' | 'rerunOf'>;

export function costCell(run: CostCellRun): CostCell {
  const headline = costHeadline(run.cost);
  const unsettled = !TERMINAL_RUN_ROW_STATUS.has(run.status);
  const notes: string[] = [];
  /* The unsettled sentence comes from `costReading` rather than being written
     here, so the list and the detail page cannot word the same caveat two ways —
     and it already picks between "spent SO FAR" and "more may still be billed"
     depending on whether the headline is a number at all. */
  if (unsettled) notes.push(unsettledSentence(headline, 'run'));
  if (run.rerunOf !== null) notes.push(rerunNote(run.rerunOf));
  return {
    figure: costFigure(headline),
    unsettled,
    note: notes.length > 0 ? notes.join(' ') : null,
  };
}
