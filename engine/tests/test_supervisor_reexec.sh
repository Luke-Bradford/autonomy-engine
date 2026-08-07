#!/usr/bin/env bash
# tests/test_supervisor_reexec.sh -- supervisor self-re-exec at the session
# boundary (#294). A long-lived supervisor's bash is frozen at process start;
# these functions let it adopt merged engine code by exec-ing itself between
# sessions. Sources the real supervisor.sh and calls the real functions:
#   engine_update_ready    -- earned "update ready" verdict (fail-safe: every
#                             failure path says NO; prevention-log #18)
#   should_reexec          -- the boundary decision (defers while a
#                             session.done edge is pending; honours disable)
#   reexec_engine          -- the exec itself (execfail so a failed exec never
#                             kills the process; restores shell state)
#   acquire_supervisor_lock -- lock continuity across a same-pid re-exec
# shellcheck disable=SC2034  # vars consumed inside the sourced supervisor.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_HOME="$(cd "$HERE/.." && pwd)"

# shellcheck source=/dev/null
source "$ENGINE_HOME/bin/supervisor.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# log() writes to $SUPLOG -- point it somewhere harmless for the failure paths.
LOGDIR="$tmp/logs"; mkdir -p "$LOGDIR"
SUPLOG="$LOGDIR/supervisor.log"

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails + 1)); fi
}

mkrepo() { # <dir> -- init a one-commit git repo, echo its HEAD
  mkdir -p "$1"
  (
    cd "$1" || exit 1
    git init -q
    git config user.email t@t; git config user.name t
    : > a; git add a; git commit -qm one
  )
  git -C "$1" rev-parse HEAD
}

# --- engine_update_ready -------------------------------------------------------
home="$tmp/engine"
boot="$(mkrepo "$home")"

# Same sha -> not ready.
if engine_update_ready "$home" "$boot" >/dev/null; then r=ready; else r=no; fi
check "same sha -> not ready" no "$r"

# New commit, clean tree -> ready, prints the new HEAD.
( cd "$home" && : > b && git add b && git commit -qm two )
want="$(git -C "$home" rev-parse HEAD)"
got="$(engine_update_ready "$home" "$boot")"; rc=$?
check "sha differs + clean -> ready (rc 0)" 0 "$rc"
check "prints the new HEAD"                "$want" "$got"

# Dirty tree -> not ready (never exec over uncommitted engine work).
: > "$home/wip"
if engine_update_ready "$home" "$boot" >/dev/null; then r=ready; else r=no; fi
check "dirty tree -> not ready" no "$r"
rm -f "$home/wip"

# Git-less home -> not ready (unreadable HEAD gates closed).
nogit="$tmp/plain"; mkdir -p "$nogit"
if engine_update_ready "$nogit" "$boot" >/dev/null; then r=ready; else r=no; fi
check "git-less home -> not ready" no "$r"

# Empty boot sha -> not ready (boot capture failed at startup -> gate closed).
if engine_update_ready "$home" "" >/dev/null; then r=ready; else r=no; fi
check "empty boot sha -> not ready" no "$r"

# Missing args -> not ready.
if engine_update_ready >/dev/null; then r=ready; else r=no; fi
check "missing args -> not ready" no "$r"

# --- should_reexec ---------------------------------------------------------------
# home is one commit ahead of $boot and clean here -- "update ready" is true.

got="$(should_reexec 0 0 "$home" "$boot")"; rc=$?
check "enabled + edge consumed + ready -> re-exec (rc 0)" 0 "$rc"
check "should_reexec prints the new HEAD" "$want" "$got"

if should_reexec 1 0 "$home" "$boot" >/dev/null; then r=yes; else r=no; fi
check "disabled (prior exec failure) -> no re-exec" no "$r"

if should_reexec 0 1 "$home" "$boot" >/dev/null; then r=yes; else r=no; fi
check "session.done edge pending -> defer re-exec" no "$r"

if should_reexec 0 0 "$home" "$want" >/dev/null; then r=yes; else r=no; fi
check "no update ready -> no re-exec" no "$r"

# --- reexec_engine: success really EXECs ----------------------------------------
# Fake engine home whose bin/supervisor.sh records its argv and exits 7. A
# subshell that calls reexec_engine must BECOME that script: marker written
# with the forwarded args, exit status 7, and nothing after the call runs.
fake="$tmp/fake-engine"; mkdir -p "$fake/bin"
cat > "$fake/bin/supervisor.sh" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$@" > "$tmp/exec-marker"
exit 7
EOF
(
  reexec_engine "$fake" --repo /some/repo --lane alpha
  echo "still-alive" > "$tmp/exec-not-taken"
)
rc=$?
check "successful exec: subshell became the new script (rc 7)" 7 "$rc"
check "successful exec: argv forwarded verbatim" "--repo
/some/repo
--lane
alpha" "$(cat "$tmp/exec-marker" 2>/dev/null)"
check "successful exec: code after the call never ran" "0" "$(find "$tmp" -name exec-not-taken | wc -l | tr -d ' ')"

# --- reexec_engine: failure never kills the process -----------------------------
# `exec /bin/bash <target>` SUCCEEDS even when <target> is missing -- the
# fresh bash then dies, taking the supervisor with it. reexec_engine must
# therefore refuse BEFORE the point of no return: missing target -> return 1,
# caller survives, one WARN in the log.
: > "$SUPLOG"
(
  if reexec_engine "$nogit" --repo /some/repo; then rc_inner=0; else rc_inner=$?; fi
  echo "alive rc=$rc_inner" > "$tmp/failure-survived"
)
check "missing target: caller survived" "alive rc=1" "$(cat "$tmp/failure-survived" 2>/dev/null)"
check "missing target: one WARN logged" "1" "$(grep -c "self-re-exec failed" "$SUPLOG")"

# A target that exists but does NOT parse must also be refused -- exec-ing it
# would replace this process with a bash that dies at the syntax error.
broken="$tmp/broken-engine"; mkdir -p "$broken/bin"
printf '#!/usr/bin/env bash\nif then fi (\n' > "$broken/bin/supervisor.sh"
: > "$SUPLOG"
(
  if reexec_engine "$broken" --repo /some/repo; then rc_inner=0; else rc_inner=$?; fi
  echo "alive rc=$rc_inner" > "$tmp/broken-survived"
)
check "unparseable target: caller survived" "alive rc=1" "$(cat "$tmp/broken-survived" 2>/dev/null)"
check "unparseable target: one WARN logged" "1" "$(grep -c "self-re-exec failed" "$SUPLOG")"
# execfail must not leak into the surviving shell's global state.
(
  reexec_engine "$nogit" --repo /x >/dev/null 2>&1
  reexec_engine "$broken" --repo /x >/dev/null 2>&1
  if shopt -q execfail; then echo leaked; else echo restored; fi > "$tmp/execfail-state"
)
check "failed re-exec: execfail not leaked" restored "$(cat "$tmp/execfail-state" 2>/dev/null)"

# --- acquire_supervisor_lock -----------------------------------------------------
# Fresh lock -> acquired, pid file holds us.
lock="$tmp/lock1"
if acquire_supervisor_lock "$lock"; then r=0; else r=1; fi
check "fresh lock -> acquired" 0 "$r"
check "fresh lock -> pid file is us" "$$" "$(cat "$lock/pid" 2>/dev/null)"

# Our own pid already in the lock (same-pid self-re-exec) -> kept, proceeds.
if acquire_supervisor_lock "$lock"; then r=0; else r=1; fi
check "own pid in lock (re-exec continuity) -> kept" 0 "$r"
check "re-exec continuity -> pid file untouched" "$$" "$(cat "$lock/pid" 2>/dev/null)"

# A DIFFERENT live pid -> refuses (rc 1), lock left alone.
lock2="$tmp/lock2"; mkdir -p "$lock2"
sleep 60 & other=$!
echo "$other" > "$lock2/pid"
if acquire_supervisor_lock "$lock2"; then r=0; else r=1; fi
check "other live pid -> refuses" 1 "$r"
check "other live pid -> lockfile untouched" "$other" "$(cat "$lock2/pid" 2>/dev/null)"
kill "$other" 2>/dev/null; wait "$other" 2>/dev/null

# Dead pid -> stale, lock re-taken by us.
lock3="$tmp/lock3"; mkdir -p "$lock3"
echo "$other" > "$lock3/pid"   # $other is dead now
if acquire_supervisor_lock "$lock3"; then r=0; else r=1; fi
check "dead pid -> stale, re-taken" 0 "$r"
check "dead pid -> pid file now us" "$$" "$(cat "$lock3/pid" 2>/dev/null)"

# Malformed pid (would previously reach kill -0) -> stale, re-taken.
lock4="$tmp/lock4"; mkdir -p "$lock4"
echo "-1" > "$lock4/pid"
if acquire_supervisor_lock "$lock4"; then r=0; else r=1; fi
check "malformed pid '-1' -> stale, re-taken" 0 "$r"
check "malformed pid -> pid file now us" "$$" "$(cat "$lock4/pid" 2>/dev/null)"

lock5="$tmp/lock5"; mkdir -p "$lock5"
echo "not-a-pid" > "$lock5/pid"
if acquire_supervisor_lock "$lock5"; then r=0; else r=1; fi
check "malformed pid 'not-a-pid' -> stale, re-taken" 0 "$r"

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails CHECK(S) FAILED"; exit 1; fi
