# Foundation Spec #9 — Data movement: linked services, datasets, and `copy`

**Status:** proposed — written 2026-08-14 against the tree at `a29a70a3`, for #996.
**Scope:** ADF-grade data movement — **heterogeneous** source and sink (CSV/Excel → database,
database → CSV, any-to-any) with declared column **mapping**, type coercion and a schema-drift
policy. Settles the three layers (**linked services → datasets → `copy`**) and every existing seam
each one widens.
**Non-goal:** re-deriving the ActivityDefinition contract (#1 D6), the secret model (#7), or the
expression language (#6). This spec says WHAT the data layer is and WHICH seams it extends; those
specs still own their mechanisms.

**This spec RETRACTS a non-goal.** `2026-07-14-foundation-activity-library.md` carried
_"No dataset/linked-service data-movement abstraction (defer `copy`/`lookup`/`transform`)"_.
Operator decision #993 (2026-08-07) reversed it: _"the source and sink types could be different, we
might want to move a csv or excel file into a database, or viceversa."_ That line is struck in the
same PR as this spec, citing #993, **together with the two other places the old position is still
written** (see §11) — leaving any of them in place while building the opposite is the contradiction
class the loop already has a rule against.

---

## The finding that reshapes the phase

**#996 frames this as three missing layers. One of the three already exists, one is far more
expensive than the ticket assumes, and the real blocker is in neither of them.**

1. **Linked services are BUILT.** `Connection` is documented, in its own docblock, as _"a named
   worker binding (ADF 'Linked Service' analog)"_ — `shared/src/schemas/connection.ts:3`. It already
   carries `resourceId` (git identity), non-secret `config`, `secretRef`, `secretStatus`, `enabled`,
   and a per-dispatch override allowlist (`parameters`, #2 L13b). **Layer 1 is not a layer to build;
   it is new `ConnectionKind`s on a seam already load-bearing for six kinds.**
2. **Datasets are new, and cost ~42 production edit sites** (§2.3) — not because they are versioned
   (they are not, §2) but because _every_ resource kind pays the portability enumeration.
3. **The real blocker is the adapter seam itself, and #996 does not mention it.** §1.

---

## §1 — the blocker: one node binds ONE connection **[SETTLED — the contract widens]**

A `copy` is _heterogeneous by definition_: it reads from one store and writes to another, usually of
different kinds. **The current dispatch path cannot express that.**

```ts
// shared/src/schemas/pipeline.ts:377
connectionId: z.string().min(1).optional(),          // ONE, singular

// server/src/connectors/types.ts:61,241
connectionConfig: Record<string, unknown>;           // ONE bound Connection's config
runActivity(ctx, secret: string | null, secretFields?): AsyncIterable<ActivityEvent>;
```

The registry is keyed by connection **kind** (`connectors/registry.ts:12`); one adapter serves many
activity types via `ctx.activityType` (`types.ts:52` — how `fs` backs all six file activities); the
executor resolves exactly one connection and one secret (`run/executor.ts:327,477`). There is no
second slot anywhere on the path.

So every "just add a `copy` activity" plan is wrong before it starts.

|     | Shape                                                                                                                                                   | Verdict           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| (a) | **Widen the contract to a source/sink PAIR** — the node binds two connections, the executor resolves both, the adapter receives both                    | **CHOSEN**        |
| (b) | One `data_movement` kind whose adapter internally owns every store client; stores named inside the copy config, credentials via `{$secret}` sink fields | Rejected          |
| (c) | Split into `read` + `write` activities joined by an output                                                                                              | Rejected outright |

**(c) fails on correctness, not taste:** the only channel between two nodes is an output, and outputs
land in `run_events` (`run/events.ts:49`). Piping a million rows through the append log is the defect
§5 exists to prevent, and nothing bounds it today (§5).

**(b) re-implements the connection model inside one adapter.** Store credentials would stop being
`Connection.secretRef` rows with a `secretStatus` readiness gate and become config-sink markers — so
a store credential would not appear in Manage › Connections, would not participate in `enabled`, and
could not be shared across pipelines the way every other credential is. It trades a bounded widening
for a permanent divergence.

**(a) is what ADF does** (a copy names two datasets, each on its own linked service) and is the only
option under which a store connection is an ordinary `Connection`. The widening is **additive and
optional at every point**:

- `NodeSchema` gains `connectionIds?: { source, sink }` **beside** `connectionId`, which remains the
  binding for every existing single-connection activity. No stored node changes shape — and
  `pipeline_versions` are immutable (`0002_p1a_data_model.sql:68-84`), so a re-interpretation of
  stored docs would be unfixable. Additive is not a preference here.
- `ActivityContext` gains an optional `sink?: { connectionConfig }`; `runActivity` an optional fourth
  `sinkSecret`. Six existing adapters ignore both.
- **`ActivityCatalogEntry` gains `sinkConnectionKinds?`** — the sink end's kind allowlist, and the
  declaration that makes an activity PAIRED. The executor must be TOLD, not left to infer it from
  the node: a node's shape is operator input, and inferring the contract from it would let a stray
  `connectionIds` change how an activity dispatches. Absent ⇒ single-connection, and `connectionIds`
  is inert everywhere but the save-time validator. A declared list must be non-empty (absence
  already carries "no sink", so `[]` would have to mean "paired, but no sink kind is ever valid").
  This is a new declared `ActivityDefinition` field, so it is #1 D6 territory — see §10.
- `resolveConnection` (`executor.ts:327`) is called twice for a paired activity, and its structured
  codes (`SECRET_NOT_FOUND` / `SECRET_UNDECRYPTABLE`) gain a **side label**. A failure that cannot say
  which end failed is a support problem, not a detail. **As built (M1):** the label is a `side` FIELD
  on `node.failed` beside `code`, not a SINK_ variant of all ten codes — the side is orthogonal to
  the cause, and `resolveConnection`'s own docblock forbids making an operator string-match the
  message. The message names the side too, so the run log is honest before a UI ticket renders it.
- **`ActivityContext.sink` carries the sink's `kind`**, not only its config: the SOURCE adapter is
  the one running, and no adapter's `configSchema` validates the other end — which is exactly why
  §8 requires a file-backed sink to re-validate at dispatch. That is impossible without the kind.
- `connection-readiness` gates BOTH ends: a copy whose sink lacks its secret must not dispatch.

**M1 is the prerequisite for the whole series.** It is a framework change (#1's D6 contract), specced
here because this is what needs it, and flagged in §10 as jointly owned.

---

## §2 — the dataset: a MUTABLE first-class resource **[SETTLED]**

**#996 states:** _"a new resource that does not participate in the version model would break the
run-binding invariant."_ **Probed: that is false.**

Only pipelines are versioned; connections and triggers are mutable rows (`repo/connections.ts:155`),
and the immutability triggers exist for `pipeline_versions` alone. Run binding is preserved by
`runs.pipelineVersionId` being NOT NULL / `onDelete: restrict` (`db/schema.ts:271`) — a run pins one
immutable pipeline version forever. Connections prove the point: freely mutable, and run binding does
not break.

**The rationale is the binding model, not environments.** An earlier draft of this section argued
from "you want to re-point dev→prod"; that is wrong to cite, because environment promotion is an
explicit non-goal (`2026-07-14-foundation-git-publish.md:900`). The correct argument is narrower and
stronger: **a `Connection`'s `config` is a mutable row read live at dispatch, and a dataset address
is the same class of fact.** A mutable dataset is _consistent with_ the existing binding model rather
than an exception to it. The verdict is unchanged; the reason is.

A dataset is honestly **both** address and contract, so it is split by role:

| Role                                                        | Lives in                                                             | Mutability | Why                                                               |
| ----------------------------------------------------------- | -------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------- |
| **Address** — which store, which table/path, format options | the **dataset row**                                                  | mutable    | same class of fact as a connection's `config`                     |
| **Contract** — the column mapping                           | the **`copy` node's config**, inside the immutable `PipelineVersion` | immutable  | a run must execute the mapping it was authored with               |
| **Declared schema** — the dataset's own column list         | the dataset row                                                      | mutable    | an **authoring aid** + a **drift check** (§7) — never a run input |

### 2.1 What this design owes, stated rather than hidden

**"The node config is complete" is NOT the reason this is safe** — the node holds a _ref_, so the
effective address resolves live. Two real consequences, both of which need a compensating control:

1. **A rerun writes wherever the dataset points today**, even though it pins the same
   `pipelineVersionId` (`foundation-rerun-from-failed.md:87`). **Control:** the resolved address is
   recorded on dispatch, so the run log says where it actually wrote — not merely which dataset it
   named. Without this, a run's own log cannot answer "where did this data go", which is the first
   question anyone asks.
2. **Editing a dataset can invalidate a pinned mapping.** **Control:** the dispatch-time drift gate
   (§7), which fails `permanent` with the offending columns named, plus **M9**, the dataset detail
   page listing the pipelines whose mappings reference it and flagging those that no longer agree.
   A dataset cannot cheaply know its consumers at save time, so this is a read-side affordance, not
   a write-side gate.

### 2.2 Schema delta

`shared/src/schemas/dataset.ts` (new), modelled field-for-field on `connection.ts:65`:

```ts
DatasetSchema = z.object({
  id,
  resourceId,
  ownerId, // identical G1 identity contract to Connection
  name: z.string().min(1),
  connectionId: z.string().min(1), // the STORE this dataset lives in
  kind: DatasetKindSchema, // 'delimited' | 'excel' | 'table' | 'query'
  config: z.record(z.string(), z.unknown()), // kind-specific, non-secret
  columns: z.array(DatasetColumnSchema), // the DECLARED schema
  parameters: z.array(z.string().min(1)).default([]), // §8 — L13b's allowlist, reused verbatim
  createdAt,
  updatedAt,
});
```

`columns` is **REQUIRED with no `.default([])`.** An absent column list must fail loudly at the read
boundary, never be manufactured as an empty schema — #473's lesson, and the same fail-closed shape
`connection.ts` already applies to `secretStatus`. An empty declared schema would otherwise read as
"this table has no columns", and auto-map (§6.3) would silently produce an empty mapping.

**Dataset parameters reuse `Connection.parameters` verbatim** (`connection.ts:78-98`): the owner
declares which `config` keys a node may override per dispatch via `${}`, and the merge **refuses any
resolved value that is `{$secret:…}`-shaped**. ADF datasets are parameterised; studio's mechanism for
exactly this already exists and is already secret-refusing, so datasets adopt it rather than growing
a second one.

### 2.3 The real cost — 42 sites, and 5 of them fail SILENTLY

An earlier draft claimed "~10 touch points". **That was wrong.** Connections participate fully in git
serialization, export, import, reconcile, apply and drift; a mutable dataset pays nearly the whole
portability enumeration. Measured: **42 production edit sites, 6 new files, ~12 test files.** What
being un-versioned actually saves is the version table, the immutability triggers, the publish/CAS
surface and the run-binding column — not the enumeration.

**TypeScript catches 6** (`paths.ts:38`, `workspace-parse.ts:204`, `:247`, `import.ts:224`,
`ImportPanel.tsx:38`, `web/api/portability.ts:167`).

**It does NOT catch these 5**, because they are array/loop enumerations with no exhaustiveness check:

| Site                             | What a forgotten kind does                              |
| -------------------------------- | ------------------------------------------------------- |
| `workspace-serialize.ts:626,637` | the kind **never gets committed** to git                |
| `workspace-drift.ts:161-173`     | the kind reports **permanently clean**                  |
| `workspace-reconcile.ts:307-344` | the kind never appears in an import **preview**         |
| `workspace-apply.ts:488,777`     | the kind is silently **never applied**                  |
| `envelope.ts:267`                | pre-existing exports **lose the `resourceId` backfill** |

`portability/paths.ts:22-27` already notes the serializer "spells its three loops out rather than
iterating this list".

**M2 therefore lands the exhaustiveness pin BEFORE it adds `dataset`** — a
`satisfies Record<ResourceKind, …>` (or a `RESOURCE_KINDS`-driven loop) at those five sites, so the
compiler catches the fourth kind and every kind after it. Adding `dataset` first and pinning later
gets the ordering exactly backwards: the pin's whole value is being in place when a kind is added.

### 2.4 What a dataset deliberately does NOT get

- **No `active` pointer and no Publish.** Publish is a CAS over an event projection and refuses
  outright with no git repo connected (`routes/pipelines.ts:274,289-294`). Datasets are mutable, so
  there is nothing to promote; an edit takes effect on the next dispatch, like a connection edit.
- **No trigger binding.** Triggers bind pipeline versions (`triggers.pipelineVersionId`, `db/schema.ts:228`).
- **No audit event.** No resource kind emits a create/update event today — there is no `connection.*`
  or `trigger.*` member of `WorkspaceEventSchema` at all. Datasets must not be the exception; if
  resource auditing is wanted it is one ticket across all four kinds.

### 2.5 Where format lives: on the DATASET **[SETTLED]**

#996 asks this directly — _"is 'CSV vs Excel' a property of the dataset, the linked service, or the
copy? ADF puts it on the dataset. Say which, and why."_ It is the dataset, and the reasoning holds
independently of ADF:

- **Not the linked service.** One folder holds CSV and Excel side by side, so format-on-connection
  forces a separate connection per format — and the connection is the object carrying the credential
  and the `config.roots` confinement. Splitting it by format multiplies the security-relevant object
  for a purely presentational distinction.
- **Not the copy.** The mapping surface needs the source's columns to auto-map against (§6.3). If
  format lived on the copy, a dataset could not describe its own columns, so every copy would
  re-declare them — and two copies over one file could disagree about what that file is.
- **The dataset**, because a dataset is precisely _"a thing in a store, in a shape"_. `kind` selects
  the reader; `config` carries that kind's options.

### 2.6 What each kind's `config` carries

`DatasetSchema.config` and a store connection's `config` are both `z.record` at the schema level, so
the concrete shape has to be written down or it will be invented per ticket. Each lands in the
existing per-kind SSOT — `CONNECTION_CONFIG_SCHEMAS` (`catalog/connection-config.ts:341`, exhaustive
over the enum, so a missing entry is a compile error) for connections, and the dataset equivalent for
dataset kinds.

**Store connections (new `ConnectionKind`s):**

| Kind       | Non-secret `config`                                                                                                                                                  | Secret                                                                     |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `sqlite`   | `roots` + `path` (**confined by the same `roots` allowlist model as `fs`** — a SQLite file is a file, and an unconfined path is the same traversal risk), `writable` | none                                                                       |
| `postgres` | `host`, `port`, `database`, `user`, `sslmode`, `connectTimeoutMs`, `statementTimeoutMs`                                                                              | `secretRef` → password. **Joins `SECRET_REQUIRING_CONNECTION_KINDS`** (§8) |

**Dataset kinds:**

| Kind        | `config`                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| `delimited` | `path`, `delimiter` (default `,`), `quote`, `escape`, `header` (bool), `encoding`, `nullValue`, `dateFormat` |
| `excel`     | `path`, `sheet` (name or index), `headerRow`, `nullValue`, `dateFormat`                                      |
| `table`     | `schema`, `table` — **identifiers, so save-time literal-only (§8)**                                          |
| `query`     | `sql` (literal; `${}` values bind as parameters, never concatenated — §8), `parameters`                      |

**Two corrections from M4, which built this row** (#1119):

- **`roots` is named explicitly**, because the parenthetical already required it and a terse key
  list read as though it did not. `Connection.parameters` lets a node override a config key per
  dispatch, so `path` is reachable from a pipeline and must be confined against something. M4 also
  closed the hole that made that confinement conditional: `roots` and `path` joined
  `CONNECTION_NON_OVERRIDABLE_CONFIG_KEYS`, so no allowlist can bless an override of either — a
  fix that lands for `fs` at the same time, where the hole was pre-existing.
- **`readonly` became `writable`.** The polarity was wrong in both directions at once. The authoring
  form omits an unchecked optional boolean, so a `readonly` key that defaults true renders an
  UNCHECKED "readonly" box on a connection that genuinely is read-only — the form states the
  opposite of the fact. And absent-means-writable is fail-OPEN. With `writable`, absent renders
  truthfully AND withholds a permission. It governs SINK use only (M5); the M4 reader opens
  read-only unconditionally, because a source scan has no reason to hold a write lock.

`nullValue` and `dateFormat` sit on the file kinds and not the SQL kinds deliberately: a database
column already has a type and a real `NULL`, so there is nothing to declare. They exist only where
the format genuinely cannot express the distinction (§6.2, §6.4).

---

## §3 — a dataset REF is a first-class node field, never config **[SETTLED]**

This is the finding that would have broken git most quietly.

**Every cross-resource reference in this codebase is a dedicated `NodeSchema` field, remapped by
name at four sites** — `export.ts:40-56`, `workspace-serialize.ts:219-225,444-451`,
`workspace-apply.ts:191-206` (with a hard refusal for an unresolvable ref), and the undecidable-ref
masking at `workspace-serialize.ts:321,366`. **`Node.config` is `z.record(z.string(), z.unknown())`
(`pipeline.ts:376`) — an opaque blob nothing remaps.**

So a `copy` node holding `config.sourceDatasetId` would round-trip a **local DB id** through
git/export/import: it would commit one workspace's primary key into a repo and resolve to nothing, or
worse to something else, on import. Nothing would throw.

**Settled:** `NodeSchema` gains `datasetIds?: { source, sink }` as first-class fields, and the remap
is added at all four sites alongside `connectionId`'s.

**And they follow `connectionId`'s L13a rule exactly.** The null-vs-preserve mechanism itself lives in
`export.ts:39-57` specifically — the other three sites remap rather than null (`workspace-serialize.ts`
maps with a fallback; `:444-451` throws on an unresolved literal), so that is the file to read and
copy. It branches on `interpolationMode`:

- a **literal** dataset id is **nulled on export** — a concrete id is environment-specific and
  meaningless elsewhere;
- a **`${}`** dataset id is **portable and preserved** — it names an expression, not an environment,
  which is what makes dynamic routing survive a round-trip.

Dynamic dataset routing therefore works exactly as dynamic connection routing already does. This is
not a new capability; it is refusing to make datasets the one ref that behaves differently.

### 3.1 Where the ref is CHECKED — dispatch, with one optional save-time arm

`ActivityCatalogEntry` has **no declarative slot** for "this field is a reference to resource X"
(`catalog/types.ts:250-298`). The two precedents are both refs held _beside_ `config`, and they check
at different times for a stated reason:

- **`connectionId` checks at DISPATCH, not save** — and `pipeline.ts:384-387` gives the argument
  verbatim: _"connections are mutable rows (a save-time check would go stale) and `connectionId` may
  itself be a `${}` ref, so the target connection is unknowable here."_ Save-time validation only
  checks that the `${}` refs _inside_ it resolve (`params.ts:1324`).
- **`call.pipelineVersionId` checks at SAVE**, through an **injected resolver** —
  `ValidateDocOptions.resolvePipeline` (`params.ts:1897`), supplied owner-scoped and server-side at
  `repo/pipeline-versions.ts:160`, while the canvas badge deliberately passes none (it has no DB, and
  enforcing a rule the canvas never checked would newly 400 a doc that badges clean —
  `params.ts:1869-1874`).

**Settled: a dataset ref follows `connectionId`.** Datasets are mutable rows (§2) and the ref may be
`${}`, so both halves of the connection argument apply unchanged — the existence, ownership and
kind-compatibility checks live at dispatch, where the drift gate (§7) already runs. The
`resolvePipeline` pattern is the right tool for an _immutable_ target and the wrong one here; naming
it explicitly is what stops a later ticket reaching for it by analogy.

An activity's acceptable dataset kinds are declared the way `connectionKinds` already declares
acceptable connection kinds (`catalog/types.ts:278`), and enforced the same way: **the executor fails
the node loudly**, with the node panel filtering the picker to accepted kinds _plus whatever is
currently bound_, so a node bound to an off-kind dataset still shows its real binding
(`PipelineCanvas.tsx:2341-2345`'s rule).

---

## §4 — partial copies, retry, and why `idempotent` is not the answer **[SETTLED]**

**The trap, measured:** `retryEligible` reads **only** `kind === 'transient'` and `policy.retry`
(`shared/src/engine/reduce.ts:3159-3168`). **It never consults `idempotent`.** That flag governs boot
recovery alone — non-idempotent → the node freezes `interrupted`
(`docs/2026-07-13-p2-engine-spec.md:180-184`).

So "declare `copy` non-idempotent" does **not** prevent a retry. A copy that dies at row 500 000 on a
network blip would be classified `transient`, retried from row 0, and **duplicate 500 000 rows into
an append sink**. #996 explicitly demands partial-copy behaviour; this is it.

**Settled — a copy is atomic at the sink, or it is not retryable:**

1. **Prefer staging + atomic swap.** Where the sink supports it, a copy writes to a staging target
   and swaps on success. Both v1 sink families do:
   - **file sinks** — a sibling temp file inside the canonical parent, atomically `rename`d over the
     target. This is not a new idea: `file_write` is already crash-safe this way
     (`connectors/fs.ts:63-64`), with a per-dispatch temp suffix unique per `(run, node, attempt)`
     so two runs cannot collide (`fs.ts:300-304`).
   - **SQL sinks** — one transaction, committed once, or a staging table swapped in.
     A copy whose sink swapped atomically **never leaves a partial write**, so a `transient` failure is
     safely retryable and is classified as such.
2. **Otherwise the failure is `permanent`, whatever its cause.** If a copy cannot guarantee
   atomicity — an `append` write mode, a sink whose driver cannot transact the whole batch — then a
   failure after the first batch is committed is reported `permanent` **even for a network blip**,
   because the engine's only retry is from row 0 and that is a duplicating retry. Losing an automatic
   retry is the correct trade against silently doubling a table.
3. **`idempotent: false` is still declared**, for the boot-recovery path it actually governs — an
   interrupted copy must not be silently resumed. It is declared _in addition to_ the above, never
   instead of it.

**Resumable copies are a non-goal in v1** (§12): a watermark that survives a run needs durable
run-scoped state that the engine does not have.

**Failure classification, in adapter terms.** Adapters emit the 5-valued `ConnectorErrorKind`
(`connectors/types.ts:37`), narrowed to the engine's 3 by `toEngineFailure`
(`connectors/error-kind.ts:28`). A copy must map to the adapter vocabulary, not invent a parallel one:

| Cause                                                                             | `ConnectorErrorKind` | Engine `kind`                   |
| --------------------------------------------------------------------------------- | -------------------- | ------------------------------- |
| bad DB credentials, permission denied                                             | `auth`               | `permanent`                     |
| connect timeout, deadlock, connection reset — **and the sink swapped atomically** | `transient`          | `transient`                     |
| the same, but a partial write may have landed                                     | `permanent` (§4.2)   | `permanent`                     |
| mapping/coercion/drift failure, path outside `config.roots`                       | `permanent`          | `permanent`                     |
| run cancelled / server shutdown                                                   | `cancelled`          | `cancelled` — **never retried** |

---

## §5 — the flow contract: bounded streaming, and the log gets counts **[SETTLED]**

**Rows never enter `run_events`.** A copy streams source → sink in bounded batches; what becomes
durable is a summary:

```
node.succeeded { outputs: { rowsRead, rowsWritten, rowsFailed, bytesRead, truncated } }
```

`file_copy` already proves the shape — `connectors/fs.ts:444` streams with a `signal.aborted` check
per chunk (`:459`) and deliberately no byte cap, because a streamed copy is memory-bounded regardless
of size.

**`truncated` is REQUIRED and must be honest.** The codebase has receipts both ways:

- the honest pattern — `server/src/limits.ts:11`, `errors.ts:107-121`: a cap whose truncation is
  STATED, _"never silently — an absent fact must never be manufactured"_;
- the dishonest one, **live today** — `ProcessSupervisor` computes `truncated`
  (`workers/process-supervisor.ts:506`) and `connectors/agent.ts` never reads it, so an over-budget
  `agent_cli` output is silently clipped. **Filed as #1101 while writing this spec.**

`truncated` is a declared output so a pipeline can branch on `${nodes.x.output.truncated}`, the way
`agent_task` already branches on `exitCode` (`connectors/agent.ts:66`).

**`lookup` is the one activity that materialises rows, so its bound is concrete, not "bounded".**
There is no generic output cap in studio — `appendEngineEvent` (`run/events.ts:49`) parses and
inserts, and `node.succeeded.outputs` is `z.record(z.string(), z.unknown())` with no byte limit
(`engine/types.ts:774`); the only cap in the run log is `RUN_DIAGNOSTIC_CAP = 500`
(`repo/run-diagnostics.ts:48`). So `lookup` declares both, in `server/src/limits.ts` beside
`ISSUE_LIST_CAP`:

- `LOOKUP_ROW_CAP = 1000` **and** `LOOKUP_BYTE_CAP = 1 MiB`, whichever binds first;
- **behaviour at the cap: truncate and mark**, never fail. A lookup is a read for a decision, and a
  bounded answer is usable where an error is not. `truncated: true` reaches the output and an
  `activity.warned` reaches the log, so no consumer can mistake a prefix for the whole.

**Progress.** A long copy must not look hung: it emits `node.output` ticks (`engine/types.ts:916` —
_"Observability/streaming ONLY — never enters `outputs` or substitution"_), which is exactly this
channel and needs no new event. Ticks are **per batch, never per row** — one event per row would
reproduce the log-volume problem this section forbids.

---

## §6 — mapping and coercion **[SETTLED]**

### 6.1 The mapping is declared, and lives on the node

```ts
CopyMappingSchema = z.array(
  z
    .object({
      source: z.string().min(1).optional(), // a source column, XOR
      expression: z.string().optional(), // ... a ${} expression producing the value
      sink: z.string().min(1),
      type: DataTypeSchema, // the TARGET type — declared, never inferred
      onError: z.enum(['fail', 'null']).default('fail'),
    })
    .strict(),
);
```

The XOR is enforced by `superRefine` with a per-element `path`, so an issue names its row rather than
the whole array (#1087's precedent).

### 6.2 The coercion matrix

Under-specifying this is how silent data corruption ships. The closed type set is
`string | integer | number | boolean | date | timestamp`. Every conversion either produces a value or
**fails the row** with a named reason — there is no third outcome, and in particular no
"best effort".

| Source value               | → `integer`                     | → `number`            | → `boolean`     | → `date` / `timestamp`                                | → `string`                             |
| -------------------------- | ------------------------------- | --------------------- | --------------- | ----------------------------------------------------- | -------------------------------------- |
| `"42"`                     | 42                              | 42                    | **fail**        | **fail**                                              | `"42"`                                 |
| `"1.5"`                    | **fail** (never truncates to 1) | 1.5                   | **fail**        | **fail**                                              | `"1.5"`                                |
| `"1e400"` / overflow       | **fail**                        | **fail** (non-finite) | **fail**        | **fail**                                              | `"1e400"`                              |
| `"true"` / `"yes"` / `"1"` | 1 only from `"1"`               | 1 only from `"1"`     | `true`          | **fail**                                              | as written                             |
| `""` (empty)               | per `nullValue` (§6.4)          | per `nullValue`       | per `nullValue` | per `nullValue`                                       | `""` — **not null**                    |
| SQL `NULL`                 | `null`                          | `null`                | `null`          | `null`                                                | `null`                                 |
| `"03/04/2026"`             | **fail**                        | **fail**              | **fail**        | only via the declared `dateFormat`; **never guessed** | as written                             |
| a real `number` 1.5        | **fail**                        | 1.5                   | **fail**        | **fail**                                              | `"1.5"` — canonical form, never locale |

Two rows carry most of the risk and are stated deliberately:

- **`"1.5"` → `integer` fails.** Truncating is the silent-corruption path, and a copy that quietly
  rounds a price column is worse than one that stops.
- **dates are parsed by the declared format ONLY.** `03/04/2026` is a different day in two countries;
  a "helpful" parser is a corruption engine. No format declared and a date column mapped → save-time
  refusal, not a run-time guess.

`onError: 'null'` is the per-column opt-out, and is **refused where the sink column is
`nullable: false`** — accepting it would push the failure into the store as a constraint violation,
by which time part of the output is already written.

### 6.3 Auto-map is an authoring ACTION, never a run-time behaviour

Auto-map matches source→sink by name (case-insensitive, trimmed) and **writes an explicit mapping
into the node's config**. It never runs at dispatch.

This is the most important decision in §6. Resolved at dispatch, renaming a source column would
silently re-map — the pipeline would keep succeeding while writing different data to different
columns, with nothing in the log to show it. The same reasoning settled #1077 (capture at write time,
so a later rename cannot retroactively rewrite what the log says). Mapping is strictly more
dangerous, because the artefact is the user's data.

### 6.4 `nullValue`

A dataset declares `nullValue` (default: **none**). CSV genuinely cannot distinguish `""` from
absent, so studio refuses to guess: by default an empty field is the empty **string**. A dataset
whose file uses a sentinel (`\N`, `NULL`) declares it once, on the dataset.

---

## §7 — drift is checked at dispatch **[SETTLED]**

Three schemas exist and must not be conflated:

1. the dataset's **declared** columns (authoring aid, mutable);
2. the node's **mapping** (immutable, in the pipeline version);
3. the store's **actual** columns at run time (discovered).

**The gate is (2) against (3)** — the mapping is what will execute; the store is what will receive it.
(1) is what the UI authored against and what M9 surfaces; it is deliberately **not** the gate, because
a stale declared schema must never block a copy that would in fact succeed, nor bless one that would
fail.

Checked before the first row moves:

| Drift                                                                       | Verdict                                                             |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| a mapped **source** column absent from the actual source                    | `permanent`, naming the column                                      |
| a mapped **sink** column absent from the actual sink                        | `permanent`, naming the column                                      |
| a mapped column's actual type is incompatible with its declared target type | `permanent`, naming both types                                      |
| a **new** column in the source the mapping does not mention                 | **allowed**, reported as `activity.warned` (`engine/types.ts:1198`) |
| a source column the mapping does not mention has **disappeared**            | allowed, silent — it was never read                                 |

Additive drift must not break a working pipeline; that is why row 4 is a warning. It is still said out
loud, because silent additive drift is how a mapping quietly stops covering its source.

---

## §8 — security **[SETTLED]**

**Values bind as parameters. Identifiers refuse `${}` at save time.**

Substitution happens in the **reducer**, not the executor — `engine/reduce.ts:1105` produces
`preparedInput` and the adapter receives it already substituted (`connectors/types.ts:59`). It is a
single inert pass: a resolved value is never rescanned (`engine/params.ts:678-689`), a whole-value
reference preserves its native type (`:740`), an embedded one coerces to string (`:748`).

**The consequence that decides this section:** by the time a value reaches the adapter, an
interpolated table name is an ordinary string and **the adapter cannot tell it came from an
expression.** The rule cannot be enforced at dispatch; it must be enforced where the distinction still
exists — save time.

- **Data values** bind as query **parameters**, always. No value is concatenated into SQL. This makes
  `${}` safe by construction rather than by escaping.
- **Identifiers** (table, schema, column names) — `validateDoc` (`engine/params.ts:1962`, the
  WRITE-path gate that `createPipelineVersion`, git import and workspace-apply all funnel through)
  **refuses** a copy node or dataset whose identifier field is not literal, via the existing
  `interpolationMode` SSOT (`engine/expr.ts:430`). A dynamic table name is not "risky if you are
  careful"; it is unbindable, so it is prohibited.
- **The escape hatch that survives that** is the dataset's `parameters` allowlist (§2.2): an
  owner-declared closed set, secret-refusing, with strict identifier validation and quoting at the
  adapter. Never free text.
- **Paths: EXTRACT and share `fs`'s guard — do not mirror it.** `resolveWithinRoots`
  (`connectors/fs.ts:186`) is a hardened single implementation — lexical `..` collapse, `realpath` on
  roots _and_ the target's parent, `lstat` + `O_NOFOLLOW` at the target, atomic temp+`rename` writes.
  A second copy of that logic is a defect by construction. Note the deliberate shared/server split:
  the absolute-root check must stay server-side (`catalog/connection-config.ts:26-32,62-68`), and
  `connectionConfigAdvisory:405` is **advisory, never a gate** — its own docblock says so, because
  `routes/connections.ts` runs no per-kind validation. **A file-backed dataset must therefore
  re-validate at dispatch and must not assume the stored connection is well-formed.**
- **Credentials** are `Connection.secretRef` rows, decrypted at dispatch into a side-channel argument,
  never in `ctx.input` and never in an event (`connectors/types.ts:1-20`, `executor.ts:477-500`), with
  `redactEventPlaintexts` (`executor.ts:166`) as backstop. **A paired activity resolves two and must
  redact both.**
- **A new credentialled kind MUST join `SECRET_REQUIRING_CONNECTION_KINDS`**
  (`shared/src/schemas/connection.ts:41`, currently only the two hosted LLM kinds). Omit it and
  `deriveSecretStatus` returns `not_required`, so a credential-less `postgres` connection sails
  through the `CONNECTION_NOT_READY` dispatch gate. This is a named build step in M10, not a detail.

---

## §9 — execution tier: a copy must not stall the server **[SETTLED]**

**The measured hazard.** Adapter runs share **one global `pLimit(deps.concurrency ?? 4)` across every
run** (`run/executor.ts:56,241`); per-run dispatch concurrency is also 4 (`PER_RUN_DISPATCH_CONCURRENCY`, `run/driver.ts:900`). Four
long copies would hold every global adapter slot and stall every LLM and http node server-wide.

**And the "zero new dependency" store is the worst case.** `better-sqlite3` is **synchronous**, and
`worker_threads` appears **nowhere** in `packages/server/src` — an in-process SQLite scan blocks the
event loop, and with it the driver pump, the SSE stream and the whole HTTP API.

**Settled, in two parts:**

1. **Batch-yield, not batch-block.** A copy's read/write loop is bounded per batch
   (`COPY_BATCH_ROWS`, default 1000) and **yields to the event loop between batches**. For
   `better-sqlite3` this means stepping the statement in bounded chunks rather than draining a cursor
   in one synchronous call. A batch is a scheduling quantum, not just a write unit — which is also
   why cancellation and progress are both defined at batch boundaries (§5, §10).
2. **A copy does not consume a general adapter slot indefinitely.** Data movement gets its own
   concurrency budget (`COPY_CONCURRENCY`, default 2) so a copy-heavy workspace cannot starve
   interactive activities. Sizing it is an operator concern; the point of specifying it is that
   "share the four slots" is not a decision anyone should reach by default.

**A worker thread or child process is NOT in v1**, though `workers/process-supervisor.ts` is the
in-tree precedent if one is ever needed. Batch-yielding is sufficient for the v1 stores and adds no
IPC, no serialization boundary and no second failure surface. **If M4 measures event-loop stalls that
yielding does not fix, promoting the tier is a follow-up ticket, not a re-spec** — nothing else in
this document depends on where the copy runs.

---

## §10 — what M depends on, and what it must not assume

**Cancellation and timeouts are NOT declared contract fields today.** `ActivityDefinition`
deliberately omits `supportsCancel` and `timeoutScope` — `catalog/types.ts:293` lists them among the
D6 fields "deliberately NOT declared yet ... sequencing behind a named owner (F2a/F2b/F3/F4/F9b-d)"
(F15's `secretSinkFields` is the one that IS declared). There is no per-node timeout in
the executor. **`copy` is the first genuinely long-running activity in the product**, so it must not
be specced as though those fields exist.

- **What exists** is `ctx.signal` (`connectors/types.ts`), which is what `fs.ts:459` already checks.
  `copy` honours it **at batch boundaries**.
- **On cancel, the sink is left in its pre-copy state** wherever §4's atomic swap applies (the staging
  target is discarded, never swapped); where it does not apply, the copy reports what it wrote in
  `rowsWritten` — a cancel must never leave a silent partial.
- **`cancelled` never retries** (`error-kind.ts`), which is the correct polarity and needs no new rule.
- **A copy-owned batch bound is the v1 timeout.** A general per-node timeout is F3/F15's to own; M
  must not grow a private one that later contradicts it.

---

## §11 — the retraction, in all three places

`2026-07-14-foundation-activity-library.md` states the superseded position three times. Striking one
and leaving two is the drift this repo has already been bitten by, so all three are amended in the
same PR, each citing #993:

1. **`:168` (Non-goals)** — _"No dataset/linked-service data-movement abstraction (defer
   `copy`/`lookup`/`transform`)"_ — **struck**.
2. **`:40` (the file-activity row)** — still claims the ADF _"(Copy, GetMetadata)"_ analog for
   `file_copy`. That impersonation is the exact thing #993 objected to (_"everything currently reads
   as a file copy, rather than a copy activity"_). Amended to name `file_copy` as a **file**
   operation and point at this spec for ADF's Copy.
3. **`:177-178` (Open question 3)** — _"design the storage abstraction up-front?"_ — **answered**, and
   marked so with a pointer here.

---

## §12 — build order (M-series)

Strictly ordered. **M1 first and alone** — nothing else can be built on a seam that cannot express a
source and a sink.

| #       | Ticket                                                                                                                                                                                                                      | Notes                                                                                                                                                                                                                                     |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M1**  | **The paired-connection contract widening** (§1): `NodeSchema.connectionIds?`, `ActivityContext.sink?`, the fourth `runActivity` arg, two-sided `resolveConnection` + readiness gate + side-labelled failure codes          | additive; six adapters untouched. Co-owned with #1 D6                                                                                                                                                                                     |
| **M2**  | **The portability exhaustiveness pin FIRST** (§2.3's five silent sites), then the `dataset` resource: schema, table, repo, REST, `RESOURCE_KINDS` widening, apply ordered connections → datasets → pipelines → triggers     | the pin precedes the kind, deliberately                                                                                                                                                                                                   |
| **M3**  | Dataset refs as first-class node fields + the four remap sites + the L13a literal/`${}` rule (§3)                                                                                                                           |                                                                                                                                                                                                                                           |
| **M4**  | `sqlite` connection kind + `table`/`query` dataset kinds + a reader, with §9's batch-yield                                                                                                                                  | **zero new dependencies**                                                                                                                                                                                                                 |
| **M5**  | The `copy` activity: catalog entry, coercion matrix (§6.2), the streaming pump, atomic-swap sink discipline (§4), `truncated`, batch progress ticks, `CATALOG_VERSION` bump (`schemas/version.ts:218`). SQLite→SQLite first | **SPLIT, as this row anticipated** — slice 1 = the coercion matrix + the mapping declaration (#1122); slice 2 = the sink discipline (#1125); slice 3 = the catalog entry + the pump + `truncated` + the progress ticks + the version bump |
| **M6**  | Dispatch-time drift gate (§7) + the resolved-address dispatch record (§2.1)                                                                                                                                                 |                                                                                                                                                                                                                                           |
| **M7**  | `delimited` dataset kind over the existing `fs` connection — **the first heterogeneous copy** (CSV → SQLite)                                                                                                                | the ticket that proves the spec                                                                                                                                                                                                           |
| **M8**  | The mapping authoring panel (§13)                                                                                                                                                                                           | UI epic; e2e-gated                                                                                                                                                                                                                        |
| **M9**  | Dataset detail: referencing pipelines, flagged where mappings no longer agree (§2.1)                                                                                                                                        | UI epic                                                                                                                                                                                                                                   |
| **M10** | `postgres` kind — networked + credentialled, `SECRET_REQUIRING_CONNECTION_KINDS`, TLS                                                                                                                                       |                                                                                                                                                                                                                                           |
| **M11** | `excel` dataset kind                                                                                                                                                                                                        |                                                                                                                                                                                                                                           |
| **M12** | `lookup` with §5's concrete row + byte caps and visible truncation                                                                                                                                                          |                                                                                                                                                                                                                                           |

**Dependencies are named, and checked against packaging, not merely "called out".** `#993` chose the
data-movement build, so these are consequences of a settled decision rather than an open fork — but
each must be verified against `2026-07-30-packaging-and-updates.md` and
`2026-07-24-bun-single-binary-spike.md` **before** its ticket starts, not after:

| Ticket | Dependency                                              | The specific risk to verify                                                                                              |
| ------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| M4     | none — `better-sqlite3@12.11.1` is already a server dep | its **native binding** already ships, so M4 also proves the single-binary story for native modules                       |
| M7     | a CSV parser (streaming, no full materialisation)       | must expose a row stream, not `parse(wholeFile)`                                                                         |
| M10    | `pg`                                                    | a **second** native/TLS surface alongside `better-sqlite3` in a single-binary target — verify empirically, do not assume |
| M11    | an xlsx reader                                          | xlsx is a ZIP container; most readers materialise the sheet, which fights §5 — check before choosing                     |

---

## §13 — the authoring surface, and the trap it must avoid

**The mapping grid cannot be a derived form, and assuming otherwise ships a JSON box.**
`deriveConfigFields` (`web/src/pages/pipeline/configForm.ts:166`) requires an **object-rooted** schema
and classifies fields into `text | number | boolean | enum | stringList | json`; **an array of objects
is not representable**, so it degrades to a raw JSON textarea (`:154-164`, fail-safe by design). A
`copy` carrying `mapping: CopyMappingSchema` would render as exactly the blank JSON box #1087 and
#1090 were filed to remove.

So M8 is a **dedicated panel**, specified as such rather than discovered late: a source→sink table
with per-row target type and `onError`, an **Auto-map** button that writes an explicit mapping (§6.3),
a per-row expression escape hatch, and an explicit _unmapped_ state — a column deliberately not copied
must be visibly so, never merely absent.

Everything else about a copy node (two dataset pickers, batch size, write mode) is flat scalars and
derives for free.

**M8 is the app's FIRST table-shaped authoring surface, and should be built as a primitive rather
than a copy-specific panel.** There is no grid/table authoring control anywhere in studio today — the
closest thing is `ParamRow`/`OutputRow`, a hand-built row repeater for U16, not a reusable table. And
`copy`'s mapping is not the only thing waiting for one: `switch`'s `cases` and `llm_call`'s `tools`
are both natural tables that currently fall through to the JSON control for exactly the same reason
(`configForm.ts:40` — an array-of-object has no typed control). Building M8 as a general
array-of-object editor pays those two down as well.

**It must fit inside U7's settled rule, not beside it** (`adf-grade-ui-design.md:148`): fields are
derived from each activity's own Zod `configSchema`, never from hand-written metadata on the catalog
entry, _"so a parallel field list would be a third copy free to drift"_. The honest way to add a table
is therefore to widen `classify` with an `objectList` kind derived from the element schema — not to
special-case `copy` in the panel, which would be the parallel field list U7 refuses.

**Datasets belong in the Manage hub**, which the UI design already scopes as _"Manage (linked
services, triggers)"_ (`2026-07-14-adf-grade-ui-design.md:33`; the hub's own section is `:117`) — a Datasets list + detail beside
Connections. No new hub, no parallel authoring idiom.

---

## Security model

- **No `${}` reaches SQL as text** — values bind as parameters; identifiers are refused at save time
  by `validateDoc`, because at dispatch the distinction no longer exists (§8). This is the one
  property here that is load-bearing for safety, and it is enforced at the only point where it is
  enforceable.
- **Credentials stay encrypted at rest**, resolved at dispatch into a side-channel argument, never in
  `preparedInput` and never in an event; **both ends** of a paired activity are redacted.
- **A credentialled kind joins `SECRET_REQUIRING_CONNECTION_KINDS`**, or the readiness gate passes a
  connection with no credential (§8).
- **File paths stay inside `config.roots`** via the _shared_ `fs` guard, with its realpath/symlink/
  `O_NOFOLLOW` discipline — and with the knowledge that the browser-side check is advisory only.
- **A dataset's `parameters` allowlist is owner-declared and secret-refusing**, so a borrowed dataset
  cannot be re-pointed by a node that does not own it.
- **Datasets carry no secrets**, so a dataset is safe to serialize to git, diff and export — exactly
  like a connection minus its `secretRef`.
- **RBAC is out of scope** (v1 single-principal); `ownerId` is the future-safe boundary only.

## Blast radius (when the slices build, not this PR)

- `shared`: `+schemas/dataset.ts`; `schemas/connection.ts:9,41` (+2 kinds, +secret-requiring);
  `catalog/connection-config.ts:341,365`; `+catalog/copy-activity-config.ts`;
  `catalog/registry.ts:73` (+`copy`, +`lookup`); `catalog/types.ts` (+type constants);
  `schemas/version.ts:218` (`CATALOG_VERSION`); `schemas/pipeline.ts:376-377` (+`connectionIds?`, +`datasetIds?`); `engine/params.ts:1962` (identifier rule); portability `paths/envelope/
content-form/import-result` + the §2.3 exhaustiveness pin.
- `server`: `+connectors/sqlite.ts`, `+connectors/postgres.ts`, `+connectors/copy/*` (readers,
  writers, coercion, the pump); `connectors/types.ts:241` (+optional sink args);
  `connectors/registry.ts:28`; **extract `resolveWithinRoots` out of `connectors/fs.ts:186` into a
  shared module**; `run/executor.ts:241,327,477` (copy concurrency budget, two-sided resolve,
  side-labelled codes); `run/connection-readiness.ts`; `limits.ts` (+`LOOKUP_ROW_CAP`,
  `LOOKUP_BYTE_CAP`, `COPY_BATCH_ROWS`, `COPY_CONCURRENCY`); `+repo/datasets.ts`,
  `+routes/datasets.ts`; the six portability modules + the four ref-remap sites; a Drizzle migration.
- `web`: Manage › Datasets (list/detail), the M8 mapping panel, the copy node's dataset pickers.
- Tests: dataset repo/route/portability round-trip; **every row of §6.2's coercion matrix**; all five
  drift arms (§7); the identifier save-time refusal; the literal-vs-`${}` dataset-ref round-trip
  (§3); a heterogeneous CSV→SQLite copy end to end; a mutation proof that `lookup`'s truncation marker
  goes red when the plumbing is removed (#1101's lesson); a test that a non-atomic sink's `transient`
  cause is reported `permanent` (§4).

## Non-goals

- **`transform` / data-flow authoring** — ADF's Mapping Data Flows are a separate Spark runtime with
  their own authoring surface, and a thin imitation is exactly the false promise #993 objects to.
  Per-column expressions (§6.1) cover concat/cast/constant/conditional without pretending otherwise.
- **Document / NoSQL stores** — a schema-less source has no column list to map from; it needs a
  projection design, not a mapping design. Adding one would not exercise this abstraction, it would
  demand a second.
- **Dataset versioning, publish, an `active` pointer, or trigger binding** (§2.4) — the run-binding
  invariant does not require them, and #996's claim that it does is answered in §2.
- **Resumable / watermark / CDC copies** (§4) — needs durable run-scoped state that outlives a run,
  which the engine does not have.
- **Parallel or partitioned copy** — v1 is one stream per copy node; `foreach` already gives per-item
  parallelism for sharding by file (#4 A4b).
- **A worker/child-process execution tier** (§9) — batch-yielding is sufficient for the v1 stores; a
  promotion is a follow-up ticket, and nothing here depends on where the copy runs.
- **A generic activity-output byte cap** (§5) — a real pre-existing gap, wider than data movement,
  and it deserves its own ticket rather than a `copy`-shaped patch.
- **Resource-level audit events for create/update** (§2.4) — no resource kind has them; datasets must
  not be the exception.

## Evidence (probed, not argued)

- **Linked services already exist.** `shared/src/schemas/connection.ts:3` — _"a named worker binding
  (ADF 'Linked Service' analog)"_; `:9` six kinds; `:41` `SECRET_REQUIRING_CONNECTION_KINDS` = the two
  hosted LLM kinds only.
- **One node binds ONE connection.** `shared/src/schemas/pipeline.ts:377` (singular, optional);
  `connectors/types.ts:61` (one `connectionConfig`), `:241` (`runActivity(ctx, secret, secretFields?)`);
  registry keyed by kind (`registry.ts:12`); one adapter serves many activities (`types.ts:52`).
- **Only pipelines are versioned.** `repo/connections.ts:155` mutates in place; immutability triggers
  exist for `pipeline_versions` only (`0002_p1a_data_model.sql:68-84`); `RESOURCE_KINDS` is three
  (`portability/paths.ts:28`).
- **Run binding does not depend on resource versioning.** `db/schema.ts:271` — NOT NULL,
  `onDelete: restrict`.
- **Environment promotion is a non-goal**, so it cannot be the argument for a mutable dataset —
  `foundation-git-publish.md:900`.
- **Cross-resource refs are first-class node FIELDS, remapped at four sites.** `export.ts:40-56`
  (literal nulled, `${}` preserved), `workspace-serialize.ts:219-225,444-451`,
  `workspace-apply.ts:191-206`, masking at `workspace-serialize.ts:321,366`. `Node.config` is an
  opaque `z.record` (`pipeline.ts:376`) that nothing remaps.
- **`retryEligible` never reads `idempotent`.** `shared/src/engine/reduce.ts:3159-3168` — only
  `kind === 'transient'` and `policy.retry`. `idempotent` governs boot recovery
  (`docs/2026-07-13-p2-engine-spec.md:180-184`).
- **`file_write` is already crash-safe by temp+`rename`.** `connectors/fs.ts:63-64`, with a
  per-`(run,node,attempt)` temp suffix at `:300-304`.
- **Adapter concurrency is one global pool of 4.** `run/executor.ts:56,241`;
  `PER_RUN_DISPATCH_CONCURRENCY = 4` at `run/driver.ts:900`. Note the docblock immediately above it: the
  global `p-limit` caps only the **adapter phase**, which sits after the per-run pre-flight — so a
  copy holding an adapter slot is the constraint that matters here.
- **`better-sqlite3` is synchronous and there are no worker threads.** `packages/server/package.json:19`;
  `grep -rl worker_threads packages/server/src` → nothing.
- **Cancel/timeout are undeclared contract fields.** `catalog/types.ts:293` lists `supportsCancel` and
  `timeoutScope` among the D6 fields still sequencing behind named owners; `ctx.signal` is what exists,
  and `connectors/fs.ts:459` is how it is used.
- **Substitution is a single inert pass in the REDUCER.** `engine/reduce.ts:1105`;
  `engine/params.ts:678-689`, `:740` whole-value type preservation vs `:748` embedded coercion; mode
  SSOT `engine/expr.ts:430`.
- **`validateDoc` is a WRITE-path gate, not advisory.** `engine/params.ts:1962`, funnelled by
  `createPipelineVersion`, git import and workspace-apply alike.
- **Nothing bounds an activity's output today.** `run/events.ts:49`; `engine/types.ts:774`. The only
  run-log cap is `RUN_DIAGNOSTIC_CAP = 500` (`repo/run-diagnostics.ts:48`). The honest-truncation
  pattern exists only elsewhere (`limits.ts:11`, `errors.ts:107-121`).
- **Silent truncation is live in one adapter.** `workers/process-supervisor.ts:506` computes
  `truncated`; `connectors/agent.ts` never reads it — **#1101**.
- **`fs` confinement + its deliberate schema gap.** `connectors/fs.ts:186` `resolveWithinRoots`;
  `catalog/connection-config.ts:62-68` (absolute check server-only), `:395,405`
  (`connectionConfigAdvisory` is _"advisory, never a gate"_).
- **A nested config renders as a JSON box.** `web/src/pages/pipeline/configForm.ts:166` returns `null`
  for a non-object-rooted schema (`:154-164`); consumed at `PipelineCanvas.tsx:2300`.
- **The failure taxonomy.** `engine/types.ts:491` `['transient','permanent','cancelled']`;
  provider→engine narrowing `connectors/error-kind.ts:28`; 5-valued `ConnectorErrorKind` at
  `connectors/types.ts:37`.
- **Five portability enumerations are unchecked by the compiler.** `workspace-serialize.ts:626,637`;
  `workspace-drift.ts:161-173`; `workspace-reconcile.ts:307-344`; `workspace-apply.ts:488,777`;
  `envelope.ts:267`. Flagged in `portability/paths.ts:22-27`.
- **Apply order is leaf-first, referrer-last.** `workspace-apply.ts:488` (connections, _"leaf: they
  reference nothing"_) → `:559` (pipelines) → `:777-778` (triggers, _"AFTER the version mints"_).
- **The git spec already anticipates datasets as files.** `foundation-git-publish.md:12` — _"each
  pipeline / linked-service / dataset a separate file"_.
