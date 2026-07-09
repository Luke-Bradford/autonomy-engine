---
name: working-under-the-loop
description: Use when working in a repository managed by the autonomy engine — creating branches, opening or updating pull requests, resolving merges, or sharing the repo with other concurrent agent sessions.
---

# working-under-the-loop — session hygiene in an engine-managed repo

This repository is driven by an autonomy engine: other agent sessions may
be working it concurrently, and merges are mechanically gated. These are
the behaviours that keep your session a good citizen. (The engine ENFORCES
the hard rules regardless — this skill explains them so you work with the
machinery instead of against it.)

## Merging

- **Never merge a pull request yourself** — no `gh pr merge`, no merge
  buttons, no pushing to the default branch. The engine's merge gate is
  the only sanctioned merge path; depending on this repo's configured
  strategy it merges mechanically once its checks pass, or leaves the
  merge to a human — either way, not to you. Your job ends at: PR open,
  checks green, review comments answered.
- Every push resets the review gate. An approval on an earlier commit
  covers only the diff it saw — expect re-review after each push, and
  don't ask for a merge on a stale approval.

## Branches and worktrees

- One branch per piece of work, created from the repository's default
  branch. Never commit directly to the default branch.
- You may be running in a disposable worktree the engine created for
  parallel work — treat the checkout as YOURS but the branch as SHARED:
  before pushing to a branch that other sessions may also push to,
  `git pull --rebase` first; on conflict, rebase and re-run the tests
  rather than force-pushing.
- Never `git add -A` blindly: a shared checkout can contain another
  session's stray files. Stage exactly what you changed.

## Honesty in outcomes

- Report what actually happened. If tests fail, the session outcome is a
  failure — the pipeline's failure edges exist to HANDLE that; masking a
  failure breaks the routing that would have recovered it.
- If work is blocked on a human decision, say so explicitly (park/notify
  paths exist for this) instead of guessing or half-finishing.
- Leave the trail future sessions need: issue/PR comments describing what
  was done, what remains, and why any deviation happened.
