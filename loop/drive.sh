#!/bin/bash
# studio-build-loop DRIVER -- headless CONTINUOUS driver.
#
# Fires run.sh (ONE fresh headless `claude` session per piece) back-to-back.
# The driver is the ONLY thing that loops; it holds NO build context -- every
# piece is its own fresh headless session.
#
# STOP MODEL (operator, 2026-07-16 -- "no max limits; stop only when I specify
# or nothing more to do; pause+backoff when limits hit"), AMENDED 2026-07-25
# after the quota incident: the run-forever posture is now BOUNDED by quota and a
# fire cap, because an uncapped night took the 7-DAY window to 97% and that window
# resets weekly -- i.e. it can lock the operator out of their own sessions for
# days. It STOPS on:
#     * an operator signal issue open: [operator-decision] / [mvp-ready]
#       ("you specify" / the milestone), or a real [loop-blocked];
#     * nothing more to do: MAX_STALL consecutive no-progress fires;
#     * QUOTA: 7-day utilization >= QUOTA_STOP_PCT (or unreadable for more than
#       QUOTA_UNKNOWN_FIRES fires) -- checked BEFORE the auth probe so a
#       quota-blocked scheduled start costs ZERO tokens;
#     * MAX_FIRES fires in one driver run (scheduled starts resume it);
#     * `launchctl unload` (operator).
#   Quota/cap stops are CHEAP and self-resuming: the plist's scheduled starts
#   re-check and fire again once the window has room.
#   On a LIMIT or TRANSIENT -- an auth hiccup, a usage cap, a rate limit -- it
#   does NOT stop: it PAUSES, BACKS OFF (escalating), and RETRIES until clear.
#
# ALERTS (issues):
#   [loop-paused]  -- backing off a transient/limit; self-heals, auto-closed on
#                     recovery; NEEDS NO ACTION and does NOT stop the loop.
#   [loop-blocked] -- genuinely stuck (a real, non-limit crash loop with auth
#                     confirmed good); needs the operator; STOPS.
#   [operator-decision]/[mvp-ready] -- a raised fork / the milestone; STOPS.
#
# Launched by launchd (com.autonomy.studio-build-driver). To stop:
#   launchctl unload ~/Library/LaunchAgents/com.autonomy.studio-build-driver.plist
set -uo pipefail

INFRA="${INFRA:-/Users/lukebradford/Dev/studio-loop}"
REPO="${REPO:-/Users/lukebradford/Dev/studio-loop-repo}"
DLOG="${DLOG:-$INFRA/logs/driver.log}"
MAX_STALL="${MAX_STALL:-3}"       # consecutive no-progress fires = nothing more to do
AHEAD_MAX_AGE="${AHEAD_MAX_AGE:-86400}"  # a studio branch whose tip is older than this is treated as
                                  # ABANDONED, not work in flight (#775 review): otherwise one stale
                                  # branch from a crashed session masks the stall detector forever.
MAX_CRASH="${MAX_CRASH:-5}"       # consecutive REAL (non-limit) crashes = broken, needs operator
GATE_WAIT_TRIES="${GATE_WAIT_TRIES:-60}"   # polls before giving up on a PR gate;
                                  # GATE_WAIT_TRIES x GATE_WAIT_SLEEP = up to 30 min by default
GATE_WAIT_SLEEP="${GATE_WAIT_SLEEP:-30}"   # seconds between gate polls; tests set 0
AUTH_TRIES="${AUTH_TRIES:-0}"     # 0 = back off + retry auth FOREVER; >0 caps it (tests only)
MAX_LOOPS="${MAX_LOOPS:-0}"       # 0 = run forever; >0 caps iterations (tests only)
BACKOFF_BASE="${BACKOFF_BASE:-30}"   # base backoff seconds; tests set 0 to neutralise sleeps
MAX_FIRES="${MAX_FIRES:-0}"       # 0 = UNCAPPED (operator, 2026-07-29). Was 6.
                                  #
                                  # HISTORY, because removing this is only safe for a reason. The
                                  # cap was added after the 2026-07-25 incident: 16 fires overnight
                                  # (~$652) took the 7-DAY window to 97%, and that window resets
                                  # weekly, so one uncapped night locked the operator out of their
                                  # own sessions for days. At the time the cap was the only bound
                                  # that WORKED -- QUOTA_STOP_PCT existed but could be defeated by
                                  # an unreadable reading, and it was (2026-07-26: both sources
                                  # down, fired blind into a ~98% window).
                                  #
                                  # What changed: #754 made the quota guard load-bearing on its own
                                  # -- it refuses on a fresh cached high reading when live reads
                                  # fail, bounds blind fires with their own counter, and re-checks
                                  # after EVERY blocking construct (auth block, PR-gate wait) so a
                                  # fire is never authorised by a stale figure. The cap was
                                  # meanwhile ending runs with the window at 3%.
                                  #
                                  # RESIDUAL RISK, stated rather than discovered: the guard is
                                  # checked BEFORE each fire, so the driver will start a fire at
                                  # 79% and one fire has measured up to ~$58. Expect overshoot of
                                  # at most one fire past QUOTA_STOP_PCT, which is why that is set
                                  # to 80 and not 95. The 5-hour window is the other natural
                                  # throttle: hitting it is a LIMIT, which pauses and backs off
                                  # rather than stopping.
                                  #
                                  # Set MAX_FIRES to a positive number to restore a per-run cap.
QUOTA_STOP_PCT="${QUOTA_STOP_PCT:-80}"      # refuse to fire at/above this 7-day utilization %
QUOTA_UNKNOWN_FIRES="${QUOTA_UNKNOWN_FIRES:-2}"  # fires allowed while utilization is UNREADABLE
AUTH_LONG_BLOCK="${AUTH_LONG_BLOCK:-6}"     # ensure_auth retries that make a block "long". The
                                  # backoff is capped at 600s, so 6 retries is ~30min MINIMUM and
                                  # in practice much longer -- comfortably past a transient hang.
MAX_BUDGET_REGRANTS="${MAX_BUDGET_REGRANTS:-1}"  # how many times ONE driver run may re-grant the
                                  # fire budget after a long block. See the re-grant block below;
                                  # this is what stops flapping auth from uncapping the driver.
QUOTA_CACHE="${QUOTA_CACHE:-$INFRA/.last_quota}"  # "<epoch> <pct>" of the last READABLE reading
QUOTA_CACHE_MAX_AGE="${QUOTA_CACHE_MAX_AGE:-86400}"  # seconds a cached reading stays evidence
QUOTA_POLL_MEMO="${QUOTA_POLL_MEMO:-$INFRA/.last_quota_poll}"  # "<epoch> <pct|->" of the last
                                  # source-2 POLL -- its OUTCOME, success or failure, not a reading
                                  # to fall back on. See quota_poll_memo_read (#777).
QUOTA_POLL_MIN_INTERVAL="${QUOTA_POLL_MIN_INTERVAL:-60}"  # min seconds between DIRECT polls of the
                                  # shared rate-limited upstream by source 2. 60s to match what the
                                  # other two sources already do -- studio's `DEFAULT_TTL_MS`
                                  # (`claude-quota.ts`) and the prototype dashboard's sampler TTL
                                  # (engine `lib/claude_usage.py`) are both 60s. 0 disables.
# Where `claude_usage.py` -- the loop's OWN 7-day utilization reader -- lives. It
# ships BESIDE this file, so the default is simply $INFRA (in production this
# script IS $INFRA/drive.sh). #764 relocated it out of the engine's `lib/`: that
# directory is parked by cutover C3 (#410), which would have taken the guard's
# second source with it and left only the source that has never yet answered.
# A sync of the live control plane must therefore carry BOTH files.
LOOP_LIB="${LOOP_LIB:-$INFRA}"
DASH_URL="${DASH_URL:-http://127.0.0.1:8787/api/state}"
# Studio's native replacement (#440 C1). 8788 -- NOT studio's 8080 dev default --
# because 8080 is contended on this machine: any `pnpm dev`, from any checkout,
# takes it, and a wrong-but-answering server 404s, which reads as UNREADABLE
# forever while looking correctly configured. 8788 belongs to the SUPERVISED
# service installed by `install_studio_server.sh` (#765 Defect 2) and to nothing
# else, so "is the guard's source up?" is an answerable question.
#
# This default is the SINGLE SOURCE OF TRUTH for that port. The repo's copy of
# the driver LaunchAgent used to pin STUDIO_QUOTA_URL in EnvironmentVariables,
# which BEATS a `${VAR:-default}`. That pin never actually fired (the installed
# agent predates it and has none), so it was a trap rather than a live bug: the
# first sync of that file would have frozen this default at 8080 and made every
# later edit here silently inert. The pin is gone; keep it gone. The only other
# copy is `DEFAULT_PORT` in `install_studio_server.sh`, and
# `test_install_studio_server.sh` asserts the two agree.
STUDIO_QUOTA_URL="${STUDIO_QUOTA_URL:-http://127.0.0.1:8788/api/quota}"
# DERIVED from the quota URL rather than written out again (#832). The port
# above already has exactly one other copy, guarded by a test; a third one
# spelled out here is how the stale 8080 pin survived its own reason, and this
# URL points at the SAME server by construction -- which is the property the
# drift half depends on, since a version served by one process says nothing
# about the build another process is running.
# The trailing-slash strip runs FIRST: without it a quota URL written
# `.../api/quota/` fails to match the suffix and derives `.../api/quota//api/version`,
# which degrades to UNKNOWN -- the safe direction, but silently, and the whole
# point here is that the two URLs address the SAME process.
# An `if` rather than a one-line `${VAR:-...}`: the derivation is two strips, and
# chaining them onto the default would also strip and re-suffix an EXPLICIT
# override, turning `STUDIO_VERSION_URL=http://host/v` into `http://host/v/api/version`.
if [ -z "${STUDIO_VERSION_URL:-}" ]; then
  # Two strips, both onto the destination itself, so the intermediate needs no
  # name in this scope: a leftover `STUDIO_VERSION_BASE` global would outlive the
  # lines that need it and read like configuration, which is exactly what this
  # section is. Deliberately NOT `set --` for scratch space -- this file is
  # SOURCED (by every test, and by anything reusing its helpers), and `set --` at
  # top level destroys the sourcing context's own positional parameters.
  STUDIO_VERSION_URL="${STUDIO_QUOTA_URL%/}"
  STUDIO_VERSION_URL="${STUDIO_VERSION_URL%/api/quota}/api/version"
fi
# QUOTA_SHADOW_STAMP / QUOTA_SHADOW_MIN_INTERVAL used to live here. Both are gone with C3
# (#410): the diagnostic probe they throttled existed only to ask studio a question the
# read order could not, back when studio was source 3 and could be reached only after two
# other sources failed. Studio is source 1 now, so every fire polls it on the decision path
# and `quota source: studio` is the ordinary log line -- the probe's gate could never be
# true again. Removed rather than left dormant: unreachable machinery inside a spend guard
# is a maintenance hazard, and `git log` keeps it. A leftover $INFRA/.last_quota_shadow on
# a live control plane is inert.
DRIFT_REPORT="${DRIFT_REPORT:-1}"  # set to exactly "0" to silence the #808 drift report. Any OTHER
                                  # value still reports: a monitor a typo can switch off without
                                  # saying so fails in the monitored direction, and `DRIFT_REPORT=no`
                                  # reading as "off" is the same silence this ticket exists to end.
SELF_ADOPT="${SELF_ADOPT:-1}"     # set to exactly "0" to refuse self-adoption of merged code and
                                  # go back to "report STALE and wait for a human kickstart" (#811).
                                  # Same rule as DRIFT_REPORT above and for the same reason: any
                                  # OTHER value still adopts, so a typo cannot silently disarm it.
MAX_SELF_ADOPT="${MAX_SELF_ADOPT:-3}"  # adoptions per driver run. Bounds an adopt-LOOP: if the file
                                  # kept changing under the driver (a sync in progress, an editor
                                  # writing every few seconds) an unbounded driver would exec on
                                  # every iteration and never fire. Carried across the exec in the
                                  # handoff, so the bound is on the RUN, not on each process.
DRIVER_HANDOFF="${DRIVER_HANDOFF:-$INFRA/.driver_handoff}"  # "<epoch> <k=v,...>" carrying the
                                  # cross-fire counters across a self-adopt exec. Consumed once,
                                  # by the process that wrote it (#811).
HANDOFF_MAX_AGE="${HANDOFF_MAX_AGE:-300}"  # a handoff older than this is not a continuation. The
                                  # exec is immediate, so this is generous by two orders of
                                  # magnitude; it exists so a record left behind by a process that
                                  # died between the write and the exec cannot be picked up later.
DRIVE_SELF="${DRIVE_SELF:-${BASH_SOURCE[0]}}"  # the file THIS process was started from. Overridable
                                  # so the drift checks are unit-testable against a scratch file
                                  # instead of against drive.sh itself.
# Resolved to an ABSOLUTE path here, while the cwd is still the one this process
# was launched in. `drive.sh` does `cd "$REPO"` further down, and the hash is
# re-taken on every fire -- so a relative `$0` (`./drive.sh`, as any manual run
# produces) would resolve against the repo by then and hash nothing. Verified:
# it yields an empty hash, i.e. `driver code: UNKNOWN` forever. That direction is
# at least safe rather than open, but the check is silently gone, which is the
# same class of quiet loss #808 exists to end. launchd passes an absolute path,
# so this is about the manual path, not the scheduled one.
case "$DRIVE_SELF" in
  /*) ;;
  *) ds_dir="$(cd "$(dirname "$DRIVE_SELF")" 2>/dev/null && pwd)"
     # An unresolvable dirname leaves DRIVE_SELF alone rather than building a
     # bogus "/name": the later shasum then fails and reads UNKNOWN, which is
     # the honest answer. Never invent a path that might hash some other file.
     [ -n "$ds_dir" ] && DRIVE_SELF="$ds_dir/$(basename "$DRIVE_SELF")" ;;
esac

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >>"$DLOG"; }

# --- is_loop_ref: is this branch the LOOP's own work? -------------------------
# #805. Every progress signal the driver keeps must measure the ACTOR IT
# GOVERNS. All three read "is something happening in this repo?", which is a
# different question: the operator works in the same repo, on the same main,
# and their activity is not the loop making progress.
#
# Measured 2026-07-31, one supervisor PR (#803) corrupting all three at once:
#   - the stall counter reset ("'fix/loop-commit-before-long-wait' is ahead of
#     main -- work in flight"), so a genuinely stalled loop could not trip it;
#   - `openPR=1` suppressed the stall branch independently, and with NO age
#     bound (the branch signal at least expires after AHEAD_MAX_AGE);
#   - the driver waited on #803's gate ("PR #803 gate settled") -- a gate that
#     was never the loop's to wait for.
#
# CORRECTED SAME DAY (#823). The first cut matched `*/studio-*` ONLY, on the
# evidence that across 40 merged PRs every `*/loop-*` branch was the operator's.
# That evidence was TRUE and the inference from it was WRONG: it held only
# because the loop had never yet worked on `loop/` itself. Hours later it did --
# #808, #811, #821 -- and named those branches exactly as it names every other,
# `fix/loop-<issue>-<slug>`. So the predicate started excluding the LOOP'S OWN
# WORK: measured 2026-07-31 10:54Z, PR #822 (`fix/loop-821-test-harness-orphan`)
# was open with a fire actively polling its gate, while the driver logged
# "no progress (main unchanged, no open PR, no branch ahead) stall=1/3" and did
# not wait on that gate at all. Three of those and it STOPS, reporting "nothing
# more to do (or the queue is drained)" with a PR in flight -- precisely the
# false stop #775 exists to prevent, reintroduced by #805's fix for it.
#
# The durable discriminator is STRUCTURAL, not a prefix census: the loop always
# embeds the ISSUE NUMBER it is working (`loop-811-`, `loop-821-`, `studio-806-`),
# because every branch it opens comes from a ticket. The supervisor's do not
# (`fix/loop-commit-before-long-wait`, `supervisor/...`, `docs/...`). `studio-*`
# stays broad because the loop has also shipped un-numbered studio branches
# (`fix/studio-sweep7-agent-cli-timeout-metering`); only the `loop-` arm needs
# the digit, and that is the arm the two actors actually collide on.
#
# Fail-safe direction, unchanged and now load-bearing in BOTH arms: a loop branch
# outside the convention reads as "not the loop's", which under-counts progress
# and can trip a FALSE stall -- and a false stall STOPS the loop, while the
# opposite error SPENDS. Stopping is the cheap mistake. The residual hazard is a
# SUPERVISOR branch named `*/loop-<digits>-*`, which would read as the loop's and
# suppress the stall; that is the expensive polarity, so the supervisor's
# convention is now the reserved `supervisor/**` prefix (prompt.md rule 0).
is_loop_ref() {
  case "${1:-}" in
    feat/studio*|fix/studio*) return 0 ;;
    feat/loop-[0-9]*|fix/loop-[0-9]*) return 0 ;;
    *) return 1 ;;
  esac
}

# --- quota_pct: the 7-day subscription utilization as an INTEGER percent, or ""
# when it cannot be read. Echoes to stdout; never fails the caller.
#
# THREE sources, and the ORDER is the load-bearing part. C3 (#410) REORDERED it;
# what follows supersedes C2's (#440) order, which ran dashboard -> reader -> studio:
#   1. studio's native endpoint (`$STUDIO_QUOTA_URL`, #440 C1) -- SAMPLER-BACKED since C3
#   2. the prototype dashboard (`$DASH_URL`) -- retired, kept only as the rollback path
#   3. the loop's OWN usage reader (`$LOOP_LIB/claude_usage.py`; relocated out
#      of the engine by #764; #766 fixed this CALL SITE against the old module)
#
# All three bottom out in the SAME upstream, `GET /api/oauth/usage`, with the
# same OAuth token off the same account -- so they share ONE rate-limit budget.
# That endpoint 429s under direct polling (observed 2026-07-25, re-confirmed
# 2026-07-29: eight consecutive direct polls over 12s, all 429).
#
# What separates them is therefore not the data but the PATH to it, and that is
# the whole reason the order changed. A source is cheap to ask when asking it does
# not touch the upstream, and expensive when it does:
#
#   * studio (1) now samples on an `unref`'d interval inside the supervised server
#     and answers `/api/quota` from that cache (`quota-sampler.ts`, armed by
#     `CLAUDE_QUOTA_SAMPLER=1` in the service plist). Its REQUEST path no longer
#     reaches the provider at all, so the guard may poll it as often as it likes.
#     That -- not novelty -- is what earns it first place; #765 stated the
#     condition in exactly those terms ("a sampler-backed studio can be polled
#     freely ... that is the state in which studio actually deserves to be the
#     primary source"), and C3 is the change that satisfies it.
#   * the dashboard (2) rode through a 429 the same way, on a background thread
#     behind a warm cache. It was source 1 for that reason and is now RETIRED --
#     C3 stops its sampler, because two standing samplers on one budget is the one
#     thing #770 refuses. It stays in the list, second, purely so that re-loading
#     the unit is a COMPLETE rollback with no code revert (see the runbook note
#     below). Once the engine is parked it will simply fail fast, which costs one
#     refused local connection and nothing upstream.
#   * the loop reader (3) is the only remaining DIRECT poll: a fresh process per
#     call, from a cold start, throttled by the #777 poll memo. It is LAST on
#     purpose -- it is the only source whose failure mode is to add load to the
#     very budget it is measuring, so it is reached only when both cache-backed
#     sources have already failed.
#
# WHAT THE OLD ORDER ARGUED, and why it no longer applies. Until C3 the rule was
# "between the two direct pollers, the PROVEN one goes first": #766 measured this
# reader -- then still in the engine's `lib/`, before #764 relocated it --
# returning 10, matching the dashboard at that moment, whereas studio had never
# once returned a number here (`account.claude: null` on every probe -- its
# reader was LAZY, so every read was the direct poll that 429s;
# `studio/packages/server/src/quota/claude-quota.ts`, and #765). That argument was
# about two DIRECT pollers. It is void now because studio is no longer one of them:
# the sampler moved its provider call off the request path entirely. The comparison
# that decides the order today is cache-backed vs direct, not proven vs unproven.
#
# BE HONEST ABOUT WHAT IS STILL UNMEASURED. Studio has not yet answered here, and
# C3 does not make it answer -- it removes the two reasons it could not (no sampler,
# and a rival sampler holding the bucket). Whether it now does is the measurement
# this reorder exists to obtain, and the evidence is a run of scheduled fires
# logging `quota source: studio`. If they instead log `quota source: loop`, studio
# is failing for a THIRD reason and the finding belongs in a ticket, not in a
# silent re-reorder. The guard stays fail-safe either way: nothing below can
# manufacture a reading, and an unreadable source falls through to the next.
#
# Do not read the old contrast as "the loop reader works and studio does not". Both
# were re-measured on 2026-07-29 while the dashboard was answering 14%: the loop
# reader's token read succeeded (108 chars) and the endpoint returned 429, i.e.
# the SAME failure studio reports. The honest reading is that whichever process
# holds the bucket is the one that answers, and right now that is the dashboard's
# 60s sampler -- continuously, which is why the two direct pollers see a
# permanently empty bucket. #766's success was measured in a gap between samples.
#
# WHY THE READER IS LAST, not merely later. Once the dashboard is retired its read
# fails on EVERY call, so any quota_pct invocation that reaches this reader becomes a
# Keychain read plus a direct poll -- and quota_gate can call quota_pct three times
# per iteration, plus once per AUTH_LONG_BLOCK retry while blocked, i.e. tens of polls
# in one iteration during the 71h block this file documents. This reader used to be the
# unthrottled one (a fresh process per call, so no in-memory cache and nothing giving
# it a cross-process one), which made it able to self-inflict the very 429 that then
# reads as UNREADABLE. FIXED by #777: it now answers from a poll memo inside
# QUOTA_POLL_MIN_INTERVAL, memoises failures too, and drops the memo after every fire
# -- see `quota_poll_memo_read` for the whole argument. That bound is what makes it
# SAFE to keep; being reached only after two cache-backed sources have failed is what
# makes it CHEAP. The two bounds are still not symmetric: studio widens geometrically
# to ~8min once it sees a 429 (`claude-quota.ts`), whereas this reader's bound is a
# FLAT 60s and does not widen, so under a sustained 429 it keeps knocking once a
# minute where studio retreats. Deliberate -- 1/min is three orders off the measured
# failure (eight polls in 12s) and the memo makes the rate knowable -- but if the
# post-C3 logs show it sitting in a 429, widening its interval on a failed poll is the
# next move, not shortening it.
#
# A CONFOUND THE OLD ORDER LEFT BEHIND, now resolved in studio's favour: the
# dashboard's sampler did not merely answer first, it CONTINUOUSLY held the shared
# bucket, which is why the two direct pollers behind it saw a permanently empty one.
# So retiring it does not only remove the best source -- it also stops the polling that
# starved the others. C3 hands that standing-sample slot to studio rather than leaving
# it vacant, which is the shape #770 permits (below) and the shape that keeps a warm
# cache in front of the guard.
#
# What CHANGED with #765 was availability. Studio's endpoint used to be
# connection-refused at fire time -- nothing supervised a studio server, so the only
# listeners were ad-hoc `pnpm dev` sessions that die with their terminal. A
# `com.autonomy.studio-server` LaunchAgent now holds 8788 (`install_studio_server.sh`),
# so studio is reachable rather than absent, and every UNREADABLE it logs is a real
# measurement of the READER rather than of "no server". C3 adds the second half: that
# service now also carries `CLAUDE_QUOTA_SAMPLER=1`, so the reader it exposes is
# cache-backed rather than lazy.
#
# THE INVARIANT THIS ORDER MUST NOT BREAK. #765 stated it as "exactly ONE process may
# poll `/api/oauth/usage` directly", and #777 asked which way to reconcile it, because
# a direct-polling reader alongside studio structurally violates that reading. The
# EXCLUSIVITY reading is too strong and is not what #770 measured: it also outlaws the
# prototype dashboard's own sampler, which was the sanctioned poller, and it would make
# the loop reader illegal for its entire life rather than merely unthrottled. What
# actually protects a shared rate-limited budget is a RATE bound. Not because N
# on-demand pollers are always cheaper than one standing sampler -- two pollers at
# 1/60s is 2 per window while the driver is active, i.e. MORE than the sampler they
# replace; that only comes out ahead integrated over the idle time, which is most of
# it. The reason is that a rate bound is what the 429 actually responds to: the
# measured failure was eight polls in 12s, and an unconditional sampler cannot be asked
# to poll less when it starts failing, whereas a bounded on-demand poller can. So the
# invariant is narrower than stated, and reads:
# at most ONE process may hold a STANDING (unconditional, background) sample
# -- and every other direct poller must be rate-bounded AND must throttle its FAILED
# reads too. That slot was the dashboard's; C3 transfers it to studio, which is why
# arming the sampler and stopping the dashboard are ONE step and not two. Studio's own
# backoff still satisfies the rate bound (`claude-quota.ts`); the loop reader satisfies
# it via the #777 poll memo; a SECOND standing sampler is still refused. That is the
# property to hold anything new to -- including a rollback: re-loading the dashboard
# means DISARMING studio's sampler in the same breath, or the rollback recreates
# exactly the contention C3 removed.
#
# #765 stated that invariant as "exactly ONE process may poll `/api/oauth/usage`
# directly", and #777 asked which way to reconcile it, because the post-C3 pair
# structurally violates it -- source 2 polls directly and so does studio. The
# EXCLUSIVITY reading is too strong and is not what #770 measured: it also outlaws
# the prototype dashboard's own sampler, which is the sanctioned poller, and it would
# make source 2 illegal for its entire life rather than merely unthrottled. What
# actually protects a shared rate-limited budget is a RATE bound. Not because N
# on-demand pollers are always cheaper than one standing sampler -- two pollers at
# 1/60s is 2 per window while the driver is active, i.e. MORE than the sampler they
# replace; that only comes out ahead integrated over the idle time, which is most of
# it. The reason is that a rate bound is what the 429 actually responds to: the
# measured failure was eight polls in 12s, and an unconditional sampler cannot be
# asked to poll less when it starts failing, whereas a bounded on-demand poller can.
# So the invariant is narrower than stated, and reads:
# at most ONE process may hold a STANDING (unconditional, background) sample
# -- today the dashboard, tomorrow nobody -- and every other direct poller must be
# rate-bounded AND must throttle its FAILED reads too. Studio satisfies that via
# `claude-quota.ts`; source 2 satisfies it via the #777 poll memo; a second standing
# sampler is still refused. That is the property to hold anything new to.
#
# "" (unknown) is a distinct outcome from "0" and the caller must not conflate
# them -- 0% means wide open, "" means blind.
#
# ONE parser for both HTTP sources, because both bodies are the same shape by
# design: studio's schema was built to the dashboard's wire contract, so adding
# it needed no parser change. A second copy could only ever drift from the first.
quota_sane() {  # $1=candidate; echoes it if usable as a percent, "" otherwise
  qs_v="$1"
  case "$qs_v" in *[!0-9]*) qs_v="" ;; esac
  [ "${#qs_v}" -gt 6 ] && qs_v=""
  echo "$qs_v"
}

# --- quota_fetch_url: $1=url; echoes the raw response body, "" on any failure.
# EXIT STATUS IS PART OF THE CONTRACT, not just stdout: rc=0 iff the transfer
# succeeded, non-zero when nothing answered. `drift_report_studio_server` keys on
# it to tell a LIFECYCLE fault (the unit is down / on another port) apart from a
# service that answered with a body it could not use -- two states with two
# different remedies. Anything that wraps this call must preserve the rc; a
# `|| true` or a retry shim that swallows it collapses those two into one and
# re-creates the mis-attribution below.
#
# Split from the parse (#825) so ONE body can be read TWICE -- for the percent
# and, when there is no percent, for studio's advisory reason. Two curls would be
# two SAMPLES: studio's reader re-polls once its throttle window elapses, so the
# second call can legitimately answer differently from the first, and the probe
# would then log a cause that did not belong to the reading it is explaining.
# That is the exact mis-attribution the ticket is about, so the single fetch is
# load-bearing rather than a tidiness.
quota_fetch_url() {
  curl -s --max-time 8 "$1" 2>/dev/null
}

# --- quota_parse_pct: stdin=a quota JSON body; echoes an integer percent or "".
# Total by construction: every parse, key and type failure prints "".
quota_parse_pct() {
  python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    u = d['account']['claude']['seven_day']['utilization']
    print(int(round(float(u) * 100)) if u is not None else '')
except Exception:
    print('')
" 2>/dev/null
}

# --- quota_parse_reason: stdin=a quota JSON body; echoes studio's `unavailable`
# reason (#825), or "" when there is none or it is not one this loop knows.
#
# DIAGNOSTIC ONLY. This value reaches a LOG LINE and nothing else -- never the
# guard's arithmetic, never `quota_pct`'s stdout.
#
# MEMBERSHIP, not shape. The reason is a CLOSED enum
# (`ACCOUNT_QUOTA_UNAVAILABLE_REASONS` in studio's shared schema), so accepting
# any lowercase token would let a non-studio service on the port -- or a studio
# that has drifted -- write an invented cause into the very log the C3 decision
# is read from, indistinguishable from a real one. The list is duplicated here
# because there is no way to import a TypeScript const into a bash driver; the
# cost of that copy is a reason going unrecognised (degrading to the bare line,
# the safe direction), never a wrong one being believed.
#
# Checked HERE, in python, rather than after it crosses into the shell: an
# unvalidated string that reaches a `log` line an operator reads is a
# log-injection surface, and the shell is a worse place to discover that.
quota_parse_reason() {
  python3 -c "
import sys, json
KNOWN = ('disabled', 'no_credential', 'rate_limited', 'provider_error',
         'unrecognized_payload', 'reader_error')
try:
    r = json.load(sys.stdin)['unavailable']['claude']
    print(r if r in KNOWN else '')
except Exception:
    print('')
" 2>/dev/null
}

# --- quota_parse_reset: stdin=a quota JSON body; echoes the 7-day window's reset
# instant as an integer epoch, or "" when there is none or it is not one this
# loop will believe.
#
# DIAGNOSTIC ONLY -- the same contract as `quota_parse_reason` above, for the
# same reason, and the tests pin it: this value reaches a LOG LINE and nothing
# else. Never the guard's arithmetic, never `quota_pct`'s stdout. The guard's
# decision is a comparison of a percent against QUOTA_STOP_PCT and this must not
# become an input to it -- "the window resets soon" is not a licence to fire into
# an exhausted one, and wiring a reset into that comparison is exactly how a
# refuse-only guard turns fail-open.
#
# WHY IT EXISTS. On 2026-08-05 the window reset at 02:59, 55 minutes after the
# 02:05 tick had read 96% and refused. The refusal said only "window resets
# weekly", so a loop behaving perfectly read as a hung one and cost a full
# session to diagnose. The instant was in the body all along; only the percent
# was ever parsed.
#
# RANGE-BOUNDED, not merely numeric. The value is interpolated into a log line an
# operator reads and greps, so the same log-injection argument `quota_parse_reason`
# makes for a closed enum applies to a number: bound it in PYTHON, where the type
# is real, rather than after it crosses into the shell. 1.4e9 (2014) to 4.1e9
# (2100) keeps it a plausible epoch while staying ~9 orders of magnitude clear of
# the signed-64-bit edge that makes bash 3.2's `test` return 2. A float, a string,
# a bool, a nested object and a shell metacharacter all print "" and are dropped.
quota_parse_reset() {
  python3 -c "
import sys, json
try:
    r = json.load(sys.stdin)['account']['claude']['seven_day']['resets_at']
    # bool is a subclass of int in python -- exclude it explicitly, or True
    # would print as 1 and become 1970.
    if isinstance(r, bool) or not isinstance(r, int):
        print('')
    elif 1400000000 <= r <= 4102444800:
        print(r)
    else:
        print('')
except Exception:
    print('')
" 2>/dev/null
}

# --- quota_log_window: $1=a quota JSON body. Logs WHEN the 7-day window reopens,
# if the body says. Silent when it does not -- an absent reset is not a finding
# and must not manufacture a line.
#
# STDOUT IS NOT OURS. This is called from inside `quota_read_url`, whose stdout
# IS the percent the guard reads, inside a command substitution. `log` appends to
# $DLOG and returns nothing on stdout (checked), which is the only reason this
# can be called from there at all; an `echo` here would be captured as part of
# the reading and land in the fail-open path.
quota_log_window() {
  qlw_epoch="$(printf '%s' "${1:-}" | quota_parse_reset)"
  [ -n "$qlw_epoch" ] || return 0
  # NOT `date -u -r "$epoch"`. That is BSD/macOS syntax; under GNU coreutils `-r`
  # means "reference FILE", so on linux it fails, this function returns early and
  # the window line silently never prints. The engine targets the operator's Mac,
  # but THIS SUITE RUNS IN UBUNTU CI -- which is exactly how the first cut of this
  # was caught (#910: 1b-i/1b-ii red on ubuntu, green on darwin, every other
  # assertion passing because the guard below degraded in the safe direction).
  # `date -d @epoch` is the GNU spelling and fails on BSD, so neither is portable
  # alone. python3 is already a hard dependency of this file (both parsers above
  # are python), so formatting there costs no new dependency and behaves
  # identically on both platforms.
  qlw_when="$(python3 -c "
import datetime, sys
print(datetime.datetime.fromtimestamp(int(sys.argv[1]), datetime.timezone.utc)
      .strftime('%Y-%m-%dT%H:%M:%SZ'))" "$qlw_epoch" 2>/dev/null)"
  [ -n "$qlw_when" ] || return 0
  qlw_left=$(( qlw_epoch - $(date +%s) ))
  if [ "$qlw_left" -gt 0 ]; then
    log "quota window: resets $qlw_when (in $((qlw_left / 3600))h$(( (qlw_left % 3600) / 60 ))m)"
  else
    log "quota window: resets $qlw_when (already elapsed -- the next reading should be low)"
  fi
}

# --- quota_body_pct: stdin=a quota JSON body; echoes the percent the GUARD would
# accept, or "". Parse + totality guard as one step, so the decision path and the
# #825 shadow probe cannot drift apart -- the same reason this file keeps ONE
# parser for both HTTP sources.
quota_body_pct() {
  quota_sane "$(quota_parse_pct)"
}

quota_read_url() {  # $1=url; echoes an integer percent, or "" for unreadable
  # TOTALITY GUARD, applied per-read at the boundary the value crosses -- and
  # since #825 it lives in `quota_body_pct`, shared with the shadow probe, so
  # the probe cannot log a percent the guard would have refused.
  #
  # Everything downstream is arithmetic, and `[ "$qg_pct" -ge "$QUOTA_STOP_PCT" ]`
  # with an operand `test` cannot parse returns 2 -- which is NEITHER branch, so
  # the `if` takes the else, logs "quota ok" and FIRES. Fail-open, on the one
  # guard that must never be.
  #
  # Digit-only is NOT sufficient, and that is not hypothetical: on bash 3.2
  # `[ 10000000000000000000 -ge 80 ]` is all digits and still errors with rc=2,
  # because it exceeds the signed-64-bit range. `quota_cache_read`'s
  # `$(( 10# ))` is worse -- it wraps such a value SILENTLY, fabricating a
  # last-known reading. The comment further down this file already records
  # "digit-only is not enough" for `$(( ))`; this is the same lesson for `test`.
  # Hence a LENGTH bound as well as a character class. Six digits allows a
  # nonsensical 999999% while staying ~13 orders of magnitude clear of overflow.
  #
  # Per-read, not once after the fallback: a guard applied after source selection
  # would let a malformed PRIMARY reading suppress the second source (non-empty,
  # so no fallthrough) and only then blank it -- fail-safe in direction, but it
  # skips a working fallback. Validating where the value enters is what makes
  # "validate at boundaries" actually true here.
  # ONE fetch, TWO readers. The body is held rather than piped so the window's
  # reset instant can be read from the SAME response the percent came from --
  # a second fetch would be a second poll of an endpoint that rate-limits (the
  # shared account bucket is exactly what #765 is about), and could answer
  # differently, which would put a reset on the log beside a percent it did not
  # come with.
  #
  # ORDER IS LOAD-BEARING: the percent is computed FIRST and is the return value.
  # `quota_log_window` runs only after it, writes to $DLOG alone, and its failure
  # cannot alter what this function echoes -- an unparseable reset degrades to
  # "no window line", never to a changed or blanked reading. The guard's totality
  # property is `quota_body_pct`'s, and it is untouched here.
  qru_body="$(quota_fetch_url "$1")"
  qru_pct="$(printf '%s' "$qru_body" | quota_body_pct)"
  # GATED ON THE PERCENT, not merely on a parseable reset (#910 review WARNING).
  # `quota_pct` may call this function TWICE in one guard evaluation -- studio
  # first, the dashboard on fallthrough -- so a reset that logged whenever it happened to
  # parse would let a studio body with a readable `resets_at` but an UNREADABLE
  # `utilization` print one window line, and the dashboard's fallthrough print a second,
  # differently-timed one for the same decision. That is precisely the cross-sample
  # mismatch the single-fetch design above exists to prevent, reintroduced one line
  # later. Gating on `qru_pct` means only the source that actually produced the
  # guard's reading describes that reading's window: at most one line per
  # evaluation, always from the sample the percent came from.
  [ -n "$qru_pct" ] && quota_log_window "$qru_body"
  printf '%s\n' "$qru_pct"
}

quota_pct() {
  qp_src=""
  qp_memo_hit=0      # set -u: must exist before the source-3 branch reads it
  # FIRST since C3 (#410): studio, served from the supervised `com.autonomy.studio-server`
  # unit on 8788 with `CLAUDE_QUOTA_SAMPLER=1`. Its request path reads the sampler's cache
  # and does NOT touch the provider, which is the whole reason it can afford to be first
  # and be asked on every call -- see the order argument in this function's header.
  qp_out="$(quota_read_url "$STUDIO_QUOTA_URL")"
  [ -n "$qp_out" ] && qp_src="studio"
  # NOTE the single exit point below: EVERY source must feed the cache. An early
  # `return` here silently skipped caching the primary (and commonest) reading,
  # leaving the cache empty exactly when it was working -- caught by a test.
  if [ -z "$qp_out" ]; then
    # SECOND: the prototype dashboard. RETIRED by C3 -- its sampler is stopped and the
    # engine that serves it is parked -- so in the normal post-cutover world this is a
    # refused local connection costing nothing upstream. It is kept, and kept AHEAD of
    # the direct-polling reader below, for exactly one reason: re-loading the unit is
    # then a complete rollback of the cutover with no code revert. Delete it only when
    # a rollback is no longer wanted.
    qp_out="$(quota_read_url "$DASH_URL")"
    [ -n "$qp_out" ] && qp_src="dashboard"
  fi
  if [ -z "$qp_out" ]; then
    # THIRD: the loop's own usage reader. Not a URL, so it is sanitised
    # explicitly rather than via quota_read_url.
    #
    # ALREADY A PERCENT — do NOT multiply by 100 the way `quota_read_url` does,
    # and do NOT divide. That is the one trap in this function: the two HTTP
    # sources carry `utilization` as a FRACTION (hence the x100 there), this
    # reader prints the percent. A /100 slip reports every reading below 150% as
    # 0 — "wide open" — which FIRES. The two shapes sit a few lines apart in one
    # function, so the difference is easy to "tidy" into a fail-open bug. Pinned
    # from both sides by `test_quota_guard.sh` cases 23-24.
    #
    # WHY A PURPOSE-BUILT PORT rather than a copy of the engine's old
    # `lib/claude_usage.py`: that module split a WRITER from a GETTER and this
    # call site used only the writer, so this reader returned "" for its entire life
    # and the guard silently had ONE source (#766 — it also reframes 2026-07-26's
    # "both sources failed at once"; one outage was always enough). The port is a
    # single call that prints the percent or prints NOTHING and exits 1, so that
    # class is unrepresentable. It also drops the old last-good GRACE window on
    # purpose — a stale-but-plausible LOW reading PERMITS a fire the live figure
    # would refuse, and fail-open is the one polarity forbidden here; the
    # monotonic `QUOTA_CACHE` below is the sanctioned way to use an old reading
    # and it can only ever REFUSE. Full rationale lives in ONE place, the
    # reader's own module docstring — do not re-argue it here.
    # THROTTLED (#777). Inside QUOTA_POLL_MIN_INTERVAL the memoised OUTCOME of the
    # last poll answers and the upstream is not touched -- including when that
    # outcome was a FAILURE, which is served as "" so the call ends exactly as it
    # would on a live failure. Before C3 that "" also fed a fallthrough to studio;
    # this reader is now LAST, so the "" is simply the final answer and the read is
    # UNREADABLE -- fail-safe, and unchanged in polarity. The full rationale, and
    # why serving nothing in-window would be worse, is on quota_poll_memo_read.
    #
    # The disable check is explicit rather than left to the age comparison: with
    # QUOTA_POLL_MIN_INTERVAL=0 an age of 0 is not GREATER than 0, so a memo written
    # in the same second would still be served and the knob would not disable
    # anything (case 38). That is now its ONLY job in the executable body, and this
    # comment used to claim a second one it no longer has: it said an unparseable
    # interval makes this `[` return 2, so the memo is skipped and a garbage knob
    # "over-polls, never over-trusts". Untrue since `quota_knob_secs` normalises the
    # knob at file scope BEFORE the first read -- an unparseable value is now the
    # default 60 and behaves exactly like it, fresh memo included (measured). The
    # check is kept because it still owns the =0 disable, and as defence in depth for
    # a caller that reaches quota_pct without that normalisation (sourcing the file to
    # unit-test its functions does exactly that).
    qp_memo=""
    [ "$QUOTA_POLL_MIN_INTERVAL" -gt 0 ] && qp_memo="$(quota_poll_memo_read)"
    if [ -n "$qp_memo" ]; then
      [ "$qp_memo" = "-" ] && qp_memo=""
      qp_out="$qp_memo"
      # Named DISTINCTLY from a live poll. A throttle that made "the reader answered"
      # indistinguishable from "the reader was not asked" would hide a death of this
      # reader the way #766 hid for its entire life -- and post-C3 that matters MORE,
      # not less: this is the last source, so its silent death is the guard's silent
      # death. Only the memo branch is relabelled --
      # the fresh-poll string other cases assert on is untouched.
      qp_memo_hit=1
    else
      qp_out="$(quota_sane "$(python3 "$LOOP_LIB/claude_usage.py" 2>/dev/null)")"
      # The SANITISED value is what gets memoised, so an out-of-range or malformed
      # reading is remembered as a FAILURE rather than as a number (case 32's
      # fail-open guard has to hold on the memo path too).
      quota_poll_memo_write "$qp_out"
    fi
    if [ -n "$qp_out" ]; then
      if [ "$qp_memo_hit" = "1" ]; then qp_src="loop-memo"; else qp_src="loop"; fi
    fi
  fi
  if [ -n "$qp_out" ]; then
    quota_cache_write "$qp_out"
    # Attribution goes to the LOG, never to stdout: this function's stdout IS the
    # percent (it is read in a command substitution), so an echo here would be
    # captured as part of the reading and hit the fail-open path.
    #
    # Logged on every read, deliberately. Before C3 this line was the evidence for
    # PROMOTING studio; it is now the evidence that the promotion HELD. A steady
    # `quota source: studio` is the cutover working; a run of `quota source: loop`
    # means the sampler is not delivering and the guard has fallen back to its last,
    # directly-polling source -- which is a ticket, not a re-reorder.
    log "quota source: $qp_src (7-day utilization ${qp_out}%)"
  fi
  echo "$qp_out"
}

# --- last-known-quota cache. Usage inside a 7-day window is MONOTONIC (it only
# rises until the weekly reset), so a recent HIGH reading is evidence the window
# is still exhausted -- but a recent LOW reading proves nothing about now, since
# fires may have run since. The cache is therefore trusted in ONE direction only:
# it may REFUSE a fire, never permit one. Fail-safe, same polarity as ci_check.
quota_cache_write() {  # $1=pct
  quota_stamped_write "$QUOTA_CACHE" "$1" && return 0
  # THE FAILURE PATH CHANGED POLARITY WITH #806, so it is no longer a `|| true`.
  # Under `>` a failed write left the file truncated or absent -- no record, blind
  # path. Temp-and-rename USUALLY leaves the PREVIOUS record intact ("usually":
  # the read-back path fails having already renamed, and discards what landed --
  # so on that one branch there is no surviving record either, which is why the
  # old value is RE-READ below rather than assumed). Where one does survive, for
  # a refuse-only cache over a MONOTONIC quantity it cuts both ways:
  #
  #   old >= the reading we could not persist -> SAFER (it refuses at least as
  #     hard as the new one would have), so keep it.
  #   old <  it -> FAIL-OPEN. Measured by review: $INFRA mode 555 with an
  #     owner-writable `.last_quota` holding 10, a live reading of 95 that STOPs
  #     the gate but cannot be persisted, and every source unreadable an hour
  #     later then serves 10 -- which permits blind fires into a 95% window. `>`
  #     succeeded in that exact state (the FILE was writable), so this is a
  #     regression the rename introduced and not a pre-existing hole.
  #
  # So drop a record we have just proved too low -- via `quota_stamped_discard`,
  # which is what makes the drop actually REACH the motivating state. An earlier
  # cut of this used a bare `rm -f` and conceded in a comment that "the 555 case
  # denies it, so the hole survives". Measured by the pre-PR correctness lens:
  # that left the exact fail-open this path exists to close wide open (the cache
  # went on serving 10 into a 95% window) WHILE logging "dropped the stale 10%
  # cache" -- a false operator-facing signal on top of the hole. `rm` needs write
  # on the DIRECTORY; TRUNCATION needs write on the FILE, and the 555 case is
  # precisely the split, so the discard tries both. Case 45n pins it.
  #
  # The log line is now conditioned on what actually happened, because a drop CAN
  # still fail (a read-only file in a read-only directory) and "silent" stopped
  # being tolerable the moment a failed write could leave a permitting record.
  #
  # NAMING THE COST, since the tradeoff above only weighs one side: in the 555
  # state the drop is PERMANENT, not momentary. Temp creation needs write on the
  # directory, so every later write fails too and the cache never holds a record
  # again -- where `>` (writing the FILE, which is writable) would have kept it
  # current and could go on REFUSING. So the fires after the drop take the blind
  # path and spend the QUOTA_UNKNOWN_FIRES allowance. Still the right call --
  # keeping a record we have proved too low is strictly worse than having none,
  # since the blind allowance is bounded and a permitting cache is not -- but it
  # is a real cost and not a free repair. The state itself is a misconfigured
  # $INFRA, which #773's drift check is the thing that surfaces.
  qcw_old="$(quota_sane "$(quota_stamped_read "$QUOTA_CACHE" "$QUOTA_CACHE_MAX_AGE")")"
  qcw_new="$(quota_sane "$1")"
  if [ -n "$qcw_old" ] && [ -n "$qcw_new" ] && [ "$qcw_old" -lt "$qcw_new" ]; then
    if quota_stamped_discard "$QUOTA_CACHE"; then
      log "WARN: could not persist quota ${qcw_new}%; dropped the stale ${qcw_old}% cache (#806)"
    else
      log "WARN: could not persist quota ${qcw_new}%, AND could not drop the stale ${qcw_old}% cache -- it may still PERMIT a fire (#806)"
    fi
  else
    log "WARN: could not persist quota reading '$1' to $QUOTA_CACHE (#806)"
  fi
  return 0
}
# --- quota_stamped_discard: make the shared reader see NO record at $1 (#806).
#
# Two ways to destroy a record, and they need DIFFERENT permissions -- which is
# the whole reason this is a function and not a bare `rm`:
#
#   rm         needs write on the DIRECTORY
#   `: >file`  needs write on the FILE
#
# The state that motivates the caller above is exactly the split: a mode-555
# $INFRA holding an owner-writable `.last_quota`. `rm` fails there and truncation
# succeeds (measured), so trying only the first left a stale PERMITTING reading
# on disk in the one case the drop was written for.
#
# An emptied file is not a record: `quota_stamped_read` needs a separator on
# line 1 and rejects a zero-byte file, so the reader serves nothing and the
# caller lands on the blind path -- fail-safe, and the same outcome `>` gave when
# a failed write left no record at all.
#
# Reports honestly rather than assuming, via `-s` and not a read-back: the
# reader's answer is WINDOW-dependent (the cache's max age is not the writer's
# 60s), so "the reader returns nothing" would call a merely-stale-to-60s record
# discarded while it still served the cache. Zero bytes is window-independent.
quota_stamped_discard() {  # $1=file -> 0 the reader can no longer serve a record
  rm -f "$1" 2>/dev/null || true
  [ -e "$1" ] || return 0
  : 2>/dev/null >"$1" || true
  if [ -s "$1" ]; then return 1; fi
  return 0
}
# --- quota_stamped_write: the ONE writer for the "<epoch> <value>" state files,
# and `quota_stamped_read`'s counterpart (#806). Three sites hand-rolled this
# format -- the cache, the source-2 poll memo and the #765 shadow stamp -- which
# was two problems:
#
#   1. FORMAT DRIFT. The reader has accumulated real hardening (separator
#      handling, leading zeros, a 64-bit length bound, future-stamp rejection)
#      and every bug in this shape has lived there. Three independent writers is
#      three chances to emit something that one hardened reader then has to cope
#      with. One owner on each side, or the format has no owner at all.
#   2. NON-ATOMICITY. `>` truncates BEFORE writing, so a concurrent reader (a
#      second driver, or an attended run racing the scheduled one) could `head -1`
#      an empty file, see no separator, and read a live record as "no record".
#
# Hence write-to-temp-then-rename: `mv` within a directory is a rename(2), so a
# reader sees either the old record or the new one and never a half-written or
# emptied file. Prior art in this tree: `loop/install_studio_server.sh` uses the
# same shape for the plist. Three deliberate deltas from it -- `$$` in the temp
# name (that file has one writer; #806 names a SECOND driver racing this one, and
# a shared `.tmp` name lets two of them rename each other's half-written temp),
# `mv -f` (nothing here may ever block on a prompt), and the stderr muzzles below.
#
# THE CONTRACT IS "RETURN 0 MEANS THE SHARED READER WILL ACCEPT WHAT IS ON DISK",
# which is why the EPOCH and the DESTINATION are validated and not merely
# interpolated. Two ways a naive version returns 0 over a record the reader then
# rejects:
#
#   * a `date +%s` that yields empty (fork failure, broken PATH) writes
#     " <value>", which `quota_stamped_read` rejects as having no epoch; and one
#     longer than 11 digits is rejected by that reader's 64-bit length bound, so
#     the writer mirrors the SAME bound rather than merely checking for digits.
#   * `mv -f tmp DIR` SUCCEEDS -- it moves the temp INSIDE the directory and
#     returns 0, leaving nothing at `$qsw_file` (measured: rc 0, versus rc 1 for
#     `> DIR`). So the rename's own status is not sufficient evidence that the
#     record landed, and a destination that is a directory is refused up front.
#
# Both are fail-safe for the two CURRENT callers, the cache and the memo, which
# discard the status entirely. The strictness is nevertheless kept, and is not
# decoration: it was written for a third caller (#765's diagnostic probe, removed
# by C3 #410) whose throttle rested on "a successful write means a readable stamp
# exists", so a `return 0` over an unreadable record silently disarmed it. The
# contract belongs to the WRITER, not to whoever happens to be calling it today --
# a future caller that does read its status inherits a correct one instead of
# discovering the loose version the hard way. Its guarantee is the useful, testable
# thing: a 0 return means a record the shared reader will ACCEPT.
#
# The VALUE is checked for FORMAT ONLY (non-empty, no whitespace) -- a value
# carrying a space or newline would split into a second token or a second line
# and be mis-parsed by the reader. Its DOMAIN is still the caller's business, as
# on the read side: the callers' domains differ (a percent; a percent-or-"-"
# sentinel; the constant `probe`). No current caller can trip this check -- all
# three pass a `quota_sane`-sanitised digit string or a literal -- it exists so a
# future one cannot corrupt the format silently.
#
# Two side effects of replacing rather than truncating, both harmless for private
# state files under $INFRA but worth naming: the destination's MODE becomes the
# temp's (600 -> 644 under the default umask) where `>` preserved it, and a
# SYMLINKED destination is replaced by a regular file where `>` wrote through it.
#
# Not fully dirt-free either: a process killed between create and rename leaks one
# `<file>.tmp.<pid>`, which nothing sweeps. Bounded (one per file per driver PID)
# and invisible to #808's drift checks, which enumerate from `git ls-tree`.
# THE RETURN IS ABOUT THE READER, NOT ABOUT THE WRITE. "0 = nothing written" was
# the first cut of this line and it was false: the read-back below runs AFTER the
# rename, so a record that lands unreadable returns non-zero having already
# replaced what was there. Both lenses caught it. The destination is discarded on
# that path so no unreadable file is left for the reader to trip over -- but the
# PRIOR record is gone either way, which is why the caller above re-reads rather
# than assuming its old value survived.
quota_stamped_write() {  # $1=file $2=value -> 0 the shared reader accepts $1; non-zero it does not
  qsw_file="$1"; qsw_val="$2"
  case "$qsw_val" in ""|*[[:space:]]*) return 1 ;; esac
  # A directory destination is refused HERE, because `mv -f` would not refuse it
  # -- see the header. Checked before the temp is created so there is nothing to
  # clean up on this path.
  [ -d "$qsw_file" ] && return 1
  qsw_now="$(date +%s 2>/dev/null)"
  case "$qsw_now" in ""|*[!0-9]*) return 1 ;; esac
  # The reader's own 64-bit length bound, mirrored so the contract above holds:
  # 11 digits reaches year 5138, and `quota_stamped_read` discards anything longer.
  [ "${#qsw_now}" -gt 11 ] && return 1
  qsw_tmp="$qsw_file.tmp.$$"
  # `2>/dev/null` FIRST on the printf: redirections apply left to right, so with
  # the file open written first the shell reports its failure on the still-open
  # stderr -- which on an unwritable $INFRA meant a "No such file or directory"
  # line in the launchd stderr log on every single gate. The `mv` needs the same
  # muzzle (a rename that fails where the create succeeded -- an immutable or
  # foreign-owned destination -- would otherwise print per gate), but not the
  # same ordering: it has one redirect and nothing to race it.
  printf '%s %s\n' "$qsw_now" "$qsw_val" 2>/dev/null >"$qsw_tmp" || {
    rm -f "$qsw_tmp" 2>/dev/null || true; return 1
  }
  mv -f "$qsw_tmp" "$qsw_file" 2>/dev/null || {
    rm -f "$qsw_tmp" 2>/dev/null || true; return 1
  }
  # ENFORCE the contract instead of asserting it. Every check above is an
  # enumeration of ways a 0 return could be a lie, and enumerations are how this
  # file has been bitten before -- the `mv`-onto-a-directory case above was found
  # by review, not by reasoning, and a `umask` of 0477 gets there another way
  # (the rename installs a FRESH umask-derived mode where `>` preserved the
  # destination's, so the record lands mode `--w-------` and the reader cannot
  # `head -1` it). Reading it back through the SHARED reader is the contract
  # stated as code and closes the whole class, including the next member of it.
  #
  # Cheap, but not as cheap as an earlier comment here claimed ("one `head -1`,
  # at most three times per iteration"): a single `quota_pct` can do all three
  # stamped writes -- memo, cache and shadow stamp -- and `quota_pct` itself runs
  # up to three times per iteration plus once per AUTH_LONG_BLOCK retry, so it is
  # up to nine per iteration and unbounded during a long block. Each read-back is
  # also a `head` PLUS a `date` fork inside `quota_stamped_read`. Still cheap
  # against a fire; the conclusion survived the correction, the number did not.
  #
  # One false-negative this admits, and its direction: `quota_stamped_read`
  # returns nothing when the record's age is NEGATIVE, so a clock that steps
  # backwards between the `date` above and the reader's own makes a perfectly
  # good record read as unacceptable -- and since the rename already happened,
  # the prior record is gone and this discards the new one too. Net effect is an
  # empty cache and the blind path, never a false LOW reading, so the polarity is
  # the safe one; the window is the microseconds between two forks. Not worth a
  # guard that would have to decide which of the two clocks to trust.
  if [ -z "$(quota_stamped_read "$qsw_file" 60)" ]; then
    # The rename has already replaced the destination, so leaving the unreadable
    # record in place would strand it there for every future reader -- and for a
    # mode-derived failure (umask 0477) it would never become readable again.
    # Discard it: the reader then sees "no record", which every caller already
    # handles fail-safe. Best-effort by design -- the return below is what the
    # contract rests on, not the cleanup.
    quota_stamped_discard "$qsw_file" || true
    return 1
  fi
  return 0
}
# --- quota_stamped_read: the ONE parser for this file's "<epoch> <value>" state
# files -- the last-known-quota cache, the source-2 poll memo (#777) and the #765
# shadow stamp. Echoes the VALUE token if the record is well-formed and no older
# than $2 seconds; echoes nothing otherwise.
#
# Shared rather than copied because every bug this shape has had lived in the EPOCH
# handling, and each is now a test case (20: a line with no separator; 14: a
# leading-zero epoch; 11: a stale reading). Two copies of that parse would drift,
# and the copy that drifted would be the one guarding spend.
#
# The VALUE is returned UNVALIDATED: the callers have different value domains (a
# percent here; a percent-or-"-" sentinel there; a constant on the shadow stamp),
# so validating it belongs to them. What is shared is exactly what is identical.
quota_stamped_read() {  # $1=file $2=max_age_seconds
  qsr_file="$1"; qsr_max="$2"
  [ -f "$qsr_file" ] || return 0
  # `head -1`, not `cat`: on a TWO-line file `%% *` takes the epoch from line 1 and
  # `##* ` takes the value from the LAST line, so a fresh stamp got paired with an
  # unrelated old value (measured: "<now> -" + "<old> 10" was served as 10).
  # `quota_stamped_write` emits exactly one line and installs it by rename, so a
  # partial or raced write can no longer produce this -- but the record is
  # per-machine state a manual run can also touch, and a parser guarding spend
  # should not depend on nobody ever appending to it.
  qsr_line="$(head -1 "$qsr_file" 2>/dev/null)" || return 0
  # A separator is REQUIRED before splitting: with no space, `%% *` and `##* `
  # BOTH degrade to the whole string, so a single-token line was read as epoch
  # AND value. A lone recent epoch then parsed as a colossal "percent" and refused
  # every fire -- over-refusing, so fail-safe, but for a fabricated reason.
  case "$qsr_line" in *" "*) ;; *) return 0 ;; esac
  qsr_when="${qsr_line%% *}"; qsr_val="${qsr_line##* }"
  case "$qsr_when" in *[!0-9]*|"") return 0 ;; esac
  # The EPOCH needs a LENGTH bound too, and on the memo path its absence was a
  # fail-OPEN -- the one polarity this guard may not have. `$(( ))` wraps silently, so
  # an epoch of 2^64+now made `qsr_age` land inside the window and the memo's value was
  # served as though freshly polled (measured: `18446744075494925739 10` -> 10), which
  # PERMITS a fire, suppresses the real poll and suppresses source 3. The identical
  # line is merely fail-safe for `.last_quota` (a bogus low reading just falls through
  # to the blind allowance), which is why the polarity only flipped once the memo
  # started sharing this parser -- and why the review round that added `quota_sane`'s
  # length bound to the VALUE for exactly this 64-bit reason had to be extended to its
  # sibling field. 11 digits reaches year 5138; anything longer is not a timestamp.
  [ "${#qsr_when}" -gt 11 ] && return 0
  # 10# forces BASE TEN. Digit-only is not enough for $(( )): it reads a leading
  # zero as octal, so a value like 018 is "value too great for base" -- fatal to
  # this subshell (and under set -u the next line then reads unbound). The caller
  # would still degrade correctly (empty result => treated as unreadable), but
  # noisily and for the wrong reason. `test` is unaffected: [ 098 -ge 80 ] is
  # true, so only this arithmetic was ever exposed.
  qsr_age=$(( $(date +%s) - 10#$qsr_when ))
  # A stamp from the FUTURE is not fresh, it is a clock that moved: trust nothing.
  [ "$qsr_age" -lt 0 ] && return 0
  [ "$qsr_age" -gt "$qsr_max" ] && return 0
  echo "$qsr_val"
}
# Echoes the cached percent if one exists and is still fresh; "" otherwise.
quota_cache_read() {
  qc_pct="$(quota_stamped_read "$QUOTA_CACHE" "$QUOTA_CACHE_MAX_AGE")"
  # The VALUE's own domain check, which the shared parser deliberately leaves to the
  # caller -- via `quota_sane`, the SAME guard the two live sources use, not a
  # hand-rolled character class. Digit-only was not enough and this is the third place
  # that has bitten: `$(( 10# ))` on a 20-digit value WRAPS silently (measured: 10^19
  # becomes -8446744073709551616), so an over-range cache line fabricated a
  # last-known reading out of nothing -- and a value that wraps to >=QUOTA_STOP_PCT
  # would then REFUSE every fire on a number that was never reported. `quota_sane`'s
  # length bound is what makes that unrepresentable. Found by review, pre-existing.
  qc_pct="$(quota_sane "$qc_pct")"
  [ -z "$qc_pct" ] && return 0
  # `10#` for the same octal reason the epoch needs it (a cached `018`).
  echo $(( 10#$qc_pct ))
}

# --- the SOURCE-2 POLL MEMO (#777). Source 2 is a fresh `python3` process per
# call, so an in-memory cache is impossible and nothing gave it a cross-process
# one -- it was the only unthrottled DIRECT poller of `GET /api/oauth/usage`, which
# 429s under exactly that treatment (measured 2026-07-29: eight consecutive polls
# over 12s, all 429). `quota_pct` runs up to three times per iteration plus once per
# AUTH_LONG_BLOCK retry while blocked, and post-C3 (#410) source 1 is gone, so every
# one of those becomes a direct poll. The guard could exhaust the very budget it
# reads and then be unable to read it -- a self-denial-of-service, fail-SAFE in
# direction (UNREADABLE refuses) but it costs the loop its fires.
#
# So the memo records the OUTCOME of the last poll and, inside
# QUOTA_POLL_MIN_INTERVAL, source 2 answers from it instead of polling again.
#
# WHY A FILE and not a shell variable, which would need no gitignore entry, no
# sentinel and no parse: every read goes through `qg_pct="$(quota_pct)"` -- a COMMAND
# SUBSTITUTION, i.e. a subshell -- so a variable assigned in there is discarded when
# it exits. Every one of the reads this throttle exists to bound is in that position
# (`quota_gate` twice or three times, and the per-retry read inside `ensure_auth`), so
# an in-shell memo would be written and thrown away on every single call and throttle
# nothing. Making it work would mean changing how `quota_pct` returns, which is the
# convention the whole guard is built on. A file also happens to survive a driver
# restart mid-iteration and to bound a manual run racing the scheduled one, but that
# is a bonus, not the reason.
#
# WHY A SECOND FILE and not a "`.last_quota` may also PERMIT within 60s" rule, which
# is the obvious cheaper alternative: that would cover the success half with no new
# state, but it cannot hold the FAILURE sentinel -- `.last_quota` is a cache of
# readable percentages and has no way to record "the last poll failed", which is the
# half that actually stops a 429 storm. It would also give `.last_quota` two
# directions of trust at two different ages, and that file's single-direction
# refuse-only contract is the one thing keeping a 24h-old reading from authorising a
# fire. Separate file, separate contract, separate age.
#
# It memoises FAILURES too ("-"), and that half is the load-bearing one: the correct
# response to a 429 is to poll LESS, so a memo written only on success leaves the
# storm exactly as it was. Studio throttles failed reads for the same reason (#770).
# "-" rather than an empty field because the separator is what makes the record
# parseable at all.
#
# WHAT THIS COSTS, stated plainly: a memoised LOW reading may be served up to
# QUOTA_POLL_MIN_INTERVAL stale, and #777 proposed serving NOTHING in-window for
# exactly that reason. That literal fix has a worse failure: post-C3 the second and
# third reads of a healthy iteration would go UNREADABLE, studio (which has never
# answered) too, the refuse-only cache would not refuse a low reading, and the
# driver would spend its QUOTA_UNKNOWN_FIRES allowance and STOP with the quota
# perfectly readable. That is the same self-DoS moved one step. Cases 33-34 pin both
# halves against each other.
#
# REVISIT TRIGGER, still live but re-pointed by C3 (#410). The paragraph above leans on
# "studio (which has never answered)", and C3 is the change meant to end that: studio is
# now source 1, sampler-backed, so a healthy iteration should be answered by studio before
# this reader is asked at all. If that holds across scheduled fires, the premise for a
# both-directions memo is gone -- this reader becomes the LAST resort rather than the
# fallthrough's floor, an in-window UNREADABLE from it would follow two sources that
# already failed, and #777's fail-safe "serve nothing in-window" becomes affordable. At
# that point this memo is unnecessary exposure and should be narrowed to refuse-only.
# The evidence to watch for is a run of scheduled fires logging `quota source: studio`.
# It is now the ORDINARY line rather than a rare one, which is the whole point of the
# reorder -- and it is also why the diagnostic probe that used to manufacture that
# evidence (#765's `quota_shadow_probe`) was removed with C3 rather than kept.
# NOT actioned here: this fire arms the sampler and reorders; whether the sampler
# actually holds is the measurement that licenses narrowing the memo. Tracked in #972.
#
# The staleness is bounded on TWO sides instead:
#   * by age, to one minute -- the same contract the other two sources already have;
#   * by the FIRE, structurally. `quota_poll_memo_clear` drops the memo when a fire
#     ends, so it can only ever serve reads about the SAME fire, and a fire is where
#     the spending happens. Within one iteration nothing spends between reads. The
#     residual drift is the operator's own concurrent session for at most a minute,
#     against the 20 points of headroom QUOTA_STOP_PCT=80 deliberately keeps.
# Nothing extends a memo's life: it is written only by an actual poll, never
# re-stamped by a read, so it cannot slide forward indefinitely. And the long-window
# QUOTA_CACHE above is untouched -- still refuse-only, still the only sanctioned way
# to use an old reading, and the reader still has no last-good grace window.
quota_poll_memo_read() {   # echoes "<pct>" | "-" (last poll FAILED) | "" (no memo)
  qpm_v="$(quota_stamped_read "$QUOTA_POLL_MEMO" "$QUOTA_POLL_MIN_INTERVAL")"
  [ "$qpm_v" = "-" ] && { echo "-"; return 0; }
  quota_sane "$qpm_v"
}
quota_poll_memo_write() {  # $1=pct, or "" for a poll that failed
  # The ""->"-" mapping stays HERE, not in `quota_stamped_write`: "a failed poll
  # is remembered as a sentinel" is this memo's semantics, not the format's. The
  # writer owns the record shape; the caller owns what the value means.
  # Status discarded -- a lost memo just means source 2 is re-polled next call.
  quota_stamped_write "$QUOTA_POLL_MEMO" "${1:--}" || true
}
quota_poll_memo_clear() { rm -f "$QUOTA_POLL_MEMO" 2>/dev/null || true; }

# --- #808: is the code that MERGED actually the code that is RUNNING? ----------
#
# `loop/` in the repo is versioned; the plane launchd actually executes,
# `~/Dev/studio-loop/`, is an unversioned copy kept in step BY HAND. So "merged"
# and "running" are two different claims, and the gap between them has now
# silently swallowed a fix twice (`3a17fe1`, then `f3ef05f`). Documentation has
# failed to prevent it both times, so the driver measures it and says so in the
# log it already writes.
#
# There are TWO independent gaps, and the 2026-07-31 incident is why both are
# reported rather than just the obvious one:
#
#   plane drift  -- the live FILE differs from what is on origin/main.
#   driver code  -- the live file is fine, but the RUNNING PROCESS predates it.
#
# That second one is the load-bearing half and it is the one a file-hash check
# cannot see. drive.sh's body is a plain `while true` with no `exec` and no
# re-source, and bash holds its script open by descriptor -- so replacing the
# file does NOT deploy it, it only stages it for the next START. On 2026-07-31
# the live drive.sh was byte-identical to origin/main (a plane-drift check would
# have said "in sync") while PID 74021, booted ~15h earlier, still held a 13KB
# older inode. #765's shadow probe had merged, been synced, and never once run.
#
# Both are ADVISORY. They log and they decide nothing. A stale driver is a real problem but it is the
# OPERATOR's to fix (see the deliberate non-goal below), and a plane that is
# temporarily AHEAD of main is a normal state during a deploy, not a fault.
#
# SINCE #811 THE DRIVER DOES ADOPT NEW CODE ITSELF -- see `drive_self_adopt`
# below. This used to read "DELIBERATE NON-GOAL: the driver does not re-`exec`
# itself", because cross-fire state (`fires`, `stall`, `blind_fires`,
# `budget_regrants`) lives in shell variables and a naive exec would silently
# reset the counters bounding MAX_STALL and MAX_BUDGET_REGRANTS -- trading a
# visible staleness for an invisible fail-open in the spend/stall guards. That
# objection was correct and is what #811 had to solve, not a reason it stayed
# unsolved: the counters are handed over explicitly. The report above stays
# DETECTION-ONLY regardless, and its `kickstart` remedy is still the right one
# for every path adoption refuses.

# --- drive_self_hash: content hash of the driver's own source, "" if unreadable.
# Unreadable must stay distinguishable from "unchanged", so this returns EMPTY
# rather than some sentinel a comparison would treat as a value.
drive_self_hash() { shasum "$DRIVE_SELF" 2>/dev/null | awk '{print $1}'; }

# --- drift_report_driver_code: is this process running its own file's contents?
#
# Compares the file NOW against what it hashed to when this process booted. A
# boot-time hash rather than an inode/`lsof` comparison on purpose: the inode
# only moves when the sync uses `mv`, so an in-place truncate+write -- the case
# where bash goes on to execute GARBAGE from a shifted byte offset -- would slip
# straight through. It also needs no `lsof`, and does not care which descriptor
# bash happened to open the script on.
#
# The check therefore only works from the FIRST RESTART after this lands, since
# the currently-running process recorded no boot hash. That is not a gap in the
# check, it is the thing being measured: no boot hash means "this process is
# older than the code that would have taken one", which is exactly the state
# that should not read as healthy.
drift_report_driver_code() {
  if [ -z "${DRIVE_BOOT_HASH:-}" ]; then
    log "driver code: UNKNOWN -- no boot hash was recorded at DRIVER START, so whether this process is running current code is unmeasured (#808)"
    return 0
  fi
  dc_now="$(drive_self_hash)"
  if [ -z "$dc_now" ]; then
    log "driver code: UNKNOWN -- $DRIVE_SELF is unreadable now, so drift is unmeasured (#808)"
  elif [ "$dc_now" = "$DRIVE_BOOT_HASH" ]; then
    log "driver code: live ($DRIVE_SELF is unchanged since this driver booted; #808)"
  else
    log "driver code: STALE -- $DRIVE_SELF changed since this driver booted, so this process is running SUPERSEDED code and every merged loop/ fix is inert until it restarts: launchctl kickstart -k gui/\$(id -u)/com.autonomy.studio-build-driver -- and \`-k\` kills a fire in flight, so restart BETWEEN fires. Since #811 self-adoption may do that for you on the very next line -- this report is detection-only and runs before that decision, so it cannot know (#808)"
  fi
  return 0
}

# --- drift_fetch_origin: refresh origin/main for a drift half. rc=0 on success.
#
# ONE owner for the fetch both halves below need, because `origin/main` inside
# $REPO is a cached local ref: a drift verdict built on an unrefreshed one
# compares against whatever was current the last time anything fetched, and then
# reads "in sync" forever. Each caller logs its OWN half's UNKNOWN message on a
# failure -- the vocabulary stays per-half, only the mechanism is shared.
#
# BOUNDED, because nothing else here is. `auth_ok` already records this file's
# rule -- macOS has no `timeout`, and a hung probe must never wedge the driver
# -- and this runs BEFORE every stop condition, the quota gate and the fire,
# with no log line while it hangs. `GIT_TERMINAL_PROMPT=0` stops a credential
# helper blocking on a prompt nobody can answer; the `http.*` knobs abort a
# stalled transfer (the remote is HTTPS, and none of these are set globally --
# verified). A bounded fetch that FAILS reads UNKNOWN, which is the safe
# direction; an unbounded one that hangs reads as nothing at all.
#
# `http.connectTimeout` IS PART OF THE BOUND, not belt-and-braces (#832 pre-PR
# review). `lowSpeedLimit`/`lowSpeedTime` only arm once bytes are flowing, and
# git sets no connect timeout of its own, so the pair bounds a STALLED transfer
# and not a connect that never completes. Measured against a black-holed address
# with exactly the two knobs above: rc=128 after 75s, 3.7x the intended bound,
# and twice per iteration because each half fetches for itself. NXDOMAIN returns
# at once; it is a black-holed resolver or route that hangs.
#
# TWO OTHER FETCHES ON THIS PATH ARE STILL UNBOUNDED and are NOT fixed here --
# the top-of-loop `git fetch origin` a few lines above `drift_report`, and
# `install_studio_server.sh`'s `report_status`. Both pre-date this ticket, and
# the first is on the core loop path where changing failure behaviour deserves
# its own change rather than a ride-along. Filed as #836. Until it lands, this
# helper bounds ITS OWN stall and no more -- read the claim above that narrowly.
#
# SHARED RATHER THAN COPIED, and that is not tidiness (#832 review). The copy
# had ALREADY diverged inside the PR that made it: the bounds
# above were added to the plane half while the studio-server half -- added by
# that same PR, on the same pre-fire path, under a comment claiming "same
# discipline and same reason as the plane half" -- kept an unbounded fetch. Two
# call sites, one of them the newer, is exactly how a hardening misses the thing
# it was written for. Independently callable and testable is preserved; each
# half still calls this itself rather than depending on a sibling having run.
#
# SO THIS DOES NOT CLOSE #834, and must not be read as doing so. That ticket is
# about the NUMBER of fetches per iteration (top-of-loop, plane half, this half
# -- still three); what is shared here is the mechanism, not the fetch. Its
# stated remedy is a per-`drift_report` memo, which is a different change with a
# different risk, and its own acceptance test ("a direct call with no flag set
# must still fetch"). Leaving one helper for it to memoise makes that change
# smaller; it does not make it done.
drift_fetch_origin() {
  GIT_TERMINAL_PROMPT=0 git -C "$REPO" -c http.connectTimeout=10 \
    -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=20 \
    fetch --quiet origin main 2>/dev/null
}

# --- drift_report_plane: does the live plane match what is on origin/main?
#
# FETCHES FIRST, and that is the difference between a drift report and a
# comforting one: `origin/main` is a cached local ref that only advances when
# something fetches, so a report built on an unrefreshed one fails in the same
# direction as the thing it monitors. A failed fetch is UNKNOWN, never "in
# sync". Mirrors the discipline `install_studio_server.sh`'s `fetch_origin` /
# `report_status` already enforce for the studio-server clone (#773) -- the
# discipline, not the code: the subject there is a git clone, here it is a
# hand-copied directory, and a shared abstraction over the two would be a
# coupling that buys nothing.
#
# ITS FETCH IS NOW BOUNDED (#832 -- it goes through `drift_fetch_origin`, which
# see). That is a behaviour change to THIS half and worth stating plainly: a
# link that cannot connect within 10s, or that delivers under 1 KB/s for 20s,
# now reads `UNKNOWN` where it previously succeeded slowly. Deliberate, and the
# safe direction -- an unmeasured plane must never be indistinguishable from a
# current one, and this runs ahead of every stop condition where a stall is
# invisible -- but a `UNKNOWN -- origin/main could not be refreshed` on a slow
# link is now an expected reading rather than a broken remote.
#
# Enumerates from `git ls-tree origin/main loop/` -- the set of files that are ON
# MAIN -- rather than from what happens to exist in both places. A file on main
# that was never synced at all is the STRONGEST drift signal, and "for each file
# present in both" reports it as nothing. Listing from main also excludes the
# live plane's `.bak-*` clutter and its unversioned state (`logs/`, `.last_*`)
# for free, without needing globstar (bash 3.2).
drift_report_plane() {
  # `git rev-parse`, NOT `[ -d "$REPO/.git" ]`. This checkout is a git WORKTREE,
  # whose `.git` is a FILE holding a gitdir pointer rather than a directory, so
  # the `-d` test the first draft used was false in production on every fire --
  # the whole half returned UNKNOWN forever. Safe direction, but a check that
  # silently never runs while looking installed is precisely what #808 is about.
  if ! git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1; then
    log "plane drift: UNKNOWN -- $REPO is not a git checkout to compare against (#808)"
    return 0
  fi
  if ! drift_fetch_origin; then
    log "plane drift: UNKNOWN -- origin/main could not be refreshed, so drift is unmeasured. This is NOT a report that the live plane is current (#808)"
    return 0
  fi
  dp_names=""
  dp_listed=0
  # Blob ids from git on BOTH sides -- `rev-parse` for what is on main and
  # `hash-object` for the live file -- rather than piping `git show` into
  # `shasum`. That pipeline could not fail visibly: a failed `git show` yields
  # empty output, which `shasum` happily hashes to the sha1 of the empty string,
  # so the "(unreadable)" branch was unreachable and a git failure against a
  # 0-byte live file would have compared EQUAL and read "in sync". Both commands
  # here return EMPTY on failure, which is what makes that guard real.
  while IFS= read -r -d '' dp_path; do
    [ -n "$dp_path" ] || continue
    dp_listed=1
    dp_name="${dp_path#loop/}"
    if [ ! -f "$INFRA/$dp_name" ]; then
      dp_names="$dp_names $dp_name(never synced)"
      continue
    fi
    dp_main="$(git -C "$REPO" rev-parse --quiet --verify "origin/main:$dp_path" 2>/dev/null)"
    dp_live="$(git -C "$REPO" hash-object "$INFRA/$dp_name" 2>/dev/null)"
    if [ -z "$dp_main" ] || [ -z "$dp_live" ]; then
      dp_names="$dp_names $dp_name(unreadable)"
    elif [ "$dp_main" != "$dp_live" ]; then
      dp_names="$dp_names $dp_name"
    fi
    # `-r` because ls-tree is NOT recursive by default: a subdirectory emerges as
    # the TREE `loop/sub`, which is not a file in the plane, so it read
    # `sub(never synced)` on a perfectly synced plane -- permanently, and with
    # its contents never compared at all.
    # `-z` because the default output C-QUOTES a non-ASCII path
    # (`"loop/caf\303\251.sh"`); the leading quote defeats the `loop/` strip and
    # the file was skipped in silence, i.e. an unmeasured file reported as "in
    # sync". NUL-terminated output is never quoted.
    # Process substitution rather than a pipe: `... | while` runs the body in a
    # SUBSHELL under bash 3.2 (verified), so every name accumulated into
    # dp_names would be discarded at the `done` and the plane would ALWAYS read
    # "in sync". A here-doc cannot serve here -- command substitution strips the
    # NULs that `-z` depends on.
  done < <(git -C "$REPO" ls-tree -r -z --name-only origin/main loop/ 2>/dev/null)
  if [ "$dp_listed" = 0 ]; then
    log "plane drift: UNKNOWN -- could not list loop/ on origin/main (#808)"
  elif [ -n "$dp_names" ]; then
    log "plane drift:$dp_names differ from origin/main -- the live plane at $INFRA is NOT what merged. Sync it, then RESTART the driver (a sync alone does not deploy; #808)"
  else
    log "plane drift: in sync with origin/main"
  fi
  return 0
}

# --- studio_version_commit: stdin=an /api/version body; echoes a commit or "".
#
# Total by construction, like every other parser here: absent, unparseable,
# wrong-type and wrong-shape all print "".
#
# THE HEX GUARD IS THE POINT, not a tidiness. `build-info.ts` serves
# `commit: "dev"` whenever there is no release manifest, and that string is a
# perfectly good argument to `git rev-parse` -- a checkout with a branch named
# `dev` resolves it and the half then announces a confident verdict about a
# build whose identity it never actually learned. Anything that is not a plain
# abbreviated sha is NOT an identity, and the safe answer to "I do not know what
# is running" is to say so. The lower bound is git's own 7-character minimum
# abbreviation; the upper is a full sha.
studio_version_commit() {
  python3 -c "
import sys, json, re
try:
    c = json.load(sys.stdin)['commit']
    print(c if isinstance(c, str) and re.fullmatch(r'[0-9a-f]{7,40}', c) else '')
except Exception:
    print('')
" 2>/dev/null
}

# --- drift_report_studio_server: is the QUOTA SOURCE running merged code?
#
# The third process in the same question. The two halves above ask it of this
# driver's file and of this driver's process; the spend guard's source 3 is a
# THIRD program -- the supervised `com.autonomy.studio-server` unit, running
# from an isolated clone under its own state dir -- and nothing moved it forward
# or said that it had not.
#
# WHAT THAT COST, measured 2026-07-31 (#832 -- and re-measured during its
# pre-PR review, which is where the figure below was corrected). The service sat
# SIXTEEN commits behind origin/main (`ce88319..fcca7b3`), SIX of them touching
# `studio/` -- and it is the six that matter under the tree comparison below,
# since the other ten could not change a byte it serves. The ticket body says
# eleven; that number was wrong. It predated #825 and served no `unavailable` field at
# all. Every layer below then behaved exactly as specified: `quota_parse_reason`
# found no reason, and #765's diagnostic probe (since removed by C3) logged a bare UNREADABLE. Three of
# those lines accumulated as C3 evidence -- and they were not weak evidence,
# they were VOID, measuring a build from before the code they were supposed to
# attest. Nothing anywhere said so, so the standing rule ("read an UNREADABLE by
# its cause") would have read three unattributed lines as a finding about
# studio's reader. `docs/review-prevention-log.md` #28: a signal must measure
# the actor it governs.
#
# DETECTION-ONLY, AND DELIBERATELY SO. `install_studio_server.sh` (#773) rejects
# a scheduled updater by name, citing an approved design
# (`studio/docs/2026-07-30-packaging-and-updates.md`) and measured evidence: an
# updater interlocked on "a fire is running" would have starved, since the
# driver run beginning 2026-07-26T02:05Z ran for 74.7 hours. That stands, and
# this half does not reopen it -- it never fetches into, builds, or restarts the
# service. #773's own stated goal was to make the drift VISIBLE; what shipped
# put the visibility in `--status`, a command someone has to think to run, and
# not in the log that is read every fire and that carries the C3 evidence
# itself. This is that missing half, and nothing more.
#
# IDENTITY COMES FROM THE RUNNING PROCESS, not from the installer's `built.sha`.
# The stamp answers "what did the installer last compile", which is one
# indirection away from the question and can read current while the loaded unit
# still serves an older `dist`. `GET /api/version` is answered BY the unit the
# guard polls, from a manifest read once at registration, so it cannot disagree
# with itself. It also avoids hardcoding a second copy of the service state-dir
# path here, whose failure mode -- an absent stamp reporting UNKNOWN forever
# while the install looks perfect -- is the same silent-never-runs shape
# `drift_report_plane` had to be rewritten out of.
#
# ONE THING THIS DELIBERATELY DOES NOT DO, deferred with a reason: stamp the
# served build onto each studio quota line instead of emitting a separate one
# (#833). Strictly better attribution -- it survives log rotation and
# `DRIFT_REPORT=0` -- but it needed a freshness contract. Not because of ordering
# WITHIN an iteration (`drift_report` runs first there, before `quota_gate` and
# every later read), but because the two ran on different clocks: this half
# reports every iteration, while the line to be stamped was #765's hourly
# diagnostic probe. A stamp read from a drift measurement taken an unknown number
# of iterations earlier is silently stale, and a stale attribution is worse than
# none -- it is the same confident-but-unfounded reading this whole ticket exists
# to stop.
#
# C3 (#410) WEAKENED that objection rather than settling it, and #833 should be
# re-read in this light rather than treated as decided. The probe is gone; the
# line that now carries studio's answer is `quota source: studio`, emitted on the
# DECISION path of the same iteration this half reports in. The clock mismatch
# that blocked #833 is therefore largely gone. What is left is that `quota_pct`
# can run several times per iteration while `drift_report` runs once, so the stamp
# would be at most iteration-stale rather than hour-stale -- a much cheaper
# contract to write, but still a contract. Deliberately NOT built here: C3 is
# already the reorder plus the sampler, and #833 is a separate, now-easier ticket.
#
# (The other deferral, collapsing the per-iteration `origin/main` fetches into
# one (#834), is STILL OPEN. `drift_fetch_origin` above gave the two halves one
# shared, bounded implementation -- which fixed a real divergence and is where a
# memo would go -- but each half still fetches, so the count #834 is about is
# unchanged.)

drift_report_studio_server() {
  if ! git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1; then
    log "studio server: UNKNOWN -- $REPO is not a git checkout to compare against (#832)"
    return 0
  fi
  # FETCH FIRST, through the same bounded helper the plane half uses: a report
  # built on an unrefreshed `origin/main` compares the service against whatever
  # was current the last time anything fetched and says "in sync" forever. A
  # failed fetch is UNKNOWN, never in sync.
  if ! drift_fetch_origin; then
    log "studio server: UNKNOWN -- origin/main could not be refreshed, so drift is unmeasured. This is NOT a report that the quota source is current (#832)"
    return 0
  fi
  ds_body="$(quota_fetch_url "$STUDIO_VERSION_URL")"
  ds_rc=$?
  if [ "$ds_rc" -ne 0 ]; then
    # A LIFECYCLE fault, and named as one: nothing answered on the port. That is
    # `install_studio_server.sh`'s territory (the unit is down, or is on another
    # port), not a statement about which code it would have been running -- and
    # reporting it as drift would send the operator to rebuild a service that
    # was never up. The shadow probe reports the same outage from its own side.
    #
    # "OR TOO SLOWLY" IS NOT PADDING (#832 pre-PR review). `quota_fetch_url` is
    # `curl --max-time 8`, so this branch also catches a unit that IS loaded and
    # simply took longer than eight seconds -- curl 28, and likewise 52/56 for a
    # connection dropped mid-answer. Safe in direction either way (never a
    # currency claim), but a message saying flatly "nothing answered" sends the
    # operator to check whether the unit is loaded when it demonstrably is. The
    # remedy differs, so the message has to admit both.
    log "studio server: UNKNOWN -- nothing answered at $STUDIO_VERSION_URL within curl's 8s bound, so which build the quota source is running is unmeasured. That is a LIFECYCLE fault (is com.autonomy.studio-server loaded, and answering promptly?), not drift (#832)"
    return 0
  fi
  ds_commit="$(printf '%s' "$ds_body" | studio_version_commit)"
  if [ -z "$ds_commit" ]; then
    # Something answered and it was not a studio that knows its own identity: an
    # older build predating the #792 manifest, or any other service on the port.
    # #765 records a wrong-but-answering server 404ing and reading as healthy
    # forever, which is why this is UNKNOWN rather than silence.
    log "studio server: UNKNOWN -- $STUDIO_VERSION_URL served no usable build identity, so this is either a studio predating the release manifest or something else on the port (#832)"
    return 0
  fi
  # EMPTY IS NOT A MATCH. `rev-parse` prints nothing on failure and so does the
  # parser above, so a bare `[ "$a" = "$b" ]` reads two failures as agreement --
  # the fail-open this file has now been bitten by in three separate places
  # (`quota_stamped_read`'s `10#`, `drift_report_plane`'s blob ids, and the
  # quota cache's UNREADABLE-vs-0). Both sides are checked before comparing.
  ds_have="$(git -C "$REPO" rev-parse --quiet --verify "${ds_commit}^{commit}" 2>/dev/null)"
  # THE HEX GUARD CONSTRAINS SHAPE, NOT MEANING. `rev-parse` prefers a REF, so a
  # branch whose name happens to be hex ("bbbbbbb") resolves here and the half
  # then reports a confident verdict having never resolved an abbreviated sha at
  # all. Demanding that the resolved commit ACTUALLY BE ABBREVIATED BY the
  # served value is what closes that: a real short sha is always a prefix of the
  # full one, and a ref that is not cannot masquerade as one.
  case "$ds_have" in "$ds_commit"*) : ;; *) ds_have="" ;; esac
  ds_main="$(git -C "$REPO" rev-parse --quiet --verify "origin/main^{commit}" 2>/dev/null)"
  if [ -z "$ds_have" ]; then
    log "studio server: UNKNOWN -- the service reports commit $ds_commit, which is not a commit this checkout knows, so it cannot be placed against origin/main (#832)"
  elif [ -z "$ds_main" ]; then
    log "studio server: UNKNOWN -- origin/main could not be resolved in $REPO, so drift is unmeasured (#832)"
  elif [ "$ds_have" = "$ds_main" ]; then
    # Both countable verdicts open with `studio server: current`, so the C3
    # evidence rule in prompt.md is one grep rather than a list of spellings.
    log "studio server: current -- serving $ds_commit, identical to origin/main"
  else
    # The abbreviation is computed BEFORE the message and falls back to the full
    # sha, rather than being substituted inline. An inline `$(...)` that fails
    # renders "origin/main is ." -- a gap in the one line someone is reading at
    # the moment they need it, and one that reads as if there were no such
    # commit rather than as if `rev-parse` had failed.
    ds_short="$(git -C "$REPO" rev-parse --short "$ds_main" 2>/dev/null)"
    [ -n "$ds_short" ] || ds_short="$ds_main"
    # THE VERDICT IS ABOUT `studio/`, NOT ABOUT SHA EQUALITY, and that is the
    # difference between a monitor that is read and one that is skipped. This
    # service is built from `studio/` alone (`pnpm -C <clone>/studio build`), so
    # a `loop/` or `docs/` merge cannot change a single byte it serves. Measured
    # on this repo (2026-07-31, tip fcca7b3): 8 of the 20 commits landing on
    # main in the preceding 24h touched `studio/`,
    # against a probe throttled to one per hour -- so a sha-equality verdict
    # would have read STALE for most of the day while the served reader was
    # perfectly current, and `prompt.md`'s rule ("do not count a STALE build's
    # evidence") would then have discarded almost every reading. A gate nothing
    # can satisfy is the failure this whole cutover has already hit once (the
    # original C3 entry gate), and it is not worth repeating for tidiness.
    #
    # ANCESTRY IS CHECKED BEFORE ANY COUNT. `rev-list A..B` on a commit that is
    # not an ancestor counts the commits B has that A lacks, which for a
    # force-pushed or rebased-out build is a number with no meaning -- and a
    # meaningless number stated confidently is worse than no number. main is
    # branch-protected so this is unlikely, not impossible.
    if ! git -C "$REPO" merge-base --is-ancestor "$ds_have" "$ds_main" 2>/dev/null; then
      log "studio server: STALE -- the quota source at $STUDIO_VERSION_URL is serving $ds_commit, which is not an ancestor of origin/main ($ds_short), so how far behind it is cannot be stated. Remedy (a human act by design, #773): loop/install_studio_server.sh --update (#832)"
      return 0
    fi
    # THE VERDICT IS A TREE COMPARISON, NOT A COMMIT COUNT (#832 pre-PR review).
    # The first draft asked `rev-list --count A..B -- studio/` and called 0
    # "current". That count applies git's default history simplification, which
    # can return 0 while `A:studio` and `B:studio` genuinely DIFFER: an evil
    # merge on main -- one whose resolution puts studio/ back to an older state
    # -- is not counted as a commit touching studio/. Reproduced on a scratch
    # repo: the plain count says 0, `--full-history` says 1, and the two trees
    # are different objects. The half would then attest a build whose studio/
    # bytes are NOT main's, which is precisely the "an unmeasurable thing
    # silently becomes 0" fail-open the lines below refuse. Latent rather than
    # live today -- main is squash-merged, with 0 merge commits in the last 200 --
    # and fixed anyway, because a currency claim this guard rests on has to be
    # MEASURED, not inferred from a proxy that is usually equivalent.
    #
    # Comparing the tree objects is exact, and it SUBSUMES the pathspec-exists
    # check it replaces: a renamed or absent studio/ yields an empty id, which is
    # refused below rather than read as a match. `cat-file -t` additionally
    # rejects a `studio` that is a BLOB rather than a directory -- `:studio`
    # resolves fine in that case, and the old pathspec count would have read 0
    # forever while looking perfectly installed.
    ds_tree_have="$(git -C "$REPO" rev-parse --quiet --verify "$ds_have:studio" 2>/dev/null)"
    ds_tree_main="$(git -C "$REPO" rev-parse --quiet --verify "$ds_main:studio" 2>/dev/null)"
    ds_type_main="$(git -C "$REPO" cat-file -t "$ds_main:studio" 2>/dev/null)"
    if [ -z "$ds_tree_main" ] || [ "$ds_type_main" != "tree" ]; then
      log "studio server: UNKNOWN -- origin/main ($ds_short) has no studio/ tree, so the served build's studio/ cannot be compared against it and no currency verdict is possible. Has the directory been renamed? (#832)"
      return 0
    fi
    if [ -z "$ds_tree_have" ]; then
      log "studio server: UNKNOWN -- the served build $ds_commit has no studio/ tree to compare against origin/main ($ds_short), so whether it carries every studio/ change is unmeasured (#832)"
      return 0
    fi
    # DISCLOSURE ONLY, never the verdict. Both counts are for the operator
    # reading the line; an unmeasurable one degrades to "an unknown number of"
    # rather than to 0, because a failed count must not read as a clean bill of
    # health even in prose.
    ds_behind="$(git -C "$REPO" rev-list --count "$ds_have..$ds_main" 2>/dev/null)"
    [ -n "$ds_behind" ] || ds_behind="an unknown number of"
    if [ "$ds_tree_have" = "$ds_tree_main" ]; then
      # Behind, but by nothing that changed a byte it serves. The distance is
      # still reported: "current" is a claim about `studio/`, and an operator
      # reading it is entitled to see what it is discounting.
      log "studio server: current for studio/ -- serving $ds_commit, behind origin/main ($ds_short) by $ds_behind commit(s), none of which changed studio/"
    else
      # `--full-history` IS LOAD-BEARING HERE, not a tidier spelling (#832
      # review). The default simplification is precisely what the tree
      # comparison above exists to distrust, so a plain `-- studio/` count in
      # THIS arm renders the evil-merge case as "whose studio/ tree differs from
      # origin/main's ...; 0 of them touching studio/" -- the one scenario the
      # half was built to catch, described in prose that argues against its own
      # verdict, at the moment an operator is deciding whether to believe it.
      # Measured on a scratch repo: plain 0, `--full-history` 1, trees differ.
      ds_behind_studio="$(git -C "$REPO" rev-list --count --full-history "$ds_have..$ds_main" -- studio/ 2>/dev/null)"
      # ...and the count is still only a PROXY; the tree is the fact. If the
      # proxy comes back 0 or unmeasurable while the trees demonstrably differ,
      # the honest line says the attribution is unavailable rather than quoting
      # a number that contradicts the verdict it is attached to. Same refusal as
      # `ds_behind` above: an unmeasurable thing never renders as a clean 0.
      #
      # THE TWO HALVES OF THIS GUARD ARE NOT ALIKE, and saying so is the point.
      # The EMPTY half is live -- `rev-list` can fail, and it is the same failure
      # `ds_behind` already degrades for. The `0` half is UNREACHABLE as the code
      # stands, and provably so: ancestry is established above, and
      # `--full-history` counts every commit in the range not TREESAME to ALL its
      # parents, so if no such commit existed the two studio/ trees would be
      # equal by induction along the path -- which is the branch we are not in.
      # It is kept as defence-in-depth against a future edit dropping
      # `--full-history`, exactly the edit that produced this finding; the
      # mutation run recorded in the PR is what demonstrates it engages.
      case "$ds_behind_studio" in
        ''|0)
          ds_studio_clause="though commit-level attribution cannot say which of them changed it"
          ;;
        *)
          ds_studio_clause="$ds_behind_studio of them touching studio/"
          ;;
      esac
      log "studio server: STALE -- the quota source at $STUDIO_VERSION_URL is serving $ds_commit, whose studio/ tree differs from origin/main's ($ds_short); it is $ds_behind commit(s) behind, $ds_studio_clause. So the spend guard's source 3 is answering from SUPERSEDED code -- treat the shadow readings it produced as evidence about that build, not about main. Remedy (a human act by design, #773): loop/install_studio_server.sh --update (#832)"
    fi
  fi
  return 0
}

# --- drift_report: all three halves, once per loop iteration. Advisory; always 0.
# Named for the set, not for any one of them -- the driver-code half is the
# load-bearing one and is not plane drift at all.
drift_report() {
  # ONLY the documented value disables. `= "1"` would have let `DRIFT_REPORT=no`
  # or `=true` silence the whole thing without a word, and a monitor a typo can
  # switch off invisibly fails in the direction it is monitoring.
  [ "$DRIFT_REPORT" = "0" ] && return 0
  drift_report_driver_code
  drift_report_plane
  drift_report_studio_server
  return 0
}

# --- #811: SELF-ADOPTION -- how a merged loop/ fix actually starts running.
#
# #808 made staleness VISIBLE; it did not fix it. `drift_report_driver_code`
# above is deliberately left DETECTION-ONLY and its remedy line still names
# `launchctl kickstart`, because it runs BEFORE the adopt decision and cannot
# know the outcome -- adoption can be disabled, capped out, or refused on an
# unparseable file, and in every one of those cases a human restart IS still the
# remedy. The whole adoption narrative lives here instead, on the line after.
#
# WHAT IS AND IS NOT PERSISTED, because the ticket asked for the wrong thing.
# #811 proposed persisting the cross-fire counters so that ANY restart -- crash,
# `launchctl`, exec -- resumes the bounds. That is a worse bug than the one it
# fixes. `MAX_FIRES` is documented as per-run and RESET by a scheduled start
# (":52/:78, and the stop message says so"); `blind_fires` and `budget_regrants`
# are per-run by construction; and `stall` persisted across scheduled starts
# would PERMANENTLY WEDGE the loop -- once it reached MAX_STALL, every future
# 03:05 run would stop at "nothing more to do" before firing, forever, even
# after the operator queued more work. The spend guard that must survive a
# restart is `quota_gate`, and it already does: it reads the live 7-day window,
# not a counter.
#
# PRIOR ART, and where this deliberately differs. `bin/supervisor.sh` has shipped
# self-re-exec since #294 (`engine_update_ready`/`should_reexec`/`reexec_engine`).
# It is a different process under different rules -- the engine half of the repo,
# which cutover C3 parks -- so this is not a shared abstraction, but three of its
# choices were considered and two rejected:
#   * it re-execs with RESOLVED args rather than raw argv. Same conclusion here,
#     reached by deletion: drive.sh parses no arguments at all (the plist passes
#     none), so this execs with none and there is no argv to get wrong.
#   * it bounds re-exec looping with a BOOLEAN `reexec_disabled`, which needs no
#     cross-exec transport. A counter needs teleporting and is therefore more
#     complex -- but it is also the only shape that permits a SECOND legitimate
#     adoption in one run, which a driver that may run for many hours wants.
#   * it restores `execfail` after a failed exec. Not mirrored: everything below
#     the exec here is the process's last few lines anyway.
#
# ONE UNAVOIDABLE HOLE, named rather than papered over: adopting a ROLLBACK to a
# drive.sh from before #811 resets every bound, because the code being adopted
# knows nothing about the handoff. Nothing this side can do about that.
#
# So the scope here is CONTINUATION-ONLY. An `exec` is the same driver run
# carrying on in new code, and it must carry its bounds. A launchd start, a
# crash restart and a manual kickstart are NEW runs and reset them, exactly as
# today. The discriminator is the PID: `exec` preserves it, and nothing else
# does. Its failure directions are asymmetric, which is why it is enough --
# a false RESET (the fail-open one) cannot happen, since exec is by definition
# the same process; a false RESUME needs a foreign process to land on a recycled
# PID inside HANDOFF_MAX_AGE, and its effect would be "the bounds stay armed",
# which is the safe direction.
HANDOFF_FORMAT=1

# --- drive_is_count: is $1 a counter this file may do arithmetic on?
#
# LEADING ZEROS ARE THE POINT, not the digit check. `$(( ))` reads a leading zero
# as OCTAL, and both outcomes are silent: `fires=012` increments to 11, and
# `fires=08` is "value too great for base" -- non-fatal, so `fires` STAYS "08"
# and never increments again, which means MAX_FIRES, QUOTA_UNKNOWN_FIRES,
# MAX_CRASH and MAX_STALL never trip for the rest of the run. A full fail-open on
# every bounded guard, from one padded field. `quota_stamped_read`'s own `10#`
# comment is this file's record of having been burned by exactly this.
#
# It matters here specifically because this parser's job is reading records
# written by OTHER VERSIONS of drive.sh, so "a future writer emits a padded
# field" is the normal case, not an exotic one.
#
# 9 digits is the same bound `quota_knob_secs` uses: past that it is not a
# counter, and it is where `test`'s arithmetic starts approaching the signed-64
# range this file has already been bitten in.
drive_is_count() {
  case "$1" in ""|*[!0-9]*) return 1 ;; esac
  case "$1" in 0[0-9]*) return 1 ;; esac
  [ "${#1}" -gt 9 ] && return 1
  return 0
}

# --- drive_handoff_encode: the counters as one whitespace-free token, or "".
# Whitespace-free because `quota_stamped_write` refuses anything else -- the
# record's VALUE is one field of a "<epoch> <value>" line (#806).
drive_handoff_encode() {
  dhe_head="${prev_head:--}"
  # `head` is the only free-form field and it goes into a comma/equals-delimited
  # token, so a stray `,` or `=` would split the record into fields that parse as
  # something else entirely.
  #
  # An unencodable head REFUSES THE WHOLE RECORD rather than degrading to the "-"
  # sentinel, which is what the first cut did on the reasoning that "an absent
  # prev_head costs at most one iteration of stall detection". That reasoning was
  # WRONG, and the review lens that measured it was right: the stall test is
  # `[ -n "$prev_head" ] && …`, so an empty prev_head takes the ELSE branch and
  # sets `stall=0`. Degrading the head would therefore have silently wiped the
  # very counter the handoff exists to preserve -- a faithfully carried
  # `stall=2` zeroed on the first iteration after the exec. Refusing costs one
  # adoption attempt and keeps every bound honest.
  case "$dhe_head" in
    "-") ;;
    ""|*[!0-9a-zA-Z]*) return 1 ;;
  esac
  [ "${#dhe_head}" -gt 64 ] && return 1
  # `$$` is the ORIGINAL shell's pid even inside this command substitution's
  # subshell (bash keeps $$ stable; BASHPID is the one that changes) -- which is
  # what makes it comparable against `$$` in the exec'd process.
  printf 'v=%s,pid=%s,fires=%s,stall=%s,blind=%s,regrants=%s,crash=%s,loops=%s,adopt=%s,head=%s' \
    "$HANDOFF_FORMAT" "$$" "$fires" "$stall" "$blind_fires" "$budget_regrants" \
    "$crash" "$loops" "$adoptions" "$dhe_head"
}

# --- drive_handoff_parse: $1=record value -> 0 and dh_* set; non-zero = refuse.
#
# THE WRITER IS THE OLD CODE AND THE READER IS THE NEW CODE. That is the whole
# point of the exec, and it means the two sides can disagree about the format in
# a way no other state file here can. The degradation is therefore per-FIELD and
# not per-record: a counter the writer did not know about defaults to 0 (that ONE
# bound restarts; the rest stay armed) and is NAMED in the log, and a field the
# reader does not know about is ignored and named. A field that is PRESENT but
# malformed still refuses the whole record -- a corrupt digit string must never
# be coerced into a bound. `v` guards the case where that per-field tolerance is
# not enough and the meaning of a field has changed.
drive_handoff_parse() {
  dh_v=""; dh_pid=""; dh_fires=""; dh_stall=""; dh_blind=""; dh_regrants=""
  dh_crash=""; dh_loops=""; dh_adopt=""; dh_head=""
  dh_missing=""; dh_unknown=""
  dh_rest="$1"
  [ -n "$dh_rest" ] || return 1
  while [ -n "$dh_rest" ]; do
    case "$dh_rest" in
      *,*) dh_kv="${dh_rest%%,*}"; dh_rest="${dh_rest#*,}" ;;
      *)   dh_kv="$dh_rest"; dh_rest="" ;;
    esac
    case "$dh_kv" in *=*) ;; *) return 1 ;; esac
    dh_k="${dh_kv%%=*}"; dh_val="${dh_kv#*=}"
    case "$dh_k" in
      v)        dh_v="$dh_val" ;;
      pid)      dh_pid="$dh_val" ;;
      fires)    dh_fires="$dh_val" ;;
      stall)    dh_stall="$dh_val" ;;
      blind)    dh_blind="$dh_val" ;;
      regrants) dh_regrants="$dh_val" ;;
      crash)    dh_crash="$dh_val" ;;
      loops)    dh_loops="$dh_val" ;;
      adopt)    dh_adopt="$dh_val" ;;
      head)     dh_head="$dh_val" ;;
      *)        dh_unknown="$dh_unknown $dh_k" ;;
    esac
  done
  [ "$dh_v" = "$HANDOFF_FORMAT" ] || return 1
  drive_is_count "$dh_pid" || return 1
  [ -n "$dh_fires" ]    || { dh_fires=0;    dh_missing="$dh_missing fires"; }
  [ -n "$dh_stall" ]    || { dh_stall=0;    dh_missing="$dh_missing stall"; }
  [ -n "$dh_blind" ]    || { dh_blind=0;    dh_missing="$dh_missing blind"; }
  [ -n "$dh_regrants" ] || { dh_regrants=0; dh_missing="$dh_missing regrants"; }
  [ -n "$dh_crash" ]    || { dh_crash=0;    dh_missing="$dh_missing crash"; }
  [ -n "$dh_loops" ]    || { dh_loops=0;    dh_missing="$dh_missing loops"; }
  [ -n "$dh_adopt" ]    || { dh_adopt=0;    dh_missing="$dh_missing adopt"; }
  for dh_n in "$dh_fires" "$dh_stall" "$dh_blind" "$dh_regrants" "$dh_crash" "$dh_loops" "$dh_adopt"; do
    drive_is_count "$dh_n" || return 1
  done
  # Kept in step with the encoder's own check, deliberately: it emits `-` for an
  # absent head and refuses anything else non-alphanumeric, so anything the
  # encoder can write, this accepts, and nothing more.
  case "$dh_head" in
    ""|"-") dh_head="" ;;
    *[!0-9a-zA-Z]*) return 1 ;;
  esac
  [ "${#dh_head}" -gt 64 ] && return 1
  return 0
}

# --- drive_handoff_resume: consume a handoff written by THIS pid, or start clean.
# Called once at startup. Every path is best-effort: the worst case is the
# counters this run already had, which is exactly today's behaviour.
drive_handoff_resume() {
  dhr_rec="$(quota_stamped_read "$DRIVER_HANDOFF" "$HANDOFF_MAX_AGE")"
  # CONSUME FIRST, and unconditionally. A handoff is valid for exactly one
  # startup: leaving a consumed or stale one on disk is how a much later restart
  # would resume bounds from a run that ended hours ago. (Two drivers starting
  # inside the same microsecond could in principle have one eat the other's
  # record; the cost is that the other's bounds reset, which is today's
  # behaviour, and the alternative -- leaving records lying around -- fails in
  # the direction that resumes something it should not.)
  if [ -e "$DRIVER_HANDOFF" ]; then
    quota_stamped_discard "$DRIVER_HANDOFF" ||
      log "WARN: could not clear the driver handoff at $DRIVER_HANDOFF -- a later restart could resume stale counters from it (#811)"
  fi
  [ -n "$dhr_rec" ] || return 0
  if ! drive_handoff_parse "$dhr_rec"; then
    log "WARN: a driver handoff was present but UNREADABLE. If this process was exec'd, the cross-fire bounds (MAX_STALL, MAX_CRASH, QUOTA_UNKNOWN_FIRES, MAX_BUDGET_REGRANTS) it had already spent are lost and restart from zero; if this is a fresh scheduled start they were zero anyway and only the leftover record is odd. Either way SELF-ADOPTION IS NOW OFF for the rest of this run so the loss cannot repeat -- a human restart is the remedy (#811)"
    adoptions="$MAX_SELF_ADOPT"
    return 0
  fi
  if [ "$dh_pid" != "$$" ]; then
    log "driver handoff: IGNORED -- written by pid $dh_pid, this process is $$, so this is a new driver run and not an exec continuation. Counters start at zero, as every scheduled start does (#811)"
    return 0
  fi
  fires="$dh_fires"; stall="$dh_stall"; blind_fires="$dh_blind"
  budget_regrants="$dh_regrants"; crash="$dh_crash"; loops="$dh_loops"
  adoptions="$dh_adopt"; prev_head="$dh_head"
  log "driver handoff: RESUMED after a self-adopt exec (fires=$fires stall=$stall blind=$blind_fires regrants=$budget_regrants crash=$crash loops=$loops adopt=$adoptions) -- the bounds this run has already spent are still armed (#811)"
  [ -n "$dh_missing" ] && log "WARN: the handoff carried no$dh_missing -- written by a drive.sh that did not have that counter, so that bound restarts from zero (#811)"
  [ -n "$dh_unknown" ] && log "driver handoff: ignored unknown field(s)$dh_unknown -- written by a NEWER drive.sh than the one now running (#811)"
  return 0
}

# --- drive_adopt_floor: the adopt cap must not depend on the handoff surviving.
#
# MEASURED, not theorised. Mutating `drive_handoff_resume` into a no-op and
# running case 44c did not merely turn assertions red -- it HUNG the suite in an
# infinite adopt-exec loop: every exec'd process started at adoptions=0, so a
# file that kept changing was adopted forever and no fire ever completed. That is
# the one failure mode MAX_SELF_ADOPT exists to prevent, and it was resting
# entirely on the same handoff record whose loss it has to survive.
#
# So the count is ALSO carried in the environment, which `exec` preserves for
# free and which no other restart can supply. The two carriers are combined by
# MAX, never by preference: whichever remembers MORE adoptions is the one that
# keeps the cap honest, and a lost carrier can then only tighten it.
#
# UNSET after reading, so no child -- run.sh, and through it the agent itself --
# ever inherits it. A stray DRIVE_ADOPT_COUNT in a fire's environment would be
# read back by a nested driver as an adoption that never happened.
drive_adopt_floor() {
  daf_env="${DRIVE_ADOPT_COUNT:-}"
  unset DRIVE_ADOPT_COUNT
  drive_is_count "$daf_env" || return 0
  [ "$daf_env" -gt "$adoptions" ] || return 0
  # Reached whenever the handoff was lost, refused or never written, on a process
  # that WAS exec'd -- i.e. exactly the case the hang above came from.
  log "driver handoff: adopt count $daf_env recovered from the environment (the handoff record carried $adoptions) -- the MAX_SELF_ADOPT cap stays armed even when the record does not survive (#811)"
  adoptions="$daf_env"
  return 0
}

# --- drive_self_adopt: re-exec into merged code, between fires, or say why not.
#
# Called at the TOP of the loop iteration, after `drift_report` and ahead of the
# quota gate, the auth probe, the PR gate-wait and the fire itself. Every
# `continue` in the body returns there, so this point is always BETWEEN fires:
# it cannot interrupt a fire, a backoff sleep, an auth-retry loop or a gate wait.
# Nothing is orphaned by the exec -- there are no traps, no background jobs and
# no long-lived descriptors (`log` opens the file per call), the cwd is
# re-established by the new process's own `cd "$REPO"`, launchd tracks the job by
# a pid that exec preserves, and the [loop-paused] issues are idempotent.
#
# EVERY REFUSAL LEAVES THE DRIVER RUNNING THE OLD CODE, which is the same state
# it is in today and therefore always safe. The one thing that must never happen
# is an exec into a process whose bounds come back zeroed, so the handoff is
# written AND read back AND re-parsed before the exec -- the contract enforced,
# not asserted, the same way `quota_stamped_write` enforces its own.
drive_self_adopt() {
  [ "$SELF_ADOPT" = "0" ] && return 0
  # No boot hash, or an unreadable file now: `drift_report_driver_code` has
  # already said UNKNOWN. Unmeasured is not a licence to exec.
  [ -n "${DRIVE_BOOT_HASH:-}" ] || return 0
  dsa_now="$(drive_self_hash)"
  [ -n "$dsa_now" ] || return 0
  [ "$dsa_now" = "$DRIVE_BOOT_HASH" ] && return 0
  if [ "$adoptions" -ge "$MAX_SELF_ADOPT" ]; then
    log "driver code: NOT adopting -- $adoptions self-adoption(s) already attempted this run (cap MAX_SELF_ADOPT=$MAX_SELF_ADOPT). The file keeps changing underneath the driver; a human restart is the remedy (#811)"
    return 0
  fi
  # A truncated or half-written sync must not become an exec into garbage, which
  # would kill the driver outright and leave nothing running until 03:05. This is
  # the same trust boundary a human `kickstart` has -- it too adopts whatever was
  # synced -- and no weaker.
  # `${BASH:-/bin/bash}` and not a bare `bash`, so the file is validated by the
  # SAME interpreter that is about to run it rather than by whatever `PATH`
  # resolves to.
  if ! "${BASH:-/bin/bash}" -n "$DRIVE_SELF" 2>/dev/null; then
    log "driver code: NOT adopting -- $DRIVE_SELF does not PARSE, so exec'ing it would kill the driver. A half-finished sync or a manual edit; still running the old code, which is the safe direction (#811)"
    return 0
  fi
  # A TRUNCATION THAT PARSES needs its own check, and this is the cheap one that
  # works. `bash -n` accepts any syntactically valid PREFIX -- a non-atomic copy
  # caught mid-write yields exactly that -- and the exec then succeeds, runs the
  # config and the function definitions, never reaches the loop, and exits. Same
  # outcome as a dead exec: nothing running until the next scheduled start.
  # Requiring a string from the file's LAST line proves the tail arrived, and
  # requiring it IN the tail rather than anywhere in the file is the stronger
  # form (review NITPICK): an unanchored match would also be satisfied by a
  # corrupt copy that happened to retain the substring mid-file. `tail -5` rather
  # than `tail -1` so a future drive.sh may gain a line or two after the marker
  # without adoption silently refusing forever -- and a refusal is announced and
  # fail-safe in any case, since the driver simply stays on the old code.
  if ! tail -5 "$DRIVE_SELF" 2>/dev/null | grep -q 'DRIVER DONE'; then
    log "driver code: NOT adopting -- $DRIVE_SELF parses but is missing its tail, so it is a TRUNCATED copy (a sync caught mid-write). Exec'ing it would run the definitions and exit without ever reaching the loop (#811)"
    return 0
  fi
  # Counted BEFORE the write, and never uncounted. An ATTEMPT is what the cap
  # bounds: a refusal path that left the count alone would retry a failing write
  # on every iteration for the life of the run.
  adoptions=$((adoptions + 1))
  dsa_rec="$(drive_handoff_encode)"
  if [ -z "$dsa_rec" ]; then
    log "driver code: NOT adopting -- the cross-fire counters could not be ENCODED (a prev_head this record's format cannot carry), and an exec that dropped them would zero the bounds. Staying on the old code (#811)"
    return 0
  fi
  if ! quota_stamped_write "$DRIVER_HANDOFF" "$dsa_rec"; then
    log "driver code: NOT adopting -- the cross-fire counters could not be written to $DRIVER_HANDOFF, and an exec without them would silently reset MAX_STALL / MAX_CRASH / QUOTA_UNKNOWN_FIRES / MAX_BUDGET_REGRANTS to zero. Staying on the old code (#811)"
    return 0
  fi
  dsa_back="$(quota_stamped_read "$DRIVER_HANDOFF" "$HANDOFF_MAX_AGE")"
  if [ "$dsa_back" != "$dsa_rec" ] || ! drive_handoff_parse "$dsa_back"; then
    log "driver code: NOT adopting -- the handoff at $DRIVER_HANDOFF does not read back as what was written, so the exec'd process would start with zeroed bounds (#811)"
    quota_stamped_discard "$DRIVER_HANDOFF" || true
    return 0
  fi
  # LAST CHECK, and it has to be last. Everything above -- the encode, the
  # stamped write with its internal date/mv/read-back, this function's own log
  # calls -- is several forks' worth of wall clock after `bash -n` ran, and the
  # trigger for all of it is "the file just changed", i.e. maximally correlated
  # with a sync still in flight. Re-hashing here closes that window: if the file
  # moved again since it was validated, the validation was of a different file.
  if [ "$(drive_self_hash)" != "$dsa_now" ]; then
    log "driver code: NOT adopting -- $DRIVE_SELF changed AGAIN between validation and exec, so what was checked is not what would run. A sync is probably still in flight; the next iteration will re-check (#811)"
    quota_stamped_discard "$DRIVER_HANDOFF" || true
    return 0
  fi
  log "driver code: ADOPTING -- $DRIVE_SELF changed since this driver booted; re-exec'ing into the merged code between fires, carrying (fires=$fires stall=$stall blind=$blind_fires regrants=$budget_regrants crash=$crash loops=$loops adopt=$adoptions) (#811)"
  # The second carrier for the cap (see drive_adopt_floor). Exported HERE and
  # nowhere else: between this line and the exec there is no child to inherit it,
  # and the exec'd process unsets it before its first fire.
  DRIVE_ADOPT_COUNT="$adoptions"
  export DRIVE_ADOPT_COUNT
  # `bash "$DRIVE_SELF"` rather than `"$DRIVE_SELF"`, mirroring the plist's own
  # `/bin/bash drive.sh`: a synced file that lost its exec bit (`git show >file`
  # drops it) must still adopt.
  #
  # `execfail` COVERS LESS THAN IT LOOKS LIKE, and the honest statement of what
  # happens matters more here than a comforting one. It governs the COMMAND WORD
  # only -- `${BASH:-/bin/bash}`. Measured on 3.2.57:
  #
  #   exec /no-such-bash file    -> recovered, the lines below RUN
  #   exec /bin/bash /missing.sh -> process GONE, exit 127
  #   exec /bin/bash /unreadable -> process GONE, exit 126
  #
  # So every way $DRIVE_SELF itself can fail is a SUCCESSFUL exec followed by the
  # new bash dying, and nothing below runs: no driver at all until the next
  # scheduled start, with `ADOPTING` as the last line in the log and the 126/127
  # going to launchd's stderr instead. That is why the checks above are the real
  # net and this is only the residue -- an interpreter that cannot be exec'd.
  # State is not corrupted on that path either way: the orphaned handoff carries
  # a pid no later start can match, so it is ignored and discarded.
  shopt -s execfail 2>/dev/null || true
  # shellcheck disable=SC2093
  # SC2093 assumes the lines after `exec` are dead. Under `execfail` the
  # command-word failure above reaches them (prevention-log #19: CI's shellcheck
  # flags this and the disable belongs here, at write time, not after a red run).
  exec "${BASH:-/bin/bash}" "$DRIVE_SELF"
  log "driver code: adoption FAILED -- ${BASH:-/bin/bash} could not be exec'd at all. Discarding the handoff and continuing on the OLD code (#811)"
  unset DRIVE_ADOPT_COUNT
  quota_stamped_discard "$DRIVER_HANDOFF" || true
  return 0
}

# --- quota_knob_secs: normalise a "how old may a reading be" knob, because BOTH of
# them are fed straight to `test` and an operand `test` cannot parse returns 2 --
# NEITHER branch -- so `[ age -gt bound ]` falls through and EVERY record looks fresh
# forever. `QUOTA_CACHE_MAX_AGE=24h` (a plausible typo) was enough to do it, and for
# the 24h cache that is worse than a fail-open: nothing ever clears that file, so an
# ancient reading at/above QUOTA_STOP_PCT would refuse every blind fire permanently.
# The memo path was already closed by its own `-gt 0` check; this closes the sibling.
# An unusable value is REPLACED by the default and ANNOUNCED -- never obeyed, and
# never silently swapped either (a misconfigured spend guard the operator cannot see
# is the shape this file exists to avoid).
#
# The CEILING argument differs per knob, which is why it is a parameter:
#   * the poll interval bounds how stale a reading may be when it PERMITS a fire, so
#     an over-wide value is a fail-open and is clamped toward the shorter, safer end.
#     (Measured by review: QUOTA_POLL_MIN_INTERVAL=86400 served a 12-hour-old reading
#     to the gate with zero polls.)
#   * QUOTA_CACHE_MAX_AGE bounds a REFUSE-ONLY cache, so a large valid value can only
#     ever over-refuse. No ceiling; it just has to be a number.
#
# The NAME is historical. It normalises any non-negative integer knob, and #811's
# MAX_SELF_ADOPT needs exactly the same treatment for exactly the same reason --
# it is fed to `[ "$adoptions" -ge "$MAX_SELF_ADOPT" ]`, so an unparseable value
# returns 2 from `test`, takes NEITHER branch, and leaves the adopt cap silently
# unarmed. Hence $5: the only seconds-specific thing here was the WARN's wording,
# and a second near-identical normaliser would be the duplication this file keeps
# paying for. Callers that omit it read "seconds", as all three original ones do.
quota_knob_secs() {  # $1=name $2=value $3=default $4=ceiling (0 = none) $5=unit noun (default seconds)
  qk_unit="${5:-seconds}"
  qk_v="$2"
  case "$qk_v" in ""|*[!0-9]*) qk_v="" ;; esac
  # 9 digits is ~31 years in seconds. Past that it is a typo, and it is also where
  # `test` starts approaching the signed-64 range that already burned this file once.
  [ "${#qk_v}" -gt 9 ] && qk_v=""
  if [ -z "$qk_v" ]; then
    log "WARN: $1='$2' is not a usable number of $qk_unit -- using the default $3 instead (an operand the shell's test builtin cannot parse returns 2 and takes NEITHER branch, so an unparseable bound silently stops bounding anything -- for an age that means every stamped record looks fresh, for a cap that means no cap)"
    qk_v="$3"
  fi
  if [ "$4" -gt 0 ] && [ "$qk_v" -gt "$4" ]; then
    log "WARN: $1=$qk_v exceeds the ${4}s ceiling -- clamping to $4. A wider window lets an OLDER reading authorise a fire, so this clamps toward the safer end."
    qk_v="$4"
  fi
  echo "$qk_v"
}

# --- quota_gate: the spend guard. Returns 1 to STOP the driver, 0 to proceed.
#
# A FUNCTION rather than inline code because it must run TWICE per iteration in
# the worst case: once before the auth probe (so a quota-blocked scheduled start
# costs ZERO tokens) and again after a long block, because ensure_auth can sit in
# backoff for DAYS -- measured 71h -- and the reading taken before that block is
# not evidence about the window the next fire would actually land in. Worse, a
# block is frequently CAUSED by quota exhaustion (a cap and an expired token look
# identical to the probe), so the re-grant path is exactly the one most likely to
# fire into a window that has since changed. The periodic quota_pct calls inside
# ensure_auth do not decide anything themselves -- the decision belongs here, where
# it can stop the loop. But since #777 they are no longer merely informational: an
# in-block read WRITES the poll memo, so within QUOTA_POLL_MIN_INTERVAL the deciding
# gate below can be answered from a reading an informational call took (case 33 pins
# exactly that: three reads, one poll). Bounded by the same 60s, and a long block is
# always far wider than the window so the post-block gate really does re-poll -- but
# it is no longer true that those calls "only warm the log and the cache", and this
# comment said so for a while.
#
# Mutates blind_fires (a global) rather than running in a subshell, so the blind
# allowance is spent exactly once per authorised blind fire.
quota_gate() {
  gate_blind=0        # was THIS decision made blind? charged at the fire site
  qg_pct="$(quota_pct)"
  if [ -n "$qg_pct" ]; then
    if [ "$qg_pct" -ge "$QUOTA_STOP_PCT" ]; then
      log "STOP: 7-day quota utilization ${qg_pct}% >= QUOTA_STOP_PCT=${QUOTA_STOP_PCT}% -- refusing to fire (window resets weekly; protecting the operator's own headroom)"
      return 1
    fi
    log "quota ok: 7-day utilization ${qg_pct}% (< ${QUOTA_STOP_PCT}%)"
    return 0
  fi
  # UNREADABLE, so before firing blind, ask what we last KNEW. Measured
  # 2026-07-26: both sources failed at 02:05 while the account sat at ~98% (it
  # had refused at 99% eight hours earlier), and the blind fire cost $24, hit the
  # cap and shipped nothing. A fresh high reading is enough to refuse.
  qg_cached="$(quota_cache_read)"
  if [ -n "$qg_cached" ] && [ "$qg_cached" -ge "$QUOTA_STOP_PCT" ]; then
    log "STOP: 7-day quota UNREADABLE and the last known reading was ${qg_cached}% >= QUOTA_STOP_PCT=${QUOTA_STOP_PCT}% -- refusing to fire blind into a window that was already exhausted (usage only rises until the weekly reset)"
    return 1
  fi
  # UNREADABLE is not the same as "fine". Allow a bounded number of blind fires
  # so a monitoring hiccup does not waste a whole night, then stop.
  #
  # Counted with its OWN counter, not the cumulative `fires`. Reusing `fires`
  # meant a run that had already done QUOTA_UNKNOWN_FIRES *readable* fires hit the
  # cap on its FIRST unreadable reading and stopped with none of the grace this
  # cap documents -- the dashboard dying mid-run ended the night. That fix is
  # mildly MORE permissive, which is only safe because the last-known cache above
  # refuses outright when the window was already exhausted; that is the check with
  # teeth, and this is the monitoring-hiccup allowance it was always described as.
  # Deliberately NOT reset by a budget re-grant: blind fires stay bounded per RUN.
  if [ "$blind_fires" -ge "$QUOTA_UNKNOWN_FIRES" ]; then
    log "STOP: 7-day quota utilization UNREADABLE and $blind_fires blind fire(s) already spent (cap QUOTA_UNKNOWN_FIRES=$QUOTA_UNKNOWN_FIRES) -- refusing to fire blind"
    return 1
  fi
  # Flag it; do NOT charge it here. quota_gate runs up to TWICE per iteration
  # (pre-auth, and again after a block), so charging inside it spent two units of
  # QUOTA_UNKNOWN_FIRES on ONE fire -- halving the grace exactly when a monitoring
  # hiccup coincides with an auth blip, which is the correlated case the allowance
  # exists for. The counter is named blind_FIRES, so the fire site charges it, and
  # an iteration that is authorised blind but then stops at the cap charges
  # nothing at all.
  gate_blind=1
  log "WARN: 7-day quota utilization UNREADABLE (dashboard, loop reader and studio all unavailable) -- firing blind, $((QUOTA_UNKNOWN_FIRES - blind_fires - 1)) blind fire(s) left after this one"
  return 0
}

# Escalating backoff: attempt N -> min(30 * 2^(N-1), 600)s. Shift is capped so a
# forever-retry (AUTH_TRIES=0) can never overflow the arithmetic.
backoff_sleep() {
  bs_n="$1"
  [ "$bs_n" -gt 10 ] && bs_n=10
  bs_s=$(( BACKOFF_BASE * (1 << (bs_n - 1)) ))
  [ "$bs_s" -gt 600 ] && bs_s=600
  log "backing off ${bs_s}s"
  [ "$bs_s" -gt 0 ] && sleep "$bs_s"
}

# --- [loop-paused]: a NON-stopping alert (the stop check below does NOT match
# it). Idempotent by a per-cause marker so we never spam duplicates. -----------
paused_open() {   # $1=marker  $2=title  $3=body
  po_n="$(gh issue list --state open --search "in:title [loop-paused] $1" --json number -q 'length' 2>/dev/null || echo 0)"
  [ "${po_n:-0}" != "0" ] && return 0
  gh issue create --title "[loop-paused] $1 -- $2" --label studio --body "$3" >>"$DLOG" 2>&1 \
    && log "ALERT: filed [loop-paused] $1 -- $2"
}
paused_close() {  # $1=marker
  for pc_n in $(gh issue list --state open --search "in:title [loop-paused] $1" --json number -q '.[].number' 2>/dev/null); do
    gh issue close "$pc_n" --comment "Auto-resolved: the condition cleared and the loop resumed." >>"$DLOG" 2>&1 \
      && log "ALERT: closed [loop-paused] $1 #$pc_n (cleared)"
  done
}

# --- [loop-blocked]: the STOPPING alarm (a real break the operator must fix).
# `gh` auth is a SEPARATE store from claude's OAuth, so this path works even when
# claude auth is what's down. Idempotent. --------------------------------------
signal_blocked() {  # $1=title  $2=body
  sb_open="$(gh issue list --state open --search 'in:title [loop-blocked]' --json number -q 'length' 2>/dev/null || echo 0)"
  [ "${sb_open:-0}" != "0" ] && { log "SIGNAL: [loop-blocked] already open -- not duplicating"; return 0; }
  gh issue create --title "[loop-blocked] $1" --label studio --body "$2" >>"$DLOG" 2>&1 \
    && log "SIGNAL: filed [loop-blocked] -- $1"
}

# --- auth_ok: ONE bounded auth probe (macOS has no `timeout`; a hung probe must
# never wedge the driver). Returns 0 if auth works, 1 otherwise. ---------------
auth_ok() {
  ao_out="$INFRA/logs/authcheck.$(date -u +%Y%m%d-%H%M%S).log"
  claude -p "Reply with exactly: AUTH_OK" \
    --model sonnet \
    --setting-sources project,local \
    --dangerously-skip-permissions \
    --output-format json >"$ao_out" 2>&1 &
  ao_pid=$!
  ao_i=0
  while [ "$ao_i" -lt 30 ]; do
    kill -0 "$ao_pid" 2>/dev/null || break
    sleep 2
    ao_i=$((ao_i + 1))
  done
  if kill -0 "$ao_pid" 2>/dev/null; then
    kill -9 "$ao_pid" 2>/dev/null
    log "auth probe HUNG >60s"
    return 1
  fi
  wait "$ao_pid"
  ao_rc=$?
  if [ "$ao_rc" != "0" ] || grep -q '"is_error":true' "$ao_out" 2>/dev/null; then
    log "auth probe FAILED (rc=$ao_rc): $(head -c 200 "$ao_out" | tr '\n' ' ')"
    return 1
  fi
  return 0
}

# --- ensure_auth: PAUSE + BACKOFF + RETRY until auth works. Never stops the loop
# for auth (operator model: auth is a limit/transient, not a "you-specify" or a
# "nothing-to-do"). A transient hang recovers on retry 1-2; a real expiry backs
# off until the operator re-logs in, then self-heals. Alerts [loop-paused] after
# a few failures so the operator knows, and auto-closes it on recovery. --------
ensure_auth() {
  ea_n=0
  while true; do
    if auth_ok; then
      # Publish how long the block was. The caller uses it to decide whether the
      # quota window the fire budget was sized against has moved on. Always set,
      # including to 0, so a later caller can never read a stale block length.
      auth_block_retries="$ea_n"
      if [ "$ea_n" -gt 0 ]; then log "auth recovered after $ea_n retr(y/ies)"; paused_close auth; fi
      return 0
    fi
    ea_n=$((ea_n + 1))
    log "auth check failed (attempt $ea_n)"
    # Periodically re-read quota DURING the block. A usage cap and an expired
    # token both surface here as a failing probe, and in the 2026-07-26..29
    # incident 427 consecutive "auth probe FAILED" lines described a weekly cap.
    # This also re-warms the cache above if the dashboard comes back mid-block.
    if [ $((ea_n % AUTH_LONG_BLOCK)) -eq 0 ]; then
      log "quota during auth block: 7-day utilization $(quota_pct)% (empty = unreadable; a CAP and an expired token both look like a failing probe)"
    fi
    if [ "$ea_n" -eq 3 ]; then
      paused_open auth "Claude auth failing; loop PAUSED, backing off + retrying" \
"The headless \`claude -p\` auth check is failing -- a transient hang, a usage cap, or an expired subscription token.

**The driver is NOT stopping.** It is backing off and retrying, and resumes automatically the moment auth returns (this issue auto-closes on recovery). No fires are being spent while paused.

If it persists for a long time, the subscription token likely needs an interactive re-login: run \`claude\` in a terminal and confirm you are logged in. Nothing else to do -- the loop self-heals.

Driver log: \`studio-loop/logs/driver.log\`."
    fi
    if [ "$AUTH_TRIES" -gt 0 ] && [ "$ea_n" -ge "$AUTH_TRIES" ]; then
      log "auth still failing after $ea_n tries (AUTH_TRIES cap hit -- test mode)"
      return 1
    fi
    backoff_sleep "$ea_n"
  done
}

# --- THE FIRE OUTCOME FACTS (#774) -------------------------------------------
# Echo a compact one-line fact string describing how the last fire TERMINATED,
# for the LIMIT-vs-CRASH classifier below to match markers against.
#
# WHY THIS EXISTS. The classifier used to grep the ENTIRE fire log. A fire log is
# a full transcript -- every file read, every diff, every word the agent wrote --
# so when the fire's TICKET is about rate limiting, the markers are all over it
# for entirely innocent reasons (measured on a real 2026-07-29 log: `quota` 1337
# times, `429` 166, `rate limit` 41). The classifier then matched
# unconditionally, so a GENUINE crash -- a broken script, a bad merge, a hung
# tool -- was excused as a limit: `crash` never incremented, MAX_CRASH never
# tripped, no `[loop-blocked]` was ever filed, and the driver backed off and
# retried the same broken fire indefinitely while the `[loop-paused] limit` alert
# told the operator "NEEDS NO ACTION". Fail-open in the one direction the crash
# detector exists to cover.
#
# The haystack is the LAST `{"type":"result"}` object and nothing else:
#   - Scanned for, not `tail -1`'d: a fire log is a MIXED stream (wrapper lines
#     plus stream-json from `run.sh`'s `--output-format stream-json`), and its
#     literal last line is usually a driver footer -- 276 of the 277 real logs
#     with a result object. Not ALL of them, which is the point: the one exception
#     is a crash whose wrapper died before writing a footer, leaving the result
#     object itself last. So neither "the last line is the result" nor "a footer
#     is always there" holds, and scanning is the only shape-independent read.
#   - The LAST such object, because a log can hold several when run.sh invokes the
#     CLI more than once: 88 of those 277 hold more than one, up to SIX. The
#     terminal one is the outcome; an earlier one only describes a turn that was
#     followed by more work.
#
# Two exit codes distinguish the non-classifiable cases, because they mean
# different things to an operator reading the driver log and both must land on
# CRASH rather than silently on the no-action path:
#   1 = no log, no terminal result object, or unparseable -- the outcome is
#       UNREADABLE (killed by OOM/launchd before emitting one, say).
#       KNOWN CONSEQUENCE, accepted deliberately: this catches a real LIMIT that
#       terminates before any stream-json turn starts (a 429 refused at connection
#       or auth time), which the old whole-log grep would have called a limit off
#       its raw stderr. Such a fire now counts toward MAX_CRASH. That is the
#       fail-SAFE direction and it is bounded -- MAX_CRASH consecutive failures
#       file one visible `[loop-blocked]`, and any clean fire resets the counter --
#       whereas the LIMIT path retries forever and tells nobody, which is the whole
#       defect. `ensure_auth` at the loop top independently pauses on an auth/limit
#       block, so the common shapes are caught before the fire path repeats.
#   2 = the model turn did NOT error, so a non-zero rc came from the WRAPPER.
#       Here the `result` text is the agent's own prose summary, markers and all,
#       so consulting it would reopen this very bug at one-message scale. It is
#       excluded BY THE GATE, not by hoping prose stays clean.
# When the turn DID error, `result` carries the provider's error string instead
# ("API Error: 529 Overloaded", "You've hit your weekly limit") and is the only
# place a status-less limit is visible at all. Every real limit observed so far
# (two 429s, one 529) DID carry `api_error_status`, so the text is not what
# classifies those -- but real logs also show `is_error:true` with a NULL status
# (an expired-OAuth case and a connection-closed one), so "a limit that arrives
# without a status" is a shape this log format genuinely produces, and the text is
# the only signal left when it does. Case 28c pins that shape and fails without it.
fire_result_facts() { # $1=fire log path -> facts on stdout; 1=unreadable, 2=no turn error
  [ -n "${1:-}" ] && [ -f "$1" ] || return 1
  python3 -c '
import json, sys

last = None
try:
    fh = open(sys.argv[1], errors="replace")
except IOError:
    sys.exit(1)
with fh:
    for line in fh:
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if isinstance(obj, dict) and obj.get("type") == "result":
            last = obj
if last is None:
    sys.exit(1)
# Strictly `is True`: a MISSING is_error must not read as "the turn errored", and
# a truthy-but-non-bool must not either.
if last.get("is_error") is not True:
    sys.exit(2)
# Capped and whitespace-flattened: this string goes into the driver log, so an
# unbounded error body would dominate it.
#
# The cap is a real (if remote) risk and therefore MEASURED, not guessed: a marker
# sitting past the cut would be truncated out of the haystack and the limit would
# misclassify as a CRASH. Across the 277 real logs the longest terminal result text
# on an ERRORED turn -- the only case reached here at all, since a non-errored turn
# exits 2 above -- is 158 chars. 2000 is ~12x that. (Successful fires do run to
# 4130, carrying the whole closing summary from the agent, but those exit 0 and
# never reach the classifier.) Raise this rather than trim it if errors grow.
#
# NOTE no apostrophes in this block: it lives inside `python3 -c` single quotes,
# where one would terminate the shell string. shellcheck catches it.
text = " ".join(str(last.get("result") or "").split())[:2000]
print("status=%s subtype=%s terminal=%s stop=%s text=%s" % (
    last.get("api_error_status"),
    last.get("subtype"),
    last.get("terminal_reason"),
    last.get("stop_reason"),
    text,
))
' "$1" 2>/dev/null
}

# --- executable body ---------------------------------------------------------
# Everything above is configuration + function definitions; everything below runs
# the loop. The guard is the repo convention, and it matters MORE here than most:
# the body is an unconditional `while true`, so sourcing this file to unit-test
# its functions would hang the sourcing shell outright.
[ "${BASH_SOURCE[0]}" = "${0}" ] || return 0

# Create the log directory. run.sh mkdir'd it, but only once a fire had already
# started -- so a first run under a fresh INFRA (exactly what the cutover in
# README.md does) silently swallowed `DRIVER START` and every FATAL, because
# log() appends to a path whose directory does not exist.
#
# BELOW the guard, not next to the DLOG assignment where it first landed. At file
# scope it ran on `source` too, which made the guard directly above it a lie --
# the round-1 fix for the missing directory and the round-1 fix adding the guard
# contradicted each other. Config and function definitions go above the guard;
# anything that TOUCHES THE WORLD goes here.
mkdir -p "$(dirname "$DLOG")" 2>/dev/null || true

cd "$REPO" || { log "FATAL: worktree $REPO missing"; exit 1; }

stall=0
crash=0
loops=0
fires=0
auth_block_retries=0      # length of the auth block ensure_auth just cleared (set -u: must exist)
budget_regrants=0         # re-grants spent this run; bounded by MAX_BUDGET_REGRANTS
blind_fires=0             # fires spent while quota was UNREADABLE; bounded by QUOTA_UNKNOWN_FIRES
gate_blind=0              # last quota_gate decision was blind (set -u: must exist)
adoptions=0               # self-adopt exec ATTEMPTS this run; bounded by MAX_SELF_ADOPT (#811)
prev_head=""

# Normalised HERE and not at declaration, because complaining needs `log` and the log
# directory. Nothing reads a quota before the loop below, so this is in time.
QUOTA_POLL_MIN_INTERVAL="$(quota_knob_secs QUOTA_POLL_MIN_INTERVAL "$QUOTA_POLL_MIN_INTERVAL" 60 300)"
QUOTA_CACHE_MAX_AGE="$(quota_knob_secs QUOTA_CACHE_MAX_AGE "$QUOTA_CACHE_MAX_AGE" 86400 0)"
# The shadow interval was normalised here too, until C3 (#410) removed the probe it
# throttled. Only the two knobs above survive, and both feed the DECISION path.
# Both #811 knobs go through the same normaliser, and for the same reason it was
# written: each is fed straight to `test`, where an operand it cannot parse
# returns 2 and takes NEITHER branch. An unparseable HANDOFF_MAX_AGE would make
# every handoff record look fresh forever; an unparseable MAX_SELF_ADOPT would
# leave the adopt cap silently unarmed, which is an adopt LOOP.
HANDOFF_MAX_AGE="$(quota_knob_secs HANDOFF_MAX_AGE "$HANDOFF_MAX_AGE" 300 0)"
MAX_SELF_ADOPT="$(quota_knob_secs MAX_SELF_ADOPT "$MAX_SELF_ADOPT" 3 0 adoptions)"

log "=== DRIVER START (repo=$REPO -- MAX_FIRES=$MAX_FIRES, QUOTA_STOP_PCT=$QUOTA_STOP_PCT%; stop on operator/nothing-to-do/quota; backoff on limits) ==="

# #808. Taken HERE, as early below the guard as the log allows, because it is the
# only moment at which "the file on disk" and "the code this process is running"
# are known to be the same thing. Every later comparison is against this.
DRIVE_BOOT_HASH="$(drive_self_hash)"
[ -n "$DRIVE_BOOT_HASH" ] || log "WARN: could not hash $DRIVE_SELF at start -- the driver-code drift check will read UNKNOWN for this whole run (#808)"

# #811. AFTER the boot hash, and that order is load-bearing: the hash must be
# taken from the file THIS process is running, so an adopted process reads `live`
# rather than inheriting the predecessor's idea of what it booted from. Before
# the loop, because every counter it restores bounds the first iteration.
drive_handoff_resume
# AFTER the resume, because it is a FLOOR on what that record said rather than an
# alternative to it -- and unconditional, because its whole job is the case where
# the record did not survive.
drive_adopt_floor

# Is the quota guard's fallback reader actually THERE? A missing reader and a
# rate-limited one are indistinguishable downstream -- both yield "" and the fire
# just logs a different winning source, or UNREADABLE. That silence is exactly
# how #766 hid for its entire life: source 2 was dead from the day it was written
# and nothing said so.
#
# The realistic way it goes missing is a partial sync. `~/Dev/studio-loop/` is an
# unversioned copy kept in step by hand, so copying `drive.sh` without
# `claude_usage.py` re-creates #764's failure by hand. Announce it once per run
# rather than trusting a README to be read. Cheap, fail-safe, and it cannot
# suppress a fire -- it only tells the truth about how many sources exist.
if [ ! -f "$LOOP_LIB/claude_usage.py" ]; then
  log "WARN: quota fallback reader MISSING at $LOOP_LIB/claude_usage.py -- the guard has lost a source and is down to its HTTP sources only (#764). If this followed a sync, copy claude_usage.py alongside drive.sh."
fi

while true; do
  loops=$((loops + 1))
  if [ "$MAX_LOOPS" -gt 0 ] && [ "$loops" -gt "$MAX_LOOPS" ]; then
    log "MAX_LOOPS=$MAX_LOOPS reached (test mode) -- ending"
    break
  fi
  git fetch origin --quiet 2>>"$DLOG"

  # #808. Per ITERATION, not per fire, and deliberately ahead of every stop
  # condition below: a run that never fires -- stopped by the quota gate, an
  # operator signal, or MAX_STALL -- is exactly a run that might be stopping
  # BECAUSE it is executing superseded code, and reporting only alongside a fire
  # would say nothing in the one case where it matters most. Iterations are
  # roughly one per fire (auth backoff and the PR gate wait loop internally), so
  # this costs no extra log volume.
  drift_report

  # #811. Immediately after the report that measures it, and ahead of every stop
  # condition, gate and fire below -- so a merged fix is adopted BEFORE the run
  # it was merged to change. `loops` has already been incremented above and is
  # carried in the handoff. That keeps MAX_LOOPS bounding the run across the
  # exec -- which in production is inert (it defaults to 0, uncapped) but is
  # exactly the lever the tests use to observe that the carry happened at all.
  drive_self_adopt

  # --- STOP: operator signal ([operator-decision]/[mvp-ready]) or a real block.
  #     [loop-paused] is deliberately NOT matched here -- it never stops. -------
  sig="$(gh issue list --state open --search 'in:title [operator-decision]' --json number -q 'length' 2>/dev/null || echo 0)"
  blk="$(gh issue list --state open --search 'in:title [loop-blocked]' --json number -q 'length' 2>/dev/null || echo 0)"
  mvp="$(gh issue list --state open --search 'in:title [mvp-ready]' --json number -q 'length' 2>/dev/null || echo 0)"
  if [ "${sig:-0}" != "0" ] || [ "${blk:-0}" != "0" ] || [ "${mvp:-0}" != "0" ]; then
    log "STOP: operator signal open (operator-decision=$sig loop-blocked=$blk mvp-ready=$mvp)"
    break
  fi

  # --- QUOTA GUARD: never spend the operator out of their own sessions --------
  # Checked BEFORE the fire, so a refusal costs a curl and a log line. The 7-day
  # window resets WEEKLY, so exhausting it does not self-heal overnight -- it
  # blocks the operator's interactive work for days. Stopping is therefore the
  # fail-safe direction, and the driver's scheduled restarts re-check cheaply.
  quota_gate || break

  # --- PAUSE+BACKOFF until auth is good (never stops the loop for auth) --------
  ensure_auth || { log "auth capped out (test mode) -- ending"; break; }

  # --- FIRE-BUDGET RE-GRANT after a LONG auth/limit block ---------------------
  # MAX_FIRES exists to bound spend inside ONE quota window (2026-07-25: 16
  # uncapped fires took the 7-day window to 97%). A long block outlives that
  # premise. Measured 2026-07-26..29: fire 1 died on the usage cap, the driver
  # then sat in auth backoff for 71h, and on recovery the surviving count stopped
  # the run at MAX_FIRES with the window back down at 3% -- ~15h of headroom
  # unspent. The block, not the budget, is what protected the operator there.
  #
  # BOUNDED ON PURPOSE. Re-granting on every block would let flapping auth uncap
  # the driver entirely, so a run gets MAX_BUDGET_REGRANTS of them (worst case
  # (1 + MAX_BUDGET_REGRANTS) * MAX_FIRES fires) and the quota guard above still
  # runs before every single fire. Only re-grant when there is something to
  # recover -- a block at fires=0 must not spend the allowance.
  if [ "$auth_block_retries" -ge "$AUTH_LONG_BLOCK" ] && [ "$fires" -gt 0 ] \
     && [ "$budget_regrants" -lt "$MAX_BUDGET_REGRANTS" ]; then
    budget_regrants=$((budget_regrants + 1))
    log "fire budget RE-GRANT: fires $fires -> 0 after a long block of $auth_block_retries auth retr(y/ies) (re-grant $budget_regrants/$MAX_BUDGET_REGRANTS)"
    fires=0
  fi
  # No reset needed here: ensure_auth is the SINGLE writer of auth_block_retries
  # and publishes it unconditionally on every success (0 included), so it cannot
  # be stale by the time this block reads it. A second reset here was mutation-
  # tested and survived -- i.e. it was unprovable, so it is gone.

  # --- RE-CHECK QUOTA after any block -----------------------------------------
  # The reading above was taken BEFORE ensure_auth, which can sit in backoff for
  # days. It is not evidence about the window this fire would land in, and the
  # re-grant just above may have handed the budget back on the strength of that
  # same block -- so this is precisely where a stale "quota ok" does the most
  # damage. Cheap (a curl and a log line), and it re-runs the identical rules.
  #
  # Post-C3 caveat, since this re-check exists to defeat staleness: a SHORT block
  # (one retry, ~30-40s at BACKOFF_BASE=30) fits inside QUOTA_POLL_MIN_INTERVAL, so
  # source 2 answers it from the memo and it re-reads the same number it was meant to
  # replace. Inside the accepted 60s bound, and the case that matters is unaffected --
  # the re-grant path needs AUTH_LONG_BLOCK retries, always far more than 60s, so it
  # always re-polls for real. Worth knowing before trusting this line to have taken a
  # fresh figure in every case.
  if [ "$auth_block_retries" -gt 0 ]; then
    log "re-checking quota: the pre-block reading is stale after $auth_block_retries auth retr(y/ies)"
    quota_gate || break
  fi

  # --- FIRE CAP ---------------------------------------------------------------
  # AFTER ensure_auth and the re-grant, deliberately. Checked before them, the
  # loop broke the moment `fires` hit MAX_FIRES without ever probing auth again,
  # so a block that started on the LAST budgeted fire could never reach the
  # re-grant -- the behaviour depended on whether the block landed one fire early
  # or exactly on the boundary, which is arbitrary. Now a block is waited out and
  # judged the same way wherever it falls.
  #
  # The QUOTA guard stays above the probe, so a quota-blocked scheduled start
  # still costs ZERO tokens. Only a run that has actually exhausted its budget
  # pays one auth probe before exiting, which is the price of the boundary case
  # behaving like every other one.
  if [ "$MAX_FIRES" -gt 0 ] && [ "$fires" -ge "$MAX_FIRES" ]; then
    log "STOP: MAX_FIRES=$MAX_FIRES reached -- ending this driver run (scheduled start will resume)"
    break
  fi

  # --- wait for the LOOP's open PR gate to settle before the next fire --------
  # Filtered in bash rather than in gh's jq so the predicate under test is this
  # script's (`is_loop_ref`), not a stub's query string.
  pr=""
  while IFS=' ' read -r pr_num pr_ref; do
    [ -n "$pr_num" ] || continue
    is_loop_ref "$pr_ref" || continue
    pr="$pr_num"; break
  done <<EOF
$(gh pr list --state open --json number,headRefName -q '.[]|"\(.number) \(.headRefName)"' 2>/dev/null || true)
EOF
  if [ -n "$pr" ]; then
    log "open PR #$pr present -- waiting for its gate to settle"
    t=0
    while [ "$t" -lt "$GATE_WAIT_TRIES" ]; do
      pend="$(gh pr checks "$pr" --json bucket -q '[.[]|select(.bucket=="pending")]|length' 2>/dev/null || echo 1)"
      [ "${pend:-1}" = "0" ] && break
      [ "$GATE_WAIT_SLEEP" -gt 0 ] && sleep "$GATE_WAIT_SLEEP"
      t=$((t + 1))
    done
    log "PR #$pr gate settled (or waited ${t}x${GATE_WAIT_SLEEP}s)"

    # --- RE-CHECK QUOTA after the wait ---------------------------------------
    # Same staleness class the round-4 fix closed for auth blocks, and this one
    # is routinely exercised: the wait runs on EVERY iteration with an open PR
    # and lasts up to GATE_WAIT_TRIES x GATE_WAIT_SLEEP (30 min by default),
    # sitting between the last quota_gate and the fire. Shorter window, but the
    # operator's own interactive sessions can move the 7-day figure inside it --
    # and their headroom is the thing this guard exists to protect. Only re-check
    # when we ACTUALLY waited; a gate that was already settled changes nothing.
    # Same post-C3 caveat as the auth-block re-check above: a single t=1 wait is
    # GATE_WAIT_SLEEP=30s, inside the memo window, so that one re-read can be
    # memo-served. t>=3 (90s) always re-polls.
    if [ "$t" -gt 0 ]; then
      log "re-checking quota: the pre-wait reading is stale after ${t}x${GATE_WAIT_SLEEP}s of gate wait"
      quota_gate || break
    fi
  fi

  # --- progress / stall accounting (the ONLY "nothing more to do" detector) ---
  head="$(git rev-parse origin/main 2>/dev/null || echo unknown)"
  # Counted the same way, and over the loop's PRs only -- an operator PR open in
  # this repo is not the loop making progress (#805).
  openpr=0
  while IFS=' ' read -r pr_num pr_ref; do
    [ -n "$pr_num" ] || continue
    is_loop_ref "$pr_ref" || continue
    openpr=$((openpr + 1))
  done <<EOF
$(gh pr list --state open --json number,headRefName -q '.[]|"\(.number) \(.headRefName)"' 2>/dev/null || true)
EOF
  # A local studio branch with commits origin/main does not have is WORK IN
  # FLIGHT, not a stall. prompt.md's triage rule 2 says exactly that ("a studio
  # feature branch ahead of main -> continue it to a PR"), so without this the
  # driver's notion of progress contradicts the rule the fires actually follow.
  #
  # Measured 2026-07-29 (#775): fires 8 and 9 each ended with work committed but
  # unpushed, the counter reached 2/3, and a third would have stopped the run
  # saying "nothing more to do (or the queue is drained)" while two commits and 66
  # staged lines sat on a branch. The stop is fail-safe in direction; the harm is
  # the MESSAGE, which is what an operator reads to decide the queue is empty --
  # and it is the one stop reason that files no alert.
  #
  # Branch-ahead, not a dirty worktree: dirt could be leftovers, whereas a commit
  # origin/main lacks is unambiguous, and it is the same signal rule 2 keys on.
  # A branch only counts while it is RECENT. Matching any studio branch would let
  # a leftover from a crashed session defeat the stall detector permanently --
  # bounded then only by quota, not by the signal it exists to trip. That is not
  # hypothetical: 18 stale branches with deleted remotes were pruned from this
  # repo on 2026-07-29. A tip untouched for AHEAD_MAX_AGE is abandonment.
  #
  # `while read` fed by a HERE-DOC, not a pipeline: a pipeline runs the loop in a
  # subshell and `ahead` would not survive it.
  ahead=""
  sb_now="$(date +%s)"
  while IFS=' ' read -r sb_ref sb_when; do
    [ -n "$sb_ref" ] || continue
    is_loop_ref "$sb_ref" || continue
    # Non-numeric or absent date -> treat as NOT recent. Fail toward letting the
    # stall detector work, since the alternative masks it.
    case "$sb_when" in ''|*[!0-9]*) continue ;; esac
    [ "$(( sb_now - sb_when ))" -gt "$AHEAD_MAX_AGE" ] && continue
    if [ "$(git rev-list --count "origin/main..$sb_ref" 2>/dev/null || echo 0)" -gt 0 ]; then
      ahead="$sb_ref"; break
    fi
  done <<EOF
$(git for-each-ref --format='%(refname:short) %(committerdate:unix)' refs/heads 2>/dev/null)
EOF
  if [ -n "$prev_head" ] && [ "$head" = "$prev_head" ] && [ "${openpr:-0}" = "0" ] && [ -z "$ahead" ]; then
    stall=$((stall + 1))
    log "no progress (main unchanged, no open PR, no branch ahead) stall=$stall/$MAX_STALL"
    if [ "$stall" -ge "$MAX_STALL" ]; then
      log "STOP: $stall consecutive no-progress fires -- nothing more to do (or the queue is drained)"
      break
    fi
  else
    # Either something moved (main advanced, or a PR is open), or a branch is
    # ahead. Say WHICH when it is the branch, so a log reader can tell "work in
    # flight" from "main advanced" without diffing anything.
    # Keyed on `ahead` ALONE. Conditioning on `[ "$head" = "$prev_head" ]` made
    # this silent on the FIRST iteration, where `prev_head` is unset -- so a
    # driver started with a branch already ahead never explained why it was not
    # stalling (#775 review NITPICK). "A branch is ahead" is true regardless.
    [ -n "$ahead" ] && log "'$ahead' is ahead of main -- work in flight, not a stall"
    stall=0
  fi
  prev_head="$head"

  # --- fire one headless piece ------------------------------------------------
  fires=$((fires + 1))
  # Charge the blind allowance HERE, once, for the fire it actually authorised.
  [ "$gate_blind" = "1" ] && blind_fires=$((blind_fires + 1))
  log "=== FIRE $fires (main=$(echo "$head" | cut -c1-7) openPR=$openpr) ==="
  bash "$INFRA/run.sh"
  rc=$?
  # A fire is the only thing that SPENDS, so a reading taken before it is not
  # evidence about the window the NEXT one would land in. Dropping the source-2 poll
  # memo here (#777) makes that structural rather than an argument about staleness:
  # the memo can only ever serve reads about the fire it was taken for, and the next
  # gate polls for real. Costs at most one poll per fire -- the rate the retired
  # dashboard sampler already ran at, so it cannot be the thing that 429s.
  quota_poll_memo_clear
  log "fire $fires exited $rc"

  if [ "$rc" != "0" ]; then
    # LIMIT vs BREAK: a usage/rate limit is a PAUSE (back off, retry -- never a
    # stop); a non-limit failure with auth good is a real BREAK (count it).
    lastlog="$(ls -t "$INFRA"/logs/fire.*.log 2>/dev/null | head -1)"
    # #774 -- the marker list is unchanged; only its INPUT is narrowed, from the
    # whole transcript to the terminal result facts. See `fire_result_facts`.
    fire_facts="$(fire_result_facts "$lastlog")"
    facts_rc=$?
    case "$facts_rc" in
      0) crash_why="terminal result carried no limit marker [$fire_facts]" ;;
      2) crash_why="the model turn did NOT error, so the non-zero rc came from the wrapper (agent prose is never consulted)" ;;
      *) crash_why="fire outcome UNREADABLE (no log, no terminal result, or unparseable) -- failing safe to CRASH" ;;
    esac
    if [ "$facts_rc" = "0" ] && printf '%s' "$fire_facts" | grep -qiE 'usage limit|rate limit|rate_limit|429|overloaded|resource_exhausted|quota|too many requests'; then
      log "fire $fires hit a LIMIT -- pausing + backing off (NOT a crash) [$fire_facts]"
      paused_open limit "usage/rate limit hit; loop PAUSED, backing off" \
"A fire hit a usage/rate limit. The driver is backing off and retries automatically when the limit clears (auto-closes on recovery). No fires wasted, no action needed."
      backoff_sleep $(( crash + 3 ))
      continue
    fi
    # Auth can also die MID-fire; ensure_auth at the loop top will catch+pause it
    # next iteration. Here, treat a non-limit failure as a real break.
    crash=$((crash + 1))
    log "fire $fires exited NON-ZERO, not a limit (crash=$crash/$MAX_CRASH): $crash_why"
    if [ "$crash" -ge "$MAX_CRASH" ]; then
      signal_blocked "run.sh crash-looped ($crash consecutive non-limit failures, auth OK)" \
"The studio build driver stopped: \`run.sh\` failed **$crash times in a row** with auth confirmed good and no usage/rate-limit marker in how the last fire TERMINATED. This is a genuine BREAK (a bug in the fire path), not a limit -- so it needs you, not a backoff.

Why the last one was not a limit:
\`\`\`
$crash_why
\`\`\`

Most recent fire log:
\`\`\`
ls -t /Users/lukebradford/Dev/studio-loop/logs/fire.*.log | head -1 | xargs tail -40
\`\`\`
Driver log: \`studio-loop/logs/driver.log\`

Fix the cause, close this issue, then reload:
\`\`\`
launchctl unload ~/Library/LaunchAgents/com.autonomy.studio-build-driver.plist
launchctl load   ~/Library/LaunchAgents/com.autonomy.studio-build-driver.plist
\`\`\`"
      log "STOP: crash-looped $crash consecutive fires (real break)"
      break
    fi
    backoff_sleep "$crash"
    continue
  fi

  # a clean fire clears the crash counter and any stale limit-pause alert
  crash=0
  paused_close limit
done

log "=== DRIVER DONE (fires=$fires, loops=$loops) ==="
