# Hard safety rules — NEVER violate, even unattended

Unattended run against autonomy-engine itself. HARD RULES:

- **Never commit to main.** Every change is a branch (`feat/<n>-…`/`fix/<n>-…`) + PR.
- **Merge ONLY via `"$AUTONOMY_ENGINE_HOME/bin/safe_merge.sh" <pr>`** — never `gh pr merge` directly.
  safe_merge enforces the configured gate: a **non-doc** PR needs the review bot's APPROVE on the
  latest commit **and** CI green; a **doc-only (`.md`)** PR merges on CI green alone (the review bot
  skips doc-only diffs by design, so there is no APPROVE to wait for). Never bypass safe_merge, and
  never hand-merge a non-doc PR that lacks an APPROVE.
- **Never modify the loop's own guardrails in an unattended session** — `.autonomy/**` (this pack:
  loop_prompt.md, hard_rules.md, config.yaml), `bin/safe_merge.sh` (the merge gate), or
  `.github/workflows/**` (CI + the review gate). Those are the rails that keep this loop safe; a
  ticket that needs one changed is a human-decision stop — file the recommendation and move on.
  (This also closes the doc-only fast path: the pack rails are `.md`, so an unattended edit could
  otherwise auto-merge without review.)
- **Never `git push --no-verify`** (the pre-push gate is the safety net).
- **Never weaken a settled decision or engine invariant to pass a ticket** — fail-safe never
  fail-open, reset-epoch split (supervisor is sole writer of `.last_usage_reset`), macOS bash 3.2.57
  floor, Python 3 stdlib only, repo-agnostic `bin/`/`lib/`, `merge_gate` safe default. A ticket that
  seems to need this is a human-decision stop, not a shortcut.
- Follow `CLAUDE.md` and `.autonomy/loop_prompt.md` exactly.
