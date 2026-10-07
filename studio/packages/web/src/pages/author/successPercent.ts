/** #1569 OR37 — the pipelines grid's Success % cell. */

/** A rate as a whole percent that never rounds a failure away (249 of 250 is
 * 99%, not 100%) nor a success (1 of 250 is 1%, not 0%). */
export function percentOf(succeeded: number, failed: number, rate: number): number {
  const pct = Math.round(rate * 100);
  if (failed > 0 && pct === 100) return 99;
  if (succeeded > 0 && pct === 0) return 1;
  return pct;
}
