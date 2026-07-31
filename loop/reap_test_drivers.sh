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
# SAFETY -- TWO gates, and which one applies is decided by PROVENANCE:
#
#   * `reap_tree` (gate: `fixture_tree_is_ours`) is for a BLIND sweep of
#     directories nobody vouched for. It demands the full fixture signature --
#     `tmp.*` directly in `$TMPDIR`, plus `infra/drive.sh` + `bin/claude` +
#     `bin/gh` -- because the only evidence available is what is on disk.
#   * `reap_known_tree` (gate: `tree_path_is_disposable`) is for a directory THIS
#     RUN created and recorded. Provenance is already established, so requiring a
#     signature would be wrong, not stricter: the suite's ad-hoc trees hold an
#     `infra/` and no stub `bin/` at all, and a signature-gated trap would refuse
#     to clean up exactly the trees it exists to clean up. It still demands an
#     absolute `tmp.*` path directly inside `$TMPDIR`.
#
# Neither gate can reach the live control plane at `~/Dev/studio-loop/drive.sh`:
# it is not under `$TMPDIR`, and `drivers_under` matches on the candidate tree's
# own absolute path, so its command line cannot match another tree's query. A
# relative path, `/`, an empty string, and any directory outside `$TMPDIR` are
# refused by both.

# --- tree_path_is_disposable: the PATH-SHAPE gate ----------------------------
# $1 = candidate directory. Returns 0 only for an existing `mktemp -d`-shaped
# directory sitting directly in this process's `$TMPDIR`. This is the weaker of
# the two gates and is sound only where the CALLER already knows the path's
# provenance (it created and recorded it).
tree_path_is_disposable() {
  tpid_dir="${1:-}"
  # An empty or relative path can never be a temp tree, and both are the shapes
  # that turn a later `rm -rf` into something else entirely.
  case "$tpid_dir" in
    "" | /) return 1 ;;
    /*) : ;;
    *) return 1 ;;
  esac
  [ -d "$tpid_dir" ] || return 1
  # `$TMPDIR` carries a trailing slash on macOS and usually none on Linux, so
  # compare against a normalised copy rather than the raw value -- otherwise the
  # parent test fails on exactly one of the two platforms this runs on.
  tpid_tmp="${TMPDIR:-/tmp}"
  while [ "${tpid_tmp%/}" != "$tpid_tmp" ] && [ "$tpid_tmp" != "/" ]; do
    tpid_tmp="${tpid_tmp%/}"
  done
  [ "$(dirname "$tpid_dir")" = "$tpid_tmp" ] || return 1
  case "$(basename "$tpid_dir")" in
    tmp.?*) return 0 ;;
    *) return 1 ;;
  esac
}

# --- fixture_tree_is_ours: the BLIND-sweep gate ------------------------------
# $1 = candidate directory. Returns 0 only for an unambiguous fixture tree: the
# path shape above PLUS the stub signature the suite builds inside it.
fixture_tree_is_ours() {
  ftio_dir="${1:-}"
  tree_path_is_disposable "$ftio_dir" || return 1
  # `mktemp -d` alone gets you a `tmp.*` directory under $TMPDIR; what makes an
  # unvouched-for one OURS is the stub tree inside. Requiring three separate
  # members means an unrelated tool's temp dir cannot collide by accident, and a
  # HALF-built fixture (the suite dying between `mktemp` and the stubs) is left
  # alone rather than guessed at.
  [ -f "$ftio_dir/infra/drive.sh" ] || return 1
  [ -f "$ftio_dir/bin/claude" ] || return 1
  [ -f "$ftio_dir/bin/gh" ] || return 1
  return 0
}

# --- drivers_under: which processes are still running out of this tree -------
# $1 = fixture tree. $2 = OPTIONAL pre-captured `ps` snapshot (see below).
# Echoes one pid per line (possibly none).
#
# Matches on the tree's own absolute path, which is what makes this safe: the
# live driver's command line is `/Users/.../studio-loop/drive.sh` and cannot
# contain a `$TMPDIR/tmp.*/infra/drive.sh` substring. `ps` output is captured
# BEFORE it is searched -- searching through a pipe would put grep's own argv
# (which contains the pattern) into the very snapshot being searched, and the
# reaper would report a driver that is really its own matcher.
#
# $2 exists because a sweep asks this question once per candidate tree, and
# `ps` is a fork+exec each time: over the 6,768 abandoned trees measured in #821
# that alone ran for minutes. A caller sweeping many trees captures ONE snapshot
# and passes it to every call. The tradeoff is that a process which starts after
# the snapshot is missed -- acceptable only for the stale sweep, whose candidates
# are by definition an hour old and whose misses the next sweep catches. Any
# caller that needs a current answer omits $2 and gets a fresh `ps`.
drivers_under() {
  du_dir="${1:-}"
  du_ps="${2:-}"
  [ -n "$du_dir" ] || return 0
  # -ww: macOS `ps` truncates the command column to the terminal width by
  # default, and these paths are long enough to lose the `/infra/drive.sh` tail.
  [ -n "$du_ps" ] || du_ps="$(ps -ww -eo pid=,command= 2>/dev/null)"
  [ -n "$du_ps" ] || return 0
  # `read -r du_pid du_cmd` with the DEFAULT IFS, deliberately: `ps -o pid=`
  # RIGHT-JUSTIFIES the pid (`    1 /sbin/launchd`), so reading the line whole and
  # taking `${line%% *}` strips the longest ` *` suffix -- which, with a leading
  # space, is the entire line. That yields an empty pid, a `kill -9 ""` that does
  # nothing, and an emptiness test that passes while the orphan is still running:
  # a reaper that reaps nothing and an assertion that cannot fail. Default-IFS
  # word splitting consumes the padding instead.
  echo "$du_ps" | while read -r du_pid du_cmd; do
    case "$du_cmd" in
      *"$du_dir/infra/drive.sh"*) : ;;
      *) continue ;;
    esac
    [ "$du_pid" = "$$" ] && continue
    echo "$du_pid"
  done
}

# --- reap_tree: kill anything still running there, then delete the tree ------
# $1 = fixture tree. $2 = optional `ps` snapshot. Returns 1 (and warns) for
# anything that fails the BLIND gate.
reap_tree() {
  rt_dir="${1:-}"
  if ! fixture_tree_is_ours "$rt_dir"; then
    echo "reap_tree: refusing '$rt_dir' -- not a fixture tree" >&2
    return 1
  fi
  reap_now "$rt_dir" "${2:-}"
}

# --- reap_known_tree: the same, for a tree whose provenance the caller knows --
# $1 = a directory THIS RUN created and recorded (a suite's own `mktemp -d`).
# $2 = optional `ps` snapshot. Gated on path shape only -- see the SAFETY note:
# demanding the stub signature here would refuse the ad-hoc trees that carry an
# `infra/` and no `bin/`, which are precisely what an exit trap must clean.
reap_known_tree() {
  rkt_dir="${1:-}"
  if ! tree_path_is_disposable "$rkt_dir"; then
    echo "reap_known_tree: refusing '$rkt_dir' -- not a disposable temp path" >&2
    return 1
  fi
  reap_now "$rkt_dir" "${2:-}"
}

# The shared body. Never call this directly: it is UNGATED by construction, so
# that neither gate can be bypassed by a caller reaching past it.
reap_now() {
  for rn_pid in $(drivers_under "$1" "${2:-}"); do
    kill -9 "$rn_pid" 2>/dev/null || true
  done
  rm -rf "$1"
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
  # ONE `ps` for the whole sweep -- see `drivers_under`'s $2. Per-tree it was
  # minutes of fork+exec across the 6,768 trees #821 measured.
  rst_ps="$(ps -ww -eo pid=,command= 2>/dev/null)"
  # -print0 + read -d '': a path with a space would otherwise split, and bash 3.2
  # has no `mapfile` to read the list with. Process substitution rather than a
  # here-doc or a pipe, for two separate reasons: command substitution STRIPS the
  # NUL bytes `-print0` exists to emit, and a pipe would run the loop in a
  # subshell where the counter increments and is then thrown away.
  while IFS= read -r -d '' rst_cand; do
    if reap_tree "$rst_cand" "$rst_ps" 2>/dev/null; then rst_n=$((rst_n + 1)); fi
  done < <(find "$rst_tmp" -maxdepth 1 -type d -name 'tmp.*' -mmin "+$rst_min" -print0 2>/dev/null)
  echo "$rst_n"
}

# Executable body guarded: sourcing this file only defines the functions.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  reaped="$(reap_stale_trees "${1:-60}")"
  echo "reaped $reaped stale fixture tree(s) older than ${1:-60}m from ${TMPDIR:-/tmp}"
fi
