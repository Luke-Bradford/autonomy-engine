# review-resolution

Mandatory handling of PR review comments. No silent ignores, no vague
acknowledgements, no "later" without a ticket.

## Terminal states — there is no fourth

- `FIXED {commit_sha} — {what changed}`
- `DEFERRED #{issue} — {why safe to defer}` (open the tech-debt issue FIRST)
- `REBUTTED — {specific reason, citing the code path / invariant / test}`

## Severity handling

| Severity | Required action |
|---|---|
| BLOCKING | FIXED or REBUTTED before merge — never deferred without operator agreement |
| WARNING | Fix on the PR if reasonable; else tech-debt issue + DEFERRED |
| NITPICK | Fix if trivial; else DEFERRED with issue. Never ignored "because it's a nit" |
| PREVENTION | Handle the point, then EXTRACT (below) |

## PREVENTION comments

Terminal states: `EXTRACTED {file}` / `ALREADY_COVERED {file}` /
`REBUTTED {reason}`. Reusable engineering lessons go into
`.claude/skills/engineering/*` (or the dashboard skill); recurring
repo-specific mistakes go into `docs/review-prevention-log.md`. The exact file
is named in the reply — "noted" is not a state. Extraction happens in the SAME
PR, not a follow-up.

## Workflow after a review lands

1. Read ALL comments before touching code.
2. Group by bug class; fix same-class occurrences, not just the commented line.
3. Re-run the pre-push checklist (`pre-push-checklist.md`).
4. Push; reply to every comment with a terminal state + SHA.
5. **Every push resets the review gate.** Wait for the review workflow + CI on
   the NEW commit — an APPROVE on a prior commit covers only the diff it saw.
   Poll `gh pr checks <n>` and the bot's comment on the latest commit.
6. Rebuttal-only round (no code changes pending)? Codex checkpoint 3 first —
   see `codex-checkpoints.md`. Never merge on rebuttals with only the author's
   word.

## Re-trigger traps (learned on PR #62 — tech-debt #64)

GitHub occasionally drops a `synchronize` event: the push lands but no
workflows start. Diagnose with `gh run list --branch <branch>` (compare run
timestamps to the push). Recovery, in order of preference:

1. `gh pr ready <n> --undo && gh pr ready <n>` — fires `ready_for_review`,
   which IS in `claude-review.yml`'s trigger types.
2. `gh pr close <n> && gh pr reopen <n>` — re-fires CI (default types) but NOT
   the review workflow (its `types:` list lacks `reopened` until #64 lands).

If checks stay "pending"/absent for ~10 minutes after a push, it is stalled —
re-trigger, don't keep waiting.

## Definition of review complete

Every comment has a terminal state · all fixes are on the latest commit · all
deferrals have issue numbers · all rebuttals cite specifics · prevention
lessons extracted · APPROVE + CI green on the most recent commit.

## Reading the gate — the check is not the verdict (2026-07-04 incident)

The required `review` CHECK going green means the workflow ran **and the bot
rendered a verdict** (#501) — it does **not** mean the verdict was APPROVE.
`REQUEST CHANGES` is still a green check today; the fork on whether it should
red is #502. The VERDICT lives in the bot's COMMENT ("## Claude Code Review" →
`**APPROVE**` / `**REQUEST CHANGES**`), and `safe_merge` enforces the
comment, freshness-compared against the head commit. A gate watcher that
polls check buckets will call a PR "ready" that safe_merge then refuses.

Before #501 green meant only "the API answered": a review that trailed off
without a verdict passed the check (PR #500 — the bot's own reasoning had
concluded REQUEST CHANGES). So **read the verdict, never the check bucket** —
and if you merge with `gh pr merge` rather than `safe_merge`, that reading is
the only thing standing between you and an uncertified merge.

When watching a gate:

- Poll the LATEST review comment: `createdAt` must postdate the head
  commit's `committedDate`, then grep the body for the verdict.
- Bound every watch (~15 min) and treat silence as a prompt to re-check by
  hand, never as progress — notifications can arrive late or not at all.
- A safe_merge run that prints NOTHING and exits 1 is an incident, not a
  refusal — refusals always print a REFUSE reason. Run `bash -x` on it
  (prevention-log #17) instead of assuming the gate is just "not ready".
