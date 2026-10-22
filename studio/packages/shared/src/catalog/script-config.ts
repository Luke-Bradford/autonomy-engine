import { z } from 'zod';
import { literalText, optionTitles, presented } from '../schemas/field-presentation.js';
import { SqlParameterValueSchema } from './dataset-config.js';

/**
 * #1600 OR41 C10a — a Script block's Type (activity catalogue §4.5, after ADF's
 * Script `scripts[].type`). A Query returns rows, which become one of the
 * activity's `resultSets`; a Non-query is DDL or DML, whose changed rows count
 * toward `recordsAffected`. Required, as in ADF: the two run differently, so a
 * default would guess which one the author meant.
 */
export const SCRIPT_BLOCK_TYPES = ['query', 'nonQuery'] as const;
export const scriptBlockTypeSchema = z.enum(SCRIPT_BLOCK_TYPES);
export type ScriptBlockType = z.infer<typeof scriptBlockTypeSchema>;

/**
 * #1600 OR41 C10a — *Capture result sets* (§4.5 Logging): how many of a Query
 * block's rows its result set keeps. Every row is still COUNTED (`rowCount`).
 * First 1000 rows is the default. The spec's third choice, *Up to the workspace
 * cap*, waits for a workspace setting of its own: the only row ceiling today is
 * Lookup max rows, which is Lookup's.
 */
export const SCRIPT_CAPTURE_MODES = ['off', 'firstRows'] as const;
export const scriptCaptureSchema = z.enum(SCRIPT_CAPTURE_MODES);
export type ScriptCapture = z.infer<typeof scriptCaptureSchema>;

/** The most blocks one Script may hold. ADF names none; a bound keeps one node's log bounded. */
export const SCRIPT_MAX_BLOCKS = 50;

/**
 * #1600 OR41 C10a — why a block's SQL breaks §8's literal rule, or `null`, as
 * `preCopyScriptIssue` decides it for Copy's Pre-copy script: a `${` substituted
 * into SQL would let a value become a statement. The schema refines on it (so
 * dispatch refuses a raw `${` too, since `prepInput` passes the SQL
 * unsubstituted) and the #444 write gate replays it with the node's address.
 * The block's Type is checked with it: it is literal for the same reason, and
 * the gate drops a schema issue at a `${}` value.
 */
export function scriptBlockIssues(
  config: Record<string, unknown>,
): { readonly path: readonly [number, 'sql' | 'type']; readonly message: string }[] {
  const blocks = config['blocks'];
  if (!Array.isArray(blocks)) return [];
  const issues: { path: readonly [number, 'sql' | 'type']; message: string }[] = [];
  blocks.forEach((block: unknown, i) => {
    if (block === null || typeof block !== 'object') return;
    const { sql, type } = block as Record<string, unknown>;
    if (typeof sql === 'string' && sql.includes('${')) {
      issues.push({
        path: [i, 'sql'],
        message:
          "a Script block's SQL stays literal, so '${' in it is never evaluated — write :name in the SQL and give its value in the block's Parameters",
      });
    }
    if (typeof type === 'string' && type.includes('${')) {
      issues.push({ path: [i, 'type'], message: "a Script block's Type is Query or Non-query" });
    }
  });
  return issues;
}

/**
 * The two variants type a bind value differently, for Copy's reason
 * (`copyInputShape`): an authored value is text that may hold a `${}`, a
 * dispatched one is what it resolved to.
 *
 * Not `.strict()`: the prepared input also carries the node's declared
 * `outputs`, which this schema leaves alone.
 */
const scriptInputShape = <B extends z.ZodType>(bindValue: B) =>
  z
    .object({
      runAsOneTransaction: presented(z.boolean().default(false), {
        title: 'Run as one transaction',
        description:
          'Runs every block in one transaction, so a failure undoes them all. Off, each block commits as it finishes, and a failure leaves the blocks before it applied.',
      }),
      captureResultSets: presented(scriptCaptureSchema.default('firstRows'), {
        title: 'Capture result sets',
        description:
          "How many of each Query block's rows its result set keeps, up to 1 MiB across the script. Every row is still counted in rowCount.",
        options: optionTitles(scriptCaptureSchema, {
          off: 'Off',
          firstRows: 'First 1000 rows',
        }),
      }),
      blocks: presented(
        z
          .array(
            z
              .object({
                type: presented(scriptBlockTypeSchema, {
                  title: 'Type',
                  options: optionTitles(scriptBlockTypeSchema, {
                    query: 'Query',
                    nonQuery: 'Non-query',
                  }),
                }),
                // LITERAL (§8): `scriptBlockIssues` refuses a `${` in it and the
                // reducer hands it over unsubstituted (`prepInput`).
                sql: presented(literalText(z.string().min(1)), {
                  title: 'SQL',
                  description:
                    'One statement. Literal: write :name for each value and give it in Parameters.',
                }),
                parameters: presented(z.record(z.string().min(1), bindValue).optional(), {
                  title: 'Parameters',
                  description:
                    'A value for each :name in the SQL, keyed without the colon, as a JSON object. A value may be ${...}.',
                }),
              })
              // Strict, so the dock draws the blocks as a table (`deriveElementFields`).
              .strict(),
          )
          .min(1)
          .max(SCRIPT_MAX_BLOCKS),
        {
          title: 'Script blocks',
          description:
            'Run in order on the connection. A Query block returns rows; a Non-query block changes data or schema.',
        },
      ),
    })
    .superRefine((cfg, ctx) => {
      for (const issue of scriptBlockIssues(cfg as Record<string, unknown>)) {
        ctx.addIssue({ code: 'custom', path: ['blocks', ...issue.path], message: issue.message });
      }
    });

/** The AUTHORED variant, which a form renders and the save gate checks. */
export const scriptConfigSchema = scriptInputShape(z.string());

/** The DISPATCH variant — what the adapter re-parses out of the prepared input. */
export const scriptDispatchConfigSchema = scriptInputShape(SqlParameterValueSchema);

export type ScriptConfig = z.infer<typeof scriptConfigSchema>;
export type ScriptDispatchConfig = z.infer<typeof scriptDispatchConfigSchema>;
