import { z } from 'zod';
import { literalText, optionTitles, presented } from '../schemas/field-presentation.js';
import { SqlParameterValueSchema } from './dataset-config.js';
import { LOOKUP_ROW_CAP } from './lookup-config.js';

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
/** The Type of a block that changes the store, which needs a writable connection. */
export const SCRIPT_NON_QUERY_BLOCK = 'nonQuery' satisfies ScriptBlockType;

/**
 * #1600 OR41 C10b-2a — a Script parameter's direction (§4.5, after ADF's
 * `scripts[].parameters[].direction` Input / Output / InputOutput). In is the
 * default and needs no entry. An Out parameter's value is never sent (ADF
 * ignores it too): it binds NULL, and its value is read back by NAME from the
 * one row the block returns, into `outputParameters`. In-out sends its value
 * and reads it back the same way. A procedure's `CALL` returns exactly that row,
 * its columns named after its INOUT and OUT parameters.
 */
export const SCRIPT_PARAMETER_DIRECTIONS = ['in', 'out', 'inOut'] as const;
export const scriptParameterDirectionSchema = z.enum(SCRIPT_PARAMETER_DIRECTIONS);
export type ScriptParameterDirection = z.infer<typeof scriptParameterDirectionSchema>;

/** The names a block reads back into `outputParameters`: its Out and In-out ones. */
export function scriptOutputParameterNames(block: {
  readonly parameterDirections?: Readonly<Record<string, ScriptParameterDirection>> | undefined;
}): string[] {
  return Object.entries(block.parameterDirections ?? {})
    .filter(([, direction]) => direction !== 'in')
    .map(([name]) => name);
}

/**
 * The rows one result set keeps under *First 1000 rows*. Lookup's default row
 * bound, for Lookup's reason: result sets are outputs, and outputs are durable.
 */
export const SCRIPT_RESULT_ROW_CAP = LOOKUP_ROW_CAP;

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

/** The block fields §8 keeps literal. */
type ScriptLiteralField = 'sql' | 'type' | 'parameterDirections';

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
): { readonly path: readonly [number, ScriptLiteralField]; readonly message: string }[] {
  const blocks = config['blocks'];
  if (!Array.isArray(blocks)) return [];
  const issues: { path: readonly [number, ScriptLiteralField]; message: string }[] = [];
  blocks.forEach((block: unknown, i) => {
    if (block === null || typeof block !== 'object') return;
    const { sql, type, parameterDirections } = block as Record<string, unknown>;
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
    // C10b-2a — a direction decides what is sent and what is read back, so it
    // is wiring, literal as the Type is.
    if (
      parameterDirections !== null &&
      typeof parameterDirections === 'object' &&
      Object.entries(parameterDirections).some(
        ([name, direction]) =>
          name.includes('${') || (typeof direction === 'string' && direction.includes('${')),
      )
    ) {
      issues.push({
        path: [i, 'parameterDirections'],
        message: "a Script parameter's direction is In, Out or In-out, and its name is literal",
      });
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
          firstRows: `First ${SCRIPT_RESULT_ROW_CAP} rows`,
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
                    'One statement. Write :name for each value and give it in Parameters; the SQL itself is never evaluated.',
                }),
                parameters: presented(z.record(z.string().min(1), bindValue).optional(), {
                  title: 'Parameters',
                  description:
                    'A value for each :name in the SQL, keyed without the colon. A value may be ${...}.',
                }),
                // LITERAL (§8), as the Type: `prepInput` evaluates only `parameters`.
                parameterDirections: presented(
                  z
                    .record(
                      z.string().min(1),
                      presented(scriptParameterDirectionSchema, {
                        title: 'Direction',
                        options: optionTitles(scriptParameterDirectionSchema, {
                          in: 'In',
                          out: 'Out',
                          inOut: 'In-out',
                        }),
                      }),
                    )
                    .optional(),
                  {
                    title: 'Parameter directions',
                    description:
                      'Out or In-out by parameter name; a name not listed is In. Read back by column name from the row a CALL returns, into outputParameters (PostgreSQL only).',
                  },
                ),
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
