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
| G3 | Export/commit to working branch + **branch-HEAD descendant guard** + author/message — **G3a (serialize + Commit + push) SHIPPED 2026-07-23** (built-block below); descendant guard is a later slice (base = the imported-from commit, needs G4) |
| G4 | Workspace-git import PARSER/upgrader (per-file, no writes) — **SHIPPED 2026-07-23** |
| G5 | Transactional reconcile: create/update/**rename**/**delete-archive** — **G5b (the CLASSIFIER + canonical content-form + #666) SHIPPED 2026-07-23** (built-block below); **G5c-1 (the transactional APPLY write-path for connections + pipelines + archive) SHIPPED 2026-07-23** (built-block below); TRIGGER apply is **G5c-2** (#670, next) |
| G6 | `active` pointer (provenance) + **CAS Publish** + resolve-once bind-to-active — SLICED 3-way (large, like G5): **G6a (the workspace-audit event log) SHIPPED** (built-block below); **G6b (git provenance on versions — reader blob-sha + `pipeline_versions` provenance cols + stamp-on-import) SHIPPED** (built-block below); **G6c** further sliced: **G6c-1 (the `active` pointer projection + CAS Publish `pipeline.published` + route) SHIPPED** (built-block below); **G6c-2 (resolve-once bind-to-active — the trigger-creation convenience that reads this projection: git-mode → active, DB-only → latest) SHIPPED** (built-block below). G6 fully sliced + shipped |
| G7 | Trigger binding reconcile (concrete version / contentHash; absent → disabled) + scheduler-invariant tests — **SHIPPED 2026-07-24** (built-block below): resolved-space content compare kills the force-disabled-unbound-trigger churn (#668 resolved: `enabled` stays content), preview↔apply parity via `listVersionResourceIds`, scheduler-invariant end-to-end test |
| G8 | Secret reconcile: connection `secretStatus`/`enabled` **readiness gate** + supply flow |
| G9 | PR open/observe via git-host API (GitHub first) — else guided manual — **G9a (persisted `working_branch` + feature-branch selection + GUIDED-MANUAL compare URL) SHIPPED 2026-07-24**; **G9b (GitHub REST auto-open + PR-observe via an operator-env token) SHIPPED 2026-07-24** (built-block below). G9 core shipped; conflict/divergence + stored-PAT/multi-remote polish is G10 |
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

### G3 working-copy model — SETTLED (operator #662, 2026-07-23): **(a) + (i)**

The v2 open item ③ ("a defined WORKING-COPY / draft model") is now pinned, unblocking G3.

- **D1 = (a): the working copy Commit serializes is the LATEST immutable version of each
  resource** (+ current connections/triggers) — **NO new draft/dirty schema.** Consistent with
  settled Option A: the DB is the runtime SSOT and the managed checkout is derived/disposable.
  This deliberately does NOT re-architect the load-bearing `save = mint-immutable-version`
  invariant (run binding / trigger pins / RS rerun / immutability triggers all depend on it). A
  mutable draft row (option b) can be layered LATER without invalidating (a): commits record
  provenance by `resourceId` + content-hash, not by "which row was the draft".
- **D2 = (i): Commit is an EXPLICIT command-bar action; Save keeps minting a version; git stays
  opt-in.** NOT auto-commit-per-save (option ii — it would couple authoring latency to git
  clone/fetch/push). The UI command bar becomes THREE distinct acts: Save / Commit / Publish (a
  per-workspace "save writes the working branch" toggle can arrive later, no schema change).
- **Drift is ADVISORY:** uncommitted iff `canonicalHash(latest version, G1 volatile-exclusions)`
  ≠ the blob last committed/imported for that `resourceId`. The descendant-guard base is **the
  commit the DB was imported from** (NOT collab-HEAD — that defeats feature branches); the real
  serialization point is push non-fast-forward / PR-merge, so the gate is advisory. A version is
  publishable (G6) only if committed.

### G3a built-block (2026-07-23) — serialize + Commit + push to the working branch

First G3 slice. Delivers the explicit **Commit**: turn the DB working copy into canonical JSON
files in the managed checkout and land them on a studio-owned working branch. Descendant/drift
guard, PR-open, and the persisted working-branch column are later slices (see deferrals).

- **`serializeWorkspace(db, ownerId)` — the workspace-git EXPORT fork** (distinct from the
  portable `portability/export.ts`, which NULLs internal refs for cross-workspace copy). It
  PRESERVES resource identity and **remaps every internal ref to a `resourceId`**, because a
  same-workspace re-import mints a NEW DB version id under the SAME `resourceId` (G1 built-block:
  "workspace-git import PRESERVES ids") — a ref stored as a concrete DB id would dangle on the
  first round-trip. Per-pipeline the file carries the pipeline row + its **latest version only**
  (`versions:[latest]`, per D1) — NOT all versions (git history IS the version trail; bundling
  the DB trail would double-track it). Remaps: literal `trigger.pipelineVersionId` /
  `node.call.pipelineVersionId` → that version's `resourceId`; literal `node.connectionId` → that
  connection's `resourceId`; a `${}` DYNAMIC ref (classified by the SSOT `interpolationMode`,
  same as export.ts) is PRESERVED verbatim (it routes on run values, not an env-specific row). A
  `null` source ref stays `null`.
- **Owner-scoped remap, no manufactured absence.** The remap resolves ids through owner-scoped
  maps built from the owner's own resources (`Map<versionDbId, resourceId>`,
  `Map<connectionDbId, resourceId>`); a NON-null id that fails to resolve to an owned row **fails
  the Commit loudly** — never coerced to `null` (#473: an absent fact is not a benign default;
  the merge-gate "a `gh` failure is never CI-green" shape). `null`-stays-`null` only when the
  source was already absent.
- **Deterministic, order-independent bytes.** Both the emission order and the slug-collision rule
  are keyed on `resourceId`, never DB row order (the `list*` repo fns issue no `ORDER BY`): when
  2+ resources of a kind share a slug, **ALL** of them get a `resourceId` suffix (a rule decided
  by content, so it can't flip with iteration order). `exportedAt` — the ONE volatile envelope
  field (`Date.now()`) — is normalized to `0` in the file (a valid `int`, so the file still
  re-parses through `ExportEnvelopeSchema`); everything else goes through `canonicalStringify`.
  Byte-stability: identical DB content → identical files, pinned by a reversed-order test.
- **Path policy (G1's, slug util lands here):** `pipelines/<slug>.json` etc.; slug = the resource
  NAME lowercased, non-alphanumeric → `-`; identity is `resourceId`, the path cosmetic (same-id
  new-path = rename, resolved on import G5). The slug neutralizes `.`/`/` (→ `-`), so a hostile
  resource name can't traverse; each file write is additionally containment-asserted within the
  checkout, and the `add`/clear steps touch ONLY the three managed dirs — never the user's own
  files.
- **Commit flow** (`POST /api/workspace/git/commit` `{message}`, inside the per-owner
  `KeyedQueue`): ensure the checkout is present (the fetch route's re-clone helper, now shared) +
  fetch (recording the same `observedCollabHead`/`lastFetchError` tracking the fetch route does —
  identical semantics); pick the base — `origin/<workingBranch>` if it exists (continue the branch
  so the push FAST-FORWARDS), else `origin/<collabBranch>`, else **orphan** (empty repo, the
  onboarding state); `checkout -f -B` the working branch off the base (`-f`: the checkout is
  disposable, so force past any crash-left dirt). Then reconcile ONLY the three managed dirs:
  `git rm -r --cached --ignore-unmatch -- pipelines connections triggers` (stage the removal of
  every previously-committed managed file), clear those dirs on disk, write the fresh serialized
  set, `git add -f -- <exact written paths>` (the exact set, never a wildcard — so no stray
  untracked file can enter studio's commit; `-f` because a base-branch `.gitignore` matching a
  managed dir would otherwise make `add` of a named ignored path exit non-zero and brick every
  Commit; a removed resource stays a staged deletion from the `rm --cached`, an unchanged file's
  re-add nets to zero). No-op detection is `git diff --cached --quiet` (staged-index-scoped, so an
  untracked file OUTSIDE the managed dirs is never mistaken for a change — where a whole-tree
  `status --porcelain` would be): nothing staged → **no-op** (`committed:false`); else commit
  (author = the principal, via `-c user.name`/`user.email` — headless servers have no ambient git
  identity) + push. The push **never passes `--force`**. Because each Commit fetches and BASES on
  the working branch's own current tip, the push is a fast-forward BY CONSTRUCTION — an out-of-band
  advance of the working branch is absorbed (rebased onto), not rejected. A non-fast-forward can
  therefore only arise from a concurrent cross-process push in the fetch→push window, surfacing as
  a `git_error` (502) rather than silently force-overwriting. Real drift detection (base = the
  imported-from commit) is the deferred descendant-guard slice; G3a's push safety is advisory only.
- **Working branch is DERIVED `studio/<ownerId>/work` this slice** (no client override — an
  unpersisted override with no reader would be inert surface). The persisted `working_branch`
  column + feature-branch selection land with their first reader (G9 PR-open).
- **Message validation:** a shared `CommitMessageSchema` (`trim().min(1)`, capped, no
  control-only) at the route boundary — `git commit -m ""` refuses, and the boundary is where
  input policy lives (the G2 pattern).
- **Non-latest binding is faithful, not a fork:** a trigger bound to v3 while latest is v5
  serializes v3's `resourceId` (every version has its own) even though only v5's file is
  committed. The dangling-ref reconcile ("absent → disabled") is G7's charter, not a re-point
  (that would violate immutability / "unbound never fires"). Pinned by test.
- **Deferrals:** descendant/drift guard (base = the imported-from commit — needs G4 import);
  drift-status reporting; `global-params.json`/`workspace.json` files (need NEW envelope KINDS
  that don't exist yet); the persisted `working_branch` column (→ G9). `git status --porcelain`
  + `merge-base --is-ancestor` — G2 deferred `merge-base` to "G3 with its consumer"; its consumer
  is the descendant guard, so it lands with that slice, not G3a.

### G5b built-block (2026-07-23) — reconcile CLASSIFIER + canonical content-form + #666

First G5 slice. The transactional reconcile is large/risky for one unattended
fire, so G5 is split: **G5b = the read-only CLASSIFIER** (what a pull WOULD do,
surfaced in the existing import-preview) + the content-comparison primitive both
it and the drift gate need + the #666 data-correctness fix; **G5c = the
transactional APPLY write-path** (create/update/rename version-mint + upsert +
archive, ref-remap `resourceId`→DB-id, the `POST …/import` route). This slice
writes NOTHING to the DB.

- **#666 (folded, data-correctness): `serializeWorkspace` OMITS archived
  pipelines AND their dependent triggers.** Git represents an archived pipeline
  as file ABSENCE (the delete-classification below), so leaving it in the
  serialized set would RESURRECT it on the next Commit → import round-trip. The
  version→`resourceId` ref map is still built over ALL pipelines (incl.
  archived), so a LIVE pipeline's `call_pipeline` node or trigger that references
  an archived version still remaps faithfully to that version's real
  `resourceId` (the dangle-on-import is G7's "absent → disabled" charter, not a
  serialize-time drop). Slug-collision suffixing is computed over the EMITTED
  (non-archived) sets only, so an archived resource can never perturb a kept
  resource's path. A trigger is omitted iff its LITERAL `pipelineVersionId`
  resolves to an archived pipeline's version (`null`/`${}` bindings are kept; a
  literal ref to a non-existent version still THROWS `WorkspaceSerializeError` —
  #473, never a silent drop).
- **Canonical CONTENT FORM (`shared/portability/content-form.ts`)** — the
  primitive that answers "did this resource's authoring content change, or only
  its identity/position/local-state." A STRING over `canonicalStringify` of the
  export `data` with the volatile/identity/local-runtime fields removed;
  equality IS the comparison ("parsed-object compare"; SHA-256 over the form is
  an explicit deferred optimization). The exclusion set is **structure-aware, per
  resource LEVEL — never a blanket key-strip** (load-bearing): resource-envelope
  `id`/`resourceId`/`ownerId`/`createdAt`/`updatedAt` are machine-specific →
  excluded; a version's `id`/`resourceId`/`pipelineId`/`version`/`catalogVersion`
  → excluded; `node.position` (canvas geometry) → excluded; connection
  `requiresSecret` (local readiness, G8's charter) → excluded; the resource
  `name` → excluded from CONTENT (tracked as the separate `nameChanged` signal).
  But `node.id`/`edge.id`/`container.id`, `param.name`/`output.name`, and a
  binding (`trigger.pipelineVersionId`/`node.call.pipelineVersionId`/
  `node.connectionId`, all already `resourceId`s in an export) are KEPT — they
  are graph content, and a blanket "strip every id" would collapse two different
  graphs to equal and mint no version for a real edit (the inverse of the #473
  fail-open shape). Reused later by the G3 drift gate.
- **Classifier (`server/portability/workspace-reconcile.ts`) — PURE over two
  `ParsedWorkspace`s.** The DB side is `parseWorkspaceFiles(serializeWorkspace(
  db, ownerId))` — the DB run through the IDENTICAL serialize+parse path the
  incoming files took, so both get the same volatile treatment for free and
  #666's archived-omission flows into the baseline automatically. Matches by
  stable `resourceId` (path is cosmetic, G1). Per resource: `create` (id absent
  from DB, or a pre-G1 `null`-id file), `unchanged`, `update` (content differs),
  `rename` (content identical, only the name differs) — carrying INDEPENDENT
  `nameChanged`/`contentChanged` flags so a rename-that-also-edits loses neither
  signal (the label folds to `update`; G5c reads both). Plus pipeline ARCHIVE
  proposals: a DB pipeline whose `resourceId` is absent from the branch.
- **Scope boundary (deferred to G5c):** only PIPELINES surface an archive
  proposal (the only kind with an archive state, G5a). A connection/trigger
  present in the DB but ABSENT from the branch is DELIBERATELY not surfaced —
  its delete/orphan semantics are undecided in the spec ("never DB-delete on
  import") and belong with the apply. Explicitly a preview non-goal, not an
  omission. `conflict` (same-path-diff-id) is a non-goal by construction: our
  identity is `resourceId` and a git tree path is unique, so a reused path with a
  new id reads as create + rename, never a conflict.
- **Wiring (no inert surface):** the classifier feeds the existing read-only
  `POST /api/workspace/git/import-preview` (each resource gains `disposition` +
  the two change flags; the result gains an `archive` list). The route now READS
  DB rows (still writes nothing).
- **For G5c (the apply write-path):** (1) a pipeline ARCHIVED in the DB but
  whose file is still PRESENT on the branch (archive not yet committed)
  classifies `create` here, because `serializeWorkspace` omits it from the DB
  baseline — the apply MUST handle that as restore-vs-create (its `resourceId`
  already exists, archived), not blindly mint a second pipeline. (2) The trigger
  `enabled` content-vs-readiness decision (see `content-form.ts`) is a G7/G8
  fork, tracked separately. (3) Connection/trigger orphan-delete semantics
  (absent from branch) are still owed.

### G5c-1 built-block (2026-07-23) — transactional reconcile APPLY (connections + pipelines + archive)

The APPLY write-path the G5b classifier previews. Sliced (operator "large/risky
for one unattended fire" + a planning-gate adversarial review): **G5c-1 =
connections + pipelines + archive**; **G5c-2 (#670) = triggers**. Triggers are
the pure LEAF (nothing references a trigger), so deferring them cannot break the
pipeline/connection apply, and the murkiest deferred semantics (mode-consistency,
`enabled`-as-content-vs-readiness, "absent→disabled"/G7) are all trigger-specific.

- **Atomic**: `applyWorkspace(db, ownerId, incoming, head)` (`portability/workspace-apply.ts`)
  does every write in ONE `db.transaction`; a mid-way refusal (invalid doc,
  unresolved ref, call cycle) rolls the DB fully back. `archivePipeline`'s own
  nested tx composes as a SAVEPOINT (the `import.ts` idiom).
- **Fail-closed on a corrupt branch**: ANY parse diagnostic
  (unparseable/duplicate-resourceId/unknown-dir) → the WHOLE import is REFUSED
  (`refused: true`, nothing written), never a partial apply of a known-broken
  tree (the merge-gate "a `gh` failure is never CI-green" posture). A stray file
  is cheap to remove; a half-applied branch is not.
- **resourceId PRESERVED on every create** (G1 "import preserves ids"): a new
  `{resourceId?}` option on `createPipeline`/`createConnection`/`createPipelineVersion`
  (CRUD + portable import omit it → still mint fresh). Without it every pull
  re-mints and all bindings dangle forever.
- **Row-fields vs version-doc split** (the planning-gate G2/G3 fixes): the apply
  drives off the INDEPENDENT signals, never the collapsed `disposition` enum. A
  `concurrency`-only change patches the pipeline ROW (`updatePipeline`) and mints
  NO version — `concurrency` is in `pipelineContentForm` so it reads as an
  `update`, but minting an identical-graph immutable version would be #473-class
  churn + silent cap loss. A pure NAME change patches `name`, no mint. A version
  mint happens only when `pipelineVersionContentForm` (a new shared helper, the
  version doc minus volatile/position) actually differs — with a **skip-if-present
  guard**: an incoming version resourceId already materialised (a restore, or a
  DB-ahead re-pull) is a no-op, never a `(pipeline_id, resource_id)` UNIQUE
  collision.
- **Restore-vs-create** (spec note 1): a `create` disposition whose resourceId
  matches a soft-ARCHIVED pipeline (serialize omits archived, so it classifies
  `create`) → `restorePipeline` (new; un-archive the row, does NOT re-enable the
  triggers archive disabled — that's G7/G8 readiness) rather than a duplicate row.
- **Inverse ref-remap** (the precise inverse of serialize's `remapNode`): a node's
  `connectionId` / `call.pipelineVersionId` resourceId → concrete DB id via
  owner-scoped maps seeded from the owner's rows PLUS everything created in THIS
  apply. `${}` dynamic refs preserved verbatim (`interpolationMode` SSOT); a
  `null` connection ref stays absent; a non-null LITERAL ref resolving to nothing
  throws `WorkspaceApplyError` (unmapped → 500, exactly as `WorkspaceSerializeError`
  is treated — a corrupt COMMIT is an internal-consistency violation, not user
  input; message names only ids, redaction-safe). New owner-scoped by-resourceId
  getters (`getPipelineByResourceId` — NOT archive-filtered so restore sees it —
  `getConnectionByResourceId`).
- **Topological mint order**: `createPipelineVersion`'s doc validator resolves a
  callee's nodes FROM THE DB, so a co-created `call_pipeline` callee must be
  inserted before its caller. Kahn over the in-batch call edges (a ref to an
  already-materialised version needs no edge — it resolves from the seed);
  deterministic (file order within each ready set); a cycle among co-created
  chains → `WorkspaceApplyError`.
- **Route** `POST /api/workspace/git/import`: fetch (shared with fetch/preview) →
  read collab-branch snapshot → `applyWorkspace` → post-commit `scheduler.sync()`
  (OUTSIDE the tx; drops the wakeups of triggers an archive disabled). Empty repo
  (no collab branch) → a no-op result. `WorkspaceGitApplyResultSchema`:
  `{head, refused, applied[], deferred[] (triggers, with disposition), archived[], diagnostics[]}`.
- **For G5c-2 (#670)**: TRIGGER apply — binding remap (versionMap, `${}`/null,
  unresolved literal → null + `enabled:false`, "absent→disabled" is G7), the
  `import.ts` mode-consistency forcing (collab branches are hand-editable), and
  the documented perpetual-`update` idempotency exception for a force-disabled
  unbound trigger (until G7's readiness reconcile — now SHIPPED, resolved by the
  resolved-space compare in the G7 built-block below). Connection/trigger
  orphan-delete (absent from branch) semantics still owed.

### G6a built-block (2026-07-23) — the workspace-audit event log

First G6 slice. G6 was sliced 3-way (large/risky for one unattended fire, like
G5): **G6a = the audit log** (this slice); **G6b** = git provenance on versions;
**G6c** = the `active` pointer projection + CAS Publish + resolve-once
bind-to-active. G6a is the EVENT-SOURCING substrate the Challenge-hardened v2
"Publish must be EVENT-SOURCED" bullet requires — the `active` pointer (G6c)
becomes a projection of THIS log, so it lands first.

- **`workspace_events` (0027) — owner-scoped, append-only.** Mirrors
  `run_events`: `id`, monotonic per-owner `seq` (from 0), envelope `type`, JSON
  `payload`, `created_at`. `UNIQUE(owner_id, seq)` is the real backstop for the
  repo layer's read-max-then-insert numbering (better-sqlite3 single-writer);
  two `RAISE(ABORT)` triggers (`_no_update`/`_no_direct_delete`) enforce
  append-only in SQL, and the repo module exports no update/delete (defense in
  depth, the `run_events` invariant). `owner_id` is `NOT NULL` (the partition
  key, always stamped) — unlike the config tables' nullable-in-SQL `owner_id`,
  because this is a fresh CREATE TABLE, not an ADD COLUMN.
- **Closed union `WorkspaceEventSchema`** (`shared/schemas/workspace-event.ts`),
  discriminated on `type`, three variants this slice: `repo.connected`
  (`{repoUrl, collabBranch, by}`), `pipeline.archived` (reuses
  `WorkspaceGitArchivedResultSchema`'s `{resourceId, name, disabledTriggerIds}`
  + `by`), `import.applied` (`{head, branch, applied[], archived[], by}`, reusing
  the apply-result sub-schemas). `pipeline.published` is added in G6c. **No `at`
  field on any payload** — the envelope `created_at` IS the logical `at`, one
  writer, no drift. `by` = the principal id, REQUIRED (every writer is an
  authenticated route; #473 — never manufactured). **DELIBERATE divergence from
  `run_events`:** the row `payload` is typed as the CLOSED union (not
  `z.unknown()`) because this log CROSSES the API boundary typed
  (`GET /api/workspace/audit`), so it validates on read as well as write and
  earns a `schema-table-parity` CASES entry (like `run_diagnostics`/`workspace_git`,
  not the `run_events` infra-exemption).
- **`appendWorkspaceEvent(db, ownerId, payload)`** (`repo/workspace-events.ts`) —
  the SINGLE validating writer: parses the payload through the union and stamps
  the indexed `type` column FROM the parsed payload (the `appendEngineEvent`
  idiom — `type` can never disagree with its payload). Called inside a caller's
  `db.transaction`, its own tx composes as a SAVEPOINT, so the audit fact commits
  or rolls back ATOMICALLY with the mutation it records (the fail-safe direction:
  never a committed change with a lost audit fact).
- **Three emit points, each ATOMIC with its mutation (one outer `db.transaction`,
  the emit nesting as a SAVEPOINT):** the connect route (`repo.connected`, with
  `createWorkspaceGit`); the MANUAL archive route `POST /api/pipelines/:id/archive`
  (`pipeline.archived`, with `archivePipeline`), gated on `!existing.archived` so
  an idempotent re-archive does NOT double-emit; the import route
  (`import.applied`, with `applyWorkspace`). An import-driven archive is captured
  in `import.applied.archived[]`, NOT also as `pipeline.archived` — the manual
  route is the sole `pipeline.archived` writer, so the two never double-count.
- **`import.applied` records EFFECT, not attempts** — `buildImportAppliedEvent`
  (a PURE helper, `portability/import-audit.ts`, unit-tested) returns `null` for a
  refused import, an empty-repo no-op (`head === null`), and an idempotent
  all-`unchanged` re-import; non-null only when something was
  created/updated/renamed/version-minted or a pipeline archived (`versionMinted`
  is part of the test because a `restored` can mint while its `action` reads
  `restored` — #672 orthogonality). Emitting on a no-op would drown the audit's
  "what changed" value.
- **`GET /api/workspace/audit`** (`routes/workspace-audit.ts`, mounted OUTSIDE
  `/api/workspace/git`) — keyset-paginated, owner-scoped, **NOT git-gated** (the
  log records `pipeline.archived` on a DB-only workspace, so it never 404s on a
  missing `workspace_git` row — an owner with no history gets an empty page).
  Ordered + keyset-paginated by `seq` (the authoritative APPEND order), NOT by
  wall-clock `created_at` (two same-millisecond events would read back in random
  `id` order, wrong for an audit history). Reuses the shared cursor codec
  (`afterCursor`/`pageOrder`/`encodeCursor`) with `seq` in the `CursorKey`'s
  numeric slot; only `toPage` isn't reused (it mints from a row's `.createdAt`),
  so the one-extra-row split is inlined.
- **Deferrals / accepted scope:** version git-provenance columns + the blob-sha
  reader change → G6b; the `active` pointer + CAS Publish + `pipeline.published` +
  resolve-once bind-to-active → G6c. `repo.disconnected` is deliberately NOT
  emitted (the spec's named set is connect/archive/import/publish; a disconnect
  deletes the `workspace_git` row but the audit rows survive, so the connect
  event is still readable). No historical backfill of pre-G6a connect/archive
  history — the same accepted loss the G2 built-block records.

### G6b built-block (2026-07-24) — git provenance on immutable versions

Second G6 slice: the substrate G6c-1's CAS Publish reads ("publish only from a
DB version whose source commit/blob is known") and the answer to "what is
running, and from where?" (spec line 134).

- **Four NULLABLE columns on `pipeline_versions` (migration 0028):**
  `source_commit`, `source_branch`, `source_file_path`, `source_blob_sha`.
  Stamped ONCE at mint from `CreateResourceOptions` by the workspace-git reconcile
  (`applyWorkspace`), `null` on every NON-git mint (the `POST /api/pipelines/:id/
  versions` route, portable import) and on every pre-G6b row. **NULL is the
  HONEST value, not a fail-open** (#473): absent and `null` mean exactly the same
  thing — "not imported from git" — so no lost fact is masked (unlike a
  manufactured sentinel would). `ADD COLUMN` is native in SQLite and does NOT
  disturb the `0002` immutability triggers (they are `BEFORE UPDATE/DELETE ON`,
  not column-scoped), so provenance is write-once at INSERT and immutable after.
- **Reader**: `GitProvider.lsTreeManaged` (`ls-tree -r -z`) surfaces `{path,
  blobSha}` per managed file; `applyWorkspace` reads the blob at `ref:path` and
  stamps all four together. A git-minted version always has all four (the reader
  lists every file from `ls-tree`, which always carries a blob sha); a non-git
  mint has none — a partial state cannot arise. Excluded from the export envelope
  + the version content-form (`VERSION_VOLATILE`), so a re-pull from a different
  commit is not misread as a content change. Read-tolerant `.default(null)` on the
  schema mirrors `containers` (a stored/exported blob predating G6b legitimately
  carries no provenance key).

### G6c-1 built-block (2026-07-24) — the `active` pointer projection + CAS Publish

Third G6 slice, further split: **G6c-1 = the publish machinery** (this slice);
**G6c-2 = resolve-once bind-to-active** (the trigger-creation convenience that
READS this projection — deferred so it lands on a stable `getActivePublishedVersion`).

- **The `active` pointer is a PROJECTION, never a stored mutable row** (v2
  "Publish must be EVENT-SOURCED"). A new closed-union variant
  `pipeline.published{pipeline, from, to, commit, blob, by}` is appended to the
  `workspace_events` audit log; `getActivePublishedVersion(db, ownerId,
  resourceId)` folds the LATEST such event (by `seq DESC`, the append authority)
  into the current active version. Migration 0029 adds the `(owner_id, type)`
  index the G6a schema comment already promised, so the projection is an index
  range scan, not a log scan.
- **ID-SPACE (deliberate two-space choice):** `pipeline` is the pipeline's stable
  `resourceId` (matches the sibling `pipeline.archived`/`import.applied` events —
  the projection GROUP key), while `from`/`to` are concrete DB pipeline-VERSION
  ids (exactly what a trigger/run binds and what CAS compares). Safe because
  `workspace_events` is a DB-LOCAL log NEVER serialized to git: a version row is
  immutable and never standalone-deleted, so a `to`/`from` id cannot dangle within
  its own DB. G6c-2 will resolve trigger → pipeline DB-id → `resourceId` (one
  `getPipeline` hop) to read the projection.
- **CAS Publish** (`POST /api/pipelines/:id/publish`, body `{toVersionId,
  expectedActiveVersionId}`): `expectedActiveVersionId` is the compare-and-set
  expected-previous active (`null` = "expected never-published"), **REQUIRED, not
  defaulted** — a missing expectation would be a fail-open CAS (#473 shape). Guards
  (all client-safe, ids only): **git-mode** — `getWorkspaceGit` non-null, else 409
  (publish is git-only; a DB-only workspace binds-to-latest, G6c-2); **not
  archived** — else 409; **version owned by THIS pipeline** — else 404 (not-found
  and not-this-pipeline collapse, the authz-leak rule); **git provenance known** —
  `source_commit`/`source_blob_sha` non-null, else 409. The CAS read
  (`getActivePublishedVersion`) + the append run in ONE `db.transaction` (the append
  nests as a SAVEPOINT), so they observe one SQLite snapshot — better-sqlite3's
  single-writer model means no concurrent publish interleaves. A stale CAS → 409
  ("pull/import first"); the spec's "expected-previous active/commit" collapses to
  a version-id CAS (each event carries a 1:1 `to`→`commit`).
- **Idempotent no-op** — re-publishing the already-active version writes NO event
  (`published:false`), the "audit records EFFECT, not attempts" rule from
  `import.applied`. **`GET /api/pipelines/:id/active`** exposes the projection
  (`{active:{versionId,commit,blob}|null}`), deliberately NOT git-gated — a DB-only
  workspace answers `null`, never 404 (the audit-route stance).
- **One 409 error class** `PublishRefusedError` (message-carrying, like
  `BadRequestError`) rather than four near-identical classes; a missing/wrong
  version stays `NotFoundError` (404). **Deferred to G6c-2:** resolve-once
  bind-to-active (trigger creation reads the projection: git-mode → active,
  DB-only → latest version).

### G6c-2 built-block (2026-07-24) — resolve-once bind-to-active on trigger create

The final G6 slice — the trigger-creation CONVENIENCE that reads the G6c-1
`active` projection. Closes G6 (the whole 3-way slice is now shipped).

- **`active` is NEVER a stored trigger binding** (Codex-hardened CORE): a trigger
  always persists a CONCRETE `pipelineVersionId` (#1 immutability + "unbound never
  fires"). "Bind to active" is a creation-time convenience that resolves ONCE
  server-side and stores the resolved id — NOT a live-follow indirection (fire-time
  `bindingMode: follow_active` stays a future, non-default concept, out of scope).
- **Create-only API, separate schema.** `POST /api/triggers` gains a create-only
  `TriggerCreateBodySchema` (`routes/triggers.ts`) accepting EXACTLY ONE of a
  concrete `pipelineVersionId` (a string, or `null` for a deliberately unbound
  trigger — the pre-G6c-2 path, unchanged) XOR `bindToActive: { pipelineId }`. The
  XOR is a `superRefine` keyed on PRESENCE (`!== undefined`), so an explicit
  `pipelineVersionId: null` still counts as "supplied unbound" (the null-vs-absent
  three-state). It is a SEPARATE schema from `TriggerWriteBodySchema` on purpose:
  PATCH (`.partial()` of the latter) stays concrete-only — leaking bind-to-active
  into PATCH would let a patch silently re-resolve a pinned binding.
- **Resolution (`resolveBindToActive`, route-local, owner-scoped).** `getPipeline`
  → `requireOwned` (missing/foreign pipeline → 404, the authz-leak rule).
  **git-mode** (`getWorkspaceGit` non-null) → the G6c-1 `getActivePublishedVersion`
  projection's concrete `.to`; **DB-only** (the git-optional default, no `active`
  pointer) → `getLatestPipelineVersion(pipeline.id).id`. Read OUTSIDE any
  transaction — resolve-once needs no compare-and-set (unlike CAS Publish); it
  snapshots whatever is active/latest NOW into an immutable pin, so a later
  version-mint never retro-rebinds an existing trigger.
- **Fail-closed, not fall-open.** A git-mode workspace with nothing published yet,
  or a versionless pipeline, has nothing to resolve → **400 `BadRequestError`**
  ("publish a version first / no versions"), never a silent unbound trigger and
  never a git-mode fall-back to latest (which would defeat the publish gate). 400
  (not the publish route's 409) mirrors the sibling `assertBindableIfEnabled`
  create-body validation ("enabled but no binding" = 400) — this is a create-body
  validation, not a publish action.
- **Non-goals (deferred, unchanged):** fire-time `follow_active`; G7 readiness
  reconcile; any archived-pipeline create-time guard (a bind to a
  published-then-archived pipeline still resolves its last active / latest — the
  fire-time `ArchivedPipelineError` dispatch guard owns that, identically to a
  concrete bind, so no new guard here); web-client mirroring (`bindToActive` is a
  server-route-local request-only field, deliberately NOT in shared
  `NewTriggerSchema` — no UI consumer until the post-P7 Git UI section).

### G7 built-block (2026-07-24) — trigger-binding reconcile: resolved-space content compare

The "absent → disabled" trigger-binding reconcile was ALREADY built in G5c-2
(#670): `resolveTriggerBinding` remaps a branch trigger's binding resourceId →
DB id, an unresolved id folds to `null`, and `buildTriggerWriteInput`
force-disables an unbound trigger. What G7 adds is the READINESS reconcile that
makes that force-disable IDEMPOTENT — the documented perpetual-`update` churn
G5c-2 left for G7, which is exactly #668 ("is `enabled` authoring content or
local-readiness?").

- **#668 RESOLVED: `enabled` STAYS authoring content** in the shared
  `triggerContentForm` — NOT excluded like `requiresSecret`. A pre-PR planner pass
  proved the churn's real driver is the dangling BINDING field, not `enabled`:
  the compare was `triggerContentForm(rawIncoming)` (binding = the absent
  resourceId) vs `dbTriggerContentForm(existing)` (binding force-resolved to
  `null`) — they differ on the BINDING regardless of `enabled`, so excluding
  `enabled` would have fixed nothing and needlessly dropped authored
  enable/disable propagation for healthy bound triggers.
- **The fix is a RESOLVED-SPACE compare, one layer up from the shared form.** New
  server module `server/src/portability/trigger-content.ts`:
  `normalizedTriggerContentForm(data, resolves)` normalizes an incoming trigger
  whose binding does not resolve to `(null, disabled)` — exactly what the apply
  persists — BEFORE computing the raw `triggerContentForm`. The DB side needs no
  normalization (`serializeTrigger` already renders a stored null binding as
  `null`, a bound one via the all-versions map). `enabledForBinding(hasBinding,
  authored)` is the SINGLE definition of the unbound⇒disabled rule, shared by
  `normalizedTriggerContentForm` and `buildTriggerWriteInput` so the persisted row
  and the content compare can never disagree. A genuine enable/disable on a BOUND
  trigger still differs → still propagates.
- **Two loci, one predicate.** LOCUS 1 = the APPLY (`workspace-apply.ts` update
  path, the correctness site pinned by the characterization test) resolves via its
  in-scope `versionById` (owner versions ∪ in-batch mints). LOCUS 2 = the PREVIEW
  classifier (`classifyWorkspace`, advisory) gains a REQUIRED `ownedVersionRids`
  param (no fail-open default) and unions it with the branch's own to-be-minted
  version ids; the preview route + the apply's plan-build both pass
  `listVersionResourceIds(db, ownerId)`.
- **`listVersionResourceIds` = the apply's `versionById` domain 1:1** — ALL
  versions of ALL owner pipelines INCLUDING archived (`listPipelines` has no
  archived filter). It CANNOT be derived from the serialized DB snapshot, which
  carries only the LATEST version per pipeline and omits archived pipelines — a
  trigger pinned to a non-latest/archived-pipeline version must resolve and stay
  bound (tested), else the fix would OVER-disable.
- **Scheduler invariant unchanged, only re-proven.** `isSchedulable` is
  DELIBERATELY not gated on the binding (schedule-tick.ts: eligibility is about
  scheduling; FIRING re-checks the binding via the `trigger_unbound` suppression).
  The reconcile's force-disable (`enabled:false`) keeps an unbound trigger out of
  `isSchedulable`, so `sync()` arms nothing — pinned end-to-end by a new
  `scheduler.test.ts` case (import an absent-bound trigger → disabled → no wakeup).
- **#674 (webhook secret-PRESENCE) stays G8.** It is a genuinely separate
  non-idempotency (differs even for a bound+enabled trigger) and is the secret
  gate's charter, not the binding reconcile's.

### G9b built-block (2026-07-24) — GitHub REST auto-open + PR-observe

G9a shipped the persisted `working_branch` (feature-branch selection) + the
GUIDED-MANUAL PR (a GitHub compare URL, or `unknown`+`null` for a local/non-GitHub
remote). G9b adds the `mode:'opened'` path: studio opens (or observes an existing)
PR via the GitHub REST API when it can, guided-manual stays the fallback.

- **Auto-open fires ONLY for `github.com` WITH an operator-env token.** The token
  is resolved once at wiring (`index.ts`): `GH_TOKEN ?? GITHUB_TOKEN` (`gh`-CLI
  precedence), overridable per-call for tests; normalized in the route to
  `(token ?? '').trim() || null` so an empty/whitespace value counts as ABSENT
  (→ guided-manual, never an empty-`Bearer` attempt). Auth model unchanged from
  G2: the operator's own environment, **NO stored PATs** — those + multi-remote +
  a non-github host API are G10. The token is never stored, never client-supplied,
  never logged; it rides ONLY the outbound `Authorization` header.
- **`POST /repos/{owner}/{repo}/pulls`** (owner/repo `encodeURIComponent`'d) with
  `{ title, head, base, body }` (server-generated title/body — no client-
  customizable PR metadata in v1). `201` → `mode:'opened'` with the PR's
  `html_url` + `number`. The response is VALIDATED (`number` a positive int,
  `html_url` non-empty) before it is trusted — a malformed payload fails loudly,
  never a manufactured result (#473 posture; `number` is REQUIRED-nullable on
  `PullRequestResultSchema`, `null` for guided-manual).
- **PR-observe = idempotency.** A `422` whose `message`/`errors[].message` says a
  PR "already exists" → `GET …/pulls?state=open&head={owner}:{branch}&base={base}`
  (head/base query values encoded) → the first open PR, returned as `opened`. An
  EMPTY observe result (the PR was merged/closed in the race) fails HONESTLY
  (`GitHostApiError`) — never a crash on `[0]`, never a null-url `opened`.
- **Error posture, two classes.** `GitHostApiError` (network / timeout / auth /
  5xx / malformed / lost-observe) → 502 `git_error` (the upstream-failure surface
  a `GitOperationError` gets). `GitHostRequestError` (a `422` that is NOT
  already-exists — e.g. "No commits between base and head", a legitimate
  request-STATE refusal, nothing to PR) → 409 `conflict` (the `PublishRefusedError`
  surface), NOT a 502. Both messages are GitHub-authored + `redactSecrets`'d for
  the token; both `instanceof` branches precede the numeric-statusCode/500
  fallthrough in `errors.ts`.
- **No-hang rail.** Every request is bounded by an `AbortController` whose timer
  stays armed across BOTH the `fetch` AND the `res.json()` body read (undici ties
  the body stream to `signal`) — a headers-arrive-then-body-stalls response is cut
  short as a timeout, not left to hang (the exact bug a clear-timer-before-body
  would introduce, pinned by test).
- **Seam parity.** `GitHostClient` (server `git/github-host.ts`, default
  `GitHubHostClient` over Node `fetch`) mirrors the G2 `GitProvider` seam: injected
  via `buildApp`'s `workspaceGitHostClient` / route `hostClient` option, faked in
  tests (a scripted `fetch`, no network). `resolvePullRequestTarget` (shared) is
  the SINGLE source of github-detection + compare-url; `buildGuidedManualPullRequest`
  delegates to it (pinned so the two can't drift). The route stays OUT of the
  per-owner `KeyedQueue` — a pure DB read + a bounded outbound call, no
  checkout/index mutation.

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
