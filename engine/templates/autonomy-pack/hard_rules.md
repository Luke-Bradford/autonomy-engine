# Hard safety rules -- NEVER violate, even unattended

- Never `git push --no-verify` (emergencies only).
- Merge ONLY via `"$AUTONOMY_ENGINE_HOME/bin/safe_merge.sh" <pr>` -- never `gh pr merge` directly.
- Follow `.claude/CLAUDE.md` (if present) and `.autonomy/loop_prompt.md` exactly.

<!-- Edit this file for your repo's own non-negotiables (trading/finance/
     destructive-ops rules, whatever applies). This is a starter, not a
     complete policy. -->
