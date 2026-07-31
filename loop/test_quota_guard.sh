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

# --- #821 fixture lifecycle --------------------------------------------------
# Every tree this suite builds is recorded, and the trap clears the lot on ANY
# exit path -- pass, fail, or Ctrl-C. Before this, `run_case` could not delete
# its own tree (it RETURNS the path and callers read files out of it afterwards)
# and nothing else ever did: 6,768 abandoned trees, ~800 MB, had piled up on the
# operator's Mac. Worse, a driver could OUTLIVE the suite -- one was found still
# firing an hour after the run that spawned it had been killed.
#
# `reap_known_tree` rather than `reap_tree`: these trees' provenance is already
# established (this process created them), and the ad-hoc ones below hold an
# `infra/` with no stub `bin/`, so the signature gate would refuse exactly the
# trees the trap exists to clean. See the SAFETY note in reap_test_drivers.sh.
# A missing module must FAIL THE SUITE, not degrade it. There is no `set -e`
# here, so an unguarded `.` on an absent file returns 1 and the suite carries on
# with every reaper function undefined: no startup sweep, a trap that cleans
# nothing, and a leak assertion whose `drivers_under` fails so `leaked` stays
# empty and the case passes GREEN. That is not hypothetical -- `loop/` is
# hand-synced file by file to the live plane, so "this file has not arrived yet"
# is the default state after a merge.
# shellcheck source=/dev/null
. "$HERE/reap_test_drivers.sh" || {
  echo "FAIL - reap_test_drivers.sh could not be sourced (#821)"; exit 1; }
# The registry is a FILE, not a variable. Every tree is created inside a command
# substitution -- `r="$(run_case ...)"`, `shtmp="$(mk_tmp)"` -- which runs in a
# SUBSHELL, so an appended variable is discarded the moment the substitution
# closes and the parent's list stays empty. A variable registry here would leave
# the trap with nothing to clean and make the leak assertion below pass
# VACUOUSLY: green suite, orphaned driver, exactly the #821 failure. (Measured:
# the first version of this fix did precisely that.)
REG_FILE="$(mktemp)" || REG_FILE=""
# Hard-fail: with no registry file the trap cleans nothing, every tree and driver
# leaks, and case 19's `done <"$REG_FILE"` fails so `leaked` stays empty and the
# leak assertion passes GREEN. The registry is the single point of failure for
# both, so it is the one thing that must be validated.
[ -n "$REG_FILE" ] && [ -f "$REG_FILE" ] || { echo "FAIL - could not create the fixture registry (#821)"; exit 1; }
mk_tmp() { mt_d="$(mktemp -d)"; echo "$mt_d" >>"$REG_FILE"; echo "$mt_d"; }
# KEEP_TMP=1 keeps the trees for debugging -- but NEVER the processes: an
# orphaned driver is the defect, not a diagnostic.
# Idempotent: the INT/TERM handler's `exit 130` re-fires the EXIT trap, and the
# second pass would read a $REG_FILE it has already removed -- a "No such file"
# on stderr at exactly the moment someone is watching the output.
rr_done=""
reap_registered() {
  [ -z "$rr_done" ] || return 0
  rr_done=1
  rr_ps="$(ps -ww -eo pid=,command= 2>/dev/null)"
  while read -r rr_t; do
    [ -n "$rr_t" ] && [ -d "$rr_t" ] || continue
    if [ -n "${KEEP_TMP:-}" ]; then reap_kill_under "$rr_t" "$rr_ps"
    else reap_known_tree "$rr_t" "$rr_ps" >/dev/null 2>&1 || true; fi
  done <"$REG_FILE"
  # KEEP_TMP keeps the LIST too -- a set of kept trees with no record of which
  # ones they are is a poor diagnostic.
  [ -n "${KEEP_TMP:-}" ] && echo "note - kept fixture trees listed in $REG_FILE" || rm -f "$REG_FILE"
}
rr_rc=0
trap 'rr_rc=$?; reap_registered; exit "$rr_rc"' EXIT
trap 'reap_registered; exit 130' INT TERM
# And sweep what earlier runs left behind. Bounded to trees older than an hour so
# a concurrently-running suite's trees are never pulled out from under it.
if stale_reaped="$(reap_stale_trees 60)" && [ -n "$stale_reaped" ]; then
  [ "$stale_reaped" = "0" ] || echo "note - reaped $stale_reaped stale fixture tree(s) from earlier runs (#821)"
else
  # An empty count is a FAILED sweep, not a clean one. Saying "reaped  trees"
  # would report the failure as a success.
  echo "note - stale-tree sweep could not run (temp root unreadable) (#821)"
fi

# One scenario: $1=utilization-json-or-EMPTY  $2=extra env  -> echoes fire count
run_case() {
  rc_util="$1"; shift
  tmp="$(mk_tmp)"; bin="$tmp/bin"; mkdir -p "$bin"
  # --- stubs -----------------------------------------------------------------
  # No operator signals. GH_OPEN_PR=1 puts an open PR in front of the driver so
  # the gate-wait path is reachable; `pr checks` then always reports pending, so
  # the driver waits its full GATE_WAIT_TRIES.
  # #805: the driver now asks for `number headRefName` pairs and filters them
  # ITSELF, so the stub reports the head branch too. GH_OPEN_PR_REF overrides it
  # — an operator PR (a ref outside the loop's convention) must not register as
  # the loop's work at any of the three sites that read this.
  cat >"$bin/gh" <<'EOS'
#!/bin/bash
case "$*" in
  *"pr list"*)         [ -n "${GH_OPEN_PR:-}" ] && echo "7 ${GH_OPEN_PR_REF:-fix/studio-open-pr}" || echo "" ;;
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
    # ...and a COUNT, appended, because the marker is truncate-only and so cannot
    # distinguish one poll from ten. #765's shadow probe is RATE-BOUNDED, and a
    # rate bound whose test cannot count is untestable -- the same blind spot #777
    # reported for source 2, which is why `readercalls` below is append-based too.
    # Separate file rather than converting the marker: three existing cases assert
    # on the marker's EXISTENCE and must keep their exact meaning.
    echo 1 >>"${STUDIO_POLL_COUNT:-/dev/null}"
    if [ -n "${STUDIO_UTIL:-}" ]; then
      echo '{"account":{"claude":{"seven_day":{"utilization":'"$STUDIO_UTIL"'}}}}'
    else
      echo '{"account":{"claude":null}}'
    fi
    exit 0 ;;
  # #832: the drift report asks the SAME service for its build identity once per
  # loop iteration. This arm exists so that call cannot fall through to the
  # dashboard arm below, which counts calls -- an untracked poll silently
  # consumes `CURL_READABLE_CALLS` and shifts every scripted response after it,
  # so the fires a case is asserting on stop being the fires it set up. (It did:
  # adding the drift half turned a 4-fire case into 3.) Returns early and never
  # touches `curlcalls`, exactly as the studio arm above does.
  #
  # Serves the `dev` PLACEHOLDER -- what a checkout with no release manifest
  # serves -- so the drift half reads UNKNOWN and the pre-existing cases stay
  # tests of what they were written to test. No knob to vary it: case 44c drives
  # every verdict directly against a real git fixture, and an unused knob here
  # would be a second, weaker way to do the same thing.
  */api/version*)
    echo '{"version":"0.0.0-dev","commit":"dev"}'
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
  # run.sh stub. RUN_RC=<n> makes the fire FAIL, and FIRE_RESULT=<kind> leaves a
  # synthetic fire log behind (#774) -- the LIMIT-vs-CRASH classifier reads the
  # newest `$INFRA/logs/fire.*.log`, so a case about classification has to leave
  # one exactly as a real fire does. Both arrive through the same `env` as every
  # other knob: drive.sh's environment is inherited by the run.sh it spawns.
  #
  # Every kind writes the SAME transcript body first: the pollution #774 is
  # about. A fire whose TICKET is rate limiting reads and writes those markers
  # for entirely innocent reasons, and the old whole-log grep matched them, so
  # the body is what makes the crash cases discriminating -- restore the whole-log
  # grep and every one of them flips to LIMIT.
  cat >"$tmp/infra/run.sh" <<'EOS'
#!/bin/bash
echo fired >>"$REPO/fires.txt"
# #821: the fixture kill switch. The driver runs this on EVERY fire, so this is
# the one place a bound can sit that survives the harness being SIGKILLed and the
# driver re-exec'ing itself. It bounds a driver that keeps FIRING -- the observed
# orphan, 3,177 fires. It does NOT bound one wedged in an inner loop that never
# reaches a fire (`ensure_auth`, the gate wait); that bound belongs to drive.sh
# itself and is out of scope here (#819). Scoped to $INFRA/drive.sh: the live control plane at
# ~/Dev/studio-loop/drive.sh can never match. The pid is read with default-IFS
# word splitting because `ps -o pid=` right-justifies it, and `${line%% *}` on a
# space-padded line strips the WHOLE line -- a kill switch that kills nothing.
if [ -f "$INFRA/.fixture_deadline" ]; then
  fd_at="$(cat "$INFRA/.fixture_deadline" 2>/dev/null)"
  # Strictly `-?[0-9]+`. The looser `*[!0-9-]*` admitted `1-2-3`, on which
  # `[ "$now" -gt ... ]` errors and the `if` takes the FALSE branch -- a kill
  # switch that is silently off. A bound must not fail open.
  case "${fd_at#-}" in "" | *[!0-9]*) fd_at="" ;; esac
  if [ -n "$fd_at" ] && [ "$(date +%s)" -gt "$fd_at" ]; then
    ps -ww -eo pid=,command= 2>/dev/null | while read -r fd_pid fd_cmd; do
      case "$fd_cmd" in *"$INFRA/drive.sh"*) kill -9 "$fd_pid" 2>/dev/null || true ;; esac
    done
    exit 1
  fi
fi
# #811: what the FIRE sees of the adopt marker. The driver carries the adopt
# count in the environment as a second carrier for the MAX_SELF_ADOPT cap, and
# must unset it before any child runs -- a stray DRIVE_ADOPT_COUNT in an agent's
# environment would be read back by a nested driver as an adoption that never
# happened. One line per fire, so "it leaked on the fire after the exec" is
# visible and not averaged away.
echo "[${DRIVE_ADOPT_COUNT:-}]" >>"$REPO/adoptmarker.txt"
# #811: MUTATE_DRIVE makes a fire change the DRIVER'S OWN source, which is what a
# `loop/` merge + sync does in production. The next iteration's `drive_self_adopt`
# then sees its file differ from its boot hash. Appending is the only sanctioned
# mutation here (never `git checkout --`/`restore`/`stash`, which destroy
# uncommitted work) and it is safe against the running process: the `while` loop
# is already parsed, and bash only reads past it once the loop has ended.
#   comment = ONE harmless append, so exactly one adoption is triggered
#   broken  = ONE append that does not PARSE, so adoption must refuse
#   every   = an append per fire, so the adopt CAP is what has to stop it
if [ -n "${MUTATE_DRIVE:-}" ]; then
  case "$MUTATE_DRIVE" in
    comment) grep -q '811-test-marker' "$INFRA/drive.sh" || printf '# 811-test-marker\n' >>"$INFRA/drive.sh" ;;
    broken)  grep -q '811-test-broken'  "$INFRA/drive.sh" || printf 'if [ ; then # 811-test-broken\n' >>"$INFRA/drive.sh" ;;
    # No idempotence guard: a repeat of the SAME line still lengthens the file,
    # so the hash changes on every fire.
    every)   printf '# 811-test-marker\n' >>"$INFRA/drive.sh" ;;
  esac
fi
if [ -n "${FIRE_RESULT:-}" ]; then
  mkdir -p "$INFRA/logs"
  fl="$INFRA/logs/fire.$(date +%Y%m%d-%H%M%S).$$.log"
  # Interleaved non-JSON lines are deliberate: a real fire log is a MIXED stream
  # (wrapper lines + stream-json), and its literal last line is a driver footer,
  # so an extractor that reads only `tail -1` would find nothing here either.
  {
    echo "=== studio-build-loop fire START ==="
    echo '{"type":"assistant","message":{"content":[{"type":"text","text":"reading the quota guard: rate limit, rate_limit, 429, quota, usage limit, overloaded, too many requests, resource_exhausted"}]}}'
    echo '{"type":"user","message":{"content":"the quota endpoint answered 429 Too Many Requests"}}'
  } >"$fl"
  case "$FIRE_RESULT" in
    # A GENUINE crash (a hung tool aborted the stream) inside a quota-ticket fire.
    crash_polluted)
      echo '{"type":"result","is_error":true,"subtype":"error_during_execution","api_error_status":null,"terminal_reason":"aborted_streaming","stop_reason":"tool_use","result":""}' >>"$fl" ;;
    # A REAL limit. Note the text says "weekly limit", which matches NO marker --
    # so this case passes only if the status field itself is in the haystack.
    limit_429)
      echo '{"type":"result","is_error":true,"subtype":"success","api_error_status":429,"terminal_reason":"api_error","stop_reason":"stop_sequence","result":"weekly limit reached - resets Jul 22 at 3am"}' >>"$fl" ;;
    # A 529 whose status was NOT captured -- classifiable ONLY from the result
    # TEXT, which is what makes including that text non-vacuous. SYNTHETIC on
    # purpose: the real 529 (2026-07-29) did carry `api_error_status=529`. What is
    # real is the SHAPE -- other logs show `is_error:true` with a null status (an
    # expired-OAuth case, a connection-closed one), so a limit arriving without one
    # is not hypothetical, and the text is the only signal left when it happens.
    limit_529_text)
      echo '{"type":"result","is_error":true,"subtype":"success","api_error_status":null,"terminal_reason":"api_error","stop_reason":"stop_sequence","result":"API Error: 529 Overloaded. This is a server-side issue, usually temporary"}' >>"$fl" ;;
    # The model turn SUCCEEDED and the non-zero rc came from the wrapper. Here the
    # result text IS the agent's own prose, markers and all -- it must never be
    # consulted, or #774 returns through the narrowed haystack.
    wrapper_fail)
      echo '{"type":"result","is_error":false,"subtype":"success","api_error_status":null,"terminal_reason":"completed","stop_reason":"end_turn","result":"Landed the quota guard fix: rate limit handling, 429 backoff, usage limit markers, resource_exhausted mapping"}' >>"$fl" ;;
    # Killed before any terminal result was emitted (OOM, launchd kill).
    no_result) : ;;
  esac
  echo "=== studio-build-loop fire END ===" >>"$fl"
fi
exit "${RUN_RC:-0}"
EOS
  chmod +x "$tmp/infra/run.sh"
  cp "$HERE/drive.sh" "$tmp/infra/drive.sh"

  # #821: the deadline the stub run.sh enforces. This is the half of the fix that
  # does not ride the harness: a `trap` dies with the shell, and the orphan that
  # started this ticket was born exactly when the suite was killed. The deadline
  # is on DISK in $INFRA, so it survives both that and the driver's own self-exec.
  # The bound to clear is MAX_LOOPS x GATE_WAIT_SLEEP: `run_case` pins
  # GATE_WAIT_TRIES=1 but NOT GATE_WAIT_SLEEP, whose default in drive.sh is 30 --
  # so a future gate-wait case that forgets `GATE_WAIT_SLEEP=0` (every current one
  # sets it) would legitimately take 12 x 30 = 360s. 1200s leaves that a 3x margin
  # while still being a bound; it exists to make an immortal driver impossible,
  # not to be tight. The earlier figure here was derived from `sleep 0.10`, which
  # is not a sleep at all -- it is run_case's utilization argument.
  rc_ttl=1200
  for rc_a in "$@"; do
    case "$rc_a" in
      FIXTURE_TTL=*)
        rc_v="${rc_a#FIXTURE_TTL=}"
        # Validated, because `$(( now + abc ))` resolves a bare name to 0 (giving
        # "deadline = now" for a typo) and `$(( now + 08 ))` is a fatal expansion
        # error that takes the subshell with it. Both would look like the
        # deadline firing correctly.
        case "${rc_v#-}" in "" | *[!0-9]*) : ;; *) rc_ttl="$rc_v" ;; esac ;;
    esac
  done
  echo "$(( $(date +%s) + rc_ttl ))" >"$tmp/infra/.fixture_deadline"

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
    STUDIO_POLL_COUNT="$tmp/studiopolls" \
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
# How many times studio (source 3) was actually POLLED in that run -- by the live
# fallback OR by the #765 shadow probe, which share one curl arm. Same accessor
# contract as readerpolls: the tmp dir is READ from the result string, never
# inferred from the log path (that derivation reads 0 under FRESH_LOGDIR=1 and
# passes vacuously).
studiopolls() {
  sp_f="$(tmpof "$1")/studiopolls"
  if [ -f "$sp_f" ]; then wc -l <"$sp_f" | tr -d ' '; else echo 0; fi
}
# Did the GUARD report a quota it could not read? $1 = the run result string.
#
# `UNREADABLE` has TWO subjects in this log since #765: the guard's own reading,
# and the shadow probe's diagnostic line about studio. Every assertion using this
# helper means the FORMER, so the shadow line is excluded rather than matched.
#
# That is a STRENGTHENING, not a loosening -- any non-shadow UNREADABLE still
# counts -- and it is needed in BOTH directions, which is the part worth stating.
# Case 33 asserts the word is ABSENT and merely broke loudly. Case 28d asserts it
# is PRESENT (a fire outcome the #774 classifier could not read) and would have
# gone on passing while satisfied by a shadow line about something else entirely:
# green, and proving nothing. That is the vacuous-coverage shape this repo has
# shipped twice, and it appeared here as a side effect of a feature in another
# file -- which is why the word is disambiguated everywhere rather than at the one
# site that happened to fail.
guard_unreadable() {  # echoes 0 if the GUARD reported UNREADABLE, 1 if it did not
  if grep 'UNREADABLE' "$(logof "$1")" 2>/dev/null | grep -qv 'quota shadow:'
  then echo 0; else echo 1; fi
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
check "unreadable util logs the blind-fire WARN" "0" "$(guard_unreadable "$r")"

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
#
# QUOTA_SHADOW_MIN_INTERVAL=0 for the same reason as case 25: the #765 shadow
# probe polls studio whenever an EARLIER source answered, which is this topology,
# and it would make the "studio is unpolled" assertion true-by-accident-or-false
# regardless of the selection order it exists to pin.
r="$(run_case EMPTY QUOTA_STOP_PCT=80 MAX_FIRES=0 QUOTA_UNKNOWN_FIRES=2 FALLBACK_UTIL=97 \
      STUDIO_UTIL=0.10 QUOTA_SHADOW_MIN_INTERVAL=0)"
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
#
# QUOTA_SHADOW_MIN_INTERVAL=0 disables the #765 shadow probe for this case, and
# that is not weakening it -- it is what keeps it testing the thing it names. The
# shadow deliberately polls studio on exactly this topology (the dashboard
# answered, so source 3 was skipped), through the SAME curl arm and the SAME
# marker, so without the knob "studio was polled" would be true for a reason that
# has nothing to do with the SELECTION order this case exists to pin. Case 29b
# below asserts the shadow poll on this same topology, so the behaviour is covered
# once each, in the case that means it.
r="$(run_case 0.10 QUOTA_STOP_PCT=80 MAX_FIRES=1 STUDIO_UTIL=0.10 QUOTA_SHADOW_MIN_INTERVAL=0)"
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
check "dashboard+loop reader down, studio readable -> NOT a blind fire" "1" "$(guard_unreadable "$r")"

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
# QUOTA_SHADOW_MIN_INTERVAL=0 is LOAD-BEARING for the third assertion, not tidiness.
# The shadow probe (#765) polls the same `/api/quota` URL through the same curl arm
# and drops the same marker, so with the probe live the marker is present whether or
# not the FALLTHROUGH reached studio -- the exact regression this case exists to
# catch would pass. Cases 25/26 got this knob when the probe landed; this one, the
# only marker assertion with POSITIVE polarity, was missed. Mutation-checked both
# ways: with the source-3 block disabled (`if false`) this case FAILS with the knob
# and PASSES without it.
r="$(run_case EMPTY QUOTA_STOP_PCT=80 QUOTA_UNKNOWN_FIRES=0 FALLBACK_UNREADABLE=1 QUOTA_SHADOW_MIN_INTERVAL=0)"
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
check "a throttled read is not reported as UNREADABLE" "1" "$(guard_unreadable "$r")"
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

# --- 27b. #805 the progress signals must measure THE LOOP, not the repo ------
# All three read "is something happening here?" when the question is "is the
# LOOP making progress?" The operator works in the same repo on the same main,
# so their branch and their PR were both counted as the loop's work.
#
# Measured 2026-07-31: ONE supervisor PR (#803, branch
# `fix/loop-commit-before-long-wait`) corrupted all three simultaneously — the
# branch reset the stall counter, `openPR=1` suppressed the stall condition
# independently of it, and the driver sat waiting on a gate that was not its
# own ("PR #803 gate settled"). Each is asserted separately below, because any
# ONE of them surviving is enough to keep a stalled loop firing.
#
# The supervisor-branch case is the discriminating one for the branch signal:
# the pre-#805 pattern matched `feat/loop*|fix/loop*` explicitly, and every
# branch ever pushed under those prefixes was the operator's.
r="$(run_case 0.10 QUOTA_STOP_PCT=80 MAX_FIRES=0 STALL_HEAD=1 BRANCH_AHEAD=fix/loop-supervisor-work)"
check "a SUPERVISOR branch does NOT mask the stall -> stops after 3" "3" "$(fires_of "$r")"
check "...and it is never named as work in flight" "1" \
  "$(grep -q "fix/loop-supervisor-work' is ahead" "$(logof "$r")" && echo 0 || echo 1)"

# The open-PR signal, isolated: no branch ahead at all, only an operator PR.
# It carries no age bound, so before #805 it masked a stall indefinitely.
r="$(run_case 0.10 QUOTA_STOP_PCT=80 MAX_FIRES=0 STALL_HEAD=1 GATE_WAIT_TRIES=1 GATE_WAIT_SLEEP=0 \
      GH_OPEN_PR=1 GH_OPEN_PR_REF=fix/loop-supervisor-work)"
check "a SUPERVISOR open PR does NOT mask the stall -> stops after 3" "3" "$(fires_of "$r")"
check "...and the driver does not wait on that PR's gate" "1" \
  "$(grep -q 'open PR #7 present' "$(logof "$r")" && echo 0 || echo 1)"

# --- 27c. #823 the loop's own `loop/` work is NUMBERED and must register -----
# #805 matched `*/studio-*` only, because across 40 merged PRs every `*/loop-*`
# branch had been the operator's. That census was true and the inference from it
# was wrong: it held only while the loop had never worked on `loop/` itself.
# Hours later it did (#808, #811, #821), naming them `fix/loop-<issue>-<slug>`
# like everything else -- so the predicate began excluding the LOOP'S OWN WORK.
#
# Measured 2026-07-31 10:54Z: PR #822 (`fix/loop-821-test-harness-orphan`) open,
# a fire actively polling its gate, and the driver logging "no progress ... no
# open PR ... stall=1/3" while refusing to wait on that gate. Three of those
# STOPS the driver claiming the queue is drained, with a PR in flight.
#
# These are the exact branch names from that incident, so the pre-#823 predicate
# is what makes them discriminating.
r="$(run_case 0.10 QUOTA_STOP_PCT=80 MAX_FIRES=0 STALL_HEAD=1 BRANCH_AHEAD=fix/loop-821-test-harness-orphan)"
check "a NUMBERED loop-infra branch is the loop's -> no stall" "12" "$(fires_of "$r")"
r="$(run_case 0.10 QUOTA_STOP_PCT=80 MAX_FIRES=0 STALL_HEAD=1 GATE_WAIT_TRIES=1 GATE_WAIT_SLEEP=0 \
      GH_OPEN_PR=1 GH_OPEN_PR_REF=fix/loop-821-test-harness-orphan)"
check "...and its PR suppresses the stall too" "12" "$(fires_of "$r")"
check "...and the driver DOES wait on its gate" "0" \
  "$(grep -q 'open PR #7 present' "$(logof "$r")" && echo 0 || echo 1)"
# The discriminator is the DIGIT, not the `loop-` prefix: the supervisor's own
# branches keep the prefix and carry no issue number, and must still be excluded
# or #805's whole finding is undone.
r="$(run_case 0.10 QUOTA_STOP_PCT=80 MAX_FIRES=0 STALL_HEAD=1 BRANCH_AHEAD=fix/loop-commit-before-long-wait)"
check "an UNNUMBERED loop- branch is the supervisor's -> still stalls" "3" "$(fires_of "$r")"
r="$(run_case 0.10 QUOTA_STOP_PCT=80 MAX_FIRES=0 STALL_HEAD=1 BRANCH_AHEAD=supervisor/loop-ref-numbered-branches)"
check "the reserved supervisor/ prefix -> still stalls" "3" "$(fires_of "$r")"
# An un-numbered STUDIO branch stays the loop's: it has shipped those
# (`fix/studio-sweep7-...`), so requiring a digit there would trip false stalls.
r="$(run_case 0.10 QUOTA_STOP_PCT=80 MAX_FIRES=0 STALL_HEAD=1 BRANCH_AHEAD=fix/studio-sweep7-agent-cli-timeout)"
check "an UNNUMBERED studio branch is still the loop's" "12" "$(fires_of "$r")"

# Both regression guards: the loop's OWN branch and PR must still register, or
# the fix trades a spend bug for a false "queue is drained" stop.
r="$(run_case 0.10 QUOTA_STOP_PCT=80 MAX_FIRES=0 STALL_HEAD=1 GATE_WAIT_TRIES=1 GATE_WAIT_SLEEP=0 \
      GH_OPEN_PR=1 GH_OPEN_PR_REF=fix/studio-812-real-work)"
check "the LOOP's own open PR still suppresses the stall" "12" "$(fires_of "$r")"
check "...and the driver still waits on ITS gate" "0" \
  "$(grep -q 'open PR #7 present' "$(logof "$r")" && echo 0 || echo 1)"

# --- 28. #774 classify a failed fire from its TERMINAL RESULT, not the log ---
# The classifier grepped the ENTIRE fire log for limit markers. A fire log is a
# full transcript, so during any quota/rate-limit TICKET the markers are all over
# it innocently (measured: `quota` x1337 in one real log) -- and a GENUINE crash
# was then excused as a limit, `crash` never incremented, MAX_CRASH never tripped,
# and the driver retried a broken fire forever while the operator was told
# "NEEDS NO ACTION". Fail-open in the one direction the crash detector exists for.
#
# Every case below leaves a transcript body FULL of markers, so the old behaviour
# is what makes them discriminating rather than an extra assertion.

# 28a. THE HEADLINE: a real crash inside a quota-ticket fire is counted.
r="$(run_case 0.10 QUOTA_STOP_PCT=80 MAX_CRASH=1 RUN_RC=1 FIRE_RESULT=crash_polluted)"
check "a crash whose TRANSCRIPT is full of quota prose counts as a CRASH" "0" \
  "$(grep -q 'not a limit (crash=1/1)' "$(logof "$r")" && echo 0 || echo 1)"
check "...and is NOT excused as a limit" "1" \
  "$(grep -q 'hit a LIMIT' "$(logof "$r")" && echo 0 || echo 1)"
check "...and reaches [loop-blocked] instead of retrying forever" "0" \
  "$(grep -q 'STOP: crash-looped' "$(logof "$r")" && echo 0 || echo 1)"

# 28b. NO REGRESSION: a real 429 is still a limit -- from the status FIELD, since
# this result's text ("weekly limit") matches no marker in the list.
r="$(run_case 0.10 QUOTA_STOP_PCT=80 MAX_CRASH=1 RUN_RC=1 FIRE_RESULT=limit_429)"
check "a real 429 is still a LIMIT (classified from api_error_status)" "0" \
  "$(grep -q 'hit a LIMIT' "$(logof "$r")" && echo 0 || echo 1)"
check "...and never touches the crash counter" "1" \
  "$(grep -q 'not a limit (crash=' "$(logof "$r")" && echo 0 || echo 1)"

# 28c. The result TEXT is load-bearing too: a 529 arrives with NO status, so
# dropping the text from the haystack would misclassify a genuine overload.
r="$(run_case 0.10 QUOTA_STOP_PCT=80 MAX_CRASH=1 RUN_RC=1 FIRE_RESULT=limit_529_text)"
check "a 529 with no status is a LIMIT (classified from the result text)" "0" \
  "$(grep -q 'hit a LIMIT' "$(logof "$r")" && echo 0 || echo 1)"

# 28d. FAIL-SAFE: an unreadable outcome must never take the no-action path. Same
# shape as the engine's "a gh API failure is NEVER CI-green".
r="$(run_case 0.10 QUOTA_STOP_PCT=80 MAX_CRASH=1 RUN_RC=1 FIRE_RESULT=no_result)"
check "a fire with NO terminal result is a CRASH, not a limit" "0" \
  "$(grep -q 'not a limit (crash=1/1)' "$(logof "$r")" && echo 0 || echo 1)"
check "...and says the outcome was UNREADABLE rather than inventing one" "0" "$(guard_unreadable "$r")"

# 28e. The agent's OWN PROSE is never the haystack. When the model turn did not
# error, a non-zero rc came from the wrapper -- and this result's text is a fire
# summary stuffed with markers, so consulting it would reopen #774 at one message.
r="$(run_case 0.10 QUOTA_STOP_PCT=80 MAX_CRASH=1 RUN_RC=1 FIRE_RESULT=wrapper_fail)"
check "a non-erroring turn with marker-laden PROSE is a CRASH" "0" \
  "$(grep -q 'not a limit (crash=1/1)' "$(logof "$r")" && echo 0 || echo 1)"
check "...and is not excused by its own prose" "1" \
  "$(grep -q 'hit a LIMIT' "$(logof "$r")" && echo 0 || echo 1)"

# --- 29. #765 the studio SHADOW PROBE: evidence collected, guard untouched ----
# C3 (#410) retires the engine and with it source 1. Its gate is evidence that
# studio can actually serve a reading at fire time -- but studio is source 3, so
# the `quota source: studio` line that gate names can only ever appear when source
# 1 FAILS. With a healthy dashboard that is a test of LUCK, and the gate could sit
# unsatisfied indefinitely while studio is in fact fine. The shadow probe polls
# studio anyway, on a rate bound, and logs the outcome WITHOUT letting it near the
# guard. These cases pin both halves: that the evidence is collected, and that
# collecting it cannot change a single decision.

# 29a. THE HEADLINE: the dashboard answers, and studio is polled ANYWAY and named
# in a shadow line. Before the probe, studio was polled on this topology zero times.
r="$(run_case 0.10 QUOTA_STOP_PCT=80 MAX_FIRES=1 STUDIO_UTIL=0.97)"
check "dashboard readable -> studio is STILL polled (the shadow probe ran)" "0" \
  "$(grep -q 'quota shadow: studio 97%' "$(logof "$r")" && echo 0 || echo 1)"
# The two lines must stay DISTINGUISHABLE. `quota source: studio` is the C3
# promotion evidence and means "the guard used studio"; a shadow reading did not
# gate anything. If the probe logged the source string, every dashboard-healthy
# fire would manufacture promotion evidence for a source that decided nothing --
# forging exactly the signal the gate exists to collect honestly.
check "...and a SHADOW reading is never logged as the SOURCE" "1" \
  "$(grep -q 'quota source: studio' "$(logof "$r")" && echo 0 || echo 1)"
# 29b. INERT, permissive direction: studio says 97% (refusing) and the dashboard
# says 10%. The fire must still happen on 10%. A shadow that could refuse would be
# a source, not a diagnostic -- and one that shares a rate-limited upstream would
# then be able to stop the loop by 429ing.
check "a refusing SHADOW reading cannot stop a fire the guard permits" "1" \
  "$(fires_of "$r")"
check "...and the guard's own reading is the one that decided" "0" \
  "$(grep -q 'quota ok: 7-day utilization 10%' "$(logof "$r")" && echo 0 || echo 1)"
# The "shadow must not write the refuse-only cache" property is pinned by 29f
# below, as a DIRECT call, and deliberately not here. Asserting it end-to-end was
# tried first and is VACUOUS: `.last_quota` holds only the LAST write, the probe is
# rate-bounded to one poll while the guard rewrites the cache on every read, so the
# guard's own later write restores the expected value no matter what the shadow did
# in between. Measured -- injecting `quota_cache_write "$qsp_pct"` into the probe
# left the whole suite GREEN. A transient state an end-to-end run cannot observe
# needs a unit call, not a cleverer topology.

# 29c. INERT, the DANGEROUS direction: the dashboard refuses at 97% and studio's
# shadow offers a permissive 10%. Fail-open is the one polarity this guard may not
# have, so a shadow reading must not permit a fire either. Zero fires.
r="$(run_case 0.97 QUOTA_STOP_PCT=80 MAX_FIRES=1 STUDIO_UTIL=0.10)"
check "a permissive SHADOW reading cannot authorise a fire the guard refuses" "0" \
  "$(fires_of "$r")"
check "...and the STOP is on the dashboard's 97%" "0" \
  "$(grep -q 'STOP: 7-day quota utilization 97%' "$(logof "$r")" && echo 0 || echo 1)"

# 29d. THE RATE BOUND, on a FAILING studio -- the half that actually protects the
# upstream. Studio is UNREADABLE here (the default: HTTP 200 carrying
# `claude: null`, its real failure shape). Three fire-gated iterations call
# quota_pct many times over; the probe must poll ONCE.
#
# The failing case is the one that matters and is easy to get wrong: stamping only
# on a SUCCESSFUL read leaves the stamp un-advanced for exactly as long as studio
# is failing, so every call re-attempts. Stamping on the ATTEMPT makes the class
# unrepresentable. The full rationale -- including WHY the tempting "#777's bug in
# a new place" framing overstates the cost, since studio absorbs repeat polls in
# its own server rather than passing them to the shared upstream -- is stated once,
# in `quota_shadow_probe`'s header block, and deliberately not restated here.
r="$(run_case 0.10 QUOTA_STOP_PCT=80 MAX_FIRES=3)"
check "a FAILING shadow read is throttled too -> one poll per window, not one per call" "1" \
  "$(studiopolls "$r")"
check "...and the failure is recorded as UNREADABLE, not silently skipped" "0" \
  "$(grep -q 'quota shadow: studio UNREADABLE' "$(logof "$r")" && echo 0 || echo 1)"

# 29e. The OFF switch is a real off switch -- ZERO polls, not "one and then
# throttled". `quota_stamped_read(file, 0)` alone cannot express this: nothing has
# stamped the file on the first call, so the probe would poll once and only then
# find a same-second stamp not older than 0. That is the trap case 38b documents
# for the source-2 memo, which is why that path carries an explicit `-gt 0` too.
r="$(run_case 0.10 QUOTA_STOP_PCT=80 MAX_FIRES=3 QUOTA_SHADOW_MIN_INTERVAL=0)"
check "QUOTA_SHADOW_MIN_INTERVAL=0 disables the probe outright -> zero polls" "0" \
  "$(studiopolls "$r")"
check "...and logs no shadow line at all" "1" \
  "$(grep -q 'quota shadow:' "$(logof "$r")" && echo 0 || echo 1)"

# 29f. INERTNESS, pinned by a DIRECT call rather than end-to-end. The three ways
# the probe could reach a decision are all WRITES that a full run overwrites before
# it ends (see 29b), so they are only observable with the function called alone:
#   * `.last_quota`, the refuse-only 24h cache. Usage is monotonic and this file is
#     trusted for a DAY to refuse, so a shadow-written value would go on refusing
#     blind fires on a figure that gated nothing -- and via `quota_cache_write` it
#     would be indistinguishable from a real reading.
#   * `.last_quota_poll`, the source-2 throttle memo, whose value IS served as a
#     reading within its window (#777).
#   * STDOUT. `quota_pct`'s stdout is the percent, read in a command substitution,
#     so a stray echo here appends to it; `[ "97 10" -ge 80 ]` then returns 2 --
#     NEITHER branch -- and the gate logs "quota ok" and FIRES. That is the one
#     polarity this guard may not have, and it is why the call site redirects to
#     /dev/null as well. Both halves are asserted, since either alone is enough.
# Studio ANSWERS here (97%, a refusing figure) so the assertions cannot pass merely
# because the probe did nothing -- the stamp and the log line are checked too.
shtmp="$(mk_tmp)"
mkdir -p "$shtmp/bin" "$shtmp/infra"
printf '#!/bin/bash\necho %s\n' \
  "'"'{"account":{"claude":{"seven_day":{"utilization":0.97}}}}'"'" >"$shtmp/bin/curl"
chmod +x "$shtmp/bin/curl"
# Bounded exactly like case 17: if the source guard ever breaks, `.` runs an
# unconditional `while true` and this would hang the suite forever.
(
  set -uo pipefail
  # exported because the SOURCED file is what reads them; shellcheck cannot see
  # across the `.` and would otherwise call them unused.
  export INFRA="$shtmp/infra"
  export DLOG="$shtmp/infra/driver.log"
  export QUOTA_CACHE="$shtmp/infra/.last_quota"
  export QUOTA_POLL_MEMO="$shtmp/infra/.last_quota_poll"
  export QUOTA_SHADOW_STAMP="$shtmp/infra/.last_quota_shadow"
  export QUOTA_SHADOW_MIN_INTERVAL=3600
  export PATH="$shtmp/bin:$PATH"
  # shellcheck source=/dev/null
  . "$HERE/drive.sh"
  quota_shadow_probe dashboard
) >"$shtmp/out" 2>"$shtmp/err" &
sh_pid=$!
sh_i=0
while [ "$sh_i" -lt 15 ]; do kill -0 "$sh_pid" 2>/dev/null || break; sleep 1; sh_i=$((sh_i + 1)); done
kill -9 "$sh_pid" 2>/dev/null || true
# Ran at all? Every absence below is meaningless if it did not.
check "the probe polled studio and logged the reading (the case is not vacuous)" "0" \
  "$(grep -q 'quota shadow: studio 97%' "$shtmp/infra/driver.log" && echo 0 || echo 1)"
check "...and stamped its own rate file" "0" \
  "$([ -f "$shtmp/infra/.last_quota_shadow" ] && echo 0 || echo 1)"
check "the shadow does not write the refuse-only quota cache" "1" \
  "$([ -f "$shtmp/infra/.last_quota" ] && echo 0 || echo 1)"
check "the shadow does not write the source-2 poll memo" "1" \
  "$([ -f "$shtmp/infra/.last_quota_poll" ] && echo 0 || echo 1)"
check "the shadow emits NOTHING on stdout (a stray echo fails the gate OPEN)" "" \
  "$(cat "$shtmp/out")"
rm -rf "$shtmp"

# --- 29h-29k. #825: the shadow line says WHY, not just that it failed ---------
#
# C3 (#410) is decided on a run of these lines, and the work order reads a run of
# UNREADABLE as "studio is not ready". That inference is only sound if UNREADABLE
# is attributable: measured 2026-07-31, studio sat rate-limited for ~7.8h while
# the old dashboard's sampler held the shared account bucket, and the one probe
# taken in that window logged a bare UNREADABLE -- a fact about the ACCOUNT being
# recorded as a fact about STUDIO. These cases pin the attribution, and pin the
# two things it must never do: reach the decision path, or invent a reason.
#
# Direct-call for the same reason 29f is: the body has to be controlled exactly,
# and an end-to-end run cannot vary studio's failure SHAPE.
shrun() {  # $1 = the body curl should echo; $2 = curl's exit status (default 0).
  # Echoes the driver.log line.
  shrtmp="$(mk_tmp)"
  mkdir -p "$shrtmp/bin" "$shrtmp/infra"
  # `cat`, not printf: the bodies below carry `%` and backslash-free JSON, and a
  # format string would be one escaping bug away from testing the wrong body.
  {
    echo '#!/bin/bash'
    # Append-based call counter: the probe must take ONE sample, and a suite that
    # cannot count polls cannot tell one from two.
    echo "echo 1 >>\"$shrtmp/polls\""
    echo 'cat <<'\''BODY'\'''
    echo "$1"
    echo 'BODY'
    # A curl that FAILED still has to exit non-zero, which is the whole signal
    # the `unreachable` attribution rests on.
    echo "exit ${2:-0}"
  } >"$shrtmp/bin/curl"
  chmod +x "$shrtmp/bin/curl"
  (
    set -uo pipefail
    export INFRA="$shrtmp/infra"
    export DLOG="$shrtmp/infra/driver.log"
    export QUOTA_SHADOW_STAMP="$shrtmp/infra/.last_quota_shadow"
    export QUOTA_SHADOW_MIN_INTERVAL=3600
    export PATH="$shrtmp/bin:$PATH"
    # shellcheck source=/dev/null
    . "$HERE/drive.sh"
    quota_shadow_probe dashboard
  ) >"$shrtmp/out" 2>"$shrtmp/err" &
  shr_pid=$!
  shr_i=0
  while [ "$shr_i" -lt 15 ]; do kill -0 "$shr_pid" 2>/dev/null || break; sleep 1; shr_i=$((shr_i + 1)); done
  kill -9 "$shr_pid" 2>/dev/null || true
  # Cut at " (diagnostic", NOT at the first "(" -- the reason suffix is itself
  # parenthesised, so a `[^(]*` capture silently swallows the very thing these
  # cases assert and every one of them passes vacuously. (It did; that is why
  # this comment exists.)
  sed -n 's/.*\(quota shadow: studio .*\) (diagnostic.*/\1/p' "$shrtmp/infra/driver.log" 2>/dev/null | tail -1
  # To a FILE, not a variable: every caller runs `shrun` inside `$(...)`, and a
  # subshell's variable assignment dies with it -- the same trap that ate two
  # registries during #821. A file crosses the boundary.
  wc -l <"$shrtmp/polls" 2>/dev/null | tr -d ' \n' >"$SHR_POLLS"
  rm -rf "$shrtmp"
}
SHR_POLLS="$(mk_tmp)/polls"

# 29h. The reason rides the line. `rate_limited` specifically, because that is
# the one the C3 evidence keeps hitting and the one most wrongly read as a studio
# fault.
check "the shadow names a rate-limited account rather than blaming studio (#825)" \
  "quota shadow: studio UNREADABLE (rate_limited)" \
  "$(shrun '{"account":{"claude":null},"unavailable":{"claude":"rate_limited"}}')"

# 29i. ...and it is the SERVER's reason, not a constant. Without this, hardcoding
# the string above would pass 29h.
check "...and reports the cause it was actually given (#825)" \
  "quota shadow: studio UNREADABLE (no_credential)" \
  "$(shrun '{"account":{"claude":null},"unavailable":{"claude":"no_credential"}}')"

# 29j. A READING carries no reason suffix. The iff-contract, seen from the
# consumer: a line that both quotes a percent and explains its absence is
# incoherent, and would mean the server emitted both.
check "a readable probe logs the percent with no reason attached (#825)" \
  "quota shadow: studio 97%" \
  "$(shrun '{"account":{"claude":{"seven_day":{"utilization":0.97}}},"unavailable":{"claude":"rate_limited"}}')"

# 29k. Anything that is not a MEMBER of the contract's enum degrades to the OLD
# line rather than to a corrupted one. Five shapes, each a real way this could
# arrive: an older studio (no key at all), a wrong service on the port, a body
# trying to get its own text into an operator's log, an unbounded string, and --
# the one a shape-only check would have let through -- a well-formed lowercase
# token that simply is not one of the six causes. That last row is why this
# validates membership and not `[a-z_]`: an invented cause written into the log
# the C3 decision is read from is indistinguishable from a real one.
for sh_body in \
  '{"account":{"claude":null}}' \
  '{"account":{"claude":null},"unavailable":{"claude":null}}' \
  '{"account":{"claude":null},"unavailable":{"claude":"RATE LIMITED; rm -rf /"}}' \
  '{"account":{"claude":null},"unavailable":{"claude":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}' \
  '{"account":{"claude":null},"unavailable":{"claude":"ok"}}'; do
  check "an unrecognised reason degrades to the bare line, never a corrupt one (#825)" \
    "quota shadow: studio UNREADABLE" "$(shrun "$sh_body")"
done

# 29l. ONE sample, not two. The percent and the reason must come from the SAME
# response: studio re-polls its provider once its throttle window elapses, so a
# second call can legitimately answer differently, and the probe would then
# attribute a cause that belongs to a reading it did not log. Reading the body
# once is what forbids that, and this is the assertion that keeps it true -- a
# refactor back to two `quota_read_url`-style calls goes red here.
check "the probe takes ONE sample, so the reason belongs to the reading (#825)" "1" \
  "$(shrun '{"account":{"claude":null},"unavailable":{"claude":"rate_limited"}}' >/dev/null; cat "$SHR_POLLS")"

# 29m. The reason NEVER reaches the decision path. `quota_read_url` is what
# `quota_pct` reads, and a stray token on its stdout makes `[ "$x" -ge "$y" ]`
# return 2 -- neither branch, so the gate logs "quota ok" and FIRES. The one
# polarity this guard may not have, and the reason the parse is split rather than
# widened.
shdrun() {  # $1 = body; echoes what the DECISION path makes of it
  shdtmp="$(mk_tmp)"
  mkdir -p "$shdtmp/bin"
  {
    echo '#!/bin/bash'
    echo 'cat <<'\''BODY'\'''
    echo "$1"
    echo 'BODY'
  } >"$shdtmp/bin/curl"
  chmod +x "$shdtmp/bin/curl"
  (
    set -uo pipefail
    export PATH="$shdtmp/bin:$PATH"
    # shellcheck source=/dev/null
    . "$HERE/drive.sh"
    quota_read_url http://studio.invalid/api/quota
  )
  rm -rf "$shdtmp"
}
# The POSITIVE control FIRST. The assertion below is an absence, and an absence
# proves nothing if the harness never reached the code -- an unsourced drive.sh
# or an unconsulted stub would satisfy it just as well. This says the same
# harness does produce a percent when there is one to produce.
check "the decision path still reads a percent through the split parse (#825)" "97" \
  "$(shdrun '{"account":{"claude":{"seven_day":{"utilization":0.97}}},"unavailable":{"claude":"rate_limited"}}')"
check "an attributed UNREADABLE still reads as UNREADABLE on the decision path (#825)" "" \
  "$(shdrun '{"account":{"claude":null},"unavailable":{"claude":"rate_limited"}}')"

# 29n. An UNREACHABLE studio is named as such, not left bare. The bucket C3 most
# needs separated: "nothing answered" is a lifecycle fault (#765 Defect 2), not
# evidence that studio's reader cannot do its job. Derived from curl's exit
# status, so it is the one cause this driver knows without being told.
check "nothing answering on the port is logged as unreachable, not as a bare UNREADABLE (#825)" \
  "quota shadow: studio UNREADABLE (unreachable)" "$(shrun '' 7)"

# ...and a SERVED body wins over curl's status, so a server that answered and
# explained itself is never relabelled by the weaker local signal.
check "a served reason outranks the locally-derived unreachable (#825)" \
  "quota shadow: studio UNREADABLE (rate_limited)" \
  "$(shrun '{"account":{"claude":null},"unavailable":{"claude":"rate_limited"}}' 7)"

# 29g. An UNWRITABLE rate stamp SKIPS the poll -- it does not silently UN-THROTTLE
# it. Every other writer in this file can afford `|| true` because a lost write
# fails SAFE: no cache entry means the guard takes the blind path, no memo means
# source 2 is re-read. This one is the exception. `quota_stamped_read` on a missing
# file returns empty, which the probe reads as "the window is open", so a stamp
# that can NEVER be written means the throttle is silently gone and studio is
# polled on every `quota_pct` call -- up to 3 per iteration plus one per
# AUTH_LONG_BLOCK retry, unbounded during a long block. A diagnostic that cannot
# record when it last ran has no business running.
#
# Direct-call, like 29f: an end-to-end run cannot make ONE path unwritable without
# breaking $INFRA for the cache and the driver log too, and the case would then
# pass for the wrong reason.
sgrun() {  # $1 = stamp path, $2 = infra dir. The curl stub marks $sgtmp/polled.
  rm -f "$sgtmp/polled"
  mkdir -p "$2"
  # Bounded exactly like 29f: if the source guard ever breaks, `.` runs an
  # unconditional `while true` and this would hang the suite forever.
  (
    set -uo pipefail
    # exported because the SOURCED file is what reads them; shellcheck cannot see
    # across the `.` and would otherwise call them unused.
    export INFRA="$2"
    export DLOG="$2/driver.log"
    export QUOTA_CACHE="$2/.last_quota"
    export QUOTA_POLL_MEMO="$2/.last_quota_poll"
    export QUOTA_SHADOW_STAMP="$1"
    export QUOTA_SHADOW_MIN_INTERVAL=3600
    export PATH="$sgtmp/bin:$PATH"
    # shellcheck source=/dev/null
    . "$HERE/drive.sh"
    quota_shadow_probe dashboard
  ) >"$2/out" 2>"$2/err" &
  sg_pid=$!
  sg_i=0
  while [ "$sg_i" -lt 15 ]; do kill -0 "$sg_pid" 2>/dev/null || break; sleep 1; sg_i=$((sg_i + 1)); done
  kill -9 "$sg_pid" 2>/dev/null || true
}
sgtmp="$(mk_tmp)"
mkdir -p "$sgtmp/bin"
printf '#!/bin/bash\n: >"%s/polled"\necho %s\n' "$sgtmp" \
  "'"'{"account":{"claude":{"seven_day":{"utilization":0.97}}}}'"'" >"$sgtmp/bin/curl"
chmod +x "$sgtmp/bin/curl"
# CONTROL FIRST. Without it, "no poll happened" below would be satisfied by a probe
# that failed to run for any reason at all -- a vacuous pass.
sgrun "$sgtmp/ok/.last_quota_shadow" "$sgtmp/ok"
check "control: the same harness with a WRITABLE stamp does poll" "0" \
  "$([ -f "$sgtmp/polled" ] && echo 0 || echo 1)"
# The real case: the stamp's PARENT directory does not exist, so the write fails.
sgrun "$sgtmp/bad/nodir/.last_quota_shadow" "$sgtmp/bad"
check "an unwritable rate stamp SKIPS the poll rather than un-throttling it" "1" \
  "$([ -f "$sgtmp/polled" ] && echo 0 || echo 1)"
check "...and says so in the log, rather than skipping silently" "0" \
  "$(grep -q 'quota shadow: skipped' "$sgtmp/bad/driver.log" && echo 0 || echo 1)"
rm -rf "$sgtmp"

# --- 43. #808 DRIVER-CODE drift: is the running process the code that merged? --
# The live plane is an unversioned hand-synced copy, and drive.sh's body is a
# plain `while true` with no exec and no re-source -- so replacing the file does
# NOT deploy it. Verified on 2026-07-31: the live drive.sh was byte-identical to
# origin/main while the running driver held a 13KB-older inode, and #765's shadow
# probe had therefore never executed despite being merged AND synced.
#
# Hashing the file against origin/main cannot see this: it reports GREEN. The
# only thing that can is comparing the file NOW against what it was when this
# process booted. Every failure path must read UNKNOWN, never `live` -- the same
# rule that keeps UNREADABLE distinct from 0% in the quota guard.
dctmp="$(mk_tmp)"
mkdir -p "$dctmp/infra"
printf '#!/bin/bash\necho boot\n' >"$dctmp/fake_drive.sh"
# Bounded exactly like case 17: a broken source guard turns `.` into an
# unconditional `while true` and would hang the suite forever.
(
  set -uo pipefail
  # exported because the SOURCED file is what reads them; shellcheck cannot see
  # across the `.` and would otherwise call them unused.
  export INFRA="$dctmp/infra"
  export DLOG="$dctmp/infra/driver.log"
  export DRIVE_SELF="$dctmp/fake_drive.sh"
  # shellcheck source=/dev/null
  . "$HERE/drive.sh"
  # (a) no boot hash recorded at all -- the pre-#808 driver, and any run whose
  #     startup hash failed. UNKNOWN, never a clean bill of health.
  drift_report_driver_code
  # (b) file unchanged since boot -> live. Exported for the same reason as the
  #     vars above: the SOURCED file is what reads it.
  export DRIVE_BOOT_HASH
  DRIVE_BOOT_HASH="$(drive_self_hash)"
  drift_report_driver_code
  # (c) the file changed underneath the running process -> STALE. Mutated by
  #     APPENDING, never by `git checkout --`/`restore`/`stash` (loop rule: those
  #     destroy uncommitted work). This file was created by this case.
  printf 'echo synced\n' >>"$dctmp/fake_drive.sh"
  drift_report_driver_code
  # (d) the file is gone/unreadable now -> UNKNOWN, not STALE and not live.
  DRIVE_SELF="$dctmp/never_existed.sh"
  drift_report_driver_code
) >"$dctmp/out" 2>"$dctmp/err" &
dc_pid=$!
dc_i=0
while [ "$dc_i" -lt 15 ]; do kill -0 "$dc_pid" 2>/dev/null || break; sleep 1; dc_i=$((dc_i + 1)); done
kill -9 "$dc_pid" 2>/dev/null || true
dclog="$dctmp/infra/driver.log"
# Ran at all? Every absence below is meaningless if it did not.
check "the driver-code check emitted all four verdicts (the case is not vacuous)" "4" \
  "$(grep -c 'driver code:' "$dclog" 2>/dev/null || echo 0)"
check "no boot hash reads UNKNOWN, never live" "0" \
  "$(sed -n '1p' "$dclog" 2>/dev/null | grep -q 'driver code: UNKNOWN' && echo 0 || echo 1)"
check "an unchanged file reads live" "0" \
  "$(sed -n '2p' "$dclog" 2>/dev/null | grep -q 'driver code: live' && echo 0 || echo 1)"
check "a file changed since boot reads STALE -- the merged fix is NOT running" "0" \
  "$(sed -n '3p' "$dclog" 2>/dev/null | grep -q 'driver code: STALE' && echo 0 || echo 1)"
check "...and names the restart as the remedy, since a sync alone does nothing" "0" \
  "$(sed -n '3p' "$dclog" 2>/dev/null | grep -q 'kickstart' && echo 0 || echo 1)"
check "an unreadable file reads UNKNOWN, not live and not STALE" "0" \
  "$(sed -n '4p' "$dclog" 2>/dev/null | grep -q 'driver code: UNKNOWN' && echo 0 || echo 1)"
check "the driver-code check emits NOTHING on stdout (a stray echo corrupts callers)" "" \
  "$(cat "$dctmp/out" 2>/dev/null)"

# --- 43b. a RELATIVE self-path survives drive.sh's own `cd "$REPO"` -----------
# `$0` is `./drive.sh` for any manual run, and the hash is re-taken every fire --
# by which time the driver has cd'd to the repo, so a relative path hashes
# nothing and the check reads UNKNOWN for the rest of the run. Safe rather than
# open, but silently gone, which is the failure class this ticket is about.
: >"$dctmp/infra/driver.log"
(
  set -uo pipefail
  # exported because the SOURCED file is what reads them; shellcheck cannot see
  # across the `.` and would otherwise call them unused.
  export INFRA="$dctmp/infra"
  export DLOG="$dctmp/infra/driver.log"
  export DRIVE_SELF="./fake_drive.sh"
  export DRIVE_BOOT_HASH
  # cd FIRST, so the relative path is meaningful when drive.sh resolves it.
  cd "$dctmp" || exit 1
  # shellcheck source=/dev/null
  . "$HERE/drive.sh"
  DRIVE_BOOT_HASH="$(drive_self_hash)"
  cd / || exit 1   # stand in for drive.sh's own `cd "$REPO"` between boot and fire
  drift_report_driver_code
) >"$dctmp/out2" 2>&1 &
dcr_pid=$!
dcr_i=0
while [ "$dcr_i" -lt 15 ]; do kill -0 "$dcr_pid" 2>/dev/null || break; sleep 1; dcr_i=$((dcr_i + 1)); done
kill -9 "$dcr_pid" 2>/dev/null || true
check "a relative self-path still reads live after a cd, not UNKNOWN" "0" \
  "$(grep -q 'driver code: live' "$dclog" 2>/dev/null && echo 0 || echo 1)"
rm -rf "$dctmp"

# --- 44. #808 PLANE drift: is the live plane the code that merged? ------------
# The other half of the same question, and the half that is USELESS ALONE (in
# the 2026-07-31 incident the plane was in sync and the process was not). Uses a
# REAL git repo rather than a stubbed one: the thing under test is a git
# comparison, so stubbing git would assert on the mock.
pdtmp="$(mk_tmp)"
git init -q --bare "$pdtmp/origin" 2>/dev/null
mkdir -p "$pdtmp/src/loop/sub" "$pdtmp/infra/sub"
git init -q "$pdtmp/src" 2>/dev/null
git -C "$pdtmp/src" checkout -q -b main 2>/dev/null
printf 'A\n' >"$pdtmp/src/loop/drive.sh"
printf 'B\n' >"$pdtmp/src/loop/run.sh"
# A SUBDIRECTORY on main. `ls-tree` without -r emits the TREE `loop/sub`, which
# is not a file in the plane -- so a correctly synced subdir read
# `sub(never synced)` forever while its contents went uncompared.
printf 'C\n' >"$pdtmp/src/loop/sub/nested.sh"
# A NON-ASCII name. `ls-tree` C-quotes it (`"loop/caf\303\251.sh"`) unless -z is
# used; the leading quote defeated the `loop/` strip and the file was skipped in
# SILENCE, i.e. reported as "in sync" while never being compared at all.
printf 'D\n' >"$pdtmp/src/loop/café.sh"
git -C "$pdtmp/src" add -A >/dev/null 2>&1
git -C "$pdtmp/src" -c user.email=t@t -c user.name=t commit -qm init >/dev/null 2>&1
git -C "$pdtmp/src" remote add origin "$pdtmp/origin" 2>/dev/null
git -C "$pdtmp/src" push -q origin main 2>/dev/null
# REPO is a git WORKTREE, because the real one is: `~/Dev/studio-loop-repo/.git`
# is an 80-byte FILE holding a gitdir pointer, not a directory. The first draft
# gated on `[ -d "$REPO/.git" ]` and therefore returned UNKNOWN on every fire in
# production while every test passed against a plain `git init` fixture. The
# fixture has to be the shape production uses or it certifies nothing.
git -C "$pdtmp/src" worktree add -q --detach "$pdtmp/repo" main >/dev/null 2>&1
cp "$pdtmp/src/loop/drive.sh" "$pdtmp/src/loop/run.sh" "$pdtmp/src/loop/café.sh" "$pdtmp/infra/"
cp "$pdtmp/src/loop/sub/nested.sh" "$pdtmp/infra/sub/"
check "the fixture REPO is worktree-shaped (.git is a FILE, as in production)" "0" \
  "$([ -f "$pdtmp/repo/.git" ] && [ ! -d "$pdtmp/repo/.git" ] && echo 0 || echo 1)"
(
  set -uo pipefail
  # exported only to stop shellcheck calling them unused -- it cannot see across
  # the `.`. A plain assignment would be read fine: sourcing runs in this shell.
  export INFRA="$pdtmp/infra"
  export REPO="$pdtmp/repo"
  export DLOG="$pdtmp/infra/driver.log"
  # shellcheck source=/dev/null
  . "$HERE/drive.sh"
  # (a) every tracked loop/ file present and identical -- including the
  #     subdirectory and the non-ASCII name -> in sync.
  drift_report_plane
  # (b) a live file whose CONTENT differs from origin/main -> named.
  printf 'A-modified\n' >"$pdtmp/infra/drive.sh"
  drift_report_plane
  # (c) a file on main that was never synced at all -> named, NOT skipped. The
  #     naive "for each file present in both" enumeration reports this as
  #     nothing, which is the strongest drift signal read as silence.
  rm -f "$pdtmp/infra/run.sh"
  drift_report_plane
  # (d) a NESTED file differs -> named by its path under loop/, proving -r
  #     compares subdirectory contents rather than stopping at the tree.
  printf 'C-modified\n' >"$pdtmp/infra/sub/nested.sh"
  drift_report_plane
  # (e) the NON-ASCII file differs -> named. Without -z this file is invisible
  #     to the walk, so a difference here would read as "in sync".
  printf 'D-modified\n' >"$pdtmp/infra/café.sh"
  drift_report_plane
  # (f) a live file that cannot be read -> (unreadable), never "same". With the
  #     old `git show | shasum` this branch was UNREACHABLE: shasum hashes empty
  #     input to the sha1 of the empty string rather than failing.
  chmod 000 "$pdtmp/infra/café.sh" 2>/dev/null
  drift_report_plane
  chmod 644 "$pdtmp/infra/café.sh" 2>/dev/null
  # (g) origin/main cannot be refreshed -> UNKNOWN. A cached ref that a failed
  #     fetch left unrefreshed must never be reported as "in sync".
  mv "$pdtmp/origin" "$pdtmp/origin-moved"
  drift_report_plane
  # (h) REPO is not a git checkout at all -> UNKNOWN, not a crash.
  REPO="$pdtmp/not-a-repo"
  drift_report_plane
) >"$pdtmp/out" 2>"$pdtmp/err" &
pd_pid=$!
pd_i=0
while [ "$pd_i" -lt 30 ]; do kill -0 "$pd_pid" 2>/dev/null || break; sleep 1; pd_i=$((pd_i + 1)); done
kill -9 "$pd_pid" 2>/dev/null || true
pdlog="$pdtmp/infra/driver.log"
check "the plane check emitted all eight verdicts (the case is not vacuous)" "8" \
  "$(grep -c 'plane drift:' "$pdlog" 2>/dev/null || echo 0)"
check "an identical live plane reads in sync (subdir + non-ASCII included)" "0" \
  "$(sed -n '1p' "$pdlog" 2>/dev/null | grep -q 'plane drift: in sync' && echo 0 || echo 1)"
check "a live file differing from origin/main is NAMED" "0" \
  "$(sed -n '2p' "$pdlog" 2>/dev/null | grep -q 'drive.sh' && echo 0 || echo 1)"
check "...and is not still reported as in sync" "1" \
  "$(sed -n '2p' "$pdlog" 2>/dev/null | grep -q 'in sync' && echo 0 || echo 1)"
check "a file on main but ABSENT from the live plane is drift, not silence" "0" \
  "$(sed -n '3p' "$pdlog" 2>/dev/null | grep -q 'run.sh(never synced)' && echo 0 || echo 1)"
check "a differing file INSIDE a subdirectory is named by its path" "0" \
  "$(sed -n '4p' "$pdlog" 2>/dev/null | grep -q 'sub/nested.sh' && echo 0 || echo 1)"
check "...and the subdirectory itself is never reported as a missing file" "1" \
  "$(grep -q 'sub(never synced)' "$pdlog" 2>/dev/null && echo 0 || echo 1)"
check "a differing NON-ASCII filename is named, not silently skipped" "0" \
  "$(sed -n '5p' "$pdlog" 2>/dev/null | grep -q 'caf' && echo 0 || echo 1)"
check "an unreadable live file reads (unreadable), never as matching" "0" \
  "$([ "$(id -u)" = 0 ] && echo 0 || { sed -n '6p' "$pdlog" 2>/dev/null | grep -q '(unreadable)' && echo 0 || echo 1; })"
check "an unfetchable origin/main reads UNKNOWN, never in sync" "0" \
  "$(sed -n '7p' "$pdlog" 2>/dev/null | grep -q 'plane drift: UNKNOWN' && echo 0 || echo 1)"
check "a REPO that is not a git checkout reads UNKNOWN" "0" \
  "$(sed -n '8p' "$pdlog" 2>/dev/null | grep -q 'plane drift: UNKNOWN' && echo 0 || echo 1)"
check "the plane check emits NOTHING on stdout" "" \
  "$(cat "$pdtmp/out" 2>/dev/null)"

# --- 44b. #808 the kill switch fails LOUD, not silent -------------------------
# The only control over this monitor. `= "1"` would have let `DRIFT_REPORT=no`
# switch it off without a word -- a monitor a typo disables silently fails in
# the direction it is monitoring.
# The two calls write to SEPARATE logs -- sharing one would let the second call's
# output satisfy the first assertion, and "silenced" is exactly the claim that
# cannot be checked against a log something else has since written to.
(
  set -uo pipefail
  # exported only to stop shellcheck calling them unused (see above).
  export INFRA="$pdtmp/infra"
  export REPO="$pdtmp/not-a-repo"
  export DLOG="$pdtmp/infra/off.log"
  export DRIFT_REPORT=0
  # shellcheck source=/dev/null
  . "$HERE/drive.sh"
  drift_report
  DRIFT_REPORT=no   # a typo, NOT the documented value
  DLOG="$pdtmp/infra/typo.log"
  drift_report
) >/dev/null 2>&1 &
ks_pid=$!
ks_i=0
while [ "$ks_i" -lt 15 ]; do kill -0 "$ks_pid" 2>/dev/null || break; sleep 1; ks_i=$((ks_i + 1)); done
kill -9 "$ks_pid" 2>/dev/null || true
check "DRIFT_REPORT=0 silences the report entirely" "1" \
  "$([ -s "$pdtmp/infra/off.log" ] && echo 0 || echo 1)"
check "...but an undocumented value still REPORTS rather than silently disabling" "3" \
  "$(grep -cE 'driver code:|plane drift:|studio server:' "$pdtmp/infra/typo.log" 2>/dev/null || echo 0)"
rm -rf "$pdtmp"

# --- 44c. #832 STUDIO-SERVER drift: is the QUOTA SOURCE running merged code? --
# The THIRD half of the same question, about the third process in it. WHY it
# exists, why identity comes from the running service rather than the
# installer's build stamp, and why it is detection-only rather than an updater:
# `drift_report_studio_server`'s header in drive.sh is the canonical statement
# and this file does not restate it (#776).
#
# A REAL git repo (the comparison under test is a git one; stubbing git would
# assert on the mock) plus a stubbed curl (the served body has to be controlled
# exactly, including the shapes a live server will not produce on demand).
sstmp="$(mk_tmp)"
git init -q --bare "$sstmp/origin" 2>/dev/null
mkdir -p "$sstmp/src/studio" "$sstmp/src/loop" "$sstmp/bin" "$sstmp/infra"
git init -q "$sstmp/src" 2>/dev/null
git -C "$sstmp/src" checkout -q -b main 2>/dev/null
sscommit() { # $1=path $2=content -> commits and echoes the short sha
  printf '%s\n' "$2" >"$sstmp/src/$1"
  git -C "$sstmp/src" add -A >/dev/null 2>&1
  git -C "$sstmp/src" -c user.email=t@t -c user.name=t commit -qm "$1" >/dev/null 2>&1
  git -C "$sstmp/src" rev-parse --short HEAD
}
# THREE commits, and the ORDER is the case: a `studio/` change in the middle and
# a `loop/`-only change at the tip. That is what makes "behind, but by nothing
# that could have changed what it serves" reachable -- the verdict this half
# turns on, and the one a sha-equality check cannot express.
ss_old="$(sscommit studio/x old)"
# A BRANCH LITERALLY NAMED `dev`. `build-info.ts` serves `commit: 'dev'` as its
# no-manifest placeholder, and a reader that hands that straight to `rev-parse`
# resolves it against this ref and reports a confident verdict about a build
# whose identity it never learned. The hex guard is what stops that, and this
# ref is what makes the case able to fail.
git -C "$sstmp/src" branch dev >/dev/null 2>&1
ss_studio="$(sscommit studio/x new)"
ss_tip="$(sscommit loop/y touched)"
# A commit that DIVERGES from main rather than trailing it. `rev-list A..B` on a
# non-ancestor counts what B has that A lacks, which for a rebased-out or
# force-pushed build is a number with no meaning -- and a meaningless number
# stated confidently is worse than none. main is branch-protected, so this is
# unlikely rather than impossible, and the guard is only real if something
# reaches it.
git -C "$sstmp/src" checkout -q dev 2>/dev/null
ss_diverged="$(sscommit studio/z sidebranch)"
git -C "$sstmp/src" checkout -q main 2>/dev/null
git -C "$sstmp/src" remote add origin "$sstmp/origin" 2>/dev/null
git -C "$sstmp/src" push -q origin main dev 2>/dev/null
# Worktree-shaped, because production is: `~/Dev/studio-loop-repo/.git` is a
# FILE holding a gitdir pointer, and case 44 records what gating on `[ -d .git ]`
# cost when the fixture was shaped differently from the thing it stands in for.
git -C "$sstmp/src" worktree add -q --detach "$sstmp/repo" main >/dev/null 2>&1
ss_tipsha="$(git -C "$sstmp/repo" rev-parse --short origin/main 2>/dev/null)"
ssrun() {  # $1 = the /api/version body curl echoes; $2 = curl's exit status
  {
    echo '#!/bin/bash'
    echo 'cat <<'\''BODY'\'''
    echo "$1"
    echo 'BODY'
    # A curl that failed must still exit non-zero: "nothing answered on the
    # port" is a LIFECYCLE fault, and reporting it as a drift verdict would
    # blame the wrong thing entirely.
    echo "exit ${2:-0}"
  } >"$sstmp/bin/curl"
  chmod +x "$sstmp/bin/curl"
  rm -f "$sstmp/infra/driver.log" "$sstmp/out" "$sstmp/err"
  (
    set -uo pipefail
    export INFRA="$sstmp/infra"
    export REPO="${SS_REPO:-$sstmp/repo}"
    export DLOG="$sstmp/infra/driver.log"
    export PATH="$sstmp/bin:$PATH"
    # shellcheck source=/dev/null
    . "$HERE/drive.sh"
    drift_report_studio_server
  ) >"$sstmp/out" 2>"$sstmp/err" &
  ss_pid=$!
  ss_i=0
  while [ "$ss_i" -lt 20 ]; do kill -0 "$ss_pid" 2>/dev/null || break; sleep 1; ss_i=$((ss_i + 1)); done
  kill -9 "$ss_pid" 2>/dev/null || true
  sed -n 's/.*\(studio server: .*\)/\1/p' "$sstmp/infra/driver.log" 2>/dev/null | tail -1
}
# BODIES ARE BUILT ONCE, BY CONCATENATION, AND NEVER INLINE IN A `check`.
# `check "..." "$(ssrun "{\"commit\":\"$x\"}" | grep ...)"` nests an escaped
# double quote inside a command substitution inside a double-quoted argument,
# and bash delivers a MANGLED body from that -- which parses as no JSON at all,
# which every UNKNOWN case below then passes on VACUOUSLY while asserting
# nothing. (It did: the in-sync case was the only one that could notice, and it
# was the only one that failed.) One quoting level, one body, asserted below.
ss_body_tip='{"version":"0.0.0-dev","commit":"'"$ss_tipsha"'"}'
ss_body_studio='{"version":"0.0.0-dev","commit":"'"$ss_studio"'"}'
ss_body_old='{"version":"0.0.0-dev","commit":"'"$ss_old"'"}'
ss_body_div='{"version":"0.0.0-dev","commit":"'"$ss_diverged"'"}'
# The anti-vacuity gate for the whole case: python, not the parser under test,
# confirming the fixture's own bodies are well formed and carry the commits the
# assertions below believe they carry. Without this, a fixture typo turns every
# UNKNOWN assertion green.
ss_wellformed() { # $1=body $2=expected commit -> "ok" or a diagnostic
  printf '%s' "$1" | python3 -c "
import sys, json
try:
    print('ok' if json.load(sys.stdin).get('commit') == '$2' else 'wrong-commit')
except Exception as e:
    print('unparseable: %s' % e)
" 2>/dev/null
}
check "the fixture REPO is worktree-shaped (.git is a FILE, as in production)" "0" \
  "$([ -f "$sstmp/repo/.git" ] && [ ! -d "$sstmp/repo/.git" ] && echo 0 || echo 1)"
check "the fixture's three commits are distinct (the case is not vacuous)" "1" \
  "$([ -n "$ss_old" ] && [ -n "$ss_studio" ] && [ -n "$ss_tipsha" ] &&
     [ "$ss_old" != "$ss_studio" ] && [ "$ss_studio" != "$ss_tipsha" ] && echo 1 || echo 0)"
check "the fixture tip is the loop/-only commit (so 'behind but current' is reachable)" "1" \
  "$([ "$ss_tipsha" = "$ss_tip" ] && echo 1 || echo 0)"
check "the tip fixture body is well formed and carries origin/main's commit" "ok" \
  "$(ss_wellformed "$ss_body_tip" "$ss_tipsha")"
check "the studio-commit fixture body is well formed" "ok" \
  "$(ss_wellformed "$ss_body_studio" "$ss_studio")"
check "the oldest fixture body is well formed" "ok" \
  "$(ss_wellformed "$ss_body_old" "$ss_old")"
check "the diverged fixture body is well formed" "ok" \
  "$(ss_wellformed "$ss_body_div" "$ss_diverged")"
check "the diverged commit really is NOT an ancestor of main (not vacuous)" "1" \
  "$(git -C "$sstmp/repo" merge-base --is-ancestor "$ss_diverged" origin/main 2>/dev/null && echo 0 || echo 1)"
# (a) the running service serves origin/main's commit -> current, identical.
ss_sync="$(ssrun "$ss_body_tip")"
check "a service serving origin/main's commit reads current" "0" \
  "$(printf '%s' "$ss_sync" | grep -q 'studio server: current' && echo 0 || echo 1)"
check "...naming the commit it is serving, so the line is evidence on its own" "0" \
  "$(printf '%s' "$ss_sync" | grep -q "$ss_tipsha" && echo 0 || echo 1)"
check "...and the in-sync path emits NOTHING on stdout" "" \
  "$(cat "$sstmp/out" 2>/dev/null)"
# (b) BEHIND, but only by a loop/-only commit -> still CURRENT for what it
#     serves. This service is built from `studio/` alone, and a sha-equality
#     verdict would call it stale here -- which, with prompt.md's rule that a
#     stale build's evidence does not count, would discard readings from a
#     perfectly current reader. Measured on this repo: 8 of 19 commits in 24h
#     touched studio/, against a probe throttled to one an hour.
ss_near="$(ssrun "$ss_body_studio")"
check "a service behind by a loop/-only commit still reads current for studio/" "0" \
  "$(printf '%s' "$ss_near" | grep -q 'studio server: current for studio/' && echo 0 || echo 1)"
check "...and is NOT called STALE" "1" \
  "$(printf '%s' "$ss_near" | grep -q 'STALE' && echo 0 || echo 1)"
check "...while still disclosing the distance it is discounting" "0" \
  "$(printf '%s' "$ss_near" | grep -q 'by 1 commit(s), none touching studio/' && echo 0 || echo 1)"
# (c) behind by a commit that DOES touch studio/ -> STALE, naming the counts and
#     the remedy. This is the 2026-07-31 state, and the point of the half.
ss_stale="$(ssrun "$ss_body_old")"
check "a service behind by a studio/ commit reads STALE" "0" \
  "$(printf '%s' "$ss_stale" | grep -q 'studio server: STALE' && echo 0 || echo 1)"
check "...naming the commit it is actually serving" "0" \
  "$(printf '%s' "$ss_stale" | grep -q "$ss_old" && echo 0 || echo 1)"
check "...and how many of the commits behind touch studio/" "0" \
  "$(printf '%s' "$ss_stale" | grep -q '2 commit(s) behind' && printf '%s' "$ss_stale" | grep -q '1 of them touching studio/' && echo 0 || echo 1)"
check "...and the remedy, so the line is actionable where it is read" "0" \
  "$(printf '%s' "$ss_stale" | grep -q 'install_studio_server.sh --update' && echo 0 || echo 1)"
check "...and saying the C3 evidence it produced is about that build" "0" \
  "$(printf '%s' "$ss_stale" | grep -q 'quota shadow' && echo 0 || echo 1)"
check "...and is never also reported as current" "1" \
  "$(printf '%s' "$ss_stale" | grep -q 'current' && echo 0 || echo 1)"
check "...and the STALE path emits NOTHING on stdout" "" \
  "$(cat "$sstmp/out" 2>/dev/null)"
# (c2) a DIVERGED build -> STALE, but with no count offered. The remedy is the
#      same; the distance is not a thing that can be stated.
ss_div="$(ssrun "$ss_body_div")"
check "a diverged build reads STALE" "0" \
  "$(printf '%s' "$ss_div" | grep -q 'studio server: STALE' && echo 0 || echo 1)"
check "...saying it is not an ancestor, rather than inventing a distance" "0" \
  "$(printf '%s' "$ss_div" | grep -q 'not an ancestor' && echo 0 || echo 1)"
check "...and quotes no commit count at all" "1" \
  "$(printf '%s' "$ss_div" | grep -q 'commit(s) behind' && echo 0 || echo 1)"
# (d) the `dev` PLACEHOLDER -> UNKNOWN, never resolved against the `dev` branch.
#     Without the hex guard `rev-parse dev^{commit}` succeeds here and the half
#     announces a verdict about a build it cannot identify.
ss_dev="$(ssrun '{"version":"0.0.0-dev","commit":"dev"}')"
check "the 'dev' placeholder reads UNKNOWN, not a verdict" "0" \
  "$(printf '%s' "$ss_dev" | grep -q 'studio server: UNKNOWN' && echo 0 || echo 1)"
check "...and is NOT resolved against a branch that happens to be named dev" "1" \
  "$(printf '%s' "$ss_dev" | grep -qE 'current|STALE' && echo 0 || echo 1)"
# (e) hex, but not a commit this checkout knows -> UNKNOWN, not STALE, no crash.
ss_unk="$(ssrun '{"version":"1.0.0","commit":"0123456789abcdef0123456789abcdef01234567"}')"
check "a commit this checkout does not know reads UNKNOWN" "0" \
  "$(printf '%s' "$ss_unk" | grep -q 'studio server: UNKNOWN' && echo 0 || echo 1)"
check "...and is not guessed at as STALE" "1" \
  "$(printf '%s' "$ss_unk" | grep -q 'STALE' && echo 0 || echo 1)"
# (f) nothing answered on the port -> UNKNOWN, and never current. An empty body
#     and an empty `rev-parse` are both "", so a bare equality test reads a DOWN
#     SERVER as a healthy one -- the fail-open this file keeps rediscovering
#     (`quota_stamped_read`'s `10#`, `drift_report_plane`'s blob ids). It is
#     also named as a LIFECYCLE fault rather than as drift, because rebuilding a
#     service that was never up fixes nothing.
ss_down="$(ssrun '' 7)"
check "an unreachable service reads UNKNOWN" "0" \
  "$(printf '%s' "$ss_down" | grep -q 'studio server: UNKNOWN' && echo 0 || echo 1)"
check "...blaming the LIFECYCLE, not the build it never learned" "0" \
  "$(printf '%s' "$ss_down" | grep -q 'LIFECYCLE' && echo 0 || echo 1)"
check "...and is never reported as current" "1" \
  "$(printf '%s' "$ss_down" | grep -q 'current' && echo 0 || echo 1)"
# (g) something answered, but not with a version -- an older studio, or any
#     other service on the port. #765 records a wrong-but-answering server 404ing
#     and reading as healthy forever.
check "a body carrying no commit reads UNKNOWN" "0" \
  "$(printf '%s' "$(ssrun '{"version":"0.0.0-dev"}')" | grep -q 'studio server: UNKNOWN' && echo 0 || echo 1)"
check "a non-JSON body reads UNKNOWN rather than crashing" "0" \
  "$(printf '%s' "$(ssrun '<html>404 not found</html>')" | grep -q 'studio server: UNKNOWN' && echo 0 || echo 1)"
# (h) an EMPTY commit -- the other half of the empty-equals-empty trap, this one
#     reachable from a served body rather than from a dead port.
check "an empty commit string reads UNKNOWN, never current" "0" \
  "$(printf '%s' "$(ssrun '{"version":"1.0.0","commit":""}')" | grep -q 'studio server: UNKNOWN' && echo 0 || echo 1)"
# (i) origin/main could not be refreshed -> UNKNOWN. `origin/main` is a CACHED
#     ref: a failed fetch leaves the last one in place, which compares equal to
#     whatever was current then and reads healthy forever. Same discipline as
#     drift_report_plane, and the reason both halves fetch for themselves.
mv "$sstmp/origin" "$sstmp/origin-moved"
ss_nofetch="$(ssrun "$ss_body_tip")"
check "an unfetchable origin/main reads UNKNOWN, never current" "0" \
  "$(printf '%s' "$ss_nofetch" | grep -q 'studio server: UNKNOWN' && echo 0 || echo 1)"
check "...and says so about the REFRESH, not about the service" "0" \
  "$(printf '%s' "$ss_nofetch" | grep -q 'could not be refreshed' && echo 0 || echo 1)"
mv "$sstmp/origin-moved" "$sstmp/origin"
# (j) REPO is not a git checkout at all -> UNKNOWN, not a crash.
check "a REPO that is not a git checkout reads UNKNOWN" "0" \
  "$(SS_REPO="$sstmp/not-a-repo" ssrun "$ss_body_tip" | grep -q 'studio server: UNKNOWN' && echo 0 || echo 1)"
check "...and that path emits NOTHING on stdout either" "" \
  "$(cat "$sstmp/out" 2>/dev/null)"
rm -rf "$sstmp"

# --- 44d. #832 the version URL is DERIVED, so the port keeps one owner --------
# The service port already has exactly two copies (`STUDIO_QUOTA_URL` here,
# `DEFAULT_PORT` in install_studio_server.sh) and a test asserting they agree.
# A third, spelled out for /api/version, is how the stale 8080 pin outlived its
# own reason -- and the failure would be quiet in the worst way: the drift half
# would ask a DIFFERENT process than the guard polls and report a build nobody
# was running. These assert the derivation is real, not that a literal is typed
# correctly.
vurl() { # $1 = STUDIO_QUOTA_URL override ("" = default) -> the derived version URL
  ( set -uo pipefail
    [ -n "$1" ] && export STUDIO_QUOTA_URL="$1"
    # shellcheck source=/dev/null
    . "$HERE/drive.sh"
    printf '%s' "$STUDIO_VERSION_URL" )
}
check "the default version URL sits on the quota URL's own host and port" "0" \
  "$([ "$(vurl '')" = "http://127.0.0.1:8788/api/version" ] && echo 0 || echo 1)"
# The load-bearing one: move the quota URL and the version URL MUST follow. A
# hardcoded literal passes the case above and fails this one.
check "a moved quota URL carries the version URL with it" "0" \
  "$([ "$(vurl 'http://127.0.0.1:9999/api/quota')" = "http://127.0.0.1:9999/api/version" ] && echo 0 || echo 1)"
check "an explicit STUDIO_VERSION_URL still wins" "0" \
  "$( ( set -uo pipefail
        export STUDIO_VERSION_URL="http://elsewhere/v"
        # shellcheck source=/dev/null
        . "$HERE/drive.sh"
        [ "$STUDIO_VERSION_URL" = "http://elsewhere/v" ] && echo 0 || echo 1 ) )"

# --- 45. #806 quota_stamped_write: ONE owner for the "<epoch> <value>" format --
# The reader was shared; the writer was hand-rolled at three sites, each with `>`.
# `>` truncates BEFORE writing, so a racing reader (a second driver, or an
# attended run alongside the scheduled one) could `head -1` an emptied file and
# read a live record as "no record". Temp-then-rename closes that window, and
# routing all three through one function gives the format an owner on both sides.
swtmp="$(mk_tmp)"
mkdir -p "$swtmp/infra" "$swtmp/ro"
# The pre-existing record case (c) needs a directory the writer cannot create in.
# Seeded BEFORE the chmod, and the write-block is asserted below rather than
# assumed -- running as root would make `chmod 555` a no-op and turn (c) and (h)
# into vacuous passes, which is the failure mode this whole suite exists to avoid.
printf '%s 11\n' "$(date +%s)" >"$swtmp/ro/.stamp"
printf '%s probe\n' "$((now - 999999))" >"$swtmp/ro/.shadow"
# Case (n)'s fixture: a FRESH, LOW cache reading in the same unwritable dir. Low
# because the drop only fires on old < new -- a high one would take the "keep"
# branch and prove nothing about the drop.
#
# 12, NOT 10, and the difference is load-bearing: case (l) drops a stale 10 to
# the SAME driver.log, so an assertion grepping for "dropped the stale 10%" would
# be satisfied by (l)'s line and could not go red if (n)'s vanished. A distinct
# value makes the log assertion name the case it claims to measure. (Found by the
# pre-PR correctness lens -- the coverage was not lost, since 45n is also pinned
# by the read-back assertions, but the assertion did not measure what it said.)
printf '%s 12\n' "$(date +%s)" >"$swtmp/ro/.cache"
# CAPTURED BEFORE the subshell runs. Comparing against a re-read of the file
# afterwards would be self-referential -- both sides would be the POST state, so
# the assertion would hold whatever the writer did to it, including destroying
# the record entirely. (Caught by the pre-PR correctness lens, which simulated a
# revert to `>`: the record was clobbered and the assertion still passed.)
sw_seed="$(head -1 "$swtmp/ro/.stamp")"
chmod 555 "$swtmp/ro"
# Bounded exactly like cases 17 and 43: a broken source guard turns `.` into an
# unconditional `while true` and would hang the suite forever.
(
  set -uo pipefail
  # exported because the SOURCED file is what reads them; shellcheck cannot see
  # across the `.` and would otherwise call them unused.
  export INFRA="$swtmp/infra"
  export DLOG="$swtmp/infra/driver.log"
  # shellcheck source=/dev/null
  . "$HERE/drive.sh"
  swf="$swtmp/infra/.stamp"

  # (a) the two halves agree: what the writer emits, the shared reader accepts.
  quota_stamped_write "$swf" 42 && echo "ok" || echo "failed"
  quota_stamped_read "$swf" 300

  # (b) rename witness. A rename(2) INSTALLS a new inode; `>` truncation reuses
  #     the old one. Cheap, but it only proves "a rename happened" -- (c) is what
  #     proves the property #806 is actually about.
  swi1="$(ls -i "$swf" | awk '{print $1}')"
  quota_stamped_write "$swf" 43 || true
  swi2="$(ls -i "$swf" | awk '{print $1}')"
  [ "$swi1" != "$swi2" ] && echo "renamed" || echo "same-inode"

  # (c) THE PROOF: a write that cannot complete leaves the PRIOR record intact.
  #     Under `>` this state (read-only dir, writable file) succeeds and destroys
  #     the record it could not replace; under temp+rename it fails having
  #     touched nothing. This is the assertion that goes red on a revert.
  quota_stamped_write "$swtmp/ro/.stamp" 99 && echo "wrote" || echo "refused"
  head -1 "$swtmp/ro/.stamp"
  # (d) ...and leaves no temp behind for the next reader to trip over.
  #     The dot is NAMED, as in 45k: the old `*.tmp.*` could not match, because a
  #     leading `*` never matches a leading dot and the temp here would be
  #     `.stamp.tmp.<pid>`. `.stamp` is the only destination attempted in this
  #     directory before (n), so naming it is exact rather than merely narrower.
  ls "$swtmp/ro"/.stamp.tmp.* >/dev/null 2>&1 && echo "dirt" || echo "clean"

  # (e) a target with prior content is REPLACED, never appended to -- the reader
  #     takes the epoch from line 1 and the value from the LAST line (case 37d),
  #     so an appending writer would pair a fresh stamp with a stale value.
  printf 'junk\nmore junk\n' >"$swf"
  quota_stamped_write "$swf" 7 || true
  wc -l <"$swf" | tr -d ' '

  # (f) a value that would corrupt the one-line format is refused, and refused
  #     BEFORE anything is written -- an embedded space splits into a second
  #     token, so `##* ` would return only its tail.
  quota_stamped_write "$swf" "7 8" && echo "wrote" || echo "refused"
  quota_stamped_write "$swf" "" && echo "wrote" || echo "refused"
  quota_stamped_read "$swf" 300

  # (g) an unusable epoch is a FAILURE, not a silently unreadable record. Without
  #     this, a broken `date` writes " probe", the shared reader rejects it as
  #     having no epoch, and `quota_shadow_probe` -- whose throttle rests on a 0
  #     return meaning a READABLE stamp exists -- would poll on every call. That
  #     is exactly what case 29g exists to prevent, reached through a SUCCESS.
  #     Shadowed as a function, so nothing on disk or on PATH is touched.
  swg="$swtmp/infra/.epoch"
  date() { :; }
  quota_stamped_write "$swg" 42 && echo "wrote" || echo "refused"
  unset -f date
  [ -e "$swg" ] && echo "record" || echo "nothing"

  # (i) a DIRECTORY destination. `mv -f tmp DIR` SUCCEEDS -- it moves the temp
  #     INSIDE the directory and returns 0 -- so the rename's status alone is not
  #     evidence the record landed, and a naive writer returns 0 with nothing at
  #     $file. `> DIR` failed here, so this is the one direction in which
  #     temp+rename is WEAKER than what it replaced, and the only one that ends
  #     fail-OPEN: the shadow probe would read a 0 return as "stamp written" and
  #     poll studio on every call.
  swd="$swtmp/infra/.asdir"
  mkdir -p "$swd"
  quota_stamped_write "$swd" 42 && echo "wrote" || echo "refused"
  # `ls -A`, not `ls`: the temp is `.asdir.tmp.<pid>` and EVERY destination this
  # writer handles is a dotfile, so plain `ls` cannot see the leak it is looking
  # for. Proven vacuous by the correctness lens -- with `ls`, deleting the
  # `[ -d ]` guard from drive.sh left all 28 section-45 assertions green while a
  # real temp sat inside the directory. The "refused" half above is produced
  # independently by the read-back (`[ -f ]` is false on a directory), so this
  # assertion was the ONLY cover the `[ -d ]` guard had, and it had none.
  ls -A "$swd" | wc -l | tr -d ' '

  # (j) an epoch LONGER than the reader's 11-digit bound is refused. The reader
  #     discards it (`$(( ))` wraps silently on a 64-bit value, so the bound is
  #     what keeps a fabricated stamp from looking fresh), and a writer that
  #     returned 0 over a record the reader discards breaks the same contract (g)
  #     protects, one door over.
  swj="$swtmp/infra/.longepoch"
  date() { echo 123456789012; }
  quota_stamped_write "$swj" 42 && echo "wrote" || echo "refused"
  unset -f date
  [ -e "$swj" ] && echo "record" || echo "nothing"

  # (k) THE RENAME FAILING is a branch nothing else reaches: in (c) and (h) the
  #     PRINTF fails (read-only dir), so the `mv`'s cleanup and its stderr muzzle
  #     never execute, and (d)'s "no temp left" checks a state where no temp could
  #     have been created. Every portable way to make a real `mv` fail here also
  #     blocks the `rm` that cleans up after it (read-only dir), or is not
  #     portable to the ubuntu runner this suite also runs on (`chflags uchg`).
  #     So `mv` is shadowed as a shell function -- the same trick as `date` in
  #     (g), touching nothing on disk or on PATH. It writes to STDERR as a real
  #     failing `mv` would, which is what makes the stderr assertion below pin
  #     drive.sh's `2>/dev/null` on the rename: the redirection under test is in
  #     drive.sh and applies to a function's stderr exactly as to a binary's, so
  #     this is an assertion about the muzzle, not about the stub.
  swk="$swtmp/infra/.mvfail"
  mv() { echo "mv: rename failed" >&2; return 1; }
  quota_stamped_write "$swk" 42 && echo "wrote" || echo "refused"
  unset -f mv
  [ -e "$swk" ] && echo "record" || echo "nothing"
  ls "$swtmp/infra"/.mvfail.tmp.* >/dev/null 2>&1 && echo "dirt" || echo "clean"

  # (l) ...and THAT is the state where the cache's failure path changed polarity.
  #     `>` left no record on failure (blind path); temp+rename leaves the PRIOR
  #     one, and for a refuse-only cache over a monotonic quantity a surviving
  #     LOWER record permits fires the reading that failed to persist would have
  #     refused. So a too-low record is dropped; a >= one is kept, since it
  #     refuses at least as hard.
  export QUOTA_CACHE="$swtmp/infra/.cache"
  printf '%s 10\n' "$(date +%s)" >"$QUOTA_CACHE"
  mv() { echo "mv: rename failed" >&2; return 1; }
  quota_cache_write 95
  unset -f mv
  [ -e "$QUOTA_CACHE" ] && echo "kept" || echo "dropped"
  printf '%s 98\n' "$(date +%s)" >"$QUOTA_CACHE"
  mv() { echo "mv: rename failed" >&2; return 1; }
  quota_cache_write 95
  unset -f mv
  head -1 "$QUOTA_CACHE" 2>/dev/null | awk '{print $2}'

  # (m) THE CONTRACT, enforced rather than enumerated. Every other guard is a
  #     named failure mode; this is the one that catches the mode NOBODY named.
  #     The rename installs a FRESH umask-derived mode where `>` preserved the
  #     destination's, so under a hostile umask the record lands write-only: the
  #     write succeeds, the file exists, and the shared reader cannot `head -1`
  #     it. Without the read-back, `quota_stamped_write` returns 0 over a record
  #     the reader rejects -- and `quota_shadow_probe` then polls studio on every
  #     call, which is exactly what case 29g exists to prevent, through a SUCCESS.
  #     (Vacuous under root, which ignores the mode -- the read-only-directory
  #     precondition asserted in the parent is what rules that out.)
  swm="$swtmp/infra/.unreadable"
  sw_umask="$(umask)"
  umask 0477
  # A CANARY under the same umask. The old anti-vacuity check here was
  # `[ -r "$swm" ]`, and it can no longer do that job: the writer now DISCARDS
  # the record it could not read back, so $swm is gone and `-r` is false whether
  # or not the umask ever bit -- i.e. the check would pass under root, which is
  # exactly the vacuity it was added to rule out. The canary still exists, so it
  # still measures the umask.
  : >"$swtmp/infra/.umaskcanary"
  quota_stamped_write "$swm" 42 && echo "wrote" || echo "refused"
  umask "$sw_umask"
  [ -r "$swtmp/infra/.umaskcanary" ] && echo "readable" || echo "unreadable"
  # ...and the unreadable record is not left stranded at the destination, where
  # a mode-derived failure would keep it unreadable to every future reader.
  [ -e "$swm" ] && echo "record" || echo "nothing"

  # (n) THE CACHE DROP, in the state it actually exists for -- a mode-555 $INFRA
  #     holding an owner-writable record. An earlier cut dropped with a bare
  #     `rm -f`, which needs write on the DIRECTORY: measured by the pre-PR
  #     correctness lens, it left the stale PERMITTING 10 on disk (the cache went
  #     on serving it into a 95% window) while logging that it had dropped it.
  #     Truncation needs write on the FILE, which this state grants, so
  #     `quota_stamped_discard` tries both. Goes red on a revert to bare `rm -f`.
  export QUOTA_CACHE="$swtmp/ro/.cache"
  quota_cache_write 95
  swn="$(quota_stamped_read "$QUOTA_CACHE" 86400)"
  [ -z "$swn" ] && echo "no-record" || echo "serves:$swn"

  # (o) the permission dependency MOVED: a rename needs write on the DIRECTORY
  #     where `>` needed write on the FILE. So a read-only $INFRA holding a
  #     writable stamp now skips where it used to poll. 29g pins the same skip
  #     via a non-existent parent, which fails under both shapes and so cannot
  #     see this direction change. The stamp seeded above is STALE, so the
  #     throttle lets the probe through to the write it then cannot do.
  export QUOTA_SHADOW_STAMP="$swtmp/ro/.shadow"
  export QUOTA_SHADOW_MIN_INTERVAL=3600
  quota_shadow_probe dashboard

  # (p) the OTHER cleanup branch. There are two `rm -f "$qsw_tmp"` calls -- one
  #     per failure path -- and until this case only the `mv` one (45k) had
  #     cover. 45d looked like it covered the printf one but does not: there the
  #     directory is read-only, so the redirect fails at OPEN and no temp is ever
  #     created, leaving the assertion green with the `rm` deleted. (Found by the
  #     pre-PR correctness lens. Same family as prevention-log #30: an absence
  #     assertion is worth exactly what its ability to see presence is worth.)
  #
  #     To reach a printf that fails with the temp ALREADY EXISTING, seed the
  #     temp path itself as an unwritable file in a WRITABLE directory: the open
  #     fails EACCES (verified: `printf >` a mode-444 file we own is denied),
  #     while `rm` -- which needs write on the DIRECTORY, not the file -- can
  #     still clear it. Deleting the printf branch's `rm -f` leaves the seeded
  #     temp behind and turns the second assertion red.
  #
  #     Appended AFTER (o) deliberately: (n) and (o) consume the read-only dir,
  #     and inserting here rather than mid-section keeps every earlier `swout`
  #     line number stable. `$$` is the same in this subshell as in drive.sh --
  #     bash does not re-assign it for a subshell -- so the temp name is exact.
  #     (Vacuous under root, which ignores the mode; ruled out by the read-only
  #     directory precondition asserted in the parent.)
  swp="$swtmp/infra/.printffail"
  : >"$swp.tmp.$$"
  chmod 444 "$swp.tmp.$$"
  quota_stamped_write "$swp" 42 && echo "wrote" || echo "refused"
  ls "$swtmp/infra"/.printffail.tmp.* >/dev/null 2>&1 && echo "dirt" || echo "clean"
) >"$swtmp/out" 2>"$swtmp/err" &
sw_pid=$!
sw_i=0
while [ "$sw_i" -lt 15 ]; do kill -0 "$sw_pid" 2>/dev/null || break; sleep 1; sw_i=$((sw_i + 1)); done
kill -9 "$sw_pid" 2>/dev/null || true
swout() { sed -n "${1}p" "$swtmp/out" 2>/dev/null; }
# Not vacuous: the read-only setup must actually block, or (c) and (h) prove
# nothing. Asserted, not assumed -- under root `chmod 555` is a no-op.
check "the read-only directory really is unwritable (else 45c/45h are vacuous)" "1" \
  "$( (touch "$swtmp/ro/probe" >/dev/null 2>&1 && echo 0) || echo 1)"
check "a written record is one the SHARED reader accepts" "ok" "$(swout 1)"
check "...and reads back as the value that was written" "42" "$(swout 2)"
check "the record is installed by RENAME, not by truncating in place" "renamed" "$(swout 3)"
check "a write that cannot complete leaves the PRIOR record intact" "refused" "$(swout 4)"
check "...the prior record, byte for byte -- not an emptied or partial file" "$sw_seed" "$(swout 5)"
check "...and leaves no temp file behind" "clean" "$(swout 6)"
check "a target with prior content is REPLACED, not appended to" "1" "$(swout 7)"
check "a value carrying a separator is refused" "refused" "$(swout 8)"
check "an empty value is refused" "refused" "$(swout 9)"
check "...and neither refusal disturbed the target" "7" "$(swout 10)"
check "an unusable epoch is a failure, not a silently unreadable record" "refused" "$(swout 11)"
check "...and nothing was written" "nothing" "$(swout 12)"
check "a DIRECTORY destination is refused (mv -f would succeed INTO it)" "refused" "$(swout 13)"
check "...and the temp was not left sitting inside that directory" "0" "$(swout 14)"
check "an epoch past the reader's 11-digit bound is refused, not written" "refused" "$(swout 15)"
check "...and nothing was written" "nothing" "$(swout 16)"
check "a failing RENAME is a refusal, not a silent success" "refused" "$(swout 17)"
check "...leaving no record at the destination" "nothing" "$(swout 18)"
check "...and cleaning up the temp it had already created" "clean" "$(swout 19)"
check "a cache reading that cannot be persisted DROPS a lower stale record" "dropped" "$(swout 20)"
check "...but keeps a HIGHER one, which refuses at least as hard" "98" "$(swout 21)"
check "a record the SHARED READER cannot accept is a refusal, not a 0 return" "refused" "$(swout 22)"
check "...and the umask really did bite (canary; else the case is vacuous)" "unreadable" "$(swout 23)"
check "...and the unreadable record is discarded, not stranded at the target" "nothing" "$(swout 24)"
check "a cache drop REACHES the read-only-dir state that motivated it" "no-record" "$(swout 25)"
check "...and says so honestly, rather than claiming a drop that did not happen" "0" \
  "$(grep -q 'could not drop the stale' "$swtmp/infra/driver.log" 2>/dev/null && echo 1 || echo 0)"
check "...having reported the drop it DID do" "1" \
  "$(grep -q 'dropped the stale 12% cache' "$swtmp/infra/driver.log" 2>/dev/null && echo 1 || echo 0)"
check "the cache write announces a failure it can no longer make invisible" "1" \
  "$(grep -q 'WARN: could not persist quota' "$swtmp/infra/driver.log" 2>/dev/null && echo 1 || echo 0)"
# The muzzles the diff added are justified as "would otherwise print to the
# launchd stderr log on every gate" -- so pin that they do, rather than trusting
# the argument (prevention-log #25).
check "nothing in section 45 leaked to stderr (the 2>/dev/null muzzles hold)" "" \
  "$(cat "$swtmp/err" 2>/dev/null)"
# `grep -q`, not `grep -c ... || echo 0`: on NO match `grep -c` prints 0 AND exits
# 1, so the `||` fires too and the value is "0\n0" -- which never equals "0" and
# makes an expected-ABSENT assertion permanently red. 1 = present, 0 = absent.
check "the shadow probe SKIPS when the rename cannot happen (permission moved)" "1" \
  "$(grep -q 'quota shadow: skipped' "$swtmp/infra/driver.log" 2>/dev/null && echo 1 || echo 0)"
check "...and did NOT poll studio, which would defeat the throttle" "0" \
  "$(grep -q 'quota shadow: studio' "$swtmp/infra/driver.log" 2>/dev/null && echo 1 || echo 0)"
check "a printf that fails with the temp already created is a refusal" "refused" "$(swout 26)"
check "...and that branch cleans up its temp too (45d could not see this)" "clean" "$(swout 27)"
chmod 755 "$swtmp/ro" 2>/dev/null || true
rm -rf "$swtmp"

# --- 46. #811 SELF-ADOPTION: a merged loop/ fix actually starts running -------
# #808 made "this process is running superseded code" VISIBLE; the fix stayed
# inert until a human ran `launchctl kickstart`. These cases drive the REAL
# drive.sh and mutate the copy it is running from, exactly as a sync does.
#
# The load-bearing property is NOT that it execs -- it is that the exec carries
# the cross-fire bounds. An exec that reset them would trade a visible staleness
# for an invisible fail-open in MAX_STALL / MAX_CRASH / QUOTA_UNKNOWN_FIRES /
# MAX_BUDGET_REGRANTS, which is why #808 refused to build it. So every case here
# asserts a COUNTER survived, not merely that a line was logged.

# (a) one mutation on fire 1 -> adopt at the top of iteration 2, counters intact.
#
# MAX_LOOPS=4 makes the carry ARITHMETICALLY observable. `loops` is incremented
# before the adopt point, so the handoff carries loops=2: the exec'd process
# resumes at 2 and has iterations 3 and 4 left, i.e. 3 fires in total. Had
# `loops` reset to 0 it would have had FOUR more iterations and fired 5 times.
# The fire COUNT is therefore the assertion, and 3-vs-5 is the whole point.
r46="$(run_case 0.10 MUTATE_DRIVE=comment MAX_LOOPS=4)"
l46="$(logof "$r46")"
check "a driver whose file changed under it ADOPTS the new code (#811)" "1" \
  "$(grep -c 'driver code: ADOPTING' "$l46" 2>/dev/null || echo 0)"
check "...and the exec'd process RESUMES the handoff rather than starting clean" "1" \
  "$(grep -c 'driver handoff: RESUMED' "$l46" 2>/dev/null || echo 0)"
check "...carrying MAX_LOOPS across the exec (3 fires, not the 5 a reset gives)" "3" \
  "$(fires_of "$r46")"
# The fire NUMBERING across both processes, not merely "FIRE 2 exists" -- that
# weaker form is vacuous, because a driver that reset its counters still reaches
# FIRE 2 eventually. A reset shows up here as a repeat: "1 1 2 3 4".
check "...and the fire counter continues across the exec (1 2 3, never a repeat)" "1 2 3" \
  "$(grep -o '=== FIRE [0-9]* ' "$l46" 2>/dev/null | awk '{print $3}' | tr '\n' ' ' | sed 's/ $//')"
# The handoff is single-use. A record left on disk is one a much later restart
# could resume bounds from -- the failure this file cares about, arriving late.
check "...and the handoff record is CONSUMED, never left for a later restart" "0" \
  "$([ -f "$(tmpof "$r46")/infra/.driver_handoff" ] && echo 1 || echo 0)"

# (b) a new file that does not PARSE must never be exec'd into. This is the
# half-finished-sync case, and exec'ing it would kill the driver outright --
# nothing would run until the next scheduled start.
r46b="$(run_case 0.10 MUTATE_DRIVE=broken MAX_LOOPS=3)"
l46b="$(logof "$r46b")"
# `grep -q`, not `grep -c ... || echo 0`: on NO match `grep -c` prints 0 AND exits
# 1, so the `||` fires too and the value is "0\n0" -- which never equals "0" and
# makes an expected-ABSENT assertion permanently red (this file's own lesson,
# and it caught this case on the first run).
check "a syntactically broken new file is REFUSED, not exec'd (#811)" "0" \
  "$(grep -q 'driver code: ADOPTING' "$l46b" 2>/dev/null && echo 1 || echo 0)"
check "...and the refusal says so instead of failing silently" "1" \
  "$(grep -q 'NOT adopting -- .* does not PARSE' "$l46b" 2>/dev/null && echo 1 || echo 0)"
check "...and the driver carries on running the OLD code (all 3 fires)" "3" \
  "$(fires_of "$r46b")"

# (c) a file that keeps changing must not adopt-loop forever. MAX_SELF_ADOPT
# bounds it, and the bound has to survive the exec or it bounds nothing.
r46c="$(run_case 0.10 MUTATE_DRIVE=every MAX_SELF_ADOPT=1 MAX_LOOPS=5)"
l46c="$(logof "$r46c")"
check "the adopt cap survives the exec -- exactly ONE adoption, not one per fire" "1" \
  "$(grep -c 'driver code: ADOPTING' "$l46c" 2>/dev/null || echo 0)"
check "...and says the cap is why it stopped adopting" "1" \
  "$(grep -q 'cap MAX_SELF_ADOPT=1' "$l46c" 2>/dev/null && echo 1 || echo 0)"
# The marker must never reach a fire. Every line is "[]" or the driver leaked it
# into the agent's environment.
check "...and no fire ever inherits DRIVE_ADOPT_COUNT (it is unset before the loop)" "0" \
  "$(grep -cv '^\[\]$' "$(tmpof "$r46c")/adoptmarker.txt" 2>/dev/null | head -1)"

# (c2) the cap must not rest on the handoff RECORD surviving. Mutating
# `drive_handoff_resume` to a no-op did not just turn (c) red -- it HUNG the
# suite in an infinite adopt-exec loop, because every exec'd process restarted at
# adoptions=0 while the file kept changing. The environment carries the count
# too, and starting AT the cap is the cheapest way to prove that carrier is read:
# the driver must refuse from its very first iteration, with a file that changes
# under it on every fire.
r46c2="$(run_case 0.10 MUTATE_DRIVE=every MAX_SELF_ADOPT=1 DRIVE_ADOPT_COUNT=1 MAX_LOOPS=3)"
l46c2="$(logof "$r46c2")"
check "an adopt count inherited from the environment is honoured (#811)" "0" \
  "$(grep -q 'driver code: ADOPTING' "$l46c2" 2>/dev/null && echo 1 || echo 0)"
check "...and the run still makes progress rather than looping (all 3 fires)" "3" \
  "$(fires_of "$r46c2")"

# (d) SELF_ADOPT=0 returns the driver to #808's report-and-wait behaviour.
r46d="$(run_case 0.10 MUTATE_DRIVE=comment SELF_ADOPT=0 MAX_LOOPS=3)"
l46d="$(logof "$r46d")"
check "SELF_ADOPT=0 refuses to adopt at all (#811)" "0" \
  "$(grep -q 'driver code: ADOPTING' "$l46d" 2>/dev/null && echo 1 || echo 0)"
check "...and the #808 STALE report still names the manual remedy" "1" \
  "$(grep -q 'driver code: STALE' "$l46d" 2>/dev/null && echo 1 || echo 0)"

# (d2) the handoff cannot be WRITTEN at all. This is the branch whose entire
# purpose is "never exec with zeroed bounds", and it was the one refusal path
# with no coverage. A DIRECTORY as the destination is the cheapest way to reach
# it that is not a permission trick: `quota_stamped_write` refuses one up front,
# because `mv -f tmp DIR` SUCCEEDS by moving the temp INSIDE it.
# A dedicated directory, not `/tmp`: the resume path also calls
# `quota_stamped_discard` on this destination, and pointing that at a shared
# system directory -- even though `rm -f` refuses a directory -- is not something
# a test should read as normal.
r46edir="$(mk_tmp)"
r46e="$(run_case 0.10 MUTATE_DRIVE=comment DRIVER_HANDOFF="$r46edir" MAX_LOOPS=3)"
l46e="$(logof "$r46e")"
check "a handoff that cannot be WRITTEN refuses the exec (#811)" "0" \
  "$(grep -q 'driver code: ADOPTING' "$l46e" 2>/dev/null && echo 1 || echo 0)"
check "...and says the counters were the reason, not the file" "1" \
  "$(grep -q 'NOT adopting -- the cross-fire counters could not be written' "$l46e" 2>/dev/null && echo 1 || echo 0)"
check "...and the driver keeps firing on the old code" "3" \
  "$(fires_of "$r46e")"
rmdir "$r46edir" 2>/dev/null || true

# (e) the handoff RECORD itself: who may consume it, and when. Sourced rather
# than driven, because the discriminating inputs (a foreign pid, a stale stamp)
# cannot be produced by a real run -- an exec always preserves the pid, and the
# window between write and exec is microseconds.
#
# `$$` inside this backgrounded subshell is the TEST SCRIPT's pid (verified:
# bash keeps $$ stable across subshells; BASHPID is the one that changes), which
# is exactly why a record written with `$$` here reads as a continuation there.
hftmp="$(mk_tmp)"
mkdir -p "$hftmp/infra"
hfnow="$(date +%s)"
printf '%s v=1,pid=%s,fires=7,stall=2,blind=1,regrants=1,crash=3,loops=9,adopt=1,head=abc123\n' \
  "$hfnow" "$$" >"$hftmp/infra/.mine"
printf '%s v=1,pid=999999,fires=7,stall=2,blind=1,regrants=1,crash=3,loops=9,adopt=1,head=abc123\n' \
  "$hfnow" >"$hftmp/infra/.foreign"
printf '%s v=1,pid=%s,fires=7,stall=2,blind=1,regrants=1,crash=3,loops=9,adopt=1,head=abc123\n' \
  "$((hfnow - 4000))" "$$" >"$hftmp/infra/.stale"
printf '%s v=1,pid=%s,fires=seven,stall=2,blind=1,regrants=1,crash=3,loops=9,adopt=1,head=abc123\n' \
  "$hfnow" "$$" >"$hftmp/infra/.corrupt"
# A record whose FORMAT version this drive.sh does not know. `v` exists for
# exactly the writer-old/reader-new skew this feature creates, so it needs a case.
printf '%s v=2,pid=%s,fires=7,stall=2,blind=1,regrants=1,crash=3,loops=9,adopt=1,head=abc123\n' \
  "$hfnow" "$$" >"$hftmp/infra/.badversion"
# A counter with a LEADING ZERO. `$(( ))` reads it as octal: `fires=012`
# increments to 11, and `fires=08` is "value too great for base" -- non-fatal, so
# the counter STAYS "08" and never increments again, which silently disarms every
# bound that reads it for the rest of the run.
printf '%s v=1,pid=%s,fires=08,stall=2,blind=1,regrants=1,crash=3,loops=9,adopt=1,head=abc123\n' \
  "$hfnow" "$$" >"$hftmp/infra/.octal"
# A record from a drive.sh that had no `blind` counter yet -- the version skew an
# adopt exec makes possible, since the OLD code writes what the NEW code reads.
printf '%s v=1,pid=%s,fires=7,stall=2,regrants=1,crash=3,loops=9,adopt=1,head=abc123,newfield=x\n' \
  "$hfnow" "$$" >"$hftmp/infra/.skewed"
# Bounded exactly like cases 17 and 43: a broken source guard turns `.` into an
# unconditional `while true` and would hang the suite forever.
(
  set -uo pipefail
  # exported because the SOURCED file is what reads them; shellcheck cannot see
  # across the `.` and would otherwise call them unused.
  export INFRA="$hftmp/infra"
  export DLOG="$hftmp/infra/driver.log"
  export MAX_SELF_ADOPT=3
  export HANDOFF_MAX_AGE=300
  # shellcheck source=/dev/null
  . "$HERE/drive.sh"
  for hf_case in mine foreign stale corrupt skewed badversion octal; do
    fires=0; stall=0; blind_fires=0; budget_regrants=0; crash=0; loops=0
    adoptions=0; prev_head=""
    cp "$hftmp/infra/.$hf_case" "$hftmp/infra/.driver_handoff"
    DRIVER_HANDOFF="$hftmp/infra/.driver_handoff"
    drive_handoff_resume
    echo "$hf_case fires=$fires stall=$stall blind=$blind_fires regrants=$budget_regrants crash=$crash loops=$loops adopt=$adoptions head=$prev_head consumed=$([ -f "$DRIVER_HANDOFF" ] && echo 0 || echo 1)"
  done
  # The env carrier, which no run_case can reach: `run_case` can only SUPPLY
  # DRIVE_ADOPT_COUNT from outside, so deleting the `export` before the exec left
  # every case green. This exercises the read side and the unset directly.
  fires=0; stall=0; blind_fires=0; budget_regrants=0; crash=0; loops=0
  adoptions=0; prev_head=""
  DRIVE_ADOPT_COUNT=2; export DRIVE_ADOPT_COUNT
  drive_adopt_floor
  echo "floor adopt=$adoptions leaked=${DRIVE_ADOPT_COUNT:-none}"
  # ...and it is a FLOOR, never a ceiling: a record that remembers MORE
  # adoptions than the environment must win, or a lost carrier could LOOSEN the
  # cap instead of tightening it.
  adoptions=5
  DRIVE_ADOPT_COUNT=2; export DRIVE_ADOPT_COUNT
  drive_adopt_floor
  echo "ceiling adopt=$adoptions leaked=${DRIVE_ADOPT_COUNT:-none}"
) >"$hftmp/out" 2>"$hftmp/err" &
hf_pid=$!
hf_i=0
while [ "$hf_i" -lt 15 ]; do kill -0 "$hf_pid" 2>/dev/null || break; sleep 1; hf_i=$((hf_i + 1)); done
kill -9 "$hf_pid" 2>/dev/null || true
hfout() { grep "^$1 " "$hftmp/out" 2>/dev/null | head -1; }
check "a handoff from THIS pid resumes every bound (the case is not vacuous)" \
  "mine fires=7 stall=2 blind=1 regrants=1 crash=3 loops=9 adopt=1 head=abc123 consumed=1" \
  "$(hfout mine)"
check "a handoff from ANOTHER pid is a new run, not a continuation -- all zero" \
  "foreign fires=0 stall=0 blind=0 regrants=0 crash=0 loops=0 adopt=0 head= consumed=1" \
  "$(hfout foreign)"
check "a handoff older than HANDOFF_MAX_AGE is not a continuation either" \
  "stale fires=0 stall=0 blind=0 regrants=0 crash=0 loops=0 adopt=0 head= consumed=1" \
  "$(hfout stale)"
# A malformed counter is REFUSED, never coerced -- and refusing costs the bounds,
# so it also disarms further adoption rather than letting the loss repeat.
check "a corrupt counter refuses the whole record and stops adopting (fail-safe)" \
  "corrupt fires=0 stall=0 blind=0 regrants=0 crash=0 loops=0 adopt=3 head= consumed=1" \
  "$(hfout corrupt)"
# Version skew degrades PER FIELD: the writer is the old code and the reader is
# the new one, so an all-or-nothing parse would drop every bound on the one fire
# that adopts a format change.
check "a record missing one counter keeps the others armed (writer=old, reader=new)" \
  "skewed fires=7 stall=2 blind=0 regrants=1 crash=3 loops=9 adopt=1 head=abc123 consumed=1" \
  "$(hfout skewed)"
check "...and NAMES the counter it could not carry, rather than silently zeroing it" "1" \
  "$(grep -q 'the handoff carried no blind' "$hftmp/infra/driver.log" 2>/dev/null && echo 1 || echo 0)"
check "an unknown FORMAT version refuses the record (v exists for exactly this)" \
  "badversion fires=0 stall=0 blind=0 regrants=0 crash=0 loops=0 adopt=3 head= consumed=1" \
  "$(hfout badversion)"
# The direction matters: coerced, `08` would disarm every bound reading it.
check "a leading-zero counter is refused, never coerced through octal \$(( ))" \
  "octal fires=0 stall=0 blind=0 regrants=0 crash=0 loops=0 adopt=3 head= consumed=1" \
  "$(hfout octal)"
check "...and names the field it did not recognise" "1" \
  "$(grep -q 'ignored unknown field(s) newfield' "$hftmp/infra/driver.log" 2>/dev/null && echo 1 || echo 0)"
check "an adopt count in the ENVIRONMENT raises the cap's counter (#811)" \
  "floor adopt=2 leaked=none" "$(hfout floor)"
check "...and it is a floor, not a ceiling -- a bigger remembered count wins" \
  "ceiling adopt=5 leaked=none" "$(hfout ceiling)"
check "the handoff resume emits NOTHING on stderr (it runs before every fire)" "" \
  "$(cat "$hftmp/err" 2>/dev/null)"
rm -rf "$hftmp"

# --- 17. sourcing drive.sh has NO side effects (review round 2) --------------
# The round-1 mkdir fix ran at FILE SCOPE, ~200 lines above the source guard the
# same commit added -- so sourcing the file to unit-test its functions created
# $INFRA/logs/ anyway. The guard is only worth having if nothing outruns it.
# Bounded with a background pid + poll: if the guard ever breaks, the body is an
# unconditional `while true` and a plain `.` would hang this suite forever.
srctmp="$(mk_tmp)"
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

# --- 18. #821 the fixture deadline kills a driver the harness cannot ---------
# FIXTURE_TTL=-5 back-dates the deadline, so the FIRST fire is already past it.
# A driver with MAX_LOOPS=12 and MAX_FIRES=0 would otherwise fire twelve times;
# one fire means the stub run.sh reached up and killed its own driver. That is
# the only bound in this suite that does not depend on the harness still being
# alive, which is the whole point -- the #821 orphan was born when the harness
# was killed.
r821="$(run_case 0.10 QUOTA_STOP_PCT=80 MAX_FIRES=0 MAX_LOOPS=12 FIXTURE_TTL=-5)"
check "the fixture deadline stops the driver on its first fire" "1" "$(fires_of "$r821")"
# ...and the same case WITHOUT the back-dated deadline still runs to its cap, so
# the assertion above is about the deadline and not about some other refusal.
r821b="$(run_case 0.10 QUOTA_STOP_PCT=80 MAX_FIRES=0 MAX_LOOPS=12)"
check "an in-date deadline does not interfere" "12" "$(fires_of "$r821b")"

# --- 19. #821 no fixture driver outlived its case ---------------------------
# The leak canary. Runs LAST, before the exit trap cleans up, and asks the real
# process table whether anything is still running out of a tree this suite built.
#
# Scoped honestly: `run_case` runs its driver in the FOREGROUND, so no run_case
# driver can outlive its own case while this suite is still alive to assert
# anything -- and the #821 orphan was born on the path where the suite is KILLED
# and this line never runs at all (that path is the deadline's job, not this
# one's). What this catches is a FUTURE backgrounded spawn that forgets to clean
# up, which is cheap insurance in a suite that already backgrounds ~8 subshells.
leaked=""
leak_ps="$(ps -ww -eo pid=,command= 2>/dev/null)"
while read -r lk_t; do
  [ -n "$lk_t" ] && [ -d "$lk_t" ] || continue
  for lk_p in $(drivers_under "$lk_t" "$leak_ps"); do leaked="$leaked $lk_p"; done
done <"$REG_FILE"
check "no run_case fixture driver outlived its case (#821)" "" "${leaked# }"

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
