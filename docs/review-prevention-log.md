# Review prevention log

Recurring, repo-specific bug classes caught in review. Read before coding
(pre-flight-review item I); when a review finding recurs or generalises, add
it here (or to a skill) in the SAME PR — `EXTRACTED docs/review-prevention-log.md`.

Format per entry: **bug class** · origin · the rule.

## 1. `VAR=value` parsing without an `=` guard exports `VAR=VAR`

*Origin: PR #62 final review (Important), `invoke_scoped_env`.*
`${line%%=*}` and `${line#*=}` both return the whole line when it contains no
`=`, so a stray `PATH` line becomes `export PATH=PATH` and clobbers the
session env. Any KEY=value line parser must first require the separator:
`case "$line" in *=*) ;; *) continue ;; esac`. Regression-tested in
`tests/test_headless_dispatch.sh` ("eq-less line skipped").

## 2. `local x=$(cmd)` masks the command's exit status

*Origin: PR #62 final review (praised as avoided); eBull recurring class.*
Under `local`/`export`, the assignment's rc is the builtin's, not the
command's. Declare then assign — and when rc gates control flow, use
`if ! x="$(cmd)"; then refuse; fi`. Same-class scan any file where you find
one.

## 3. Silent fallback that widens behaviour = fail-open

*Origin: headless-dispatch plan decision 10; scope-compose refusal.*
When a constraint artifact (scope directive, safety rules, gate config) can't
be produced, falling back to running WITHOUT it silently widens the agent's
remit. The failure must refuse the operation. Same class: `gh` failure treated
as CI-green (forbidden by `ci_check`), merge-gate misconfig upgrading itself
(forbidden), corrupt registry read as empty (#59 — still open, don't extend
the pattern).

## 4. Forward-declared globals trip SC2034 when their consumer lands in a later task

*Origin: PR #62 task 3 → task 4.*
Splitting producer (sets globals) and consumer (reads them) across commits
leaves shellcheck seeing dead assignments. Handling: one scoped
`# shellcheck disable=SC2034` directive with a comment naming the consumer,
placed where it actually suppresses (above the enclosing compound — verify
empirically, shellcheck does not honour it on a `case`-internal assignment
line), REMOVED in the task that adds the consumer. Never file-level.

## 5. Dropped `synchronize` event stalls the PR review gate

*Origin: PR #62; tech-debt #64.*
A push can land with NO workflow runs started (GitHub drops the event).
Symptom: `gh pr checks` shows nothing new ~10 min after the push. Diagnose
with `gh run list --branch <branch>`; recover with `gh pr ready --undo` +
`gh pr ready` (fires `ready_for_review`, which the review workflow listens
for). `close`/`reopen` restarts CI but NOT the review workflow until #64 adds
`reopened` to its types. Don't sit polling a stalled gate.

## 6. Config-sourced strings must be re-validated before argv / filenames

*Origin: #24 (`valid_model_id` parity note), #62 (`ROLE_MODEL` blanking,
role-name charset filter), `resolve_account_key` charset fallback.*
Anything read from config or the dashboard control channel that lands in a CLI
argv, a filename, or shell word-splitting gets a strict charset/enum check at
the point of use, with warn-and-ignore (or safe-default) on failure — even
though an upstream writer also validates. Defense in depth is the convention,
not paranoia.

## 7. Review replies without terminal states get lost

*Origin: increments 1-3 process; eBull convention.*
Every review comment ends `FIXED <sha>` / `DEFERRED #n` / `REBUTTED <reason>`
— posted as a PR reply, not just handled silently. An APPROVE with unreplied
NITPICKs is not complete (see `review-resolution.md`).
