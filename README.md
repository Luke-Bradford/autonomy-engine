# autonomy-engine

Repo-agnostic engine for running Claude Code (and, in future, other CLI agents) autonomy loops
against any target repo, from one operator's account.

## Quickstart

One command, from a fresh checkout:

```bash
./start                      # detects: setup needed, or just run the app
./start /path/to/target-repo # first time: guided setup for that repo, then the app
```

`./start` looks at `~/.config/autonomy/repos`: nothing registered → setup guidance
(with a target argument it chains the guided quickstart and registers the repo);
something registered → loop-state summary (`bin/control.sh list`) and the
control-room dashboard. It never runs `launchctl` — loading a supervisor stays a
deliberate step (`bin/control.sh start`, or the printed go-live lines).

Under the hood, the guided setup is:

```bash
bin/quickstart.sh /path/to/target-repo
```

It scaffolds the `.autonomy/` pack, walks you through the minimum config
(board owner/title, model, merge-gate strategy — Enter keeps the shown value;
writes are comment-preserving), runs the doctor report, offers to create the
dedicated worktree + launchd plist, offers to register the repo for the
dashboard, and prints the exact go-live commands. It **never runs `launchctl`
itself** — loading the supervisor stays a deliberate operator step.

Idempotent: re-run it any time; pressing Enter everywhere changes nothing.
Every prompt has a flag twin (`--board-owner`, `--board-title`, `--model`,
`--merge-gate`, `--worktree yes|no`, `--register yes|no`) for non-interactive
use.

Under the hood it runs the same tools you can drive by hand:

```bash
# 1. Scaffold a new target repo's pack:
bin/onboard.sh /path/to/target-repo
# edit /path/to/target-repo/.autonomy/config.yaml

# 2. Check it's ready:
bin/doctor.sh /path/to/target-repo

# 3. Create its dedicated worktree + launchd plist:
bin/setup_worktree.sh /path/to/target-repo

# 4. Load it (see setup_worktree.sh's own printed next-steps for the exact commands)
```

## Prerequisites / replicating on a new machine

The engine's supported host is **macOS**: it uses `launchd` (background loops),
the **Keychain** (API-key storage), and targets the stock **`/bin/bash` 3.2.57**
floor. Config parsing and all helpers are **Python 3 stdlib only** — no PyYAML,
no third-party packages. Those four are non-negotiable; everything below is
per-feature and `bin/doctor.sh <repo>` reports each one (diagnostic-only — it
warns, never blocks or provisions).

| You want… | Requires | doctor line |
| --- | --- | --- |
| **Core loop** (coder drains the board) | `gh` authed with the **`repo`** scope; `claude` CLI logged in (subscription) *or* an API account in the credentials registry | `WARN gh token missing 'repo' scope` / `WARN gh auth status failed` |
| **Board sync** (Projects v2) | `gh` token also carries the **`project`** scope (default `gh auth login` often omits it → `gh auth refresh -s project`); `board.owner` + `board.project_title` set | `WARN gh token missing 'project' scope`; `WARN board '…' not found` |
| **Review gate** (`merge_gate.strategy: bot_comment`) | the review workflow installed under the target repo's `.github/workflows/`; the **`ANTHROPIC_API_KEY`** secret set **in that repo** (`gh secret set ANTHROPIC_API_KEY`) | `WARN no review-bot workflow found`; `WARN ANTHROPIC_API_KEY secret not found` |
| **`gh_review` gate** | branch protection on `main` with required reviews | `WARN no branch protection detected on main` |
| **Installing/updating** the review or QA workflow | `gh` token also carries the **`workflow`** scope (setup-only — the running loop never pushes workflows) | `INFO gh token has no 'workflow' scope` |
| **Codex roles** | `codex` CLI installed + logged in (ChatGPT) | (adapter-checked at dispatch) |
| **Local-LLM roles** (`openai_compatible`) | a local OpenAI-compatible endpoint (Ollama / LM Studio) reachable from the role's configured host | (adapter-checked at dispatch) |

`gh auth refresh -s repo,project,workflow` grants all three GitHub scopes at
once. `bin/quickstart.sh` runs `doctor.sh` as step 3/6, so these same checks
surface during guided onboarding.

## Run model & health

Two tiers of process, deliberately different lifetimes:

- **The loops are background services.** Each registered repo's supervisor runs under
  **launchd** (the plist `setup_worktree.sh` installs), so it survives closing your
  terminal and, with `KeepAlive=true`, is **relaunched if it crashes**. Loading one is a
  deliberate step — `bin/control.sh start <repo>` (or the go-live lines quickstart prints).
  This is the tier that does the engineering.
- **The dashboard is a managed service too.** `./start` (with repos registered) loads
  `bin/dashboard.py` as a **launchd service** (`com.autonomy.dashboard`) and opens the
  browser — so it survives closing your terminal and restarts on crash/reboot, just like the
  loops. Stop it with **`./start stop`** (booting the service out is the only thing that
  actually stops it under `KeepAlive`); check it with `./start status`. Two opt-outs when you
  don't want a service: **`./start --foreground`** runs it in this terminal (Ctrl-C stops it;
  the loops are unaffected — they're separate services), and **`./start --no-launch`** just
  prints the command without running anything. For a single terminal-native window onto the
  live work log instead, **`./start console`** runs the engine as one foreground service.

So the everyday model is: **loops run unattended under launchd; `./start` brings up the
dashboard service and opens it; `./start stop` takes the dashboard back down.**

**Is it healthy?** Two read-only checks, no side effects:

```bash
./start status        # one-screen OK/WARN report, then exits
bin/control.sh list   # per-repo loop state: running / paused / stopped
```

`./start status` reports the dashboard process (is one running?), `gh` auth, how many repos
are registered, **each registered loop's running / paused / stopped state** (folded in from
`bin/control.sh list` so you don't need a second command), any BYO-LLM local endpoint's
reachability (see [BYO-LLM](docs/byo-llm.md)),
and **loop-worktree cleanliness** — it WARNs when a registered worktree is left dirty while
its loop is *not* running (a finished loop should leave a clean tree), or when a worktree is
uninspectable or the registry unreadable (surfaced, never reported healthy — fail-safe). It
binds no port and runs no `launchctl`; health lives in the text, not the exit code.

> **Note — health signal.** `./start status` is the read-only health story today. A live
> health strip *inside* the dashboard header (server up? loop stuck? worktree dirty? endpoint
> down?) is still open on [#81](https://github.com/Luke-Bradford/autonomy-engine/issues/81),
> pending a decision on where health-truth is owned (the shell `status` report vs. the Python
> dashboard vs. a shared module).

Starting, pausing, and hard-stopping the loops — one repo or all of them — is the
[Lifecycle](#lifecycle-start--graceful-stop--hard-stop) section below.

## The `.autonomy/` pack contract

Every target repo needs a `.autonomy/` directory with exactly these three files:

- **`loop_prompt.md`** — the standing task, passed as the primary prompt (`claude -p`).
- **`hard_rules.md`** — non-negotiable safety rules, appended to the session's system prompt.
- **`config.yaml`** — project policy (see schema below). `bin/onboard.sh` scaffolds all three from
  `templates/autonomy-pack/`.

`.autonomy/config.yaml` existing and parsing is the engine's hard requirement for treating a
directory as a valid target repo — `doctor.sh`/`supervisor.sh` both refuse to proceed without it.

## `config.yaml` schema

```yaml
board:
  owner: <github-user-or-org>
  project_title: "<Projects v2 board title>"

engine:
  label: <slug>                # optional; disambiguates two repos sharing a basename
  requires_claude_md: <bool>    # hard-fail (not just warn) if .claude/CLAUDE.md is missing
  account_key: <key>            # optional; which account's shared usage-limit marker this
                                # repo participates in (default: "default" -- all repos on
                                # this machine share one account's rate-limit state)

agent:
  type: claude                  # claude | codex
  model:
    primary: <model-id>
    fallback: <model-id>
  config: {}                    # opaque, adapter-owned pass-through (unused by the claude adapter)

merge_gate:
  strategy: manual | ci_only | bot_comment | gh_review
  author_login: <string>        # bot_comment only
  marker: <string>               # bot_comment only
  doc_only_extensions: [<ext>]   # bot_comment only, e.g. [".md"]
  reviewer_login: <string>       # gh_review only

worktree:
  default_path: "../.{repo-slug}-autonomy"  # worktree path: positional arg overrides, {repo-slug} substituted
```

Every value is either optional-with-an-engine-default or required-only-for-the-strategy-that-uses-
it. Nothing in the engine hardcodes any one repo's actual values.

`{repo-slug}` = `engine.label` if set, else the target repo's directory basename, lowercased,
non-alphanumeric runs collapsed to `-`.

### Role triggers (scheduling)

An optional `roles:` block runs a multi-role roster (see the agent-org spec for the full schema).
Each role has a `trigger.type`:

- **`loop`** — the supervisor round-robins enabled loop roles, one session per iteration (the coder
  default).
- **`cron`** — the supervisor fires the role on its `schedule` (standard 5-field cron, UTC /
  GitHub-Actions semantics), reusing the same headless dispatch path under the held per-repo lock.
  Firing granularity is **loop-cadence** — a role becomes due on the first loop iteration at or
  after its scheduled time, not to-the-second. First start (or after downtime) initialises each
  role's marker **without** a catch-up fire. The supervisor is the sole writer of the per-role
  last-fire marker (`<repo>/var/cron/<role>.last_fire`); adapters never persist scheduling state.
- **`event`** — the supervisor gh-polls board/PR state each loop iteration and wakes the role when
  a new item appears for one of its `on:` events (`pr.opened`, `pr.synchronize`, `issue.created`,
  `merge.done`, `session.done`). So QA (`on: [pr.opened, pr.synchronize]`) reacts to a Coder's PR
  without either knowing the other — choreography emerges. Delivery is at-least-once within the poll
  page (loop-cadence latency); the supervisor is sole writer of the per-`(role, event)` seen-set at
  `<repo>/var/events/<role>__<event>.seen`, and first start seeds the baseline without a catch-up
  fire. `session.done` fires an event role after a loop session completes.

```yaml
roles:
  qa:
    enabled: true
    trigger: { type: event, on: [pr.opened, pr.synchronize] }
```

```yaml
roles:
  researcher:
    enabled: true
    trigger: { type: cron, schedule: "0 3 * * *" }   # daily 03:00 UTC
```

## Merge-gate strategies

CI-green is checked first (any failing/pending check refuses; a `gh` API failure itself refuses,
never treated as green; `ci_only` additionally refuses on zero configured checks). Then:

| Strategy | What it checks |
|---|---|
| `manual` (default) | Nothing further — never auto-merges. PRs stay open for a human. |
| `ci_only` | Nothing further — CI green is the whole gate. |
| `bot_comment` | Latest matching issue comment (by `author_login` + `marker`) postdates the head commit and reads APPROVE, no BLOCKING/REQUEST CHANGES. Includes a doc-only fast path for PRs where every changed file matches `doc_only_extensions`. |
| `gh_review` | Latest GitHub Review object from `reviewer_login` postdates the head commit and its `state == APPROVED`. |

`bin/safe_merge.sh <pr-number>` is the only sanctioned merge path — the loop must never call
`gh pr merge` directly.

## `bin/` reference

| Script | Purpose |
|---|---|
| `../start [target-repo] [--port N] [--no-launch]` | THE entry point (repo root): setup-or-app detection — guided quickstart on first run, loop-state summary + dashboard after |
| `supervisor.sh --repo <path> [--agent-type] [--model] [--fallback-model] [--label]` | The main loop launchd runs |
| `quickstart.sh <target-repo> [flags]` | Guided single-entry onboarding: onboard → minimum config → doctor → optional worktree → optional dashboard registration → printed go-live commands (never runs `launchctl`) |
| `control.sh list \| register \| unregister \| start \| stop \| pause \| resume` | Multi-repo control unit over `~/.config/autonomy/repos`: loop states from the supervisor's own lock/sentinel, start/stop via `launchctl` against the installed plists, graceful pause/resume via the sentinel. `--all` fans out. Never provisions |
| `onboard.sh <target-repo>` | Scaffold `.autonomy/` (idempotent) |
| `doctor.sh <target-repo>` | Full readiness report (network calls; diagnostic-only, never provisions) |
| `setup_worktree.sh <target-repo> [worktree-path]` | Create/reuse the dedicated worktree + install the launchd plist |
| `worktree_gc.sh --repo <path>` | Prune stale worktrees + merged branches |
| `safe_merge.sh <pr-number>` | The only sanctioned merge path |
| `board.sh status <issue#> "<status>" \| add <issue#>` | Best-effort GitHub Projects v2 board updates |
| `unblock_dependents.sh <merged-pr-number>` | Post-merge "blocked by #X" notifier |
| `dashboard.py --repo <path> [--repo …] [--port 8787]` | Control-room page. Stdlib HTTP+SSE, **binds 127.0.0.1 only**. Renders the engine's emitted artifacts (session logs, `supervisor.log`, git/gh, config, quota); lifecycle controls (start / graceful-stop / hard-stop / resume) via a token-guarded POST |
| `agents/claude.sh` | The Claude Code agent adapter |
| `agents/codex.sh` | The Codex agent adapter (safety text prepended to the prompt; engine-level fallback retry) |

## Lifecycle: start / graceful-stop / hard-stop

Three levers, distinct on purpose:

- **Start (hard) / stop (hard):** `launchctl bootstrap` / `launchctl bootout` the plist
  `setup_worktree.sh` installed. Hard-stop kills the supervisor process; a mid-session hard-stop
  interrupts the running agent.
- **Graceful-stop (pause):** create the sentinel file
  `<target-repo>/var/autonomy-logs/autonomy-PAUSE`. The supervisor checks it at the *top* of the
  loop, so the current session always finishes — never a mid-session kill — then idles (polling
  every `PAUSE_POLL`=30s). It logs the pause once to `supervisor.log`.
- **Resume / start-if-stopped:** remove the sentinel; the supervisor logs "resuming" and continues.
  (Under launchd `KeepAlive=true`, exiting on pause would just be relaunched — idling is the only
  stop that holds, which is why graceful-stop pauses rather than exits.)

The dashboard's graceful-stop / resume controls (issue #10) drive this sentinel.

All three levers are also available across every registered repo at once through
`bin/control.sh` (`start`/`stop` wrap `launchctl` against the installed plist;
`pause`/`resume` wrap the sentinel; `--all` fans out over `~/.config/autonomy/repos`).

## Usage-limit backoff (account-shared)

When a session hits the account rate limit, the agent adapter *extracts* the
API-reported reset epoch and the supervisor *persists* it (that split is an
invariant) — to the repo-local `var/autonomy-logs/.last_usage_reset` **and** to an
account-shared marker `~/.config/autonomy/usage-reset.<account_key>`, so parallel
supervisors on the same account back off together instead of each rediscovering the
wall. Waits use the **latest** valid epoch across both files; garbage/stale/torn
markers are ignored per-file (fail-safe), and a clean session clears both. Repos on
different accounts set `engine.account_key` to keep their markers separate.

## Fingerprint gate (zero-token idle)

Before dispatching a loop-role session the supervisor computes a sha256
fingerprint of the observable world — open issues (number + `updatedAt`), open
PRs (number + head + `updatedAt`), the remote default-branch head
(`ls-remote --symref origin HEAD` — never a hardcoded branch name), every
`.autonomy/` pack file plus the role's resolved prompt file, the config
overlay, and the CLI override set. If it exactly matches
the fingerprint recorded when a previous session for that role **completed
cleanly**, the session is skipped (zero LLM tokens) and the loop idles on a
growing schedule (120s → 300 → 900 → 1800 cap, reset by any real session;
capped at 300s while cron/event roles are declared so their resolvers keep
their cadence). Every doubt — a `gh`/git failure, a page-cap hit, a pending
one-shot model override — refuses the skip and the session runs as before:
staleness costs tokens, never buried work. The idle is pause-aware
(`PAUSE` sentinel honoured within one poll), and skips are narrated as
`fingerprint-idle` heartbeats. (#318)

## Control room (P1 dashboard)

```bash
bin/dashboard.py --repo /path/to/worktree [--repo /another] [--port 8787]
# open http://127.0.0.1:8787/
```

`--repo` can be omitted: discovery falls back to the `AUTONOMY_DASHBOARD_REPOS`
environment variable (newline-separated paths), then to `~/.config/autonomy/repos`
(one path per line — `quickstart.sh`'s register step appends here). CLI `--repo`
always wins.

A single self-contained local page — stdlib HTTP + SSE, **localhost-bind only**, no build step.
It exposes what the engine already emits, nothing invented:

- **Now** — each repo's current worker: working / idle / paused / stopped (working-vs-idle is the
  freshness of the session log, not the lock pid), current step, in-flight ticket, elapsed.
- **Repos & roles** — the multi-role roster (Coder live; PM/QA/Researcher shown per
  [docs/agent-org-design.md](docs/agent-org-design.md), rendered even before they're built).
- **Activity** — tree / timeline / tally over the session's stream-json tool calls (subagents
  nest by `parent_tool_use_id`).
- **Account quota** — real 5-hour and weekly `utilization` from `rate_limit_event`s.
- **Throughput** — server-sampled output tok/min over wall-clock (flatlines when idle).
- **Supervisor voice** — the loop's own decisions, tailing `supervisor.log`.
- **Git in flight** — open PRs (CI / review / mergeable) + recently-merged tickets.
- **Concierge** — a token-free chat box (`POST /api/chat`) that answers whole-system questions via
  a **local** LLM, so idle Q&A never spends cloud subscription tokens. It uses a registered
  `openai_compatible` account (e.g. Ollama); with several registered, set
  `AUTONOMY_CONCIERGE_ACCOUNT=<name>` to choose which one answers (unset = the first registered).
  The account that replied is echoed in each response; a set-but-unknown name is refused, not
  silently swapped.

**Lifecycle controls** (per running/stopped repo, in the Now cards): start / graceful-stop / hard-stop
/ resume. Behind `POST /api/control`, which requires a per-process token embedded in the served page
(defeats cross-origin / DNS-rebinding drive-by) and only ever acts on a managed repo — **lifecycle
only, never a target repo's trade/order path**. Hard-stop and start prompt for confirmation; start
never auto-fires. graceful-stop/resume drive the `autonomy-PAUSE` sentinel; hard-stop/start drive
`launchctl bootout`/`bootstrap` on the repo's installed plist.

Design + the research behind it: [docs/dashboard-design.md](docs/dashboard-design.md),
[docs/control-room-research.md](docs/control-room-research.md). Dark/light toggle.

## Agent adapters

`bin/agents/<type>.sh`, dispatched by `agent.type`. Each implements two functions:

- `agent_invoke(prompt_file, safety_file, model, fallback_model, log_file) -> exit code`
- `agent_classify_outcome(log_file, exit_code) -> "success" | "usage_limit [epoch]" | "error"`

Two adapters exist: `claude.sh` and `codex.sh`. Codex's CLI differs structurally, and the
adapter absorbs every difference so `supervisor.sh` needs no changes:

- **No system-prompt-append flag** — the safety text (`hard_rules.md`) is *prepended* to the
  prompt, ordering guaranteed by the adapter.
- **No native fallback-model support** — the adapter retries once with `agent.model.fallback`
  on a non-limit failure. A usage-limit failure never burns the fallback (the limit is
  account-global).
- **Its own `--json` JSONL schema** — classification parses error envelopes (structured
  code/message) and `rate_limits` snapshots (`resets_at` in epoch-s/ms/ISO,
  `resets_in_seconds`); agent *content* is never parsed.

**Codex validation caveat:** the flag surface and field names are verified against
codex-cli 0.136.0 (`--help` + binary introspection) and the parsers are fixture-tested, but
the exact rate-limit event a real 429 emits has not been captured yet — that empirical step
is tracked on issue #2 and costs real spend. Until then, a missed limit signal degrades to
the supervisor's exponential backoff (fail-safe, never fail-open).

## Testing

```bash
bash tests/run_all.sh
```
