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
  # STALL_HEAD=1 pins origin/main so the stall path is reachable; without it every
  # read differs and the driver always sees progress.
  rev-parse)
    if [ -n "${STALL_HEAD:-}" ]; then echo "cafebabecafebabecafebabecafebabecafebabe"
    else echo "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef$RANDOM"; fi ;;
  # BRANCH_AHEAD=<name> reports one local studio branch with commits origin/main
  # does not have — the state triage rule 2 calls "continue it to a PR".
  # BRANCH_AGE_H=<hours> ages its tip commit; the driver ignores branches whose
  # tip is older than AHEAD_MAX_AGE, so an abandoned one cannot mask a real stall.
  for-each-ref)
    if [ -n "${BRANCH_AHEAD:-}" ]; then
      echo "$BRANCH_AHEAD $(( $(date +%s) - (${BRANCH_AGE_H:-0} * 3600) ))"
    fi ;;
  rev-list)     [ -n "${BRANCH_AHEAD:-}" ] && echo 1 || echo 0 ;;
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
  # Both reader stubs APPEND one line to $READER_CALLS per invocation, which makes
  # "how often was source 2 actually POLLED" an observable. It has to be, because
  # #777's whole subject is the POLL RATE: every source-2 property up to now was
  # about the VALUE, so the suite could not distinguish one poll from ten and the
  # throttle would have been untestable (and its absence, which is what #777
  # reported, was likewise invisible).
  #
  # Optional FALLBACK_UTIL_AFTER=<percent> makes the reader answer differently from
  # its SECOND call on, i.e. "the window moved while a fire was running". Mirrors
  # the dashboard arm's CURL_UTIL_AFTER/CURL_SWITCH_CALLS rather than inventing a
  # second idiom; the counter is the call log itself, so there is one piece of
  # state, not two.
  for rc_a in "$@"; do
    case "$rc_a" in
      FALLBACK_UTIL=*)
        cat >"$tmp/infra/claude_usage.py" <<EOS
import os, sys
p = os.environ["READER_CALLS"]
try:
    with open(p) as f:
        n = sum(1 for _ in f)
except IOError:
    n = 0
with open(p, "a") as f:
    f.write("1\n")
after = os.environ.get("FALLBACK_UTIL_AFTER", "")
print(int(after) if after and n >= 1 else ${rc_a#FALLBACK_UTIL=})
sys.exit(0)
EOS
        ;;
      FALLBACK_UNREADABLE=1)
        # The real module's failure shape: nothing on stdout, non-zero exit. A
        # reader that printed 0 here would silently disarm the guard, so the
        # distinction has to be exercisable.
        cat >"$tmp/infra/claude_usage.py" <<'EOS'
import os, sys
with open(os.environ["READER_CALLS"], "a") as f:
    f.write("1\n")
sys.stderr.write("claude_usage: 7-day utilization unreadable\n")
sys.exit(1)
EOS
        ;;
      # Optional SEED_POLL_MEMO=<file contents> pre-seeds the source-2 poll memo
      # (#777), so "a memo that is stale / malformed / from the future" is reachable
      # without a clock stub -- the same trick SEED_CACHE uses for .last_quota.
      SEED_POLL_MEMO=*) printf '%s\n' "${rc_a#SEED_POLL_MEMO=}" >"$tmp/infra/.last_quota_poll" ;;
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
    STUDIO_POLL_MARKER="$tmp/studio_polled" READER_CALLS="$tmp/readercalls" \
    BACKOFF_BASE=0 MAX_LOOPS=12 GATE_WAIT_TRIES=1 \
    AUTH_TRIES=1 "$@" bash "$tmp/infra/drive.sh" >/dev/null 2>&1
  n=0; [ -f "$tmp/fires.txt" ] && n="$(wc -l <"$tmp/fires.txt" | tr -d ' ')"
  # count|logpath|tmpdir -- the caller cannot see assignments made in this subshell.
  # The TMPDIR field exists because deriving it as `dirname $(logof ...)` is only right
  # while DLOG sits at the top of $tmp: under FRESH_LOGDIR=1 it is two levels deeper,
  # so a poll-count assertion written that way would read 0 and pass VACUOUSLY. Found
  # by review before it bit; the accessors below are the only sanctioned way.
  echo "$n|$rc_dlog|$tmp"
}
fires_of()  { echo "${1%%|*}"; }
logof()     { lo_r="${1#*|}"; echo "${lo_r%%|*}"; }
tmpof()     { echo "${1##*|}"; }
# How many times source 2 (the loop's own reader) was actually POLLED in that run.
# $1 = the whole run_case result string (so the tmp dir is read, never inferred).
readerpolls() {
  rp_f="$(tmpof "$1")/readercalls"
  if [ -f "$rp_f" ]; then wc -l <"$rp_f" | tr -d ' '; else echo 0; fi
}

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
  "$(cut -d' ' -f2 "$(tmpof "$r")/infra/.last_quota" 2>/dev/null || echo MISSING)"

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
  "$([ -f "$(tmpof "$r")/studio_polled" ] && echo 0 || echo 1)"
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
  "$(cut -d' ' -f2 "$(tmpof "$r")/infra/.last_quota" 2>/dev/null || echo MISSING)"
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
  "$([ -f "$(tmpof "$r")/studio_polled" ] && echo 0 || echo 1)"

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
  "$(cut -d' ' -f2 "$(tmpof "$r")/infra/.last_quota" 2>/dev/null || echo MISSING)"

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
  "$([ -f "$(tmpof "$r")/studio_polled" ] && echo 0 || echo 1)"

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

# --- 33-34. the SOURCE-2 POLL THROTTLE (#777) --------------------------------
# Source 2 is a fresh `python3` process per call, so it has no in-memory cache and
# nothing gave it a cross-process one. `quota_pct` is called up to three times per
# iteration (pre-auth gate, post-block gate, post-gate-wait gate) plus once per
# AUTH_LONG_BLOCK retry while blocked -- and post-cutover-C3 the dashboard is gone,
# so EVERY one of those becomes a direct poll of a shared, rate-limited upstream
# that 429s under exactly that treatment. The guard could exhaust its own budget
# and then be unable to read the number it exists to read.
#
# ONE run pins BOTH halves of the fix, and they pull in opposite directions -- which
# is why neither is provable alone:
#   * the throttle must REDUCE the polls (33), and
#   * a throttled read must still SERVE the memoised reading (34).
# `QUOTA_UNKNOWN_FIRES=0` is what makes (34) observable: serving "" in-window instead
# of the memo -- which is what #777's own suggested fix said to do -- takes the
# post-block gate blind, and with the blind allowance at 0 the driver STOPs with zero
# fires. So that variant scores 0 fires here and the memo scores 1. Why the memo wins
# that argument is set out ONCE, on `quota_poll_memo_read` in drive.sh -- not
# re-argued here, because a divergence rationale duplicated into a test file is the
# copy that goes stale first (#776 is about exactly that drift).
#
# WHAT THIS DOES NOT PROVE, because the harness sets BACKOFF_BASE=0: in production
# these three reads are NOT adjacent. `ensure_auth` sleeps 30/60/120/240/480/600s
# between retries, so a six-retry block spans ~25 minutes and the in-block read and
# the post-block gate fall well outside a 60s window -- they would cost three polls,
# not one. Only the pre-auth gate and the gate-wait recheck reliably land inside it.
# So this case demonstrates a CEILING on the poll rate (never more than one per
# interval), not a 3-to-1 reduction of the production rate. That distinction is why
# the memo is a bound rather than an optimisation, and the floor is set elsewhere
# anyway: the post-fire clear guarantees at least one real poll per fire (case 39).
#
# The auth block is not decoration: with no block there is exactly ONE gate per
# iteration, so the poll count cannot tell a throttle from its absence. Six failures
# (= AUTH_LONG_BLOCK) give this iteration three quota_pct calls: the pre-auth gate,
# the in-block reading at retry 6, and the post-block re-check.
r="$(run_case EMPTY QUOTA_STOP_PCT=80 MAX_LOOPS=1 QUOTA_UNKNOWN_FIRES=0 FALLBACK_UTIL=10 \
      AUTH_TRIES=0 AUTHFAIL_N=6 AUTHFAIL_BLOCKS=1)"
check "three quota reads in one iteration cost ONE source-2 poll" "1" \
  "$(readerpolls "$r")"
check "a throttled read still SERVES the reading (never a blind fire)" "1" "$(fires_of "$r")"
check "a throttled read is not reported as UNREADABLE" "1" \
  "$(grep -q 'UNREADABLE' "$(logof "$r")" && echo 0 || echo 1)"
# Folded onto this run rather than given its own (it needed byte-identical args): a
# memo HIT must be DISTINGUISHABLE from a live poll in the log. `quota source: loop` is
# the evidence trail that decides when studio can be promoted and the dashboard retired
# (C3); if a memo hit logged the same string, a source-2 death would cost nothing and
# say nothing -- exactly how #766 hid for its whole life. Reads 2 and 3 here are
# memo-served and must say so, while read 1 keeps the live-poll string.
check "a memo hit is logged as its own source, not as a poll" "0" \
  "$(grep -q 'quota source: loop-memo' "$(logof "$r")" && echo 0 || echo 1)"
check "...and the FIRST read still logs the live-poll source string" "0" \
  "$(grep -q 'quota source: loop (7-day utilization 10%)' "$(logof "$r")" && echo 0 || echo 1)"

# --- 38. ...and the reduction above is caused by the THROTTLE, nothing else ---
# The same run with the throttle switched off must poll every time. This is the
# in-suite mutation check for case 33: without it, "1 poll" could be some unrelated
# short-circuit and the assertion would pass with no throttle in the code at all.
r="$(run_case EMPTY QUOTA_STOP_PCT=80 MAX_LOOPS=1 QUOTA_UNKNOWN_FIRES=0 FALLBACK_UTIL=10 \
      AUTH_TRIES=0 AUTHFAIL_N=6 AUTHFAIL_BLOCKS=1 QUOTA_POLL_MIN_INTERVAL=0)"
check "QUOTA_POLL_MIN_INTERVAL=0 disables the throttle -> three polls" "3" \
  "$(readerpolls "$r")"
# ...and case 38a above does NOT pin the explicit `-gt 0` disable check, which is easy
# to believe it does. `auth_ok`'s `sleep 2` puts every read at least a second apart, so
# `[ age -gt 0 ]` rejects the memo on age alone and the case stays green with the check
# deleted (mutation-proved). The same-second memo the check actually exists for is
# never exercised there. THIS is the discriminating case: a memo stamped NOW, so only
# the explicit check can reject it. Removing the check serves a fresh 97% with the
# throttle "disabled" and STOPs -> 0 fires (measured).
r="$(run_case EMPTY QUOTA_STOP_PCT=80 MAX_FIRES=1 QUOTA_UNKNOWN_FIRES=0 FALLBACK_UTIL=10 \
      QUOTA_POLL_MIN_INTERVAL=0 "SEED_POLL_MEMO=$(date +%s) 97")"
check "QUOTA_POLL_MIN_INTERVAL=0 truly disables it, even for a same-second memo" "1" \
  "$(fires_of "$r")"

# 38c. an unparseable interval. This case used to be labelled "over-polls, never
# over-trusts a stale memo" and to claim it pinned the `-gt 0` check's rc=2 behaviour.
# Both were wrong, and measurement is what settled it: since `quota_knob_secs`
# normalises at file scope BEFORE the first read, `QUOTA_POLL_MIN_INTERVAL=abc` IS 60
# and behaves exactly like it -- with a fresh memo it serves it (`quota source:
# loop-memo`, 0 polls), so it does not over-poll at all. The two-hour-old memo it was
# seeded with was rejected on ordinary age, which is why deleting the `-gt 0` check
# left it green. So it now asserts what actually holds and what actually matters: the
# knob is REPLACED by the default and SAID SO, and a stale memo still cannot be served.
r="$(run_case EMPTY QUOTA_STOP_PCT=80 MAX_FIRES=1 QUOTA_UNKNOWN_FIRES=0 FALLBACK_UTIL=10 \
      QUOTA_POLL_MIN_INTERVAL=abc "SEED_POLL_MEMO=$((now - 7200)) 97")"
check "an unparseable interval falls back to the default, so a stale memo is not served" "1" \
  "$(fires_of "$r")"
check "...and the fallback is ANNOUNCED for the poll interval too" "0" \
  "$(grep -q "WARN: QUOTA_POLL_MIN_INTERVAL='abc' is not a usable number" "$(logof "$r")" && echo 0 || echo 1)"

# --- 35. a FAILED poll is memoised too, so a 429 cannot become a storm --------
# The failure mode #777 is about is self-inflicted: the correct response to a 429
# is to poll LESS, so remembering "that failed" is the load-bearing half. Studio
# throttles failed reads for the same reason (#770). A memo written only on success
# leaves the storm intact -- three polls here instead of one.
#
# The fallthrough must survive it: source 2 saying "unreadable from memory" has to
# reach studio exactly as a live failure does, or the throttle would silently delete
# source 3.
r="$(run_case EMPTY QUOTA_STOP_PCT=80 MAX_LOOPS=1 QUOTA_UNKNOWN_FIRES=2 FALLBACK_UNREADABLE=1 \
      AUTH_TRIES=0 AUTHFAIL_N=6 AUTHFAIL_BLOCKS=1)"
check "a FAILED poll is remembered -> one poll, not three" "1" "$(readerpolls "$r")"
# Serving the "-" sentinel verbatim would be WORSE than the fail-opens case 32 pins:
# `[ - -ge 80 ]` is rc=2, so quota_gate logs "quota ok" and fires with gate_blind=0 --
# an UNCHARGED blind fire, invisible to QUOTA_UNKNOWN_FIRES. This run must stay on the
# blind path throughout.
check "a memoised failure never surfaces as a 'quota ok' reading" "1" \
  "$(grep -q 'quota ok' "$(logof "$r")" && echo 0 || echo 1)"

# ...and a memoised failure must be served as UNREADABLE, so source 3 still decides.
# Its own run, seeded with a FRESH "-" memo, because asserting this on the run above
# was vacuous: that run's FIRST read is a live failure which reaches studio anyway
# (case 31's property), so the marker appeared whether or not the MEMOISED failure
# fell through. Mutation-proved here instead.
#
# Serving "-" verbatim is also a fail-OPEN, which is why the studio reading refuses:
# `[ - -ge 80 ]` returns 2 on bash 3.2 -- neither branch -- so `quota_gate` logs
# "quota ok" and FIRES. Correct behaviour STOPs on studio's 97%.
r="$(run_case EMPTY QUOTA_STOP_PCT=80 MAX_LOOPS=1 QUOTA_UNKNOWN_FIRES=2 FALLBACK_UNREADABLE=1 \
      STUDIO_UTIL=0.97 "SEED_POLL_MEMO=$(date +%s) -")"
check "a memoised FAILURE is UNREADABLE, so studio still decides -> refuse" "0" \
  "$(fires_of "$r")"
check "a memoised FAILURE costs no poll at all" "0" "$(readerpolls "$r")"
check "...and studio is NAMED as the source, not the memo" "0" \
  "$(grep -q 'quota source: studio (7-day utilization 97%)' "$(logof "$r")" && echo 0 || echo 1)"

# --- 39. the memo is DROPPED after a fire, so every fire is gated on a FRESH read
# The one real cost of memoising a reading is that a stale LOW figure could permit a
# fire the live figure would refuse, and fires are where the spend actually happens.
# Bounding it by age alone would be an argument; dropping the memo when a fire ends
# makes it structural: within an iteration nothing spends, so the memo can only ever
# serve reads about the SAME fire.
#
# The reader answers 10% first and 97% afterwards -- the window moving during fire 1,
# which is precisely what MAX_FIRES=3 exists to keep spending into. Correct: fire 1,
# memo dropped, fresh poll reads 97, STOP -- one fire. A memo that survived the fire:
# three fires on a reading taken before the first one.
r="$(run_case EMPTY QUOTA_STOP_PCT=80 MAX_FIRES=3 QUOTA_UNKNOWN_FIRES=0 \
      FALLBACK_UTIL=10 FALLBACK_UTIL_AFTER=97)"
check "the memo does not outlive a fire -> the moved window stops fire 2" "1" \
  "$(fires_of "$r")"
check "the post-fire read is a REAL poll, and it refuses" "0" \
  "$(grep -q 'STOP: 7-day quota utilization 97%' "$(logof "$r")" && echo 0 || echo 1)"
# TWO polls, one per iteration: the fire is what makes the second one happen. Asserted
# because "1 fire" alone would also be satisfied by a throttle that never expired and
# a driver that stopped for some unrelated reason.
check "one poll per fire-gated iteration, not one per run" "2" \
  "$(readerpolls "$r")"

# --- 36. an EXPIRED memo is re-polled ----------------------------------------
# A memo is a poll THROTTLE, not the last-known-quota cache: `.last_quota` is
# trusted for 24h in the refuse-only direction, a memo for QUOTA_POLL_MIN_INTERVAL
# in both. Seeded with a refusing 97% at an epoch well outside the window against a
# live reader answering 10%: if age is not checked the run STOPs on a memo from
# another era, which is the "stale-but-plausible reading" fail-open the relocated
# reader deliberately has no grace window for.
r="$(run_case EMPTY QUOTA_STOP_PCT=80 MAX_FIRES=1 QUOTA_UNKNOWN_FIRES=0 FALLBACK_UTIL=10 \
      "SEED_POLL_MEMO=$((now - 7200)) 97")"
check "an expired memo is re-polled, not served" "1" "$(fires_of "$r")"
check "the fresh poll is what reaches the log" "0" \
  "$(grep -q 'quota source: loop (7-day utilization 10%)' "$(logof "$r")" && echo 0 || echo 1)"

# --- 37. a MALFORMED memo is not a reading -----------------------------------
# The memo file is external state on disk, so its parse is a boundary, and it shares
# `quota_stamped_read` with `.last_quota` -- deliberately, because each rejection here
# was a REAL bug in the sibling parser and two copies of that parse would drift.
#
# Each case is set up so that rejecting the memo and serving it give OPPOSITE
# outcomes, which is the only way an assertion here can fail.
#
# The value case is the fail-OPEN one, and its shape is case 32's: on bash 3.2
# `[ abc -ge 80 ]` returns 2, which is NEITHER branch, so `quota_gate`'s `if` takes
# the else, logs "quota ok" and FIRES. So the assertion is inverted from what it
# looks like -- 1 fire is the BUG and 0 is correct, which is why the live reader
# answers a REFUSING 97 here: correct behaviour rejects `abc`, polls, and STOPs.
#
# `$(date +%s)`, not `$now`: this is the one seeded memo that must be FRESH, and
# `$now` is stamped once up at case 9, many driver runs earlier -- so the memo aged
# out of QUOTA_POLL_MIN_INTERVAL and got rejected for the WRONG reason, which made
# this assertion survive deleting `quota_sane` from quota_poll_memo_read. Caught by
# the mutation pass, not by reading it. The cases that seed a deliberately stale or
# future memo are immune to that drift and still use `$now`.
r="$(run_case EMPTY QUOTA_STOP_PCT=80 MAX_FIRES=1 QUOTA_UNKNOWN_FIRES=0 FALLBACK_UTIL=97 \
      "SEED_POLL_MEMO=$(date +%s) abc")"
check "a memo whose value is not a percent is not served" "0" "$(fires_of "$r")"
# ...and the garbage never reaches the log either, which is where the fail-open is
# visible: an unsanitised memo is reported as `utilization abc%` and then compared
# with `-ge`. Asserted as ABSENCE of the value rather than presence of the 97% STOP,
# because that STOP happens on the NEXT iteration anyway once the fire clears the
# memo -- so the obvious assertion was vacuous under the very mutation this pins.
check "an unusable memo value never reaches the log or the >= comparison" "1" \
  "$(grep -q 'utilization abc' "$(logof "$r")" && echo 0 || echo 1)"
r="$(run_case EMPTY QUOTA_STOP_PCT=80 MAX_FIRES=1 QUOTA_UNKNOWN_FIRES=0 FALLBACK_UTIL=10 \
      "SEED_POLL_MEMO=$((now + 7200)) 97")"
check "a memo stamped in the FUTURE is not served (clock skew)" "1" "$(fires_of "$r")"

# --- 37c. the EPOCH needs a length bound too, and on the memo path its absence was
# a fail-OPEN. `$(( ))` wraps silently, so an epoch of 2^64+now computes an age
# INSIDE the window and the memo's value is served as though freshly polled -- which
# permits a fire, suppresses the real poll AND suppresses source 3. The same line is
# merely fail-SAFE for `.last_quota` (a bogus reading falls through to the blind
# allowance), so the polarity only flipped when the memo started sharing this parser.
#
# The epoch is built without 64-bit arithmetic, because bash cannot hold 2^64: split
# the constant 18446744073709551616 after 8 digits and add `now` to the low 12, which
# cannot carry (7.4e10 + 1.8e9 is still 11 digits). Yields the value measured by hand.
# A live reader at a REFUSING 97% against a memo of a permissive 10%, so rejecting the
# epoch polls and STOPs (0 fires) while serving it fires.
# `$(date +%s)`, NOT the run-wide `$now`: the wrapped epoch has to land INSIDE
# QUOTA_POLL_MIN_INTERVAL or the memo is rejected on ordinary age and the length bound
# is never reached. `$now` is stamped up at case 9, minutes of driver runs earlier --
# which made the first version of this case pass with the bound DELETED. Same trap the
# review round already fixed once for case 37; caught here by the mutation pass again.
bigepoch="18446744$(printf '%012d' $((73709551616 + $(date +%s))))"
r="$(run_case EMPTY QUOTA_STOP_PCT=80 MAX_FIRES=1 QUOTA_UNKNOWN_FIRES=0 FALLBACK_UTIL=97 \
      "SEED_POLL_MEMO=$bigepoch 10")"
check "a memo epoch too long to be a timestamp is not served (64-bit wrap)" "0" \
  "$(fires_of "$r")"
# ...and it refuses for the RIGHT reason -- the fresh 97% poll, not an UNREADABLE stop,
# which would also show 0 fires here.
check "...and it refuses on the freshly polled 97%, not by going blind" "0" \
  "$(grep -q 'STOP: 7-day quota utilization 97%' "$(logof "$r")" && echo 0 || echo 1)"

# --- 37d. the parser reads ONE line. `cat` took the epoch from line 1 and the value
# from the LAST line, so a fresh stamp got paired with an unrelated old value. Seeded
# with a fresh memoised FAILURE on line 1 and a stale permissive 10% on line 2:
# correctly, line 1 wins, "-" is UNREADABLE, and studio's 97% refuses -> 0 fires.
# Under `cat` the split yields epoch=now + value=10 and it fires. Both writers emit
# one line, so this needs a partial or raced write -- but it is per-machine state a
# manual run can touch, and the failure is a PERMITTED fire, not a refused one.
# Line 1 must be FRESH (`$(date +%s)`, not `$now`) for the same reason as 37c: a stale
# line 1 is rejected on age under BOTH behaviours and the case proves nothing.
r="$(run_case EMPTY QUOTA_STOP_PCT=80 MAX_FIRES=1 QUOTA_UNKNOWN_FIRES=0 STUDIO_UTIL=0.97 \
      "SEED_POLL_MEMO=$(date +%s) -"$'\n'"$((now - 7200)) 10")"
check "a two-line memo does not pair line 1's epoch with the last line's value" "0" \
  "$(fires_of "$r")"
check "...and studio is what refuses, so the memoised failure really fell through" "0" \
  "$(grep -q 'quota source: studio (7-day utilization 97%)' "$(logof "$r")" && echo 0 || echo 1)"

# NOT tested here: a memo line with NO separator. The degrade (`%% *` and `##* ` both
# yielding the whole string) makes the value a 10-digit epoch, which `quota_sane`
# rejects on length -- so the memo path re-polls whether or not the separator check
# exists, and an assertion on it would have been vacuous. It is pinned where it IS
# observable: case 20, on `.last_quota`, whose value domain accepts any digits. That
# is the same `quota_stamped_read` line now, so the property is covered once rather
# than asserted twice and proved once. (Verified by mutation: deleting the separator
# check leaves these cases green and turns case 20 red.)

# --- 40-42. the two "how old may a reading be" knobs are VALIDATED -------------
# Both are handed straight to `test`, and an operand `test` cannot parse returns 2 --
# neither branch -- so `[ age -gt bound ]` falls through and every stamped record
# looks FRESH. The memo path was already closed by its own `-gt 0` check; these pin
# the shared normalisation (#777 review), including for the pre-existing cache.
#
# 40. `QUOTA_CACHE_MAX_AGE=24h` is the plausible typo. Seeded with a TWO-DAY-old 98%:
# under the default (86400s) that record is stale, so it is not evidence and the blind
# allowance decides -- one fire. Unvalidated, the comparison falls through, the
# two-day-old 98% refuses, and because nothing ever clears `.last_quota` it would
# refuse EVERY fire from then on. That is worse than a fail-open: it is a permanent
# stall on a typo.
r="$(run_case EMPTY QUOTA_STOP_PCT=80 MAX_FIRES=1 QUOTA_UNKNOWN_FIRES=2 \
      QUOTA_CACHE_MAX_AGE=24h "SEED_CACHE=$((now - 172800)) 98")"
check "an unparseable QUOTA_CACHE_MAX_AGE cannot make a stale cache look fresh" "1" \
  "$(fires_of "$r")"
check "...and the substitution is ANNOUNCED, not silent" "0" \
  "$(grep -q "WARN: QUOTA_CACHE_MAX_AGE='24h' is not a usable number" "$(logof "$r")" && echo 0 || echo 1)"

# 41. The poll interval has the opposite risk -- it bounds how stale a reading may be
# when it PERMITS a fire, so an over-wide value is a fail-open. Measured by review:
# QUOTA_POLL_MIN_INTERVAL=86400 served a 12-hour-old reading to the gate with zero
# polls. Seeded with a two-hour-old permissive 10% against a live reader at 97%:
# clamped, the memo is expired and the fresh 97% STOPs; unclamped, the stale 10% fires.
r="$(run_case EMPTY QUOTA_STOP_PCT=80 MAX_FIRES=1 QUOTA_UNKNOWN_FIRES=0 FALLBACK_UTIL=97 \
      QUOTA_POLL_MIN_INTERVAL=86400 "SEED_POLL_MEMO=$((now - 7200)) 10")"
check "an over-wide poll interval is clamped, so a stale memo cannot permit a fire" "0" \
  "$(fires_of "$r")"
check "...and the clamp is ANNOUNCED" "0" \
  "$(grep -q 'WARN: QUOTA_POLL_MIN_INTERVAL=86400 exceeds the 300s ceiling' "$(logof "$r")" && echo 0 || echo 1)"

# 42. The CACHE's value needed `quota_sane`'s LENGTH bound, not just a digit class --
# the third appearance of the same 64-bit lesson (`quota_read_url` documents it,
# case 32 pins it for source 2, and the cache was still hand-rolling a char class).
# 18446744073709551696 is 2^64 + 80: all digits, so a char class passes it, and
# `$(( 10# ))` WRAPS it to exactly 80 on /bin/bash 3.2.57 (verified). That fabricates
# a last-known reading of precisely QUOTA_STOP_PCT out of a malformed line and refuses
# every fire. Rejected, it is simply not evidence, so the blind allowance decides.
r="$(run_case EMPTY QUOTA_STOP_PCT=80 MAX_FIRES=1 QUOTA_UNKNOWN_FIRES=1 \
      "SEED_CACHE=$now 18446744073709551696")"
check "an out-of-range CACHED value is rejected, not wrapped into a fake reading" "1" \
  "$(fires_of "$r")"

# --- 25. an unchanged main with NO branch in flight IS a stall ---------------
# The baseline the next case is measured against: MAX_STALL consecutive
# no-progress fires stop the run, so exactly MAX_STALL fires happen (the first
# iteration has no previous head to compare).
r="$(run_case 0.10 QUOTA_STOP_PCT=80 MAX_FIRES=0 STALL_HEAD=1)"
check "unchanged main, no branch -> stops after MAX_STALL=3 fires" "3" "$(fires_of "$r")"
check "and says nothing-more-to-do" "0" \
  "$(grep -q 'STOP: 3 consecutive no-progress fires' "$(logof "$r")" && echo 0 || echo 1)"

# --- 26. a studio branch AHEAD of main is progress, not a stall (#775) -------
# `prompt.md`'s triage rule 2 calls this state "continue it to a PR" — work in
# flight. The driver counted it as no-progress because it only looked at
# origin/main's HEAD and the open-PR count, so three fires that each ended with
# work committed-but-unpushed would stop the run with "nothing more to do (or the
# queue is drained)". Observed 2026-07-29: fires 8 and 9 both ended that way and
# the counter reached 2/3 while two commits and 66 staged lines sat on
# `fix/studio-764-relocate-quota-fallback-reader`.
#
# The stop is fail-safe in direction, which is why this is a correctness bug
# rather than a spend bug: the MESSAGE is what an operator reads to decide the
# queue is empty, and it is the one stop reason that files no alert.
r="$(run_case 0.10 QUOTA_STOP_PCT=80 MAX_FIRES=0 STALL_HEAD=1 BRANCH_AHEAD=fix/studio-764-example)"
check "branch ahead of main -> no stall, keeps firing" "12" "$(fires_of "$r")"
check "no nothing-more-to-do stop is logged" "1" \
  "$(grep -q 'consecutive no-progress fires' "$(logof "$r")" && echo 0 || echo 1)"
# The reason must be STATED, including on the first iteration — `prev_head` is
# unset there, so a condition keyed on it logs nothing and the operator sees a
# driver that simply never stalls with no explanation (review NITPICK).
check "it names the branch as the reason it did not stall" "0" \
  "$(grep -q "fix/studio-764-example' is ahead" "$(logof "$r")" && echo 0 || echo 1)"
# ...and on the FIRST iteration too. MAX_LOOPS=1 isolates it: `prev_head` is unset
# there, so a log line conditioned on it stays silent and a driver started with a
# branch already ahead explains nothing. The assertion above cannot catch that on
# its own — later iterations log it regardless — so this is the discriminating one.
r="$(run_case 0.10 QUOTA_STOP_PCT=80 MAX_FIRES=0 MAX_LOOPS=1 STALL_HEAD=1 BRANCH_AHEAD=fix/studio-first-iter)"
check "the reason is stated on the FIRST iteration as well" "0" \
  "$(grep -q "fix/studio-first-iter' is ahead" "$(logof "$r")" && echo 0 || echo 1)"

# --- 27. an ABANDONED branch must not mask a real stall (review WARNING) -----
# The scan matches any local studio branch, so a leftover from a crashed session
# would defeat the "nothing more to do" detector indefinitely — bounded only by
# quota, not by the stall signal it was meant to trip. Not hypothetical: 18 stale
# branches with deleted remotes were pruned from this repo on 2026-07-29.
# A tip older than AHEAD_MAX_AGE is abandonment, not work in flight.
r="$(run_case 0.10 QUOTA_STOP_PCT=80 MAX_FIRES=0 STALL_HEAD=1 BRANCH_AHEAD=fix/studio-abandoned BRANCH_AGE_H=48)"
check "a 48h-old branch does NOT mask the stall -> stops after 3" "3" "$(fires_of "$r")"

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
