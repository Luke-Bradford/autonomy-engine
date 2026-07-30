# Packaging and in-app updates — design

**Status:** design, approved 2026-07-30 (operator). Supersedes nothing; extends `#409 P7`.
**Related:** `#409` (P7 packaging), `#410` (cutover), `2026-07-24-bun-single-binary-spike.md`,
`loop/install_studio_server.sh` (the existing supervised-service installer).

## Why

Studio runs today in three ways: `pnpm dev`, a supervised launchd service (`#765` Defect 2), and a
Docker container. All three are operated from a terminal. The operator's requirement:

> a user-friendly way of running this that doesn't involve running scripts … clicking their way in

with a stated direction of travel toward **a team using it**, and updates that are **on demand with a
notification**, not scheduled.

This document covers the decisions that are cheap now and expensive later. It deliberately does NOT
design login, RBAC, or Windows/Linux packaging — it establishes the seams those slot into.

## The framing that simplifies everything

**Installation is gated to a machine only some people can reach.** Users are browser clients; they
install nothing.

That removes most of the packaging problem: no per-user installer, no Gatekeeper prompt for every
team member, no mobile app. One server, many browsers — which is also the shape an enterprise
deployment takes, so the personal setup and the team setup are the same architecture at different
scales.

Consequence: **code signing is not on the critical path.** It matters when strangers download the
installer, not when a trusted admin installs on a controlled machine. Deferred without blocking.

## TWO different git concerns — do not conflate them

This document is about **updating the application**. It is NOT about the repo that holds a user's
pipeline definitions. Both involve git and both are called "publishing", which is exactly why the
distinction is written down here rather than assumed.

| | **App updates** (this document) | **Workspace git** (already built, G-series) |
| --- | --- | --- |
| What moves | the studio application code | the user's pipelines, connections, triggers |
| Source | studio's own releases | the **customer's** repo, any host |
| Mechanism | download artifact, verify, swap `app/`, restart | `git fetch` + transactional reconcile into the DB |
| Who triggers | an admin, on demand | authors (Commit / Publish); the server (import) |
| Where it lands | `app/` | `state/` — DB rows, plus the clone in `state/git/` |
| Restarts the server? | yes | **never** |
| Status | this design | largely shipped: G2, G3a, G4, G5b/c, G6, G7, G9 |

The workspace-git flow is the ADF model and already exists end to end: developers edit and push, the
server fetches and reconciles, and CAS Publish moves the `active` pointer that triggers bind to.
Surface: `/api/workspace/git/{import, import-preview, commit, fetch, drift, divergence,
pull-request, working-branch, token}`. See `2026-07-14-foundation-git-publish.md`.

**The two are independent by construction, and the layout below is what enforces it:** an app update
replaces `app/` and never touches `state/`, so it cannot disturb a workspace clone, its working
branch, or any imported version. Conversely a workspace import writes only DB rows and `state/git/`,
and never restarts anything.

**One consequence worth stating:** because `state/` survives updates, a repo a server is pointed at
stays pointed at across an app update. Re-pointing is a workspace-git operation, never an install
operation.

Remaining workspace-git work (G8 secret-readiness reconcile, G10 non-GitHub hosts / multi-remote,
`#692`) is tracked separately and is not affected by anything in this document.

## Goals

1. An admin installs by double-clicking, not by typing.
2. Anyone with access uses a browser — no client install, ever.
3. Updates are **on demand**: the app says one is available, shows what changed, and an admin applies
   it with a click.
4. An update that fails is recoverable without a terminal.
5. Nothing in this design blocks authentication, multi-user, or other platforms later.

## Non-goals (deliberate, and each has a named seam)

| Not doing | Why it is not blocked |
| --- | --- |
| Login / SSO | `auth/principal.ts` already isolates principal resolution and threads `ownerId` through every repo call. Auth replaces one function. |
| RBAC | Same seam; roles attach to the principal. |
| Windows / Linux installers | The bundle layout and update protocol below are OS-agnostic; only the installer and service manager differ. |
| Code signing / notarisation | Needed to distribute to strangers, not to install on a gated machine. Add when that changes. |
| Scheduled auto-update | Explicitly rejected — see "Why on-demand". |
| Single-binary distribution | Deferred by the Bun spike: `better-sqlite3` is a native addon and escaping it forks dev/prod. Bundling a Node runtime is therefore assumed throughout. |

## Why on-demand, not scheduled

A scheduled updater must not interrupt a running pipeline, so it needs an interlock that skips while
runs are active — which then needs starvation handling for when runs never stop, and a rule about
avoiding the loop's 03:05/21:05 windows.

A human choosing the moment removes all three. On-demand is less machinery *and* better behaviour:
the person applying the update can see what is running.

## The five load-bearing decisions

Everything else in this document is mechanism. These are the parts that are cheap to get right now
and painful to retrofit.

### 1. Release identity

`/health` currently returns `{"ok":true}`. It carries no version.

Without an identity you cannot answer "what am I running", cannot compare against the latest, cannot
show patch notes, and cannot audit an upgrade. **Every other feature here depends on it.**

Add `GET /api/version`:

```json
{ "version": "0.4.2", "commit": "e93ebf8", "builtAt": "2026-07-30T09:12:44Z", "arch": "arm64" }
```

Baked at build time (not read from git at runtime — a packaged install has no git). `/health` stays
a bare liveness probe; version is a separate concern with a separate consumer.

### 2. Updates are an API, not a script

This is the difference between a personal tool and something a team operates.

**A process cannot cleanly restart itself.** So the server never tries:

```text
UI            POST /api/update/apply { version }
server        validates, writes state/update-request.json, returns 202 immediately
updater agent launchd WatchPaths on that file wakes it
              downloads the artifact, verifies checksum
              swaps app/  (previous kept as app-previous/)
              restarts the service, polls /health
              writes state/update-result.json, emits an update event
UI            polls /api/update/status, shows success or failure + how to roll back
```

The agent is a separate launchd unit with a single job. It is the only component that may replace
`app/`, which keeps "what can mutate the installation" answerable.

### 3. The release manifest carries the notes

CI publishes, alongside each artifact:

```json
{ "version": "0.4.2", "commit": "e93ebf8", "arch": "arm64",
  "sha256": "…", "url": "https://…/studio-0.4.2-arm64.tar.gz",
  "notes": "### Fixed\n- an edge naming a non-existent id is refused (#786)\n…" }
```

**Patch notes are then free** — the update-available banner renders `notes`. Retrofitting this later
means every historical release lacks notes permanently, so the field goes in from the first release
even while it is generated crudely (initially: the squashed commit subjects since the previous tag).

### 4. Rollback is a designed path

The previous `app/` is retained as `app-previous/` for exactly one generation. Rollback is a
directory rename plus a service restart — it reuses the swap-and-health-check half of the update
agent, but skips download and checksum verification, since the artifact is already on disk and was
already verified when it was installed.

Exposed as `POST /api/update/rollback`, and printed in the failure notification so it is discoverable
at the moment it is needed rather than in documentation nobody has open.

### 5. Update events are recorded from day one

Studio is event-sourced. Every update attempt records who requested it, from and to which version,
and the outcome.

No audit UI is needed today. What is needed is that **the history exists** when someone asks
"when did this change and who did it" — which cannot be reconstructed after the fact.

## Installation layout

Code and state are separate directories, which is what makes a wholesale swap safe:

```text
~/Library/Application Support/autonomy-studio/
  app/                  ← replaced wholesale by an update
    node                    bundled runtime (pinned; see tradeoffs)
    dist/                   server build
    web/                    web build
    manifest.json           identity of THIS install
  app-previous/         ← one generation, for rollback
  state/                ← NEVER touched by an update
    app.sqlite              runs, pipelines, connections
    master.key              secrets
    git/                    workspace clones
  update-request.json   ← the marker the agent watches
  update-result.json    ← outcome of the last attempt
```

`loop/install_studio_server.sh` already separates code from state for the supervised service, so this
follows an established shape rather than inventing one.

## First install

A macOS `.pkg`, user-domain (no admin password), which:

1. writes `app/` and an empty `state/`,
2. installs two launchd agents — the service and the updater,
3. starts the service and waits for `/health`,
4. opens the browser at the local URL.

**The `.pkg` handles first install only.** Every subsequent update uses the tarball path above, so
there is one update mechanism rather than two.

## CI

A release workflow that, on a tag:

1. builds server + web,
2. bundles a Node runtime **per architecture** (`arm64`, `x86_64` — see tradeoffs),
3. writes `manifest.json` with version, commit, arch, checksum, notes,
4. publishes artifacts and manifest to a GitHub Release.

This does not exist in any form today and is a prerequisite for the update path — there is nothing to
update *from* without it, which is why a minimal version of it lands in Phase 1 rather than Phase 2.

## Stated tradeoffs

- **Bundling a Node runtime pins it.** Runtime security updates become your releases, not the OS's.
  Accepted: the single-binary alternative was already deferred, and an unpinned runtime means an
  install that breaks when the machine's Node changes underneath it.
- **`better-sqlite3` is a native addon**, so artifacts are architecture-specific. The updater must
  select by arch and refuse a mismatch loudly rather than installing something that will not boot.
- **Unsigned works for a gated machine, not for strangers.** Stated so the boundary is explicit.
- **`app-previous/` doubles the install footprint.** Accepted: rollback without a terminal is worth
  more than the disk.
- **On-demand means an install can sit out of date indefinitely.** Accepted — that is the operator's
  choice, and the banner makes it visible rather than silent.

## Phasing

Ordered so something is visible early rather than after the whole thing lands.

**Phase 1 — identity, and a release to compare against.** `GET /api/version`, `manifest.json` baked
at build, the version shown in the UI, a **minimal CI release job** that publishes the manifest, and
an "update available" banner that compares the two. No updating yet — the banner links to the release
and says how to update by hand.

The release job is in Phase 1 rather than Phase 2 deliberately: an update-available check has nothing
to check against without it, so splitting them would make Phase 1 untestable end to end. It is the
smallest slice that is *visibly true* rather than merely coded.

**Phase 2 — the update path.** The updater agent, `apply`, `rollback`, update events, and the UI to
drive them. This is the bulk of the work, and it is where the marker-file mechanism lives.

**Phase 3 — first-install packaging.** The `.pkg`, both agents, browser launch.

**Phase 4 (later, not specified here) — the desktop shell.** A menu-bar/taskbar app, cross-platform.
Reuses the bundle layout and update protocol unchanged; it becomes a UI over an API that already
exists, which is the point of doing 1–3 in this order.

## Open questions

1. **Version scheme.** Semver implies a compatibility contract nobody is maintaining yet. Suggest
   date-based (`2026.07.30`) until a real API contract exists, then semver.
2. **Update channel.** Only "latest" is specified. A `stable`/`edge` split is easy to add to the
   manifest later and is not needed while there is one operator.
3. **Notes generation.** Squashed commit subjects since the previous tag are enough to start;
   curated notes can replace them without changing the manifest shape.
