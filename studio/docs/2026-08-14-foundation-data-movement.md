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
   question anyone asks. **BUILT — M6 slice B (#1149):** `node.dispatched.datasetAddresses`, minted
   per end by the store's own adapter (§7's as-built block for the three decisions it forced).
   **RENDERED — #1162:** durable was only half the control. Until the run monitor read it, the
   answer was reachable only by querying `run_events`, which is the state this paragraph calls
   unacceptable rather than a workaround. See the as-built block below.
2. **Editing a dataset can invalidate a pinned mapping.** **Control:** the dispatch-time drift gate
   (§7), which fails `permanent` with the offending columns named, plus **M9**, the dataset detail
   page listing the pipelines whose mappings reference it and flagging those that no longer agree.
   A dataset cannot cheaply know its consumers at save time, so this is a read-side affordance, not
   a write-side gate.

### As built — the address becomes readable (#1162)

Two surfaces, because they answer two different questions and neither subsumes the other.

**The node drill-in** (`web/src/pages/runs/NodeActivityPanel.tsx`) gains a **Data movement**
section naming each end the dispatch resolved to. It is fed by `deriveNodeActivity`, which folds
the address onto `NodeActivity` from `node.dispatched`. Three decisions that fell out of the fold
rather than being planned:

- **Last dispatch wins.** A retry can resolve somewhere the previous attempt did not — the dataset
  row is mutable, which is the whole reason §2.1 demands this record — so pairing attempt 1's
  target with attempt 2's outcome would answer "where did this data go" wrongly and confidently.
- **A retry re-open CLEARS it, a terminal event KEEPS it.** `node.retryDue`/`node.retryRequested`
  re-open the node without resolving anything, so the previous target must not stand over a node
  being sent elsewhere — the same argument `dropSpan` already makes one line above, for the same
  window. It is deliberately NOT part of `clearResult`, which runs at the head of every TERMINAL
  branch: putting it there would blank the address of precisely the settled copies whose
  destination anyone reads. Both directions are pinned, and both were mutation-proven.
- **Presence-gated on the fact, not on the activity type.** The panel has no doc and cannot ask
  what kind a node is; it does not need to, because only a dataset-bound dispatch records one.

**The event feed** (`format.ts`'s `eventGloss`) glosses `source=`/`sink=` on a `node.dispatched`.
This is not redundant with the panel: the feed is the only surface that keeps the address **per
attempt**, which is exactly what the panel's last-dispatch-wins rule gives up. The gloss reads the
value through `DatasetAddressSchema.safeParse` rather than duck-typing it — every other field that
function reads is a string it checks inline, and a hand-rolled shape check here would be a second,
drifting authority on an address.

Both reuse `describeDatasetAddress`, the renderer the engine's own `DATASET_SELF_COPY` refusal
already uses, so a refusal and a run log cannot drift into two spellings of one address.
`storeIdentity` is shown nowhere: it is a comparison token that identifies a store (a `dev:ino` for
a file, a cluster/database/primary-or-standby triple for postgres since #1193), it does not address one, and beside
a path or a host it would read as part of it.

**Still open on #1162** — items 2 (a `query` end has no comparable describe object), 3 (the
actual-store `NOT NULL` pre-flight, a stated behaviour break) and 4 (lifting the sink describe
policy out of `sqlite.ts`). This slice is item 1 only. The dataset-detail direction — which
pipelines reference this dataset — remains **M9**, and the panel deliberately does not link to it.

### As built — M9 (#1185): which pipelines reference this dataset

§2.1's consequence-2 control is now both halves: the dispatch gate (M6 slice A) and the read-side
affordance this row always named. `GET /api/datasets/:id/references` walks the owner's pipelines for
`copy` nodes bound to the dataset, and `Manage › Datasets › <id>` renders them with a per-reference
verdict. Four decisions the section could not have settled in advance:

**① The candidate-version set is a BOUND, and it is stated on the page.** Not every version is
walked — `latest ∪ active-published (git mode) ∪ trigger-pinned`, which are the three ways a version
fires on its own. `latest` is what a DB-only workspace binds to and what an author edits against;
`active` is what a GIT-mode workspace binds to instead (`routes/triggers.ts`'s `resolveBindToActive`),
so omitting it would answer "nothing references this" over precisely the version that runs; `trigger`
is needed because a trigger records `pipelineVersionId` ONCE at creation and can lag both. This is
where it diverges from `readyVersionResourceIds`, which walks EVERY owned version — that one feeds a
gate, where missing a dispatchable version is a correctness fault, and this is a read surface where
two hundred versions of one pipeline buries the answer. The case given up is a rerun-from-failed of an
older version, and it is not left unprotected: §7's gate refuses it `permanent`, naming the column.

**② One classifier, two surfaces.** The M8 authoring panel and this page both read a mapping against
a dataset's DECLARED columns, and two hand-written readings of one advisory is the drift
`copy-automap.ts` names three times. `datamove/mapping-agreement.ts` now owns the row projection and
the NOT NULL/nullable split of `notWritten`, and the panel was moved onto it in the same change.

**③ The mapping is PROJECTED, not re-parsed.** `CopyMappingSchema.safeParse` on a stored
`Node.config.mapping` is a recorded rejected alternative (`catalog/copy-config.ts`) — it is
`.strict()` with a required `type`, so it refuses far more than the cross-row rules the #444 write
gate admitted, and would report a pinned, runnable mapping as broken. `unreadable` is therefore
reserved for a mapping that is absent or is not an array, and it is a THIRD state that never folds
into `agrees` (an unknown printed as agreement manufactures reassurance out of an absent fact).

**④ A `${}` dataset end is NAMED, not dropped.** `Node.datasetIds` may hold an expression whose value
is only known at dispatch, so such a node may well address this dataset. Reporting it as a caveat is
what stops an empty reference list reading as "this dataset is unused".

Ends come from the CATALOG (`entry.datasetKinds`), not from the presence of `Node.datasetIds` — a
stray `datasetIds` on an activity that declares none is accepted by the write gate and has no mapping
to read, so presence-gating would report an `unreadable` copy that does not exist; and
`datasetKinds.sink` is already optional for M12's `lookup`.

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

**As built — M10 slice 1 (#1189): what a `postgres` connection actually accepts.**

The key list above stands. Three things it did not settle were settled by MEASURING `pg@8.23.0`
against a real `postgres:17`, and each changed the shape of the code rather than merely confirming
it.

**(1) `sslmode`'s vocabulary is NARROWER than libpq's, and it is not a passthrough.** Measured: a
`pg` `Client` **silently ignores an `sslmode` key on its options object** — `new Client({ ...,
sslmode: 'require' })` connects in PLAINTEXT and reports success, because `sslmode` is a
connection-URL concept only `pg-connection-string` parses. Forwarding the operator's string would
therefore tell someone who asked for TLS that their unencrypted connection was fine. The adapter
maps by hand instead (`connectors/postgres.ts`'s `sslOptionFor`), over three values:

| `sslmode`     | `pg`'s `ssl`                    | means                                                 |
| ------------- | ------------------------------- | ----------------------------------------------------- |
| `disable`     | `false`                         | plaintext, asked for explicitly                       |
| `require`     | `{ rejectUnauthorized: false }` | encrypted, peer NOT verified (libpq's meaning)        |
| `verify-full` | `{ rejectUnauthorized: true }`  | encrypted and verified against the system trust store |

`prefer` and `allow` are omitted: they mean "TLS if offered, plaintext otherwise", a downgrade an
attacker forces by answering "no SSL here", and a setting whose failure mode is invisible plaintext
is not one this schema should be able to express. **`verify-ca` is omitted as a SPEC GAP rather than
a preference** — the key list above has no `sslRootCert`, so there is nowhere to put a private CA,
and a system-trust-only `verify-ca` would differ from `verify-full` only by dropping hostname
verification. Wanting a private CA means this table owes the key first.

There is **no default**. #473's rule — an absent fact must never be manufactured as a benign one —
binds hardest on a transport-security setting, and here both candidate defaults are wrong: `pg`'s
own default is `ssl: false`, so silence would mean plaintext, while defaulting to `verify-full`
would fail every local dev server with an error naming nothing the operator set.

**(2) Every identity field is REQUIRED, because `pg` fills the gaps from the environment.**
Measured: an option that is `undefined` **or an empty string** falls back to `PGHOST`, `PGPORT`,
`PGUSER`, `PGDATABASE` and `PGPASSWORD`, and an absent `ssl` falls back to `PGSSLMODE`. A connection
missing its `host` therefore does not fail — it reaches whatever the studio server process happens
to have in its environment, differently on every machine; and a connection with no bound secret
would authenticate with `PGPASSWORD`, a credential nothing in the product recorded. So the schema
requires them, the adapter refuses a `null` **or empty** secret before building a client, and
`clientOptionsFor` populates every key rather than letting the driver infer one.

**(2b) `statementTimeoutMs` arms TWO timers, because either alone leaves a way to hang.** Measured
with `select pg_sleep(5)` against a 600ms budget: `statement_timeout` is a SERVER-side startup
parameter and cancelled at 623ms (SQLSTATE `57014`) — but only because the server chose to honour
it, which a tarpit or a proxy need not; `query_timeout` is a CLIENT-side timer and gave up at 617ms
regardless. `connectTimeoutMs` does not cover the gap: `pg` arms that timer during `_connect` and
clears it once the session is ready, so a host that completes the handshake quickly and then goes
silent would leave a probe neither resolving nor rejecting. Both are set from the one operator-facing
`statementTimeoutMs`, because "how long may one statement take" is one question, not two.

**(3) The non-overridable boundary is wider than `sqlite`'s.** `postgres` is the first kind where a
per-dispatch `Connection.parameters` override could move a DECRYPTED CREDENTIAL, so `host`, `port`,
`database`, `user` and `sslmode` all join `CONNECTION_NON_OVERRIDABLE_CONFIG_KEYS`; only the two
timeouts stay tunable. The rule reads as one sentence — a postgres connection's identity and its
transport are fixed by whoever bound the credential — and `user` is closed along with the rest on
that map's own stated asymmetry: closing a key with no consumer costs one entry, and re-opening one
later is a change in the permissive direction.

**`DATASET_CONNECTION_KINDS` is deliberately UNCHANGED by slice 1.** No `table` or `query` dataset
may name a postgres connection until slice 2 (#1190) ships the reader, in the same commit. Listing a
store there is what lets an operator author a dataset against it — the form stops warning and the
row saves clean — so opening it early would mean a dataset that can only fail at dispatch, the trap
§12's M5 row was split four ways to avoid. The existing `DATASET_CONNECTION_MISMATCH` dispatch gate
refuses the binding meanwhile, so holding it shut costs nothing and moves the refusal to where the
dataset is authored.

**As built — M10 slice 2 (#1190): what the postgres READER actually does.**

`DATASET_CONNECTION_KINDS` now lists `postgres` for `table` and `query`, in the same commit as the
reader, as slice 1 promised. Four things were settled by MEASURING `pg@8.23.0` against `postgres:17`
rather than by reasoning, and each changed the code.

**(1) A NAIVE TIMESTAMP IS A SILENT, MACHINE-DEPENDENT CORRUPTION under `pg`'s default parser.**
`timestamp without time zone` and `date` carry no zone, so there is no instant in them to recover —
but `pg` builds a `Date` by reading the text as LOCAL time. Measured, one row holding
`2026-07-15 13:45:00`:

| process `TZ`       | `pg`'s default parse       |
| ------------------ | -------------------------- |
| `UTC`              | `2026-07-15T13:45:00.000Z` |
| `Europe/London`    | `2026-07-15T12:45:00.000Z` |
| `America/New_York` | `2026-07-15T17:45:00.000Z` |

`coerce.ts` then renders a `Date` with `toISOString()`, i.e. in UTC, so the same source row copies
DIFFERENT TEXT depending on where the studio server happens to run — silently, and reading as
success. `date` is worse than a shift: measured in `Europe/London`, `2026-07-15` parses to
`2026-07-14T23:00:00.000Z`, so the DAY moves backwards for every process east of UTC.

This is #473's rule in a new place — an absent fact (the zone) must never be manufactured as a
benign one (the server's) — so both OIDs are re-parsed as UTC. The override is PER-CLIENT and never
`pg.types.setTypeParser`, which is process-global: measured, a second `Client` built without the
option still receives a `Date`, so nothing else in the process is affected. `timestamptz` is
deliberately NOT overridden — it names a real instant, and it measured identically under all three
zones. Values with no `Date` at all (`infinity`, `-infinity`, BC dates) are handed back as
postgres' own text, where `coerce.ts` already has an outcome: a `string` target copies the store's
spelling, a `date`/`timestamp` target refuses.

**How the property is HELD, not merely measured once.** The four-zone sweep — `UTC`,
`Europe/London`, `America/New_York`, `Asia/Tokyo`, all green, and the override removed reds it under
`Asia/Tokyo` — was a MANUAL measurement during the slice, and nothing re-runs it. The obvious guard
does not suffice either: on a UTC runner `pg`'s local-time parse and ours COINCIDE, so the live
TZ-invariance test would stay green with the fix removed. Two things keep it honest instead. (a) An
OFFLINE test pins the WIRING — both naive OIDs resolve to the UTC parser, `timestamptz` does not —
which reds under any zone and without a server. (b) The CI `Test` step pins `TZ: Asia/Tokyo`, so the
live half runs somewhere the two parses actually differ.

**(2) A SMUGGLED STATEMENT REALLY EXECUTES, and the wrap plus a read-only transaction are what stop
it.** Measured: `DECLARE "c" NO SCROLL CURSOR FOR select 1; drop table victim` raises **no error** —
the `;` terminates the DECLARE and the second statement runs (it survived the probe only because the
probe rolled back). Two independent guards, in the order the ladder runs them:

- `describeSource` wraps the statement as `SELECT * FROM (<sql>) "__studio_src" LIMIT 0`, and a
  subquery cannot contain a second statement (`syntax error at or near ";"`) nor a data-modifying
  CTE (`WITH clause containing a data-modifying statement must be at the top level`). Postgres
  independently refuses `DECLARE CURSOR ... WITH (data-modifying)` with `0A000`. Because `copy.ts`
  calls `describeSource` BEFORE `readBatches`, this runs first and a smuggle never reaches a cursor.
- The read is wrapped in `BEGIN READ ONLY`, under which the same smuggle fails with SQLSTATE `25006`,
  `cannot execute DROP TABLE in a read-only transaction`.

**Stated so the claim is not over-read:** read-only is a TRANSACTION property, not a sandbox. It
refuses DDL and DML; it does not constrain a `SELECT` that calls a VOLATILE or SECURITY DEFINER
function. The claim here is exactly what was measured.

**(3) A trailing `;` is REFUSED, not stripped.** Measured, the wrap turns `select 1;` into a bare
`syntax error at or near ";"` — a true statement naming nothing the operator can act on. Stripping
was rejected because it would mean the SQL that runs is not the SQL the operator saved, and it would
only ever fix the LAST separator (`select 1; select 2` reaches the same error either way). So the
reader refuses it with a sentence. Named `parameters` were refused alongside it, for a separate
measured reason: `where a = :id` reaches postgres as SQLSTATE `42601`, because `pg` has no named
parameters at all and binds positionally as `$1`.

**AMENDED BY #1194 — named parameters are now REWRITTEN, not refused.** The refusal was correct for
slice 2 (rewriting `:name` is not safe by regex, because a `:` inside a string literal must not be
rewritten) but it left one dataset config meaning something on sqlite and nothing on postgres, which
is the opposite of what a dataset abstraction is for. `:name` is now the PORTABLE authoring style and
each store binds it in its own: sqlite by name, postgres by rewriting to `$n` at dispatch through a
postgres-aware LEXER (`connectors/postgres-named-parameters.ts`), never a regex. §8 is untouched — the
values still leave as bind parameters and never enter the statement text; what is translated is the
placeholder spelling. Every lexical case was measured on `postgres:17` and is pinned in that module's
suite: `''` and backslash escapes, dollar quoting plain and tagged, quoted identifiers, NESTED block
comments, a `--` comment terminated by a bare CR, the `::` cast, array slices, and `$` as an
IDENTIFIER character (`a$$b` and `a$1` are names, not quotes or placeholders). Three decisions worth
carrying: an UNDECLARED `:name` is left byte-identical, because postgres has valid syntax in which a
`:` is not a parameter and refusing on sight would be a gate parsing an operator's SQL badly, which
§7 ② forbids; an UNUSED declared parameter is dropped rather than refused, matching better-sqlite3's
measured behaviour, because a postgres-only refusal would re-break the portability this closes; and a
pre-existing positional `$n` alongside declared names IS refused `permanent`, because the rewrite
appends `$1..$k` and would otherwise bind our value to the operator's own placeholder — silent
corruption, the one outcome here worth a refusal.

**(4) Reading uses a SERVER-SIDE CURSOR, with no new dependency.** `DECLARE` + `FETCH FORWARD n` is
plain SQL; measured at 4, 4, 2, 0 rows over a 10-row table with a 4-row batch, with the field list
still present on the final empty fetch. A plain `client.query` buffers the whole result before
yielding a row; `LIMIT`/`OFFSET` paging reads a new snapshot per page and re-scans from the top.
`pg-cursor`/`pg-query-stream` would do this properly but are separate packages that are not
installed. One consequence, stated rather than discovered: `statementTimeoutMs` arms both pg timers
per STATEMENT, and each `FETCH` is a statement — so it bounds ONE BATCH, not the whole copy, and a
slow first batch on an unindexed scan is the shape that trips it (SQLSTATE `57014`, classified
`transient`).

**The coercion bound did NOT change, and that is the measured answer rather than an omission.**
`coerce.ts`'s int64 bound is a SINK fact and the sink is still sqlite. Measured: `pg` returns `int8`
and `numeric` as JS **strings**, and `coerce.ts` already routes a string integer through
`BigInt(text)`, which is exact — so an `int8` boundary value survives with no precision loss, pinned
by a live test. The docblock's own worry — "if M10 binds `integer` to a NARROWER physical type" — is
a question for slice 3, where postgres becomes a sink and `integer` must bind to `int4` or `int8`.

**What slice 2 does NOT do**, so the split is legible: postgres is a SOURCE only. `copy`'s
`sinkConnectionKinds` stays `['sqlite']`, and §7's row 3, the `query` self-copy residual and the
`storeIdentity` hole all move to slice 3 (#1193) because each is unreachable while that is true —
see §7's amended ③ and residual for the arguments.

**§12's dependency check is DISCHARGED, not deferred.** `pg@8.23.0` is MIT and **pure JavaScript** —
`pg-native` is an optional peer and is deliberately not installed, so the "second native/TLS surface"
the dependency table warns about does not materialise. Every transitive dependency is MIT or ISC and
the `audit:licenses` gate passes. The single-binary concern is moot in any case:
`2026-07-30-packaging-and-updates.md` already assumes a bundled Node runtime throughout.

**As built — M10 slice 3a (#1196): what the postgres WRITER actually does.**

`copy`'s `sinkConnectionKinds` is now `['sqlite', 'postgres']`, opened in the same commit as
`postgres-sink.ts` exactly as slice 2 opened the source half alongside its reader. Postgres is a
source AND a sink, so `copy` is a real mesh for the first time: three source stores × two sink
stores. Five things were settled by MEASURING, and each changed the code.

**(1) THE SINK DIRECTION HAD THE SAME TZ CORRUPTION SLICE 2 FOUND IN THE READ DIRECTION, and the
existing coercion is what already prevents it.** `pg` serializes a JS `Date` CLIENT-side, in the
process's own zone. Measured, the instant `2026-07-15T13:45:00Z` written into a
`timestamp without time zone`:

| bound as         | `TZ=Europe/London`    | `TZ=Asia/Tokyo`       |
| ---------------- | --------------------- | --------------------- |
| a `Date`         | `2026-07-15 14:45:00` | `2026-07-15 22:45:00` |
| `.toISOString()` | `2026-07-15 13:45:00` | `2026-07-15 13:45:00` |

For `23:30:00Z` the `Date` bind moves the **day** forward in a `date` column under both zones.
`timestamptz` is correct under every bind, because it names a real instant — the same asymmetry the
reader found.

The writer needs no `Date` arm to fix this, and that is the finding rather than an omission:
`CoercedValue` has no `Date` member and `coerceValue` renders every instant to ISO text before it
becomes one, so a `Date` cannot reach the bind seam. The shared coercion is what makes this sink
zone-honest. What the slice added is the PIN — a live test asserting the round trip under
`TZ=Asia/Tokyo`, which reds when the writer is mutated to hand `pg` the `Date` instead. Without it
a later "optimisation" that skipped the render would be a silent, machine-dependent corruption
with no test in its way.

**(2) THE SINK IS DESCRIBED THROUGH `to_regclass`, NOT `information_schema`, so the gate and the
write cannot mean different tables.** `information_schema.columns` requires an explicit
`table_schema` and does not consult `search_path`, so it cannot answer for a `table` dataset that
names a bare table — and assuming `public` would describe one relation while an unqualified INSERT
wrote to another. Measured with `search_path = 's_b','public'` and a `dup` table in each:
`to_regclass('"dup"')` resolves to `s_b.dup`, which is exactly where `INSERT INTO "dup"` lands.
Because both are built from ONE string, agreement is structural rather than hoped for. The name is
a BOUND parameter: measured, `to_regclass('"public"."plain"; drop table public.plain')` returns
NULL, so a name that does not parse is simply not a relation and nothing executes.

It also yields facts SQLite hid. A generated column is absent from `pragma_table_info` entirely, so
the sqlite sink could only report one as "absent from the sink" — "imprecise but never wrong about
the outcome", in its own words. `pg_attribute` carries `attgenerated` and `attidentity`, so the
postgres rung names them: *"'gen' is a generated column"*. Same rung, better sentence.

**(3) THE LOCK STRENGTH DEPENDS ON THE MODE, and `ROW EXCLUSIVE` alone would have been a silent
correctness hole.** Both modes lock before the §7 gate reads, closing the `ALTER TABLE` TOCTOU that
`begin immediate` closes for sqlite. But `ROW EXCLUSIVE` is the lock an ordinary INSERT already
holds, so it does not exclude a second copy: two concurrent `overwrite` copies would each DELETE
and each INSERT, leaving the table holding the UNION of both and reporting success to each — and
§9's `COPY_CONCURRENCY` makes that reachable. `overwrite` therefore takes `EXCLUSIVE`, which
serialises writers and is the guarantee sqlite gets for free from its single writer. `append` keeps
the weaker lock deliberately: two appends interleaving is what append MEANS, and `EXCLUSIVE` there
would block the operator's own application writes for the length of a long copy for no correctness
gain.

`DELETE` rather than `TRUNCATE` for `overwrite`, for two reasons beyond matching sqlite: `TRUNCATE`
needs `ACCESS EXCLUSIVE` (it would block readers too), and it REFUSES outright on a table another
references by foreign key unless given `CASCADE`, where `DELETE` honours the operator's own
`ON DELETE` rules. The row-by-row cost is #1126's, already filed against the sqlite sink.

**(4) THE BIND-PARAMETER CEILING IS 65535 AND EXCEEDING IT DOES NOT FAIL CLEANLY.** Measured, 65535
parameters are accepted; 65538 raises `08P01 bind message has 2 parameter formats but 0 parameters`
— the count wraps in a 16-bit field, so the wire message is GARBLED rather than refused, and the
error names neither the limit nor the statement. So the writer chunks each multi-row INSERT at
`floor(65535 / columnCount)` rows, computed from the mapping width rather than left to the pump's
row batching, which knows nothing about how wide the mapping is. A 70-column mapping tips over at
937 rows, well inside `COPY_BATCH_ROWS`.

`undefined` is refused rather than bound, and that rung is not inherited on faith: measured, `pg`
binds `undefined` as NULL and the insert succeeds — #473's shape exactly. Everything else in
`SinkValue` binds as it stands, including a `bigint` (2^53+1 round-trips into `int8` exactly) and a
`Uint8Array` (byte for byte through `bytea`); sqlite needed a boolean arm only because
`better-sqlite3` throws on one.

**(5) §7's ROW 3 RESTED ON A WRONG PREMISE, and the `query` self-copy residual is not destructive.**
Both were re-measured rather than expired silently when this slice opened the sink list.

Slice 2 measured `insert into t(n int4) select c` where `c` is `text` raising `42804`, and inferred
that postgres-as-sink rejects on TYPE. It does not on the path this writer uses. A bound parameter
is untyped text, so postgres coerces per VALUE: measured, `'123'` into `int4` **succeeds** (→ 123)
while `'abc'` raises `22P02` and `3000000000` raises `22003`. That is SQLite's behaviour, so §7 ③'s
argument for not building row 3 — a per-type refusal would break exactly the working copies M7's
all-text CSV columns produce — applies here unchanged. Row 3 is not merely still deferred; the
reason it was deferred for sqlite is the reason it stays deferred for postgres.

And the residual is a wasteful no-op rather than a data-loss path. Measured: the sink's `EXCLUSIVE`
lock does not conflict with the source cursor's `ACCESS SHARE`, and under READ COMMITTED the source
reads a snapshot taken before the sink's UNCOMMITTED `DELETE` — so a `query` reading the very table
its sink overwrites read all five rows, wrote them back, and committed with the table intact. It
stays on #1193 as a REACHABLE case rather than an unreachable one, and it is still not
guess-refused: §7 ② is explicit that a `permanent` refusal reached by parsing an operator's SQL is
the one direction a gate must never fail in.

**What slice 3a does NOT do — `storeIdentity`, SINCE CLOSED by slice 3b (#1193).** Slice 3a left
`storeIdentity` at `null` for postgres on the reasoning that `ConnectorAdapter.resolveDatasetAddress`
receives no SECRET and a cluster's identity needs a session. The seam's half of that was wrong:
`executor.ts` resolves the source secret AND `sinkSecret` in the same pre-flight, before either
address is asked for — the sink's ADAPTER never runs, but its credential is in hand. Slice 3b gives
the seam a `secret`; see §7's as-built block below. `datasetKinds.sink` still excludes `delimited`:
there is no CSV writer, so a file remains something a copy can read and not something it can write.

**The structural change this forced, recorded because it is not visible from the ticket.** A second
sink means every source adapter must reach both writers, and `sqlite.ts` importing `postgres.ts`
while `postgres.ts` imports `sqlite.ts` is a cycle. Four leaf modules resolve it —
`postgres-session.ts`, `sqlite-store.ts`, `sqlite-sink.ts` and `sink-columns.ts` — so the writers no
longer live inside the adapters, and `copy-sink.ts` can dispatch on sink kind without importing an
adapter back. That is the registry `copy.ts`'s own docblock deferred until "a second SINK exists",
and it carries ONE shared `refuseSink` derived from the catalog, replacing three hand-written
sentences around a hardcoded `'sqlite'`.

---

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

**Three corrections from M7 slice 1, which built the `delimited` row** (#1163), recorded here on the
M4 precedent above rather than left to disagree with the shipped schema:

- **`quote` and `encoding` are DEFAULTED too**, to `"` and `utf-8`, though this table annotated a
  default only on `delimiter`. The test applied was not "is a default convenient" but "is a wrong
  guess VISIBLE": a file that declares neither is overwhelmingly RFC 4180 UTF-8, and getting either
  wrong produces mangled text an operator sees at once, not a plausible wrong value they never do.
- **`header` is REQUIRED, with no default**, because it fails that test in both directions. Defaulted
  true it eats row 1 of a headerless file and then names every column after a data value; defaulted
  false it turns the header into a data row. Both SUCCEED and write wrong data. It is also the exact
  shape of the M4 correction directly above: `configForm.ts` treats a defaulted field as optional and
  an unchecked optional box omits its key, so a defaulted `header` could not be set to `false`
  distinguishably from "not set" at all — which is how `readonly` became `writable`.
- **`encoding` is a CLOSED set** — `utf-8`, `utf-16le`, `utf-16be`, `windows-1252` — and the last is
  named for what it is. Measured on node v25.9.0: `new TextDecoder('latin1').encoding` is
  `windows-1252`, and so is `ascii`'s. Offering `latin1` would promise ISO-8859-1's C1 controls and
  deliver `€` for `0x80`; offering `ascii` would promise a 7-bit refusal that never comes. An
  unrecognised label is refused here rather than reaching `TextDecoder` as a raw `RangeError` that
  no connector error maps.

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

**As built (M5 slice 4a, #1130) — two things this section did not settle, decided in code.**

**① The node's connection pair and the dataset's own `connectionId` MUST AGREE.** §1 was written
before datasets existed, so it never said what happens when a node bound to store Y carries a dataset
declaring `users` in store X. Left unchecked, the copy reads `users` out of **Y**: the right shape,
the wrong data, nothing thrown. Refused `permanent` as `DATASET_CONNECTION_MISMATCH`, per side, and
refused rather than resolved in either direction — neither ref is subordinate to the other, and
guessing is what produces the silent-wrong run. The node's binding stays what the ADAPTER runs on
(it is what `connection-readiness.ts` gates statically and what the secret side-channel decrypts);
the dataset is made to agree with it, not to replace it. **Its cost, stated:** one physical file
reachable through both a read-only and a `writable` connection (§2.6) needs two dataset rows, one per
connection. That is the price of the pair being checkable at all.

**② `datasetKinds.sink` is OPTIONAL.** M12's `lookup` reads a source only, which both
`schemas/pipeline.ts` and `engine/params.ts` already anticipated in prose; a required `sink` here
would have to be widened by the very ticket those notes name. A DECLARED list must still be
non-empty, and a declared `sink` implies `sinkConnectionKinds` — a sink dataset with no sink
connection names a store that does not exist.

**Also decided: source and sink may not name the SAME dataset** (`DATASET_SELF_COPY`, unlabelled by
side — the pair is at fault, not an end). §4's atomic-swap discipline DELETEs inside the write
transaction while the reader is still streaming, so a self-copy destroys the rows it was asked to
move. **M6 slice B (#1149) closed the residual this sentence used to state.** The id check stays — it is
cheaper, needs no store I/O, and names the ref an operator has to change — and the resolved ADDRESS
(§2.1, §7's as-built block) now refuses the case it could not see: two DIFFERENT dataset rows that
resolve to one physical table. One `code` for both, because it is one fault.

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

**`bytesRead` is a DEFINITION, not a derivation, so it is written down here
rather than left to each source to invent.** It is the size of the source values
**as measured at the copy boundary** — every value the reader materialised for a
row, including columns the mapping ignores (they were read regardless), with a
string charged its UTF-8 length and a BLOB its byte length. It is not the store's
on-disk size and not a wire size: M7's CSV source will read a rather different
number of FILE bytes (delimiters, quoting, encoding) than it counts in parsed
values, and both numbers are honest about different things. `fs.ts:353`'s
`bytesWritten` is the in-tree precedent for "bytes of the payload moved". One
detail with an expiry date: SQLite charges an `INTEGER` at most 8 bytes and a
`REAL` exactly 8, so v1 counts 8 for both — M10's arbitrary-precision `numeric`
is where that constant has to become a per-source measurement.

**`truncated` is REQUIRED and must be honest.** The codebase has receipts both ways:

- the honest pattern — `shared/src/schemas/zod-issues.ts` (`ISSUE_LIST_CAP` +
  `summarizeIssueList`), `server/src/errors.ts`'s `capIssues`: a cap whose truncation is
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
(`repo/run-diagnostics.ts:48`). So `lookup` declares both, in `server/src/limits.ts` beside the other
data-movement bounds (`COPY_BATCH_ROWS`, `DELIMITED_MAX_*`). **Amended by #1183:** they no longer
sit beside `ISSUE_LIST_CAP`, which moved to `shared/src/schemas/zod-issues.ts` when
`formatZodIssues` — in `shared`, which cannot import from `server` — became its third consumer.
The lookup caps have no `shared` consumer, so `server/src/limits.ts` stays their home:

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

**As built (#1176) — the mapping's cross-row rules are enforced at the WRITE gate, not only on the canvas.**

Three rules hold over the mapping as a whole rather than over any one field: a copy that maps no
columns, two rows writing one sink column (silent LAST-WINS into the operator's table, and perfectly
valid SQL), and a row carrying both `source` and `expression`. They were declared in
`catalog/copy-config.ts` and therefore reached by exactly two things — the canvas Apply pre-check,
whose own docblock calls itself *"a UX PRE-CHECK, never the gate"*, and the adapter's dispatch parse.
`validateDoc` is what `createPipelineVersion` funnels every mint through, **git import and a direct
POST included**, and for a `copy` node it ran the §8 identifier rule alone. So a doc arriving from a
repo could carry any of the three, validate clean, and fail hours later when a scheduled copy ran.

The three are now declared ONCE (`copyMappingShapeIssues`) and replayed by both, so a rule the canvas
enforces is a rule the gate enforces. Per-FIELD types deliberately did NOT move: the canvas schema and
the adapter each refuse a type error legibly, so the gate has nothing to add. Neither did a
**non-array** `mapping` — it may be a whole-value `${}` resolving to an array at dispatch, and
refusing it at save time would refuse a working pipeline.

**Behaviour change:** a git import of a repo holding an already-bad copy doc is now REFUSED at import
rather than imported and failed at run time.

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

**As built (M6 slice A, #1148) — the SOURCE half, and one row this section could not have known.**

Rows 1, 4 and 5 now gate at dispatch through a `CopyIo.describeSource` seam that reports the source's
actual column names **without reading a row** (`Statement.columns()` for `sqlite`; M7's `delimited`
implements it from the CSV header row). Row 2 was already built by M5 slice 2 and stays exactly where
it is — inside `begin immediate`, so the sink gate has no TOCTOU against its own write.

Three things this section did not settle, decided against measurement:

**① The pump's check STAYS, and is not the gate's duplicate.** Before M6 the only source-column check
resolved from the FIRST ROW's key set, which meant it fired from inside the sink's open write
transaction and **did not fire at all against an empty source** — a mapping naming a column the store
does not have reported SUCCESS over 0 rows. The gate is the early, well-named refusal; the pump
remains the binding-time truth that has actually seen the rows, and catches a source that changed
between being described and being read. They share ONE predicate (`datamove/schema-drift.ts`) rather
than agreeing by coincidence.

**② A duplicated result column is collapsed before the gate sees it.** `SELECT i, i` reports
`['i','i']` from `columns()` while the row it yields is an object carrying `i` ONCE. Left
uncollapsed, the gate would refuse `ambiguous_source_column` for a copy the pump binds without
complaint — a `permanent` refusal of working work, which is the one direction a gate must never fail
in.

**③ Row 3 (type incompatibility) is deliberately NOT built for `sqlite`, and the reason is a
measurement, not an omission.** This table's `permanent` verdict assumes a declared type mismatch is
a fact about the TYPES. Under SQLite it is a fact about each VALUE: a STRICT table coerces by the
usual affinity rules and rejects only what cannot be converted **losslessly**. Measured on
better-sqlite3 12.11.1 / SQLite 3.53.2 — `INSERT` of `'123'` into a STRICT `INTEGER` column
**succeeds** (`typeof` `integer`), while `'abc'` is rejected (`cannot store TEXT value in INTEGER
column`). A per-type `permanent` refusal would therefore break working copies, and would break
exactly M7's shape: every CSV column is text, and most of them are meant for numeric sink columns.
On a NON-strict table nothing is rejected at all, so there is no refusal to make. Row 3 becomes
honest where the WRITING side rejects on TYPE; it is deferred rather than approximated here.

**M10 slice 2 (#1190) measured that and did NOT build it, because the premise is about the SINK.**
Postgres as a sink really does reject before any value is seen — measured on `postgres:17`, `insert
into tgt(n int4) select c` where `c` is `text` raises SQLSTATE `42804` naming both types. But slice
2 makes postgres a SOURCE only (`copy`'s `sinkConnectionKinds` stays `['sqlite']`), so the sink is
still the per-VALUE store this paragraph describes, and a type gate over a postgres source into a
sqlite sink would refuse exactly the working copies ③ declined to break. It moved to **slice 3**,
with the sink, tracked as #1193 — which also records that `CopyIo.describeSource` returns names and
no types, so row 3 needs that seam widened first.

**M10 slice 3a (#1196) built the sink and found the premise WRONG, which is a stronger outcome than
another deferral.** Postgres-as-sink does NOT reject on type on the path the writer uses: a bound
parameter is untyped text, so postgres coerces per VALUE just as SQLite does. Measured on
`postgres:17` — `'123'` into an `int4` column **succeeds** (→ 123), `'abc'` raises `22P02` and
`3000000000` raises `22003`. The `42804` slice 2 measured comes from `insert ... select`, where the
source column carries a declared type; a `$n` parameter carries none. So this paragraph's argument
— that a per-type `permanent` refusal would break exactly the working copies M7's all-text CSV
columns produce — holds for postgres unchanged, and row 3 stays unbuilt for the same reason rather
than for a new one. Row 3 is therefore DECLINED on measured grounds rather than deferred, and needs no ticket to carry
it: two independent measurements (slice 2's `42804`, slice 3a's per-value coercion) say the refusal
it proposed would break working copies. Should it ever be revisited, `CopyIo.describeSource` returns
names and no types and would need widening first — recorded here so that prerequisite is not
rediscovered. #1193 closed with the `storeIdentity` hole alone (§7 ④). The harm it would have prevented under
`sqlite` is already prevented: the sink is one transaction that rolls back reporting
`partialWritePossible: false`, so an ungated type mismatch costs a wasted scan and a provably clean
store, not the mid-copy partial write §6.2 and this row exist to stop.

**As built (M6 slice B, #1149) — the resolved-address record and the refusal it unlocks.**

`node.dispatched` now carries `datasetAddresses`, minted by the store's own adapter through a new
`ConnectorAdapter.resolveDatasetAddress` seam and stamped BEFORE the durable dispatch event, so §2.1's
control is a fact in the log rather than a promise. Three decisions this section could not have
anticipated:

**① A PATH IS NOT AN IDENTITY, and the gap is a data-loss path rather than a nicety.**
`resolveWithinRoots` canonicalises the target's PARENT and joins the final component **as spelled**
(`connectors/confine.ts`), so on a case-insensitive filesystem — APFS, the operator's own Mac —
`data.db` and `Data.db` are two confined strings for ONE inode. Compared on the path alone, the
self-copy gate would have waved through precisely the pair it exists to refuse. The address therefore
carries a `storeIdentity` (`dev:ino` for a file-backed store) that is compared in preference to the
path; the path stays, because it is what answers "where did this data go" for a human. An
unobtainable identity is recorded as `null` and the comparison falls back to the path — never to a
refusal invented on a fact nobody established.

**② The seam is OPTIONAL on the adapter and REQUIRED at the point of use.** Six of the seven
adapters are not stores and a dataset means nothing to them, so the interface does not make them
implement it; the executor refuses a dataset-bound dispatch whose adapter omits it
(`DATASET_ADDRESS_UNSUPPORTED`). That is `describeSource`'s polarity above — a gate a store can
decline is not a gate — placed where it costs the non-stores nothing. **M7 inherits an obligation
from this:** `fs` becomes a store when `delimited` lands, and every `delimited` copy will refuse at
dispatch until it implements the seam.

**③ It is NOT folded into `CopyIo`, which also carries a store-specific describe.** The two run at
different times for different reasons: `describeSource` is ACTIVITY-time, supplied by the adapter
that is already running. This is DISPATCH-time and must be answerable for the SINK, whose adapter
never runs at all. Merging them by analogy would break both.

**The residual, stated so it is not mistaken for coverage.** A `query` dataset names no single
object, so its address's `object` is `null` and never matches. A query reading the very table its
sink overwrites, in one store, is therefore NOT refused. Deciding it means parsing the operator's SQL
to learn which relations it touches, and a `permanent` refusal reached by guessing is the one
direction ② above says a gate must never fail in. M10's postgres, whose driver can describe a
statement's source relations, is where it becomes answerable — measured in #1190, `explain (verbose,
format json)` does yield `Relation Name` and `Schema` for each relation a statement reads.

**Slice 2 did not take it, and the reason is a property of the CODE rather than of a list.**
`sameDatasetAddress` short-circuits on `kind`, so a postgres source can never match a sqlite sink on
any address, and slice 2 admits no other pairing.

**Slice 3a (#1196) made the pairing reachable, and MEASURED that it is not destructive.** With
postgres a sink, a `query` source can now read the very table its sink overwrites in one store. It
was probed rather than reasoned about: the sink's `EXCLUSIVE` lock does not conflict with the source
cursor's `ACCESS SHARE`, and under READ COMMITTED the source's snapshot predates the sink's
UNCOMMITTED `DELETE` — so the copy read all five rows, wrote them back, and committed with the table
intact. A wasteful no-op, not a data-loss path. That does not retire it: a no-op that reads as a
successful copy is still worth refusing, and a different isolation level or a partially-committing
future shape need not behave the same way. It stays on #1193 as a REACHABLE case, and is still not
guess-refused, because ② above forbids a `permanent` refusal reached by parsing an operator's SQL.

**④ The `storeIdentity` hole — CLOSED by slice 3b (#1193).** Slice 2 opened it and slice 3a made it
reachable: `resolvePostgresDatasetAddress` returned `storeIdentity: null`, so two connections naming
one cluster through different host spellings (`localhost` and `127.0.0.1`, a name and its CNAME)
compared only by the `store` string, disagreed, and a copy reading and overwriting ONE table was not
refused. The stated cause — "the seam receives no SECRET, because it must be answerable for the
SINK, whose adapter never runs and whose credential is therefore never resolved" — was FALSE in its
second clause and was false when written: `executor.ts` resolves both ends' secrets before it asks
for either address.

`ConnectorAdapter.resolveDatasetAddress` now takes a `secret` (each end its OWN — passing the
source's to the sink would send one server's password to another), and the postgres implementation
opens one session per end to answer two questions only a session can:

- `storeIdentity` = `<system_identifier>:<database oid>:<primary|standby>`. All three parts are
  load-bearing. `system_identifier` is cluster-unique and MEASURED readable by an ordinary
  unprivileged role. The database OID separates two databases in one cluster, which
  `nspname.relname` cannot. `pg_is_in_recovery()` separates a PRIMARY from a physical STANDBY,
  whose control file is a byte copy of its primary's and which therefore reports the same
  `system_identifier` and the same database OIDs — without it, `standby → primary`, an ordinary ETL
  shape, would be refused as a self-copy. (That byte-copy claim is REASONED from `pg_basebackup`'s
  mechanism, not measured; the part is included so the answer does not depend on it.)
- `object` = the CANONICAL `nspname.relname` from `to_regclass` on the QUOTED name. This half was
  not optional: `sameDatasetAddress` ends on `a.object !== null && a.object === b.object`, and
  `object` was `null` for every table dataset that did not declare a `schema` — which the schema
  makes optional, i.e. the majority spelling. Closing `storeIdentity` alone would have started
  refusing schema-QUALIFIED pairs and gone on missing unqualified ones. One seam limitation, one
  cause, one fix.

**Enrichment is BEST-EFFORT; only the CONNECT may refuse.** A connect failure dooms the copy and
propagates. A failure of either QUERY degrades to `null` and the address still resolves. sqlite's
opposite choice does not transfer: `resolveSqliteDatasetAddress` lets a `stat` failure propagate
because every way it can fail leaves the copy unable to proceed anyway. Not so here —
`pg_control_system()`'s execute privilege is a REVOCABLE ACL (public on a vanilla 17, measured) and
`to_regclass` raises `42501` for a role without `USAGE` on a schema. Neither code is transient, so
propagating would classify `permanent` and refuse EVERY copy against such a server, forever, while
a role that can `SELECT` and `INSERT` would have copied fine — ② 's forbidden direction, reached by
a different door.

**The cost, stated rather than discovered.** One session per dataset end is added to the pre-flight,
so a postgres-to-postgres copy opens four sessions across a dispatch where it opened two. They are
SEQUENTIAL and each closes in a `finally`, so peak concurrent sessions per node is unchanged at two.
The unbounded part is across NODES: pre-flight runs outside `executor.ts`'s `pLimit`, so N
concurrently dispatching copy nodes open N store sessions with no cap where the running phase is
capped. That is a pre-existing property of pre-flight which this makes matter more; it is filed as
#1200 rather than fixed here.

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

**As built (#1127) — the rule is about PROVENANCE, and one carve-out makes that explicit.**

Nothing above is retracted: every bullet is about a name reaching SQL from operator-authored text,
and all of them stand. What the section did not distinguish is a name that reaches SQL from the
**store itself**, and the sink implementation had been applying the config rule to both.

`writeSqliteDatasetRows` builds its INSERT column list from `pragma_table_info` on the confined
database file — the schema's own content, created by the operator's own DDL, never operator input to
this pipeline. Running it through the `SQL_IDENTIFIER_RE` refusal meant an ordinary sink table with a
column called `first name`, `total (£)` or `order-id` could not be a copy target at all, which is a
real gap against the any-to-any intent of `#993` and one CSV headers hit immediately. Those names are
now `"`-quoted with embedded quotes doubled (`quoteStoreIdentifier`) rather than refused.

**Table and schema names are unchanged and stay refused** — they come from a dataset's `config`, which
is exactly the operator-authored text this section is about.

The property that makes the carve-out safe is worth stating, because "we relaxed an identifier check"
deserves an argument under it: **a mapping's authored `sink` name never reaches SQL as written.**
`resolveSinkColumns` resolves it onto the store's own spelling of a column the store already has, or
refuses the mapping. So the set of names that can reach the statement is exactly the set the store
already has, and a relaxed quoting rule cannot widen it. That holds even for a mapping supplied
through a whole-value `${}`, which is why the save-time gate can leave that shape alone (#1176).

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
| **M5**  | The `copy` activity: catalog entry, coercion matrix (§6.2), the streaming pump, atomic-swap sink discipline (§4), `truncated`, batch progress ticks, `CATALOG_VERSION` bump (`schemas/version.ts:218`). SQLite→SQLite first | **SPLIT INTO FOUR, as this row anticipated** — slice 1 = the coercion matrix + the mapping declaration (#1122); slice 2 = the sink discipline (#1125); slice 3 = the pump, the counters incl. `truncated`, and the progress ticks (#1129); slice 4 = the DISPATCH seam, itself split THREE ways once built — 4a (#1130) dataset resolution into `ActivityContext` + the `onError:'null'` vs `nullable:false` refusal, 4b (#1134) the adapter, 4c (#1139) the catalog entry, the first populated `sinkConnectionKinds`/`datasetKinds`, §8's literal-only NODE gate, `CATALOG_VERSION` 23, and the four paired canvas pickers without which the entry would put an unbindable node on the canvas. **Slice 4 is the split's whole point:** nothing resolved `Node.datasetIds` into the executor until 4a, so a catalog entry landed alongside the pump would have been a user-visible activity that always fails at dispatch. **M5 is COMPLETE as of 4c**, with two knowing residuals: the mapping grid is a JSON textarea until §13/M8 builds an `objectList` control, and §9's `COPY_CONCURRENCY` has no consumer to slot into (#1140) |
| **M6**  | Dispatch-time drift gate (§7) + the resolved-address dispatch record (§2.1). **SPLIT IN TWO** — slice A (#1148) is the source half of §7: the `describeSource` seam, rows 1/4/5 gated before the first row moves, and the empty-source blind spot closed; row 3 deliberately deferred to M10 (see §7's as-built block). Slice B (#1149) is §2.1's resolved-address record + §3.1's physical-address self-copy refusal, which needs it — SHIPPED, with two knowing residuals: a `query` end has no comparable object (§7's as-built block), and the record is durable but not yet RENDERED on the run-detail page. The ticket's two folded-in sink-side items (the actual-store `NOT NULL` check, a stated behaviour break; lifting the sink describe policy out of `sqlite.ts`) are deferred with it                                                                                                                                                 |                                                                                                                                                                                                                                           |
| **M7**  | `delimited` dataset kind over the existing `fs` connection — **the first heterogeneous copy** (CSV → SQLite)                                                                                                                | the ticket that proves the spec                                                                                                                                                                                                           |
| **M8**  | The mapping authoring panel (§13). **SPLIT IN TWO** — slice 1 (#1169) is the `objectList` PRIMITIVE (§13's *"build it as a primitive rather than a copy-specific panel"*): the derived row control, which upgrades `copy.mapping` and `llm_call.tools`. Slice 2 is the copy-specific half — Auto-map, the explicit *unmapped* state and per-column expressions — all three of which need a sink-column seam that does not exist yet. See §13's as-built block                                                                                                                                                                                          | UI epic; e2e-gated                                                                                                                                                                                                                        |
| **M9**  | Dataset detail: referencing pipelines, flagged where mappings no longer agree (§2.1). **SHIPPED (#1185)** — `GET /api/datasets/:id/references` + `Manage › Datasets › <id>`; see §2.1's as-built block for the candidate-version bound, the shared classifier the M8 panel now also uses, and why `unreadable` is a third state | UI epic; e2e-gated                                                                                                                                                                                                                                   |
| **M10** | `postgres` kind — networked + credentialled, `SECRET_REQUIRING_CONNECTION_KINDS`, TLS. **SPLIT IN THREE**, as M5/M6/M8 were — slice 1 (#1189) is the CONNECTION half and moves NO data: the kind, its config, the `SECRET_REQUIRING_CONNECTION_KINDS` join §8 names a build step, the non-overridable-key boundary, a `pg`-backed `testConnection`, migration 0038's CHECK widening and `CATALOG_VERSION` 25. **SHIPPED**, with `DATASET_CONNECTION_KINDS` deliberately UNCHANGED — see §2.6's as-built block for that and for the three MEASURED `pg` behaviours that shaped it. Slice 2 (#1190) is the `CopyIo` reader — **SHIPPED**: it opens that binding in the same commit, adds `resolveDatasetAddress` (without which every postgres copy refuses at dispatch), re-parses naive `timestamp`/`date` as UTC to close a silent TZ-dependent corruption, guards the read with a subquery wrap plus `BEGIN READ ONLY`, and stands up the CI `postgres:17` service with a guard that makes a MISSING service red rather than a silent skip. §7's row 3 and the `query` self-copy residual were NOT taken and were re-assigned to slice 3 (#1193): both need postgres to be a SINK, which slice 2 is not — see §2.6's slice 2 as-built block and §7's amended ③. Slice 3 is the sink and the source × sink mesh — **SPLIT IN TWO**: slice 3a (#1196) is the WRITER and the mesh (`sinkConnectionKinds` `['sqlite','postgres']`, `CATALOG_VERSION` 27), and it re-measured both of slice 2's deferrals rather than expiring them silently — §7 row 3's premise turned out to be WRONG (a bound parameter coerces per VALUE) and the `query` self-copy residual measured as a wasteful no-op rather than destruction. It also forced the sink REGISTRY `copy.ts` deferred until "a second SINK exists", via four leaf extractions that break the adapter-imports-adapter cycle. Slice 3b (#1193) is **SHIPPED** and was the `storeIdentity` hole ALONE: row 3 and the `query` self-copy residual were both dispatched by slice 3a's re-measurement (row 3's premise was wrong; the residual is a wasteful no-op and stays deliberately un-guess-refused), leaving one item. It gives `ConnectorAdapter.resolveDatasetAddress` a `secret` — the ticket's stated blocker, that the sink's credential is never resolved, was FALSE — and resolves `<system_identifier>:<database oid>:<primary|standby>` plus the canonical `to_regclass` object, both best-effort so a revoked `pg_control_system()` degrades rather than refusing every copy forever. See §7's amended ④. #1194 is CLOSED out of band: a `query` dataset's named `parameters` now bind on postgres, rewritten `:name` → `$n` by a postgres-aware lexer — see §2.6's amended slice-2 block | slice 1 shipped no operator-reachable caller for the probe — #1191 |
| **M11** | `excel` dataset kind. **SPLIT IN TWO**, as M5/M6/M8/M10 were — slice 1 (#1213) is the READER and moves no data: `server/connectors/xlsx-read.ts`, its three `limits.ts` bounds and its fixtures. It discharges the dependency row below by BUILDING the reader (both measured libraries were disqualified as WRONG, not merely as materialising), and is deliberately unreachable — `excel` does NOT join `IMPLEMENTED_DATASET_KINDS` and the registry is untouched, so nothing user-facing changes. Slice 2 is the KIND: the config schema, `excel-io.ts`, the `fs` fork, the catalog wiring, the form and the e2e — the binding and the reader's first caller land together. |                                                                                                                                                                                                                                           |
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

**M11's dependency row is DISCHARGED, and the answer was not the expected one (#1213,
slice 1).** The row anticipated materialisation. The measured problem is worse: the streaming
readers are WRONG. Measured on node v25.9.0 against one logical workbook rewritten into three zip
entry orders.

`exceljs@4.4.0` (MIT) resolves shared strings and number formats only when
`xl/sharedStrings.xml` and `xl/styles.xml` PRECEDE the worksheet, because it is a single forward
pass — and **Excel writes them after**. Identical bytes, order alone changed: strings-first gave
`"hello"` and a real `Date`; the real-Excel order gave `{sharedString: 9}` and the raw serial
`46255`. No option changes this. On the layout exceljs's OWN `writeFile` emits it throws outright
(`this.model.sheets`, unguarded, `workbook-reader.js:303`); upstream has been dormant since 2023.
Its non-streaming reader is correct on every order and peaked at **1001 MB RSS** on a
6.8 MB/200k-row workbook, OOM-crashing under a 128 MB heap — §5's stated hazard, confirmed.

`xlsx-stream-reader@1.1.1` (MIT) is order-independent and lighter, and is disqualified by one line —
`lib/worksheet.js:272`, `workingVal || ''` — which returns `''` for `0`, for `false` AND for `''`.
A genuine zero becomes indistinguishable from a blank cell, so under §6.2 every `0` in a numeric
column becomes `null` or fails the row. Its only date support is `ssf.format`, which yields a
locale-shaped display string — the "corruption engine" §6.2 forbids by name.

**So the reader is BUILT, on M7's precedent** (which discharged its own *"a CSV parser"* row by
hand-rolling `shared/datamove/delimited.ts`). Only the sheet grammar is hand-rolled: `yauzl` (MIT)
supplies RANDOM ACCESS and `saxes` (ISC) the XML — 4 packages, 408 KB, both pure JS, both on
`ALLOWED_LICENSES`, versus exceljs's 78 packages / 34 MB. No native addon, so no new per-arch
artifact for the updater (`2026-07-30-packaging-and-updates.md:219`) and no `.node`
direct-require caveat (`2026-07-24-bun-single-binary-spike.md:44`).

**Random access is the whole design, not an implementation detail.** Reading the small parts by
NAME makes entry order irrelevant BY CONSTRUCTION — the property exceljs structurally cannot have.
Only the worksheet streams, so memory is proportional to DISTINCT STRINGS plus one batch, never to
rows; `limits.ts`'s `XLSX_MAX_SHARED_STRINGS_BYTES`, `XLSX_MAX_ENTRY_BYTES` and
`XLSX_MAX_CELL_CHARS` make that a guarantee, and inflation is counted as it ARRIVES because a zip's
declared `uncompressedSize` is attacker-controlled.

Four value decisions were forced by measurement and are pinned in `xlsx-read.test.ts`:

- a **blank cell binds `null`**, not `undefined`. Excel omits blanks from the XML, so `undefined`
  would reach `coerceValue` as `absent_value` and fail a row per blank — on sheets that are sparse
  by construction.
- **numFmt 45/46/47 are DURATIONS** and 18-21 are times of day, so they stay NUMERIC. `[h]:mm:ss`
  over `30.5` means 732 elapsed hours; rendering it as `1900-01-30T12:00Z` is exactly what §6.2
  forbids. 22 does bear a date. The locale date formats (27-36, 50-58) are a knowing omission with
  a safe failure: such a cell reads as a number, and a number into a `date` column fails visibly.
- **serial 60 is REFUSED.** It is Excel's phantom `1900-02-29`, inherited from Lotus; mapping it to
  `1900-03-01` would make it indistinguishable from serial 61.
- an **error cell travels as a fault OBJECT** that `coerceValue` rejects for every target, because
  the reader has no per-row error channel. The string `"#N/A"` would land in a text column looking
  like data.

**Slice 1 is the substrate only** — the reader, its bounds and its fixtures. `excel` does NOT join
`IMPLEMENTED_DATASET_KINDS` and the registry is untouched, so nothing user-reachable changes. The
kind (config schema, `excel-io.ts`, the `fs` fork, the catalog wiring, the form and e2e) is slice 2,
which lands the binding and the reader's first caller together — M5's four-way split exists for
exactly that reason.

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
a per-column expression escape hatch (**per DISPATCH, not per row** — §8 puts
substitution in the reducer, so a mapping's `expression` is one substituted
constant applied to every row, and a value that varies BY ROW is not expressible
in v1; #1129 records this at the seam), and an explicit _unmapped_ state — a column deliberately not copied
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

### As built — M8 slice 1 (#1169)

**`switch`'s `cases` is not one of the fields this pays down.** It is
`z.array(z.string())` and has classified `stringList` all along; the claim above
that it *"falls through to the JSON control"* was wrong when written. `llm_call`'s
`tools` is real, and is the second field slice 1 upgrades.

**The control admits an array only when its element is `.strict()`, and that gate
is load-bearing rather than tidy.** A row control renders exactly the columns the
element declares, so an OPEN element permits keys it would silently drop. It is
also what keeps `llm_call` off the control correctly: `history` is typed
`z.array(...)` but `validateDoc` refuses any non-string value — *"history must be
a whole-value `${...}` expression"* — so in every valid doc it holds a STRING.
Classified as a row list it would be unrenderable, and ONE unrenderable field
takes the WHOLE node into the JSON editor; the ticket meant to remove that box
would have inflicted it on the catalog's most-used activity. The same gate keeps
`messages`, whose `content` is prose, out of a narrow cell. Read off `def.catchall`
through the existing `defOf` funnel, so no per-activity list is introduced.

**It is a stack of cards, not a `<table>`.** The property panel is a fixed 320px
column (`web/src/index.css`, `grid-template-columns: 180px 1fr 320px`) and every
string control in it is a `<textarea>` — five columns of textarea in that width is
about 60px each. §13's requirement is the SHAPE of the surface (a row per mapping
carrying its own target type and `onError`), and `.contract-row`, already carrying
`ParamRow` and `OutputRow`, is the panel's idiom for it.

**Slice 1 is NOT §13 complete, and the remainder is not polish deferred out of
laziness.** Auto-map (§6.3) and the explicit *unmapped* state both need the SINK's
column list, and there is no seam that resolves one at authoring time — M6 built
`describeSource` for DISPATCH. The per-column expression escape hatch is deferred
with them: the flyout resolves its options by top-level config field name, so a
cell would ask it about `sink`.

**It must fit inside U7's settled rule, not beside it** (`adf-grade-ui-design.md:148`): fields are
derived from each activity's own Zod `configSchema`, never from hand-written metadata on the catalog
entry, _"so a parallel field list would be a third copy free to drift"_. The honest way to add a table
is therefore to widen `classify` with an `objectList` kind derived from the element schema — not to
special-case `copy` in the panel, which would be the parallel field list U7 refuses.

**Datasets belong in the Manage hub**, which the UI design already scopes as _"Manage (linked
services, triggers)"_ (`2026-07-14-adf-grade-ui-design.md:33`; the hub's own section is `:117`) — a Datasets list + detail beside
Connections. No new hub, no parallel authoring idiom.


### As built — M8 slice 2 (#1170)

**The missing seam turned out not to need a route.** Slice 1 recorded that auto-map and the
*unmapped* state "both need the SINK's column list, and there is no seam that resolves one at
authoring time". There is: `PipelineCanvas` already loads every `Dataset` on mount and threads the
list into the node panel, and `DatasetSchema.columns` is REQUIRED on every kind. So both read the
two bound datasets' declared columns directly — no introspection route, no fetch, no store access
at authoring time.

**That makes everything in this slice ADVISORY, and the code says so at every rung.** §7's three
schemas are the dataset's DECLARED columns (1), the node's MAPPING (2) and the store's ACTUAL
columns (3). The dispatch gate is (2)-against-(3) and deliberately does not read (1). Everything
here is (1)-against-(2), so a stale declared list produces a wrong WARNING and never a blocked
copy. The panel says as much in a hint under the advisory.

**Matching reuses the gate's own primitives, and that is a correctness property rather than
tidiness.** Auto-map's entire output is a mapping the gate will later resolve, so it matches through
`indexSourceColumns`/`resolveSourceColumn` — anything else could write a row auto-map believes is
fine and the gate then refuses. A button that authors a broken copy is worse than no button.

**The sink dedupe folds case, which is the one defect that would have shipped silently.**
`copyMappingShapeIssues` dedupes sinks by EXACT string, but the store resolves them folded and refuses the
collision ("each sink column may be written by one mapping row"). An exact-only skip list would add
a second row for `ID` beside an author's `id`, pass every cross-row rule, pass the write gate (#1176
put the same three rules there, and they compare as strings too — deliberately, since folding is the
store's answer to give), mint an immutable version — and fail `permanent` at dispatch, hours later.
The same fold covers two DECLARED sink columns that collide, since `columns` has no uniqueness refine.

**The advisory also names the fold collision an AUTHOR can still type.** Auto-map's own dedupe only
governs auto-map's output; a hand-typed `id` beside `ID` passes the exact-string cross-row
dedupe on both the canvas and the write gate, saves, and dies `permanent` at dispatch on an immutable version. The coverage check already
builds the fold set, so it reports the pair — the only place an author can still act on it. An
EXACT duplicate is deliberately left to `copyMappingShapeIssues`, which refuses it on Apply — and, since
#1176, at the write gate too — in better words.

**§6.3's "trimmed" is DELIBERATELY NOT IMPLEMENTED, and this supersedes that parenthetical.**
Neither the source resolver nor the store's sink resolver trims. A trimmed match would bind a
declared `" id "` to source `id` and emit a row whose `sink` is `" id "`, which
`resolveSinkColumns` then cannot match against the actual column `id`. Trimming would author
exactly the unrunnable row the reuse above exists to prevent, so matching agrees with the gate
instead. Case-insensitive stands; trimmed does not.

**Auto-map is ADDITIVE, never a replacement.** It skips sink columns some row already claims and
appends the rest. Replacing would destroy hand-authored rows — in particular `expression` rows,
which auto-map cannot regenerate because it only ever binds a source column. Its counterpart is
that stale rows can outlive a re-bind, so the advisory reports both directions: declared columns
nothing writes, AND rows naming a column the bound dataset does not declare.

**It writes the DRAFT, not the config.** `ExpressionPicker`'s precedent: the author reviews the rows
and commits them with Apply, which is what puts them through `schemaIssues`. A press that matches
nothing leaves the draft ALONE rather than clearing it, and says which of the three reasons applies
— source declares no columns, sink declares no columns, or nothing lined up. `columns: []` is a
deliberately authorable state ("this table has none"), so it must not read as "nothing matched".

**The *unmapped* state is an ADVISORY, not a persisted acknowledgment.** §13 asks that a column
deliberately not copied be "visibly so, never merely absent"; that is satisfied by naming it on
screen. Persisting a per-column opt-out would need a key on the mapping element, which is
`.strict()` — a schema change and a `CATALOG_VERSION` bump this slice does not carry. A sink column
that is `nullable: false` and unwritten is reported APART from one merely not copied, because that
one is not a deliberate omission at all: it is a copy that cannot succeed.

**The button is gated on the derived ELEMENT SHAPE, not on the activity type.** `formatFieldValue`
refuses any undeclared column key, so a row list whose cells are not `source`/`sink`/`type`/
`onError` is one auto-map could only write a refusal into. Reading the gate off the derived fields
keeps the Zod schema the single source of truth (U7) where a hand-written activity list would drift.

**What remains of §13 is item 3 alone — the per-column expression escape hatch (#1178).** It is
blocked on a different seam from the two above: `FieldPicker.resolve` keys on a TOP-LEVEL config
field name, so a cell inside a row would ask it about `sink`. It pairs with #864, which owns the
rest of that picker gap.

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
  pattern exists only elsewhere (`shared/src/schemas/zod-issues.ts`, `server/src/errors.ts`'s
  `capIssues`).
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
