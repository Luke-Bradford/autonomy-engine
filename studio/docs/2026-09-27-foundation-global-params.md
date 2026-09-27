# Foundation — global parameters (GL-series)

**Status:** spec, no code. Owner ticket: #844 item 1 (the globals half; the variables half is
[`2026-09-27-foundation-pipeline-variables.md`](./2026-09-27-foundation-pipeline-variables.md)).
**Supersedes spec #1's D3 and its tickets F7a/F7b/F7c.** D3 settled, and this spec keeps: a
workspace-scoped store of `{ name, type, value }`, read as `${global.<name>}`, an explicit read-only
namespace that is **never** an implicit fallback for a same-named `${params.x}`, with param
resolution unchanged (`pipeline default < trigger override`). What D3 left open or got wrong is
settled below: how a mutable store stays deterministic under replay and rerun (GL-D3), and why
"secure globals" are not built (GL-D5).

## Why

The same value is hand-copied into every pipeline today: a base URL, a target schema, an
environment name. Changing it means a new version of every pipeline that carries it. ADF's answer
is global parameters, set once per factory and read by every pipeline. Ours is the same, with the
one property ADF does not give: a run records the values it read, so its log replays and its rerun
reuses them.

## What exists today (measured 2026-09-27)

- **No workspace entity.** Every resource row has a nullable `ownerId`; "workspace" means one
  owner's resources. Routes check ownership with `requireOwned` (`server/src/routes/util.ts`). There
  is no per-owner settings table; `app_meta` is global and unowned.
- **A standalone secret store exists** (the unified secret model,
  [`2026-07-16-foundation-unified-secret-model.md`](./2026-07-16-foundation-unified-secret-model.md)):
  owner-scoped named `secrets` rows, `/api/secrets`, addressed from a declared sink field as
  `{ "$secret": "<name>" }` and resolved at dispatch by `resolveConfigSecrets` (`run/executor.ts`).
- **`${}` roots** are defined once, in `refRoot` (`shared/src/engine/params.ts`). `vars` is the
  newest (V2). Adding a root means touching `refRoot`, `resolveRoot`, `checkRefRoot`,
  `refRootType`, `SubstitutionContext`, the `ScanScope` builders, `availableRefs`/`refsInScope`,
  and `buildCtx`/`RunState`/`onRunStarted`. Trigger bindings and tool expressions evaluate under
  closed `allowedRoots` sets.
- **The save gate is injected.** `validatePipelineDoc` is pure; the server's write path
  (`repo/pipeline-versions.ts`) passes an OWNER-SCOPED `resolvePipeline`. Every version write
  (the REST route and git import) funnels through that one function.
- **Run start records its inputs.** `startRun` (`run/driver.ts`) resolves params with
  `resolveRunParams` and records them on `run.started.params`, so replay folds the logged values.
  A throw there happens BEFORE any event is appended, so `terminalizeInterrupted` patches the row
  cleanly. Rerun-from-failed (`run/reseed.ts`) re-derives params from the source row, which is only
  sound because the version is immutable.
- **Portability** knows `pipeline | connection | trigger | dataset` (`RESOURCE_KINDS`,
  `shared/src/portability/paths.ts`). The git-publish spec already names a `global-params.json`
  file and notes it needs a new kind. Nothing is built.
- Grep: no `global_params` table, no `global` root, no code mentioning the feature.

## Decisions

### GL-D1 — The store: an owner-scoped, mutable table

New table `global_params`:
`{ id, ownerId NOT NULL, name, type, value (JSON text), description, createdAt, updatedAt }`.

- **`ownerId` is NOT NULL**, unlike the other resource tables. SQLite treats NULLs as distinct, so a
  nullable owner under a unique `(owner_id, name)` index would admit duplicate names (the same hole
  `secrets` has). The principal's `ownerId` is never null. Reads key on the run's own `ownerId`, as
  `resolveConfigSecrets` does, and a run or pipeline with a null owner reads `{}`.
- **`type`** is `string | number | boolean | json`: `ParamTypeSchema` minus `secret`
  (`GlobalParamTypeSchema = ParamTypeSchema.exclude(['secret'])`, derived, not restated).
- **`value`** is checked the way `variableDefaultDefects` checks a default:
  `matchesSig(value, sigOfDeclared(type))`, plus `jsonReplaySafetyErrors` for `json`. (`matchesSig`
  has no `json` case, and a value such as `1e400` parses to `Infinity`, which would be logged and then
  replay as `null`.) A value is bounded at `GLOBAL_PARAM_MAX_BYTES` = 64 KiB of serialized JSON.
- **`name`** must be an addressable identifier, enforced as a hard rule the way V1 enforces variable
  names, so every global can be referenced. It is unique per owner **case-insensitively**
  (`COLLATE NOCASE`), so `apiUrl` and `apiURL` cannot both exist. A reference matches exactly.
  *(GL3 amendment: `__proto__` is reserved. zod's `z.record` drops that key, and every event is
  parsed before it is folded, so a snapshot holding it would lose it and no run could read it.)*
- **`name` and `type` are immutable after creation.** A version is immutable and references a
  global by name, typed at save time. Renaming or retyping in place would silently change what an
  already-saved version means. A rename or retype is delete + create, and GL-D3's start check catches
  the break.
- **REST**, owner-scoped with `requireOwned`: `GET /api/global-params`, `POST`, `PATCH /:id`
  (`value` and `description` only; `name`/`type` refused with 400), `DELETE /:id`. No bulk route.
  `GET /api/global-params/:id/usage` (GL-D4) answers from `global_reads`, so it ships with GL3.

### GL-D2 — Reads: the `${global.<name>}` root

- A new `refRoot` kind `global`, arity 2, exactly like `vars`. The resolver reads
  `ctx.globals[name]`. A missing name at run time is a `SubstituteError`, never `Missing`, so
  `default()` cannot rescue a typo (V2's rule).
- **Typing.** `refRootType` returns `sigOfDeclared(type)`. The scalar-root rule is V2's: a `json`
  global may be field-stepped and indexed, a scalar may not take a tail.
- **Where it is allowed:** everywhere `${params}` is scanned today. `validateRefs` covers node config
  fields and the reference fields `connectionId`, `connectionIds`, `datasetIds` and
  `call.pipelineVersionId`. `validateDoc` covers container `items`/`exitWhen` through
  `validateForeachItems`/`validateExitWhen`, which build their own scopes (`foreachItemsScope`,
  `exitWhenScope`), so those builders take `globals` too. The reference fields are allowed on purpose: selecting a
  connection per environment is the main thing ADF globals are used for. Such a value is a raw DB id
  and travels raw through git and export (GL-D6), exactly like a `${params}` default holding an id.
- **Not** in trigger bindings or tool-argument expressions. Both stay on their closed `allowedRoots`
  sets (Open question 2).
- **Param defaults stay literal** (settled in #844 item 3), so a default cannot read a global.
- **Save-time validation.** `ScanScope.globals` is a REQUIRED map of name to type, like `variables`.
  The server's write gate injects the owner's current globals the way it injects `resolvePipeline`:
  owner-scoped, and the validator stays pure. An unknown `${global.x}` is a hard refusal in the same
  wording family as an undeclared param. Every version write gets the check by construction, git
  import included. Reads are collected in a `globalReads` slot beside `variableReads` in `ScanScope`
  and `ValidateDocOptions`, so container fields are covered by the same pass.

### GL-D3 — Determinism: a version records its reads, a run snapshots them

Globals are mutable and versions are not. A run replays and reruns faithfully only if it records the
values it read.

- **The version records what it reads.** A new write-once column `pipeline_versions.global_reads`
  holds `{ name, type }[]`, taken from the write gate's own `globalReads`. That set is complete,
  because the gate only accepts a doc with no errors. It is DERIVED: not part of the content form,
  the git file or the export, and recomputed by the gate on every write, git import included. A null
  column (every row written before GL3) means "reads none". Those rows cannot reference a global,
  because the root did not exist.
- **The run snapshots them.** `run.started.globals?: Record<name, JsonValue>` holds the live values of
  exactly the recorded reads, taken in `startRun` beside `resolveRunParams`, i.e. before
  `foldPendingCancel` (which can itself append) and before any other append. An unrelated global never lands in a run's log.
- **The start check reads the column and never runs the validator.** Every recorded read must exist
  and its live type must equal the recorded type. That catches a global deleted, and one deleted and
  recreated under the same name with a new type. Re-validating the doc at start would refuse
  versions saved before a newer, unrelated rule existed. The snapshot's total size is capped at
  `GLOBAL_SNAPSHOT_MAX_BYTES` = 256 KiB, checked here, because values can grow after the save.
- A failed check throws before any append, the same seam as a bad trigger-authored param. **What the
  operator sees:** a start that throws there ends as an `interrupted` row, because `driveRun` runs
  `startRun` unawaited (a child's refusal fails the parent's call node). Since #1367 the reason is
  shown on the run page as a `start` diagnostic, and GL3 adds `GlobalStartError` to the refusals it
  quotes (its message names the global and the types, never a value). So GL3 adds one thing the params path lacks: the trigger run-now route (`routes/triggers.ts`,
  the only manual start) runs the same check function BEFORE `fire()` creates the row, and refuses with a 400 naming the global, as a bad trigger
  binding already is. The start check still runs, since a global can be deleted between the two.
  Scheduled, webhook and child starts keep the `interrupted` outcome. That
  gap is not new, since a bad trigger param already ends the same way, but deleting a global makes it
  routine. Open question 3.
- `RunState.globals` is folded from `run.started.globals` (default `{}`) and never changes during the
  run. `buildCtx` hands it to substitution. Replay and boot reconcile read the log, never the table.
- **Rerun-from-failed copies the SOURCE run's logged `globals` verbatim**, never the live values. This
  follows the RS param rule (settled, operator 2026-07-23) for the same reason: copied frontier outputs
  were computed under the old values, so mixing in new ones would be a silent inconsistency. So such a
  rerun still works after a global it read was edited or deleted. **The exception is a failure at a
  `call_pipeline` node:** the rerun dispatches a fresh child, and that child takes its own live
  snapshot (below).
- **A fresh run takes its snapshot at its own start**, whether manual, trigger or `call_pipeline`
  child. A queued run's snapshot is taken when it is admitted and started, while its params were
  frozen at fire time. A child therefore reads live values, and a global edited while the parent runs
  can differ between parent and child. Each log is still self-contained and deterministic. Passing
  `${global.x}` as a call param pins the parent's value for the child. Open question 1.

### GL-D4 — Deleting a referenced global

Delete is allowed. A global is workspace configuration, like a connection. Blocking its delete on every
version that ever referenced it would make it undeletable, because versions are immutable. The
consequence is explicit rather than silent: a new run of a version that reads it fails GL-D3's start
check, while a rerun-from-failed still works from its copied values.

`GET /api/global-params/:id/usage` answers from the `global_reads` column. It returns the pipelines
whose **latest** version reads the global, plus every version pinned by a **trigger**, because
a trigger runs its pinned version, not the latest. The Manage page's delete confirmation shows that
list. It is advisory, not a gate. *(GL3 amendment: a DISABLED trigger is listed too, flagged
`enabled: false`, because Run now fires a trigger whatever its `enabled` flag, so its pinned version
can still start and meet the start check.)*

### GL-D5 — No "secure globals": a credential is a named secret

D3 said secure globals "route to the secret store". The unified secret model (§1.3) left F7c as "a
later layer whose `${global.secureX}` resolves to a secret name". That layer is **not built**. The store
it would route to already exists and is already addressable from every sink that can take a secret, as
`{ "$secret": "<name>" }`. A `${global.secureX}` alias would be a second address for the same value,
reachable by the same sinks. It would also put a secret-bearing root into an expression language whose
every other root is cleartext.

- **A global is cleartext configuration.** It appears in the table, in the run log (GL-D3), in exports
  and in git (GL-D6). There is no `secret` type (GL-D1).
- The Manage page says so beside the value field and points to Secrets.
- **A `json` global can carry a marker.** Markers are collected after substitution, so
  `{"$secret":"n"}` substituted into a declared sink field is resolved as the owner's secret `n`. That
  is the same as a `json` param today and is not a leak: the plaintext reaches only a declared sink,
  and only the owner's own secret. The global holds the NAME, never the value.
- **V-D8's forward note is satisfied by construction.** It required `${global.<secure>}` to be refused
  in a `set`/`append` value, and no secure global exists.
- F7c is closed as superseded by F15, recorded in spec #1's ticket table.

### GL-D6 — Persistence and portability

- **Git.** One file per global, `global-params/<name>.json`, holding `{ name, type, value,
  description }` with no DB ids or timestamps. This follows the one-directory-per-kind machinery
  (`RESOURCE_KINDS`, `RESOURCE_KIND_DIRS`, `MANAGED_DIRS`, per-file drift) rather than the single
  `global-params.json` the git-publish spec sketched, which that machinery cannot hold. Because names
  are unique case-insensitively, file names cannot collide on a case-insensitive filesystem either.
- **Apply** matches names case-insensitively and creates or updates the value and description. Two
  cases are reported as drift and **not** applied:
  - **A DB global absent from the branch is not deleted.** The DB is the runtime source of truth
    (settled Option A), and a pull that deleted live configuration would fail the next run of every
    version that reads it. As a consequence, a deletion made on the branch never propagates, and the
    next Commit writes the global back.
  - **A file whose `type` differs from the DB row is not applied**, for the same reason: a retype
    breaks runs exactly as a deletion does. The operator retypes in the app with delete + create.
- `APPLY_RANK` places `global-params` ahead of pipelines, so a pulled pipeline that reads a pulled
  global passes the save gate.
- **Portable export.** A `global-param` export kind joins the per-resource exporters. A pipeline export
  carries no globals. Importing a pipeline that reads a global the target lacks is refused by the save
  gate, naming the global.

### GL-D7 — Security model

- **Authorization.** Every route is owner-checked with `requireOwned`. The save gate reads the
  pipeline owner's globals; `startRun` reads by `run.ownerId`. A run never reads another owner's
  globals.
- **No secret material** by design (GL-D5). Values are cleartext wherever they go, and the UI says so.
- **Bounds.** The per-value bound (GL-D1) and the snapshot total (GL-D3) cap what one run's log can
  gain. Only the reads a version records are copied, so many large globals do not inflate every run.
- **Injection.** `${global.x}` is substituted the way `${params.x}` is. It is never a fallback for a
  param name, so a global cannot shadow a param (D3's collision rule).

### GL-D8 — Authoring and monitoring UI

- **Manage → Global parameters.** A new hub page, which must be registered in both `routes.tsx` and
  `hubs.ts`. Rows reuse the `ContractEditor` row shell that params, variables and outputs share; a
  fourth row editor would break the third-copy rule. `ContractRow` gains a `'global'` kind and a way to
  lock the name and type cells on a saved row. The cleartext notice sits beside the value field.
- **Canvas.** `validateCanvas` takes `globals`, fetched when the canvas mounts and again on window focus
  and after a save the server refused. Without it, the canvas would badge every `${global.x}` unknown
  and block the save, since any canvas issue blocks Save. The expression picker offers a "Global
  parameters" group. The server gate is the authority either way.
- **Run page.** A "Global parameters" section lists `state.globals` from the page's one engine
  projection, as V7 does for variables. It renders nothing for a run that read none.

## Migration / authority posture (#443)

Additive only. `run.started.globals` is optional and old logs lack it, so the fold defaults to `{}`
and every existing log folds identically. No event changes shape, and no command is added. The new
table is empty until an operator writes to it. `pipeline_versions.global_reads` is nullable, and null
means "reads none", which is true of every existing row, because the root is refused until GL3. So no
bound run changes meaning.

## Ticket table

| # | Ticket | Ships with |
|---|--------|------------|
| **GL1** | Store: migration (`global_params`, `owner_id NOT NULL`, the NOCASE unique index), `GlobalParamSchema`/`GlobalParamTypeSchema` + `GLOBAL_PARAM_MAX_BYTES` in shared, the name/type/value rules, owner-scoped REST with `name`/`type` immutability. Inert: nothing reads it. | — |
| **GL2** | Manage page (GL-D8), with the cleartext notice. The first user-visible slice. | after GL1 |
| **GL3** | **SHIPPED 2026-09-27.** *(Built notes: absent `globals` in `ValidateDocOptions` means NONE, so every caller that passes nothing refuses a read. The save gate reads only names and types, and leaves out a stored row whose name breaks today's rule. `__proto__` is now RESERVED (GL-D1): zod's `z.record` drops that key, and every event is parsed before it is folded, so a snapshot holding it would lose it. `global_reads` is `[]` on every new row, `NULL` only on a pre-GL3 one, and a column that does not decode refuses the start rather than read as none. A rerun of a source cancelled before it started has no logged snapshot, so it takes a live one under the start check. The canvas loads the globals with the version, fatally, like datasets, and re-reads them on window focus and after a refused save, latest-wins. The usage route lists a disabled trigger too, see GL-D4.)* Read, **atomically**: the `global` root (resolver, typing, `checkRefRoot`, the closed-root exclusions pinned by test), `ScanScope.globals` + `globalReads`, the save gate injecting the owner's globals, the `global_reads` column, `run.started.globals` + `RunState.globals` + `buildCtx`, the typed start check + snapshot cap + the manual-run 400, the rerun-from-failed copy, the `usage` route + the delete confirmation's list, and the canvas `validateCanvas` plumbing with its refetch. | after GL1. **Inseparable:** a save gate that accepts `${global.x}` without the snapshot would give runs that replay against live values. A snapshot without the reseed copy would make a rerun silently read new values, the class of #1150. And a server that accepts the root while the canvas does not would block every canvas save that uses it. |
| **GL4** | **SHIPPED 2026-09-27.** *(Built notes: `availableRefs` takes the workspace's globals as a third argument, the same `Pick<ValidateDocOptions, 'globals'>` the validator takes, and ABSENT means none, as at the gate. The web side builds that map through ONE helper, `globalTypes`, for both the catalog and the validator that probes each offer, so a global is offered only when the probe knows it. A name the ref grammar would split is skipped, as a param's is. Trigger bindings and tool expressions keep `NO_GLOBALS`, GL-D2.)* Canvas: the expression picker's "Global parameters" group. | after GL3 |
| **GL5** | Run page: the "Global parameters" section. | after GL3 |
| **GL6** | Git + portability: the `global-param` resource kind (`RESOURCE_KINDS`, dirs, `APPLY_RANK`), serialize/parse/apply/drift with the two drift rules, and the export kind. | after GL3 |

Build order GL1 → GL6. GL2 may land before GL3: the operator can fill a store that no pipeline reads
yet, and the page says what reads it. Nothing is lost before GL6. Until then, globals are simply absent
from git, and a pull whose pipelines read a global the target lacks is refused visibly by the save
gate.

## Open questions (none blocks GL1–GL6)

1. **A `call_pipeline` child takes its own snapshot** (GL-D3). The alternative is for the child to
   inherit the parent's values. That is more consistent within one parent run, but it mixes two sources
   whenever the child reads a global the parent did not. This spec takes the simpler rule, and passing
   `${global.x}` as a call param already pins a value. Revisit if a real pipeline is surprised.
2. **Globals in trigger bindings.** Excluded for now. Allowing them would be sound, since a binding's
   result is frozen into `run.params` at fire time. But it widens a closed root set, which should be a
   decision of its own.
3. **A refused non-manual start leaves no durable reason** on the run (GL-D3). The fix is a general
   one: a start-refusal fact on the run row or log, covering bad trigger params too. That belongs to
   the run lifecycle, not to globals, and is filed as #1367.
4. **`GLOBAL_PARAM_MAX_BYTES` = 64 KiB and `GLOBAL_SNAPSHOT_MAX_BYTES` = 256 KiB** are judgements,
   not measurements.
