import type { PipelineCostRollup } from '@autonomy-studio/shared';
import { costFigure, costHeadline, costSentence, tokenSummary } from './costReading';

/**
 * #931 (U27 slice 2) — what the run list says about ONE PIPELINE's lifetime spend.
 *
 * `GET /api/pipelines/:id/cost` has existed since #599 and had no web caller at
 * all: the money it serves was reachable only by opening runs one at a time and
 * adding them up. This is the reading that surfaces it.
 *
 * PURE, and split out of the page for the reason every `runs/` decision module is:
 * every sentence below is a function of the rollup, so it can be tested — and
 * mutation-proven — without mounting a page.
 *
 * ## Why this is not a second wording
 *
 * The figure and the reading sentence come from `costReading`, the one authority
 * the per-node and per-run surfaces already use, so a pipeline cannot be told a
 * different story about the same money. What is genuinely NEW here is only what
 * the other two surfaces have no analogue for: how many RUNS were folded, how
 * many of them had spend nobody could price, and — the part that matters most —
 * what this total leaves out.
 *
 * ## What it leaves out, and why saying so is the point
 *
 * Two exclusions, both silent and both understatements:
 *
 *  - **Sub-pipeline spend.** `aggregatePipelineCost` scopes on
 *    `pipelineVersions.pipelineId`, and a `call_pipeline` child is created against
 *    the CALLED pipeline's version (`run/child.ts`), under its own run id. So a
 *    caller's rollup contains none of what its children spent. This is #932's
 *    finding at run scope, and it is strictly LARGER here — a whole pipeline's
 *    worth of children rather than one run's. Unlike #932 this surface cannot
 *    enumerate them: `PipelineCostRollup` carries no child ids, so it is one flat
 *    sentence rather than a list of links.
 *  - **In-flight runs.** A running run's metered events are already in the sum, so
 *    the figure is spend-so-far for that part and will rise. The rollup carries no
 *    running-run count, so this CANNOT be conditioned — and deriving it from the
 *    rows on screen would be worse than not saying it, because those rows are
 *    filtered and the figure is not. It is therefore stated unconditionally, as a
 *    property of the figure rather than a claim about today.
 *
 * Understating is the safe direction — nothing is double-counted, and every
 * excluded penny is counted somewhere else. It is only safe once it is legible.
 *
 * ## Scope, which is the other thing a reader would get wrong
 *
 * The rollup is EVERY run of the pipeline, every version, every status, all time.
 * The rows underneath it are narrowed by status/window/trigger and the origin tab.
 * Those two sets are routinely different, so the scope sentence is not decoration:
 * without it the figure reads as the total of what is on screen.
 */
export interface PipelineCostSummary {
  /**
   * The headline, or `null` when the pipeline has never run — where every one of
   * `costFigure`'s five readings would be a claim about a measurement nobody took.
   */
  figure: string | null;
  /** The shared reading sentence, or the never-run statement. */
  reading: string;
  /** What the figure covers, always — the sentence that stops it reading as the total of the rows. */
  scope: string;
  /** The token line, or `null` when there is nothing measured to report. */
  tokens: string | null;
  /** The two exclusions, or `null` when there is no figure to qualify. */
  excludes: string | null;
  /** How much of the figure is a lower bound, or `null` when none of it is. */
  incomplete: string | null;
}

function runs(count: number): string {
  return `${count} run${count === 1 ? '' : 's'}`;
}

export function pipelineCostSummary(rollup: PipelineCostRollup): PipelineCostSummary {
  /* A pipeline that has never run is not a cheap pipeline, and every reading
     below would say it was. `costFigure` would print "No billed exchange" (true
     of a pipeline that RAN and billed nothing — a different fact) and
     `tokenSummary` "0 in · 0 out", which `tokenSideReported` deliberately treats
     as a measured zero. Both are honest about a scope that executed; neither is
     honest about one that never did. */
  if (rollup.runCount === 0) {
    return {
      figure: null,
      reading: 'This pipeline has not run yet.',
      scope: 'This pipeline has not run yet, so there is no spend to show.',
      tokens: null,
      excludes: null,
      incomplete: null,
    };
  }

  const headline = costHeadline(rollup);
  return {
    figure: costFigure(headline),
    reading: costSentence(
      {
        ...headline,
        exchangeCount: rollup.responseCount,
        unknownCount: rollup.costUnknownResponseCount,
        coveredCount: rollup.unpricedResponseCount,
      },
      'pipeline',
    ),
    scope: `Across all ${runs(rollup.runCount)}, every version — not just the runs listed below.`,
    /* Ungated once the pipeline HAS run. A pipeline that ran and billed nothing
       measured a real `0 in · 0 out`, which is what `tokenSideReported` answers
       TRUE for by design — and the AI-activity totals tile renders it on exactly
       the same argument for an idle window. Suppressing it here would be this
       module inventing a second policy for the same question. Only the never-run
       case above withholds a token line, because there the zero was never
       measured at all. */
    tokens: tokenSummary(rollup),
    excludes:
      'Excludes what any sub-pipeline this one calls spent — a called pipeline bills to its own run, and its spend is counted there. A run still running contributes what it has spent so far, so this figure can rise.',
    incomplete:
      rollup.incompleteRunCount > 0
        ? `${rollup.incompleteRunCount} of the ${runs(rollup.runCount)} had spend nobody could price.`
        : null,
  };
}
