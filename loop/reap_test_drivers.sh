#!/bin/bash
# reap_test_drivers.sh -- kill and remove the throwaway fixture trees that
# `test_quota_guard.sh` builds, INCLUDING any driver still running out of one.
#
# Why this exists (#821). The suite drives the REAL `drive.sh` inside a
# `mktemp -d` tree whose `bin/` shadows `claude`, `gh`, `git` and `curl` with
# stubs. The driver's only bound is `MAX_LOOPS`, carried in its ENVIRONMENT --
# so a driver that loses that bound (the #811 self-`exec` cases rewrite the
# driver's own source, and an intermediate version dropped `MAX_LOOPS` across
# the `exec`) loops forever, the foreground `run_case` never returns, and the
# suite hangs. Kill the hung suite and the driver survives it: its only other
# bound was the harness's own liveness. Measured on 2026-07-31: one such orphan
# had run 3,177 stub fires over an hour with `ppid 1`, and 6,768 abandoned
# fixture trees (~800 MB) had accumulated because `run_case` cannot delete its
# own tree (it RETURNS the path; callers read files out of it afterwards).
#
# This file is the reaper half. The harness-independent half -- the deadline the
# stub `run.sh` enforces on every fire -- lives in `test_quota_guard.sh`, because
# it has to survive the suite being SIGKILLed, which no `trap` here can.
#
# SAFETY. Everything below destroys, so `fixture_tree_is_ours` is the ONLY gate
# and it is deliberately narrow: a tree qualifies only if it is a `tmp.*`
# directory sitting DIRECTLY in this process's `$TMPDIR`, and it carries the full
# fixture signature (`infra/drive.sh` + `bin/claude` + `bin/gh`). The live
# control plane at `~/Dev/studio-loop/drive.sh` fails every clause of that, and
# `drivers_under` matches on the candidate tree's own absolute path, so no
# reachable input makes this touch the running driver. A relative path, `/`, an
# empty string, or any directory the operator happens to own are all refused.

# --- fixture_tree_is_ours: the destruction gate ------------------------------
# $1 = candidate directory. Returns 0 only for an unambiguous fixture tree.
# Every later function calls this FIRST; none of them re-derives the answer.
fixture_tree_is_ours() {
  ftio_dir="${1:-}"
  # An empty or relative path can never be a fixture tree, and both are the
  # shapes that turn a later `rm -rf` into something else entirely.
  case "$ftio_dir" in
    "" | /) return 1 ;;
    /*) : ;;
    *) return 1 ;;
  esac
  [ -d "$ftio_dir" ] || return 1
  # `$TMPDIR` carries a trailing slash on macOS and usually none on Linux, so
  # compare against a normalised copy rather than the raw value -- otherwise the
  # parent test fails on exactly one of the two platforms this runs on.
  ftio_tmp="${TMPDIR:-/tmp}"
  while [ "${ftio_tmp%/}" != "$ftio_tmp" ] && [ "$ftio_tmp" != "/" ]; do
    ftio_tmp="${ftio_tmp%/}"
  done
  [ "$(dirname "$ftio_dir")" = "$ftio_tmp" ] || return 1
  case "$(basename "$ftio_dir")" in
    tmp.?*) : ;;
    *) return 1 ;;
  esac
  # The signature. `mktemp -d` alone gets you a `tmp.*` directory under $TMPDIR;
  # what makes it OURS is the stub tree the suite builds inside it. Requiring
  # three separate members means an unrelated tool's temp dir cannot collide by
  # accident, and a HALF-built fixture (the suite dying between `mktemp` and the
  # stubs) is left alone rather than guessed at.
  [ -f "$ftio_dir/infra/drive.sh" ] || return 1
  [ -f "$ftio_dir/bin/claude" ] || return 1
  [ -f "$ftio_dir/bin/gh" ] || return 1
  return 0
}

# --- drivers_under: which processes are still running out of this tree -------
# $1 = fixture tree. Echoes one pid per line (possibly none).
#
# Matches on the tree's own absolute path, which is what makes this safe: the
# live driver's command line is `/Users/.../studio-loop/drive.sh` and cannot
# contain a `$TMPDIR/tmp.*/infra/drive.sh` substring. `ps` output is captured
# BEFORE it is searched -- searching through a pipe would put grep's own argv
# (which contains the pattern) into the very snapshot being searched, and the
# reaper would report a driver that is really its own matcher.
drivers_under() {
  du_dir="${1:-}"
  [ -n "$du_dir" ] || return 0
  # -ww: macOS `ps` truncates the command column to the terminal width by
  # default, and these paths are long enough to lose the `/infra/drive.sh` tail.
  du_ps="$(ps -ww -eo pid=,command= 2>/dev/null)"
  [ -n "$du_ps" ] || return 0
  echo "$du_ps" | while IFS= read -r du_line; do
    du_pid="${du_line%% *}"
    case "$du_line" in
      *"$du_dir/infra/drive.sh"*) : ;;
      *) continue ;;
    esac
    [ "$du_pid" = "$$" ] && continue
    echo "$du_pid"
  done
}

# --- reap_tree: kill anything still running there, then delete the tree ------
# $1 = fixture tree. Returns 1 (and warns) for anything that fails the gate.
reap_tree() {
  rt_dir="${1:-}"
  if ! fixture_tree_is_ours "$rt_dir"; then
    echo "reap_tree: refusing '$rt_dir' -- not a fixture tree" >&2
    return 1
  fi
  for rt_pid in $(drivers_under "$rt_dir"); do
    kill -9 "$rt_pid" 2>/dev/null || true
  done
  rm -rf "$rt_dir"
  return 0
}

# --- reap_stale_trees: sweep the leftovers of runs that already ended --------
# $1 = minimum age in minutes (default 60). Only trees OLDER than that are
# considered, so a concurrently-running suite's trees are never pulled out from
# under it. Every candidate still passes through `reap_tree`'s gate.
reap_stale_trees() {
  rst_min="${1:-60}"
  case "$rst_min" in
    '' | *[!0-9]*)
      echo "reap_stale_trees: refusing non-numeric age '$rst_min'" >&2
      return 1
      ;;
  esac
  rst_tmp="${TMPDIR:-/tmp}"
  while [ "${rst_tmp%/}" != "$rst_tmp" ] && [ "$rst_tmp" != "/" ]; do
    rst_tmp="${rst_tmp%/}"
  done
  [ -d "$rst_tmp" ] || return 0
  rst_n=0
  # -print0 + read -d '': a path with a space would otherwise split, and bash 3.2
  # has no `mapfile` to read the list with. Process substitution rather than a
  # here-doc or a pipe, for two separate reasons: command substitution STRIPS the
  # NUL bytes `-print0` exists to emit, and a pipe would run the loop in a
  # subshell where the counter increments and is then thrown away.
  while IFS= read -r -d '' rst_cand; do
    if reap_tree "$rst_cand" 2>/dev/null; then rst_n=$((rst_n + 1)); fi
  done < <(find "$rst_tmp" -maxdepth 1 -type d -name 'tmp.*' -mmin "+$rst_min" -print0 2>/dev/null)
  echo "$rst_n"
}

# Executable body guarded: sourcing this file only defines the functions.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  reaped="$(reap_stale_trees "${1:-60}")"
  echo "reaped $reaped stale fixture tree(s) older than ${1:-60}m from ${TMPDIR:-/tmp}"
fi
