import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import {
  ConnectionKindSchema,
  ExternalWaitStatusSchema,
  RunStatusSchema,
  TriggerModeSchema,
  WakeupStatusSchema,
  WebhookDeliveryOutcomeSchema,
  type Concurrency,
  type ConnectionKind,
  type Container,
  type Edge,
  type ExternalWaitStatus,
  type Node,
  type Output,
  type Param,
  type EventConfig,
  type Recurrence,
  type RunDiagnosticPhase,
  type RunStatus,
  type RunWindow,
  type TriggerContext,
  type TriggerMode,
  type WakeupRef,
  type WakeupStatus,
  type WebhookConfig,
  type WebhookDeliveryOutcome,
  type WindowConfig,
  type WindowEventType,
  type WindowOrigin,
  type WindowStatus,
  WindowEventTypeSchema,
  WindowStatusSchema,
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
    // #2 L13b — the per-dispatch override allowlist (see the 0023 migration +
    // `ConnectionSchema.parameters`). NOT NULL with a DB-side DEFAULT '[]' so
    // pre-L13b rows read as "nothing overridable" (fail-closed) rather than
    // NULL; the app write path always supplies a value (`ConnectionSchema`'s
    // read default), so the DB default only ever serves the migration.
    // (`mode: 'json'` defaults take the JS value — Drizzle serializes it; a
    // string here would double-encode to '"[]"' and read back as a string.)
    parameters: text('parameters', { mode: 'json' }).notNull().default([]).$type<string[]>(),
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
    // #5 S6b — per-pipeline concurrency cap (max concurrent runs across ALL
    // the pipeline's triggers; both-must-pass admission). NULL = uncapped —
    // pre-S6b rows are genuinely uncapped, so the nullable ADD COLUMN backfill
    // is truthful, not manufactured (#473's lesson does not apply).
    concurrency: integer('concurrency'),
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
    // #473: absent until 0006 — every authored container was silently dropped
    // on insert. `.notNull()` with no drizzle-level default is deliberate: it
    // makes TypeScript refuse a raw insert that omits the key. (The column's
    // SQL DEFAULT exists only to backfill pre-0006 rows — see the migration.)
    containers: text('containers', { mode: 'json' }).notNull().$type<Container[]>(),
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
    // Nullable (see `TriggerSchema.pipelineVersionId` in
    // `@autonomy-studio/shared`): an "unbound" trigger — freshly imported, or
    // authored before its pipeline exists — transiently has no version bound.
    pipelineVersionId: text('pipeline_version_id').references(() => pipelineVersions.id, {
      onDelete: 'cascade',
    }),
    params: text('params', { mode: 'json' }).notNull().$type<Record<string, unknown>>(),
    mode: text('mode', { enum: asEnumTuple(TriggerModeSchema.options) })
      .notNull()
      .$type<TriggerMode>(),
    schedule: text('schedule'),
    // #5 S5b-1: the ADF recurrence object (`{frequency, interval, schedule?}`).
    // Nullable JSON (the `run_windows` precedent) — null for a raw-cron /
    // non-schedule trigger. `schedule` is the DERIVED cron cache of it.
    recurrence: text('recurrence', { mode: 'json' }).$type<Recurrence | null>(),
    webhook: text('webhook', { mode: 'json' }).$type<WebhookConfig | null>(),
    // #5 S8: the event-mode subscription (`{name}`). Nullable JSON (the
    // `recurrence`/`run_windows` precedent) — NULL is the honest value for
    // every non-event trigger and every pre-S8 row.
    event: text('event', { mode: 'json' }).$type<EventConfig | null>(),
    // #5 S9: the tumbling-window geometry (`{frequency, interval, startTime,
    // endTime?}`). Nullable JSON (the `recurrence`/`event` precedent) — NULL is
    // the honest value for every non-tumbling trigger and every pre-S9 row.
    // (`window` is a SQLite keyword since 3.25 but valid as a column name —
    // verified empirically; Drizzle quotes identifiers regardless.)
    window: text('window', { mode: 'json' }).$type<WindowConfig | null>(),
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
    // #5 S6a — the durable admission-queue FIFO key + the fire-time trigger
    // context a `queued` run carries until admission (both `null` for an
    // immediately-started run). See `RunSchema` for the full contract.
    queuedAt: integer('queued_at'),
    triggerContext: text('trigger_context', { mode: 'json' }).$type<TriggerContext>(),
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
 * #497 — the sink for the pure reducer's `diagnostics` (`RunDiagnostic`).
 *
 * Deliberately NOT part of `run_events`: that log holds FACTS, and a diagnostic
 * is a DERIVATION of (immutable doc + log). Keeping it off the log is what keeps
 * it out of `EngineEventSchema` (so it re-folds no already-bound log — the #443
 * question) and what stops a replay double-counting it. Nothing the engine gates
 * on reads this table; it is an explanation channel only.
 *
 * `(run_id, seq, phase, ordinal)` is UNIQUE and every write is INSERT OR IGNORE,
 * so re-deriving at the same log position is idempotent BY CONSTRUCTION. `phase`
 * is in the key because `resume()` derives at the same `seq` as the fold before
 * it; without it, two different derivations collide. Full account in the 0007
 * migration.
 */
export const runDiagnostics = sqliteTable(
  'run_diagnostics',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    phase: text('phase').notNull().$type<RunDiagnosticPhase>(),
    ordinal: integer('ordinal').notNull(),
    message: text('message').notNull(),
    ts: integer('ts').notNull(),
  },
  (table) => [
    uniqueIndex('run_diagnostics_run_id_seq_phase_ordinal_idx').on(
      table.runId,
      table.seq,
      table.phase,
      table.ordinal,
    ),
    index('run_diagnostics_run_id_idx').on(table.runId),
  ],
);

/**
 * An encrypted-at-rest secret blob (`Secret`). `ref` is the stable machine
 * handle `connections.secret_ref` points at; unique. `ciphertext` is opaque to
 * this layer — produced/consumed by `packages/server/src/secrets/secrets.ts`.
 *
 * `owner_id` + `name` (item 7 / S1) are nullable: a connection-owned secret
 * leaves both `NULL` (addressed only by `ref`); a standalone secret carries an
 * owner + a user-chosen `name`, UNIQUE per owner (case-insensitively — see
 * below) so `{ "$secret": "<name>" }` (S2) resolves deterministically. A UNIQUE
 * index over `(owner_id, name)` does NOT collide the many `(NULL, NULL)`
 * connection secrets — SQLite treats NULLs as distinct in a UNIQUE index.
 *
 * `name` collates `NOCASE` in the unique index (#533): `"stripe-key"` and
 * `"Stripe-Key"` are the SAME name per owner, so a case-variant is refused —
 * the S3 lookup (`repo/secrets.ts` `getSecretByName`) folds case to match.
 * `owner_id` stays BINARY (an opaque machine id, case-significant). The runtime
 * DDL SSOT is the hand-rolled SQL migration (`drizzle/migrations/0009_*`), not
 * this declaration — this `.on(...)` mirrors it so the two stay in step.
 */
export const secrets = sqliteTable(
  'secrets',
  {
    id: text('id').primaryKey(),
    ref: text('ref').notNull(),
    ciphertext: text('ciphertext').notNull(),
    ownerId: text('owner_id'),
    name: text('name'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('secrets_ref_idx').on(table.ref),
    uniqueIndex('secrets_owner_name_idx').on(table.ownerId, sql`${table.name} COLLATE NOCASE`),
  ],
);

/**
 * Durable webhook-delivery ledger (`WebhookDelivery`) — the source of truth for
 * replay protection + caller idempotency. `(trigger_id, idempotency_key)` is
 * UNIQUE: the launcher admits a given delivery at most once, even across a
 * restart (the row survives; an in-memory cache would not). `received_at` is
 * indexed for age-based pruning. See `packages/server/src/routes/webhooks.ts`.
 */
export const webhookDeliveries = sqliteTable(
  'webhook_deliveries',
  {
    id: text('id').primaryKey(),
    triggerId: text('trigger_id')
      .notNull()
      .references(() => triggers.id, { onDelete: 'cascade' }),
    idempotencyKey: text('idempotency_key').notNull(),
    outcome: text('outcome', {
      enum: asEnumTuple(WebhookDeliveryOutcomeSchema.options),
    })
      .notNull()
      .$type<WebhookDeliveryOutcome>(),
    // Bare column, no FK to `runs` on purpose: the ledger is provenance, never
    // joined for correctness, and a run may be deleted while its delivery record
    // is kept — a dangling `run_id` is harmless (see the 0004 migration note).
    runId: text('run_id'),
    receivedAt: integer('received_at').notNull(),
  },
  (table) => [
    uniqueIndex('webhook_deliveries_trigger_key_idx').on(table.triggerId, table.idempotencyKey),
    index('webhook_deliveries_received_at_idx').on(table.receivedAt),
  ],
);

/**
 * #5 S1 — the durable-alarm OUTBOX (`ScheduledWakeup`): the ONE time-based
 * firing primitive every feature consumes (retry, `wait`, webhook expiry,
 * schedule ticks, tumbling windows, lease expiry) instead of owning a
 * `setTimeout` that a restart silently loses.
 *
 * `(kind, dedupe_key)` is UNIQUE — it dedupes ARMING, so a reducer command
 * that re-emits on replay upserts the same row rather than arming a second
 * alarm. The event log remains the domain truth; this table is driver infra
 * (never part of a resource response), like `webhook_deliveries`.
 *
 * `kind` is an OPEN string (no enum): the handler registry in
 * `scheduler/alarms.ts` is the runtime authority, and pinning a durable field
 * to an enum is a back-compat trap. `status` IS closed. See the 0005 migration
 * for why the two differ, and for why `claimed_at` is absent (`superseded_by`,
 * deferred there under the same no-writer rule, gained its writer at S7 —
 * migration 0017).
 */
export const scheduledWakeups = sqliteTable(
  'scheduled_wakeups',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    /** Per-kind typed handle (`{runId, nodeId, attemptId}`, `{triggerId}`, …);
     * each handler declares a `refSchema`, checked when the alarm is armed. */
    ref: text('ref', { mode: 'json' }).notNull().$type<WakeupRef>(),
    /** Epoch ms; a STORED fact (backoff is never recomputed at fold time). */
    dueAt: integer('due_at').notNull(),
    /** ALWAYS derived via `buildDedupeKey(kind, ref, discriminator)`. */
    dedupeKey: text('dedupe_key').notNull(),
    status: text('status', { enum: asEnumTuple(WakeupStatusSchema.options) })
      .notNull()
      .$type<WakeupStatus>(),
    firedAt: integer('fired_at'),
    /** #5 S7 (#465) — the replacement row's id when a `supersede` cancelled
     * this alarm. Provenance only: bare column, no self-FK, never joined. */
    supersededBy: text('superseded_by'),
  },
  (table) => [
    uniqueIndex('scheduled_wakeups_kind_dedupe_key_idx').on(table.kind, table.dedupeKey),
    // The claim scan ("pending rows due by now") — the only hot query.
    index('scheduled_wakeups_status_due_at_idx').on(table.status, table.dueAt),
    // #464 — the RETENTION sweep ("settled rows older than the floor, oldest
    // first"). A PARTIAL index on `fired_at` over SETTLED rows only: the sweep's
    // `WHERE status <> 'pending' AND fired_at < ? ORDER BY fired_at` becomes an
    // index range scan instead of a full sort of the settled set, which matters
    // on the exact high-volume instance this ticket targets (and keeps the
    // first-boot backlog drain fast). Pending rows are excluded from the index,
    // so it never competes with the claim scan above.
    index('scheduled_wakeups_retention_idx')
      .on(table.firedAt)
      .where(sql`${table.status} <> 'pending'`),
  ],
);

/**
 * #4 A13 — the `webhook` external-wait CORRELATION store. When a `webhook` node
 * parks (`external_wait_pending`), one row here links its parked
 * `(run_id, node_id, attempt_id)` to the SHA-256 hash of its capability token, so
 * an inbound `POST /api/external-wait/:token` route can authenticate a callback
 * (by token → hash → this row) and correlate it to the exact parked attempt.
 *
 * `token_hash` is UNIQUE and indexed — the inbound lookup's only query. The RAW
 * token is NEVER stored (only its hash): the row is read by an unauthenticated
 * inbound route, and the token is re-DERIVED on demand (`HMAC(masterKey, ...)`,
 * `webhooks/external-wait-token.ts`), never persisted in plaintext.
 *
 * UNIQUE (run_id, node_id, attempt_id) is load-bearing for crash recovery: a
 * driver re-arm on resume upserts the SAME row (ON CONFLICT DO NOTHING) rather
 * than minting a second token, mirroring `scheduled_wakeups`' `(kind, dedupe_key)`
 * dedupe. `status` settles `pending` → `completed`/`expired` exactly once (every
 * transition is `WHERE status = 'pending'`), so a completed row is never
 * downgraded by a late timeout alarm. `expires_at` mirrors the expiry alarm's
 * `due_at` (the audit fact for "when does this wait end"). Like `webhook_deliveries`
 * / `scheduled_wakeups`, this is driver INFRA — never part of a resource response.
 */
export const externalWaits = sqliteTable(
  'external_waits',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    nodeId: text('node_id').notNull(),
    attemptId: text('attempt_id').notNull(),
    /** SHA-256 hex of the capability token — the inbound lookup handle. */
    tokenHash: text('token_hash').notNull(),
    status: text('status', { enum: asEnumTuple(ExternalWaitStatusSchema.options) })
      .notNull()
      .$type<ExternalWaitStatus>(),
    createdAt: integer('created_at').notNull(),
    /** Epoch ms; mirrors the expiry alarm's `due_at`. */
    expiresAt: integer('expires_at').notNull(),
    /** Epoch ms the row settled (`completed`/`expired`); null while `pending`. */
    resolvedAt: integer('resolved_at'),
  },
  (table) => [
    uniqueIndex('external_waits_token_hash_idx').on(table.tokenHash),
    uniqueIndex('external_waits_run_node_attempt_idx').on(
      table.runId,
      table.nodeId,
      table.attemptId,
    ),
  ],
);

/**
 * #2 L14c — the per-connection quota RESET-WINDOW store (the PROACTIVE half of
 * the CLI/subscription quota primitive; the reactive half — pattern-match a
 * subprocess's exhaustion output into a `rate_limit` failure — shipped in the
 * first L14c slice on `connectors/agent.ts`).
 *
 * A subscription CLI (`agent_cli`) has a usage quota that resets on a rolling
 * window. When ONE dispatch discovers exhaustion (a `node.failed{code:'rate_limit',
 * retryAfterSeconds}`), the driver records the reset epoch HERE, keyed by the
 * `connectionId` it dispatched with. Every SUBSEQUENT dispatch of that shared
 * connection — in ANY run — then reads this row at pre-flight and short-circuits
 * to the same `rate_limit` retry WITHOUT spawning a doomed subprocess (the
 * admission gate), instead of each run independently burning a subprocess to
 * rediscover the shared quota is spent.
 *
 * ONE row per connection (`connection_id` PRIMARY KEY, upserted MAX-of-window).
 * Driver INFRA, never part of a resource response — no Zod resource counterpart,
 * so `schema-table-parity.test.ts` exempts it like `scheduled_wakeups`.
 *
 * The reset epoch is a STORED FACT, anchored to the failure event's durable `ts`
 * (never recomputed at read time), so the driver is the SOLE WRITER and the
 * adapter only EXTRACTS the window — the studio analog of the engine's
 * reset-epoch-split invariant (`bin/agents/*.sh` extract, `supervisor.sh`
 * persists `.last_usage_reset`). The whole layer is a best-effort OPTIMISATION
 * over the already-correct reactive path: an absent row means "not known
 * exhausted", so a missed write only degrades to the reactive behaviour, never
 * to incorrectness (fail-safe, never fail-open). FK CASCADE: a window is
 * meaningless once its connection is gone.
 */
export const connectionQuotaState = sqliteTable('connection_quota_state', {
  connectionId: text('connection_id')
    .primaryKey()
    .references(() => connections.id, { onDelete: 'cascade' }),
  /** Epoch ms the exhausted quota window resets; the admission gate refuses
   * dispatch while `reset_epoch_ms > now`. A STORED fact (never recomputed). */
  resetEpochMs: integer('reset_epoch_ms').notNull(),
  /** Epoch ms of the LAST write to this row (the writing failure event's `ts`) —
   * AUDIT ONLY, read nowhere today. Note it advances on every write, so on a
   * MAX-upsert that KEEPS an earlier window it stamps the newest write, not the
   * window-setting event; it is "last write", not "when the kept window was set". */
  updatedAtMs: integer('updated_at_ms').notNull(),
});

/**
 * #5 S9 — the tumbling-window DOMAIN EVENT LOG (the TRUTH for window
 * lifecycle; the spec's codex-hardened block: "Tumbling state = projection,
 * not truth"). A window exists BEFORE any run materializes for it, so its
 * lifecycle cannot live in a run's per-run event log — this table is the
 * window-scoped append log. The codex-hardened window key `(triggerId,
 * configEpoch, windowStart)` rides the row as columns (`config_epoch` is the
 * server-computed hash of the geometry tuple `(frequency, interval,
 * startTime)` — `scheduler/tumbling.ts`); `seq` (rowid alias) is the global
 * append order rebuilds fold in. Append-only: never updated, never deleted
 * (except by trigger-delete CASCADE, symmetric with the projection below so a
 * rebuild can never resurrect rows for a gone trigger).
 *
 * Driver-adjacent DOMAIN data with no top-level Zod resource counterpart
 * (`WindowEventSchema` types the `{type, payload}` half), so
 * `schema-table-parity.test.ts` exempts it like `scheduled_wakeups`.
 */
export const windowEvents = sqliteTable(
  'window_events',
  {
    /** Global append order (rowid alias) — the fold order for rebuilds. */
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    triggerId: text('trigger_id')
      .notNull()
      .references(() => triggers.id, { onDelete: 'cascade' }),
    configEpoch: text('config_epoch').notNull(),
    /** UTC ISO of the window's inclusive start — the key's occurrence part. */
    windowStart: text('window_start').notNull(),
    type: text('type', { enum: asEnumTuple(WindowEventTypeSchema.options) })
      .notNull()
      .$type<WindowEventType>(),
    payload: text('payload', { mode: 'json' }).notNull().$type<Record<string, unknown>>(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    // SINGLE-FIRE at the event level: `window.created` exactly once per window
    // key — the hard backstop beneath the projection's UNIQUE primary key.
    uniqueIndex('window_events_created_once_idx')
      .on(table.triggerId, table.configEpoch, table.windowStart)
      .where(sql`${table.type} = 'window.created'`),
    // Fold/rebuild scan: one window's events in append order.
    index('window_events_window_idx').on(table.triggerId, table.configEpoch, table.windowStart),
  ],
);

/**
 * #5 S9 — the tumbling-window state PROJECTION: materialized from
 * `window_events` (same-transaction with each append), rebuildable by folding
 * a window's events in `seq` order (`foldWindowStatus` in shared is the pure
 * status fold; the rebuild test pins projection == fold). UNIQUE on the window
 * key via the composite PRIMARY KEY — the spec's "materialized projection with
 * uniqueness". `run_id` is BARE (no FK) like `webhook_deliveries.run_id`: the
 * link is provenance, not integrity. Blocked/backfill windows live HERE, not
 * as run rows (spec: "Blocked/backfill windows live in window state, NOT as
 * full runs") — a run row materializes only when the window fires through the
 * launcher. Driver infra for parity purposes (exempt in
 * `schema-table-parity.test.ts`).
 */
export const tumblingWindowState = sqliteTable(
  'tumbling_window_state',
  {
    triggerId: text('trigger_id')
      .notNull()
      .references(() => triggers.id, { onDelete: 'cascade' }),
    configEpoch: text('config_epoch').notNull(),
    /** UTC ISO, inclusive start of `[windowStart, windowEnd)`. */
    windowStart: text('window_start').notNull(),
    /** UTC ISO, exclusive end — also the window's `dueAt` instant. */
    windowEnd: text('window_end').notNull(),
    status: text('status', { enum: asEnumTuple(WindowStatusSchema.options) })
      .notNull()
      .$type<WindowStatus>(),
    runId: text('run_id'),
    /**
     * #5 S10 — HOW the window became known: `'live'` = the forward
     * `window_due` chain (S9), `'backfill'` = the bounded backfill pass.
     * Drives the materialization gate (backfill fires one-at-a-time; live
     * keeps S9's ungated behavior). DEFAULT 'live' is the honest value for
     * every pre-S10 row — all were created by the live chain.
     */
    origin: text('origin', { enum: ['live', 'backfill'] })
      .notNull()
      .default('live')
      .$type<WindowOrigin>(),
    /**
     * #5 S11c — retries CONSUMED by this window (0 = the initial attempt has
     * never been re-driven; honest for every pre-S11c row). Monotonic via the
     * guarded `running → retry_pending` flip; the settle-time budget check
     * (`attempt < retry.count`) reads it. Re-derivable from the event log as
     * the count of `window.retryScheduled` events (pinned by test).
     */
    attempt: integer('attempt').notNull().default(0),
    /**
     * #5 S11c — the STORED due instant (epoch ms) of a pending retry; NULL
     * outside `retry_pending`. Mirrors the `window_retry` alarm's `dueAt`
     * (never recomputed); the sync/reconcile OVERDUE HEAL reads it to re-drive
     * a retry whose alarm was suppressed while the trigger was broken.
     */
    nextAttemptAtMs: integer('next_attempt_at_ms'),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.triggerId, table.configEpoch, table.windowStart] }),
    // Completion tap: resolve a terminalized run back to its window.
    index('tumbling_window_state_run_id_idx').on(table.runId),
    // Reconcile/stranded scans: non-terminal windows.
    index('tumbling_window_state_status_idx').on(table.status),
  ],
);

/**
 * #5 S10 — the durable BACKFILL CURSOR, one row per (trigger, config epoch).
 * `cursor_ms` is the EXCLUSIVE disposition boundary: every window of the
 * epoch with `windowStart < cursor_ms` is dispositioned (created, or
 * deliberately skipped past the `maxBackfillWindows` lookback) and must never
 * be re-created or re-armed. This cursor + the projection PK — NOT wakeup-key
 * absence — carry the no-double-fire guarantee for past windows (backfill
 * never arms `scheduled_wakeups` rows at all; see the re-verified retention
 * note in `repo/scheduled-wakeups.ts`). Monotonic via the repo write path.
 * Old-epoch rows are debris after a geometry edit (never read again),
 * reclaimed by the trigger's delete CASCADE. Driver infra for parity purposes
 * (exempt in `schema-table-parity.test.ts`).
 */
export const tumblingBackfillCursors = sqliteTable(
  'tumbling_backfill_cursors',
  {
    triggerId: text('trigger_id')
      .notNull()
      .references(() => triggers.id, { onDelete: 'cascade' }),
    configEpoch: text('config_epoch').notNull(),
    cursorMs: integer('cursor_ms').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.triggerId, table.configEpoch] })],
);
