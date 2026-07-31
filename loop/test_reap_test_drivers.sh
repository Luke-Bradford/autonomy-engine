#!/bin/bash
# test_reap_test_drivers.sh -- tests for the #821 fixture reaper.
#
# Every case builds a REAL fixture tree and spawns a REAL spinning process out of
# it, then calls the real functions: nothing here asserts on a mock. The point of
# the reaper is that it destroys things, so the cases that matter most are the
# REFUSALS -- a gate that only ever says yes is the bug, not the fix.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
fails=0
check() { # $1=label $2=expected $3=actual
  if [ "$2" = "$3" ]; then echo "ok   - $1"
  else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails + 1)); fi
}

# shellcheck source=/dev/null
. "$HERE/reap_test_drivers.sh"

# This suite spawns spinners of its own, so it owes the same hygiene it is
# testing for: track every pid and tree, and clear them on ANY exit path.
spawned=""
trees=""
cleanup() {
  for cl_pid in $spawned; do kill -9 "$cl_pid" 2>/dev/null || true; done
  for cl_t in $trees; do
    case "$cl_t" in "${TMPDIR:-/tmp}"*) rm -rf "$cl_t" ;; esac
  done
}
trap cleanup EXIT INT TERM

# A fixture tree exactly as test_quota_guard.sh's run_case builds one: a driver
# under infra/ and the stub bin/ that makes it unmistakably ours.
mk_fixture() { # -> echoes the tree path
  mf_t="$(mktemp -d)"
  trees="$trees $mf_t"
  mkdir -p "$mf_t/infra" "$mf_t/bin"
  printf '#!/bin/bash\nwhile true; do sleep 0.2; done\n' >"$mf_t/infra/drive.sh"
  printf '#!/bin/bash\nexit 0\n' >"$mf_t/bin/claude"
  printf '#!/bin/bash\nexit 0\n' >"$mf_t/bin/gh"
  chmod +x "$mf_t/infra/drive.sh" "$mf_t/bin/claude" "$mf_t/bin/gh"
  echo "$mf_t"
}

spin() { # $1 = script to run in the background -> echoes its pid
  bash "$1" >/dev/null 2>&1 &
  sp_pid=$!
  spawned="$spawned $sp_pid"
  # `ps` has to have observed it before any assertion about ps output is honest.
  sp_i=0
  while [ "$sp_i" -lt 25 ]; do
    ps -ww -eo pid=,command= 2>/dev/null | grep -q "^ *$sp_pid " && break
    sleep 0.1; sp_i=$((sp_i + 1))
  done
  echo "$sp_pid"
}

alive() { if kill -0 "$1" 2>/dev/null; then echo alive; else echo gone; fi; }

# `kill -9` is asynchronous: the process is reaped by the kernel a moment later,
# so poll rather than reading `alive` on the next line and calling it a result.
settled() { # $1 = pid -> alive|gone, after up to ~3s
  st_i=0
  while [ "$st_i" -lt 30 ]; do
    kill -0 "$1" 2>/dev/null || { echo gone; return; }
    sleep 0.1; st_i=$((st_i + 1))
  done
  echo alive
}

# --- 1. the gate accepts a real fixture tree ---------------------------------
t1="$(mk_fixture)"
check "gate accepts a complete fixture tree" "0" \
  "$(fixture_tree_is_ours "$t1" && echo 0 || echo 1)"

# --- 2. the gate REFUSES a tree missing the stub signature -------------------
# A bare `mktemp -d` under $TMPDIR is not ours. This is the case that keeps the
# reaper off some other tool's temp directory.
rm -f "$t1/bin/claude"
check "gate refuses a tree with no bin/claude" "1" \
  "$(fixture_tree_is_ours "$t1" && echo 0 || echo 1)"
printf '#!/bin/bash\nexit 0\n' >"$t1/bin/claude"   # restore for later cases
t2="$(mktemp -d)"; trees="$trees $t2"
check "gate refuses a bare mktemp dir (no infra/drive.sh, no bin/)" "1" \
  "$(fixture_tree_is_ours "$t2" && echo 0 || echo 1)"

# --- 3. the gate refuses the paths that would turn rm -rf into a disaster ----
check "gate refuses an empty path" "1" "$(fixture_tree_is_ours "" && echo 0 || echo 1)"
check "gate refuses /"             "1" "$(fixture_tree_is_ours / && echo 0 || echo 1)"
check "gate refuses a relative path" "1" \
  "$(fixture_tree_is_ours "$(basename "$t1")" && echo 0 || echo 1)"
# Deep enough that it is NOT a direct child of $TMPDIR, but otherwise a perfect
# fixture: the parent check is the only thing that can refuse this one.
t3="$(mk_fixture)"; mkdir -p "$t3/nested"
cp -R "$t3/infra" "$t3/bin" "$t3/nested/" 2>/dev/null
check "gate refuses a signature tree that is not a direct child of TMPDIR" "1" \
  "$(fixture_tree_is_ours "$t3/nested" && echo 0 || echo 1)"

# --- 4. drivers_under finds a live driver, and ONLY inside its own tree ------
t4="$(mk_fixture)"
p4="$(spin "$t4/infra/drive.sh")"
check "drivers_under finds the driver running out of the tree" "$p4" \
  "$(drivers_under "$t4" | tr -d ' ')"
# The safety pin. A driver with the same FILENAME somewhere else -- which is
# exactly what the live control plane at ~/Dev/studio-loop/drive.sh is -- must
# not be matched by another tree's reap.
t5="$(mk_fixture)"
p5="$(spin "$t5/infra/drive.sh")"
check "drivers_under does not match a drive.sh outside the queried tree" "" \
  "$(drivers_under "$t4" | grep -v "^ *$p4\$" | tr -d ' \n')"
check "the other tree's driver is still running" "alive" "$(alive "$p5")"

# --- 5. reap_tree kills the driver and removes the tree ---------------------
check "reap_tree returns 0 for a fixture tree" "0" \
  "$(reap_tree "$t4" >/dev/null 2>&1 && echo 0 || echo 1)"
check "reap_tree killed the driver" "gone" "$(settled "$p4")"
check "reap_tree removed the tree" "1" "$([ -d "$t4" ] && echo 0 || echo 1)"
check "reap_tree left the OTHER tree's driver alone" "alive" "$(alive "$p5")"
check "reap_tree left the OTHER tree in place" "0" "$([ -d "$t5" ] && echo 0 || echo 1)"

# --- 6. reap_tree REFUSES a non-fixture tree: nothing killed, nothing deleted -
# Same tree, same live process -- only the signature is missing. If the gate is
# removed this case flips, which is what makes it worth having.
rm -f "$t5/bin/gh"
check "reap_tree returns 1 for a tree that fails the gate" "1" \
  "$(reap_tree "$t5" >/dev/null 2>&1 && echo 0 || echo 1)"
check "a refused reap kills nothing" "alive" "$(alive "$p5")"
check "a refused reap deletes nothing" "0" "$([ -d "$t5" ] && echo 0 || echo 1)"
kill -9 "$p5" 2>/dev/null || true

# --- 7. reap_stale_trees is bounded by age ----------------------------------
# A fresh tree belongs to a suite that may still be running; only trees older
# than the cutoff are candidates. Both trees carry the full signature, so AGE is
# the only thing separating them.
t6="$(mk_fixture)"   # fresh
t7="$(mk_fixture)"   # aged below
touch -t 202601010000 "$t7"
reap_stale_trees 60 >/dev/null 2>&1
check "reap_stale_trees removed the aged tree" "1" "$([ -d "$t7" ] && echo 0 || echo 1)"
check "reap_stale_trees left the fresh tree alone" "0" "$([ -d "$t6" ] && echo 0 || echo 1)"

# An aged tree with a driver still running out of it is the actual #821 orphan.
t8="$(mk_fixture)"
p8="$(spin "$t8/infra/drive.sh")"
touch -t 202601010000 "$t8"
reap_stale_trees 60 >/dev/null 2>&1
check "reap_stale_trees killed the orphaned driver in an aged tree" "gone" "$(settled "$p8")"

check "reap_stale_trees refuses a non-numeric age" "1" \
  "$(reap_stale_trees abc >/dev/null 2>&1 && echo 0 || echo 1)"

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
