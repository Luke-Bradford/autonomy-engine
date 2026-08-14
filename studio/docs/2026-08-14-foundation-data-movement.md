# Foundation Spec #9 — Data movement: linked services, datasets, and `copy`

**Status:** proposed — written 2026-08-14 against the tree at `a29a70a3`, for #996.
**Scope:** ADF-grade data movement — **heterogeneous** source and sink (CSV/Excel → database,
database → CSV, any-to-any) with declared column **mapping**, type coercion and a schema-drift
policy. Settles the three layers (**linked services → datasets → `copy`**) and the seam changes
each needs.
**Non-goal:** re-deriving the ActivityDefinition contract (#1 D6), the secret model (#7), or the
expression language (#6). This spec says WHAT the data layer is and WHICH existing seams it
extends; those specs still own their mechanisms.

**This spec RETRACTS a non-goal.** `2026-07-14-foundation-activity-library.md` carried
*"No dataset/linked-service data-movement abstraction (defer `copy`/`lookup`/`transform`)"*.
Operator decision #993 (2026-08-07) reversed it: *"the source and sink types could be different,
we might want to move a csv or excel file into a database, or viceversa."* That line is struck in
the same PR as this spec, citing #993 — leaving it in place while building the opposite is the
contradiction class the loop already has a rule against.

---

## The finding that reshapes the phase

**#996 frames this as three missing layers. Two of the three already exist, and the one real
blocker is in neither of them.**

1. **Linked services are BUILT.** `Connection` is documented, in its own docblock, as *"a named
   worker binding (ADF 'Linked Service' analog)"* — `shared/src/schemas/connection.ts:3`. It
   already carries `resourceId` (git identity), `config` (non-secret), `secretRef`, `secretStatus`,
   `enabled`, and a per-dispatch override allowlist (`parameters`, #2 L13b). **Layer 1 is not a
   layer to build; it is new `ConnectionKind`s on a seam that is already load-bearing for six
   kinds.**
2. **Datasets are genuinely new** — but far smaller than #996 assumes, for the reason in §1.
3. **The real blocker is the adapter seam itself, and it is not mentioned in #996 at all.**

### §0 — the blocker: one node, one connection **[SETTLED — the contract widens]**

A `copy` is *heterogeneous by definition*: it reads from one store and writes to another, and the
two are usually different kinds. **The current dispatch path physically cannot express that.**

```ts
// shared/src/schemas/pipeline.ts:377
connectionId: z.string().min(1).optional(),          // ONE, singular

// server/src/connectors/types.ts:61,223
connectionConfig: Record<string, unknown>;           // ONE bound Connection's config
runActivity(ctx, secret: string | null, secretFields?): AsyncIterable<ActivityEvent>;
```

The registry is keyed by connection **kind** (`connectors/registry.ts:12`), one adapter serves many
activity types via `ctx.activityType` (`types.ts:52` — this is how `fs` backs all six file
activities), and the executor resolves exactly one connection and one secret
(`run/executor.ts:327,477`). There is no second slot anywhere on the path.

So every "just add a `copy` activity" plan is wrong before it starts. Three ways out were
considered:

| | Shape | Verdict |
|---|---|---|
| (a) | **Widen the contract to a source/sink PAIR** — the node binds two connections, the executor resolves both, the adapter receives both. | **CHOSEN** |
| (b) | One `data_movement` connection kind whose adapter internally owns every store client; source and sink named inside the copy's config, credentials via `{$secret}` sink fields. | Rejected |
| (c) | Split into `read` + `write` activities joined by an output. | Rejected outright |

**(c) is rejected on correctness, not taste:** the only channel between two nodes is an output, and
outputs land in `run_events` (`run/events.ts:49`). Piping a million rows through the append log is
the defect §3 exists to prevent, and it is unbounded today (§3).

**(b) is rejected because it re-implements the connection model inside one adapter.** Store
credentials would stop being `Connection.secretRef` rows with a `secretStatus` readiness gate
(`connection.ts:~100`, checked at `run/connection-readiness.ts`) and become config-sink markers, so
a store's credential would no longer appear in Manage › Connections, would not participate in
`enabled`, and could not be shared across pipelines the way every other credential is. It trades a
contract widening for a permanent divergence.

**(a) is what ADF does** (a copy names two datasets, each on its own linked service) and it is the
only option under which a store connection is an ordinary `Connection`. Its cost is honest and
bounded — the widening is **additive and optional at every point**:

- `NodeSchema` gains `connectionIds?: { source, sink }` **beside** `connectionId`, which stays the
  binding for every existing single-connection activity. No existing node changes shape, so no
  stored `PipelineVersion` is re-interpreted (`pipeline_versions` are immutable —
  `0002_p1a_data_model.sql:68-84` — so a re-interpretation is unfixable, which is why this must be
  additive).
- `ActivityContext` gains an optional `sink?: { connectionConfig }`, and `runActivity` an optional
  fourth `sinkSecret` argument. Six existing adapters ignore both.
- The executor's `resolveConnection` (`executor.ts:327`) is called twice for a paired activity; its
  structured failure codes (`SECRET_NOT_FOUND` / `SECRET_UNDECRYPTABLE`) gain a side label so a
  failure names WHICH end failed. **A failure that cannot say which end failed is a support
  problem, not a detail.**
- `connection-readiness` gates BOTH ends: a copy whose sink needs a secret it has not got must not
  dispatch, exactly as a single-connection node must not.

**M1 is therefore the prerequisite ticket for the whole series**, and it is a framework change
(#1's contract), not a data-movement one. It is specced here because this is what needs it, and
noted in the build order as owned jointly.

---

## The four decisions this spec settles

| | Question | Answer | § |
|---|---|---|---|
| **①** | Are datasets VERSIONED like pipelines, or mutable rows like connections? | **Mutable rows** — and the ticket's stated reason for versioning them is false | §1 |
| **②** | Where does a copy's data actually flow, and what reaches the log? | **Bounded streaming; rows NEVER enter `run_events`** | §3 |
| **③** | What stops `${}` becoming SQL injection? | **Values bind as parameters; identifiers refuse `${}` at SAVE time** | §5 |
| **④** | What is in v1? | delimited + Excel + SQLite + Postgres · `lookup` in · `transform` out | §6 |

---

## §1 — the dataset: a MUTABLE first-class resource, modelled on `Connection` **[SETTLED]**

**#996 states:** *"a new resource that does not participate in the version model would break the
run-binding invariant."* **Probed: that is false**, and it matters, because acting on it costs ~22
enumeration touch points and mints a second versioned-resource precedent.

**Only pipelines are versioned.** Connections and triggers are mutable rows (`repo/connections.ts:155`).
Run binding is preserved by `runs.pipelineVersionId` being NOT NULL with `onDelete: restrict`
(`db/schema.ts:271`) — a run pins one immutable pipeline version forever. **What makes a run
reproducible is that its NODE CONFIG is complete inside that version**, not that every resource it
touches is versioned. Connections prove it: they are freely mutable and run binding does not break,
because a connection supplies an *address*, resolved at dispatch, and re-pointing dev→prod is a
thing you WANT.

So the question is not "is a dataset like a pipeline or like a connection" — a dataset is honestly
**both**, and the resolution is to split it by role:

| Role | Lives in | Mutability | Why |
|---|---|---|---|
| **Address** — which store, which table/path, format options | the **dataset row** | mutable | re-pointing is the whole point of the resource existing |
| **Contract** — the column mapping and the schema it was authored against | the **`copy` node's config**, inside the immutable `PipelineVersion` | immutable | a mapping is compiled against a shape; a run must execute the mapping it was authored with |
| **Declared schema** — the dataset's own column list | the dataset row | mutable | an **authoring aid** and a **dispatch-time drift check** — never a run input |

**The rule, stated once:** *a dataset carries an address the pipeline dials; the mapping carries a
contract the pipeline compiled against.* Change the address and the pipeline aims elsewhere,
deliberately. Change the shape and the pipeline finds out at dispatch (§4), loudly.

**The failure mode this design must own, named rather than hidden:** a dataset's declared schema and
its `copy` nodes' mappings can drift apart, and nothing stops a user editing the dataset. That is
NOT silent — §4's drift check is a dispatch-time gate that fails `permanent` with the offending
columns named. What it is not is a *save-time* gate on the dataset, because a dataset does not know
its consumers cheaply. **M8 adds the affordance that makes this humane: a dataset's detail page
lists the pipelines whose mappings reference it and flags those whose columns no longer agree.**
That is ADF's "related" surface, and it is a UI ticket, not a correctness one.

### 1.1 Schema delta

`shared/src/schemas/dataset.ts` (new), modelled field-for-field on `connection.ts:65`:

```ts
DatasetSchema = z.object({
  id, resourceId, ownerId,                  // identical contract to Connection (G1 identity)
  name: z.string().min(1),
  connectionId: z.string().min(1),          // the STORE this dataset lives in
  kind: DatasetKindSchema,                  // 'delimited' | 'excel' | 'table' | 'query'
  config: z.record(z.string(), z.unknown()),// kind-specific, non-secret, per CONNECTION_CONFIG_SCHEMAS' pattern
  columns: z.array(DatasetColumnSchema),    // the DECLARED schema (authoring aid + drift check)
  parameters: z.array(z.string().min(1)).default([]),   // §5 — the L13b allowlist, reused verbatim
  createdAt, updatedAt,
});

DatasetColumnSchema = z.object({
  name: z.string().min(1),
  type: DataTypeSchema,                     // §4's closed type set
  nullable: z.boolean(),
});
```

`columns` is **REQUIRED with no `.default([])`.** An absent column list must fail loudly at the read
boundary, never be manufactured as an empty schema — that is #473's lesson, and the identical
fail-closed shape `connection.ts` already applies to `secretStatus`. An empty declared schema would
otherwise read as "this table has no columns" and auto-map (§4.3) would silently produce an empty
mapping.

### 1.2 Portability — the enumeration points

A dataset is git-serialized and export/importable like the other three. `foundation-git-publish.md:12`
already anticipates the file layout (*"each pipeline / linked-service / dataset a separate file"*).
Adding it means widening, in this order:

1. `shared/src/portability/paths.ts:28` — `'dataset'` into `RESOURCE_KINDS` (+ `RESOURCE_KIND_DIRS:38`;
   `MANAGED_DIRS`/`kindForDir` derive).
2. `shared/src/portability/envelope.ts:147,154` — `ExportKindSchema` + a `kind:'dataset'` union arm.
3. `shared/src/portability/content-form.ts:87` — a `datasetContentForm` reusing `RESOURCE_VOLATILE`.
4. `shared/src/portability/import-result.ts:39` — the result arm.
5. `server/src/portability/` — `export.ts`, `import.ts`'s kind switch, `workspace-serialize.ts`'s
   per-kind loop, `workspace-parse.ts`, `workspace-reconcile.ts`, `workspace-drift.ts`.
6. `server/src/portability/workspace-apply.ts` — **a `// --- Datasets ---` section between
   Connections and Pipelines.** Ordering is load-bearing and is the one thing easy to get wrong: a
   dataset references a connection, and a pipeline's copy node references a dataset, so the apply
   order is connections → datasets → pipelines → triggers.
7. `web/src/api/portability.ts` — the display arm.

That is ~10 touch points against the ~22 a versioned dataset would need, and it adds **no** new
immutability triggers, no `dataset_versions` table, no second publish/CAS surface, and no new
`WorkspaceEvent` union arm.

### 1.3 What a dataset deliberately does NOT get

- **No `active` pointer and no Publish.** Publish is a CAS over an event projection and refuses
  outright when no git repo is connected (`routes/pipelines.ts:274,289-294`). Datasets are mutable,
  so there is nothing to promote. A dataset edit takes effect on the next dispatch, exactly like a
  connection edit.
- **No trigger binding.** Triggers bind pipeline versions (`db/schema.ts:225`); a dataset is reached
  through a pipeline, never fired directly.
- **No audit event in v1.** Plain create/update writes no audit row for ANY resource today (only
  archive/restore/publish/import/connect do) — a `dataset.created` event would be a new precedent,
  and inventing one here would make datasets louder than connections for no stated reason. If
  resource-level auditing is wanted it is one ticket across all four kinds, not a dataset special
  case.

---

## §2 — linked services: new `ConnectionKind`s, not a new layer **[SETTLED]**

Each store is an ordinary `Connection`. Adding one is a known, tested path:

- `shared/src/schemas/connection.ts:9` — the kind into `ConnectionKindSchema`; `:41`
  `SECRET_REQUIRING_CONNECTION_KINDS` for the credentialled ones.
- `shared/src/catalog/connection-config.ts:341` — `CONNECTION_CONFIG_SCHEMAS` is **exhaustive over
  the enum**, so a missing entry is a compile error, not a runtime surprise; plus
  `CONNECTION_SECRET_USE:365`.
- `server/src/connectors/<kind>.ts` — the `ConnectorAdapter` (`connectors/types.ts:223`), extending
  the shared config schema server-side where a check cannot be expressed browser-safely (the
  `fs.ts:138` pattern).
- `server/src/connectors/registry.ts:28` — register it.
- `connectors/__tests__/connection-config-ssot.test.ts` — the shared-vs-server agreement test.

**Carry `fs`'s confinement model, and carry its known gap knowingly.** `fs` confines every
pipeline-supplied path to a server-side `config.roots` allowlist (`connectors/fs.ts:186`
`resolveWithinRoots`: realpath, `..` collapse, `root + sep` containment, `lstat` symlink refusal,
`O_NOFOLLOW`). The absolute-root check lives server-side because it needs `node:path.isAbsolute`
(`catalog/connection-config.ts:62-68`), and the browser-side `connectionConfigAdvisory:405` is
**advisory, never a gate** — its own docblock says so, because `routes/connections.ts` runs no
per-kind validation. **A file-backed dataset must therefore re-validate at dispatch and must not
assume the stored connection is well-formed.** Any new store kind with a path-shaped config inherits
this exactly, and `#1087`'s lesson applies: when a check is deliberately absent from a shared schema,
every consumer of that schema has to know.

---

## §3 — the flow contract: bounded streaming, and the log gets counts **[SETTLED]**

**Rows never enter `run_events`.** A copy streams source → sink in bounded batches, and what becomes
durable is a *summary*:

```
node.succeeded { outputs: { rowsRead, rowsWritten, rowsFailed, bytesRead, truncated } }
```

`file_copy` already proves the streaming shape in-tree — `connectors/fs.ts:444` streams and checks
`signal.aborted` per chunk (`:459`), deliberately without a `maxBytes` cap because a streamed copy is
memory-bounded regardless of size. `copy` follows it: bounded memory, cancellable at a batch
boundary, `supportsCancel: true`.

**`truncated` is REQUIRED on the output and must be honest.** This is not a nicety, and the codebase
has the receipts both ways:

- the honest pattern: `server/src/limits.ts:11` and `errors.ts:107-121` — a cap whose truncation is
  STATED (`truncated`/`totalIssues`), *"never silently — an absent fact must never be manufactured"*;
- the dishonest one, **live today**: `ProcessSupervisor` computes `truncated` at
  `workers/process-supervisor.ts:506` and `connectors/agent.ts` never reads it, so an over-budget
  `agent_cli` output is silently clipped. **Filed as #1101** while writing this spec.

`copy` must not repeat #1101. Its `truncated` flag is a declared output so a pipeline can branch on
`${nodes.x.output.truncated}`, the way `agent_task` already branches on `exitCode`
(`connectors/agent.ts:66`).

**There is no generic output bound in studio.** `appendEngineEvent` (`run/events.ts:49`) parses and
inserts; `node.succeeded.outputs` is `z.record(z.string(), z.unknown())` with no byte cap
(`engine/types.ts:774`). `copy`'s own outputs are scalars so it does not need one — but **`lookup`
(§6) does**, because it materialises rows into an output by design. `lookup` therefore carries a hard
row cap in `server/src/limits.ts` (the existing SSOT, alongside `ISSUE_LIST_CAP`) and sets the same
visible `truncated` marker. A generic activity-output bound is a broader gap and is NOT in this
spec's scope; it is noted in §8 as the ticket it deserves.

**Progress.** A long copy must not look hung. It emits `node.output` progress ticks
(`engine/types.ts:916` — *"Observability/streaming ONLY — never enters `outputs` or substitution"*),
which is exactly the channel for this and needs no new event. Ticks are **batch-boundary, not
per-row** — one event per row would reproduce the very log-volume problem this section forbids.

---

## §4 — mapping, coercion, and drift **[SETTLED]**

### 4.1 The mapping is declared, and lives on the node

```ts
CopyMappingSchema = z.array(z.object({
  source: z.string().min(1),      // source column name, or
  expression: z.string().optional(), // ... a ${} expression producing the value (escape hatch)
  sink: z.string().min(1),        // sink column name
  type: DataTypeSchema,           // the TARGET type — coercion is declared, never inferred
  onError: z.enum(['fail', 'null']).default('fail'),
}).strict());
```

Exactly one of `source` / `expression` per row, enforced by `superRefine` with a per-element `path`
so an issue names its row rather than the whole array (the `#1087` precedent).

### 4.2 Coercion is a declared, total function — never inferred per row

Under-specifying this is how silent data corruption ships. The closed type set is
`string | integer | number | boolean | date | timestamp`, and every conversion either produces a
value or **fails the row** with a named reason:

| From → to | Rule |
|---|---|
| text → `integer` | strict parse of an optionally-signed integer; `1.5` **fails**, never truncates to `1` |
| text → `number` | strict IEEE-754 parse; `NaN`/`Infinity` fail (matching `canonicalStringify`'s refusal of non-finite values) |
| text → `boolean` | a closed token set (`true/false/1/0/yes/no`, case-insensitive); anything else fails |
| text → `date`/`timestamp` | **only** the dataset's declared `dateFormat`. No locale-dependent or "helpful" parsing — `03/04/2026` is a different day in two countries and guessing is corruption |
| `''` (empty) → any | governed by the dataset's `nullValue` (§4.4) |
| any → `string` | total; numbers use the canonical form, not a locale format |

`onError: 'null'` is the per-column opt-out and is refused where the sink column is `nullable: false`
— accepting it would push the failure into the store as a constraint violation, at which point the
run has already written part of its output.

### 4.3 Auto-map is an authoring ACTION, never a run-time behaviour

Auto-map matches source→sink by name (case-insensitive, trimmed) and **writes an explicit mapping
into the node's config**. It never runs at dispatch.

This is the single most important decision in §4. If auto-map resolved at dispatch, renaming a source
column would silently re-map — the pipeline would keep succeeding while writing different data to
different columns, with nothing in the log to show it. The same reasoning settled #1077 (capture the
name at write time, so a later rename cannot retroactively rewrite what the log says). Mapping is
strictly more dangerous, because the artefact is the user's data.

### 4.4 Drift is checked at dispatch and fails `permanent`

Three schemas exist and must not be confused:

1. the dataset's **declared** columns (authoring aid, mutable);
2. the node's **mapping** (immutable, in the pipeline version);
3. the store's **actual** columns at run time (discovered).

**The gate is (2) against (3)** — the mapping is what will execute, and the store is what will
receive it. (1) is what the UI authored against and what M8 surfaces drift on; it is deliberately
NOT the gate, because a stale declared schema must never be able to block a copy that would in fact
succeed, nor bless one that would fail.

The dispatch check, before the first row moves:

- a mapped **source** column absent from the actual source → `permanent`, naming the column;
- a mapped **sink** column absent from the actual sink → `permanent`, naming the column;
- a **new** column in the source that the mapping does not mention → allowed, and reported as an
  `activity.warned` (`engine/types.ts:1198`). Additive drift is normal and must not break a
  working pipeline; silent additive drift is still worth saying out loud.

The dataset's `nullValue` (default: none — an empty CSV field is the empty **string**, not null)
settles the classic corruption case, and its default is the conservative one: CSV genuinely cannot
distinguish `""` from absent, so studio refuses to guess.

---

## §5 — security **[SETTLED]**

**Values bind as parameters. Identifiers refuse `${}` at save time.**

Substitution happens in the **reducer**, not the executor — `engine/reduce.ts:1105` produces
`preparedInput`, and the adapter receives it already substituted (`connectors/types.ts:59`). It is a
single inert pass: a resolved value is never rescanned, so a value containing `${` is not
re-expanded (`engine/params.ts:678-689`), and a whole-value reference preserves its native type
(`params.ts:740`) while an embedded one coerces to string (`:748`).

**The consequence that decides this section:** by the time a value reaches the adapter, an
interpolated table name is an ordinary string and **the adapter cannot tell it came from an
expression.** So the rule cannot be enforced at dispatch — it has to be enforced where the
distinction still exists, which is save time.

- **Data values** — every mapped value binds as a query **parameter**. No value is ever concatenated
  into SQL. This is what makes `${}` safe by construction rather than by escaping.
- **Identifiers** (table, schema, column names) — `validateDoc` (`engine/params.ts:1962`, the
  WRITE-path gate that `createPipelineVersion`, git import and workspace-apply all funnel through)
  **refuses** a copy node or dataset whose identifier field is not literal, using the existing
  `interpolationMode` SSOT (`engine/expr.ts:430`). A dynamic table name is not "risky if you are
  careful"; it is unbindable, so it is prohibited.
- **The parameterised escape hatch that survives that.** A dataset's `parameters` allowlist reuses
  #2 L13b verbatim (`connection.ts:~78-98`): the dataset OWNER declares which `config` keys a node
  may override, and the dispatch merge **refuses any resolved value that is `{$secret:…}`-shaped**.
  Where an identifier genuinely must vary, it varies over that owner-declared closed set with strict
  identifier validation and quoting at the adapter — never over free text.
- **Paths** inherit `fs`'s confinement whole (§2), including the knowledge that the shared schema's
  check is advisory and the server's is the gate.
- **Credentials** are `Connection.secretRef` rows, decrypted at dispatch into a side-channel
  argument, never in `ctx.input` and never in an event (`connectors/types.ts:1-20`,
  `executor.ts:477-500`), with `redactEventPlaintexts` (`executor.ts:166`) as the backstop. A paired
  activity resolves two of them and must redact both.

---

## §6 — v1 scope **[SETTLED]**

**Stores.** Chosen to be *heterogeneous on purpose*, so the abstraction is exercised rather than
assumed. Breadth of connectors is the easy axis and can follow.

| Store | Why | Cost |
|---|---|---|
| **delimited** (CSV/TSV) | the format the operator named | a CSV parser dependency |
| **excel** (xlsx) | the other format the operator named; proves format-on-dataset (§7) is real | an xlsx dependency |
| **sqlite** | proves the relational path at **zero new dependency** — `better-sqlite3` is already a server dep | none |
| **postgres** | proves the *networked + credentialled* path through `SecretRef`, which sqlite cannot | a `pg` dependency |

Both file formats ride the **existing `fs` connection** and its `config.roots` confinement — they are
dataset *kinds*, not new connection kinds. Only `sqlite` and `postgres` are new `ConnectionKind`s.

**Document stores are OUT of v1, with the reason stated rather than deferred silently:** a
schema-less source has no column list to map from, so it needs a projection/flattening design that is
a different problem from column mapping. Adding one would not exercise this abstraction; it would
demand a second one.

**Three new dependencies is a real cost and is called out as a decision, not absorbed.** The
packaging spec (`2026-07-30-packaging-and-updates.md`) ships a single binary, so each dependency has
to bundle. `sqlite` deliberately goes first in the build order precisely because it proves the whole
relational path — adapter, mapping, coercion, drift — while adding nothing to the bundle.

**`lookup` is IN v1.** It is the bounded-read half and it is what makes a dataset useful outside a
copy: read ≤N rows into an output that other nodes can `${}` reference. It is cheap once the reader
exists, and it carries §3's hard cap and visible `truncated` marker because it materialises by design.

**`transform` is OUT of v1.** ADF's Mapping Data Flows are a separate Spark runtime with their own
authoring surface; a thin imitation would be exactly the false promise #993 objects to — the canvas
implying a capability that is not there. Per-column expressions in the mapping (§4.1) cover the
genuinely common cases (concat, cast, constant, conditional) without pretending to be a data-flow
engine.

---

## §7 — where format lives: on the DATASET **[SETTLED]**

ADF's answer, and the reasoning holds independently:

- **not the linked service** — one folder holds CSV and Excel side by side, so format-on-connection
  forces a separate connection per format, and the connection is the thing carrying the credential
  and the confinement. Splitting it by format multiplies the security-relevant object.
- **not the copy** — the mapping surface needs the source's columns to auto-map against. If format
  lived on the copy, a dataset could not describe its own columns and every copy would re-declare
  them.
- **the dataset** — a dataset is precisely *"a thing in a store, in a shape"*. `kind` selects the
  reader (`delimited`/`excel`/`table`/`query`), `config` carries the kind's options (delimiter,
  header row, sheet name, encoding, `nullValue`, `dateFormat`).

---

## §8 — build order (M-series)

Strictly ordered. **M1 first and alone** — nothing else can be built on a seam that cannot express a
source and a sink.

| # | Ticket | Notes |
|---|---|---|
| **M1** | **The paired-connection contract widening** (§0). `NodeSchema.connectionIds?`, `ActivityContext.sink?`, the fourth `runActivity` argument, two-sided `resolveConnection` + readiness gate + side-labelled failure codes. **Additive; six adapters untouched.** | co-owned with #1's D6 contract |
| **M2** | The `dataset` resource: schema, table, repo, REST, `RESOURCE_KINDS` widening + the seven portability seams (§1.2), apply ordered connections → datasets → pipelines → triggers. | no versioning, no publish |
| **M3** | `sqlite` connection kind + the `table`/`query` dataset kinds + a reader. **Zero new dependencies** — proves the relational path end to end. | |
| **M4** | The `copy` activity: catalog entry, coercion (§4.2), the streaming pump, `truncated`, batch-boundary progress ticks, `CATALOG_VERSION` bump (`schemas/version.ts:218`). SQLite→SQLite first. | |
| **M5** | Dispatch-time drift checking (§4.4) + the `activity.warned` additive-drift report. | |
| **M6** | `delimited` dataset kind over the existing `fs` connection — **the first heterogeneous copy** (CSV → SQLite). This is the ticket that proves the whole spec. | |
| **M7** | The mapping authoring panel (§9). | UI epic; e2e-gated |
| **M8** | Dataset detail: the pipelines referencing it, flagged where their mappings no longer agree with its declared columns (§1). | UI epic |
| **M9** | `postgres` connection kind — the networked + credentialled path, `SecretRef`, TLS. | |
| **M10** | `excel` dataset kind. | |
| **M11** | `lookup` activity with §3's hard row cap + visible truncation. | |

**Not in this series, but this spec exposed it:** there is no generic bound on an activity's output
before it enters `run_events` (§3). That is a pre-existing gap, wider than data movement, and it
deserves its own ticket rather than a `copy`-shaped patch.

---

## §9 — the authoring surface, and a trap it must avoid

**The mapping table cannot be a derived form, and assuming otherwise ships a JSON box.**
`deriveConfigFields` (`web/src/pages/pipeline/configForm.ts:166`) requires an **object-rooted**
schema and classifies fields into `text | number | boolean | enum | stringList | json`; **an array of
objects is not representable**, so it degrades to a raw JSON textarea (`:154-164`, fail-safe by
design). A `copy` whose config carries `mapping: CopyMappingSchema` would therefore render as exactly
the blank JSON box #1087 and #1090 were filed to remove.

So M7 is a **dedicated panel**, specified as such rather than discovered late: a two-column
source→sink table with per-row target type and `onError`, an **Auto-map** button that writes an
explicit mapping (§4.3), a per-row expression escape hatch, and an explicit *unmapped* state — a
column that is deliberately not copied must be visibly so, never merely absent.

Everything else about a copy node (the two dataset pickers, batch size, write mode) is flat scalars
and derives for free.

**Datasets belong in the Manage hub**, which the UI design already scopes as *"Manage (linked
services, triggers)"* (`2026-07-14-adf-grade-ui-design.md:33,117`) — a Datasets list + detail beside
Connections, no new hub, no parallel authoring idiom.

---

## Security model

- **No `${}` reaches SQL as text.** Values bind as parameters; identifiers are refused at save time
  by `validateDoc` using `interpolationMode`, because at dispatch the distinction no longer exists
  (§5). This is the one property of this spec that is load-bearing for safety, and it is enforced at
  the only point where it is enforceable.
- **Credentials stay in the encrypted store**, resolved at dispatch into a side-channel argument,
  never in `preparedInput` and never in an event; a paired activity redacts BOTH ends
  (`executor.ts:166,477-500`).
- **File paths stay inside `config.roots`**, with `fs`'s realpath/symlink/`O_NOFOLLOW` discipline
  (`connectors/fs.ts:186`) and with the knowledge that the browser-side check is advisory only.
- **A dataset's `parameters` allowlist is owner-declared and secret-refusing**, reusing L13b so a
  borrowed dataset cannot be re-pointed by a node that does not own it.
- **Readiness gates both ends** — a copy whose sink connection lacks its secret does not dispatch.
- **No new plaintext surface**: datasets carry no secrets, so a dataset is safe to serialize to git,
  diff and export, exactly like a connection minus its `secretRef`.

## Blast radius (when the slices build, not this PR)

- `shared`: `+schemas/dataset.ts`; `schemas/connection.ts:9` (+2 kinds);
  `catalog/connection-config.ts:341,365`; `+catalog/copy-activity-config.ts`;
  `catalog/registry.ts:73` (+`copy`, +`lookup`); `catalog/types.ts` (+type constants);
  `schemas/version.ts:218` (`CATALOG_VERSION` bump); `schemas/pipeline.ts:377`
  (+`connectionIds?`); `engine/params.ts:1962` (identifier rule); portability
  `paths/envelope/content-form/import-result`.
- `server`: `+connectors/sqlite.ts`, `+connectors/postgres.ts`, `+connectors/copy/*` (readers,
  writers, coercion, the pump); `connectors/types.ts:223` (+optional sink args);
  `connectors/registry.ts:28`; `run/executor.ts:327,477` (two-sided resolve + side-labelled codes);
  `run/connection-readiness.ts`; `limits.ts` (+the `lookup` row cap); `+repo/datasets.ts`,
  `+routes/datasets.ts`; the six portability modules; a Drizzle migration for `datasets`.
- `web`: Manage › Datasets (list/detail), the M7 mapping panel, the copy node's dataset pickers.
- Tests: dataset repo/route/portability round-trip; coercion table (per row of §4.2); drift gate
  (all three arms); the identifier save-time refusal; a heterogeneous CSV→SQLite copy end to end;
  `lookup` truncation with a mutation proof that the marker goes red when the plumbing is removed.

## Non-goals

- **`transform` / data-flow authoring** (§6) — a separate runtime, deliberately not imitated.
- **Document / NoSQL stores** (§6) — needs a projection design, not a mapping design.
- **Dataset versioning, publish, an `active` pointer, or trigger binding** (§1.3) — the run-binding
  invariant does not require them, and the ticket's claim that it does is answered in §1.
- **A generic activity-output byte cap** (§3, §8) — a real pre-existing gap, wider than this spec.
- **Resource-level audit events for create/update** (§1.3) — no resource has them; datasets should
  not be the exception.
- **Incremental / watermark / CDC copies** — v1 copies are whole-source. Incremental needs run-scoped
  state that outlives a run, which nothing in the engine has today.
- **Parallel/partitioned copy** — v1 is one stream per copy node. `foreach` already gives per-item
  parallelism if a user wants to shard by file (`#4 A4b`).

## Evidence (probed, not argued)

- **Linked services already exist.** `shared/src/schemas/connection.ts:3` — *"a named worker binding
  (ADF 'Linked Service' analog)"*; `:9` the six kinds; `:41` the secret-requiring set.
- **One node binds ONE connection.** `shared/src/schemas/pipeline.ts:377`
  (`connectionId: z.string().min(1).optional()` — singular); `connectors/types.ts:61` (one
  `connectionConfig`), `:223` (`runActivity(ctx, secret, secretFields?)`); registry keyed by kind at
  `registry.ts:12`; one adapter serves many activities via `ctx.activityType` (`types.ts:52`).
- **Only pipelines are versioned.** `repo/connections.ts:155` mutates connections in place;
  immutability triggers exist for `pipeline_versions` only
  (`drizzle/migrations/0002_p1a_data_model.sql:68-84`); `RESOURCE_KINDS` is three
  (`portability/paths.ts:28`).
- **Run binding does not depend on resource versioning.** `db/schema.ts:271` —
  `runs.pipelineVersionId` NOT NULL, `onDelete: restrict`.
- **Publish is git-only.** `routes/pipelines.ts:274` refuses with no repo connected; `:289-294`
  refuses a version without git provenance; the active pointer is an event projection
  (`repo/workspace-events.ts:154`), not a column.
- **Substitution is a single inert pass in the REDUCER.** `engine/reduce.ts:1105`;
  `engine/params.ts:678-689` (no rescanning, `$${` literal), `:740` whole-value type preservation vs
  `:748` embedded string coercion; mode SSOT `engine/expr.ts:430`.
- **`validateDoc` is a WRITE-path gate, not advisory.** `engine/params.ts:1962`; funnelled by
  `createPipelineVersion`, git import and workspace-apply alike.
- **Nothing bounds an activity's output today.** `run/events.ts:49` parses and inserts;
  `engine/types.ts:774` `outputs: z.record(z.string(), z.unknown())`. The honest-truncation pattern
  exists only elsewhere (`limits.ts:11`, `errors.ts:107-121`).
- **Silent truncation is live in one adapter.** `workers/process-supervisor.ts:506` computes
  `truncated`; `connectors/agent.ts` never reads it (zero references) — **#1101**.
- **`fs` confinement + its deliberate schema gap.** `connectors/fs.ts:186` `resolveWithinRoots`;
  `catalog/connection-config.ts:62-68` (absolute check is server-only), `:395,405`
  (`connectionConfigAdvisory` is *"advisory, never a gate"*).
- **Streaming has an in-tree precedent.** `connectors/fs.ts:444` streams `file_copy` with
  `signal.aborted` checks at `:459` and no byte cap, deliberately.
- **A nested config renders as a JSON box.** `web/src/pages/pipeline/configForm.ts:166`
  `deriveConfigFields` returns `null` for a non-object-rooted schema (`:154-164`), consumed at
  `PipelineCanvas.tsx:2300`.
- **The failure taxonomy is three kinds.** `engine/types.ts:491`
  `FailureKindSchema = ['transient','permanent','cancelled']`; provider→engine narrowing at
  `connectors/error-kind.ts:28`; retry eligibility reads `kind` at `engine/reduce.ts:3159`.
- **`idempotent` is static in the catalog but PERSISTED per dispatch.** `catalog/types.ts:271`;
  `node.dispatched` written before the side effect (`executor.ts:855`), never recomputed
  (`docs/2026-07-13-p2-engine-spec.md:180-184`).
- **The git spec already anticipates datasets as files.**
  `2026-07-14-foundation-git-publish.md:12` — *"each pipeline / linked-service / dataset a separate
  file"*.
