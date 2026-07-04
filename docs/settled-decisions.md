# Settled decisions

Operator-approved decisions that bind all future work. Check this file before
coding (pre-flight-review item H); changing an entry requires surfacing it to
the operator FIRST — never silently reinterpret. Each entry cites its origin.

## Platform

1. **macOS `/bin/bash` 3.2.57 is the floor.** No bash-4isms, ever. The engine
   runs on the operator's stock Mac. *(design.md; CI-enforced.)*
2. **Python 3 stdlib only.** Config parsing via `lib/config_parser.py`
   (restricted YAML subset) — adding a dependency is an explicit operator
   decision. *(design.md.)*
3. **Repo-agnostic engine.** Nothing repo-specific in `bin/`/`lib/`; target
   specifics live in the target's `.autonomy/` pack. *(design.md.)*

## Safety posture

4. **Fail-safe, never fail-open.** A `gh` failure is never CI-green
   (`ci_check`); an unresolvable account/prompt/scope REFUSES the session; a
   misconfigured merge gate hard-refuses rather than upgrading itself.
   *(design.md; PRs #52, #62.)*
5. **`merge_gate.strategy: manual` is the default** and `safe_merge.sh` is the
   only sanctioned merge path. *(design.md.)*
6. **Best-effort periphery:** `board.sh` and `unblock_dependents.sh` warn to
   stderr and `exit 0` on every failure — board/notifier hiccups never block
   engineering. *(design.md.)*
7. **Reset-epoch split:** agent adapters only EXTRACT a usage-limit reset
   epoch (outcome string); `bin/supervisor.sh` is the sole writer of
   `.last_usage_reset` and the shared account-keyed marker. *(#3; PR #62
   preserved byte-identically.)*
8. **Secrets live in the macOS Keychain** (#51). Index files
   (`~/.config/autonomy/credentials`, `…/accounts`) hold names/kinds/labels
   only, mode 600, atomic writes. Secrets never cross argv or logs; session
   env exports are subshell-scoped. *(PRs #52, #54, #57, #62.)*
9. **Dashboard is loopback-only** (127.0.0.1/localhost, anything else refused
   at startup) with a per-process control token on the single write endpoint
   and server-side re-validation of all control input. Controls began
   lifecycle-only (#10) and were deliberately extended to model/config/repo/
   credential/account writes (#24, #47, #51) — every extension stays behind
   the same token + validation, and none may ever touch a target repo's
   trade/order/position path. *(#10, #24, #47, #51.)*

## Agent-org (2026-07-02 brainstorm + increments 1-3)

10. **Three declarative layers** — accounts / agents / execution; nothing
    hard-wired; Managed Agents deferred to an optional account kind.
    *(specs/2026-07-02-dynamic-agent-org-design.md.)*
11. **Auth is account-first:** a role's `account:` beats the legacy #51-C
    `credential:`; account resolution failure refuses the session (fail-safe)
    while the credential path stays best-effort. Subscription = nothing
    exported. *(plans/2026-07-02-headless-dispatch.md, decision 1.)*
12. **Dispatch is round-robin, one session per loop iteration**, role list
    re-enumerated every tick; enumeration FAILURE → coder-only fallback;
    EMPTY enumeration → idle. Cron/event triggers belong to the increment-4
    scheduler/event bus. *(ibid., decisions 2/4/9.)*
13. **Model/effort precedence:** one-shot dashboard override (applied last,
    wins for its one session) > CLI flag > role `model:`/`effort:` >
    `agent.*` config > hardcoded default. Fallback model stays global.
    *(#24 + ibid., decisions 6/7.)*
14. **Merge semantics for roles mirror `dashboard_state.build_roles`**, single
    source in `lib/roles.py` (standard roster defaults; custom roles default
    disabled/loop; no `roles:` block → coder only). *(ibid., decision 5.)*
15. **Session log filename pattern `session-<ts>.log` is a contract** — the
    dashboard globs it; the role name goes in the supervisor.log line instead.
    *(ibid., decision 8.)*
16. **Shared usage-limit marker is one per supervisor** (`engine.account_key`);
    with per-role accounts this over-waits (safe direction) — accepted, and
    per-account limit state is issue #3's scope. *(PR #62 tradeoffs.)*
17. **`instances:` is retired in favour of named lanes** (superseded 2026-07-03,
    operator-approved D1). REMOVED from the schema once lanes Part 1 landed
    (#147): no longer validated, dropped from `role_settings`/the dispatch CLI
    and the supervisor NOTE-stub; a leftover `instances:` in an old config is
    inert (ignored, not an error). Parallelism is now expressed as named lanes.
    *(Was: deferred, PR #62 decision 3; retired via
    specs/2026-07-03-lanes-and-board-contract-design.md D1.)*
26. **Per-phase `models:` is retained-but-flagged, not dropped** (settled
    2026-07-04, #149 item 4). The schema still validates `roles.<r>.models:
    {plan,implement,test}`, but no adapter consumes it — the adapter takes ONE
    model (see entry 13). It is deliberately NOT dropped from the schema: #149's
    fail-safe-honesty NOTE now makes the no-op loud (dispatch and `doctor`
    both emit `roles.<r>.models is set but per-phase models are ignored …`), so
    the original reason to drop — a *silent* validated aspiration — no longer
    holds, and a graceful flagged no-op is more fail-safe than hard-rejecting a
    config that set the knob. Revisit wire-vs-drop when #89 designs per-phase
    model switching; the `_KNOB_NOTES` entry disappears for free the moment it
    is wired. *(#149, interim honesty of #89; enforced by
    `tests/test_roles.py` unwired-knob + models-shape cases.)*

## Lanes + board contract (2026-07-03 operator session, D1–D6)

21. **A lane is a named worktree + role subset**, keyed in the repo's one
    committed `.autonomy/config.yaml`; no `lanes:` block = one implicit lane =
    prior behaviour. One supervisor per lane; default lane keeps the legacy
    launchd label. *(specs/2026-07-03-lanes-and-board-contract-design.md, D1.)*
22. **Parallel lanes coordinate by label partition, not runtime claiming** —
    disjoint `scope.labels` is the claim; overlap is a doctor WARNING, never a
    lease mechanism. *(ibid., D1.)*
23. **Labels are the routing contract; Projects v2 is display-only.** Priority
    is `p1`/`p2`/`p3` labels (no board-field reads); the PM routes purely by
    applying labels and never knows lanes exist — label application IS
    assignment. *(ibid., D2/D3.)*
24. **Onboard creates the standard routing labels idempotently**
    (`ready`, `p1`-`p3`, `needs-design`, plus labels referenced by scaffolded
    scopes); existing labels are never modified; Projects boards are never
    auto-created. *(ibid., D4.)*
25. **GitHub is the only board** — no abstraction layer; board access stays
    concentrated in `board.sh` + the few gh call sites as the seam for any
    future adapter. Cron/event roles fire in the default lane only unless
    explicitly pinned. *(ibid., D5/D6.)*

## Workflow

18. **Nothing merges to main without a PR + CI green + review APPROVE on the
    latest commit** (branch protection, enforce_admins). Every push resets the
    review gate. *(CLAUDE.md workflow.)*
19. **Codex second-opinion checkpoints** at spec/plan, first push, and
    rebuttal-only merges — see
    `.claude/skills/engineering/codex-checkpoints.md`. *(Operator decision
    2026-07-02.)*
20. **Tests are genuine** — real scripts sourced, stubs only at the
    established seams. *(CLAUDE.md; test-quality skill.)*

## Adding an entry

A decision belongs here when the operator settled it and future work could
plausibly drift from it. Add: the rule, one line of why, the origin (spec /
plan / PR / date). Keep entries one paragraph max.
