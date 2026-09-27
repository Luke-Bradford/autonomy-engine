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
`{ id, ownerId (nullable, like every resource), name, type, value (JSON text), description, createdAt, updatedAt }`.

- **`type`** is `string | number | boolean | json`: `ParamTypeSchema` minus `secret`
  (`GlobalParamTypeSchema = ParamTypeSchema.exclude(['secret'])`, derived, not restated).
- **`value`** must match its type strictly, by the same `matchesSig` check a variable default uses
  (V1). `json` takes any JSON value. It is bounded at `GLOBAL_PARAM_MAX_BYTES` = 64 KiB of
  serialized JSON, because every value a run reads is copied into that run's log (GL-D3).
- **`name`** must be an addressable identifier (`isAddressableOutputName`, the rule params and
  variables already use), so every declared global can be referenced. It is unique per owner
  **case-insensitively** (`COLLATE NOCASE`, as `secrets.name` is), so `apiUrl` and `apiURL` cannot
  both exist. A reference matches exactly.
- **`name` and `type` are immutable after creation.** A version is immutable and references a
  global by name, typed at save time. Renaming or retyping would silently change what an
  already-saved version means. A rename or retype is delete + create, which makes the break
  explicit (GL-D4 states what a deleted global does to a run).
- **REST**, owner-scoped with `requireOwned`: `GET /api/global-params`, `POST`, `PATCH /:id`
  (`value`, `description` only; `name`/`type` refused with 400), `DELETE /:id`. No bulk route.

### GL-D2 — Reads: the `${global.<name>}` root

- A new `refRoot` kind `global`, arity 2, exactly like `vars`. The resolver reads
  `ctx.globals[name]`. A missing name at run time is a `SubstituteError`, never `Missing`, so
  `default()` cannot rescue a typo (V2's rule).
- **Typing.** `refRootType` returns the global's type. The scalar-root rule is V2's: a `json` global
  may be field-stepped and indexed, a scalar may not take a tail.
- **Where it is allowed:** everywhere `${params}` is today: node config fields and container
  `items`/`exitWhen`. **Not** in trigger bindings or tool-argument
  expressions: both stay on their closed `allowedRoots` sets. A trigger binding is evaluated at fire
  time before the run's snapshot exists (GL-D3). Lifting that is a later, separate decision (Open
  question 2).
- **Param defaults stay literal** (settled in #844 item 3), so a default cannot read a global.
- **Save-time validation.** `ScanScope.globals` is a REQUIRED map, like `variables`. The server's
  write gate injects the owner's current globals the way it injects `resolvePipeline`: owner-scoped,
  and the validator stays pure. An unknown `${global.x}` is a hard refusal with the same wording
  family as an undeclared param. Every version write gets the check by construction, including git
  import, so the git apply must place `global-params` ahead of pipelines (`APPLY_RANK`).

### GL-D3 — Determinism: a run snapshots what it reads

Globals are mutable and versions are not, so the only way a run replays and reruns faithfully is to
record the values it read.

- **`run.started.globals?: Record<name, JsonValue>`** holds exactly the globals the version's doc
  references, taken from the store at run start in `startRun`, beside `resolveRunParams`. It does not
  hold every global: the log carries only what the run uses, and an unrelated value never lands in a
  run it did not touch. The referenced set comes from the validators' own scan, the same seam V4 uses
  for variable reads, never from a second scanner.
- `RunState.globals` is folded from that field and never changes during the run. `buildCtx` hands it
  to substitution. Replay reads the log, never the table.
- **A referenced global that no longer exists at run start** makes `startRun` throw before any append,
  the same seam and outcome as a bad trigger-authored param today. The message names the global.
  **So does one whose type no longer fits.** Immutability (GL-D1) stops an in-place retype, but not a
  delete followed by a create under the same name with a new type. So the start check is not bare
  existence: it re-runs the doc's global reads through the same pure validator the save gate uses,
  against the live globals, and refuses on any error. One validator, two call sites, no second rule.
- **Rerun-from-failed copies the SOURCE run's logged `globals` verbatim**, never the live values. This
  is the RS param rule for the same reason (settled, operator 2026-07-23): copied frontier outputs were
  computed under the old values, so mixing in new ones would be a silent inconsistency. It follows that
  such a rerun still works after a global it read has been deleted or edited.
- **A fresh run (manual, trigger, or `call_pipeline` child) reads live values** at its own start. A
  child therefore takes its own snapshot, and a global edited while the parent runs can differ between
  parent and child. Each log is still self-contained and deterministic. See Open question 1.
- Old logs have no `globals` field, and a version saved before GL3 cannot reference a global (the
  root did not exist), so the fold's default is `{}`.

### GL-D4 — Deleting a referenced global

Delete is allowed. A global is workspace configuration, like a connection, and blocking its delete on
every version that ever referenced it would make it undeletable, because versions are immutable.
The consequence is explicit, not silent: a new run of a version that reads it fails at start with the
GL-D3 message, while a rerun-from-failed still works from its copied values. The Manage page's
delete confirmation names the pipelines whose **latest** version references the global (GL2). That
list is advisory, not a gate.

### GL-D5 — No "secure globals": a credential is a named secret

D3 said secure globals "route to the secret store", and the unified secret model (§1.3) left F7c as "a
later layer whose `${global.secureX}` resolves to a secret name". That layer is **not built**. The
store it would route to already exists and is already addressable from every sink that can take a
secret, as `{ "$secret": "<name>" }`. A `${global.secureX}` alias would be a second address for the
same value, reachable by the same sinks, and it would put a secret-bearing root into an expression
language whose every other root is cleartext.

- **A global is cleartext configuration.** It appears in the table, in the run log (GL-D3), in exports
  and in git (GL-D6). There is no `secret` type (GL-D1).
- The Manage page says so beside the value field and points to Secrets, as the connection form's
  secret-name hint does.
- **V-D8's forward note is satisfied by construction.** It required `${global.<secure>}` to be refused
  in a `set`/`append` value; no secure global exists, so there is nothing to refuse.
- F7c is closed as superseded by F15, recorded in spec #1's ticket table.

### GL-D6 — Persistence and portability

- **Git.** `serializeWorkspace` writes ONE file, `global-params.json`: an array of
  `{ name, type, value, description }` sorted by name, with no DB ids or timestamps, so the file is
  byte-stable. It takes part in drift the way the other kinds do. **Apply upserts by name.** A name in
  the file with a different `type` than the DB row is delete + create (GL-D1). **A DB global absent from
  the file is NOT deleted by an apply**: it is reported as drift. The DB is the runtime source of truth
  (settled Option A), and a pull that silently deleted live configuration would fail the next run of
  every version that reads it. The apply ranks `global-params` ahead of pipelines (GL-D2).
- **Portable export.** A pipeline export carries no globals. Importing a pipeline that references a
  global the target lacks is refused by the save gate, naming the global, which is the same shape as a
  missing param declaration. A whole-set export gains a `global-params` envelope kind, the one the
  git-publish spec already calls for.

### GL-D7 — Security model

- **Authorization.** Every route is owner-checked with `requireOwned`. The save gate and `startRun`
  read the globals of the **pipeline's** owner, using the same null-safe owner equality the other
  resources use. A run never reads another owner's globals.
- **No secret material** by design (GL-D5). Values are cleartext wherever they go, and the UI says so.
- **Bounds.** The per-value bound (GL-D1) caps what one read adds to a run log. Only referenced values
  are copied (GL-D3), so an owner with many large globals does not inflate every run.
- **Injection.** `${global.x}` is substituted the way `${params.x}` is. It is never a fallback for a
  param name, so a global cannot shadow or inject into a param (D3's collision rule).

### GL-D8 — Authoring and monitoring UI

- **Manage → Global parameters**: a new hub page (`routes.tsx` + `hubs.ts`, both needed). Rows use the
  shared `ContractEditor` row shell that params, variables and outputs already share. A fourth row
  editor would break the third-copy rule. The name and type cells are editable only on a new row.
- **Canvas.** `validateCanvas` and `useExpressionPicker` take `globals` (fetched once per canvas mount),
  so a server-valid `${global.x}` is not badged as unknown and the flyout offers a "Global parameters"
  group. A global created in another tab is picked up on the next mount. The server gate is the
  authority either way.
- **Run page.** A "Global parameters" section lists `state.globals` from the page's one engine
  projection, as V7 does for variables. It renders nothing for a run that read none.

## Migration / authority posture (#443)

Additive only. `run.started.globals` is optional and old logs lack it, so the fold defaults to `{}`
and every existing log folds identically. No event changes shape; no command is added. The new table
is empty until an operator writes to it. No existing version can reference `${global.*}`, because
the root is refused until GL3, so no bound run changes meaning.

## Ticket table

| # | Ticket | Ships with |
|---|--------|------------|
| **GL1** | Store: migration (`global_params` + the NOCASE unique index), `GlobalParamSchema`/`GlobalParamTypeSchema` + `GLOBAL_PARAM_MAX_BYTES` in shared, the name/type/value rules, owner-scoped REST with `name`/`type` immutability. Inert: nothing reads it. | — |
| **GL2** | Manage page (GL-D8), including the cleartext notice and the delete confirmation's advisory "used by" list. The first user-visible slice. | after GL1 |
| **GL3** | Read, **atomically**: the `global` root (resolver, typing, `checkRefRoot`, the closed-root exclusions pinned by test), `ScanScope.globals` required, the save gate injecting the owner's globals, `run.started.globals` + `RunState.globals` + `buildCtx`, the start-time existence check, the rerun-from-failed copy, and `APPLY_RANK`. | after GL1. **Inseparable:** a save gate that accepts `${global.x}` without the snapshot would give runs that replay against live values; a snapshot without the reseed copy would make a rerun silently read new values, the class of #1150. |
| **GL4** | Canvas: `validateCanvas` + the expression picker's "Global parameters" group. | after GL3 |
| **GL5** | Run page: the "Global parameters" section. | after GL3 |
| **GL6** | Git + portability: `global-params.json` serialize/parse/apply/drift, the absent-is-drift rule, and the `global-params` envelope kind. | after GL3 |

Build order GL1 → GL6. GL2 may land before GL3: a store an operator can fill but no pipeline can read
yet is honest, since the page says what reads it.

## Open questions (none blocks GL1–GL6)

1. **A `call_pipeline` child takes its own snapshot** (GL-D3). The alternative, inheriting the parent's
   values, is more consistent within one parent run but mixes two sources whenever the child reads a
   global the parent did not. This spec takes the simpler rule. Revisit if a real pipeline edits a
   global mid-run and is surprised.
2. **Globals in trigger bindings.** Excluded for now. Allowing them is sound, because a binding's
   result is frozen into `run.params` at fire time, but it widens a closed root set, which should be its
   own decision.
3. **`GLOBAL_PARAM_MAX_BYTES` = 64 KiB** is a judgement, not a measurement.
