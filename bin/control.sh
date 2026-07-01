#!/usr/bin/env bash
# bin/control.sh -- multi-repo registry / control unit (issue #4).
#
# One surface to see and drive every autonomy loop on this machine:
#
#   control.sh list                     registered repos + label + loop state
#   control.sh register   <path>        add a repo to the registry
#   control.sh unregister <path>        remove a repo from the registry
#   control.sh start      <path>|--all  launchctl bootstrap the installed plist
#   control.sh stop       <path>|--all  launchctl bootout (hard stop)
#   control.sh pause      <path>|--all  graceful stop via the PAUSE sentinel
#   control.sh resume     <path>|--all  remove the sentinel
#
# Registry = ~/.config/autonomy/repos -- the SAME file dashboard.py discovers
# repos from and quickstart.sh registers into (one absolute path per line).
# Label<->repo mapping is read from the installed launchd plists themselves
# (what setup_worktree.sh wrote) -- never re-derived by guessing, so a custom
# engine.label or renamed directory can't desync it. Loop state comes from
# the supervisor's own lock (pid liveness) + pause sentinel, the exact
# signals the supervisor uses itself.
#
# control.sh never provisions: `start` on a repo with no plist refuses and
# points at setup_worktree.sh/quickstart.sh. Unlike quickstart (which only
# PRINTS the launchctl lines), start/stop DO run launchctl -- this is the
# deliberate operator tool those printed next-steps hand over to.
ENGINE_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ctl_registry_file() { printf '%s' "$HOME/.config/autonomy/repos"; }

# Registered repo paths, one per line (blank-line tolerant; empty when the
# registry doesn't exist yet).
ctl_repos() {
  local f; f="$(ctl_registry_file)"
  [ -f "$f" ] || return 0
  grep -v '^[[:space:]]*$' "$f" 2>/dev/null || true
}

ctl_unregister() {
  local path="$1" f tmpf
  f="$(ctl_registry_file)"
  if [ ! -f "$f" ] || ! grep -qxF "$path" "$f"; then
    echo "control.sh: $path is not registered in $f" >&2
    return 1
  fi
  tmpf="$f.tmp.$$"
  cp "$f" "$tmpf"                            # cp first: tmp inherits the registry's mode
  grep -vxF "$path" "$f" > "$tmpf" || true   # rc 1 = registry is now empty
  mv -f "$tmpf" "$f"
  echo "unregistered $path"
}

# Extract one <key>NAME</key><string>VALUE</string> pair from a plist.
ctl_plist_value() {
  grep -A1 "<key>$2</key>" "$1" 2>/dev/null | tail -1 \
    | sed -E 's#.*<string>(.*)</string>.*#\1#'
}
ctl_plist_repo()  { ctl_plist_value "$1" WorkingDirectory; }
ctl_plist_label() { ctl_plist_value "$1" Label; }

# Map a repo path to its installed plist by WorkingDirectory (rc 1: none).
ctl_find_plist() {
  local repo="$1" p
  for p in "$HOME/Library/LaunchAgents"/com.autonomy.*.supervisor.plist; do
    [ -f "$p" ] || continue                      # unmatched glob stays literal
    if [ "$(ctl_plist_repo "$p")" = "$repo" ]; then
      printf '%s' "$p"
      return 0
    fi
  done
  return 1
}

# running | paused | stopped -- from the supervisor's own lock-pid liveness
# and pause sentinel (a stale lock with a dead pid reads as stopped; the
# supervisor reclaims it on next start).
ctl_loop_state() {
  local repo="$1" pid
  pid="$(cat "$repo/var/autonomy-supervisor.lock/pid" 2>/dev/null || printf '')"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    if [ -f "$repo/var/autonomy-logs/autonomy-PAUSE" ]; then
      printf 'paused'
    else
      printf 'running'
    fi
  else
    printf 'stopped'
  fi
}

ctl_start() {
  local repo="$1" plist
  if ! plist="$(ctl_find_plist "$repo")"; then
    echo "control.sh: no launchd plist installed for $repo -- run bin/setup_worktree.sh (or bin/quickstart.sh) first; control.sh never provisions" >&2
    return 1
  fi
  echo "starting $(ctl_plist_label "$plist") ($repo)"
  launchctl bootstrap "gui/$(id -u)" "$plist"
}

ctl_stop() {
  local repo="$1" plist label
  if ! plist="$(ctl_find_plist "$repo")"; then
    echo "control.sh: no launchd plist installed for $repo -- nothing to stop" >&2
    return 1
  fi
  label="$(ctl_plist_label "$plist")"
  echo "stopping $label ($repo)"
  launchctl bootout "gui/$(id -u)/$label"
}

ctl_pause() {
  mkdir -p "$1/var/autonomy-logs"
  touch "$1/var/autonomy-logs/autonomy-PAUSE"
  echo "paused $1 (graceful -- the in-flight session finishes first)"
}

ctl_resume() {
  rm -f "$1/var/autonomy-logs/autonomy-PAUSE"
  echo "resumed $1"
}

# Apply $1 (a ctl_* function) to every registered repo; rc 1 if any failed.
ctl_each() {
  local fn="$1" rc=0 repo
  while IFS= read -r repo; do
    [ -n "$repo" ] || continue
    "$fn" "$repo" || rc=1
  done <<EOF
$(ctl_repos)
EOF
  return "$rc"
}

ctl_list() {
  local repo plist label state any=0 p r registered
  registered="$(ctl_repos)"   # capture once; reused for the orphan scan below
  while IFS= read -r repo; do
    [ -n "$repo" ] || continue
    any=1
    state="$(ctl_loop_state "$repo")"
    if plist="$(ctl_find_plist "$repo")"; then
      label="$(ctl_plist_label "$plist")"
    else
      label="(no plist -- run setup_worktree.sh/quickstart.sh to install one)"
    fi
    printf '%-8s %s  %s\n' "$state" "$repo" "$label"
  done <<EOF
$registered
EOF
  [ "$any" -eq 1 ] || echo "no repos registered ($(ctl_registry_file))"
  for p in "$HOME/Library/LaunchAgents"/com.autonomy.*.supervisor.plist; do
    [ -f "$p" ] || continue
    r="$(ctl_plist_repo "$p")"
    if ! printf '%s\n' "$registered" | grep -qxF "$r"; then
      printf '%-8s %s  %s  [installed but NOT registered -- control.sh register "%s"]\n' \
        "$(ctl_loop_state "$r")" "$r" "$(ctl_plist_label "$p")" "$r"
    fi
  done
}

ctl_usage() {
  cat >&2 <<'EOF'
usage: control.sh list
       control.sh register|unregister <repo-path>
       control.sh start|stop|pause|resume <repo-path>|--all

Registry: ~/.config/autonomy/repos (shared with dashboard.py discovery).
start/stop drive launchctl against the plist setup_worktree.sh installed;
pause/resume drive the graceful PAUSE sentinel. Never provisions.
EOF
}

[ "${BASH_SOURCE[0]}" = "${0}" ] || return 0

set -euo pipefail

CMD="${1:-}"
[ -n "$CMD" ] || { ctl_usage; exit 2; }
shift

case "$CMD" in
  list)
    ctl_list
    ;;
  register|unregister)
    ARG="${1:?control.sh $CMD needs a repo path}"
    # normalize to the physical path when it exists; a deleted worktree must
    # still be unregisterable by its recorded literal path
    if [ -d "$ARG" ]; then ARG="$(cd "$ARG" && pwd)"; fi
    if [ "$CMD" = register ]; then
      # qs_register_repo (append-if-missing) comes from quickstart.sh, which
      # is functions-only + side-effect-free when sourced. Sourced only on
      # this arm -- no other subcommand needs it (PR #41 review).
      # shellcheck source=/dev/null
      source "$ENGINE_HOME/bin/quickstart.sh"
      qs_register_repo "$(ctl_registry_file)" "$ARG"
    else
      ctl_unregister "$ARG"
    fi
    ;;
  start|stop|pause|resume)
    ARG="${1:?control.sh $CMD needs a repo path or --all}"
    if [ "$ARG" = "--all" ]; then
      ctl_each "ctl_$CMD"
    else
      [ -d "$ARG" ] || { echo "control.sh: $ARG is not a directory" >&2; exit 2; }
      "ctl_$CMD" "$(cd "$ARG" && pwd)"
    fi
    ;;
  -h|--help)
    ctl_usage
    ;;
  *)
    echo "control.sh: unknown command '$CMD'" >&2
    ctl_usage
    exit 2
    ;;
esac
