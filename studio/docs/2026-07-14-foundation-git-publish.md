# Foundation Spec #3 — Git-backed authoring + Publish

**Status:** proposed — brainstormed + ADF-grounded 2026-07-14; pending Codex + self review.
**Scope:** ADF-style source-control + publish for studio — author against a repo, feature-branch
→ PR → merge → **Publish**, secrets never in git. Builds on P1c (versioned JSON export/import)
and Foundation Spec #1 (versions, secrets, global params).
**Non-goal:** engine execution semantics; no CI/CD deployment pipelines (that's the user's own).

## ADF grounding (MS Learn: `source-control`)

- **Collaboration branch** (default `main`): authored resources live as **individual JSON files**
  (each pipeline / linked-service / dataset a separate file). Work happens on **feature branches**
  → **Create pull request** → merge to collaboration branch.
- **Publish branch** (default `adf_publish`): on **Publish**, ADF generates deployable ARM
  templates from the collaboration branch and writes them here. **The collaboration branch is NOT
  what's deployed — Publish is a manual, explicit promotion.**
- **Secrets never in git** — linked-service secrets go to Key Vault; secret changes publish
  immediately, not via git.
- Import existing resources into the repo on setup; permissions: read-for-all, publish-for-few,
  no direct check-in to the collaboration branch.

## The architecture fork (the key decision)

Our current model: **SQLite immutable `PipelineVersion`s are the runtime SSOT**; P1c gives
version-stamped JSON export/import. ADF makes **git the authoring SSOT** + a separate live service.
Three ways to reconcile:

- **A — DB-SSOT + Git-sync/Publish seam (RECOMMENDED, local-first OSS).** The DB stays the runtime
  SSOT. Add a git seam: connect a repo; **Commit** serializes the workspace to JSON files on a
  branch; **Pull/Import** loads a branch's JSON into the DB (as versions); **Publish** promotes a
  committed config to the **active/deployable** state. Faithful to ADF's feature→PR→merge→publish
  flow, secrets-out-of-git, but respects our DB runtime + immutable-version model and self-host
  simplicity. Git is versioning/collaboration/backup; the DB is what runs.
- **B — Git-as-SSOT (ADF-faithful).** The collaboration branch IS the authoring source; the DB is a
  projection of the checked-out config; Publish deploys. Heaviest — re-architects storage, conflicts
  with immutable-version identity, brings merge/checkout complexity into the hot path.
- **C — Export/import only (status quo+).** Keep P1c, add a git-friendly file layout + a manual
  commit helper. Minimal; misses the collaboration/publish flow the operator asked for.

**Recommendation: A.** It delivers the ADF *feel* (branches, PR, publish, secrets-out-of-git)
without the git-as-database re-write, and layers cleanly on P1c + #1.

## Design (Option A)

### G-model — workspace serialization

- A **file layout** in the repo (git-friendly, one resource per file, stable ids/paths):
  `pipelines/<name>.json` (each = the immutable version doc), `connections/<name>.json`
  (**config only, NO secret**), `triggers/<name>.json`, `global-params.json`, `workspace.json`
  (folders/annotations/meta). Version-stamped envelope (reuse P1c's upgrade framework).
- **Secrets never serialized.** Connection files carry non-secret `config` only. On import, a
  secret-bearing connection lands **disabled / "needs secret"** (mirror P1c's unbound-trigger
  `enabled:false` defense) until a secret is supplied into the local secret store (#1).

### G-connect — repo association

Connect a git remote to the workspace (local repo or remote URL + auth). Settings: repo, default
**collaboration branch** (`main`), **working-branch** convention (`studio/<user>/<feature>`),
optional **publish/active pointer**. Store in a `workspace_git` config row.

### G-commit — Save-to-branch

**Save** in an authoring session commits the changed resource file(s) to the current working
branch (not the collaboration branch — no direct check-in). Message + author from the principal
(#1 audit). This is the studio analog of ADF's feature-branch authoring.

### G-pr / G-merge — collaboration

Open a PR from the working branch → collaboration branch (via the git host API where available;
else instruct the user). Merge happens in the git host (review). Studio observes the merge (pull).

### G-import — Pull into DB

Pull the collaboration branch → parse resource files → **create new immutable `PipelineVersion`s**
in the DB for changed pipelines (reuse P1c import + upgrade). Connections/triggers/global-params
upserted (secrets untouched). Import is idempotent (content-hash guards).

### G-publish — Promote to active

**Publish** = mark a committed pipeline version as the **active/deployable** version. Reconciles
with our immutable versions: authoring/merge creates versions; **Publish promotes one to `active`**,
which is what **new triggers bind by default** and what a "latest/active" resolver returns.
(Existing bound triggers keep their immutable pin — Publish never silently rebinds a pinned trigger;
#1 immutability preserved.) **This REINTRODUCES a draft/publish split** — updating the UI-epic's
earlier "save = version, no publish" note: with git, Save = commit-to-branch (draft), Publish =
promote-active. The command bar gains **Publish** when a repo is connected.

## Interactions / reconciliations

- **UI epic:** the Manage hub gains a **Git** section (connect repo, branch, publish); the Author
  command bar shows **Save** (commit) + **Publish** (when repo connected). Supersedes the UI-epic
  note that dropped "Publish."
- **#1 immutability:** versions stay immutable; `active` is a movable POINTER, not a mutation.
- **#1 secrets:** connection secrets never leave the encrypted store; git holds config only.
- **P1c:** the file layout = P1c's envelope, one-resource-per-file; import = P1c import + upgrade.

## Codex-hardened CORE (folded — these are load-bearing, NOT polish)

Codex confirmed Option A **only if** stable IDs + drift detection + CAS publish + dependency/secret
reconcile are core. Corrections:

- **Stable resource IDs, path cosmetic.** Each file carries a stable `resourceId` (+ its own
  `schemaVersion`/`catalogVersion`); path is `pipelines/<slug>.json` (regenerated), NOT identity.
  Import classifies by ID: same-id-new-path = **rename**; missing-file-DB-exists = **proposed
  delete/archive** (archive — runs restrict hard-delete); new-id = **create**; same-path-diff-id =
  **conflict**.
- **P1c import SPLITS into two modes.** `portable import` = today's behavior (new IDs, unbound —
  for copy). `workspace git import` = **upsert by stable `resourceId`, preserve internal refs
  (ownership-validated), new immutable version ONLY when the CANONICAL content hash changes**
  (hash canonical post-upgrade content, excluding volatile fields; SHA-256 as an optimization,
  parsed-object compare on mismatch).
- **`active` is NEVER a stored trigger binding.** Triggers always store a **concrete
  `pipelineVersionId`** (preserves #1 immutability + "unbound never fires"). "Bind to active" =
  a creation-time convenience that resolves ONCE. Live-follow, if ever, = a distinct visible
  `bindingMode: follow_active` resolved atomically at fire time with audit — not the default.
- **Publish = atomic compare-and-set.** Active-pointer row = `{pipelineId, activeVersionId,
  sourceCommit, sourceBlobSha, updatedBy, updatedAt}`. Publish requires the expected-previous
  active/commit; a stale publish is **refused** ("pull/import first"). Publish only from a DB
  version whose source commit/blob is known.
- **Secret readiness is a real runtime GATE.** Add connection `secretStatus: not_required | ready
  | needs_secret` + `enabled`. A node bound to a secret-bearing connection **fails validation/
  import unless `ready`**; a trigger referencing unresolved connections imports **disabled** and
  cannot be enabled until validation passes. Attention-text is not enough.
- **Drift/branch-HEAD gate.** Track observed collaboration-branch HEAD. Before commit: require the
  working branch is a descendant (else "pull/rebase first"). Block commit/import/publish while the
  worktree is conflicted / HEAD unknown / upstream relation unknown.
- **`GitProvider` capability interface** — CLI git first (Docker image includes git);
  isomorphic-git only a future fallback if bundle demands.
- **Per-file upgrade + all-or-nothing pull.** Each resource file upgrades independently (P1c
  framework), then a cross-resource graph validation; the pull transaction is atomic except the
  secrets-provisioning post-step.
- **Workspace/owner-scoped from day one** — `workspace_git`, active pointers, the resource-state
  ledger, and stable IDs all carry `ownerId`; never a cross-workspace DB-id reference.
- **Audit git provenance** — imported versions persist `commitSha, branch, filePath, blobSha`
  (with #1's author/changeNote) → "what is running?" is answerable.

## Ticket decomposition (G-series, reordered; each ≈ a fire)

| # | Ticket |
| --- | --- |
| **G1** | Resource envelopes: stable `resourceId`, canonical JSON, per-file schemaVersion, path policy — **SHIPPED 2026-07-23** (see the built-block below the table) |
| G2 | `workspace_git` (owner-scoped) + `GitProvider` CLI + repo status/fetch/HEAD tracking — **SHIPPED 2026-07-23** (built-block below) |
| G3 | Export/commit to working branch + **branch-HEAD descendant guard** + author/message |
| G4 | Workspace-git import PARSER/upgrader (per-file, no writes) |
| G5 | Transactional reconcile: create/update/**rename**/**delete-archive** classification |
| G6 | `active` pointer (provenance) + **CAS Publish** + resolve-once bind-to-active |
| G7 | Trigger binding reconcile (concrete version / contentHash; absent → disabled) + scheduler-invariant tests |
| G8 | Secret reconcile: connection `secretStatus`/`enabled` **readiness gate** + supply flow |
| G9 | PR open/observe via git-host API (GitHub first) — else guided manual |
| G10 | Conflict/divergence UX; multi-remote/auth polish |

### G1 built-block (2026-07-23)

- **`resourceId` on all four resource tables** (pipelines, pipeline_versions, connections,
  triggers — every immutable VERSION gets its own, per ①: `(pipelineId, version#)` is not stable
  across machines). Server-minted `newId('res')` in the repo create fns; write schemas OMIT it (no
  client/patch path); read schemas REQUIRE it non-null (no `.default()` — #473). Migration 0024
  backfills pre-G1 rows (`res_` + randomblob — the format difference from nanoid mints is cosmetic per
  `repo/ids.ts`); on `pipeline_versions` the backfill drops/recreates the `no_update` immutability
  trigger around the ONE system UPDATE (pinned by test). Nullable-in-SQL, NOT-NULL-at-the-Zod-read
  boundary (SQLite ADD COLUMN can't be NOT NULL without a constant-default sentinel; a NULL row
  fails loudly on read instead). **Uniqueness is OWNER-scoped** (`(owner_id, resource_id)`;
  versions `(pipeline_id, resource_id)`) because workspace-git import PRESERVES ids — two owners
  importing the same repo must not collide.
- **Envelope v4** (SCHEMA_VERSION 3→4): every export carries `resourceId` as REQUIRED-NULLABLE
  (`null` = "exported pre-G1"; the deterministic v3→v4 upgrader backfills `null` on all THREE
  kinds incl. the nested `data.pipeline` + every `data.versions[]` — an upgrader must never MINT a
  random id). PORTABLE import IGNORES it and keeps minting fresh ids (that IS the copy contract,
  pinned by test); preserve-by-resourceId lands with the workspace-git import (G4/G5).
- **`canonicalStringify`** (`shared/src/portability/canonical.ts`): THE canonical JSON serializer —
  UTF-16-code-unit-sorted keys at every depth, arrays ordered, `JSON.stringify` string/number
  formatting, skips `undefined` object props (JSON parity), REFUSES loudly (with path) non-finite
  numbers, `undefined` array elements, BigInt/function/symbol, and non-plain objects. Live
  consumer: all three `/export` routes serve `canonicalStringify(envelope)` bytes as
  `application/json` — identical content downloads byte-identical, and the G3 file writer reuses
  this exact serialization. **Content HASHING + the volatile-exclusion set** (id/resourceId/version/
  createdAt/catalogVersion/node.position, enumerated in v2 below) deliberately NOT built — lands
  with its first consumer (G4/G5 classifier), no-inert-surface rule.
- **`exportedAt` churn trap (for G3):** the envelope stamps `Date.now()` — the ONE volatile field.
  The G3 git file writer MUST omit/normalize it or every re-serialize dirties the file (byte-
  stability-modulo-exportedAt is pinned by test).
- **Per-file schemaVersion is DISCHARGED by the existing envelope**: a workspace file's content is
  ONE canonical P1c envelope per resource (each already carrying `schemaVersion`/`catalogVersion` +
  the upgrader chain). G3 must NOT invent a second stamp.
- **Path policy (decision recorded; slug util lands in G3 with its first consumer):**
  `pipelines/<slug>.json`, `connections/<slug>.json`, `triggers/<slug>.json` — slug from the
  resource NAME (lowercased, non-alphanumerics → `-`); **identity is `resourceId`, the path is
  cosmetic** (same-id-new-path = rename, per the Codex-hardened block). A slug collision within a
  kind appends a short `resourceId` suffix; renames regenerate the path.

### G2 built-block (2026-07-23)

- **Worktree model (the v2 "highest unbuildability risk", now PINNED):** the managed checkout is
  ALWAYS a clone the server itself creates at `<workspaceGitRoot>/<ownerId>/repo`
  (`buildApp` opt `workspaceGitRoot` / env `WORKSPACE_GIT_ROOT` / default `data/git`, cwd-relative
  like `dbPath` — safe because everything under it is DERIVED state). A "local repo" is connected
  by using its path as the clone REMOTE — **the user's own repo is never studio's working tree**,
  so disconnect can `rm` the checkout (realpath-canonicalized containment assert, fs.ts pattern).
  Every row↔disk divergence self-heals: connect clears an orphaned dir (no row ⇒ crash-mid-clone
  leftover), fetch re-clones a wiped checkout, a failed clone tidies its partial dir. All git ops
  for one owner serialize through an in-process `KeyedQueue` (the server is the single writer to
  its own checkouts — no lease table needed).
- **Auth model (pinned, v1):** the operator's own environment — SSH agent + credential helper of
  the user running the server. NO stored PATs until G10 (`CliGitProvider.secretsToRedact` is the
  G10 seam, empty today, redaction path pinned by test). Nothing can ever HANG an unattended op:
  `GIT_TERMINAL_PROMPT=0` + `GIT_ASKPASS=echo` + `ssh -oBatchMode=yes` (operator's own
  `GIT_SSH_COMMAND` respected). Child env also strips the master-key vars
  (`MASTER_KEY_ENV_VARS`, hoisted to `secrets/secrets.ts` as the ONE list) and ambient
  `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`.
- **Concrete commands (only what G2 consumes — no inert surface):** `git version` (probe →
  503 `git_unavailable`), `git clone --origin origin -- <src> <dir>` (empty remote clones fine =
  the onboarding state; `--origin` pins the remote name against an operator
  `clone.defaultRemoteName` gitconfig, which would otherwise break every origin-addressed op on
  the checkout), `git -C <dir> fetch --prune origin` (**`--prune` is load-bearing**: without it a
  remotely-deleted collab branch resolves its stale head forever — verified empirically),
  `git -C <dir> rev-parse --verify --quiet refs/remotes/origin/<branch>` (silent exit-1 =
  branch-missing, a real state, distinct from failure). `status --porcelain` +
  `merge-base --is-ancestor` land in G3 with their consumers. Execution: `execFile` arg-arrays
  (never a shell; deliberately NOT the process-supervisor, which is a detached line-streaming
  abstraction for long-lived agent workers), timeouts clone 120s / fetch 60s / local 10s, 1 MiB
  output cap.
- **Boundary validation:** `repoUrl` is a scheme ALLOWLIST (`https://`, `ssh://`, scp-like
  `user@host:path`, `file://`, absolute path) — blocks `ext::` transport injection and
  option-shaped values; embedded `user:password@` credentials are REFUSED (they would land in the
  DB row + error text). `collabBranch` is check-ref-format-validated before it reaches the
  `refs/remotes/origin/<branch>` interpolation.
- **Schema/API:** `workspace_git` (0025) — one row per owner (DB unique index is the authority;
  the route's 409 is the nicer message; re-point = disconnect + connect, never a mutation).
  Tracking fields REQUIRED-nullable (#473: no manufactured defaults). Derived
  `state = fetch_error > collab_branch_missing > ready` (precedence pinned: a failed fetch must
  not render "ready" off a stale earlier head), shared FE/BE via `deriveWorkspaceGitState`.
  Routes: GET/POST `/api/workspace/git`, POST `…/fetch` (failure recorded on the row AND
  surfaced as 502 `git_error`), DELETE. New closed-enum API codes `git_error` (502) +
  `git_unavailable` (503).
- **Deliberate deferrals:** the workspace-audit log (`repo.connected` et al.) → G6 with its
  design-driving consumer (Publish); accepted loss: pre-G6 connect/disconnect *history* is
  unrecorded (the live row survives). Working-branch-prefix column → G3 (its consumer; ADD COLUMN
  is cheap). Stored-PAT auth + multi-remote → G10.

## Challenge-hardened CORE v2 (2026-07-14 — read the SHIPPED P1c code; MAJOR reshape)

P1c is a **cross-workspace COPY primitive** (mints new ids, NULLs every internal ref
`node.connectionId`/`trigger.pipelineVersionId`/`node.call.pipelineVersionId`, forces
`enabled:false`, no stable identity, no archive) — **the wrong base for authoring/backup/delete.**
Three things MUST land before #3 is buildable, then the rest is specifiable:
- **① Stable resource+version identity.** A `resourceId` on pipelines AND **versions** (`(pipelineId,
  DB-version#)` is NOT stable across machines). Trigger→version, `call_pipeline`, `rerunOf`, and CAS
  provenance all depend on it. **Both export AND import fork** portable-strip (new ids) vs
  workspace-git (preserve-by-resourceId, recurse into `node.call` + `${}` version refs to remap).
- **② Real `archived` state, wired to trigger-disable.** `deletePipeline` HARD-THROWS with runs
  (`PipelineHasRunsError`) → a git-delete of a pipeline-with-runs **deadlocks the atomic pull**; and a
  deleted/archived pipeline's concrete-bound triggers **keep firing** ("unbound never fires" only
  null-checks). Git-delete → **archive** (new column, filtered from scheduler/list/dispatch) → **disable
  dependent triggers**. Never DB-delete on import.
- **③ A defined WORKING-COPY / draft model.** "Save = commit" leaves NO representation of a dirty DB
  edit → flow-2 reconcile + re-import clobber are unbuildable. Pin what the editable working config IS
  (a mutable draft row? the latest version? the worktree) before commit/drift semantics mean anything.
- **Drift gate uses the WRONG reference** — "descendant of collab-HEAD" defeats feature branches; the
  correct base is **the commit the DB was imported from**. And the real serialization point is the
  push non-fast-forward / PR-merge, so the gate is advisory — state it honestly.
- **Publish must be EVENT-SOURCED** — the active-pointer is a mutable last-writer row that can't answer
  "who published v5 before v7." Append `pipeline.published{from,to,commit,blob,by,at}` (+ `repo.connected`,
  `pipeline.archived`, `import.applied`) to a **workspace-audit log**; the pointer becomes a projection
  (satisfies overview T13).
- **Secret gate must be at DISPATCH, not just enable-time** — a secret removed AFTER a trigger is
  enabled fires a secretless run. The executor refuses to dispatch a node whose connection ≠ `ready`.
  `secretStatus`/connection `enabled` are net-new schema. Add the connection→dependent-triggers reverse
  index for post-hoc secret changes.
- **DB-only "bind to active" is DEAD** (Publish requires git) → local-first births every trigger
  unbound. Give DB-only workspaces a git-independent active pointer OR a **"bind to latest version"**
  fallback when no repo is connected.
- **Git mechanics are a SKETCH** — spec the concrete `GitProvider`: commands (`fetch`/`rev-parse`/
  `merge-base --is-ancestor`/`status --porcelain`/`commit`/`push`), **auth model** (PAT/SSH/credential-
  helper), conflict-detection, and the **worktree location + lifecycle** (studio authors in the DB —
  where is the checkout Commit serializes into, owned across concurrent sessions?). Highest unbuildability risk.
- **Canonical hash: enumerate the volatile-excluded set** — exclude `id/version/createdAt/catalogVersion/
  node.position` (else a canvas node-drag mints a spurious immutable version + Publish candidate);
  canonicalize key order + number formatting.
- Whole-workspace export needs `workspace`/`global-params` envelope KINDS (don't exist) + the RS reseed
  `sourceRunId`/`rerunOf` dangle after a round-trip unless version ids remap by resourceId (① again).

## Non-goals

- No environment-promotion pipelines (dev/test/prod) — user's own CI beyond the repo.
- No git-as-SSOT (Option B). No merge-conflict resolution UI in v1 (surface + defer to git host).
- No secrets in git, ever.

## Open questions (for Codex / review)

1. Publish/active: a single `active` pointer per pipeline, or an environment-keyed set of pointers
   (dev/prod) even in v1? (Leaning single, envs later.)
2. Git ops: shell out to `git` (self-host has it) vs a JS git lib (isomorphic-git) for portability
   (Docker without git)? Bundle implications.
3. Conflict model: studio authors on the DB then commits — if the branch moved underneath, how do
   we detect/merge? (Content-hash + require-pull-before-commit?)
4. Does `active`-pointer publish interact badly with the scheduler's "unbound never fires" +
   immutable-pin guarantees? (Should be fine — active is only the DEFAULT bind, not a rebind.)
5. Is connecting a repo required, or fully optional (studio works DB-only; git is opt-in)? (Leaning
   fully optional — local-first works with zero git.)
