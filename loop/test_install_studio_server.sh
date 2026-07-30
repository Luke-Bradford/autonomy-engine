#!/bin/bash
# test_install_studio_server.sh -- exercises the REAL install_studio_server.sh by
# sourcing it and calling its real functions. No assertions on mocks: `launchctl`,
# `pnpm`, `git` and `curl` are PATH stubs that RECORD what they were asked to do,
# and every assertion is about the artifact produced (the rendered plist) or about
# whether a side effect happened at all.
#
# Runs on ubuntu CI, so nothing here may touch a real LaunchAgent, a real network,
# or a real pnpm: HOME is redirected to a temp dir for every case, which is also
# what makes "--dry-run wrote nothing" a meaningful assertion rather than a hope.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SUT="$HERE/install_studio_server.sh"
fails=0
check() { # $1=label $2=expected $3=actual
  if [ "$2" = "$3" ]; then echo "ok   - $1"
  else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails + 1)); fi
}

[ -f "$SUT" ] || { echo "FAIL - $SUT does not exist"; exit 1; }

# Every sandbox is recorded and removed on exit; the suite used to leak one
# mktemp dir per case.
SANDBOXES="$(mktemp)"
cleanup() {
  while IFS= read -r d; do
    case "$d" in /*/*) rm -rf "$d" ;; esac   # never rm -rf a short/empty path
  done <"$SANDBOXES"
  rm -f "$SANDBOXES"
}
trap cleanup EXIT

# --- a sandbox: fake HOME, fake source repo, stub PATH ----------------------
# Returns the sandbox root on stdout. Every case gets its own, so a case can
# never observe another's launchctl calls or leftover plist.
new_sandbox() {
  ns_root="$(mktemp -d)"
  mkdir -p "$ns_root/home/Library/LaunchAgents" "$ns_root/bin" "$ns_root/src/studio"
  # `launchctl`: records each invocation, one per line, and succeeds. `bootout`
  # of a job that is not loaded really does fail on macOS (rc 3/113), so the
  # stub reproduces that -- the installer must tolerate it.
  # `list` reports the job as STILL LOADED for the first $LIST_LOADED_TIMES
  # calls, then gone. That is what makes the teardown-wait testable: launchd's
  # bootout is asynchronous, so the installer must keep polling rather than
  # bootstrap straight into a job that is still shutting down.
  # `LOADED_LABELS` is a space-separated list of `label` or `label:pid` entries
  # that `list` reports as registered with launchd. The `:pid` form matters:
  # launchd prints a DASH for a job that is loaded but not currently running, so
  # "is it loaded" and "is it running" are different questions and the stub has
  # to be able to say both.
  cat >"$ns_root/bin/launchctl" <<'EOS'
#!/bin/bash
echo "$*" >>"$LAUNCHCTL_CALLS"
case "$1" in
  bootout) exit "${BOOTOUT_RC:-0}" ;;
  list)
    nf="$LAUNCHCTL_CALLS.listn"
    n=$(cat "$nf" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" >"$nf"
    [ "$n" -le "${LIST_LOADED_TIMES:-0}" ] && printf '4242\t0\tcom.autonomy.studio-server\n'
    # A label stops being loaded once it has been booted out. Derived from the
    # CALLS log rather than from a state file of its own, so it stays correct
    # when a case truncates that log to isolate a phase. Without this the
    # installer's teardown-wait polls a stub that never lets go: 60 real seconds
    # per reload, and a suite that looks hung rather than red.
    for e in ${LOADED_LABELS:-}; do
      l="${e%%:*}"; p='-'
      case "$e" in *:*) p="${e#*:}" ;; esac
      grep -q "^bootout .*/$l\$" "$LAUNCHCTL_CALLS" && continue
      printf '%s\t0\t%s\n' "$p" "$l"
    done
    ;;
esac
exit 0
EOS
  cat >"$ns_root/bin/pnpm" <<'EOS'
#!/bin/bash
echo "$*" >>"$PNPM_CALLS"
case "$*" in
  *" build") exit "${PNPM_BUILD_RC:-0}" ;;
esac
exit 0
EOS
  cat >"$ns_root/bin/git" <<'EOS'
#!/bin/bash
echo "$*" >>"$GIT_CALLS"
case "$*" in
  *"remote get-url"*) echo "https://github.com/Luke-Bradford/autonomy-engine.git" ;;
  *"rev-parse origin/main"*) echo "${GIT_ORIGIN_SHA:-0riginsha}" ;;
  *"rev-parse HEAD"*) echo "${GIT_HEAD_SHA:-${GIT_ORIGIN_SHA:-0riginsha}}" ;;
  *fetch*) exit "${GIT_FETCH_RC:-0}" ;;
esac
exit 0
EOS
  # `CURL_RC` fails every call; `CURL_FAIL_TIMES` fails only the first N /health
  # probes and then recovers, which is what makes the RETRY testable -- a stub
  # that always fails cannot tell a retried probe from a single-shot one.
  cat >"$ns_root/bin/curl" <<'EOS'
#!/bin/bash
echo "$*" >>"$CURL_CALLS"
case "$*" in
  *"/health"*)
    if [ -n "${CURL_FAIL_TIMES:-}" ]; then
      cf="$CURL_CALLS.health"
      n=$(cat "$cf" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" >"$cf"
      [ "$n" -le "$CURL_FAIL_TIMES" ] && exit 7
      exit 0
    fi ;;
esac
exit "${CURL_RC:-0}"
EOS
  # `lsof` MUST be stubbed. Without it `port_owner` ran the real one, so every
  # install case failed on any machine where the supervised service was actually
  # running -- the suite went red exactly when the system worked, and was green
  # on CI only because ubuntu's 8788 is free. Measured: exit 12 on this host.
  # The stub reports LSOF_PID (default: nobody), so the REAL port_owner runs.
  cat >"$ns_root/bin/lsof" <<'EOS'
#!/bin/bash
[ -n "${LSOF_PID:-}" ] && echo "$LSOF_PID"
exit 0
EOS
  chmod +x "$ns_root/bin/"*
  : >"$ns_root/launchctl.calls"; : >"$ns_root/pnpm.calls"
  : >"$ns_root/git.calls";       : >"$ns_root/curl.calls"
  echo "$ns_root" >>"$SANDBOXES"
  echo "$ns_root"
}

# Sources the SUT with the sandbox in force. Sourcing must DEFINE ONLY -- the
# source guard is what makes that true, and case 1 proves it.
load_sut() { # $1=sandbox root
  export HOME="$1/home"
  export PATH="$1/bin:$PATH"
  export LAUNCHCTL_CALLS="$1/launchctl.calls" PNPM_CALLS="$1/pnpm.calls"
  export GIT_CALLS="$1/git.calls" CURL_CALLS="$1/curl.calls"
  # A sourced script sees the CALLER's positional parameters, so leaving "$1" in
  # place would hand `main` a stray path, which it rejects as an unknown
  # argument. That made the source-guard test weak: it passed for the wrong
  # reason (bad args), not because the guard held. Cleared, an unguarded script
  # runs the FULL default install and trips every side-effect assertion below --
  # verified by mutation.
  set --
  # shellcheck source=/dev/null
  . "$SUT"
}

echo "== source guard =="
sb="$(new_sandbox)"
( load_sut "$sb" ) >"$sb/source.out" 2>&1
check "sourcing the installer runs nothing" "0" "$(wc -l <"$sb/launchctl.calls" | tr -d ' ')"
check "sourcing the installer exits 0" "0" "$(
  ( load_sut "$sb" ) >/dev/null 2>&1; echo $?)"

echo "== port validation =="
sb="$(new_sandbox)"
(
  load_sut "$sb"
  for p in 8788 1 65535; do
    valid_port "$p" || echo "REJECTED-GOOD:$p"
  done
  # Every one of these must be refused. `65536` and the 20-digit value are the
  # interesting ones: both are digit-only, so a character-class check alone
  # passes them, and the 20-digit value overflows signed 64-bit in `test`
  # exactly as drive.sh's totality guard documents.
  # `0080` is the sharp one: studio parses the port with Number(), so it becomes
  # 80, the unit tries to bind a privileged port, and launchd crash-loops it
  # every 30s forever while this installer has already reported success.
  for p in 0 65536 99999999 abc "" " " "80 80" "-1" "8.0" "0080" "07" \
           "10000000000000000000"; do
    valid_port "$p" && echo "ACCEPTED-BAD:[$p]"
  done
) >"$sb/ports.out" 2>&1
check "no good port rejected" "" "$(grep 'REJECTED-GOOD' "$sb/ports.out")"
check "no bad port accepted" "" "$(grep 'ACCEPTED-BAD' "$sb/ports.out")"

# TOTALITY, which is a different property from rejection and needs its own
# assertion. A 20-digit port is digit-only, so the character class passes it, and
# on bash 3.2 `[ 10000000000000000000 -ge 1 ]` exceeds signed 64-bit: it errors
# with rc=2 and a message on stderr. rc=2 is not 0, so the range check alone
# still REJECTS it and "was it rejected" cannot see the difference -- which is
# exactly how a redundant-looking length bound gets deleted. What the bound
# actually buys is a clean rc=1 and silence, and rc=2 is the same
# neither-branch shape `drive.sh`'s totality guard exists to prevent. So assert
# the property, not the outcome.
sb="$(new_sandbox)"
( load_sut "$sb"; valid_port 10000000000000000000; echo "rc=$?" ) \
  >"$sb/total.out" 2>"$sb/total.err"
check "valid_port stays total on an overflowing port (clean rc)" "rc=1" \
  "$(cat "$sb/total.out")"
check "valid_port stays total on an overflowing port (silent)" "" \
  "$(cat "$sb/total.err")"

echo "== plist rendering =="
sb="$(new_sandbox)"
(
  load_sut "$sb"
  configure --port 8788 --state-dir "$sb/state" --repo-src "$sb/src" --node /usr/bin/node
  render_plist >"$sb/rendered.plist"
) >"$sb/render.out" 2>&1
check "render exits 0" "0" "$?"
check "no placeholder survives rendering" "0" \
  "$(grep -qE '\{\{' "$sb/rendered.plist" && echo 1 || echo 0)"
check "rendered plist parses as a plist" "ok" "$(python3 - "$sb/rendered.plist" <<'EOS'
import plistlib, sys
try:
    plistlib.load(open(sys.argv[1], 'rb')); print('ok')
except Exception as e:
    print('parse error: %s' % e)
EOS
)"

# Read the parsed plist rather than grepping the text: an assertion about
# `Label` must be about the key's VALUE, not about a string appearing anywhere
# in the file (a comment mentioning the label would satisfy a grep).
# `grep -c` is a COUNT, and coercing one to a boolean by truncation reads 12 as
# 1. These assertions only ever mean "did this happen at all", so say that.
has() { # $1=pattern $2=file  -> 1 if present, 0 if not
  grep -qE "$1" "$2" && echo 1 || echo 0
}

plist_get() { # $1=file $2=python expression over `p`
  python3 - "$1" "$2" <<'EOS'
import plistlib, sys
p = plistlib.load(open(sys.argv[1], 'rb'))
try:
    print(eval(sys.argv[2]))
except Exception as e:
    print('ERR:%s' % e)
EOS
}
R="$sb/rendered.plist"
check "label" "com.autonomy.studio-server" "$(plist_get "$R" "p['Label']")"
check "port" "8788" "$(plist_get "$R" "p['EnvironmentVariables']['PORT']")"
check "binds loopback only" "127.0.0.1" "$(plist_get "$R" "p['EnvironmentVariables']['HOST']")"
check "runs the BUILT entrypoint under node" "/usr/bin/node" \
  "$(plist_get "$R" "p['ProgramArguments'][0]")"
check "entrypoint is dist, not src" "1" \
  "$(plist_get "$R" "int(p['ProgramArguments'][1].endswith('/studio/packages/server/dist/index.js'))")"
check "restarts if it exits" "True" "$(plist_get "$R" "p['KeepAlive']")"
check "starts at load" "True" "$(plist_get "$R" "p['RunAtLoad']")"
check "throttled against crash-looping" "1" \
  "$(plist_get "$R" "int(p['ThrottleInterval'] >= 10)")"

echo "== isolation invariants =="
# These four are the whole reason the unit is shaped this way. Each guards a
# concrete, evidenced failure, so each is asserted rather than left to review.
#
# (1)+(2) TWO studio servers against ONE sqlite file corrupt each other's runs:
#   `index.ts` reconcileOnBoot treats every `running` row as a crash survivor and
#   pumps it without the drive lock, and lease.ts judges liveness from IN-PROCESS
#   `drives.activeRunIds()`, so instance B reclaims instance A's live runs. The
#   supervised service must therefore never share a DB (or a git workspace root,
#   which is cwd-relative by default) with a developer's `pnpm dev`.
# (3) The service's CODE must not live in the loop's working checkout: the loop
#   branch-switches and rebuilds it every fire, `dist/` is gitignored so a
#   checkout does not restore it, and KeepAlive would then boot the quota source
#   from a foreign branch's half-written build at the exact moment it is needed.
# (4) AUTONOMY_DATA_DIR must NOT be set: it also relocates the master key file,
#   so pinning it would mint a NEW key and silently orphan every existing secret.
ENVD="p['EnvironmentVariables']"
check "DB is outside the loop checkout" "0" \
  "$(plist_get "$R" "int('$sb/src' in ${ENVD}['DB_PATH'])")"
check "DB is under the service state dir" "1" \
  "$(plist_get "$R" "int(${ENVD}['DB_PATH'].startswith('$sb/state'))")"
check "git workspace root is pinned outside the checkout" "1" \
  "$(plist_get "$R" "int(${ENVD}['WORKSPACE_GIT_ROOT'].startswith('$sb/state'))")"
check "service code is outside the loop checkout" "0" \
  "$(plist_get "$R" "int(p['WorkingDirectory'].startswith('$sb/src'))")"
check "AUTONOMY_DATA_DIR is not set (would orphan the master key)" "0" \
  "$(plist_get "$R" "int('AUTONOMY_DATA_DIR' in $ENVD)")"
check "quota reader is left enabled" "0" \
  "$(plist_get "$R" "int('CLAUDE_QUOTA_ENABLED' in $ENVD)")"

echo "== rendering is deterministic =="
sb2="$(new_sandbox)"
(
  load_sut "$sb2"
  configure --port 8788 --state-dir "$sb2/state" --repo-src "$sb2/src" --node /usr/bin/node
  render_plist >"$sb2/a.plist"; render_plist >"$sb2/b.plist"
) >/dev/null 2>&1
check "two renders are byte-identical" "0" \
  "$(cmp -s "$sb2/a.plist" "$sb2/b.plist"; echo $?)"
# `cmp -s` on two EMPTY files also returns 0, so the assertion above passes if
# render_plist is replaced by `true` -- the redirect creates both files either
# way. Anchor it to real content.
check "the deterministic render is not empty" "1" "$(has '<key>Label</key>' "$sb2/a.plist")"

echo "== --dry-run touches nothing =="
sb="$(new_sandbox)"
( load_sut "$sb"; main --dry-run --port 8788 --state-dir "$sb/state" \
    --repo-src "$sb/src" --node /usr/bin/node ) >"$sb/dry.out" 2>&1
check "dry-run exits 0" "0" "$?"
check "dry-run installed no LaunchAgent" "0" \
  "$(find "$sb/home/Library/LaunchAgents" -type f | wc -l | tr -d ' ')"
check "dry-run ran no launchctl" "0" "$(wc -l <"$sb/launchctl.calls" | tr -d ' ')"
check "dry-run ran no pnpm" "0" "$(wc -l <"$sb/pnpm.calls" | tr -d ' ')"
check "dry-run ran no git" "0" "$(wc -l <"$sb/git.calls" | tr -d ' ')"
check "dry-run still printed the plist it WOULD install" "1" \
  "$(has '<key>Label</key>' "$sb/dry.out")"

echo "== install =="
sb="$(new_sandbox)"
( load_sut "$sb"; main --port 8788 --state-dir "$sb/state" \
    --repo-src "$sb/src" --node /usr/bin/node ) >"$sb/install.out" 2>&1
inst_rc=$?
P="$sb/home/Library/LaunchAgents/com.autonomy.studio-server.plist"
check "install exits 0" "0" "$inst_rc"
check "LaunchAgent written to HOME" "1" "$([ -f "$P" ] && echo 1 || echo 0)"
check "installed plist parses" "com.autonomy.studio-server" "$(plist_get "$P" "p['Label']")"
check "provisioned an isolated clone" "1" "$(has '^clone .*--local' "$sb/git.calls")"
check "pinned the clone to origin/main" "1" \
  "$(has 'reset --hard.*origin/main' "$sb/git.calls")"
check "built the service tree" "1" "$(has ' build$' "$sb/pnpm.calls")"
check "bootstrapped the unit" "1" "$(has '^bootstrap gui/' "$sb/launchctl.calls")"
check "booted out the old unit first" "1" "$(has '^bootout gui/' "$sb/launchctl.calls")"
check "bootout precedes bootstrap" "1" \
  "$(awk '/^bootout/{b=NR} /^bootstrap/{if(b && NR>b) print 1; exit}' "$sb/launchctl.calls")"
# `bootout` returns as soon as it has SIGNALLED the job, and this server shuts
# down gracefully, so bootstrapping straight away fails with `5: Input/output
# error` and leaves the new plist on disk while the OLD process keeps running.
# Measured on the second install, 2026-07-29. The installer must therefore poll
# the job list in BETWEEN the two.
# A weaker version of this ("some list call happened in between") passed with
# the wait loop DELETED, because the post-loop sanity check also calls list.
# So drive the stub: report the job loaded for 3 polls, then gone, and require
# the installer to have polled past all of them before bootstrapping.
sbw="$(new_sandbox)"
( load_sut "$sbw"; LIST_LOADED_TIMES=3 main --port 8788 --state-dir "$sbw/state" \
    --repo-src "$sbw/src" --node /usr/bin/node ) >"$sbw/wait.out" 2>&1
check "waits for the teardown before bootstrapping" "1" \
  "$(awk '/^list/ { n++ } /^bootstrap/ { print (n >= 4) ? 1 : 0; exit }' "$sbw/launchctl.calls")"
check "and still bootstraps once the job is gone" "1" \
  "$(has '^bootstrap gui/' "$sbw/launchctl.calls")"

echo "== install tolerates 'not currently loaded' =="
# `launchctl bootout` on a job that was never loaded exits 3 (or 113). A first
# install would fail outright if that were treated as an error.
sb="$(new_sandbox)"
( load_sut "$sb"; BOOTOUT_RC=3 main --port 8788 --state-dir "$sb/state" \
    --repo-src "$sb/src" --node /usr/bin/node ) >"$sb/install3.out" 2>&1
check "install survives bootout rc=3" "0" "$?"
check "still bootstrapped after rc=3" "1" "$(has '^bootstrap gui/' "$sb/launchctl.calls")"

echo "== install refuses a foreign listener on the port =="
# A wrong-but-answering server on the port reads as UNREADABLE forever while
# looking correctly configured -- the exact hazard #765 records for 8080. Fail
# loudly at install rather than silently at 03:05.
sb="$(new_sandbox)"
( load_sut "$sb"; LSOF_PID="99999" main --port 8788 --state-dir "$sb/state" \
    --repo-src "$sb/src" --node /usr/bin/node ) >"$sb/busy.out" 2>&1
check "install refuses when the port is taken" "1" \
  "$([ "$?" -ne 0 ] && echo 1 || echo 0)"
# Name the pid: without this the assertion above passes just as happily when the
# conflict detection is deleted and the failure comes from somewhere else.
check "the refusal identifies the offending pid" "1" "$(has 'pid 99999' "$sb/busy.out")"
check "refusal installed no LaunchAgent" "0" \
  "$(find "$sb/home/Library/LaunchAgents" -type f | wc -l | tr -d ' ')"
check "refusal ran no pnpm (fails before the expensive provision)" "0" \
  "$(wc -l <"$sb/pnpm.calls" | tr -d ' ')"

echo "== uninstall =="
sb="$(new_sandbox)"
( load_sut "$sb"
  main --port 8788 --state-dir "$sb/state" --repo-src "$sb/src" --node /usr/bin/node
  : >"$sb/launchctl.calls"
  main --uninstall --state-dir "$sb/state" ) >"$sb/uninstall.out" 2>&1
check "uninstall exits 0" "0" "$?"
check "uninstall removed the LaunchAgent" "0" \
  "$(find "$sb/home/Library/LaunchAgents" -type f | wc -l | tr -d ' ')"
check "uninstall booted out the right label" "1" \
  "$(has 'com\.autonomy\.studio-server' "$sb/launchctl.calls")"
check "uninstall did NOT delete the service state" "1" \
  "$([ -d "$sb/state" ] && echo 1 || echo 0)"

echo "== refusals that protect the single-instance invariant =="
# The isolation assertions above only check the values the test itself passes in,
# so they cannot catch an installer that happily accepts a hostile configuration.
# These do.
sb="$(new_sandbox)"
( load_sut "$sb"; main --port 8080 --state-dir "$sb/state" --repo-src "$sb/src" \
    --node /usr/bin/node ) >"$sb/p8080.out" 2>&1
check "refuses --port 8080 (studio's dev default)" "1" \
  "$([ "$?" -ne 0 ] && echo 1 || echo 0)"
check "the 8080 refusal explains itself" "1" "$(has "dev-server default" "$sb/p8080.out")"
check "the 8080 refusal installed nothing" "0" \
  "$(find "$sb/home/Library/LaunchAgents" -type f | wc -l | tr -d ' ')"

sb="$(new_sandbox)"
( load_sut "$sb"; main --port 8788 --state-dir "$sb/src/studio/state" \
    --repo-src "$sb/src" --node /usr/bin/node ) >"$sb/inside.out" 2>&1
check "refuses a --state-dir inside the source checkout" "1" \
  "$([ "$?" -ne 0 ] && echo 1 || echo 0)"
check "the state-dir refusal installed nothing" "0" \
  "$(find "$sb/home/Library/LaunchAgents" -type f | wc -l | tr -d ' ')"

sb="$(new_sandbox)"
( load_sut "$sb"; main --port ) >"$sb/noval.out" 2>&1
check "a flag with no value fails" "1" "$([ "$?" -ne 0 ] && echo 1 || echo 0)"
# It used to exit 1 printing absolutely nothing.
check "a flag with no value SAYS so" "1" "$(has 'needs a value' "$sb/noval.out")"

sb="$(new_sandbox)"
( load_sut "$sb"; main --port 8788 --state-dir "$sb/state" --repo-src "$sb/src" \
    --node /usr/bin/node ) >/dev/null 2>&1
rm -f "$sb/bin/node" 2>/dev/null
# `--uninstall` and `--help` must not need node: if node moves you still have to
# be able to remove a crash-looping unit.
( load_sut "$sb"; PATH="$sb/bin:/usr/bin:/bin"; main --uninstall --state-dir "$sb/state" ) \
  >"$sb/nonode.out" 2>&1
check "--uninstall works without node on PATH" "0" "$?"

# Teardown must not depend on the preconditions for SETUP. Anything `configure`
# rejects is rejected for every mode, so a moved template or an awkward
# --state-dir would block removing a crash-looping unit. Same class of bug as
# the node lookup above; caught by the review bot on the first push.
sb="$(new_sandbox)"
( load_sut "$sb"; main --port 8788 --state-dir "$sb/state" --repo-src "$sb/src" \
    --node /usr/bin/node ) >/dev/null 2>&1
(
  load_sut "$sb"   # sourcing sets TMPL, so the override has to come after it
  # shellcheck disable=SC2034  # consumed by the sourced installer, not by this file
  TMPL="$sb/definitely-not-here.tmpl"
  main --uninstall --state-dir "$sb/state"
) >"$sb/notmpl.out" 2>&1
check "--uninstall works with the template missing" "0" "$?"
check "and it really did remove the unit" "0" \
  "$(find "$sb/home/Library/LaunchAgents" -type f | wc -l | tr -d ' ')"
sb="$(new_sandbox)"
( load_sut "$sb"; main --uninstall --state-dir "$sb/src/inside" --repo-src "$sb/src" ) \
  >"$sb/insideun.out" 2>&1
check "--uninstall is not blocked by an install-only --state-dir check" "0" "$?"
# Same rule for the port refusal and the character checks: they only matter when
# a plist is being written, so an operator recovering with an explicit override
# must not be turned away on install-only grounds.
sb="$(new_sandbox)"
( load_sut "$sb"; main --uninstall --port 8080 --state-dir "$sb/state" ) \
  >"$sb/un8080.out" 2>&1
check "--uninstall is not blocked by the 8080 refusal" "0" "$?"
sb="$(new_sandbox)"
( load_sut "$sb"; main --uninstall --port 0080 --state-dir "$sb/st&ate" ) \
  >"$sb/unbad.out" 2>&1
check "--uninstall is not blocked by install-only argument validation" "0" "$?"
sb="$(new_sandbox)"
( load_sut "$sb"; main --uninstall --state-dir "" ) >"$sb/unempty.out" 2>&1
check "--uninstall is not blocked by an empty --state-dir" "0" "$?"
sb="$(new_sandbox)"
( load_sut "$sb"; main --port 8788 --state-dir "" --repo-src "$sb/src" \
    --node /usr/bin/node ) >"$sb/inempty.out" 2>&1
check "INSTALL still refuses an empty --state-dir" "1" \
  "$([ "$?" -ne 0 ] && echo 1 || echo 0)"
check "the empty --state-dir refusal explains itself" "1" \
  "$(has 'may not be empty' "$sb/inempty.out")"

echo "== uninstall is scoped to THIS HOME's installation =="
# The rm was HOME-scoped but the bootout was not, so running with a temp HOME
# unloaded the operator's LIVE service while reporting a tidy success. Observed
# on 2026-07-29 during review of this very change.
sb="$(new_sandbox)"
( load_sut "$sb"; main --uninstall --state-dir "$sb/state" ) >"$sb/foreign.out" 2>&1
check "uninstall with nothing installed exits 0" "0" "$?"
check "uninstall with nothing installed runs NO launchctl" "0" \
  "$(wc -l <"$sb/launchctl.calls" | tr -d ' ')"
check "and says how to unload a job owned by another HOME" "1" \
  "$(has 'different HOME' "$sb/foreign.out")"

echo "== drive.sh and the unit agree on the port =="
# The single-source-of-truth check. `drive.sh`'s default is the ONLY place the
# port is written down for the guard; the driver LaunchAgent deliberately does
# not pin STUDIO_QUOTA_URL any more, because two copies of a constant is how the
# 8080 pin came to outlive the reason for it.
DRIVE_PORT="$(grep -o 'STUDIO_QUOTA_URL="\${STUDIO_QUOTA_URL:-http://127\.0\.0\.1:[0-9]*' \
  "$HERE/drive.sh" | grep -o '[0-9]*$')"
check "drive.sh default port matches the installer default" "$DRIVE_PORT" \
  "$(sed -n 's/^DEFAULT_PORT=\([0-9]*\).*/\1/p' "$SUT" | head -1)"
# The KEY element, not the bare name: the plist now carries a comment saying
# why the pin was removed, and a bare-name grep would read that as the pin.
check "driver LaunchAgent does not pin STUDIO_QUOTA_URL" "0" \
  "$(has '<key>STUDIO_QUOTA_URL</key>' "$HERE/com.autonomy.studio-build-driver.plist")"

####################################################################
# #773 -- staleness, drift reporting, and the guards that make
# re-running the installer safe. There is deliberately NO scheduled
# updater unit: see the header of install_studio_server.sh.
####################################################################

# A sandbox that has been through a REAL install, plus the built artifact the
# stubs cannot produce (`pnpm` is a stub, so nothing ever writes dist/). This is
# the starting point for every `--update` case.
#
# NOTE it deliberately installs with LOADED_LABELS unset. With the label
# reported as loaded, `load_unit`'s teardown-wait would poll a stub that never
# stops saying "loaded" -- 60 real seconds per call.
installed_sandbox() {
  is_sb="$(new_sandbox)"
  ( load_sut "$is_sb"; main --port 8788 --state-dir "$is_sb/state" \
      --repo-src "$is_sb/src" --node /usr/bin/node ) >"$is_sb/install.log" 2>&1
  provisioned_tree "$is_sb"
  # Park the install's OWN launchctl traffic and start the case with an empty
  # log. Not tidiness: `list` treats a label as unloaded once a bootout for it
  # appears in this log, so leaving the install's two bootouts in place made
  # every later case read both units as NOT loaded. `service_is_current` then
  # returned false for that reason alone, and the staleness comparison it is
  # supposed to be testing was never reached -- proved by mutation, which
  # deleted the comparison outright with the whole suite still green.
  mv "$is_sb/launchctl.calls" "$is_sb/install.launchctl.calls"
  : >"$is_sb/launchctl.calls"
  echo "$is_sb"
}

# The artifacts a REAL provision leaves behind that the stubs cannot: `git` is a
# recording stub, so no clone happens and there is no `.git`; `pnpm` is one too,
# so nothing writes `dist/`. Without these a second run sees a non-empty tree
# with no `.git` and correctly refuses to clone over it, which is a real
# behaviour but not the one any of these cases is about.
provisioned_tree() { # $1=sandbox root
  mkdir -p "$1/state/repo/.git" "$1/state/repo/studio/packages/server/dist"
  : >"$1/state/repo/studio/packages/server/dist/index.js"
}
LOADED="com.autonomy.studio-server:4242"
AGENTS_DIR_N() { find "$1/home/Library/LaunchAgents" -type f | wc -l | tr -d ' '; }

echo "== --update does nothing when the service is current =="
sb="$(installed_sandbox)"
: >"$sb/pnpm.calls"; : >"$sb/launchctl.calls"
( load_sut "$sb"; LOADED_LABELS="$LOADED" main --update --port 8788 \
    --state-dir "$sb/state" --repo-src "$sb/src" --node /usr/bin/node ) >"$sb/cur.out" 2>&1
check "a no-op update exits 0" "0" "$?"
check "and says so with the sha" "1" "$(has 'already current at 0riginsha' "$sb/cur.out")"
check "and rebuilds nothing" "0" "$(wc -l <"$sb/pnpm.calls" | tr -d ' ')"
check "and never bounces the server" "0" \
  "$(has '^bootstrap' "$sb/launchctl.calls")"

echo "== --update acts when the service is stale =="
sb="$(installed_sandbox)"
: >"$sb/pnpm.calls"
( load_sut "$sb"; GIT_ORIGIN_SHA="newsha1" LOADED_LABELS="$LOADED" \
    main --update --port 8788 --state-dir "$sb/state" --repo-src "$sb/src" \
    --node /usr/bin/node ) >"$sb/stale.out" 2>&1
check "a stale update exits 0" "0" "$?"
check "and rebuilds" "1" "$(has ' build$' "$sb/pnpm.calls")"
check "and re-stamps the new sha" "newsha1" "$(cat "$sb/state/built.sha")"

echo "== staleness is measured from the BUILD, not from HEAD =="
# `provision` does `reset --hard origin/main` BEFORE `pnpm build`, so a failed
# build leaves HEAD already advanced. Comparing HEAD to origin/main would then
# report "current" forever while the service ran old code -- a loud failure
# converted into a silent permanent one, which is strictly worse than the manual
# status quo this replaces.
sb="$(new_sandbox)"
( load_sut "$sb"; PNPM_BUILD_RC=1 main --port 8788 --state-dir "$sb/state" \
    --repo-src "$sb/src" --node /usr/bin/node ) >"$sb/failbuild.out" 2>&1
check "a failed build fails the install" "1" "$([ "$?" -ne 0 ] && echo 1 || echo 0)"
check "a failed build writes NO build stamp" "0" \
  "$([ -f "$sb/state/built.sha" ] && echo 1 || echo 0)"
# The consequence, asserted directly, and isolated to the STAMP clause: take a
# fully installed service -- both plists present, both units loaded, dist built,
# HEAD at origin/main -- and remove only the stamp, as a failed build would. Every
# other clause of `service_is_current` is satisfied, so a HEAD-based check would
# say "current" here. It must not.
sb="$(installed_sandbox)"
rm -f "$sb/state/built.sha"
: >"$sb/pnpm.calls"
( load_sut "$sb"; LOADED_LABELS="$LOADED" main --update --port 8788 \
    --state-dir "$sb/state" --repo-src "$sb/src" --node /usr/bin/node ) >"$sb/retry.out" 2>&1
check "an unstamped tree is NOT current, even at origin/main" "0" \
  "$(has 'already current' "$sb/retry.out")"
check "so the next update retries the build" "1" "$(has ' build$' "$sb/pnpm.calls")"

echo "== a service that does not ANSWER is not current =="
# The clause every other one lets through. A tree that built and bootstrapped but
# never answered leaves a satisfied stamp, a present dist, both plists and both
# units "loaded" -- launchd prints `-` in the pid column for a job it respawns
# every 30s exactly as it does for a healthy idle one. Without a liveness probe
# the spend guard's own source can be down permanently while every run reports
# "already current". `wait_ready` cannot cover this: it runs once, at the end of
# an install, and its failure leaves all of the above behind.
sb="$(installed_sandbox)"
: >"$sb/pnpm.calls"
( load_sut "$sb"; CURL_RC=7 LOADED_LABELS="$LOADED" main --update --port 8788 \
    --state-dir "$sb/state" --repo-src "$sb/src" --node /usr/bin/node ) >"$sb/dead.out" 2>&1
check "a server that does not answer is not current" "0" \
  "$(has 'already current' "$sb/dead.out")"
check "so the update rebuilds it" "1" "$(has ' build$' "$sb/pnpm.calls")"

# ...but a BLIP must not buy a rebuild. "Not current" costs a full `pnpm install`
# + build + bounce -- minutes of work and an outage of the very source being
# protected -- so the probe is retried, and that retry needs its own case: with a
# stub that always fails, a retried probe and a single-shot one are
# indistinguishable.
sb="$(installed_sandbox)"
rm -f "$sb/curl.calls.health"       # the install's own /health probe
: >"$sb/pnpm.calls"
( load_sut "$sb"; CURL_FAIL_TIMES=2 LOADED_LABELS="$LOADED" main --update --port 8788 \
    --state-dir "$sb/state" --repo-src "$sb/src" --node /usr/bin/node ) >"$sb/blip.out" 2>&1
check "a transient non-answer is ridden out" "1" "$(has 'already current' "$sb/blip.out")"
check "and buys no rebuild" "0" "$(wc -l <"$sb/pnpm.calls" | tr -d ' ')"

echo "== --update self-heals a wiped dist or an unloaded unit =="
sb="$(installed_sandbox)"
rm -f "$sb/state/repo/studio/packages/server/dist/index.js"
: >"$sb/pnpm.calls"
( load_sut "$sb"; LOADED_LABELS="$LOADED" main --update --port 8788 \
    --state-dir "$sb/state" --repo-src "$sb/src" --node /usr/bin/node ) >"$sb/nodist.out" 2>&1
check "a missing dist is not current" "1" "$(has ' build$' "$sb/pnpm.calls")"

sb="$(installed_sandbox)"
: >"$sb/pnpm.calls"
# Nothing loaded: the plists are on disk and the stamp matches, but launchd is
# not running either job. Reporting "current" there leaves the quota source down.
( load_sut "$sb"; main --update --port 8788 --state-dir "$sb/state" \
    --repo-src "$sb/src" --node /usr/bin/node ) >"$sb/unloaded.out" 2>&1
check "an unloaded unit is not current" "1" "$(has ' build$' "$sb/pnpm.calls")"

echo "== a failed fetch is UNKNOWN, never current =="
# `origin/main` inside the clone is a CACHED local ref, so a failed fetch leaves
# a stale one that compares equal to the stamp. Measured 2026-07-30: the live
# clone's cached ref was five commits behind with nothing inside it able to tell.
sb="$(installed_sandbox)"
: >"$sb/pnpm.calls"
( load_sut "$sb"; GIT_FETCH_RC=1 LOADED_LABELS="$LOADED" main --update \
    --port 8788 --state-dir "$sb/state" --repo-src "$sb/src" \
    --node /usr/bin/node ) >"$sb/fetchfail.out" 2>&1
check "a failed fetch fails the update" "1" "$([ "$?" -ne 0 ] && echo 1 || echo 0)"
check "and says staleness is UNKNOWN" "1" "$(has 'UNKNOWN' "$sb/fetchfail.out")"
check "and does NOT claim the service is current" "0" \
  "$(has 'already current' "$sb/fetchfail.out")"
check "and changes nothing" "0" "$(wc -l <"$sb/pnpm.calls" | tr -d ' ')"

echo "== --force overrides the staleness check =="
sb="$(installed_sandbox)"
: >"$sb/pnpm.calls"
( load_sut "$sb"; LOADED_LABELS="$LOADED" main --update --force --port 8788 \
    --state-dir "$sb/state" --repo-src "$sb/src" --node /usr/bin/node ) >"$sb/force.out" 2>&1
check "--force rebuilds a current service" "1" "$(has ' build$' "$sb/pnpm.calls")"

echo "== concurrent runs are serialised =="
# Two runs can otherwise land in the same tree at once -- an operator re-running
# the installer while an earlier one is still building, or a future on-demand
# updater (#792 phase 2) alongside a hand run. Two `reset --hard` plus two
# interleaved bootout/bootstrap cycles is a corrupt checkout and a
# possibly-unloaded unit.
sb="$(installed_sandbox)"
mkdir -p "$sb/state/.install.lock"
: >"$sb/pnpm.calls"
( load_sut "$sb"; GIT_ORIGIN_SHA="newsha1" LOADED_LABELS="$LOADED" \
    main --update --port 8788 --state-dir "$sb/state" --repo-src "$sb/src" \
    --node /usr/bin/node ) >"$sb/lock.out" 2>&1
check "a run that cannot get the lock exits 0" "0" "$?"
check "and touches nothing" "0" "$(wc -l <"$sb/pnpm.calls" | tr -d ' ')"
check "and says why" "1" "$(has 'another install is in progress' "$sb/lock.out")"
# `release_lock` must not delete a lock this run never owned. Two runs that both
# see a >60m lock can both steal it; without the owner stamp the loser deletes
# the winner's FRESH lock on its way out, leaving the tree unprotected while both
# are still working in it.
check "and does not delete the other run's lock" "1" \
  "$([ -d "$sb/state/.install.lock" ] && echo 1 || echo 0)"

# `release_lock` head-on, because the case above never reaches it (a run that
# fails to acquire returns before `main_locked`). Two runs that both see a >60m
# lock can both steal it, and without the owner stamp the loser deletes the
# WINNER's fresh lock on its way out, leaving the tree unprotected while both are
# still working in it.
sb="$(new_sandbox)"
(
  load_sut "$sb"
  configure --port 8788 --state-dir "$sb/state" --repo-src "$sb/src" --node /usr/bin/node
  mkdir -p "$LOCK_DIR"
  printf '999999\n' >"$LOCK_DIR/owner"     # a lock owned by somebody else
  release_lock
  [ -d "$LOCK_DIR" ] && echo KEPT
) >"$sb/rel.out" 2>&1
check "release_lock leaves a lock it does not own" "1" "$(has 'KEPT' "$sb/rel.out")"
# ...and still releases its own, or every run would leave one behind.
sb="$(new_sandbox)"
(
  load_sut "$sb"
  configure --port 8788 --state-dir "$sb/state" --repo-src "$sb/src" --node /usr/bin/node
  acquire_lock && release_lock
  [ -d "$LOCK_DIR" ] || echo RELEASED
) >"$sb/rel2.out" 2>&1
check "release_lock releases its own" "1" "$(has 'RELEASED' "$sb/rel2.out")"

# A lock that cannot be CREATED is a different thing from a lock someone else
# holds, and collapsing them reported "another install is in progress" for an
# unwritable state dir and exited 0 -- a real fault reported as a tidy no-op,
# with a false explanation attached.
sb="$(new_sandbox)"
( load_sut "$sb"; main --update --port 8788 --state-dir /dev/null/nope/state \
    --repo-src "$sb/src" --node /usr/bin/node ) >"$sb/nolock.out" 2>&1
check "an uncreatable state dir FAILS" "1" "$([ "$?" -ne 0 ] && echo 1 || echo 0)"
check "and is not misreported as a concurrent install" "0" \
  "$(has 'another install is in progress' "$sb/nolock.out")"
check "and says what was actually wrong" "1" \
  "$(has 'cannot create the state dir' "$sb/nolock.out")"

echo "== an OLD lock is not automatically an abandoned one =="
# Age is not abandonment. A cold `pnpm install` plus a full build can run past an
# hour on a slow link, and stealing that run's lock is not a recovery -- both runs
# then race `reset --hard`, build and bootstrap in one tree, which is the exact
# corruption the lock exists to prevent. The owner stamp makes the real question
# answerable: is that process still there.
sb="$(installed_sandbox)"
mkdir -p "$sb/state/.install.lock"
printf '%s\n' "$$" >"$sb/state/.install.lock/owner"   # a pid that IS alive: us
touch -t 200001010000 "$sb/state/.install.lock"        # ...and an ancient mtime
: >"$sb/pnpm.calls"
( load_sut "$sb"; GIT_ORIGIN_SHA="newsha1" LOADED_LABELS="$LOADED" main --update \
    --port 8788 --state-dir "$sb/state" --repo-src "$sb/src" \
    --node /usr/bin/node ) >"$sb/livelock.out" 2>&1
check "an old lock with a LIVE owner is not stolen" "1" \
  "$(has 'will NOT be stolen' "$sb/livelock.out")"
check "and the run defers instead of building" "0" "$(wc -l <"$sb/pnpm.calls" | tr -d ' ')"
check "and the lock survives" "1" \
  "$([ -d "$sb/state/.install.lock" ] && echo 1 || echo 0)"

# ...but a lock whose owner is genuinely gone must still be recoverable, or one
# killed install wedges every later run forever.
sb="$(installed_sandbox)"
( exit 0 ) & dead_pid=$!; wait "$dead_pid" 2>/dev/null   # a pid that is definitely NOT alive
mkdir -p "$sb/state/.install.lock"
printf '%s\n' "$dead_pid" >"$sb/state/.install.lock/owner"
touch -t 200001010000 "$sb/state/.install.lock"
: >"$sb/pnpm.calls"
( load_sut "$sb"; GIT_ORIGIN_SHA="newsha1" LOADED_LABELS="$LOADED" main --update \
    --port 8788 --state-dir "$sb/state" --repo-src "$sb/src" \
    --node /usr/bin/node ) >"$sb/deadlock.out" 2>&1
check "an old lock with a DEAD owner is stolen" "1" \
  "$(has 'removing an abandoned lock' "$sb/deadlock.out")"
check "and the run proceeds" "1" "$(has ' build$' "$sb/pnpm.calls")"

echo "== a lock that cannot be CREATED is not a conflict =="
# `mkdir` reports EEXIST and "permission denied" identically, so without looking
# at the directory itself a real failure is announced as "another install is in
# progress" -- the same misreport the STATE_DIR mkdir already avoids one level
# up. Here the state dir exists (so `mkdir -p` succeeds) but is not writable.
sb="$(new_sandbox)"
mkdir -p "$sb/state"
if [ "$(id -u)" = "0" ]; then
  echo "ok   - (skipped as root: mode bits cannot block root's mkdir)"
else
  chmod 500 "$sb/state"
  ( load_sut "$sb"; main --update --port 8788 --state-dir "$sb/state" \
      --repo-src "$sb/src" --node /usr/bin/node ) >"$sb/rolock.out" 2>&1
  rolock_rc=$?
  chmod 700 "$sb/state"    # or the sandbox cleanup cannot remove it
  check "an uncreatable lock FAILS" "1" "$([ "$rolock_rc" -ne 0 ] && echo 1 || echo 0)"
  check "and is not called a concurrent install" "0" \
    "$(has 'another install is in progress' "$sb/rolock.out")"
  check "and says the lock could not be created" "1" \
    "$(has 'cannot create the lock' "$sb/rolock.out")"
fi

echo "== uninstall does not race a live install =="
sb="$(installed_sandbox)"
mkdir -p "$sb/state/.install.lock"
: >"$sb/launchctl.calls"
( load_sut "$sb"; main --uninstall --state-dir "$sb/state" ) >"$sb/unlock.out" 2>&1
check "uninstall refuses while an install holds the lock" "1" \
  "$([ "$?" -ne 0 ] && echo 1 || echo 0)"
check "and leaves the unit in place" "1" "$(AGENTS_DIR_N "$sb")"
# The MESSAGE, not just the exit code. `acquire_lock` distinguishes "someone
# else holds it" (rc=1) from "I could not create it at all" (rc=2), and this
# branch must only claim a concurrent install for the first -- reporting a
# permissions failure as a conflict sends the operator hunting for a process
# that does not exist. Without this assertion the refusal text could be deleted
# outright and the two checks above would still pass.
check "and says an install is in progress" "1" \
  "$(has 'not uninstalling while an install is in progress' "$sb/unlock.out")"

echo "== --status reports drift without changing anything =="
sb="$(installed_sandbox)"
: >"$sb/pnpm.calls"; : >"$sb/launchctl.calls"
( load_sut "$sb"; LOADED_LABELS="$LOADED" main --status \
    --state-dir "$sb/state" ) >"$sb/status.out" 2>&1
check "status exits 0" "0" "$?"
check "status reports the built sha" "1" "$(has 'built sha: *0riginsha' "$sb/status.out")"
check "status reports the unit" "1" \
  "$(has 'com\.autonomy\.studio-server: loaded' "$sb/status.out")"
# The verdict, not two shas to diff by eye.
check "status states a verdict" "1" "$(has 'verdict: *CURRENT' "$sb/status.out")"

check "status runs no pnpm" "0" "$(wc -l <"$sb/pnpm.calls" | tr -d ' ')"

# THE property that makes it a drift report rather than a comforting one.
# `origin/main` in the clone is a CACHED ref that only advances when something
# fetches, so a status built on it fails in the same direction as the thing it
# monitors: the longer nobody updates, the more confidently it says "current".
sb="$(installed_sandbox)"
: >"$sb/git.calls"; : >"$sb/pnpm.calls"
( load_sut "$sb"; GIT_ORIGIN_SHA="newsha1" LOADED_LABELS="$LOADED" main --status \
    --state-dir "$sb/state" ) >"$sb/statusfetch.out" 2>&1
check "status fetches before it compares" "1" "$(has 'fetch .*origin main' "$sb/git.calls")"
check "and calls a drifted service NEEDS UPDATE" "1" \
  "$(has 'verdict: *NEEDS UPDATE .* behind origin/main' "$sb/statusfetch.out")"
check "status still builds nothing" "0" "$(wc -l <"$sb/pnpm.calls" | tr -d ' ')"
check "status loads nothing" "0" "$(has '^bootstrap' "$sb/launchctl.calls")"
# Asserting the lock dir is absent afterwards only catches a LEAKED lock, not an
# acquired-and-released one -- with that assertion alone, wrapping `--status` in
# acquire_lock/release_lock left the suite green. Point it at a state dir that
# does not exist and require that it was not created: `acquire_lock` starts with
# `mkdir -p "$STATE_DIR"`, so taking the lock at all would show up here.
sb="$(new_sandbox)"
( load_sut "$sb"; main --status --state-dir "$sb/never-existed" ) >"$sb/status3.out" 2>&1
check "status exits 0 with nothing installed" "0" "$?"
check "status creates no state dir (so it took no lock)" "0" \
  "$([ -d "$sb/never-existed" ] && echo 1 || echo 0)"

# The verdict must test the SAME clauses as `service_is_current`, or it can print
# CURRENT directly underneath `health: NO ANSWER` -- a drift surface calling a
# demonstrably dead service current, which is the failure this command exists to
# remove. Everything here is current EXCEPT that the server does not answer.
sb="$(installed_sandbox)"
( load_sut "$sb"; CURL_RC=7 LOADED_LABELS="$LOADED" main --status \
    --state-dir "$sb/state" ) >"$sb/statusdead.out" 2>&1
check "a dead server is reported dead" "1" \
  "$(has 'health: *NO ANSWER' "$sb/statusdead.out")"
check "and the verdict does NOT say CURRENT" "0" \
  "$(has 'verdict: *CURRENT' "$sb/statusdead.out")"
check "and it names the reason" "1" \
  "$(has 'does not answer /health' "$sb/statusdead.out")"

# ...but a BLIP is not a dead server. `--status` and `--update` must share one
# definition of "up": if status probed once while `service_is_current` retries
# three times, the two would disagree about the same server and status would cry
# NEEDS UPDATE on something `--update` correctly calls current.
sb="$(installed_sandbox)"
rm -f "$sb/curl.calls.health"       # the install's own /health probe
( load_sut "$sb"; CURL_FAIL_TIMES=2 LOADED_LABELS="$LOADED" main --status \
    --state-dir "$sb/state" ) >"$sb/statusblip.out" 2>&1
check "status rides out a transient non-answer" "1" \
  "$(has 'health: *answers on' "$sb/statusblip.out")"
check "and still calls it CURRENT" "1" "$(has 'verdict: *CURRENT' "$sb/statusblip.out")"
# Diagnosing a broken install must not require the install to be workable.
sb="$(installed_sandbox)"
(
  load_sut "$sb"
  # shellcheck disable=SC2034  # consumed by the sourced installer, not by this file
  TMPL="$sb/definitely-not-here.tmpl"
  main --status --state-dir "$sb/state"
) >"$sb/status2.out" 2>&1
check "status works with a template missing" "0" "$?"

echo "== a non-git tree is refused, not cloned over =="
# Self-healing covers "unit unloaded" and "never built"; it does not cover a
# corrupt tree. `git clone --local` into a non-empty path fails with a message
# about the destination rather than about the real problem, which is a poor thing
# to find in a log after the fact.
sb="$(new_sandbox)"
mkdir -p "$sb/state/repo"; : >"$sb/state/repo/leftover"
( load_sut "$sb"; main --port 8788 --state-dir "$sb/state" --repo-src "$sb/src" \
    --node /usr/bin/node ) >"$sb/nongit.out" 2>&1
check "a non-git service tree fails the install" "1" "$([ "$?" -ne 0 ] && echo 1 || echo 0)"
check "and the message names the real problem" "1" \
  "$(has 'not a git checkout' "$sb/nongit.out")"
check "and it stops before the expensive provision" "0" \
  "$(wc -l <"$sb/pnpm.calls" | tr -d ' ')"

echo "== --dry-run prints the plist and still touches nothing =="
sb="$(new_sandbox)"
( load_sut "$sb"; main --dry-run --port 8788 --state-dir "$sb/state" \
    --repo-src "$sb/src" --node /usr/bin/node ) >"$sb/dry2.out" 2>&1
check "dry-run printed the unit" "1" \
  "$(has '<string>com\.autonomy\.studio-server</string>' "$sb/dry2.out")"
# `acquire_lock` starts with `mkdir -p "$STATE_DIR"`, so this also pins that
# --dry-run returns BEFORE taking the lock.
check "dry-run still created no state dir" "0" \
  "$([ -d "$sb/state" ] && echo 1 || echo 0)"

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILURE(S)"; fi
exit "$fails"
