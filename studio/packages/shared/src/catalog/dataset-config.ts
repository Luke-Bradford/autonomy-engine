import { z } from 'zod';
import { DatasetKindSchema, type DatasetKind } from '../schemas/dataset.js';

/**
 * #1119 M4 — the per-KIND shape of a `Dataset.config` (data-movement spec §2.6).
 *
 * `DatasetSchema.config` is a `z.record` at the schema level, exactly as
 * `ConnectionSchema.config` is, so §2.6 says the concrete shape "has to be
 * written down or it will be invented per ticket". This module is the dataset
 * half of that, deliberately mirroring `connection-config.ts` key for key: a
 * per-kind schema, an exhaustive `Record` keyed by the kind enum, a total
 * lookup function, and the kind list the authoring form's picker reads.
 *
 * WHERE IT IS ENFORCED, stated plainly because the honest answer is "not
 * everywhere yet": nothing validates a dataset's `config` on WRITE today —
 * `routes/datasets.ts` parses the row schema and stores `config` verbatim, the
 * same way `routes/connections.ts` runs no per-kind validation on a connection.
 * The gate that exists is at DISPATCH: the reader parses this schema before it
 * touches a store, and refuses a config that does not match. That is the
 * placement §8 argues for on the security-relevant half ("a file-backed dataset
 * must re-validate at dispatch and must not assume the stored connection is
 * well-formed"), but it does mean an operator learns about a malformed config
 * when a run fails rather than when they save. A save-time advisory on the
 * `connectionConfigAdvisory` precedent is worth having and is filed separately;
 * it would be an advisory, not a second gate.
 */

/**
 * A bare SQL identifier: a leading letter or underscore, then letters, digits,
 * underscores or `$`.
 *
 * Deliberately strict, and the strictness IS the security control (§8): a table
 * or schema name cannot be bound as a parameter, so the only two safe options
 * are "refuse anything that is not obviously an identifier" and "quote it". The
 * reader does BOTH — this shape check at the boundary, and `"`-quoting with
 * embedded-quote doubling at the point of interpolation. Names needing quoting
 * to be legal (spaces, leading digits, reserved words) are refused rather than
 * accommodated: §8's rule is that a dynamic identifier "is not 'risky if you are
 * careful'; it is unbindable, so it is prohibited", and the same reasoning
 * applies to an identifier that only a quoting rule makes safe.
 */
export const SQL_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/** Whether `value` is a bare SQL identifier (`SQL_IDENTIFIER_RE`) — the one
 * predicate both the schemas below and the reader's quoter consult. */
export function isSqlIdentifier(value: string): boolean {
  return SQL_IDENTIFIER_RE.test(value);
}

const sqlIdentifier = (label: string) =>
  z.string().refine(isSqlIdentifier, {
    message: `${label} must be a bare SQL identifier (letters, digits, _ or $; not starting with a digit)`,
  });

/**
 * A value a `query` dataset binds as a SQL PARAMETER.
 *
 * `boolean` is deliberately absent, and this was measured rather than assumed:
 * `better-sqlite3@12.11.1` throws `TypeError: SQLite3 can only bind numbers,
 * strings, bigints, buffers, and null` on a boolean. Declaring one here would
 * move a runtime throw mid-scan to a config-parse refusal, but it would still
 * be a value nobody can use — so the type says what the driver accepts. An
 * author who means a SQLite boolean writes `0` or `1`, which is what the column
 * holds anyway.
 */
export const SqlParameterValueSchema = z.union([z.string(), z.number(), z.null()]);
export type SqlParameterValue = z.infer<typeof SqlParameterValueSchema>;

/** `table` — a whole table in the store, addressed by identifier (§2.6). */
export const tableDatasetConfigSchema = z.object({
  /** Optional namespace. SQLite has no schemas in the Postgres sense but does
   * have ATTACHed database aliases, and `postgres` (M10) needs it for real. */
  schema: sqlIdentifier('schema').optional(),
  table: sqlIdentifier('table'),
});

/**
 * `query` — a literal SQL statement, with named parameters bound (§2.6, §8).
 *
 * `sql` is LITERAL: `${}` in a copy node reaches the parameter VALUES, never the
 * statement text, so injection is impossible by construction rather than by
 * escaping. The reader enforces the other half — it only ever `prepare(...)`s
 * this string and steps it as a cursor, never `run`s or `exec`s it, so a
 * statement that returns no rows (an `ATTACH`, an `UPDATE`, a `PRAGMA`) is
 * refused instead of executed.
 */
export const queryDatasetConfigSchema = z.object({
  sql: z.string().min(1),
  /** Named bind values, keyed WITHOUT the `:` prefix the SQL carries. */
  parameters: z.record(z.string().min(1), SqlParameterValueSchema).optional(),
});

/**
 * The config shape for a kind whose READER has not been built yet.
 *
 * Explicitly permissive — `z.looseObject` KEEPS unknown keys, where a bare
 * `z.object({})` would strip them. That difference matters: M2 already ships the
 * `delimited` and `excel` kinds in the address vocabulary (portability has to
 * round-trip them), so a config authored today must survive a parse unchanged
 * rather than come back empty.
 *
 * Permissive here is NOT fail-open, because this schema is never the gate. The
 * gate is `IMPLEMENTED_DATASET_KINDS`: the reader consults that positive fact
 * and refuses a kind it cannot read, so "no reader yet" is a stated refusal
 * rather than an empty shape that happens to validate everything.
 */
export const unimplementedDatasetConfigSchema = z.looseObject({});

/**
 * Every kind's dataset-config schema, keyed by kind.
 *
 * Typed `Record<DatasetKind, …>` for the same reason
 * `CONNECTION_CONFIG_SCHEMAS` is: adding a kind to `DatasetKindSchema` without
 * giving it a config schema is then a TYPE ERROR. That is M2's own lesson —
 * "the pin precedes the kind, deliberately" — applied one layer down.
 */
export const DATASET_CONFIG_SCHEMAS: Record<DatasetKind, z.ZodObject> = {
  delimited: unimplementedDatasetConfigSchema,
  excel: unimplementedDatasetConfigSchema,
  table: tableDatasetConfigSchema,
  query: queryDatasetConfigSchema,
};

/**
 * The dataset kinds a reader exists for — M4's `table` and `query`.
 *
 * A POSITIVE fact, and that is the point: the alternative (infer "unimplemented"
 * from a permissive schema) would make the refusal an accident of shape, so a
 * kind whose real schema happened to be permissive would silently become
 * readable. `delimited` joins at M7, `excel` at M11.
 */
export const IMPLEMENTED_DATASET_KINDS: ReadonlySet<DatasetKind> = new Set<DatasetKind>([
  'table',
  'query',
]);

/** Whether a reader exists for `kind` (`IMPLEMENTED_DATASET_KINDS`). */
export function datasetKindIsImplemented(kind: DatasetKind): boolean {
  return IMPLEMENTED_DATASET_KINDS.has(kind);
}

/** The dataset-config schema for `kind`. Total over the kind enum. */
export function datasetConfigSchema(kind: DatasetKind): z.ZodObject {
  return DATASET_CONFIG_SCHEMAS[kind];
}

/** Every kind, in the enum's own order — the form's kind picker reads this. */
export const DATASET_KINDS: readonly DatasetKind[] = DatasetKindSchema.options;
