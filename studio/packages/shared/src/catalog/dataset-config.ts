import { z } from 'zod';
import { isValidDateFormat } from '../datamove/coerce.js';
import { FORMAT_TOKEN_NAMES } from '../engine/functions.js';
import { formatZodIssues } from '../schemas/zod-issues.js';
import type { ConnectionKind } from '../schemas/connection.js';
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
 * The text encodings a `delimited` file may declare (#1163, M7 slice 1).
 *
 * A CLOSED set, and each member is named for what Node's `TextDecoder` ACTUALLY
 * decodes rather than for what an operator might hope. Measured on node v25.9.0:
 * `new TextDecoder('latin1').encoding` is `windows-1252`, and so is `ascii`'s —
 * both labels are aliases for cp1252, which maps every byte and therefore never
 * refuses one. Offering `latin1` would promise ISO-8859-1's C1 controls and
 * silently deliver `€` for `0x80`; offering `ascii` would promise a 7-bit
 * refusal that never comes. So the member is `windows-1252`, which is true.
 *
 * Closed because an unrecognised label reaching `new TextDecoder(label)` throws
 * a raw `RangeError` that nothing in the connector error model maps — a refusal
 * at the config boundary is the same fact, said where it can be understood.
 */
export const DELIMITED_ENCODINGS = ['utf-8', 'utf-16le', 'utf-16be', 'windows-1252'] as const;
export const DelimitedEncodingSchema = z.enum(DELIMITED_ENCODINGS);
export type DelimitedEncoding = z.infer<typeof DelimitedEncodingSchema>;

/** The three roles a single character can play in a delimited file. Sharing one
 * character between any two of them makes the grammar ambiguous with itself. */
const DELIMITED_ROLES = ['delimiter', 'quote', 'escape'] as const;

/**
 * A single character that is not a row terminator.
 *
 * ONE character, deliberately: a multi-character delimiter is a different
 * parser, and admitting it here would leave a config that saves cleanly and then
 * splits nothing. A terminator (`\n`, `\r`) in any of the three roles would make
 * the end of a field indistinguishable from the end of a row.
 */
const delimitedChar = (role: string) =>
  z
    .string()
    .length(1, { message: `${role} must be exactly one character` })
    .refine((c) => c !== '\n' && c !== '\r', {
      message: `${role} cannot be a line terminator`,
    });

/**
 * `delimited` — a separated-values FILE in an `fs` store (§2.6). #1163, M7 slice 1.
 *
 * §2.6's eight keys, in full. (Four places in the tree list seven and omit
 * `escape`; #1163 corrects them.)
 *
 * **WHAT IS DEFAULTED, AND WHY `header` IS NOT.** §2.6 authorises a default for
 * `delimiter` alone. `quote` and `encoding` are defaulted here as well, because a
 * separated-values file that declares neither is overwhelmingly RFC 4180 UTF-8
 * and because guessing either WRONG produces visibly mangled text — a failure an
 * operator sees immediately rather than a plausible wrong value they never do.
 *
 * `header` fails that test in both directions and therefore carries NO default:
 * defaulted true it EATS ROW 1 of a headerless file and names every column after
 * a data value; defaulted false it turns the header into a data row. Either way
 * the copy succeeds and the data is wrong, which is the one outcome this spec
 * exists to prevent. §2.6's own M4 correction is the precedent, and it goes
 * further — `configForm.ts`'s `ABSENTABLE_WRAPPERS` treats a `.default()`ed field
 * as optional, and an unchecked optional box OMITS its key, so a defaulted
 * `header` could not be set to `false` distinguishably from "not set" at all.
 * That is exactly how `readonly` became `writable`.
 *
 * `header: false` stays expressible, because it is a real property of real
 * files. Naming its columns is the READER's problem and is settled in the
 * parser's docblock, not here.
 *
 * `nullValue` has NO `.min(1)` and that is load-bearing: `coerceValue` tests
 * `opts.nullValue !== undefined`, so `''` is a meaningful declaration ("an empty
 * field means NULL") for a file that uses one. A minimum length would read as
 * tidying and would silently delete that capability.
 *
 * `dateFormat` is validated against the coercion matrix's OWN compiler
 * (`isValidDateFormat`), so a format every row would reject is refused at save
 * rather than discovered once per row at run time.
 */
export const delimitedDatasetConfigSchema = z
  .object({
    /** Confined against the `fs` connection's `roots` at DISPATCH, never here
     * (§8) — this schema is shared with the browser and knows no filesystem. */
    path: z.string().min(1),
    delimiter: delimitedChar('delimiter').default(','),
    quote: delimitedChar('quote').default('"'),
    /** Absent means RFC 4180: a doubled quote is the only escape. Declaring one
     * ADDS "the next character is literal" inside a quoted field. */
    escape: delimitedChar('escape').optional(),
    header: z.boolean(),
    encoding: DelimitedEncodingSchema.default('utf-8'),
    /** §6.4 — the NULL sentinel. Default: none, so an empty field is the empty
     * STRING. CSV cannot distinguish `""` from absent and studio will not guess. */
    nullValue: z.string().optional(),
    /** §6.2 — the ONLY way a textual date is read. Absent plus a `date`/
     * `timestamp` target is a refusal (`no_date_format`), never a guess. */
    dateFormat: z
      .string()
      .refine(isValidDateFormat, {
        message:
          `dateFormat must use the closed token set (${FORMAT_TOKEN_NAMES.join(', ')}), ` +
          'each at most once',
      })
      .optional(),
  })
  .superRefine((config, ctx) => {
    // Reported on the SECOND role of each colliding pair, so the message names a
    // field. An object-level issue carries `path: []`, and `formatZodIssues`
    // then prints it with no prefix at all — the operator would be told two
    // things clash without being told which control to touch.
    for (let i = 0; i < DELIMITED_ROLES.length; i += 1) {
      for (let j = i + 1; j < DELIMITED_ROLES.length; j += 1) {
        const a = DELIMITED_ROLES[i] as (typeof DELIMITED_ROLES)[number];
        const b = DELIMITED_ROLES[j] as (typeof DELIMITED_ROLES)[number];
        if (config[a] === undefined || config[a] !== config[b]) continue;
        ctx.addIssue({
          code: 'custom',
          path: [b],
          message: `${b} cannot be the same character as ${a} ('${String(config[a])}')`,
        });
      }
    }
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
  delimited: delimitedDatasetConfigSchema,
  excel: unimplementedDatasetConfigSchema,
  table: tableDatasetConfigSchema,
  query: queryDatasetConfigSchema,
};

/**
 * The dataset kinds a reader exists for — M4's `table` and `query`, and M7's
 * `delimited` (#1167, the slice that wired the `fs` copy arm).
 *
 * A POSITIVE fact, and that is the point: the alternative (infer "unimplemented"
 * from a permissive schema) would make the refusal an accident of shape, so a
 * kind whose real schema happened to be permissive would silently become
 * readable. `excel` joins at M11.
 *
 * IT IS "A READER EXISTS", NOT "THIS STORE READS IT", and the distinction stopped
 * being academic the moment this set held kinds from two different stores. A
 * store adapter that used this as a proxy for its OWN vocabulary would, from
 * #1167 on, accept a `delimited` dataset and then try to parse its config as a
 * table target — the right refusal for the wrong reason, or none at all. Both
 * store readers therefore name their own kinds literally (`sqlite.ts`'s
 * `statementFor`, `delimited-io.ts`'s `prepareRead`), and this set answers only
 * the question it is named for.
 */
export const IMPLEMENTED_DATASET_KINDS: ReadonlySet<DatasetKind> = new Set<DatasetKind>([
  'table',
  'query',
  'delimited',
]);

/** Whether a reader exists for `kind` (`IMPLEMENTED_DATASET_KINDS`). */
export function datasetKindIsImplemented(kind: DatasetKind): boolean {
  return IMPLEMENTED_DATASET_KINDS.has(kind);
}

/**
 * #1120 — what this kind's own schema says about a dataset's `config`, as ONE
 * operator-facing sentence, or `null` when it has nothing to say.
 *
 * ADVISORY, never a gate, on `connectionConfigAdvisory`'s precedent and for its
 * stated reason: every shape this reports is one the server stores TODAY
 * (`routes/datasets.ts` parses the ROW schema and keeps `config` verbatim, and
 * `workspace-apply.ts` writes it verbatim on git import). Hardening it into a
 * refusal would make an already-stored row unsaveable after an unrelated rename,
 * and would need a decision about pre-existing rows and about git import that is
 * a bigger question than this. The form must never refuse what the server
 * accepts; saying so BEFORE a run fails is the whole point.
 *
 * The gate that does exist is at DISPATCH — the reader parses the same schema
 * before it touches a store (§8) — so this closes the gap between "saved" and
 * "learned about when a run failed", nothing more.
 */
export function datasetConfigAdvisory(
  kind: DatasetKind,
  config: Record<string, unknown>,
): string | null {
  const notes: string[] = [];

  const parsed = DATASET_CONFIG_SCHEMAS[kind].safeParse(config);
  if (!parsed.success) notes.push(formatZodIssues(parsed.error.issues));

  // A kind with no reader yet. Reported from the POSITIVE fact
  // (`IMPLEMENTED_DATASET_KINDS`), never inferred from the permissive shape of
  // `unimplementedDatasetConfigSchema` — that schema validates everything, so a
  // shape-based inference would go quiet the moment a real schema happened to be
  // permissive too. Worth saying even though the config parses: a dataset that
  // saves cleanly and then refuses every copy naming it is exactly the
  // silent-until-dispatch surprise this function exists to end.
  if (!datasetKindIsImplemented(kind)) {
    notes.push(
      `no reader exists for a ${kind} dataset yet, so a copy naming it is refused at dispatch`,
    );
  }

  return notes.length === 0 ? null : notes.join('; ');
}

/** The dataset-config schema for `kind`. Total over the kind enum. */
export function datasetConfigSchema(kind: DatasetKind): z.ZodObject {
  return DATASET_CONFIG_SCHEMAS[kind];
}

/** Every kind, in the enum's own order — the form's kind picker reads this. */
export const DATASET_KINDS: readonly DatasetKind[] = DatasetKindSchema.options;

/**
 * #1145 — which store kinds a dataset of each kind can actually live in.
 *
 * `Dataset.connectionId` is checked for EXISTENCE and OWNERSHIP on write
 * (`routes/datasets.ts` → `requireOwnedConnection`) and for nothing else, so a
 * `table` dataset may name an `anthropic_api` connection and the server stores
 * it. This is the fact that was missing to say so.
 *
 * WHERE EACH ROW COMES FROM, because half of it was called unsettled when the
 * ticket was filed and only two thirds of that was still true:
 * - `table`, `query` → a SQL store. §2.6's store-connection table names exactly
 *   two, `sqlite` and `postgres`. Both are now in `ConnectionKindSchema` (#1189,
 *   M10 slice 1), and `postgres` is STILL NOT LISTED HERE — see the next
 *   paragraph, because that is a decision, not the lag it used to be.
 * - `delimited` → `fs`. SETTLED: §12's M7 row is "`delimited` dataset kind over
 *   the existing `fs` connection", §7 ② says "`fs` becomes a store when
 *   `delimited` lands", and `registry.ts`'s `copy` entry already says in prose
 *   that "a `delimited` dataset lives on an `fs` connection".
 * - `excel` → `fs`. INFERRED, and flagged as inference rather than dressed up as
 *   a citation: M11's row names no connection. The support is §2.5 — format
 *   lives on the dataset precisely BECAUSE one folder holds CSV and Excel side
 *   by side — plus §2.6 giving `excel` a `path`. M11 restates it or corrects it.
 *
 * WHY `postgres` IS ABSENT FROM `table`/`query` (#1189, M10 slice 1). It is a
 * store, so the pin's own instruction — "decide whether it is a STORE; if it is,
 * add it to every dataset kind that can live in it" — points at adding it. The
 * answer is NOT YET, and the reason is what this map is FOR. Listing a store
 * here is what lets an operator author a dataset against it: the form stops
 * warning, `datasetConnectionKindAdvisory` falls silent, and the dataset saves
 * clean. Slice 1 ships no reader and no writer for postgres, so every one of
 * those datasets would then fail at dispatch — a shape the spec already names as
 * the trap M5's slice 4 was split to avoid (§12's M5 row: a catalog entry landed
 * before the resolution seam "would have been a user-visible activity that always
 * fails at dispatch"). Holding it back costs nothing, because the existing
 * `DATASET_CONNECTION_MISMATCH` dispatch gate refuses the binding anyway; what it
 * buys is that the refusal happens where the dataset is AUTHORED. Slice 2 adds
 * `'postgres'` to `table` and `query` in the same commit as the reader.
 *
 * `Record<DatasetKind, …>` makes a new DATASET kind a compile error, as
 * `DATASET_CONFIG_SCHEMAS` does. It cannot do the same for a new CONNECTION
 * kind, which is the direction that would make this lie: when `postgres` joins
 * the enum, a perfectly good `table` dataset on a postgres store would be told
 * to expect `sqlite`. A docblock cannot prevent that, so the test file pins
 * `ConnectionKindSchema.options` against a literal list — adding a connection
 * kind reds this module, which is M2's "the pin precedes the kind" convention
 * pointed at the axis that actually needs it.
 */
export const DATASET_CONNECTION_KINDS: Record<DatasetKind, readonly ConnectionKind[]> = {
  delimited: ['fs'],
  excel: ['fs'],
  table: ['sqlite'],
  query: ['sqlite'],
};

/**
 * #1145 — whether this dataset's kind agrees with the kind of store it names,
 * as ONE operator-facing sentence, or `null` when it has nothing to say.
 *
 * A SEPARATE function rather than a branch inside `datasetConfigAdvisory`, which
 * is what #1145 literally asked for. That function's whole signature is
 * `(kind, config)`: it judges a dataset against its OWN config and needs nothing
 * else. This question needs the store's kind, so folding it in would widen that
 * signature to carry a parameter half its logic ignores, and would fuse two notes
 * that must be able to fire independently — the `delimited`-on-`sqlite` case is
 * BOTH unreadable and mis-stored, and the operator needs to be told both.
 *
 * ADVISORY, never a gate, for `datasetConfigAdvisory`'s reason above: the server
 * stores these rows today, so refusing one here would make an already-saved
 * dataset unsaveable after an unrelated rename, and the form must never refuse
 * what the server accepts.
 *
 * WHAT REFUSES AT DISPATCH, stated precisely because the obvious guess is wrong.
 * A mismatched pair cannot reach a reader with a poor message — it cannot reach
 * a reader at all. Two refusals form a pincer, and which one fires depends on
 * what the copy NODE bound:
 * - node bound the non-store connection → `CONNECTION_KIND_INVALID`
 *   (`run/executor.ts:401`), because `copy` declares `connectionKinds:
 *   ['sqlite']` and the executor resolves the CONNECTION (`:1098`, `:1124`)
 *   before it resolves any dataset (`:1194`, `:1223`);
 * - node bound the store, dataset names the non-store →
 *   `DATASET_CONNECTION_MISMATCH` (`run/executor.ts:629`), the identity check.
 * Both are `permanent`. So dispatch is fail-SAFE and this closes a diagnostics
 * gap, not a correctness hole. That property is INHERITED, not owned: it holds
 * while `copy.connectionKinds` lists store kinds only. An activity that accepted
 * a non-store connection would drop the first arm, and this advisory would then
 * be the only thing that had ever mentioned the mismatch.
 *
 * A `null` `connectionKind` — no connection selected, or one that no longer
 * exists — says NOTHING, deliberately. The form already has its own notes for
 * both of those states, and a second sentence derived from a connection nobody
 * resolved would be a complaint invented on a fact that was never established.
 * Those notes are cited by their GUARD rather than by line — `DatasetsPage.tsx`
 * renders one under `connections.length === 0` and one under `boundIsUnresolved`.
 * The line numbers this docblock first carried were already stale by the time it
 * was committed, because the block it cites sits BELOW the code the same commit
 * inserted. A name survives that; a line number re-rots on the next edit.
 */
export function datasetConnectionKindAdvisory(
  kind: DatasetKind,
  connectionKind: ConnectionKind | null,
): string | null {
  if (connectionKind === null) return null;
  const expected = DATASET_CONNECTION_KINDS[kind];
  if (expected.includes(connectionKind)) return null;
  // Phrased so no kind name ever follows an indefinite article. `excel`,
  // `anthropic_api`, `agent_cli` and `openai_api` are all vowel-initial, so the
  // natural "a ${kind} dataset ... a ${connectionKind} connection" reads "a
  // excel dataset ... a anthropic_api connection" for a third of the matrix.
  // Restructuring is better than an `an`-aware helper: the article rule is
  // orthographic rather than phonetic for identifiers nobody says aloud, and a
  // helper would have to be re-litigated for every kind added.
  const stores = expected.map((store) => `'${store}'`).join(' or ');
  return `dataset kind '${kind}' lives in a store of kind ${stores}, but this one names a connection of kind '${connectionKind}'`;
}
