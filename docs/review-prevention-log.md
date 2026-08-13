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

## 20. GitHub's closing grammar is itself negation- and quote-blind — a PR body that QUOTES "close #N" closes #N at merge, engine or no engine

*Origin: PR #324 (the #301 fix), 2026-07-08 — the fix's own body quoted
"does NOT close #90" while documenting the incident; GitHub's
`closingIssuesReferences` listed [90,286,301] and the merge closed #90 for
the third time.* The #301 premise "GitHub's own auto-close semantics are
stricter (negations don't count)" is empirically FALSE: `close #90` inside a
negated, quoted sentence is linked server-side. Moving done-everywhere onto
`closingIssuesReferences` (#324) is still right — the engine can no longer
OUT-close GitHub — but it cannot be MORE careful than GitHub either, because
GitHub itself closes linked refs natively at merge. **Rule: the "never write
closing-keyword+#N for an issue that must stay open" authoring rule is
permanent and applies to every PR body on GitHub, not a workaround for our
old regex. Check `gh pr view <n> --json closingIssuesReferences` BEFORE
merging any PR whose body discusses issues it must not close — that field is
exactly what the merge will close.** Same class as prevention-log #13's
"verify the premise": an issue's claim about third-party behaviour
("GitHub is stricter") deserves an empirical check before code is built on
it — one `gh api` probe would have caught this at spec time.

## 19. Local shellcheck ≠ CI shellcheck — a locally-clean push can still fail the lint gate

*Origin: 2026-07-05, PR #296 (#294 self-re-exec).* `shellcheck -S warning`
passed locally (0.11.0) and in the pre-push gate, then FAILED in CI on SC2093
("remove exec if script should continue") — the CI runner ships a different
shellcheck build with checks the local one lacks (and vice versa). One full
red CI round for a one-line directive. **Rule: CI's shellcheck is the
authoritative one.** When a construct is intentionally unusual (continue after
`exec` under execfail, sourcing dynamic paths, deliberate word-splitting),
add the targeted `# shellcheck disable=SCnnnn` + one-line justification AT
WRITE TIME rather than assuming a locally-clean pass covers CI. If CI flags a
check the local binary doesn't, fix + note the version drift — don't argue
with the older tool.

## 21. A review fix is a diff too — run the same-class scan on the FIX before pushing it

*Origin: 2026-07-09, PR #358 (#357 P3a canvas viewer).* Review round 1
flagged ONE call site in `build_pipeline_view` escaping the builder's
totality contract (`role_settings` guarded only for `KeyError`). The fix
widened exactly that site and pushed — and round 2 came back REQUEST
CHANGES with the two SIBLINGS (`wrap_role` unguarded, `ledger` guarded too
narrowly). The pre-flight-review skill's "required same-class scan" was
applied to the feature diff but NOT to the follow-up fix, which is itself a
diff introducing (or re-asserting) a pattern. One extra grep at fix time —
"list every external call in this function and its guard" — would have
saved a full review round. **Rule: when a review finding names an instance
of a CLASS (a missing guard, a masked rc, an unvalidated input), fix EVERY
occurrence of the class in the touched scope in the same commit, and say so
in the reply ("scanned siblings: X, Y also widened / already guarded
because …"). A one-site fix to a class finding is a partial fix the next
round will find.**

## 22. Prose that flows through `pipeline.substitute()` must `$${`-escape its `${` examples

*Origin: Phase B's `_OUTPUTS_FOOTER` (caught in the Phase C plan's own
escape rule) + the D3 blank-starter brief (caught in pre-push self-review,
PR #387) — the same class twice.* Brief TEXT is substituted at prepare
time, so any documentation prose that mentions `${params.x}`-style syntax
inside a brief, footer, or template that reaches `compile_brief`/
`_prepare_step` is EXECUTED as a reference, not displayed — an undeclared
example ref makes the pipeline's very first run refuse (fail-safe, but a
baffling out-of-box failure the author shipped as documentation). **Rule:
any string literal in engine code or pack templates that (a) documents the
`${…}` syntax and (b) travels through `substitute()` must write `$${…}`
(the engine's literal-`${` escape), and the test pins the rendered output
against the REAL `pipeline.substitute` — not a copy of the escape rule.**
Grep sites at write time: footer constants, starter briefs, scaffolded
`.md` templates under `templates/`.

## 23. A workflow fix does NOT apply to an already-open PR — `pull_request` loads the workflow from the PR's HEAD

*Origin: #468/#469 — the review bot's charter excluded `studio/`, so it
declined to review TypeScript diffs and emitted an arbitrary verdict. The
charter fix merged to `main`; the blocked PR #466 was then close/reopened to
re-fire the gate, and returned the IDENTICAL out-of-scope verdict.* For
`pull_request` events GitHub loads the workflow DEFINITION from the PR's **head
commit**, not from the base branch and not from the recomputed merge ref.
`actions/checkout` does check out `refs/pull/N/merge` — so the fixed code can be
sitting right there on disk — but the STEPS that run come from head's copy of
the YAML. Code and workflow-definition come from different places. The evidence
was in the job log: the old `cat > build_prompt.py << 'PYEOF'` heredoc ran
against head `9f4bb84`, which predated the fix. **Rule: a CI/workflow fix
reaches an open PR only when that PR's BRANCH contains it — merge/rebase `main`
into the branch (and push) before concluding the fix did or did not work. Closing
and reopening re-fires the trigger (prevention-log #5) but changes nothing about
which YAML is used. Verify which definition actually ran by grepping the job log
for a line only the new code emits — never infer it from "the fix is on main".**

## 24. Making a fact authoritative promotes every previously-benign write to it into a load-bearing one

*Origin: #443's planning gate. The reconciler's terminality check moved from the
PROJECTION to the LOG. `launcher.ts`'s `terminalizeInterrupted` gated on the
run ROW, not the log, so a throw in the driver's fold/sync AFTER the durable
`run.finished` append landed there with the row still `running` — and it appended
`run.interrupted` on top of an accepted terminal.* Before the authority flip that
write was **benign**: the projection folded the spurious event to a no-op
(`reduce.ts` early-returns on an already-terminal run), so nothing observed it.
The moment the LOG became authoritative it became active corruption — the boot
reconciler would resync a SUCCEEDED run to `interrupted`. Nothing in the diff
touched that file; a test would not have caught it (the old behaviour was
correct); and its own doc comment asserted the case was impossible (**"A run
reaching `terminalizeInterrupted` always has a NON-terminal log"** — false).
**Rule: when a change makes some fact authoritative — a log over a projection, a
column over a derivation, one field over another — enumerate every WRITER of that
fact before shipping, not just the readers you are changing. Writes that were
harmless because something downstream absorbed them are exactly what breaks, and
they are invisible to the diff and to the existing tests.** Corollary (recurring,
cf. #21): a comment asserting an invariant is not evidence the invariant holds —
`grep` the producers. Both the false comment and the guard were fixed in the same
PR as the flip.

## 25. The guard your comment ARGUES FOR is the one nothing tests — mutate it before you trust the argument

*Origin: two independent findings in the same fire (2026-07-16), which is what
makes it a rule rather than an anecdote.* (a) **#504**: the review bot's
`output_config.effort` was the single knob the whole ticket was about — and the
only one with no test, while its neighbour `max_tokens` had **both** a test and a
rationale comment. (b) **#479**: the per-run catch's docblock argued the
wrap-the-whole-body breadth was safe *because* "the cost of the breadth — that it
could mask a genuine bug — is paid by the sentinel re-throw below". The pre-PR
correctness lens mutation-tested that sentence: **deleting the re-throw line
passed 474/474 tests, and reverting the sentinel to a plain `Error` also passed
474/474.** The safety argument was load-bearing prose with nothing underneath it.

The mechanism is not laziness — it is that **a guard is written to make a bad
thing not happen, so the natural test ("the good path still works") passes with
the guard deleted.** Prose is cheap to write and reads as evidence; the more
carefully a comment argues that a design is safe, the more likely the argument is
carrying weight the test suite is not. The two findings above are the same shape
as #21 (*a review fix is a diff too*) and #24's corollary (*a comment asserting an
invariant is not evidence the invariant holds*): the repo keeps rediscovering that
**rationale is not verification**.

**Rule: when you write a comment whose job is to justify a risk ("this is safe
because X"), X needs its own test — and the way to check is to DELETE X and run
the suite. If it stays green, the test suite does not know about X, and the next
refactor will remove it as ceremony.** Cheap to apply: it is one revert and one
`pnpm test`. Applies with double force to guards that are unreachable today and
defended only as "defensive" — those are exactly the lines a future reader
deletes, and exactly the lines no happy-path test covers. Corollary: a sentinel /
allowlist / re-throw that discriminates two error classes needs a test **per
class**, or the discrimination is untested even when the happy path is not.

**(c) The third instance — the rule applies to the claim you just CORRECTED.**
The same #479 fire produced one more, *after* this entry was written: the review
bot found that the `failed` docblock's exclusivity rule (*"NOT exclusive of
`held`/`rearmed`"*) had no test. That rule was the planning gate's **finding** —
the plan's original "a failed run appears in no other bucket" was false, and
correcting it was the gate working. But nobody then mutated the correction, so
the PR fixing two instances of #25 shipped a third in the very docblock stating
the lesson. **A freshly-reasoned invariant feels verified BECAUSE you reasoned
about it** — that is precisely the state in which the mutation goes unwritten.
So: apply the delete-and-run check to corrected claims and review findings, not
only to code you authored. Second corollary, from the same test: **a
characterization test (one pinning behaviour that is already correct) is written
to pass, so passing is not evidence it binds.** Its first run is not the check —
mutating the behaviour it claims to pin is. If the mutation stays green, the test
is decoration. This is the mirror of TDD's see-it-fail step, for the case where
the implementation already exists and there is no red phase to observe.

## 26. The SQUASH-MERGE COMMIT body is a second door into GitHub's closing grammar — and `closingIssuesReferences` cannot see it

*Origin: PR #509's own merge, 2026-07-16, demonstrated live.* The merge body
passed to `gh pr merge --body` contained the sentence `Phase-boundary bug sweep
per the standing rule: fixed #479 before starting work-order item 7` — narrative
prose, not an instruction to close anything. #479 closed at `07:19:30Z`, **one
second after** the merge at `07:19:29Z`. The outcome happened to be correct
(#479 *was* the issue the PR fixed), which is exactly what makes this worth
logging: **it worked by luck, and the same sentence naming a ticket that had to
stay open would have closed it silently.** The same body also said `Deliberately
left #483, #477, #485` — those survived only because that sentence used no
keyword.

Entry #20 established the authoring rule and its mitigation: *check
`gh pr view <n> --json closingIssuesReferences` BEFORE merging*. That probe is
**PR-body-scoped and cannot catch this**, for two independent reasons:

1. `closingIssuesReferences` is derived from the **PR body**. The merge
   subject/body is authored **at merge time**, after any probe has run, and
   never appears in that field.
2. The merge commit lands on the **default branch**, where GitHub parses closing
   keywords **natively** off the commit message. There is no PR-linked
   intermediary to inspect.

So a PR whose body is scrupulously clean — as #509's was, opening with *"Closes
nothing automatically"* — can still close issues via a body typed into the merge
command minutes later. The two channels are independent, and only one of them
has a pre-merge probe.

**Rule: the never-write-closing-keyword+#N rule of #20 governs EVERY text
GitHub parses — the PR body, the squash subject, the squash body, and any commit
message reaching the default branch. Treat the merge body as a PR body with no
safety net: it has no `closingIssuesReferences` probe, and by the time it is
wrong the merge has already happened.** Practical form: in a merge body, write
issue refs as bare `#N` and reach for a non-keyword verb — *"addresses #N"*,
*"the #N fix"*, *"per #N"* — reserving `fixed`/`closes`/`resolves` for nothing at
all, since the deliberate close is a separate `gh issue close` anyway (which this
repo already mandates, precisely because the grammar cannot be trusted). Same
family as #20 and #24's corollary: the tool's behaviour, not your intent, decides
what happens — and prose *about* an issue reads to GitHub exactly like an
instruction *to* it.

**Corollary — how to WRITE UP an incident like this without re-triggering it,
measured 2026-07-16.** The first draft of this entry's own PR body reproduced the
offending sentence in a **blockquote**, to illustrate it. `closingIssuesReferences`
then listed #479 — the write-up re-linked the very ref it was documenting, which
is #20's PR-#324 failure (*quoting* `does NOT close #90` closed #90 a third time)
recurring inside the entry written to prevent it. Probed all three forms directly
against the live PR:

| form in a PR body | links the ref? |
|---|---|
| blockquote — `> fixed #N` | **YES** |
| inline code span — `` `fixed #N` `` | no |
| fenced code block | no |

So #20's "quote-blind" is imprecise in a way that matters: **markdown quoting
(a blockquote, or English quotation marks) does NOT suppress the link — a CODE
SPAN or FENCED BLOCK does.** GitHub's linker skips code, not quotes. **Rule: when
documenting a closing-grammar incident anywhere GitHub parses — PR body, review
comment, merge body — put the offending text in a code span or fenced block, never
a blockquote, and verify with `gh pr view <n> --json closingIssuesReferences`
before merging.** The entries above and this one follow that form deliberately;
that is why their `fixed #N` examples are in backticks. Note the file you are
reading is safe either way — GitHub parses commit messages, PR bodies, and
comments, not repo file contents — but the PR that lands a file like this is not.

## 27. The hazard you SPOTTED and waved through is the one the reviewer files — write the test at the moment of the thought, not after the verdict

Measured on PR #754 (2026-07-29), which took **five review rounds** to reach a
clean APPROVE. Round 1 found things genuinely new to the author. **Every finding
from round 2 onward was already present in the author's own reasoning**, recorded
in the session, and consciously dismissed:

| round | finding | the author's prior thought |
|---|---|---|
| 2 | `mkdir` at file scope outran the source guard | both fixes written in the **same commit**, neither checked against the other |
| 3 | fire cap ordering made the re-grant boundary-dependent | *"the driver exits, the scheduled start resumes with a fresh budget, fine"* |
| 4 | quota reading stale across a long block | the PR body's own claim *"checked before every single fire"* — written, not verified |
| 5 | blind allowance charged twice per fire | *"is that OK? conservative... acceptable, but slightly odd"* |

The engineering around these was not the weak part: every fix was RED-first and
mutation-proven, and the mutations discriminated. **The failure was judgement
about what is "acceptable", and it failed four times running in the same
direction** — each dismissal leaned on the outcome being *fail-safe* (stops
early, never overspends). Fail-safe is a reason not to panic. It is not a reason
not to fix, and it is never a reason not to *test*, because the next change can
flip the direction underneath an untested assumption. Round 4 is the proof: round
3's reorder widened the exact window round 4's BLOCKING defect lived in.

**Rule: when you think "this case is probably fine because it fails safe", that
sentence is the trigger to write the test — immediately, in that turn.** The
thought has already done the expensive part (finding the case); stopping before
the assertion throws that away and hands it to a reviewer a round later. A
dismissal is only sound if it survives being written down as an executable
expectation. If the case is genuinely fine, the test is cheap and pins it against
the change that would break it; if it is not, you have found it yourself.

**Corollary — a claim in a PR body is an assertion under test, not narration.**
Round 4's BLOCKING finding was located by reading a sentence *the author wrote*
("the quota guard is still checked before every single fire") against the code,
and it was false across a long block. Before writing a safety property into a PR
body, name the test that pins it; if there is no such test, either write it or
downgrade the sentence to what is actually true. Same family as #25 — the guard
your comment argues for is the one nothing tests.

## 28. A health/progress signal must measure the ACTOR IT GOVERNS — not "is anything happening"

*Origin: #805 (PR #807, 2026-07-31), where ONE supervisor PR corrupted three
independent signals at once, two of which were written by the same author who
then relied on them.*

`loop/drive.sh` decides "has the loop made progress?" from three signals. All
three were implemented as "is something happening in this repo?" — a question
that is *adjacent* to the real one and looks identical while the operator is
idle. The operator works in the same repo, on the same `main`, so their activity
read as the loop's:

- **branch-ahead** matched `feat/loop*|fix/loop*` — prefixes under which the loop
  had **never pushed a single branch**. All five ever pushed were the operator's.
  Introduced by the author's own earlier stall fix (#775).
- **open-PR count** counted every open PR in the repo, and — unlike the branch
  check — had **no age bound**, so it masked a stall indefinitely.
- **gate-wait** waited on whichever PR was open, whoever's it was.

The live log carried all three in four consecutive lines, which is what made it
findable at all:

```text
open PR #803 present -- waiting for its gate to settle
PR #803 gate settled (or waited 0x30s)
'fix/loop-commit-before-long-wait' is ahead of main -- work in flight, not a stall
=== FIRE 11 (main=ce88319 openPR=1) ===
```

Consequence: while the operator held one open PR, a genuinely stalled loop could
not reach `MAX_STALL` and kept firing at real spend — the exact failure the
detector exists to prevent.

**Why it survived review three times:** every one of these is *correct* in the
common case. A repo where only the loop works gives the same answer to both
questions, so the test that would discriminate ("the OPERATOR does something —
does the loop still count itself as stalled?") is one nobody writes, because it
requires modelling a second actor. Same family as #25: the happy path passes
either way.

**Rule: for any signal that gates an autonomous actor's behaviour, name the actor
in the predicate and test it against a DIFFERENT actor's activity.** Concretely:
one shared predicate (`is_loop_ref`) rather than the same `case` pasted at three
call sites — three copies is three chances to fix two — and at least one test per
signal where the *other* actor is the one moving. Pick the fail-safe polarity
deliberately and say which it is: here a misnamed loop branch under-counts
progress and can trip a FALSE stall, which *stops* the loop, while the opposite
error *spends*. Stopping is the cheap mistake.

**Corollary, same PR: a file format is not a risk class.** `is_doc_only()`
classified by extension, so `loop/prompt.md` — the loop's **work order**, whose
edits change what an unattended agent does overnight — counted as documentation
for both the merge gate and the review-bot skip. PR #803 changed it and got
*"Doc-only diff — engineering review skipped to save tokens."* Ask what a file
DOES, not what it is named: in a repo where control planes are written in
Markdown, "is it a doc?" and "is it safe to skip review?" stopped being the same
question. Fixed at the shared predicate (`merge_gate.doc_only_exclude_paths`,
checked FIRST), never by forking it per-consumer — the divergence #192 exists to
prevent.

**AMENDMENT, five hours later, by the entry's own author (#823).** The rule above
says *name the actor in the predicate*. The fix that produced this entry did name
it — and still broke, because **the name was derived from a census, not from a
rule.** `is_loop_ref` matched `*/studio-*` only, justified in its own comment by:
*"across the last 40 merged PRs every `*/loop-*` branch was the operator's."*

That measurement was correct. The inference from it was not. It held only
because the loop had never yet worked on `loop/` itself — and hours later it did
(#808, #811, #821), naming those branches the way it names every other one,
`fix/loop-<issue>-<slug>`. The predicate then excluded **the loop's own work**:
measured 2026-07-31 10:54Z, PR #822 open with a fire actively polling its gate,
while the driver logged `no progress … no open PR … stall=1/3` and did not wait
on that gate. Three of those STOPS the driver claiming the queue is drained —
the identical false stop #775 exists to prevent, reintroduced by the fix for it.

**A census tells you what the actors have done, not what they may do.** It is
evidence about the past that reads exactly like a rule about the future, and it
is at its most convincing when the sample is large — 40 PRs *felt* like proof.
The tell: the justification is a COUNT ("every one so far", "all N of them")
rather than a REASON the other case cannot arise. There was no reason here; the
loop simply had not been given that kind of work yet.

**Rule: when a predicate identifies an actor, key it on something the actor
CONSTRUCTS, not on something it has HAPPENED to use.** The durable
discriminator was structural and available the whole time — every branch the
loop opens comes from a ticket and carries its number (`loop-811-`,
`studio-806-`), because that is how it works; the supervisor's do not. And when
the safe and expensive polarities are split across the same predicate, give the
*other* actor a RESERVED namespace (`supervisor/**`) rather than relying on it
to keep avoiding a pattern by habit — a convention only one side knows is the
same census error one level up.

## 29. `grep -c … || echo 0` DOUBLE-EMITS on no match — an expected-ABSENT assertion is then permanently red

Found while writing `#806`'s tests (`loop/test_quota_guard.sh` section 45), and it
is the third member of a family already in this log (#7 `producer | grep -q` under
`pipefail`; #11 a non-zero function poisoning `… && echo 0`): **a shell idiom that
silently produces a permanently-red or vacuous assertion.**

`grep -c` prints the count AND exits 1 when the count is zero. So:

```bash
"$(grep -c 'needle' "$f" 2>/dev/null || echo 0)"     # no match -> "0\n0", not "0"
```

The `|| echo 0` was added for the FILE-MISSING case, and it does fix that — but it
also fires on the ordinary no-match case, appending a second `0` to a value that
already read `0`. Measured: `[0\n0]`.

This never bites where the expectation is a NON-ZERO count (the `||` branch is
unreachable once there is a match), which is why three pre-existing uses in that
file are fine and the idiom looks safe by induction. It bites the moment you
assert that something is **absent** — exactly the assertion that pins "the guard
did NOT do the thing", which is the interesting half of most safety tests.

**Rule: for an expected-ABSENT assertion, use `grep -q` and map the status, never
`grep -c`.**

```bash
"$(grep -q 'needle' "$f" 2>/dev/null && echo 1 || echo 0)"   # 1 present, 0 absent
```

Same shape as #25: the assertion that never goes green is easy to spot, but its
sibling — the one that never goes RED — is the dangerous one. Before trusting any
new assertion about absence, make the thing PRESENT once and watch it fail.

## 30. `ls` and `*` are BLIND TO DOTFILES — an "is it clean?" assertion over hidden state always passes

Found by the pre-PR correctness lens on `#806`, and it is the second vacuous-test
family that one ticket exposed (see #29). Both are the same disease: an assertion
about something being **absent** that could never have observed it.

`loop/drive.sh`'s state files are all dotfiles (`.last_quota`, `.poll_memo`,
`.shadow_stamp`), so its temp files are `.last_quota.tmp.<pid>`. Two idioms were
used to assert "no temp was left behind", and **neither can see one**:

```bash
ls "$dir" | wc -l                      # `ls` omits dotfiles entirely
ls "$dir"/*.tmp.* >/dev/null 2>&1      # a leading `*` never matches a leading dot
```

Measured cost: with the first idiom, deleting the guard it covered
(`[ -d "$file" ] && return 1`, which stops `mv -f tmp DIR` succeeding **into** a
directory and returning 0 with no record written) left **all 28 assertions in
that section green** while a real temp sat inside the directory. The other half
of that test — "the write was refused" — was produced independently by a later
check, so the guard had *no* cover at all while appearing to have two.

**Rule: any assertion over directory contents that could involve a dotfile uses
`ls -A`, or names the dot explicitly (`"$dir"/.thing.tmp.*`).** Prefer naming the
dot where the destination is known — it is exact, and it does not trip
shellcheck's SC2010 the way `ls -A | grep` does.

The deeper rule is the one #25 and #29 keep restating from different angles: **a
test that asserts absence is only worth what its ability to see presence is
worth.** Make the thing PRESENT once and watch the assertion go red. If it does
not, the test is decoration. Mutation-prove the guard, not just the feature.

## 31. A bound must not be transported by the mechanism whose loss it exists to survive

*Origin: 2026-07-31, PR for #811 (driver self-adoption).* `loop/drive.sh` gained
the ability to re-`exec` into merged code, handing its cross-fire counters to the
new process in a state file. One of those counters was `adoptions`, bounded by
`MAX_SELF_ADOPT` — the guard whose entire job is to stop an adopt-`exec` **loop**
when the driver's own file keeps changing underneath it.

That cap rode in the same handoff record as everything else. Mutation-testing the
record's reader into a no-op did not produce a red assertion: it **hung the test
suite**. Every exec'd process restarted at `adoptions=0`, so a file that changed
on every fire was adopted forever and no fire ever completed. The guard against
infinite adoption was itself carried by the thing whose failure causes infinite
adoption.

**Rule: when a guard exists to survive the failure of mechanism X, its state must
not travel through X.** Give it a second, independent carrier and combine them in
the direction that keeps the guard armed — here the count also rides in the
environment (which `exec` preserves for free and no other restart can supply),
and the two are reconciled by MAX, never by preference, so a lost carrier can
only ever *tighten* the cap.

Two corollaries worth keeping:

- **The failure mode of a transport-coupled bound is a hang, not a wrong answer.**
  A test suite that only greps for `FAIL` will report nothing at all. Treat "the
  suite stopped producing output" as a result, not as an infrastructure problem.
- **Ask the question at design time by naming the dependency out loud:** "this
  guard protects against X failing — what does it need in order to run *when X
  has failed?*" For a retry cap, a circuit breaker, a stall detector or a spend
  bound, the answer is almost never "the thing X was carrying".

## 32. A MUTATION TEST edits the working tree — so it voids any build or suite running concurrently

Mutation-proving a test ("break the guard, watch it go red, restore it") is a
required practice here. It is also a *write to the working tree*, and that makes
it incompatible with anything else reading that tree at the same time.

Measured on the #878 branch. A full `pnpm -C studio test:e2e` was launched in the
background; while it ran, three mutations were applied and reverted in the same
checkout. `test:e2e` begins with `pnpm build`, so the build compiled a tree in
which the feature under test had been temporarily gutted. The run came back
**157 passed / 4 failed** — and the specs most certain to break were among the
*passes*. Every one of those passes was a reading of a mutant.

The failure is silent and reads as good news. Nothing errors; the suite simply
describes code that no longer exists. It is the same class as the stale-`dist`
false pass, but worse, because the artifact is freshly built — the usual
"is the build current?" check says yes.

**Rule: one writer at a time. Never mutate the working tree while a build, a test
suite, a subagent, or a browser session is reading it.** Either serialise them, or
mutate in a `git worktree add` copy so the two never share a checkout.

Two corollaries:

- **A concurrent-mutation run is void in BOTH directions.** It cannot be salvaged
  by "the failures are real and the passes are suspect" — a mutation can make a
  test pass as easily as fail. Discard the whole run and repeat it on a quiescent
  tree; do not reason from any part of it.
- **Diagnose a surprising PASS with the same energy as a failure.** The thing that
  caught this was dumping the actual string an assertion was matching against
  (`expect(x).toBe('DUMP')`), not re-reading the assertion. An assertion you
  expected to fail and which passed is evidence about the *harness*, not a happy
  accident.
- **Two subagents dispatched together are two writers.** Hit on the #884 branch:
  the pre-PR CORRECTNESS and FIT lenses were launched in one message, as the
  workflow encourages. The correctness lens mutation-tests — that is its job — so
  it wrote to the tree while the FIT lens ran `vitest`, `typecheck` and `lint`
  against it. FIT reported the collision itself, and correctly flagged its own
  green runs as provisional and a `lint` failure that was really the other agent's
  scratch probe. The rule above already says "or a subagent"; what is easy to miss
  is that *you* create the collision by fanning out, and that the reviewer's report
  arrives looking authoritative. **Run a mutating lens serially, or give it
  `isolation: "worktree"`.** Read any parallel reviewer's tool output as void, not
  as evidence.

## 33. A COMPOUND mutation proves only that the compound matters — mutate one property at a time

Mutation-proving answers "can this test fail?". It only answers "can it fail *for
the reason stated*" if the mutation breaks **exactly one** property.

Measured on the #884 branch. A regex was anchored at index 0 on purpose —
`/^nodes?\.([^.\s:]+)(\.?)/` — because the same pattern occurs later in the string
where it must NOT be rewritten. The test claiming to guard the anchor was
mutation-proved by changing the regex to `/\bnodes?\.…/g`: two tests went red, and
the anchor was recorded as pinned.

It was not. That mutation changed **two** things — the anchor *and* the global
flag — and the red came from the global flag alone. A review lens removed only
the `^`, leaving the regex non-global, and **all 1172 tests passed**.
`String.replace` with a non-global regex rewrites only the FIRST match, and in
every fixture that test used, the first match *was* the location. The anchor was
untested, and a real message existed that the missing anchor corrupted.

**Rule: the mutation must be the minimal edit that falsifies the property the test
names.** If the test says "anchored", delete the `^` and nothing else. If it says
"short-circuits", remove the early return and nothing else. A mutation that
touches two properties tells you at least one of them is guarded — which is not
what the test claims.

Corollaries:

- **Write the mutation from the test's SENTENCE, not from the code.** "leaves a
  reference in the body verbatim" names the anchor; reaching for the nearest
  plausible edit instead is what produced the compound.
- **A fixture can hide a property.** The anchor is only load-bearing when the
  first match is in the body, which no fixture produced. When a minimal mutation
  comes back green, the fixture is usually the reason — fix the fixture, not the
  assertion.
- Same shape as #25 (*the guard your comment ARGUES FOR is the one nothing
  tests*). #25 is about the untested guard; this is about the test that looks like
  it covers one and does not.

## 34. An invisible hit target is a SECOND geometry — and often the one the library actually consults

A spacing constant only guards a gesture if **every element claiming space at
that spacing respects it** — including the ones with no measurable box.

Measured on the #992/#997 branch. `SOURCE_PORT_PITCH` (14px) spaces a node's
outcome ports, and two tests guarded it: one pinned `CONNECTION_RADIUS` under
half the pitch, another measured the rendered dots' gaps in a real browser. Both
stayed green while the canvas authored the wrong edge.

The change had added a WCAG-motivated 24×24px `::after` to each port — invisible,
unmeasurable (a pseudo-element has no `getBoundingClientRect`), and larger than
the pitch it sat on. React Flow does not resolve a drop against its own measured
handle bounds: `isValidHandle` calls `document.elementFromPoint` and, in its own
comment, "always want[s] to prioritize the handle below the mouse cursor over the
closest distance handle" (`@xyflow/system` 0.0.79, index.js:2563-2574). So that
invisible box, not the dot and not the snap radius, decided every drop.

It bit twice in one property, in both axes:

- **Vertically**, each target reached ±12px into a 14px pitch, so it covered both
  neighbours. A drag approaching `success` from above crossed `failure`'s target
  first; `.connectingto { transform: scale(1.6) }` then grew the wrongly-picked
  port's target over `success`'s own centre, so a pointer finishing EXACTLY on
  `success` still dropped on `failure`. A duplicate that should have been refused
  was silently authored as a valid `on failure` edge.
- **Horizontally**, the same 24px reached outward over the reconnect anchor —
  which React Flow draws tangent to the dot, so the crescent beyond it is the
  only grabbable part of a selected edge's end. Pressing the anchor pressed the
  port instead, turning "pick this edge up" into "start a new connection", which
  then failed as a self-connect and left the edge untouched.

**Rule: when a constant spaces a gesture, enumerate everything that claims space
there — drawn or not — and bound each by that constant.** Take all the room there
is and none belonging to another gesture: the target's height became the pitch
exactly (targets tile instead of overlapping) and its width grew inward only,
ending at the dot's outer edge.

Corollaries:

- **Give the constant one home and let the stylesheet spend it.** The pitch lives
  in TypeScript (`sourcePortOffset`); CSS receives it as `--port-pitch` rather
  than restating `14px`. An unresolved custom property collapses the box to zero,
  which fails toward "no enlargement", never toward "reaches a neighbour".
- **Assert OWNERSHIP, not size.** A size check restates the stylesheet. "A point
  45% of a pitch from a port resolves to THAT port" says what the size is for,
  and tracks the constant when it changes.
- **Read the library's hit-test path before trusting a coordinate.** Two
  hypotheses failed here on the assumption that a pixel-perfect drop coordinate
  decides the outcome. What settled it was instrumenting `elementFromPoint` at
  each step of the drag and then reading `isValidHandle` itself — the comment in
  the vendored source stated the priority outright.
