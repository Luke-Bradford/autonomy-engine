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

## 12. A pure projection over cached data runs OUTSIDE the fetch try — make it total

*Origin: #206 follow-up, Codex checkpoint 2 (`_row_id`/`_project_ids`).*
A best-effort fetch/cache function documents "never raises, fall back safely",
but when a later helper PROJECTS the cached value (`live_claude_models` maps its
rich `{id,display_name}` cache rows to bare ids via `_project_ids`), that
projection runs *after* the fetch `try` has exited. An injected/legacy fetcher
or a corrupt cache holding an unexpected row shape (a bare int, a dict with no
`id`) then makes the projection raise — breaking the never-raises contract from a
spot the `try` no longer guards. **A helper that normalises cached/injected data
must be total: tolerate any shape, drop what it can't read, never assume the
happy-path type.** `_row_id` returns `None` for anything that isn't a non-empty
str or an `{id: str}` dict; `_project_ids` drops the `None`s. Regression:
`test_live_models_tolerates_junk_rows`.

## 13. Static snapshots can't catch temporal defects — instrument time, not frames

*Origin: #239 (operator: "we're not looking at the site but a screenshot"); the
#174 flicker and its regression both shipped through green QA.*
A11y snapshots, console dumps, and network status are STILL readings — flicker,
jank, and layout thrash are *temporal*, so a snapshot literally cannot contain
them, and a green static pass proves nothing about motion. The dashboard verify
loop now runs a **temporal pass** (SKILL.md step 4): observe an idle fixture for
a window with zero interaction and assert `steadyStateCLS < 0.01` + every panel's
`innerHTML` byte-stable + ≤1 element-rebuild/panel. Two instrumentation traps the
probe design must avoid or every panel reads as churning: (a) measure CLS with a
FRESH `PerformanceObserver` (no `buffered:true`) so expected load-time settling
shifts don't count; (b) count only childList mutations that add/remove an
ELEMENT node — the minute-granularity countdown ticker (#238) rewrites time-cell
text nodes every second, which is benign motion. The probe immediately surfaced a
latent case: only `renderRepos` carries the #164/#238 skip-unchanged guard; the
other panel renders reassign `el.innerHTML` every SSE tick, rebuilding
byte-identical DOM (node-identity churn). **Rule: a render that writes markup on a
recurring tick needs a skip-unchanged guard, not an unconditional
`el.innerHTML = …`; and any temporal probe must exclude load-settle CLS and
text-node ticks or it cries wolf.** The read-only QA rail can't run a browser, so
it carries the *static* twin (qa.md UX check): flag the unconditional-per-tick
`innerHTML` pattern in review.

## 14. A skip-unchanged panel guard must own EVERY write path — an out-of-band `innerHTML` desyncs its signature cache

*Origin: #248 renderFocus slice; Codex checkpoint 2 caught the empty-state path.*
Once a panel render is gated by a signature cache (`_sig[id]` in `setHTML`, the
#248 skip-unchanged guard), the cache only tells the truth if EVERY mutation of
that panel's DOM goes through the guard — or re-syncs it. `renderFocus` has four
write paths: empty-state, idle full-write, repo-set-changed full-write, and the
held-node partial `replaceWith` (which keeps the focused card's live node and
swaps the others in place, a DOM mutation *outside* `setHTML`). Two traps this
exposed: (a) the held partial-update leaves `_sig.focus` keyed to the PRE-update
markup, so a state-change-during-interaction that then reverts lets the next idle
`setHTML` match the stale key and SKIP — freezing the swapped cards; fix is to
re-derive `_sig.focus` from the ACTUAL DOM (`_sig["focus"]=_sigKey(box.innerHTML)`)
after the partial write. (b) the empty-state early-return wrote `innerHTML`
directly, leaving `_sig.focus` on old card markup — a transient empty→repopulate
with identical markup would then wrongly skip and stick on the empty state; fix
is to route it through `setHTML` too. **Rule: a signature-cached render must have
NO write path that bypasses the guard; any unavoidable out-of-band DOM mutation
(a `replaceWith` that preserves a live node) must re-sync the signature to the
real DOM immediately after. Also: normalize ALL volatile ticker cells the render
emits — the guard's `_volRe` had to add `upe` (the busy card's live elapsed
counter) alongside `qreset`/`agox`, or a working repo's key changes every second
and the guard never skips.** Verified via the #239 temporal pass (focus idle
rebuilds 0) plus an in-browser interaction driver (focus survives a tick;
change-then-revert leaves no stale card; empty→repopulate restores cards).

## 15. A `*_valid: False` config projection still echoes the RAW invalid keys — a new consumer that treats them as usable is fail-open

*Origin: #258 lane-selection slice; Codex checkpoint 2.*
`build_repo_state.lanes` exposes `names`/`default`/`valid` where `valid: False`
means the committed `lanes:` block is malformed (bad name, non-mapping, unknown
key — the SAME verdict the supervisor's `--lane` gate reaches, so it REFUSES to
dispatch). But `roles.lane_names()`/`default_lane()` deliberately still echo the
raw keys verbatim (`_declared_lane_names` returns `list(lanes)` unfiltered) so a
render can *name* the offending lane in its ⚠ badge. The trap: a NEW consumer
that reads `names`/`default`/`lane_of_role` as "the lanes I can use" will surface
a lane the engine won't run. The #258 default-selection (`lanes.active`) hit
exactly this — an invalid lane name flowed straight into the selectable/active
lane, so the center zone would default-focus a lane that can't dispatch =
fail-open display, which invariant #1 forbids. **Rule: any read-only surface that
turns a config projection into an ACTION target (selection, dispatch, a control
default) must gate on the block's `valid`/`*_valid` verdict FIRST and degrade to
the neutral fallback (`main`) when False — never treat the echoed-for-display raw
keys as usable. Displaying an invalid value (badged as broken) is truthful;
*selecting/acting on* it is fail-open.** Verified:
`test_active_lane_does_not_surface_an_invalid_lane_name` (an invalid lane name →
`valid: False`, `active == "main"`, not the raw key).

## 16. A focusable control added to a single-card signature-guarded panel is captured by the held-node "preserve focus" path — freezing the card

*Origin: #258 slice 3b lane-history popover; Codex checkpoint 2.*
`renderFocus` has a held-node partial-update path (prevention-log #14): if the
focused element is a `SELECT`/`BUTTON` inside `#focus`, that element's `.fcard`
is *preserved* (kept as the live DOM node so its focus/dropdown survives) while
the OTHER cards re-render around it, then `_sig.focus` is resynced to the actual
DOM. That is correct for the model/effort `<select>` — you're mid-interaction and
want focus kept. But slice 3b added a history-clock `<button>` to the card, and a
click leaves it as `document.activeElement`. Since slice 2b collapsed the center
to a SINGLE card, `held` is then the only card: the `replaceWith` loop swaps
nothing, and `_sig.focus` is resynced to the UNCHANGED (old) markup — so every
subsequent tick's real state change is skipped and the focus card FREEZES while
the popover is read (stale server truth = fail-open display, invariant #1). The
trap is specific to the single-card panel: with N cards the held path still
updates the others, so the freeze is invisible until a slice collapses the panel
to one. **Rule: a focusable control whose job ENDS on click (a popover trigger, a
toggle) must NOT linger as `document.activeElement` inside a signature-guarded
single-node panel that has a held-focus preserve path — `blur()` it after acting
so the next render takes the normal full-render path. Only controls you are
actively editing (a `<select>` mid-dropdown, a text input) should be held.**
Verified: `test_open_blurs_the_trigger` (openLaneHist blurs the anchor) + a
browser check that after open the clock is not focused and the popover stays live
across ticks.

## 17. Under `set -e`, a non-total config reader turns a MISSING OPTIONAL KEY into a silent rc-1 death — before the `:-default` ever applies

*Origin: 2026-07-05 live incident (fleet-wide safe_merge stall); introduced by
#192/PR #284, diagnosed after the operator reported "PRs not progressing".*
`VAR="$(CONFIG_GET some.key | paste ...)"` under `set -euo pipefail`: when the
key is absent the parser exits 1, the assignment takes that rc, and `set -e`
kills the script with ZERO output — the next line's `VAR="${VAR:-default}"` is
unreachable. The first read of a key no existing config carried
(merge_gate.doc_only_paths) killed EVERY safe_merge run silently; APPROVE'd
PRs piled up unmerged and the only symptom was rc 1 with no output. **Rule:
any helper that reads an OPTIONAL config key must be TOTAL (`… || true` /
`|| echo <default>`) when any caller runs `set -e` — missing-key tolerance
belongs in the READER, not in each call site's default.** doctor.sh's
`|| echo` reads are the established pattern; supervisor.sh is exempt only
because it runs without `set -e`. Same class: any `x="$(cmd)"` under `set -e`
where cmd legitimately exits nonzero for an expected condition (entry #11's
capture-first rule is the test-side twin). Diagnosis trap: the failure is
INVISIBLE (no stderr) — when a gate script "does nothing", run `bash -x`
before theorizing. Regression: `tests/test_safe_merge_config_get.sh` (the OLD
code makes the test itself die rc-127 after one output line — the class
demonstrated on itself).

## 18. Fail-safe `case`/`if` DEFAULT — the healthy verdict must be EARNED, not the fallback

*Origin: 2026-07-05, Codex CP2 on the #81 health slice (`./start status` wedged
wiring).* The running-loop branch printed `OK loop running` as the `case`
default and WARNed only on explicit `wedged`/`unknown`. A health probe that
FAILED (no python3, timeout) returned blank → hit the default → read healthy.
That's fail-open: "couldn't inspect liveness" silently rendered as OK, the exact
thing the feature exists to prevent. The "never worse than before" rationale
doesn't hold — the feature's OWN invariant is "unreadable liveness never reads
healthy". **Rule: for any health/safety verdict rendered by a `case`/`if`, put
the SAFE outcome in the default arm and require an EXPLICIT positive signal for
the reassuring one** — `ok|idle) OK ;; *) WARN` beats `wedged) WARN ;; *) OK`.
A blank/absent/garbage result must land on the safe side, never the happy path.
Same class as invariant "fail-safe never fail-open": absence of evidence is not
evidence of health. Regression: `tests/test_start.sh` drives blank-probe and
unrecognised-state through the branch and asserts the WARN (no bare OK) fires.
