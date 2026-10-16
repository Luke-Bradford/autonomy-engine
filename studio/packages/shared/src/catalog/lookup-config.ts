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
 * #1600 OR41 C7a — it is also the ceiling on a node's **Max rows**, which can
 * only LOWER it. Moved here from the server's `limits.ts` so the schema that
 * bounds Max rows and the reader that enforces it share one constant. Raising
 * it per workspace is C7b's.
 */
export const LOOKUP_ROW_CAP = 1000;

const overLimitSchema = z.enum(['truncate', 'fail']);
export type LookupOverLimit = z.infer<typeof overLimitSchema>;

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
    description:
      'Return the first row as firstRow. Off returns every row, up to Max rows, as rows.',
  }),
  maxRows: presented(z.number().int().min(1).max(LOOKUP_ROW_CAP).default(LOOKUP_ROW_CAP), {
    title: 'Max rows',
    description: `The most rows to return, up to ${LOOKUP_ROW_CAP}. Not used with First row only.`,
  }),
  overLimit: presented(overLimitSchema.default('truncate'), {
    title: 'When over the limit',
    description:
      'What happens when the source has more than Max rows, or more data than a lookup may hold. Truncate returns the rows that fit and warns.',
    options: optionTitles(overLimitSchema, { truncate: 'Truncate and warn', fail: 'Fail' }),
  }),
});
export type LookupConfig = z.infer<typeof lookupConfigSchema>;
