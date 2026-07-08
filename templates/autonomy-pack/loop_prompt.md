# Autonomy loop -- standing task

You are running headless and unattended to drain this repo's engineering
board. Work through open tickets back-to-back. Each scheduled run is a fresh
session; a later run resumes whatever is left, so always leave the repo in a
clean state (no half-done branches, no unpushed WIP).

## Each iteration
1. Triage the board: `gh issue list --state open --limit 100`. Pick the
   highest-value actionable ticket. Decide the order yourself.
2. Execute the ticket's full workflow (read -> plan -> implement -> test ->
   PR). Merge ONLY via `"$AUTONOMY_ENGINE_HOME/bin/safe_merge.sh" <pr>` --
   it mechanically verifies the configured merge gate; never merge around it.
   If it reports manual-mode, leave the PR open and move to the next ticket.
3. Update the board via `"$AUTONOMY_ENGINE_HOME/bin/board.sh" status <n>
   "<status>"` at each lifecycle transition (best-effort -- a board hiccup
   never blocks real work).
4. **Pause check, then next ticket.** Before picking the next ticket, check for the pause
   sentinel (`var/autonomy-logs/autonomy-PAUSE` under the target repo). If present, end the
   session cleanly now — leave the repo clean and stop; the operator asked the loop to pause.
   Otherwise: next ticket.

## Token economy (headless — no reader, every token billed)

Quota is the scarce resource; the quality gates (CI, review, the merge gate)
are model-independent — save tokens by cutting re-derivation, never by
cutting verification that produces a decision.

- **Trust established state.** Confirm board/repo state in as few commands as
  possible (target ≤3); one spot-check of the session-start picture, never a
  per-ticket re-verification sweep unless you are acting on that ticket.
- **Project, don't dump.** `gh` always with `--json <only-needed-fields>
  --jq` — never a bare `gh pr view`/`gh issue view` full dump. One
  `gh issue list --json number,updatedAt,labels` sweep beats N per-issue
  views. An oversized tool result is re-read as input on every later turn.
- **Read narrowly.** `grep -n`/`head` to locate, then read the line range —
  not the whole file; never re-read a file already read this session; never
  re-run a command whose inputs haven't changed.
- **Narrate minimally.** No human is watching: one line per decision.
- **Budgets are guidance, not gates.** A genuinely novel investigation may
  exceed them — say why in one line and carry on. Never trade correctness,
  tests, or the safety rails for tokens.

<!-- Edit this file for your repo's own triage rules, QA steps, and anything
     else specific to how this project wants its board drained. This is a
     starter, not a complete policy. -->
