#!/usr/bin/env bash
# bin/lock_paths.sh -- single source of the supervisor lock path convention (#117).
#
# bin/supervisor.sh creates <repo>/var/autonomy-supervisor.lock/ (a mkdir-atomic
# lock directory) and writes its own pid to .../pid. bin/control.sh
# (ctl_loop_state) and ./start (start_loop_running) each read that pid to report
# loop state. Three hardcoded copies of the path convention could silently drift
# if the lock layout ever changes -- this file is the one definition all three
# source (the small shared-lib seam #116 deferred rather than inline).
#
# Functions-only + side-effect-free: sourcing defines the helpers and does
# nothing else, so there is no executable body to guard.

# supervisor_lock_dir <repo> -> the mkdir-atomic lock directory for <repo>.
supervisor_lock_dir() { printf '%s/var/autonomy-supervisor.lock' "$1"; }

# supervisor_lock_pid_file <repo> -> the pid file inside that lock directory.
# Composes from supervisor_lock_dir so the convention lives in exactly one place.
supervisor_lock_pid_file() { printf '%s/pid' "$(supervisor_lock_dir "$1")"; }
