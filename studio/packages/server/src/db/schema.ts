import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import {
  ConnectionKindSchema,
  RunStatusSchema,
  TriggerModeSchema,
  type Concurrency,
  type ConnectionKind,
  type Edge,
  type Node,
  type Output,
  type Param,
  type RunStatus,
  type RunWindow,
  type TriggerMode,
  type WebhookConfig,
} from '@autonomy-studio/shared';

/**
 * The ONE example table for the P0a skeleton. It exists purely to prove the
 * migration runner + Drizzle + better-sqlite3 wiring works end to end.
 */
export const appMeta = sqliteTable('app_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

// The Drizzle `text(col, { enum: [...] })` value lists come straight from the
// Zod schemas in `@autonomy-studio/shared` (`.options` on a `z.enum(...)`) —
// ONE source of truth for the enum vocabulary. Previously this file
// duplicated the value lists as local `as const` arrays, which could silently
// drift from the Zod schemas; see the review that flagged it.
//
// `asEnumTuple` narrows `.options`'s `T[]` down to the non-empty-tuple shape
// Drizzle's `{ enum: [...] }` config wants (`readonly [string, ...string[]]`)
// — a type-level cast only; the values themselves still come from the Zod
// schema at runtime, so the enum vocabulary has exactly one source.
function asEnumTuple<T extends string>(options: readonly T[]): [T, ...T[]] {
  return options as [T, ...T[]];
}

/**
 * A named worker binding (`Connection` in `@autonomy-studio/shared`).
 * `secretRef` points at `secrets.ref`, never inlines a secret.
 */
export const connections = sqliteTable(
  'connections',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id'),
    name: text('name').notNull(),
    kind: text('kind', { enum: asEnumTuple(ConnectionKindSchema.options) })
      .notNull()
      .$type<ConnectionKind>(),
    config: text('config', { mode: 'json' }).notNull().$type<Record<string, unknown>>(),
    // Nullable (a connection need not use a secret), but when present it MUST
    // resolve to a real `secrets.ref` row — RESTRICT so a secret can't be
    // deleted out from under a connection still pointing at it. Forward
    // reference to `secrets` (defined further down this file) via the same
    // lazy-callback pattern `runs.parentRunId`'s self-reference uses below.
    secretRef: text('secret_ref').references((): AnySQLiteColumn => secrets.ref, {
      onDelete: 'restrict',
    }),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [index('connections_owner_id_idx').on(table.ownerId)],
);

/** A reusable pipeline template (`Pipeline`); the graph itself lives on
 * immutable `pipeline_versions` rows. */
export const pipelines = sqliteTable(
  'pipelines',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id'),
    name: text('name').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [index('pipelines_owner_id_idx').on(table.ownerId)],
);

/**
 * IMMUTABLE once written (`PipelineVersion`) — no update path exists in the
 * repository layer; a new version is always a new row. `(pipelineId,
 * version)` is unique so `version` behaves as a per-pipeline auto-increment.
 */
export const pipelineVersions = sqliteTable(
  'pipeline_versions',
  {
    id: text('id').primaryKey(),
    pipelineId: text('pipeline_id')
      .notNull()
      .references(() => pipelines.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    params: text('params', { mode: 'json' }).notNull().$type<Param[]>(),
    outputs: text('outputs', { mode: 'json' }).notNull().$type<Output[]>(),
    nodes: text('nodes', { mode: 'json' }).notNull().$type<Node[]>(),
    edges: text('edges', { mode: 'json' }).notNull().$type<Edge[]>(),
    catalogVersion: integer('catalog_version').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('pipeline_versions_pipeline_id_version_idx').on(table.pipelineId, table.version),
    index('pipeline_versions_pipeline_id_idx').on(table.pipelineId),
  ],
);

/**
 * First-class trigger (`Trigger`): binds ONE immutable pipeline version +
 * param values + firing mode + concurrency policy.
 */
export const triggers = sqliteTable(
  'triggers',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id'),
    name: text('name').notNull(),
    pipelineVersionId: text('pipeline_version_id')
      .notNull()
      .references(() => pipelineVersions.id, { onDelete: 'cascade' }),
    params: text('params', { mode: 'json' }).notNull().$type<Record<string, unknown>>(),
    mode: text('mode', { enum: asEnumTuple(TriggerModeSchema.options) })
      .notNull()
      .$type<TriggerMode>(),
    schedule: text('schedule'),
    webhook: text('webhook', { mode: 'json' }).$type<WebhookConfig | null>(),
    concurrency: text('concurrency', { mode: 'json' }).notNull().$type<Concurrency>(),
    runWindows: text('run_windows', { mode: 'json' }).$type<RunWindow[] | null>(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('triggers_pipeline_version_id_idx').on(table.pipelineVersionId),
    index('triggers_owner_id_idx').on(table.ownerId),
  ],
);

/** One execution of a specific, immutable pipeline version (`Run`). */
export const runs = sqliteTable(
  'runs',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id'),
    pipelineVersionId: text('pipeline_version_id')
      .notNull()
      .references(() => pipelineVersions.id, { onDelete: 'restrict' }),
    triggerId: text('trigger_id').references(() => triggers.id, { onDelete: 'set null' }),
    // Self-referencing FK (child run -> parent run): the callback form is
    // required here because `runs` is still being defined at this point —
    // `AnySQLiteColumn` breaks the otherwise-circular type reference.
    parentRunId: text('parent_run_id').references((): AnySQLiteColumn => runs.id, {
      onDelete: 'set null',
    }),
    params: text('params', { mode: 'json' }).notNull().$type<Record<string, unknown>>(),
    status: text('status', { enum: asEnumTuple(RunStatusSchema.options) })
      .notNull()
      .$type<RunStatus>(),
    leaseUntil: integer('lease_until'),
    heartbeatAt: integer('heartbeat_at'),
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at'),
  },
  (table) => [
    index('runs_pipeline_version_id_idx').on(table.pipelineVersionId),
    index('runs_trigger_id_idx').on(table.triggerId),
    // `status`: the boot-reconciler's "find all running rows" scan.
    // `owner_id`: per-owner run listing. `started_at`: time-ordered listing.
    index('runs_status_idx').on(table.status),
    index('runs_owner_id_idx').on(table.ownerId),
    index('runs_started_at_idx').on(table.startedAt),
    index('runs_parent_run_id_idx').on(table.parentRunId),
  ],
);

/**
 * Append-only event log per run (`RunEvent`) — the source of truth for run
 * state + the monitoring feed. `(runId, seq)` is unique; the repository
 * layer assigns a monotonic `seq` per run and never updates/deletes a row.
 */
export const runEvents = sqliteTable(
  'run_events',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    payload: text('payload', { mode: 'json' }).notNull().$type<unknown>(),
    ts: integer('ts').notNull(),
  },
  (table) => [
    uniqueIndex('run_events_run_id_seq_idx').on(table.runId, table.seq),
    index('run_events_run_id_idx').on(table.runId),
  ],
);

/**
 * An encrypted-at-rest secret blob (`Secret`). `ref` is the stable handle
 * `connections.secret_ref` points at; unique. `ciphertext` is opaque to this
 * layer — produced/consumed by `packages/server/src/secrets/secrets.ts`.
 */
export const secrets = sqliteTable(
  'secrets',
  {
    id: text('id').primaryKey(),
    ref: text('ref').notNull(),
    ciphertext: text('ciphertext').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [uniqueIndex('secrets_ref_idx').on(table.ref)],
);
