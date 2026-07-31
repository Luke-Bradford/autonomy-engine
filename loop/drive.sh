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
QUOTA_SHADOW_STAMP="${QUOTA_SHADOW_STAMP:-$INFRA/.last_quota_shadow}"  # "<epoch> probe" of the
                                  # last SHADOW poll ATTEMPT. Its own file, its own age, its own
                                  # contract -- see quota_shadow_probe (#765).
QUOTA_SHADOW_MIN_INTERVAL="${QUOTA_SHADOW_MIN_INTERVAL:-3600}"  # min seconds between DIAGNOSTIC
                                  # polls of studio. 0 disables the probe entirely.
DRIFT_REPORT="${DRIFT_REPORT:-1}"  # set to exactly "0" to silence the #808 drift report. Any OTHER
                                  # value still reports: a monitor a typo can switch off without
                                  # saying so fails in the monitored direction, and `DRIFT_REPORT=no`
                                  # reading as "off" is the same silence this ticket exists to end.
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
# The convention this keys on is prompt.md rule 0's own words -- "the
# supervisor opens its OWN PRs ... on non-`studio` branches" -- so the driver
# was the one part of this loop not honouring its own work order. Checked
# 2026-07-31: of the last 30 merged PRs, 22 were `*/studio-*` (the loop's), and
# across the last 40 every `*/loop-*` branch was the operator's.
#
# Fail-safe direction: a loop branch misnamed outside the convention reads as
# "not the loop's", which under-counts progress and can trip a false stall. A
# false stall STOPS the loop; the opposite error spends. Stopping is the cheap
# mistake, so the imprecision is on the safe side deliberately.
is_loop_ref() {
  case "${1:-}" in feat/studio*|fix/studio*) return 0 ;; *) return 1 ;; esac
}

# --- quota_pct: the 7-day subscription utilization as an INTEGER percent, or ""
# when it cannot be read. Echoes to stdout; never fails the caller.
#
# THREE sources, and the ORDER is the load-bearing part (cutover C2, #440):
#   1. the prototype dashboard (`$DASH_URL`)
#   2. the loop's OWN usage reader (`$LOOP_LIB/claude_usage.py`; relocated out
#      of the engine by #764; #766 fixed this CALL SITE against the old module)
#   3. studio's native endpoint (`$STUDIO_QUOTA_URL`, #440 C1)
#
# All three bottom out in the SAME upstream, `GET /api/oauth/usage`, with the
# same OAuth token off the same account -- so they share ONE rate-limit budget.
# That endpoint 429s under direct polling (observed 2026-07-25, re-confirmed
# 2026-07-29: eight consecutive direct polls over 12s, all 429).
#
# What separates them is therefore not the data but the PATH to it:
#
#   * the dashboard rides through a 429 because it samples on a background
#     thread and answers from a warm cache. It is the only source that does, so
#     it goes first -- and asking it costs the upstream nothing.
#   * the loop reader (2) and studio (3) are both DIRECT polls, one per call,
#     from a cold start. Under a 429 both return "" for the same reason.
#
# Between the two direct pollers, the PROVEN one goes first: #766 measured this
# reader -- then still in the engine's `lib/`, before #764 relocated it --
# returning 10, matching the dashboard at that moment, whereas studio has never
# once returned a number here (`account.claude: null` on every probe -- its
# reader is lazy, so every read is the direct poll that 429s;
# `studio/packages/server/src/quota/claude-quota.ts`, and #765).
#
# Do not read that contrast as "the loop reader works and studio does not". Both
# were re-measured on 2026-07-29 while the dashboard was answering 14%: the loop
# reader's token read succeeded (108 chars) and the endpoint returned 429, i.e.
# the SAME failure studio reports. The honest reading is that whichever process
# holds the bucket is the one that answers, and right now that is the dashboard's
# 60s sampler -- continuously, which is why the two direct pollers see a
# permanently empty bucket. #766's success was measured in a gap between samples.
#
# There is a second-order effect on C3 too, pointing the other way. Post-C3 the
# dashboard read fails on EVERY call, so every quota_pct invocation becomes a
# Keychain read plus a direct poll -- and as the "Studio LAST" paragraph below
# notes, that is tens of polls in one iteration during a long auth block. This
# reader used to be the unthrottled one (a fresh process per call, so no in-memory
# cache and nothing giving it a cross-process one), which made it able to self-
# inflict the very 429 that then reads as UNREADABLE. FIXED by #777: it now answers
# from a poll memo inside QUOTA_POLL_MIN_INTERVAL, memoises failures too, and drops
# the memo after every fire -- see `quota_poll_memo_read` for the whole argument.
# Both surviving sources are therefore rate-bounded now, but NOT symmetrically: studio
# widens geometrically to ~8min once it sees a 429 (`claude-quota.ts`), whereas source
# 2's bound is a FLAT 60s and does not widen, so under a sustained 429 it keeps
# knocking once a minute where studio retreats. Deliberate for now -- 1/min is three
# orders off the measured failure (eight polls in 12s) and the memo makes the rate
# knowable -- but if the post-C3 logs show source 2 sitting in a 429, widening its
# interval on a failed poll is the next move, not shortening it.
#
# That has a consequence for C3 worth stating BEFORE anyone acts on it: removing
# the dashboard does not merely remove the best source, it also stops the
# polling that starves the other two. So the post-C3 pair may well start
# answering precisely because source 1 is gone. That is a HYPOTHESIS, not a
# measurement -- it predicts that a fire whose dashboard read fails will log
# `quota source: loop`, which is exactly the evidence the log lines below collect.
# Do not treat "studio has never answered" as settled while the confound stands.
#
# What CHANGED with #765 is availability, not the order. Studio's endpoint used
# to be connection-refused at fire time -- nothing supervised a studio server, so
# the only listeners were ad-hoc `pnpm dev` sessions that die with their
# terminal. A `com.autonomy.studio-server` LaunchAgent now holds 8788
# (`install_studio_server.sh`), so source 3 is reachable rather than absent.
# Every UNREADABLE it now logs is a real measurement of the READER, which is what
# the promotion decision needs; before, it only measured "no server".
#
# Studio LAST is what makes adding it free. It is reached only when both other
# sources have already failed, so it adds no SELECTION-path load in the common
# case, cannot starve the sampler that keeps source 1 warm, and still produces the
# `quota source: studio` log line that is the evidence for promoting it. (Since
# #765 studio IS asked in the common case, by the hourly diagnostic probe -- that
# is a deliberate reversal of the "no load" claim, bought for the C3 evidence and
# priced at one request per hour per active driver. It does not touch the order
# below. See `quota_shadow_probe`.) Putting
# it first would instead put a direct poll on EVERY read -- three per iteration
# from quota_gate plus one per AUTH_LONG_BLOCK retries while blocked, i.e. tens
# of polls in one iteration during the 71h block this file documents, unbounded
# -- competing for the very budget the working source depends on.
#
# Studio is promoted (and source 1 retired with the engine, C3) once it has
# DEMONSTRABLY answered here across scheduled fires -- and they only became
# collectable at all once #765 Defect 2 gave studio a supervised server to answer
# from. TWO log lines carry that evidence now, and they are NOT interchangeable:
# `quota source: studio` means the guard USED studio, and can only appear when the
# sources before it failed; `quota shadow: studio` means the probe asked studio on
# a fire the dashboard was perfectly capable of answering. The second exists
# because the first is unreachable while source 1 is healthy, which made the gate
# a test of luck. Rationale lives in ONE place -- `quota_shadow_probe` -- and is
# deliberately not restated here (#776 is about exactly this duplication).
#
# Note the promotion criterion is no longer "add a sampler": #770 measured a cold
# poll returning 200 and rejected a sampler on the evidence -- it would add a
# standing ~1/min draw on a budget already at its ceiling, contending with the
# dashboard sampler on the same account. Studio instead backs off geometrically on a
# 429. Until the evidence is in, this order is deliberate: DO NOT reorder it because
# studio is "the new one". #765 is the gate.
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

quota_read_url() {  # $1=url; echoes an integer percent, or "" for unreadable
  qr_out="$(curl -s --max-time 8 "$1" 2>/dev/null | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    u = d['account']['claude']['seven_day']['utilization']
    print(int(round(float(u) * 100)) if u is not None else '')
except Exception:
    print('')
" 2>/dev/null)"
  # TOTALITY GUARD, applied per-read at the boundary the value crosses.
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
  quota_sane "$qr_out"
}

quota_pct() {
  qp_src=""
  qp_memo_hit=0      # set -u: must exist before the source-2 branch reads it
  qp_studio_polled=0 # did source 3 run LIVE this call? gates the shadow probe below
  qp_out="$(quota_read_url "$DASH_URL")"
  [ -n "$qp_out" ] && qp_src="dashboard"
  # NOTE the single exit point below: BOTH sources must feed the cache. An early
  # `return` here silently skipped caching the primary (and commonest) reading,
  # leaving the cache empty exactly when it was working -- caught by a test.
  if [ -z "$qp_out" ]; then
    # SECOND: the loop's own usage reader. Not a URL, so it is sanitised
    # explicitly rather than via quota_read_url.
    #
    # ALREADY A PERCENT — do NOT multiply by 100 the way `quota_read_url` does,
    # and do NOT divide. That is the one trap in this function: the two HTTP
    # sources carry `utilization` as a FRACTION (hence the x100 there), this
    # reader prints the percent. A /100 slip reports every reading below 150% as
    # 0 — "wide open" — which FIRES. The two calls sit ten lines apart and are
    # the only survivors post-C3, so the difference is easy to "tidy" into a
    # fail-open bug. Pinned from both sides by `test_quota_guard.sh` cases 23-24.
    #
    # WHY A PURPOSE-BUILT PORT rather than a copy of the engine's old
    # `lib/claude_usage.py`: that module split a WRITER from a GETTER and this
    # call site used only the writer, so source 2 returned "" for its entire life
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
    # outcome was a FAILURE, which is served as "" so the fallthrough to studio
    # below happens exactly as it would on a live failure. The full rationale, and
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
      # Named DISTINCTLY from a live poll. `quota source: loop` is the evidence trail
      # for the C3 promotion decision, and a throttle that made "the reader answered"
      # indistinguishable from "the reader was not asked" would hide a source-2 death
      # the way #766 hid for its entire life. Only the memo branch is relabelled --
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
  # THIRD: studio (#440 C1), now served by the supervised `com.autonomy.studio-server`
  # unit on 8788 (#765 Defect 2) rather than by whatever `pnpm dev` happened to be
  # running. Last, deliberately. It is a DIRECT upstream poll of the same
  # rate-limited endpoint the loop reader hits, and unlike that reader it has
  # never once returned a number here (`account.claude: null` on every probe,
  # 2026-07-29). Trying the proven source first maximises availability;
  # studio is reached only when both others failed, so it adds no load in the
  # common case while still producing the `quota source: studio` signal that
  # decides when it can be promoted. See #765.
  if [ -z "$qp_out" ]; then
    qp_out="$(quota_read_url "$STUDIO_QUOTA_URL")"
    qp_studio_polled=1
    [ -n "$qp_out" ] && qp_src="studio"
  fi
  if [ -n "$qp_out" ]; then
    quota_cache_write "$qp_out"
    # Attribution goes to the LOG, never to stdout: this function's stdout IS the
    # percent (it is read in a command substitution), so an echo here would be
    # captured as part of the reading and hit the fail-open path.
    #
    # Logged on every read, deliberately -- how often studio answers, and whether
    # it ever answers at all, is the measurement that decides when it can be
    # promoted and when the dashboard can be retired (C3).
    log "quota source: $qp_src (7-day utilization ${qp_out}%)"
  fi
  # DIAGNOSTIC-ONLY studio poll, for the C3 evidence the read order above cannot
  # otherwise produce (#765). Placed here so `qp_out`/`qp_src` are already settled
  # and cannot be touched, and SKIPPED when source 3 already ran live -- a live
  # poll is real evidence and re-asking would just double the load. stdout is
  # redirected because this function's stdout is the reading itself; see
  # quota_shadow_probe for why that redirect is structural and not decoration.
  if [ "$qp_studio_polled" = "0" ]; then
    quota_shadow_probe "${qp_src:-none}" >/dev/null
  fi
  echo "$qp_out"
}

# --- last-known-quota cache. Usage inside a 7-day window is MONOTONIC (it only
# rises until the weekly reset), so a recent HIGH reading is evidence the window
# is still exhausted -- but a recent LOW reading proves nothing about now, since
# fires may have run since. The cache is therefore trusted in ONE direction only:
# it may REFUSE a fire, never permit one. Fail-safe, same polarity as ci_check.
quota_cache_write() {  # $1=pct
  # Fail-safe, so the status is deliberately discarded: no cache entry means the
  # guard takes the blind path, which is the same place a missing file lands.
  quota_stamped_write "$QUOTA_CACHE" "$1" || true
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
# same shape for the plist. Two deliberate deltas from it -- `$$` in the temp
# name (that file has one writer; #806 names a SECOND driver racing this one, and
# a shared `.tmp` name lets two of them rename each other's half-written temp),
# and `mv -f` (nothing here may ever block on a prompt).
#
# THE CONTRACT IS "RETURN 0 MEANS THE SHARED READER WILL ACCEPT WHAT IS ON DISK",
# which is why the EPOCH is validated and not merely interpolated. A `date +%s`
# that yields empty (fork failure, broken PATH) writes " <value>", which
# `quota_stamped_read` correctly rejects as having no epoch -- fail-safe for the
# cache and memo, but NOT for `quota_shadow_probe`, whose whole throttle rests on
# a successful write meaning a readable stamp exists. A `return 0` over an
# unreadable record would silently disarm it and poll studio on every call, which
# is the exact failure case 29g exists to prevent. So a bad epoch is a failure.
#
# The VALUE is checked for FORMAT ONLY (non-empty, no whitespace) -- a value
# carrying a space or newline would split into a second token or a second line
# and be mis-parsed by the reader. Its DOMAIN is still the caller's business, as
# on the read side: the callers' domains differ (a percent; a percent-or-"-"
# sentinel; the constant `probe`). No current caller can trip this check -- all
# three pass a `quota_sane`-sanitised digit string or a literal -- it exists so a
# future one cannot corrupt the format silently.
#
# Not fully dirt-free: a process killed between create and rename leaks one
# `<file>.tmp.<pid>`, which nothing sweeps. Bounded (one per file per driver PID)
# and invisible to #808's drift checks, which enumerate from `git ls-tree`.
quota_stamped_write() {  # $1=file $2=value -> 0 written, non-zero nothing written
  qsw_file="$1"; qsw_val="$2"
  case "$qsw_val" in ""|*[[:space:]]*) return 1 ;; esac
  qsw_now="$(date +%s 2>/dev/null)"
  case "$qsw_now" in ""|*[!0-9]*) return 1 ;; esac
  qsw_tmp="$qsw_file.tmp.$$"
  # `2>/dev/null` FIRST on both: redirections apply left to right, so with the
  # file open written first the shell reports its failure on the still-open
  # stderr -- which on an unwritable $INFRA meant a "No such file or directory"
  # line in the launchd stderr log on every single gate. The `mv` needs the same
  # muzzle for the same reason: a rename that fails where the create succeeded
  # (an immutable or foreign-owned destination) would otherwise print per gate.
  printf '%s %s\n' "$qsw_now" "$qsw_val" 2>/dev/null >"$qsw_tmp" || {
    rm -f "$qsw_tmp" 2>/dev/null || true; return 1
  }
  mv -f "$qsw_tmp" "$qsw_file" 2>/dev/null || {
    rm -f "$qsw_tmp" 2>/dev/null || true; return 1
  }
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
# REVISIT TRIGGER, because the argument above leans on one measurement that is still
# pending: "studio (which has never answered)". That is what makes the in-window read
# BLIND and so makes #777's polarity unaffordable. If source 3 starts answering, the
# premise is gone -- an in-window UNREADABLE from source 2 would simply fall through
# to a throttled source 3, nothing would spend the blind allowance, and #777's
# fail-safe "serve nothing in-window" becomes affordable. At that point this
# both-directions memo is unnecessary exposure and should be narrowed to refuse-only.
# The evidence to watch for is a scheduled fire logging `quota source: studio` -- or,
# since #765, a `quota shadow: studio <n>%` line, which answers the same question
# ("can source 3 serve a reading at fire time?") without needing source 1 to fail
# first. A shadow line is the WEAKER trigger of the two for this particular
# revisit, though: it says studio could have answered, not that the fallthrough
# actually reached it.
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

# --- quota_shadow_probe: poll studio for the RECORD, never for the DECISION.
#
# THE PROBLEM IT SOLVES. Cutover C3 (#410) retires the engine and with it source
# 1, leaving the loop reader and studio. Its gate is evidence that studio can
# actually serve a reading at fire time, and #765 states that evidence as a
# scheduled fire logging `quota source: studio`. But studio is source 3: that line
# can only ever appear when source 1 FAILS. While the dashboard is healthy every
# fire logs `quota source: dashboard` and studio is not polled at all, so the gate
# is unreachable by construction -- not because studio is broken, but because
# nothing ever asks it. The operator hit exactly this on 2026-07-30: an attended
# manual probe returned a real 0.16 matching the dashboard, proving the whole path
# (supervised server, reader, credential store, upstream, mapping) works end to
# end, while `grep 'quota source: studio'` over the driver log stayed at zero.
# A gate that can only be satisfied by an outage of the source it is replacing is
# a test of luck, and C3 could sit blocked indefinitely on it.
#
# So the probe asks studio ANYWAY, once per window, and writes down what it said.
#
# WHY THIS IS NOT THE SAMPLER #770 REJECTED, which is the obvious objection since
# both add load to the same rate-limited upstream. #770 measured a cold poll
# returning 200 and refused a STANDING background sample at ~1/min against a
# budget already at its ceiling. This is on-demand (it runs only when the driver
# is already reading quota, never on a timer), rate-bounded at 1/hour by default
# -- ~60x lighter, and only while the driver is active rather than around the
# clock -- and it throttles FAILED reads too. That is precisely the property the
# narrowed invariant above demands of every non-standing poller: at most ONE
# process may hold a standing sample, and everything else must be rate-bounded and
# must back off when it starts failing. A second standing sampler is still
# refused. This is not one.
#
# WHAT IT CHANGES, stated plainly rather than buried: the read order's claim that
# studio "adds no upstream load in the common case" is no longer strictly true --
# the common case is now exactly when the probe runs. That is a deliberate
# reversal, bought for the evidence, and priced at one request per hour per active
# driver. The SELECTION order is untouched; studio is still last, still reached
# live only when both other sources fail.
#
# WHAT IT MAY NEVER DO is influence a decision, and that is structural rather than
# careful:
#   * it calls `quota_read_url` DIRECTLY, not `quota_pct`. `quota_cache_write` and
#     `quota_poll_memo_write` live only in `quota_pct`'s body, so the shadow cannot
#     poison the refuse-only 24h cache or the source-2 throttle -- there is no code
#     path from here to either. A shadow-written cache entry would be especially
#     nasty: indistinguishable from a real reading, and trusted for a day.
#   * it returns nothing on stdout, and the call site redirects stdout to
#     /dev/null anyway. `quota_pct`'s stdout IS the percent (read in a command
#     substitution), so a stray echo would be appended to the reading and
#     `[ "$qg_pct" -ge "$QUOTA_STOP_PCT" ]` would return 2 -- NEITHER branch -- and
#     the gate would log "quota ok" and FIRE. Belt and braces on the one guard that
#     may not fail open.
#   * it logs a line that is DISTINCT from the live-source line. `quota source:
#     studio` means the guard used studio and is the promotion evidence; `quota
#     shadow: studio` means studio was asked and decided nothing. Collapsing the
#     two would manufacture promotion evidence on every dashboard-healthy fire --
#     forging the very signal this exists to collect honestly.
#
# THE STAMP IS WRITTEN ON THE ATTEMPT, not on success -- and this is the CANONICAL
# statement of why; the two sites that depend on it (the write below, case 29d)
# point here rather than restating it (#776). Stamping only a successful read
# leaves the stamp un-advanced for exactly as long as studio is failing, so every
# call re-attempts: up to 3 per `quota_gate` iteration plus one per
# `AUTH_LONG_BLOCK` retry, i.e. unbounded during a long block. A throttle that
# stops throttling in precisely the failure mode it was added for is the wrong
# shape. `quota_poll_memo_write` records failures as `-` for the same reason, and
# case 29d pins it here (it measured 4 polls where 1 was due).
#
# BE PRECISE ABOUT THE COST, because the obvious framing -- "#777's bug in a new
# place" -- OVERSTATES it and would justify this line for a reason that is not
# true. #777 was source 2 hitting the shared rate-limited upstream DIRECTLY with
# no throttle. #777's own text says studio is NOT in that position, and the server
# confirms it: `studio/packages/server/src/quota/claude-quota.ts` caches on a TTL,
# stamps every sample including a rate-limited one, and widens geometrically to
# ~8 min on a 429. So un-stamped retries land on a supervised localhost server and
# are absorbed there; they do NOT reach the upstream budget. The real costs are
# localhost request churn and one `quota shadow: ... UNREADABLE` line per call --
# which floods the driver log at exactly the moment it is being read to diagnose
# the failure. Smaller than a true poll storm, still worth the one line, and the
# absorbing behaviour is a property of the CURRENT server rather than a contract
# this file may lean on.
#
# The value token is a constant: unlike the memo, nothing here is ever READ BACK
# as a reading, so the file carries a timestamp and nothing else. Reusing
# `quota_stamped_read` gets the epoch handling -- separator, leading zero, 64-bit
# length bound, future stamp -- that every bug in this shape has lived in.
quota_shadow_probe() {  # $1 = the source the guard actually used, for the log line
  # EXPLICIT disable check, not left to the age comparison. Via `quota_stamped_read
  # $file 0` alone the first call finds no stamp at all, polls, and only then writes
  # one -- so `=0` would still cost a poll per fire. Same trap the source-2 memo
  # carries a `-gt 0` for (case 38b); case 29e pins the zero here.
  [ "$QUOTA_SHADOW_MIN_INTERVAL" -gt 0 ] || return 0
  [ -n "$(quota_stamped_read "$QUOTA_SHADOW_STAMP" "$QUOTA_SHADOW_MIN_INTERVAL")" ] && return 0
  # STAMPED BEFORE THE POLL, so the window opens on the ATTEMPT and closes whatever
  # the attempt does -- succeed, fail, or die mid-curl. Rationale is stated once, in
  # the header block above; case 29d pins it.
  #
  # AND NO STAMP MEANS NO POLL. Every other writer in this file can afford `|| true`
  # because a lost write fails SAFE: no cache entry means the guard takes the blind
  # path, no memo means source 2 is re-read. Here it fails the wrong way -- an
  # unwritable `$INFRA` (full disk, bad perms) leaves `quota_stamped_read` returning
  # empty forever, so the throttle is silently gone and the probe polls on EVERY
  # `quota_pct` call. A diagnostic that cannot record when it last ran has no
  # business running: skip, say so, and let the next call try again. Case 29g pins
  # it. Since #806 the write is atomic (temp + rename), so there is no truncation
  # window that could leave a partial stamp behind for a racing reader -- and
  # `quota_stamped_write`'s contract is that a 0 return means a record the shared
  # reader will ACCEPT, which is what this branch actually needs to distinguish.
  #
  # NOTE the permission dependency this moved: a rename needs write on the
  # DIRECTORY, where `>` needed write on the FILE. So a read-only $INFRA holding
  # a writable stamp now skips (it did not before), and a writable $INFRA holding
  # an immutable stamp now succeeds (it did not before). Both directions still
  # end somewhere safe -- skip, or a fresh readable stamp -- and case 45f pins
  # the first, which is the one that changed toward refusing.
  if ! quota_stamped_write "$QUOTA_SHADOW_STAMP" probe; then
    log "quota shadow: skipped -- rate stamp $QUOTA_SHADOW_STAMP is unwritable (#765)"
    return 0
  fi
  qsp_pct="$(quota_read_url "$STUDIO_QUOTA_URL")"
  if [ -n "$qsp_pct" ]; then
    log "quota shadow: studio ${qsp_pct}% (diagnostic only -- the guard used $1; #765 C3 evidence)"
  else
    # UNREADABLE is logged, never skipped: "studio was asked and could not answer"
    # is the measurement, and a silent skip would be indistinguishable from the
    # probe not running -- which is the blind spot the whole ticket is about.
    log "quota shadow: studio UNREADABLE (diagnostic only -- the guard used $1; #765 C3 evidence)"
  fi
  return 0
}

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
# Both are ADVISORY. They log and they decide nothing -- same posture as
# `quota_shadow_probe`. A stale driver is a real problem but it is the
# OPERATOR's to fix (see the deliberate non-goal below), and a plane that is
# temporarily AHEAD of main is a normal state during a deploy, not a fault.
#
# DELIBERATE NON-GOAL: the driver does not re-`exec` itself to adopt new code.
# Cross-fire state -- `fires`, `stall`, `blind_fires`, `budget_regrants` -- lives
# in shell variables, so an exec would silently reset the counters that bound
# MAX_STALL and MAX_BUDGET_REGRANTS. Trading a visible staleness for an invisible
# fail-open in the spend/stall guards is a bad trade. Self-adoption needs that
# state persisted first (#811); until then, report and let a human restart.

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
    log "driver code: STALE -- $DRIVE_SELF changed since this driver booted, so this process is running SUPERSEDED code and every merged loop/ fix is inert until it restarts: launchctl kickstart -k gui/\$(id -u)/com.autonomy.studio-build-driver -- and \`-k\` kills a fire in flight, so restart BETWEEN fires (#808)"
  fi
  return 0
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
  if ! git -C "$REPO" fetch --quiet origin main 2>/dev/null; then
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

# --- drift_report: both halves, once per loop iteration. Advisory; always 0.
# Named for the pair, not for either half -- the driver-code half is the
# load-bearing one and is not plane drift at all.
drift_report() {
  # ONLY the documented value disables. `= "1"` would have let `DRIFT_REPORT=no`
  # or `=true` silence the whole thing without a word, and a monitor a typo can
  # switch off invisibly fails in the direction it is monitoring.
  [ "$DRIFT_REPORT" = "0" ] && return 0
  drift_report_driver_code
  drift_report_plane
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
quota_knob_secs() {  # $1=name $2=value $3=default $4=ceiling (0 = none)
  qk_v="$2"
  case "$qk_v" in ""|*[!0-9]*) qk_v="" ;; esac
  # 9 digits is ~31 years in seconds. Past that it is a typo, and it is also where
  # `test` starts approaching the signed-64 range that already burned this file once.
  [ "${#qk_v}" -gt 9 ] && qk_v=""
  if [ -z "$qk_v" ]; then
    log "WARN: $1='$2' is not a usable number of seconds -- using the default $3 instead (an unparseable bound makes every stamped record look fresh, which is the one polarity this guard may not have)"
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
prev_head=""

# Normalised HERE and not at declaration, because complaining needs `log` and the log
# directory. Nothing reads a quota before the loop below, so this is in time.
QUOTA_POLL_MIN_INTERVAL="$(quota_knob_secs QUOTA_POLL_MIN_INTERVAL "$QUOTA_POLL_MIN_INTERVAL" 60 300)"
QUOTA_CACHE_MAX_AGE="$(quota_knob_secs QUOTA_CACHE_MAX_AGE "$QUOTA_CACHE_MAX_AGE" 86400 0)"
# No CEILING for the shadow interval, and the reason is the opposite of the poll
# memo's. That one bounds how stale a reading may be when it PERMITS a fire, so an
# over-wide value is a fail-open and is clamped. The shadow never feeds the guard
# at all: a wide value buys LESS load and LESS evidence, which is merely useless,
# never unsafe. It is normalised anyway so an unparseable knob is announced rather
# than silently making every stamp look fresh (i.e. the probe quietly never running).
QUOTA_SHADOW_MIN_INTERVAL="$(quota_knob_secs QUOTA_SHADOW_MIN_INTERVAL "$QUOTA_SHADOW_MIN_INTERVAL" 3600 0)"

log "=== DRIVER START (repo=$REPO -- MAX_FIRES=$MAX_FIRES, QUOTA_STOP_PCT=$QUOTA_STOP_PCT%; stop on operator/nothing-to-do/quota; backoff on limits) ==="

# #808. Taken HERE, as early below the guard as the log allows, because it is the
# only moment at which "the file on disk" and "the code this process is running"
# are known to be the same thing. Every later comparison is against this.
DRIVE_BOOT_HASH="$(drive_self_hash)"
[ -n "$DRIVE_BOOT_HASH" ] || log "WARN: could not hash $DRIVE_SELF at start -- the driver-code drift check will read UNKNOWN for this whole run (#808)"

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
