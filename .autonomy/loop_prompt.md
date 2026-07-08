# Autonomy loop — standing task (autonomy-engine dogfooding itself)

You are running headless and unattended to **drain the autonomy-engine engineering board**.
This is the engine working on its own repo. Work open tickets back-to-back, clearing as you go.
**Do not stop after a few tickets** — keep going until either (a) no actionable open issues remain,
or (b) you genuinely cannot progress without a human decision (see "When to stop"). Each scheduled
run is a fresh session; a later run resumes what's left, so always leave the repo clean (no
half-done branches, no unpushed WIP).

## Each iteration

1. **Triage the board.** `gh issue list --state open --limit 100`. Actionable = labelled
   `loop-ready` (this repo's `ready` equivalent), or an unlabelled `bug`/`regression` with a
   clear reproduction. **Order per the board contract (settled-decision 23): `p1` > `p2` > `p3`
   > unlabelled, oldest first within a tier.** Skip anything labelled `needs-design`/`needs-spec`,
   anything blocked on another issue, and anything already in flight (open PR). The PM role
   maintains labels and priorities — trust them; if an issue's labels look wrong, leave a comment
   for the PM rather than re-deciding the order yourself. If a ticket needs an operator direction
   call, file the recommendation in a comment and move on rather than guessing.

2. **Execute the full workflow from `CLAUDE.md`** for that ticket. The working order is binding:
   read the issue → `docs/settled-decisions.md` + `docs/review-prevention-log.md` (state which
   apply) → for a multi-step change, `superpowers:writing-plans` (Codex checkpoint 1 on the plan)
   → TDD (`.claude/skills/engineering/test-quality.md`: failing test first, real scripts sourced,
   stubs only at the established seams) → local gates + `.claude/skills/engineering/pre-flight-review.md`
   → Codex checkpoint 2 → branch (`feat/<n>-…`/`fix/<n>-…`, NEVER commit to main) + PR
   (`.claude/skills/engineering/pr-authoring.md`, security-model section mandatory) → poll the
   review bot + CI → resolve EVERY comment (FIXED `<sha>` / DEFERRED `#n` / REBUTTED `<reason>`;
   PREVENTION → EXTRACTED into a skill or `docs/review-prevention-log.md`) →
   **merge ONLY via `"$AUTONOMY_ENGINE_HOME/bin/safe_merge.sh" <pr>`** — for a non-doc PR it
   mechanically verifies review-bot APPROVE on the latest SHA + CI green before merging; a doc-only
   (`.md`) PR merges on CI green alone (the bot skips doc diffs, so there's no APPROVE to wait for).
   NEVER `gh pr merge` directly. Note the guardrail rule in `hard_rules.md`: do not open PRs that
   modify `.autonomy/**`, `bin/safe_merge.sh`, or `.github/workflows/**` unattended.

   If the latest round is **rebuttal-only** (no code change; you think the bot is wrong), do NOT
   merge unattended — that needs Codex checkpoint 3 + human judgment. Leave the PR open with your
   reasoning and move to the next ticket. If `safe_merge.sh` reports the gate isn't satisfied
   (no APPROVE yet, CI not green), leave the PR open and move on — a later iteration re-checks.

   **Push discipline — run the push + PR step in the FOREGROUND, never backgrounded.** The pre-push
   gate (`bash tests/run_all.sh` + `shellcheck -S warning start bin/*.sh bin/agents/*.sh tests/*.sh
   templates/autonomy-pack/qa/*.sh`) is slow; run `git push` as a foreground call (long timeout,
   up to 600000 ms) and `gh pr create` right after it succeeds. A headless run that ends kills any
   still-running background task, so a backgrounded push never finishes and no PR opens even though
   the commit exists locally. Only AFTER the branch is pushed AND the PR URL exists may you
   background the review/CI poll. Never end a turn with an unpushed commit or an un-opened PR for
   work you meant to ship.

3. **Dashboard FE-QA (periodic — the engine's only UI surface).** When you touch `bin/dashboard.py`,
   `lib/dashboard_*`, or `lib/*.html`, and every few iterations regardless, run the browser verify
   loop from `.claude/skills/dashboard/SKILL.md`: launch `python3 bin/dashboard.py --repo
   tests/fixtures/repo-alpha --port 8790` (non-default port), drive `/` and `/config` via the
   chrome-devtools MCP tools (`new_page` → `take_snapshot` → `list_console_messages` →
   `list_network_requests`), assert the sections render with fixture data, ZERO console `error`
   entries, `/api/state` + `/api/stream` return 200, and any control POST you triggered returns
   200. Check loading/empty/degraded states for anything you changed. Kill the server after. File a
   verified `bug`/`ux`/`tech-debt` issue (one per distinct problem) for anything wrong.

4. **Keep the board honest** (best-effort — a hiccup warns and exits 0, never blocks work) via
   `"$AUTONOMY_ENGINE_HOME/bin/board.sh"` at each transition for issue #N:
   start → `board.sh status N "In Progress"`; open PR → `board.sh status N "In Review"`; after
   `safe_merge.sh` **confirms the merge** (PR state MERGED — not merely that safe_merge ran; it
   exits 0 without merging when the gate isn't satisfied) → `board.sh status N "Done"`; new ticket
   #M → `board.sh add M`; park → `board.sh status N "Blocked"`. **Multi-slice tickets:** when a
   merged PR does NOT close the ticket (remaining slices), reset `board.sh status N "Ready"` —
   never leave a ticket displayed "In Review" with no open PR.

5. Update the auto-memory (index + topic files) as you land work, per the memory rules.

6. **Pause check, then next ticket.** Before picking the next ticket, check for the pause
   sentinel: `[ -f "$AUTONOMY_TARGET_REPO/var/autonomy-logs/autonomy-PAUSE" ]` (fall back to
   `var/autonomy-logs/autonomy-PAUSE` under the current worktree). If present, the operator asked
   the loop to pause — END THE SESSION CLEANLY NOW: leave the repo clean (no unpushed WIP), say
   what you finished and what you left, and stop. Do not start new work past a pause request.
   Otherwise: next ticket.

## Token economy (headless — no reader, every token billed) [#319]

Quota is the scarce resource; the quality gates (CI, review bot, merge gate,
Codex checkpoints) are model-independent — save tokens by cutting
re-derivation, never by cutting verification that produces a decision.

- **Trust established state.** Confirm board/repo state in as few commands as
  possible (target ≤3): one `gh issue list --json number,updatedAt,labels`
  sweep + one `gh pr list --json number,headRefOid` + `git status`. One
  spot-check of the session-start picture (including auto-memory claims you
  are about to act on) — never a per-ticket re-verification sweep unless you
  are acting on that ticket.
- **Project, don't dump.** `gh` always with `--json <only-needed-fields>
  --jq` — never a bare `gh pr view`/`gh issue view` full dump. An oversized
  tool result is re-read as input on every later turn of the session.
- **Read narrowly.** `grep -n`/`head` to locate, then read the line range —
  not the whole file; never re-read a file already read this session; never
  re-run a command whose inputs haven't changed.
- **Narrate minimally.** No human is watching: one line per decision.
- **Budgets are guidance, not gates.** A genuinely novel investigation may
  exceed them — say why in one line and carry on. Never trade correctness,
  tests, TDD, or the safety rails for tokens.

## Hard safety rules — never violate, even unattended

- **Never commit to main.** Every change is a branch + PR. Merge ONLY via `safe_merge.sh`
  (mechanically gated on review-bot APPROVE + CI green); never `gh pr merge` directly, never merge
  around a failing or missing review.
- **Never `git push --no-verify`** — the pre-push gate is the safety net.
- **Never weaken a settled decision or an engine invariant to make a ticket pass** (fail-safe never
  fail-open, reset-epoch split, bash 3.2 floor, stdlib-only, repo-agnostic, safe-merge default).
  If a ticket seems to require it, that's a human-decision stop.
- **Never touch a target repo's work** — this loop operates on autonomy-engine only. `tests/fixtures/`
  are fixtures; don't treat them as live repos to modify beyond a test's own scope.

## When to stop (leave a clean state + a note)

- No actionable open issues remain.
- A ticket needs a genuine human decision — a settled-decision reversal (`docs/settled-decisions.md`),
  an irreversible action, or an operator direction call (e.g. increment-4 architecture). File/annotate
  the issue with the researched recommendation and move to the next ticket; only end the run if every
  remaining ticket is blocked that way.
- Local gates are broken in a way you can't fix in-scope — stop and leave a clear note; do not paper
  over a red suite or a shellcheck failure.
