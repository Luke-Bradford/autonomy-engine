# autonomy-engine — project instructions

## What this is

A **repo-agnostic engine** that runs Claude Code (and, in future, other CLI agents) autonomy loops
against **any** target repo. Extracted from eBull's `scripts/autonomy/`. The engine is generic; each
target repo supplies a small `.autonomy/` **pack** (`loop_prompt.md`, `hard_rules.md`, `config.yaml`)
that the engine reads. eBull is the first consumer.

Design + build history: `docs/design.md`, `docs/implementation-plan.md`.

## Non-negotiables (every change respects these — the CI review bot enforces them)

- **macOS `/bin/bash` 3.2.57 compatible.** NO `mapfile`/`readarray`, NO globstar/`**`, NO associative
  arrays (`declare -A`), NO `${var,,}`/`${var^^}`. This engine runs on the operator's Mac; bash 3.2
  is the floor. Use `find … -print0` + `while IFS= read -r -d ''` instead of `mapfile`.
- **Python 3 stdlib only.** No PyYAML, no yq, no third-party imports anywhere. Config parsing goes
  through `lib/config_parser.py` (a restricted-YAML-subset parser, stdlib only). Adding a dependency
  needs a very good reason and an explicit decision.
- **Every script's executable body is guarded** by `[ "${BASH_SOURCE[0]}" = "${0}" ] || return 0`
  (or the `if [ "${BASH_SOURCE[0]}" = "${0}" ]; then … fi` form) so sourcing it for tests only
  defines functions. Adapter files that are functions-only (`bin/agents/*.sh`) need no guard.
- **`shellcheck -S warning` clean** across `start bin/*.sh bin/agents/*.sh tests/*.sh
  templates/autonomy-pack/qa/*.sh`. Test files too — not just `bin/`. (`.sh` under `tests/` is a
  common miss.)
- **Tests are genuine.** They `source` the real script and call the real functions (mock only `gh`
  as a shell function where a network call is unavoidable). No assertions-on-mocks.

## Invariants (correctness properties — do not regress)

- **Merge-gate CI fail-safe:** a `gh` API failure must NEVER be treated as CI-green. `ci_check`
  refuses (returns 1) on a `gh` failure, distinct from "checks failing". Fail-safe, never fail-open.
- **Reset-epoch split:** agent adapters (`bin/agents/*.sh`) only *extract* the rate-limit reset
  epoch and return it in their outcome string; `bin/supervisor.sh` is the sole writer of
  `.last_usage_reset`. Never persist reset state inside an adapter.
- **Best-effort scripts never hard-fail their caller:** `board.sh` and `unblock_dependents.sh` warn
  to stderr and `exit 0` on every failure path — board/notifier hiccups must never block engineering.
- **Repo-agnostic:** no target-repo-specific values (GitHub owners, board titles, issue numbers)
  hardcoded in `bin/` or `lib/`. Everything repo-specific comes from the target repo's
  `.autonomy/config.yaml`. `templates/` and `docs/` may use placeholders/examples — those are fine.
- **`merge_gate.strategy: manual` is the safe default.** Never silently fall back to a stronger,
  auto-merging strategy on a misconfig — hard-refuse with a clear reason.

## Layout

```text
bin/
  supervisor.sh          # main loop: --repo <path>, runs every enabled loop role round-robin (account-first auth), preflight, backoff
  quickstart.sh           # guided single-entry onboarding; chains the tools below (never launchctl)
  control.sh               # multi-repo registry/control unit: list/start/stop/pause/resume, --all
  onboard.sh              # scaffold a target repo's .autonomy/ (idempotent)
  doctor.sh                # target-repo readiness report (diagnostic-only, never provisions)
  setup_worktree.sh         # create dedicated worktree + install launchd plist
  worktree_gc.sh             # prune stale worktrees + merged branches
  safe_merge.sh               # the ONLY sanctioned merge path; 4 gate strategies
  board.sh                     # best-effort GitHub Projects v2 board updates
  unblock_dependents.sh         # post-merge "blocked by #X" notifier
  agents/claude.sh               # Claude Code adapter
  agents/codex.sh                 # Codex adapter (engine-level fallback retry; limit-shape #2-caveat)
lib/config_parser.py             # restricted YAML-subset parser (stdlib only)
lib/pipeline.py                   # sequencer P1-P3a: docs+validator, SPEC_SHEETS SSOT, graph walk, journal/ledger (skill: engineering/pipelines)
templates/                        # supervisor.plist.tmpl + autonomy-pack/ (onboard scaffolds these; incl. pipelines/ starters)
tests/                             # one per script; run_all.sh runs the whole suite
docs/                               # design.md, implementation-plan.md
```

## Workflow

`main` is branch-protected — **nothing merges to main without a PR + CI green + a review pass**
(required checks `lint-and-test` + `review`, enforce_admins, PR-required with 0 human approvals so
CI + the review bot are the gate).

**Working order for every task:**

1. Read the issue. Read `docs/settled-decisions.md` and `docs/review-prevention-log.md`; state
   which entries apply (or that none do). If the plan would change a settled decision, stop and
   surface it first.
2. Branch (`feat/<n>-…` or `fix/<n>-…`), never commit to main.
3. Spec/plan work: Codex checkpoint 1 before execution
   (`.claude/skills/engineering/codex-checkpoints.md`).
4. TDD: write the failing test, see it fail, implement, see it pass
   (`.claude/skills/engineering/test-quality.md`).
5. Before every push: `.claude/skills/engineering/pre-push-checklist.md` (run_all + shellcheck +
   pre-flight-review; Codex checkpoint 2 on the first push; dashboard verify loop if the dashboard
   changed).
6. PR per `.claude/skills/engineering/pr-authoring.md` (security model section mandatory). CI +
   review bot run automatically; resolve every comment per
   `.claude/skills/engineering/review-resolution.md` (FIXED `<sha>` / DEFERRED `#n` /
   REBUTTED `<reason>`; Codex checkpoint 3 before any rebuttal-only merge).
7. Merge once green + APPROVE on the latest commit (every push resets the gate). Delete the
   branch, close the issue.

The review bot needs the `ANTHROPIC_API_KEY` repo secret (already set). Doc-only PRs skip the bot.

**Definition of done:** implementation matches the issue + settled decisions · self-reviewed via
pre-flight-review · run_all + shellcheck clean · PR description self-contained · every review
comment in a terminal state · recurring findings extracted to the prevention log or a skill in the
same PR · dashboard changes browser-verified.

## Internal skills (project-local, in-repo)

`.claude/skills/engineering/` — bash-hygiene · python-hygiene · test-quality · pre-flight-review ·
pre-push-checklist · pr-authoring · review-resolution · codex-checkpoints · loop-coexistence ·
pipelines (the sequencer subsystem map — read before touching lib/pipeline.py or the dispatch path).
`.claude/skills/dashboard/` — control-room architecture + chrome-devtools browser verify loop.

**Skill ownership:** these files are engineering substrate the agent OWNS. When a gap or stale
claim is found mid-task, fix the skill inline in the same PR — no separate ticket, no "later".
New prevention lessons land in the relevant skill AND/OR `docs/review-prevention-log.md` in the
same PR that exposed them.

## Backlog

Open issues are the build queue: **#1** harden safe_merge timestamp compare · **#2** codex agent
adapter · **#3** shared account-level usage-limit state (registry prereq) · **#4** registry /
control-unit. `docs/implementation-plan.md` is the record of how the engine was built (Tasks 1–13).
