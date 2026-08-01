import { z } from 'zod';

/**
 * The FE/BE contract for the `GET /api/hello` endpoint. Kept deliberately tiny
 * for the P0a skeleton: it exists only to prove that a Zod schema authored
 * once in `@autonomy-studio/shared` validates data on the server AND supplies
 * an inferred type consumed by the web client.
 */
export const HelloSchema = z.object({
  message: z.string(),
  ts: z.number(),
});

export type Hello = z.infer<typeof HelloSchema>;

// P1a data model — Connection/Pipeline+Version/Trigger/Run/RunEvent/Secret
// Zod schemas + inferred types, the single source of truth shared by
// `@autonomy-studio/server` and `@autonomy-studio/web`.
export * from './schemas/index.js';

// P1c — version-stamped JSON export/import envelope + upgrade framework.
export * from './portability/index.js';

// P2a — the pure `${}` parameter language (inert substitution + validateRefs).
export * from './engine/index.js';

// P3 — the activity catalog (pure metadata; server supplies the adapters).
export * from './catalog/index.js';

// P4b — the pure run-window evaluator (scheduler's automatic-fire gate).
export * from './triggers/run-window.js';

// #2 L5 — the model price table + cost-estimate math (SSOT for the price fields
// stamped onto `activity.metered`; L6 sums the stamped costEstimate).
export * from './pricing/price-table.js';

// #866 — how a cost figure is WRITTEN DOWN (the never-render-spent-money-as-
// `$0.00` rule), shared so a second cost surface cannot re-decide it.
export * from './pricing/display.js';

// #2 L6 — the run-cost projection: a pure fold that SUMS the stamped
// `costEstimate` per run + per pipeline (fail-closed on an absent estimate).
export * from './pricing/run-cost.js';
