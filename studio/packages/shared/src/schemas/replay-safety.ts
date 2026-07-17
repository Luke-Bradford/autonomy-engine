import { z } from 'zod';
import { jsonReplaySafetyErrors } from '../engine/params.js';

/**
 * Shared #547 write-boundary guard. Walk each param VALUE for a non-finite
 * number (`Infinity`/`-Infinity`/`NaN` — which `JSON.stringify` silently loses to
 * `null` on the event-sourced `run.started` append→replay) and raise ONE Zod
 * issue per offending path. Factored out of the two byte-identical `superRefine`
 * loops (`TriggerParamsWriteSchema` in `trigger.ts`, `FireRequestSchema` in
 * `fire-result.ts`) so they cannot drift.
 *
 * Lives in the schema layer, taking a `z.RefinementCtx`, precisely so the
 * engine-layer `jsonReplaySafetyErrors` stays Zod-free (that boundary is
 * deliberate — `engine/params.ts` imports no `zod`).
 */
export function addParamsReplaySafetyIssues(
  params: Record<string, unknown>,
  ctx: z.RefinementCtx,
): void {
  for (const [name, value] of Object.entries(params)) {
    for (const message of jsonReplaySafetyErrors(`params.${name}`, value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    }
  }
}
