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

## Ticket decomposition (G-series, ordered; each ≈ a fire)

| # | Ticket |
| --- | --- |
| G1 | Git-friendly file layout + per-resource serialize (config-only connections) |
| G2 | `workspace_git` config + connect-repo (local repo first; remote/auth next) |
| G3 | Commit-to-working-branch (Save) with author/message |
| G4 | Pull/import collaboration branch → new versions + upsert (idempotent, secret-safe) |
| G5 | `active` version pointer + Publish (promote) + default-bind-to-active |
| G6 | PR open/observe via git-host API (GitHub first) — else guided manual |
| G7 | Secret-reconcile on import (needs-secret disabled state + supply flow) |
| G8 | Multi-remote / auth polish; conflict + divergence handling |

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
