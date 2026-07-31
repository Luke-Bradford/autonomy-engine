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

# SANDBOX the temp root before anything else. `reap_stale_trees` sweeps the whole
# root and both gates are defined relative to it -- so a test run against the REAL
# root would reap the operator's actual leftovers as a side effect of being run.
# (Found the hard way: on this machine that was 6,768 trees, and the suite ran for
# minutes before it was killed.)
#
# Overriding `TMPDIR` would NOT do it: macOS `mktemp -d` ignores `TMPDIR`, so the
# fixtures would land back in the real root while the gates looked at the sandbox.
# `REAP_TEMP_ROOT` is the seam the reaper exposes for exactly this, and every
# fixture below is created with an EXPLICIT template inside it.
SANDBOX_ROOT="$(mktemp -d)" || SANDBOX_ROOT=""
# HARD-FAIL on a failed mktemp. An empty SANDBOX_ROOT turns the cleanup sweep's
# pattern `*"$SANDBOX_ROOT"/*` into `*/*`, which matches the command line of
# essentially every process on the machine -- and that sweep runs `kill -9`.
# The `rm -rf` beside it is gated on the path shape; this is the one destruction
# primitive whose safety rests entirely on the variable being non-empty.
case "$SANDBOX_ROOT" in
  /*/tmp.?*) : ;;
  *) echo "FAIL - could not create a sandbox root (got '$SANDBOX_ROOT')"; exit 1 ;;
esac
export REAP_TEMP_ROOT="$SANDBOX_ROOT"
sandbox_mktemp() { mktemp -d "$SANDBOX_ROOT/tmp.XXXXXXXX"; }

# This suite spawns spinners of its own, so it owes the same hygiene it is
# testing for. Two mechanisms, because the obvious one is not enough:
#
# Cleanup is a PATH-SCOPED sweep of the process table, and deliberately nothing
# else: anything still running out of the sandbox dies, however it got there.
#
# Two rejected alternatives, both instructive. A pid registry in a VARIABLE
# cannot work at all -- every spawn goes through `p="$(spin ...)"`, and a command
# substitution runs in a SUBSHELL, so the append is discarded with it. The first
# version of this file did exactly that and left ELEVEN orphaned spinners behind:
# the very defect #821 is about, reproduced inside its own test suite. A registry
# in a FILE fixes that but adds its own hazard -- pids get recycled, so killing a
# remembered pid can hit an unrelated process that inherited the number. The
# sweep has neither problem.
# Idempotent: the INT/TERM handler exits, which re-fires the EXIT trap, and a
# second pass would re-scan and re-`rm -rf` a sandbox that is already gone --
# noise on the one path where the output matters.
cleanup_done=""
cleanup() {
  [ -z "$cleanup_done" ] || return 0
  cleanup_done=1
  ps -ww -eo pid=,command= 2>/dev/null | while read -r cl_p cl_cmd; do
    case "$cl_cmd" in *"$SANDBOX_ROOT"/*) kill -9 "$cl_p" 2>/dev/null || true ;; esac
  done
  case "$SANDBOX_ROOT" in /*/tmp.?*) rm -rf "$SANDBOX_ROOT" ;; esac
}
# INT/TERM must EXIT, not just clean: a bare `trap cleanup INT` runs the handler
# and then RESUMES the script, so a Ctrl-C would tear down the sandbox and carry
# on running cases against a directory that no longer exists.
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM

# A fixture tree exactly as test_quota_guard.sh's run_case builds one: a driver
# under infra/ and the stub bin/ that makes it unmistakably ours.
mk_fixture() { # -> echoes the tree path
  mf_t="$(sandbox_mktemp)"
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
t2="$(sandbox_mktemp)"
check "gate refuses a bare mktemp dir (no infra/drive.sh, no bin/)" "1" \
  "$(fixture_tree_is_ours "$t2" && echo 0 || echo 1)"

# --- 3. the gate refuses the paths that would turn rm -rf into a disaster ----
check "gate refuses an empty path" "1" "$(fixture_tree_is_ours "" && echo 0 || echo 1)"
check "gate refuses /"             "1" "$(fixture_tree_is_ours / && echo 0 || echo 1)"
check "gate refuses a relative path" "1" \
  "$(fixture_tree_is_ours "$(basename "$t1")" && echo 0 || echo 1)"
# One level too deep, but IDENTICAL in every other respect -- full signature AND a
# `tmp.*` basename. Naming it `nested` instead would let the basename check refuse
# it and the case would pass with the parent check deleted, which is exactly how
# the first version of this case was vacuous.
t3="$(mk_fixture)"; mkdir -p "$t3/tmp.deepfixture"
cp -R "$t3/infra" "$t3/bin" "$t3/tmp.deepfixture/" 2>/dev/null
check "gate refuses a signature tree that is not a direct child of the temp root" "1" \
  "$(fixture_tree_is_ours "$t3/tmp.deepfixture" && echo 0 || echo 1)"

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

# --- 8. reap_known_tree: the provenance gate, for trees WE recorded ----------
# The suite's ad-hoc cases build an `infra/` and no stub `bin/` at all, so the
# signature gate refuses them -- and an exit trap routed through that gate would
# leak exactly the trees it exists to clean. reap_known_tree is the second gate.
t9="$(sandbox_mktemp)"; mkdir -p "$t9/infra"
printf '#!/bin/bash\nwhile true; do sleep 0.2; done\n' >"$t9/infra/drive.sh"
p9="$(spin "$t9/infra/drive.sh")"
check "the SIGNATURE gate refuses an ad-hoc tree (no stub bin/)" "1" \
  "$(fixture_tree_is_ours "$t9" && echo 0 || echo 1)"
check "the PROVENANCE gate accepts it" "0" \
  "$(tree_path_is_disposable "$t9" && echo 0 || echo 1)"
check "reap_known_tree kills its driver" "gone" \
  "$(reap_known_tree "$t9" >/dev/null 2>&1; settled "$p9")"
check "reap_known_tree removed the tree" "1" "$([ -d "$t9" ] && echo 0 || echo 1)"
# The provenance gate is weaker, NOT absent: it still refuses everything that
# would make `rm -rf` dangerous.
check "reap_known_tree refuses an empty path" "1" \
  "$(reap_known_tree "" >/dev/null 2>&1 && echo 0 || echo 1)"
check "reap_known_tree refuses /" "1" \
  "$(reap_known_tree / >/dev/null 2>&1 && echo 0 || echo 1)"
# `tmp.*`-named, so only the parent check stands between it and `rm -rf`.
mkdir -p "$SANDBOX_ROOT/elsewhere/tmp.outsider"
check "reap_known_tree refuses a directory outside the temp root" "1" \
  "$(reap_known_tree "$SANDBOX_ROOT/elsewhere/tmp.outsider" >/dev/null 2>&1 && echo 0 || echo 1)"
check "refusing an outside directory deleted nothing" "0" \
  "$([ -d "$SANDBOX_ROOT/elsewhere/tmp.outsider" ] && echo 0 || echo 1)"
check "reap_known_tree refuses the repo directory it is running from" "1" \
  "$(reap_known_tree "$HERE" >/dev/null 2>&1 && echo 0 || echo 1)"
check "refusing the repo directory deleted nothing" "0" \
  "$([ -f "$HERE/reap_test_drivers.sh" ] && echo 0 || echo 1)"

# --- 9. the PROBE path (no REAP_TEMP_ROOT override) -------------------------
# Every case above runs with the sandbox override set, so the production path --
# work out where `mktemp -d` actually writes -- is otherwise never executed here.
# Run it in a subshell with the override unset and check it against a real
# `mktemp -d`, which is the only ground truth available and the reason the module
# probes instead of reading $TMPDIR.
probe_out="$( unset REAP_TEMP_ROOT; . "$HERE/reap_test_drivers.sh"; reap_temp_root )"
probe_truth="$( d="$(mktemp -d)"; dirname "$d"; rmdir "$d" )"
check "reap_temp_root probes the directory mktemp -d really uses" "$probe_truth" "$probe_out"
# And the cache must land in the CALLER's shell, not in a subshell that discards
# it -- the defect that ate both registries. `_init` is the form that can do it.
cache_probe="$( unset REAP_TEMP_ROOT; . "$HERE/reap_test_drivers.sh"; \
  reap_temp_root_init && echo "$REAP_TEMP_ROOT" )"
check "reap_temp_root_init caches in the caller's shell" "$probe_truth" "$cache_probe"

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
