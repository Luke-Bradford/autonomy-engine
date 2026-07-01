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
4. Next ticket.

<!-- Edit this file for your repo's own triage rules, QA steps, and anything
     else specific to how this project wants its board drained. This is a
     starter, not a complete policy. -->
