#!/usr/bin/env bash
# tests/test_engine_sha.sh -- the supervisor's boot-sha record (#166 slice 1).
# write_engine_boot_sha() writes the engine checkout's HEAD sha ONCE at boot to
# the gitignored $LOGDIR/engine_sha, so the dashboard can tell the operator when
# a running (frozen) supervisor is behind the merged engine and needs a restart.
# Best-effort like heartbeat(): a git-less / unwritable path must never crash or
# perturb the loop. Sources the real supervisor.sh and calls the real function.
# shellcheck disable=SC2034  # vars consumed inside the sourced supervisor.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_HOME="$(cd "$HERE/.." && pwd)"

# shellcheck source=/dev/null
source "$ENGINE_HOME/bin/supervisor.sh"

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails + 1)); fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# --- happy path: records HEAD of a real engine checkout ------------------------
home="$tmp/engine"
mkdir -p "$home"
(
  cd "$home" || exit 1
  git init -q
  git config user.email t@t; git config user.name t
  : > a; git add a; GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t \
    GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t git commit -qm one
)
want="$(git -C "$home" rev-parse HEAD)"
LOGDIR="$tmp/logs"; mkdir -p "$LOGDIR"
out="$(write_engine_boot_sha "$home" "$LOGDIR")"; rc=$?
check "returns 0"                    "0"      "$rc"
check "prints the boot sha (#294 re-exec baseline)" "$want" "$out"
check "engine_sha holds HEAD"        "$want"  "$(cat "$LOGDIR/engine_sha" 2>/dev/null)"
check "exactly one line"             "1"      "$(wc -l < "$LOGDIR/engine_sha" | tr -d ' ')"
leftover="$(find "$LOGDIR" -name 'engine_sha.*.tmp' | wc -l | tr -d ' ')"
check "no temp file left behind"     "0"      "$leftover"

# --- best-effort: git-less home writes nothing, returns 0 ----------------------
nogit="$tmp/plain"; mkdir -p "$nogit"
LOGDIR2="$tmp/logs2"; mkdir -p "$LOGDIR2"
out="$(write_engine_boot_sha "$nogit" "$LOGDIR2")"; rc=$?
check "git-less home returns 0"      "0"      "$rc"
check "git-less home prints nothing" ""       "$out"
check "git-less home writes no file" "0"      "$(find "$LOGDIR2" -name engine_sha | wc -l | tr -d ' ')"

# --- best-effort: unwritable LOGDIR does not crash -----------------------------
out="$(write_engine_boot_sha "$home" "$tmp/does/not/exist")"; rc=$?
check "unwritable LOGDIR returns 0"  "0"      "$rc"
check "unwritable LOGDIR still prints the sha (in-memory baseline survives)" "$want" "$out"

# --- defaults to globals when args omitted ------------------------------------
ENGINE_HOME="$home"
LOGDIR="$tmp/logs3"; mkdir -p "$LOGDIR"
write_engine_boot_sha; rc=$?
check "defaults to \$ENGINE_HOME/\$LOGDIR" "$want" "$(cat "$LOGDIR/engine_sha" 2>/dev/null)"

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails CHECK(S) FAILED"; exit 1; fi
