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
  # curl serves the dashboard payload; EMPTY utilization => unreadable path.
  # CURL_READABLE_CALLS=N makes it readable for the first N calls and unreadable
  # after, so "the dashboard died PART WAY THROUGH a run" is reachable.
  if [ "$rc_util" = "EMPTY" ]; then
    printf '#!/bin/bash\necho ""\n' >"$bin/curl"
  else
    cat >"$bin/curl" <<EOS
#!/bin/bash
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
  chmod +x "$bin"/*
  # run.sh stub: one line per fire, so the count is the observable
  mkdir -p "$tmp/infra/logs"
  # Optional SEED_CACHE=<epoch> <pct> pre-seeds the last-known-quota cache, so the
  # "unreadable but we remember 98%" path is reachable without a clock stub.
  for rc_a in "$@"; do
    case "$rc_a" in SEED_CACHE=*) printf '%s\n' "${rc_a#SEED_CACHE=}" >"$tmp/infra/.last_quota" ;; esac
  done
  # Optional FALLBACK_UTIL=<0-1> stands up a fake `claude_usage` implementing the
  # REAL module's two-call contract: refresh_live_quota() does the I/O and returns
  # None, live_quota() returns the mapped windows. A stub that returned the value
  # from the refresher would let the driver's broken call LOOK correct, so this
  # deliberately mirrors the real shape.
  for rc_a in "$@"; do
    case "$rc_a" in
      FALLBACK_UTIL=*)
        mkdir -p "$tmp/fallback-lib"
        cat >"$tmp/fallback-lib/claude_usage.py" <<EOS
_cache = {}
def refresh_live_quota(*a, **k):
    _cache['v'] = {'seven_day': {'utilization': ${rc_a#FALLBACK_UTIL=}}, 'source': 'live'}
    return None
def live_quota(*a, **k):
    return _cache.get('v')
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
  # ENGINE_LIB points at the fake `claude_usage` when a case asked for one, and
  # at a path that does not exist otherwise — so every case that does NOT set
  # FALLBACK_UTIL still exercises "no fallback available".
  rc_lib="$tmp/nonexistent-lib"
  [ -f "$tmp/fallback-lib/claude_usage.py" ] && rc_lib="$tmp/fallback-lib"

  env PATH="$bin:$PATH" INFRA="$tmp/infra" REPO="$tmp" DLOG="$rc_dlog" \
    ENGINE_LIB="$rc_lib" BACKOFF_BASE=0 MAX_LOOPS=12 GATE_WAIT_TRIES=1 \
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
r="$(run_case EMPTY QUOTA_STOP_PCT=80 MAX_FIRES=0 QUOTA_UNKNOWN_FIRES=2 FALLBACK_UTIL=0.97)"
check "a working fallback is READ when the dashboard is down" "0" "$(fires_of "$r")"
check "the fallback reading drives the STOP, not the blind path" "0" \
  "$(grep -q 'STOP: 7-day quota utilization 97%' "$(logof "$r")" && echo 0 || echo 1)"

# --- 24. the fallback also feeds the last-known cache ------------------------
# Both sources must write it (a fix for the same class already landed once, when
# an early `return` skipped caching the PRIMARY reading).
r="$(run_case EMPTY QUOTA_STOP_PCT=80 MAX_FIRES=1 QUOTA_UNKNOWN_FIRES=2 FALLBACK_UTIL=0.42)"
check "a fallback reading is cached like a primary one" "42" \
  "$(cut -d' ' -f2 "$(dirname "$(logof "$r")")/infra/.last_quota" 2>/dev/null || echo MISSING)"

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
