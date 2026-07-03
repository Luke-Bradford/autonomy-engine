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

## 7. `producer | grep -q` under `set -o pipefail` is a CI-only flake

*Origin: PR #95 (`tests/test_start.sh`, `start_status_report`); recurred and
corrected in #106.*
`multi_line_producer 2>&1 | grep -q PATTERN` under `set -o pipefail`: when
`grep -q` matches a line it exits immediately, so the producer's NEXT write gets
SIGPIPE (rc 141). pipefail then makes the whole pipeline non-zero *even though
grep succeeded*, so a trailing `&& echo 0 || echo 1` reports failure.
Timing-dependent → green locally, red in CI.

**The fix is to remove the PIPE, not to capture into a var first.** The original
advice here — `out="$(producer)"; printf '%s\n' "$out" | grep -q …` — is
**still buggy**: `printf '%s\n' "$out" | grep -q` is itself a
producer-into-`grep -q` pipeline with the identical SIGPIPE race (this is how
the #95 flake resurfaced as #106). Grep the variable through a **here-string**,
which has no producer process to SIGPIPE:

```sh
grep -q 'PATTERN' <<<"$out"        # deterministic; single command, grep's own rc
# or, pure-bash, no external:
case "$out" in *"PATTERN"*) … ;; esac
```

Same class: any `producer | grep -q`/`| head`/`| read` where the left side keeps
writing after the right side exits. Never `printf … | grep -q` in a check.

## 8. Review replies without terminal states get lost

*Origin: increments 1-3 process; eBull convention.*
Every review comment ends `FIXED <sha>` / `DEFERRED #n` / `REBUTTED <reason>`
— posted as a PR reply, not just handled silently. An APPROVE with unreplied
NITPICKs is not complete (see `review-resolution.md`).

## 9. `assert elapsed < X` is a load-flake; prove concurrency structurally

*Origin: #100 (sleep-timed dashboard test), #108
(`test_collect_parallelises_repos_and_preserves_order`,
`test_gh_calls_run_concurrently`).*
A test that proves work ran in parallel by timing it (`elapsed < serial_sum`)
goes green in isolation and red under a loaded `run_all` — thread scheduling
can make a genuinely-parallel run look serial and trip the threshold. There is
nothing to tune: any wall-clock bound is a flake waiting for a busy box.

**Prove overlap structurally, not by clock.** Use a shared in-flight counter
(`max_inflight >= N`) recorded as each worker enters/leaves, or a
`threading.Barrier(N)` the workers must all reach at once — a serial executor
physically cannot cross an N-party barrier, so `max_inflight == N` is exact and
deterministic. Keep a `sleep`/latch only to *hold* the workers in-flight long
enough to observe the overlap, never as the thing asserted on. Same class as any
"it must be fast enough" assertion standing in for "it must be concurrent".

## 10. A live pid alone doesn't prove the process is who the lock says — confirm identity before it gates a warning

*Origin: PR (#81 `start status` worktree cleanliness), Codex checkpoint 2.*
`kill -0 "$pid"` proves a pid is *alive*, not that it's the process the lock
claims. A stale `…/supervisor.lock/pid` whose pid was recycled by an unrelated
process reads "alive" → the code trusts it as "running". Cosmetically (a status
label) that's tolerable — `control.sh:ctl_loop_state` accepts it. But when the
state **suppresses a health WARN** (a "running" loop is allowed to be dirty), a
false-positive HIDES a real problem = fail-open, which invariant #1 forbids.

**When a liveness check gates a warning, confirm the process identity** before
trusting it: match its argv (`ps -o command= -p "$pid"`) against a signature
only the real owner has. Anything unconfirmed falls to the fail-safe side
(treated not-running, so the WARN still fires). The same lock read is fine for a
cosmetic label and unsafe for a gate — the fail-open cost is set by what the
state *decides*, not by the signal.

**Match the exact launch sequence, not loose substrings.** `*supervisor.sh*`
plus `*"$repo"*` false-matches `vim …/bin/supervisor.sh` and a supervisor for
`<repo>2` when checking `<repo>` — each a fail-open. Require the contiguous
`…/supervisor.sh --repo <repo>` with `<repo>` terminated by a space or
end-of-argv (two `case` arms: `*"…--repo $repo"` and `*"…--repo $repo "*`).
Quote `"$repo"` in the pattern so a path metachar can't widen the match
(entry #6).

## 11. Under `pipefail`, a function that returns non-zero poisons `func | grep -q ... && echo 0`

*Origin: self-loop test authoring (#149 doctor knob-notes; earlier the #152 doctor
scaffold test).*
A test that pipes a function's output into `grep`:

```bash
check "msg matches" "0" \
  "$(doctor_preflight_check "$tmp" 2>&1 >/dev/null | grep -q -- '--claude-md' && echo 0 || echo 1)"
```

fails even when the pattern IS present, if the test file runs under `set -o
pipefail` (most of ours do). `doctor_preflight_check` legitimately `return 1`s on
the failure path it is meant to report; `pipefail` makes the whole pipeline take
that non-zero exit even though `grep -q` matched (exit 0), so the `&&` branch
never runs and the check reads a false negative. `grep`'s own result is invisible.

**Capture the output first, then grep the variable** — take the function out of
the pipeline so its exit status can't propagate:

```bash
msg="$(doctor_preflight_check "$tmp" 2>&1 >/dev/null || true)"
check "msg matches" "0" \
  "$(printf '%s' "$msg" | grep -q -- '--claude-md' && echo 0 || echo 1)"
```

The `|| true` on the capture makes the intent explicit. Same trap bites any
`producer | consumer` under `pipefail` where you care about the *consumer's*
verdict but the *producer* can exit non-zero by design.
