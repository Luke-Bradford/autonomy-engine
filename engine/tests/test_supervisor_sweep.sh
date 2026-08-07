#!/usr/bin/env bash
# Wiring test for supervisor.sh sweep_board() (#252). The supervisor drives the
# board's closed-issue -> Done sweep once per iteration by shelling out to
# board.sh. This asserts the best-effort contract at that seam: sweep_board
# invokes "$ENGINE_HOME/bin/board.sh sweep" from the target repo, and returns 0
# EVEN WHEN board.sh fails -- a board hiccup must never perturb dispatch (SD #6).
#
# Loop *placement* (after the pause `continue`, before cron) is verified by
# inspection, consistent with how cron-fire position is not position-unit-tested
# (the main-loop body is guarded, not factored into a callable unit).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=/dev/null
source "$HERE/../bin/supervisor.sh"
# shellcheck disable=SC2034  # consumed by log() in the sourced supervisor.sh
SUPLOG=/dev/null
log() { :; }

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails + 1)); fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
# Fake engine home with a stub board.sh that records its argv + cwd to a marker.
mkdir -p "$tmp/engine/bin" "$tmp/repo"
STUB_MARKER="$tmp/marker"
cat > "$tmp/engine/bin/board.sh" <<SH
#!/usr/bin/env bash
echo "args=\$* cwd=\$(pwd)" > "$STUB_MARKER"
exit \${STUB_RC:-0}
SH
chmod +x "$tmp/engine/bin/board.sh"

# shellcheck disable=SC2034  # consumed by sweep_board() in the sourced supervisor.sh
ENGINE_HOME="$tmp/engine"
# shellcheck disable=SC2034  # consumed by sweep_board() in the sourced supervisor.sh
AUTONOMY_TARGET_REPO="$tmp/repo"

# --- happy path: invokes board.sh sweep, from the target repo, returns 0 ------
rm -f "$STUB_MARKER"
sweep_board; rc=$?
check "sweep_board returns 0 on success" 0 "$rc"
check "sweep_board invoked board.sh with 'sweep'" 1 "$(grep -c 'args=sweep' "$STUB_MARKER" 2>/dev/null || echo 0)"
check "sweep_board ran board.sh from the target repo" 1 "$(grep -c "cwd=$tmp/repo" "$STUB_MARKER" 2>/dev/null || echo 0)"

# --- best-effort: board.sh failing must NOT make sweep_board non-zero ---------
rm -f "$STUB_MARKER"
STUB_RC=3 sweep_board; rc=$?
check "sweep_board returns 0 even when board.sh exits non-zero" 0 "$rc"
check "sweep_board still invoked board.sh" 1 "$(grep -c 'args=sweep' "$STUB_MARKER" 2>/dev/null || echo 0)"

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails CHECK(S) FAILED"; exit 1; fi
