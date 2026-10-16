import { z } from 'zod';
import { optionTitles, presented } from '../schemas/field-presentation.js';

/**
 * #996 M12 slice 2 (#1221, data-movement spec §5) — how many rows a `lookup`
 * may materialise into its declared outputs.
 *
 * `lookup` is the one activity whose rows become DURABLE. §5's rule that "rows
 * never enter `run_events`" is a statement about `copy`, and `lookup` is the
 * deliberate exception — which is why §5 gives it a CONCRETE bound rather than
 * a "bounded" one: "there is no generic output cap in studio", so nothing else
 * on the path would stop a lookup over a large table from writing that table
 * into the run log, once per attempt, re-parsed on every read of the log.
 *
 * #1600 OR41 C7a — it is also the default of a node's **Max rows**. Moved here
 * from the server's `limits.ts` so the schema that bounds Max rows and the
 * reader that enforces it share one constant.
 *
 * #1600 OR41 C7d — and the default of the workspace's **Lookup max rows**
 * (`WorkspaceSettings.lookupMaxRows`), the ceiling every Lookup run is held to.
 * A workspace may raise it to {@link LOOKUP_ROW_CEILING_MAX}. That does not
 * raise the worst case the run log holds: the durable bound is the 1 MiB
 * `LOOKUP_BYTE_CAP` (data-movement spec §5 ③), which stays fixed, so more rows
 * only ever means smaller rows.
 */
export const LOOKUP_ROW_CAP = 1000;

/**
 * #1600 OR41 C7d — the largest Lookup max rows a workspace may set, and so the
 * largest a node may ask for: ADF's Lookup limit ("can return up to 5000 rows",
 * https://learn.microsoft.com/azure/data-factory/control-flow-lookup-activity).
 */
export const LOOKUP_ROW_CEILING_MAX = 5000;

export const lookupOverLimitSchema = z.enum(['truncate', 'fail']);
export type LookupOverLimit = z.infer<typeof lookupOverLimitSchema>;
/** The choice's labels, one place for both Lookup modes (#1600 C7c). */
export const LOOKUP_OVER_LIMIT_OPTIONS = optionTitles(lookupOverLimitSchema, {
  truncate: 'Truncate and warn',
  fail: 'Fail',
});

/**
 * #1600 OR41 C7a — a Lookup's Settings tab (activity catalogue §4.2, after
 * ADF's Lookup `firstRowOnly`).
 *
 * Every default is TODAY's behaviour, not ADF's: a stored `lookup` node has
 * `config: {}`, and catalogue §8 lowers it to "not first row only" so its
 * `rows` result does not change. ADF's new-node default (First row only on) is
 * written into a NEW node instead, by the catalog entry's `newNodeConfig`.
 *
 * Not `.strict()`: the prepared input also carries the node's declared
 * `outputs`, which this schema leaves alone.
 */
export const lookupConfigSchema = z.object({
  firstRowOnly: presented(z.boolean().default(false), {
    title: 'First row only',
    description: 'Returns one row, as firstRow. Off returns every row, as rows.',
  }),
  // #1600 C7d — a node may ask for up to ADF's 5000; the run is held to the
  // workspace's Lookup max rows (Settings) as well, whichever is lower.
  maxRows: presented(z.number().int().min(1).max(LOOKUP_ROW_CEILING_MAX).default(LOOKUP_ROW_CAP), {
    title: 'Max rows',
    description: `Held to the workspace's Lookup max rows in Settings (${LOOKUP_ROW_CAP} unless changed). Not used with First row only.`,
  }),
  overLimit: presented(lookupOverLimitSchema.default('truncate'), {
    title: 'When over the limit',
    description: 'More than Max rows, or more data than a lookup may hold.',
    options: LOOKUP_OVER_LIMIT_OPTIONS,
  }),
});
export type LookupConfig = z.infer<typeof lookupConfigSchema>;
