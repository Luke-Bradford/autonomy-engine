#!/bin/bash
# test_quota_guard.sh -- drives the REAL drive.sh with PATH stubs so the quota
# guard + fire cap are exercised for real (no assertions on mocks: run.sh is
# stubbed to record that it was CALLED, and every assertion is about whether the
# driver fired or refused). Costs zero tokens: `claude`, `gh`, `git` and `curl`
# are all shims.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
fails=0
check() { # $1=label $2=expected $3=actual
  if [ "$2" = "$3" ]; then echo "ok   - $1"
  else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails + 1)); fi
}

# One scenario: $1=utilization-json-or-EMPTY  $2=extra env  -> echoes fire count
run_case() {
  rc_util="$1"; shift
  tmp="$(mktemp -d)"; bin="$tmp/bin"; mkdir -p "$bin"
  # --- stubs -----------------------------------------------------------------
  # No operator signals. GH_OPEN_PR=1 puts an open PR in front of the driver so
  # the gate-wait path is reachable; `pr checks` then always reports pending, so
  # the driver waits its full GATE_WAIT_TRIES.
  cat >"$bin/gh" <<'EOS'
#!/bin/bash
case "$*" in
  *"pr list"*length*)  [ -n "${GH_OPEN_PR:-}" ] && echo 1 || echo 0 ;;
  *"pr list"*)         [ -n "${GH_OPEN_PR:-}" ] && echo 7 || echo "" ;;
  *"pr checks"*)       echo 1 ;;
  *"issue list"*)      echo "0" ;;
  *) echo "" ;;
esac
EOS
  cat >"$bin/git" <<'EOS'
#!/bin/bash
case "$1" in
  fetch) exit 0 ;;
  rev-parse) echo "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef$RANDOM" ;;  # always "progress"
  *) exit 0 ;;
esac
EOS
  # curl now serves BOTH HTTP quota sources and dispatches on the URL, because
  # the guard reads the dashboard first and studio last (the loop reader in
  # between is a python call, not a URL, and is stubbed via FALLBACK_UTIL for a
  # reading or FALLBACK_UNREADABLE for a present-but-failing one). The studio arm is written
  # FIRST and returns early, so the dashboard arm below keeps its call counter
  # and knobs byte-for-byte -- the pre-existing cases are unaffected by studio
  # being added.
  #
  # Studio defaults to UNREADABLE, and that default is load-bearing: it is the
  # dashboard-unreadable cases that reach studio at all, and a studio which
  # answered by default would turn every one of them into a test of the readable
  # path instead -- green, and proving nothing. STUDIO_UTIL=<fraction> is the
  # opt-in for a readable studio.
  #
  # The unreadable body is studio's REAL failure shape: a well-formed HTTP 200
  # carrying `claude: null`, not the empty/truncated body the dashboard fails
  # with. Both parse to "" through the same parser, which is the point -- the
  # test exists so that stays true.
  cat >"$bin/curl" <<'EOS'
#!/bin/bash
case "$*" in
  */api/quota*)
    # Marker: records that studio was POLLED, independently of whether it won.
    # The source log line names only the winning source, so it cannot
    # distinguish "studio was never asked" from "studio was asked and lost" --
    # and "never asked" is the entire justification for the read order.
    : >"${STUDIO_POLL_MARKER:-/dev/null}"
    if [ -n "${STUDIO_UTIL:-}" ]; then
      echo '{"account":{"claude":{"seven_day":{"utilization":'"$STUDIO_UTIL"'}}}}'
    else
      echo '{"account":{"claude":null}}'
    fi
    exit 0 ;;
esac
EOS
  # --- the dashboard (/api/state) arm: EMPTY utilization => unreadable path.
  # CURL_READABLE_CALLS=N makes it readable for the first N calls and unreadable
  # after, so "the dashboard died PART WAY THROUGH a run" is reachable. The
  # counter counts DASHBOARD calls only (studio returns above without touching
  # it), so CURL_READABLE_CALLS/CURL_SWITCH_CALLS keep their exact meaning.
  if [ "$rc_util" = "EMPTY" ]; then
    printf 'echo ""\n' >>"$bin/curl"
  else
    cat >>"$bin/curl" <<EOS
ccf="$tmp/curlcalls"
cc="\$(cat "\$ccf" 2>/dev/null || echo 0)"
echo \$((cc + 1)) >"\$ccf"
if [ -n "\${CURL_READABLE_CALLS:-}" ] && [ "\$cc" -ge "\$CURL_READABLE_CALLS" ]; then
  echo ""; exit 0
fi
# CURL_UTIL_AFTER + CURL_SWITCH_CALLS: the window CHANGES mid-run, which is what
# a long block looks like from the outside.
if [ -n "\${CURL_UTIL_AFTER:-}" ] && [ "\$cc" -ge "\${CURL_SWITCH_CALLS:-1}" ]; then
  echo '{"account":{"claude":{"seven_day":{"utilization":'"\$CURL_UTIL_AFTER"'}}}}'; exit 0
fi
echo '{"account":{"claude":{"seven_day":{"utilization":$rc_util}}}}'
EOS
  fi
  # claude: the auth probe, on a FAIL SCHEDULE so auth blocks are reproducible.
  # AUTHFAIL_N failures per block, for AUTHFAIL_BLOCKS blocks, each block ended by
  # exactly one success; then always OK. Defaults (N=0) => always OK, so every
  # pre-existing case is unaffected.
  cat >"$bin/claude" <<EOS
#!/bin/bash
n="\${AUTHFAIL_N:-0}"; blocks="\${AUTHFAIL_BLOCKS:-1}"
cf="$tmp/authcalls"
c="\$(cat "\$cf" 2>/dev/null || echo 0)"
echo \$((c + 1)) >"\$cf"
if [ "\$n" -gt 0 ]; then
  period=\$((n + 1))
  if [ \$((c / period)) -lt "\$blocks" ] && [ \$((c % period)) -lt "\$n" ]; then
    echo '{"is_error":true,"result":"AUTH_FAIL"}'; exit 1
  fi
fi
echo '{"is_error":false,"result":"AUTH_OK"}'
EOS
  # python3 must stay REAL (the guard parses JSON with it)
  ln -s "$(command -v python3)" "$bin/python3" 2>/dev/null || true
  # `security` is stubbed to FAIL, which is the last line of hermeticity. python3
  # is real by necessity, so if the reader path ever resolves to a real
  # `claude_usage.py` instead of the fake, that module would read the operator's
  # OAuth token from the live Keychain and poll the real rate-limited endpoint --
  # spending from the very budget these tests exist to protect, on every case.
  # That is not hypothetical: it happened while writing #764, when removing the
  # old `ENGINE_LIB=$tmp/nonexistent-lib` override let drive.sh's absolute default
  # resolve to the real engine lib mid-refactor. A failing token read makes the
  # reader return None before any HTTP, so the suite stays offline even if the
  # path plumbing regresses. Stubbing EVERY external command is the rule here.
  printf '#!/bin/bash\nexit 1\n' >"$bin/security"
  chmod +x "$bin"/*
  # run.sh stub: one line per fire, so the count is the observable
  mkdir -p "$tmp/infra/logs"
  # Optional SEED_CACHE=<epoch> <pct> pre-seeds the last-known-quota cache, so the
  # "unreadable but we remember 98%" path is reachable without a clock stub.
  for rc_a in "$@"; do
    case "$rc_a" in SEED_CACHE=*) printf '%s\n' "${rc_a#SEED_CACHE=}" >"$tmp/infra/.last_quota" ;; esac
  done
  # Optional FALLBACK_UTIL=<percent> stands up a fake `claude_usage.py` beside the
  # driver, implementing the REAL module's contract (#764): a CLI that prints the
  # integer 7-day utilization PERCENT on stdout and exits 0, or prints NOTHING and
  # exits 1.
  #
  # The UNIT here is a percent, not the 0-1 fraction this knob used to take. The
  # relocated reader talks to the upstream endpoint directly, and upstream reports
  # `utilization` as a PERCENT; only the two HTTP sources divide by 100 for their
  # wire format, which is why `quota_read_url` multiplies it back. A fraction
  # arriving here would round to 0 -- a fail-open reading -- so the fake speaks
  # the real unit and the cases below assert the value survives unscaled.
  #
  # Shaped so the OLD two-call `refresh_live_quota()`/`live_quota()` module shape
  # CANNOT satisfy it: this is a script with no importable reader function at all.
  # That mirrors the care the previous stub took for the same reason -- a stub a
  # broken caller can still satisfy lets the break look correct (#766).
  for rc_a in "$@"; do
    case "$rc_a" in
      FALLBACK_UTIL=*)
        cat >"$tmp/infra/claude_usage.py" <<EOS
import sys
print(${rc_a#FALLBACK_UTIL=})
sys.exit(0)
EOS
        ;;
      FALLBACK_UNREADABLE=1)
        # The real module's failure shape: nothing on stdout, non-zero exit. A
        # reader that printed 0 here would silently disarm the guard, so the
        # distinction has to be exercisable.
        cat >"$tmp/infra/claude_usage.py" <<'EOS'
import sys
sys.stderr.write("claude_usage: 7-day utilization unreadable\n")
sys.exit(1)
EOS
        ;;
    esac
  done
  printf '#!/bin/bash\necho fired >>"%s/fires.txt"\nexit 0\n' "$tmp" >"$tmp/infra/run.sh"
  chmod +x "$tmp/infra/run.sh"
  cp "$HERE/drive.sh" "$tmp/infra/drive.sh"

  # FRESH_LOGDIR=1 points DLOG at a directory that does NOT exist, which is what
  # a first run under a new INFRA looks like (the README's cutover procedure).
  rc_dlog="$tmp/driver.log"
  case " $* " in *" FRESH_LOGDIR=1 "*) rm -rf "$tmp/infra/logs"; rc_dlog="$tmp/infra/logs/driver.log" ;; esac

  # `env` is REQUIRED: a var=value word arriving via "$@" is NOT parsed as an
  # assignment (assignments are recognised before expansion), so writing
  # `... "$@" bash drive.sh` would execute `QUOTA_STOP_PCT=80` as the COMMAND.
  # NOTE `LOOP_LIB` is deliberately NOT passed. The fake reader is written to
  # `$tmp/infra/`, which is also where drive.sh is copied and what INFRA points
  # at — so these cases exercise the PRODUCTION default (`LOOP_LIB=$INFRA`, the
  # reader shipping beside the driver) rather than a test-only override. #764
  # relocated that reader out of the engine's `lib/`, which cutover C3 parks; a
  # test that pointed at some other directory would not notice if the default
  # broke. Cases that do NOT set FALLBACK_UTIL write no reader at all, so they
  # still exercise "no fallback available".
  env PATH="$bin:$PATH" INFRA="$tmp/infra" REPO="$tmp" DLOG="$rc_dlog" \
    STUDIO_POLL_MARKER="$tmp/studio_polled" \
    BACKOFF_BASE=0 MAX_LOOPS=12 GATE_WAIT_TRIES=1 \
    AUTH_TRIES=1 "$@" bash "$tmp/infra/drive.sh" >/dev/null 2>&1
  n=0; [ -f "$tmp/fires.txt" ] && n="$(wc -l <"$tmp/fires.txt" | tr -d ' ')"
  # count|logpath -- the caller cannot see assignments made in this subshell.
  echo "$n|$rc_dlog"
}
fires_of()  { echo "${1%%|*}"; }
logof()     { echo "${1##*|}"; }

# --- 1. over the threshold: refuse to fire AT ALL ----------------------------
r="$(run_case 0.97 QUOTA_STOP_PCT=80)"
check "97% util >= 80% stop-pct -> zero fires" "0" "$(fires_of "$r")"
check "97% logs the quota STOP reason" "0" \
  "$(grep -q 'STOP: 7-day quota utilization 97%' "$(logof "$r")" && echo 0 || echo 1)"

# --- 2. under the threshold: fires, but bounded by MAX_FIRES ------------------
r="$(run_case 0.10 QUOTA_STOP_PCT=80 MAX_FIRES=3)"
check "10% util with MAX_FIRES=3 -> exactly 3 fires" "3" "$(fires_of "$r")"
check "fire cap logs its own STOP reason" "0" \
  "$(grep -q 'STOP: MAX_FIRES=3 reached' "$(logof "$r")" && echo 0 || echo 1)"

# --- 2b. the DEFAULT is UNCAPPED (operator, 2026-07-29) ----------------------
# MAX_FIRES defaulted to 6, which ended a run while the weekly window still had
# room. The operator removed the cap and kept QUOTA_STOP_PCT as the sole spend
# bound. Asserted on the DEFAULT (no MAX_FIRES passed), because the previous
# default was load-bearing and nothing pinned it -- MAX_LOOPS caps this run at
# 12 iterations, so 12 fires means "no fire cap intervened".
r="$(run_case 0.10 QUOTA_STOP_PCT=80)"
check "default is uncapped -> fires every iteration (12), not 6" "12" "$(fires_of "$r")"
check "no fire-cap STOP is logged by default" "1" \
  "$(grep -q 'STOP: MAX_FIRES' "$(logof "$r")" && echo 0 || echo 1)"

# --- 3. boundary: exactly AT the stop pct refuses (>=, not >) -----------------
r="$(run_case 0.80 QUOTA_STOP_PCT=80)"
check "exactly 80% refuses (boundary is >=)" "0" "$(fires_of "$r")"

# --- 3b. just BELOW the boundary still fires (proves the guard is not blanket) -
r="$(run_case 0.79 QUOTA_STOP_PCT=80 MAX_FIRES=1)"
check "79% still fires (guard is a threshold, not a block)" "1" "$(fires_of "$r")"

# --- 4. unreadable quota: bounded blind fires, then stop ---------------------
r="$(run_case EMPTY QUOTA_UNKNOWN_FIRES=2 MAX_FIRES=0)"
check "unreadable util -> exactly QUOTA_UNKNOWN_FIRES=2 blind fires" "2" "$(fires_of "$r")"
check "unreadable util logs the blind-fire WARN" "0" \
  "$(grep -q 'UNREADABLE' "$(logof "$r")" && echo 0 || echo 1)"

# --- 5. unreadable is NOT treated as 0% (the conflation bug) -----------------
r="$(run_case EMPTY QUOTA_UNKNOWN_FIRES=0 MAX_FIRES=0)"
check "unreadable with 0 blind fires allowed -> zero fires" "0" "$(fires_of "$r")"

# --- 6. a LONG auth/limit block RE-GRANTS the fire budget --------------------
# The 2026-07-26..29 incident: one fire, then a 71h auth/limit block, then the
# driver stopped at MAX_FIRES with the quota window at 3%. The budget was sized
# against a quota window the block outlived, so a long block re-grants it ONCE.
# Schedule: block(6 fails) -> fire 1 -> block(6 fails) -> re-grant -> 2 more.
r="$(run_case 0.10 QUOTA_STOP_PCT=80 MAX_FIRES=2 AUTH_TRIES=0 AUTHFAIL_N=6 AUTHFAIL_BLOCKS=2)"
check "long auth block re-grants the budget -> 3 fires, not 2" "3" "$(fires_of "$r")"
check "the re-grant states itself in the log" "0" \
  "$(grep -q 'fire budget RE-GRANT' "$(logof "$r")" && echo 0 || echo 1)"

# --- 7. a SHORT auth blip does NOT re-grant (transient != window moved on) ----
r="$(run_case 0.10 QUOTA_STOP_PCT=80 MAX_FIRES=2 AUTH_TRIES=0 AUTHFAIL_N=2 AUTHFAIL_BLOCKS=2)"
check "short auth blip does NOT re-grant -> exactly 2 fires" "2" "$(fires_of "$r")"
check "short blip logs no re-grant" "1" \
  "$(grep -q 'fire budget RE-GRANT' "$(logof "$r")" && echo 0 || echo 1)"

# --- 8. the re-grant is BOUNDED -- flapping auth cannot uncap the driver ------
# Three long blocks, one re-grant allowed: the third block must NOT buy a budget.
r="$(run_case 0.10 QUOTA_STOP_PCT=80 MAX_FIRES=2 AUTH_TRIES=0 AUTHFAIL_N=6 AUTHFAIL_BLOCKS=3)"
check "3 long blocks, 1 re-grant allowed -> 3 fires (bound holds)" "3" "$(fires_of "$r")"
r="$(run_case 0.10 QUOTA_STOP_PCT=80 MAX_FIRES=2 AUTH_TRIES=0 AUTHFAIL_N=6 AUTHFAIL_BLOCKS=3 MAX_BUDGET_REGRANTS=2)"
check "same schedule, 2 re-grants allowed -> 4 fires (bound is the cause)" "4" "$(fires_of "$r")"

# --- 9. UNREADABLE + a fresh last-known reading OVER the stop pct -> refuse ---
# The 2026-07-26 blind-fire incident: both quota sources failed while the account
# was at ~98%, so the 80% guard had no number and the driver fired blind ($24,
# hit the cap, shipped nothing). Usage inside a window only RISES, so a recent
# high reading is evidence the window is still exhausted.
now="$(date +%s)"
r="$(run_case EMPTY QUOTA_UNKNOWN_FIRES=2 MAX_FIRES=0 "SEED_CACHE=$now 98")"
check "unreadable + fresh cached 98% -> zero fires (no blind fire)" "0" "$(fires_of "$r")"
check "unreadable + cached 98% names the cache as its reason" "0" \
  "$(grep -q 'last known reading was 98%' "$(logof "$r")" && echo 0 || echo 1)"

# --- 10. the cache is trusted in ONE direction only --------------------------
# A cached LOW reading proves nothing about now (fires may have run since), so it
# must NOT unlock anything -- the blind allowance still bounds it exactly as before.
r="$(run_case EMPTY QUOTA_UNKNOWN_FIRES=2 MAX_FIRES=0 "SEED_CACHE=$now 10")"
check "unreadable + fresh cached 10% -> still bounded blind fires" "2" "$(fires_of "$r")"

# --- 11. a STALE cached reading is not evidence about now --------------------
r="$(run_case EMPTY QUOTA_UNKNOWN_FIRES=2 MAX_FIRES=0 "SEED_CACHE=$((now - 200000)) 98")"
check "unreadable + STALE cached 98% -> ignored, blind fires as before" "2" "$(fires_of "$r")"

# --- 12. a readable quota WRITES the cache (or none of the above can engage) --
r="$(run_case 0.42 QUOTA_STOP_PCT=80 MAX_FIRES=1)"
check "a successful quota read caches the value" "42" \
  "$(cut -d' ' -f2 "$(dirname "$(logof "$r")")/infra/.last_quota" 2>/dev/null || echo MISSING)"

# --- 13. a long block re-reads quota, so the operator sees the REAL cause -----
# 71h of "auth probe FAILED" logs while the true cause was the weekly cap.
r="$(run_case 0.10 QUOTA_STOP_PCT=80 MAX_FIRES=1 AUTH_TRIES=0 AUTHFAIL_N=6 AUTHFAIL_BLOCKS=1)"
check "a long auth block reports quota alongside the auth failures" "0" \
  "$(grep -q 'quota during auth block' "$(logof "$r")" && echo 0 || echo 1)"

# --- 14. a leading-zero cached epoch is decimal, not octal (review WARNING) ---
# `$(( ))` reads 018 as octal and dies; `test` does NOT (verified: [ 098 -ge 80 ]
# is true), so only the epoch field is exposed. Degradation was graceful (the
# subshell died, the value read empty, the blind path ran) but noisy and wrong.
r="$(run_case EMPTY QUOTA_UNKNOWN_FIRES=2 MAX_FIRES=0 "SEED_CACHE=0$now 98")"
check "leading-zero cached epoch is read as decimal -> still refuses" "0" "$(fires_of "$r")"

# --- 15. blind fires are counted SEPARATELY from readable ones (WARNING) ------
# The cap read the CUMULATIVE fire count, so a run that had already done
# QUOTA_UNKNOWN_FIRES readable fires stopped on the FIRST unreadable reading with
# none of the documented grace. Dashboard dies after 2 readable fires here.
r="$(run_case 0.10 QUOTA_STOP_PCT=80 MAX_FIRES=0 QUOTA_UNKNOWN_FIRES=2 CURL_READABLE_CALLS=2)"
check "2 readable fires then unreadable -> 2 readable + 2 blind = 4" "4" "$(fires_of "$r")"

# --- 16. the driver creates its own log directory (WARNING) ------------------
# Only run.sh mkdir'd it, and only per fire -- so a first run under a new INFRA
# (exactly the README's cutover) silently lost DRIVER START and every FATAL.
r="$(run_case 0.10 QUOTA_STOP_PCT=80 MAX_FIRES=1 FRESH_LOGDIR=1)"
check "a missing log dir is created, not silently swallowed" "0" \
  "$(grep -q 'DRIVER START' "$(logof "$r")" 2>/dev/null && echo 0 || echo 1)"

# --- 18. a block ON the budget boundary still re-grants (review round 3) -----
# The fire cap was checked BEFORE ensure_auth, so once fires hit MAX_FIRES the
# loop broke without ever probing auth again -- and a block starting on the LAST
# budgeted fire could never reach the re-grant. Behaviour depended on whether the
# block landed one fire early or exactly on the boundary, which is arbitrary.
# MAX_FIRES=1, so block 2 lands precisely at fires == MAX_FIRES.
r="$(run_case 0.10 QUOTA_STOP_PCT=80 MAX_FIRES=1 AUTH_TRIES=0 AUTHFAIL_N=6 AUTHFAIL_BLOCKS=2)"
check "a long block AT the budget boundary re-grants -> 2 fires, not 1" "2" "$(fires_of "$r")"

# --- 19. quota is RE-CHECKED after a block (review round 4, BLOCKING) --------
# The guard ran once per iteration, BEFORE ensure_auth -- which can block for
# days (measured: 71h). So the fire straight after recovery was authorised by a
# reading taken before the entire block. Worse, a block is frequently CAUSED by
# quota exhaustion (a cap and an expired token look identical to the probe), so
# the re-grant case is exactly the one most likely to fire into a window that has
# since changed. Here it is 10% before the block and 97% after.
r="$(run_case 0.10 QUOTA_STOP_PCT=80 MAX_FIRES=5 AUTH_TRIES=0 AUTHFAIL_N=6 AUTHFAIL_BLOCKS=1 CURL_UTIL_AFTER=0.97 CURL_SWITCH_CALLS=1)"
check "quota re-checked after a block -> refuses, does not fire on a stale read" "0" "$(fires_of "$r")"
check "the post-block re-check states why" "0" \
  "$(grep -q 'stale' "$(logof "$r")" && echo 0 || echo 1)"

# --- 20. a cache line with no separator is malformed, not two fields ---------
# `${qc_line%% *}` and `${qc_line##* }` BOTH degrade to the whole string when
# there is no space, so a single-token line was read as epoch AND pct. A lone
# recent epoch therefore parsed as a colossal "percent" and refused every fire.
r="$(run_case EMPTY QUOTA_UNKNOWN_FIRES=2 MAX_FIRES=0 "SEED_CACHE=$now")"
check "single-field cache line is rejected, not read as epoch+pct" "2" "$(fires_of "$r")"

# --- 21. the blind allowance is spent per FIRE, not per gate call (round 5) --
# quota_gate runs up to TWICE an iteration (pre-auth, and again after a block).
# Incrementing inside it charged two units of QUOTA_UNKNOWN_FIRES for ONE fire,
# halving the grace exactly when a monitoring hiccup coincides with an auth blip
# -- the correlated case the allowance exists to cover. AUTHFAIL_N=1 is a SHORT
# blip on purpose: no re-grant, just enough to trigger the second gate call.
r="$(run_case EMPTY QUOTA_UNKNOWN_FIRES=2 MAX_FIRES=0 AUTH_TRIES=0 AUTHFAIL_N=1 AUTHFAIL_BLOCKS=3)"
check "unreadable + auth blip -> 2 blind fires, not 1 (one charge per fire)" "2" "$(fires_of "$r")"

# --- 22. quota is RE-CHECKED after a PR-GATE WAIT (review round 7) -----------
# Same staleness class as round 4, shorter window but routinely exercised: the
# gate wait is up to GATE_WAIT_TRIES x 30s = 30 min and runs on EVERY iteration
# with an open PR, sitting after the last quota_gate and before the fire. The
# operator's own sessions can move the window during it -- which is exactly the
# headroom the guard protects. 10% before the wait, 97% after.
r="$(run_case 0.10 QUOTA_STOP_PCT=80 MAX_FIRES=5 GH_OPEN_PR=1 GATE_WAIT_TRIES=1 GATE_WAIT_SLEEP=0 CURL_UTIL_AFTER=0.97 CURL_SWITCH_CALLS=1)"
check "quota re-checked after a gate wait -> refuses on the fresh reading" "0" "$(fires_of "$r")"

# --- 23. the FALLBACK source actually works (measured dead 2026-07-29) -------
# `quota_pct`'s fallback called `cu.refresh_live_quota()` and read its RETURN
# value. That function is a WRITER — it populates a module cache and returns None
# on every path; the getter is `live_quota()`. So the fallback always yielded ""
# and the guard had ONE source, not two, since the day it was written.
#
# Observed live: at 16:45Z a momentary dashboard blip took the reading straight
# to UNREADABLE and spent a blind fire, with the dashboard answering 200 seconds
# later. It also reframes 2026-07-26, recorded as "both sources failed at once" —
# the fallback was already dead, so one outage was always enough. That one cost
# $24.
#
# Dashboard EMPTY + a working fallback reading 97% must REFUSE, not fire blind.
#
# `STUDIO_UTIL=0.10` makes this run pin SOURCE PRECEDENCE too, at no extra cost.
# README says "do not reorder" and the reason is load-bearing: the loop reader is
# PROVEN (it has returned a number) while studio never has, and studio is polled
# last so it adds no load to the shared upstream rate-limit budget in the common
# case. Nothing asserted it -- swapping the two blocks in `quota_pct` left the
# whole suite green. With studio offering a permissive 10% behind a refusing 97%
# reader, a swap now fails three ways: fires appear, the source label changes, and
# the poll marker shows up.
r="$(run_case EMPTY QUOTA_STOP_PCT=80 MAX_FIRES=0 QUOTA_UNKNOWN_FIRES=2 FALLBACK_UTIL=97 \
      STUDIO_UTIL=0.10)"
check "a working fallback is READ when the dashboard is down" "0" "$(fires_of "$r")"
check "the loop reader OUTRANKS studio (not merely outvoted -- studio is unpolled)" "1" \
  "$([ -f "$(dirname "$(logof "$r")")/studio_polled" ] && echo 0 || echo 1)"
check "the fallback reading drives the STOP, not the blind path" "0" \
  "$(grep -q 'STOP: 7-day quota utilization 97%' "$(logof "$r")" && echo 0 || echo 1)"
# ...and is NAMED as the source (#764). Folded onto this run rather than given its
# own: this case ALREADY is the post-cutover topology -- dashboard EMPTY, reader
# present -- so a separate case would have been a byte-identical second driver run
# for one grep. The label is not cosmetic: `quota source: <name>` is the evidence
# trail that decides when studio can be promoted and the engine retired (#765), and
# nothing asserted the old `engine` label, which is how the rename to `loop` could
# have shipped untested. Also pins the reading as a PERCENT: a x100 slip logs
# 9700%, a /100 slip logs 0% and would fire.
check "the fallback reader is NAMED as the source, unscaled" "0" \
  "$(grep -q 'quota source: loop (7-day utilization 97%)' "$(logof "$r")" && echo 0 || echo 1)"

# --- 24. the fallback also feeds the last-known cache ------------------------
# Both sources must write it (a fix for the same class already landed once, when
# an early `return` skipped caching the PRIMARY reading).
r="$(run_case EMPTY QUOTA_STOP_PCT=80 MAX_FIRES=1 QUOTA_UNKNOWN_FIRES=2 FALLBACK_UTIL=42)"
check "a fallback reading is cached like a primary one" "42" \
  "$(cut -d' ' -f2 "$(dirname "$(logof "$r")")/infra/.last_quota" 2>/dev/null || echo MISSING)"
# Same run, two more properties for free. The percent survives unscaled all the way
# to the log line (the cache assertion above already catches x100 as 4200 and /100
# as 0, but the log is what a human reads), and a PRESENT reader must NOT trip the
# missing-reader WARN -- a warning that fires unconditionally is as useless as one
# that never fires, so both directions are asserted (the other is on case 29).
check "a percent reading reaches the log unscaled" "0" \
  "$(grep -q 'quota ok: 7-day utilization 42%' "$(logof "$r")" && echo 0 || echo 1)"
check "a PRESENT fallback reader logs no missing-reader WARN" "1" \
  "$(grep -q 'quota fallback reader MISSING' "$(logof "$r")" && echo 0 || echo 1)"

# --- 25-30. STUDIO as the THIRD source, behind the fallback (cutover C2) ----
# Cases 25-26 assert on the SOURCE LOG LINE rather than the fire count, because
# for those two the fire count is NOT an observable: a 10% reading fires exactly
# the same number of times whichever source produced it, so a fire-count
# assertion would pass with the second source never wired up at all. Cases 27-30
# do use the fire count and the cache file, and legitimately so -- there the
# behaviour under test (refusing, and the blind-fire bound) IS the fire count.

# 25. the dashboard answers -> studio is NEVER POLLED. This is the property that
# keeps studio free: studio's reader is a DIRECT provider poll sharing one
# rate-limit budget with the dashboard's sampler, so polling it when the
# dashboard already answered would spend the budget that keeps the primary alive.
#
# The marker, not the log line, is what pins this. The log names only the
# WINNING source, so its absence is equally consistent with "studio was polled
# and lost" -- which is precisely the regression this case has to catch, since
# reading both sources unconditionally and preferring the dashboard would look
# identical in the log while doubling upstream load.
r="$(run_case 0.10 QUOTA_STOP_PCT=80 MAX_FIRES=1 STUDIO_UTIL=0.10)"
check "dashboard readable -> the dashboard is named as the source" "0" \
  "$(grep -q 'quota source: dashboard' "$(logof "$r")" && echo 0 || echo 1)"
check "dashboard readable -> studio is never consulted" "1" \
  "$(grep -q 'quota source: studio' "$(logof "$r")" && echo 0 || echo 1)"
check "dashboard readable -> studio is never POLLED (not merely outvoted)" "1" \
  "$([ -f "$(dirname "$(logof "$r")")/studio_polled" ] && echo 0 || echo 1)"

# 26. the dashboard AND the loop reader are down, studio answers -> the
# reading is USED and the run is NOT blind. This is the state C3 creates
# permanently, when sources 1 and 2 are parked with the engine.
r="$(run_case EMPTY QUOTA_STOP_PCT=80 MAX_FIRES=1 STUDIO_UTIL=0.10)"
check "dashboard+loop reader down, studio readable -> studio is named as the source" "0" \
  "$(grep -q 'quota source: studio' "$(logof "$r")" && echo 0 || echo 1)"
check "dashboard+loop reader down, studio readable -> NOT a blind fire" "1" \
  "$(grep -q 'UNREADABLE' "$(logof "$r")" && echo 0 || echo 1)"

# 27. studio can REFUSE, not just permit. A source that could only
# ever say "fine" would be worse than none -- it would launder an unknown into
# permission. 97% reached via studio must stop the driver exactly as via the
# dashboard.
r="$(run_case EMPTY QUOTA_STOP_PCT=80 STUDIO_UTIL=0.97)"
check "studio 97% -> zero fires (the third source can refuse)" "0" "$(fires_of "$r")"
check "studio 97% logs the quota STOP reason" "0" \
  "$(grep -q 'STOP: 7-day quota utilization 97%' "$(logof "$r")" && echo 0 || echo 1)"

# 28. a reading from studio still writes the last-known cache. This is the
# single-exit-point invariant, and the LAST branch is the one most likely to be
# missed: an early `return` once skipped the cache write on one source, leaving
# the cache empty precisely when that source was working.
r="$(run_case EMPTY QUOTA_STOP_PCT=80 MAX_FIRES=1 STUDIO_UTIL=0.42)"
check "a studio reading writes the last-known cache" "42" \
  "$(cut -d' ' -f2 "$(dirname "$(logof "$r")")/infra/.last_quota" 2>/dev/null || echo MISSING)"

# 29. ALL sources unreadable -> still UNREADABLE, and the WARN says so. The
# UNREADABLE-vs-0 distinction is the guard's load-bearing property (0 = wide
# open, "" = blind); adding a source must not create a path where a failure
# becomes a number.
r="$(run_case EMPTY QUOTA_STOP_PCT=80 QUOTA_UNKNOWN_FIRES=2)"
check "all sources down -> exactly QUOTA_UNKNOWN_FIRES=2 blind fires" "2" "$(fires_of "$r")"
check "all sources down -> the WARN names every source" "0" \
  "$(grep -q 'UNREADABLE (dashboard, loop reader and studio all unavailable)' "$(logof "$r")" && echo 0 || echo 1)"
# This case has no reader FILE, which is what a partial sync of the unversioned
# live control plane looks like (`drive.sh` copied without `claude_usage.py`).
# Downstream that is invisible -- a missing reader and a 429'd one both yield "" --
# and that exact silence is how #766 stayed hidden for its entire life. So the
# driver says so at startup. Folded here because this run already has no reader.
check "a missing fallback reader logs a WARN naming the file" "0" \
  "$(grep -q 'WARN: quota fallback reader MISSING at .*/claude_usage.py' "$(logof "$r")" && echo 0 || echo 1)"

# 30. an ALL-DIGIT but out-of-range reading is UNREADABLE, not a fire. Digits
# alone are not enough to make a value safe for `test`: on bash 3.2
# `[ 10000000000000000000 -ge 80 ]` errors with rc=2, which is NEITHER branch --
# the `if` takes the else, logs "quota ok" and FIRES, uncapped, while claiming
# the window is fine. `utilization: 1e19` reaches the guard as 10^21, i.e. 22
# digits, which is why the guard bounds LENGTH and not just the character class.
# QUOTA_UNKNOWN_FIRES=0 makes the distinction observable: unreadable => refuse.
r="$(run_case 1e19 QUOTA_STOP_PCT=80 QUOTA_UNKNOWN_FIRES=0)"
check "an out-of-range all-digit reading -> zero fires (not fail-open)" "0" "$(fires_of "$r")"
check "an out-of-range reading is treated as UNREADABLE, never as 'quota ok'" "1" \
  "$(grep -q 'quota ok' "$(logof "$r")" && echo 0 || echo 1)"

# --- 31. the POST-CUTOVER pair: a reader that is PRESENT but cannot read ------
# Cutover C3 (#410) parks `bin/ lib/ tests/ templates/ start`, removing the
# DASHBOARD (source 1) and -- until #764 relocated it into `loop/` -- the reader
# (source 2) too, which would have left only studio, the source that has never yet
# returned a number here. The surviving pair is (loop reader, studio).
#
# The pair's other properties are pinned on the runs that already exercise them:
# cases 23-24 ARE this topology (dashboard EMPTY, reader present) and now carry the
# source-label, unscaled-percent and no-spurious-WARN assertions; case 26 covers
# fallthrough-to-studio; case 29 covers all-down plus the missing-reader WARN.
# Re-running those with the same knobs would have cost four extra full driver runs
# in a suite that already takes ~10 minutes (README), for assertions that fit on
# existing ones.
#
# What NO existing case reaches is a reader that EXISTS and FAILS -- the real
# post-C3 failure, a 429 from the shared upstream, as opposed to an absent file.
# The property under test is the one the whole guard rests on: UNREADABLE and 0%
# are DISTINCT outcomes (#440). 0% means wide open and PERMITS a fire; a reader
# that answered "0" on failure would silently disarm the guard. Mutation-checked:
# making the failing reader print `0` flips both assertions below.
r="$(run_case EMPTY QUOTA_STOP_PCT=80 QUOTA_UNKNOWN_FIRES=0 FALLBACK_UNREADABLE=1)"
check "a present-but-failing reader -> refuses to fire blind" "0" "$(fires_of "$r")"
check "a present-but-failing reader is never read as a 0% reading" "1" \
  "$(grep -q 'utilization 0%' "$(logof "$r")" && echo 0 || echo 1)"
# ...and the failing reader does not SWALLOW the fallthrough. Case 26 pins
# fallthrough-to-studio with the reader ABSENT; this pins it for a reader that is
# present and exits non-zero, which is the distinct post-C3 failure. Asserted on
# the POLL MARKER rather than on the source label because studio is unreadable on
# this run too (that is the point of the case) -- so "studio was reached" is only
# observable as the poll having happened at all. Free: same driver run as above.
check "a present-but-failing reader still lets studio be POLLED" "0" \
  "$([ -f "$(dirname "$(logof "$r")")/studio_polled" ] && echo 0 || echo 1)"

# --- 32. the SOURCE-2 boundary is sanitised, not just source 1 ----------------
# Case 30 pins the totality guard for the DASHBOARD (`quota_read_url` calls
# `quota_sane` internally). Source 2 is sanitised by a SEPARATE call --
# `qp_out="$(quota_sane "$qp_out")"` in `quota_pct` -- because the reader is a
# python call, not a URL. Nothing pinned that one: deleting the line left the whole
# suite GREEN, which is the vacuous-coverage shape this repo has shipped twice.
#
# It is a fail-open, and post-C3 it sits on one of only two surviving sources.
# `seven_day_pct` applies no UPPER bound (deliberately -- overage above 100% is the
# strongest stop signal there is), so a malformed or hostile upstream payload of
# 1e19 is printed verbatim. On /bin/bash 3.2.57
# `[ 10000000000000000000 -ge 80 ]` is all digits and STILL errors with rc=2 --
# neither branch -- so the `if` takes the else, logs "quota ok" and FIRES. That is
# the one polarity the guard must never have.
#
# The value is passed as digits, not `1e19`: the stub emits `print(<literal>)`, and
# an int literal prints as digits whereas a float literal would print `1e+19` and
# be rejected by the character class instead of the length bound -- testing a
# different rejection path than the real one.
r="$(run_case EMPTY QUOTA_STOP_PCT=80 QUOTA_UNKNOWN_FIRES=0 \
      FALLBACK_UTIL=10000000000000000000)"
check "an out-of-range reading from the LOOP READER -> zero fires" "0" "$(fires_of "$r")"
check "an out-of-range reader value is UNREADABLE, never 'quota ok'" "1" \
  "$(grep -q 'quota ok' "$(logof "$r")" && echo 0 || echo 1)"

# --- 17. sourcing drive.sh has NO side effects (review round 2) --------------
# The round-1 mkdir fix ran at FILE SCOPE, ~200 lines above the source guard the
# same commit added -- so sourcing the file to unit-test its functions created
# $INFRA/logs/ anyway. The guard is only worth having if nothing outruns it.
# Bounded with a background pid + poll: if the guard ever breaks, the body is an
# unconditional `while true` and a plain `.` would hang this suite forever.
srctmp="$(mktemp -d)"
(
  set -uo pipefail
  # exported because the SOURCED file is what reads them; shellcheck cannot see
  # across the `.` and would otherwise call them unused.
  export INFRA="$srctmp/infra"
  export DLOG="$srctmp/infra/logs/driver.log"
  export QUOTA_CACHE="$srctmp/infra/.last_quota"
  # shellcheck source=/dev/null
  . "$HERE/drive.sh"
) >/dev/null 2>&1 &
src_pid=$!
src_i=0
while [ "$src_i" -lt 10 ]; do kill -0 "$src_pid" 2>/dev/null || break; sleep 1; src_i=$((src_i + 1)); done
if kill -0 "$src_pid" 2>/dev/null; then kill -9 "$src_pid" 2>/dev/null; src_hung=0; else src_hung=1; fi
check "sourcing drive.sh returns instead of running the loop" "1" "$src_hung"
check "sourcing drive.sh creates no directories" "1" \
  "$([ -d "$srctmp/infra/logs" ] && echo 0 || echo 1)"
rm -rf "$srctmp"

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
