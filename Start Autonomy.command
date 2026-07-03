#!/bin/bash
# ============================================================================
#  Start Autonomy  (macOS -- double-click me in Finder)
#
#  Runs the control-room site and opens it in your browser.
#  Close this window (or press Ctrl-C) to stop.
#
#  To change the port, edit  ~/.config/autonomy/settings  and add a line:
#       port = 8787
# ============================================================================
cd "$(dirname "$0")" || exit 1

PORT="$(python3 lib/settings.py port 2>/dev/null)"
case "$PORT" in ''|*[!0-9]*) PORT=8787 ;; esac
URL="http://127.0.0.1:$PORT/"

echo "== Autonomy control room =="
echo "  site:   $URL"
echo "  config: ~/.config/autonomy/settings   (set 'port = N' to change the port)"
echo "  stop:   close this window (or press Ctrl-C)"
echo ""

# open the browser a moment after the server starts binding
( sleep 2; open "$URL" >/dev/null 2>&1 ) &

# this window IS the running service: close it (or Ctrl-C) to stop
exec python3 bin/dashboard.py --port "$PORT"
