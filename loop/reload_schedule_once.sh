#!/bin/bash
# ONE-SHOT: waits for the studio-build-driver to stop on its own, then reloads
# its LaunchAgent so the plist's new 03:05 + 21:05 StartCalendarInterval takes
# effect. Needed because `launchctl unload` KILLS a running driver (a fire was
# in flight when the plist was edited, 2026-07-23). Safe to re-run; exits fast
# if the job is already not running. Logs to logs/schedule_reload.log.
set -u

LABEL="com.autonomy.studio-build-driver"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="/Users/lukebradford/Dev/studio-loop/logs/schedule_reload.log"

while :; do
  pid="$(launchctl list | awk -v l="$LABEL" '$3==l{print $1}')"
  # "-" = loaded, not running. Empty = not loaded at all. Either way: reload now.
  [ "$pid" = "-" ] || [ -z "$pid" ] && break
  sleep 60
done

{
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] driver stopped -- reloading LaunchAgent for the 03:05+21:05 schedule"
  launchctl unload "$PLIST" 2>&1
  launchctl load "$PLIST" 2>&1
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] reloaded -- schedule now 03:05 + 21:05"
} >>"$LOG" 2>&1
