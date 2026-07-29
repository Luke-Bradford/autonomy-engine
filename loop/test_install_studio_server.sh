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
  cat >"$ns_root/bin/launchctl" <<'EOS'
#!/bin/bash
echo "$*" >>"$LAUNCHCTL_CALLS"
case "$1" in
  bootout) exit "${BOOTOUT_RC:-0}" ;;
  list)
    nf="$LAUNCHCTL_CALLS.listn"
    n=$(cat "$nf" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" >"$nf"
    [ "$n" -le "${LIST_LOADED_TIMES:-0}" ] && printf '4242\t0\tcom.autonomy.studio-server\n'
    ;;
esac
exit 0
EOS
  cat >"$ns_root/bin/pnpm" <<'EOS'
#!/bin/bash
echo "$*" >>"$PNPM_CALLS"
exit 0
EOS
  cat >"$ns_root/bin/git" <<'EOS'
#!/bin/bash
echo "$*" >>"$GIT_CALLS"
case "$*" in
  *"remote get-url"*) echo "https://github.com/Luke-Bradford/autonomy-engine.git" ;;
esac
exit 0
EOS
  cat >"$ns_root/bin/curl" <<'EOS'
#!/bin/bash
echo "$*" >>"$CURL_CALLS"
exit 0
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

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILURE(S)"; fi
exit "$fails"
