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
ENGINE_LIB="${ENGINE_LIB:-/Users/lukebradford/Dev/autonomy-engine/lib}"   # claude_usage.py lives here
DLOG="${DLOG:-$INFRA/logs/driver.log}"
MAX_STALL="${MAX_STALL:-3}"       # consecutive no-progress fires = nothing more to do
MAX_CRASH="${MAX_CRASH:-5}"       # consecutive REAL (non-limit) crashes = broken, needs operator
GATE_WAIT_TRIES="${GATE_WAIT_TRIES:-60}"   # polls before giving up on a PR gate;
                                  # GATE_WAIT_TRIES x GATE_WAIT_SLEEP = up to 30 min by default
GATE_WAIT_SLEEP="${GATE_WAIT_SLEEP:-30}"   # seconds between gate polls; tests set 0
AUTH_TRIES="${AUTH_TRIES:-0}"     # 0 = back off + retry auth FOREVER; >0 caps it (tests only)
MAX_LOOPS="${MAX_LOOPS:-0}"       # 0 = run forever; >0 caps iterations (tests only)
BACKOFF_BASE="${BACKOFF_BASE:-30}"   # base backoff seconds; tests set 0 to neutralise sleeps
MAX_FIRES="${MAX_FIRES:-6}"       # 0 = uncapped. A cap exists because the 2026-07-25 quota
                                  # incident ran 16 fires overnight (~$652) and took the 7-DAY
                                  # window to 97%; that window resets weekly, so one uncapped
                                  # night can lock the operator out of their own sessions for
                                  # days. Six fires is roughly a night's useful work.
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
DASH_URL="${DASH_URL:-http://127.0.0.1:8787/api/state}"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >>"$DLOG"; }

# --- quota_pct: the 7-day subscription utilization as an INTEGER percent, or ""
# when it cannot be read. Echoes to stdout; never fails the caller.
#
# Read order is deliberate. The operator dashboard is preferred because it holds a
# recently-refreshed CACHED value: the upstream usage endpoint has its OWN rate
# limit and returns 429 when polled directly (observed 2026-07-25), so the direct
# call is the FALLBACK, not the primary. "" (unknown) is a distinct outcome from
# "0" and the caller must not conflate them -- 0% means wide open, "" means blind.
quota_pct() {
  qp_out="$(curl -s --max-time 8 "$DASH_URL" 2>/dev/null | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    u = d['account']['claude']['seven_day']['utilization']
    print(int(round(float(u) * 100)) if u is not None else '')
except Exception:
    print('')
" 2>/dev/null)"
  # NOTE the single exit point below: BOTH sources must feed the cache. An early
  # `return` here silently skipped caching the primary (and commonest) reading,
  # leaving the cache empty exactly when it was working -- caught by a test.
  if [ -z "$qp_out" ]; then
  # Fallback: ask the engine's usage reader directly (may be 429-limited).
  qp_out="$(cd "$ENGINE_LIB" 2>/dev/null && python3 -c "
import claude_usage as cu
try:
    q = cu.refresh_live_quota()
    w = (q or {}).get('seven_day') or {}
    u = w.get('utilization')
    print(int(round(float(u) * 100)) if u is not None else '')
except Exception:
    print('')
" 2>/dev/null)"
  fi
  [ -n "$qp_out" ] && quota_cache_write "$qp_out"
  echo "$qp_out"
}

# --- last-known-quota cache. Usage inside a 7-day window is MONOTONIC (it only
# rises until the weekly reset), so a recent HIGH reading is evidence the window
# is still exhausted -- but a recent LOW reading proves nothing about now, since
# fires may have run since. The cache is therefore trusted in ONE direction only:
# it may REFUSE a fire, never permit one. Fail-safe, same polarity as ci_check.
quota_cache_write() {  # $1=pct
  printf '%s %s\n' "$(date +%s)" "$1" >"$QUOTA_CACHE" 2>/dev/null || true
}
# Echoes the cached percent if one exists and is still fresh; "" otherwise.
quota_cache_read() {
  [ -f "$QUOTA_CACHE" ] || return 0
  qc_line="$(cat "$QUOTA_CACHE" 2>/dev/null)" || return 0
  # A separator is REQUIRED before splitting: with no space, `%% *` and `##* `
  # BOTH degrade to the whole string, so a single-token line was read as epoch
  # AND pct. A lone recent epoch then parsed as a colossal "percent" and refused
  # every fire -- over-refusing, so fail-safe, but for a fabricated reason.
  case "$qc_line" in *" "*) ;; *) return 0 ;; esac
  qc_when="${qc_line%% *}"; qc_pct="${qc_line##* }"
  case "$qc_when$qc_pct" in *[!0-9]*|"") return 0 ;; esac
  # 10# forces BASE TEN. Digit-only is not enough for $(( )): it reads a leading
  # zero as octal, so a value like 018 is "value too great for base" -- fatal to
  # this subshell (and under set -u the next line then reads unbound). The caller
  # would still degrade correctly (empty result => treated as unreadable), but
  # noisily and for the wrong reason. `test` is unaffected: [ 098 -ge 80 ] is
  # true, so only this arithmetic was ever exposed.
  qc_age=$(( $(date +%s) - 10#$qc_when ))
  [ "$qc_age" -lt 0 ] && return 0
  [ "$qc_age" -gt "$QUOTA_CACHE_MAX_AGE" ] && return 0
  echo $(( 10#$qc_pct ))
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
# ensure_auth only warm the log and the cache; they deliberately do not decide
# anything, because the decision belongs here where it can stop the loop.
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
  log "WARN: 7-day quota utilization UNREADABLE (dashboard down and usage endpoint unavailable) -- firing blind, $((QUOTA_UNKNOWN_FIRES - blind_fires - 1)) blind fire(s) left after this one"
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

log "=== DRIVER START (repo=$REPO -- MAX_FIRES=$MAX_FIRES, QUOTA_STOP_PCT=$QUOTA_STOP_PCT%; stop on operator/nothing-to-do/quota; backoff on limits) ==="

while true; do
  loops=$((loops + 1))
  if [ "$MAX_LOOPS" -gt 0 ] && [ "$loops" -gt "$MAX_LOOPS" ]; then
    log "MAX_LOOPS=$MAX_LOOPS reached (test mode) -- ending"
    break
  fi
  git fetch origin --quiet 2>>"$DLOG"

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

  # --- wait for any open PR's gate to settle before the next fire -------------
  pr="$(gh pr list --state open --json number -q '.[0].number // empty' 2>/dev/null || true)"
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
    if [ "$t" -gt 0 ]; then
      log "re-checking quota: the pre-wait reading is stale after ${t}x${GATE_WAIT_SLEEP}s of gate wait"
      quota_gate || break
    fi
  fi

  # --- progress / stall accounting (the ONLY "nothing more to do" detector) ---
  head="$(git rev-parse origin/main 2>/dev/null || echo unknown)"
  openpr="$(gh pr list --state open --json number -q 'length' 2>/dev/null || echo 0)"
  if [ -n "$prev_head" ] && [ "$head" = "$prev_head" ] && [ "${openpr:-0}" = "0" ]; then
    stall=$((stall + 1))
    log "no progress (main unchanged, no open PR) stall=$stall/$MAX_STALL"
    if [ "$stall" -ge "$MAX_STALL" ]; then
      log "STOP: $stall consecutive no-progress fires -- nothing more to do (or the queue is drained)"
      break
    fi
  else
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
  log "fire $fires exited $rc"

  if [ "$rc" != "0" ]; then
    # LIMIT vs BREAK: a usage/rate limit is a PAUSE (back off, retry -- never a
    # stop); a non-limit failure with auth good is a real BREAK (count it).
    lastlog="$(ls -t "$INFRA"/logs/fire.*.log 2>/dev/null | head -1)"
    if [ -n "$lastlog" ] && grep -qiE 'usage limit|rate limit|rate_limit|429|overloaded|resource_exhausted|quota|too many requests' "$lastlog" 2>/dev/null; then
      log "fire $fires hit a LIMIT -- pausing + backing off (NOT a crash)"
      paused_open limit "usage/rate limit hit; loop PAUSED, backing off" \
"A fire hit a usage/rate limit. The driver is backing off and retries automatically when the limit clears (auto-closes on recovery). No fires wasted, no action needed."
      backoff_sleep $(( crash + 3 ))
      continue
    fi
    # Auth can also die MID-fire; ensure_auth at the loop top will catch+pause it
    # next iteration. Here, treat a non-limit failure as a real break.
    crash=$((crash + 1))
    log "fire $fires exited NON-ZERO, not a limit (crash=$crash/$MAX_CRASH)"
    if [ "$crash" -ge "$MAX_CRASH" ]; then
      signal_blocked "run.sh crash-looped ($crash consecutive non-limit failures, auth OK)" \
"The studio build driver stopped: \`run.sh\` failed **$crash times in a row** with auth confirmed good and no usage/rate-limit marker in the fire logs. This is a genuine BREAK (a bug in the fire path), not a limit -- so it needs you, not a backoff.

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
