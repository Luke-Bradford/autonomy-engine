#!/usr/bin/env bash
# tests/test_safe_merge_done_everywhere.sh -- done_everywhere() executes the
# SD-26 completion checklist at the merge chokepoint: verify/close the issues
# the PR body CLOSES (Closes/Fixes/Resolves #N), board them Done; board the
# PR's still-open WORK-CLAIM tickets (explicit "Part of #N" in the body, or
# (#N) in the title) back to Ready; never touch prose-mention issues; and
# NEVER fail the caller -- every hygiene failure warns and continues (the
# merge has already landed; SD-6 best-effort board).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$HERE/../bin/safe_merge.sh"

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails + 1)); fi
}

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
calls="$tmp/gh_calls"

# board.sh seam: recorder script (best-effort contract -- always exits 0)
BOARD_SH="$tmp/board.sh"
cat > "$BOARD_SH" <<'EOF'
#!/bin/bash
printf 'board %s\n' "$*" >> "${BOARD_CALLS:?}"
exit 0
EOF
chmod +x "$BOARD_SH"
export BOARD_CALLS="$tmp/board_calls"

# gh mock: PR body/title per scenario; issue states per scenario map.
BODY=""; TITLE=""
gh() {
  printf 'gh %s\n' "$*" >> "$calls"
  case "$*" in
    "pr view"*"--json body"*)  printf '%s\n' "$BODY" ;;
    "pr view"*"--json title"*) printf '%s\n' "$TITLE" ;;
    "issue view 61 "*) printf 'OPEN\n' ;;
    "issue view 62 "*) printf 'CLOSED\n' ;;
    "issue view 63 "*) printf 'OPEN\n' ;;
    "issue view 64 "*) printf 'OPEN\n' ;;
    "issue view"*) return 1 ;;   # unknown ref (e.g. a PR number) -> error
    "issue close"*) : ;;
  esac
  return 0
}

# --- happy path: close-ref still open -> closed + Done; work-claim -> Ready ---
: > "$calls"; : > "$BOARD_CALLS"
BODY="Closes #61.

Part of #63 (slices remain).

Related reading: #83 and #199 in prose."
TITLE="fix: something (#61)"
rc=0; done_everywhere 42 || rc=$?
check "done_everywhere returns 0" "0" "$rc"
check "closes the open close-ref"        "yes" "$(grep -q 'gh issue close 61' "$calls" && echo yes || echo no)"
check "close-ref boarded Done"           "yes" "$(grep -q 'board status 61 Done' "$BOARD_CALLS" && echo yes || echo no)"
check "work-claim ticket boarded Ready"  "yes" "$(grep -q 'board status 63 Ready' "$BOARD_CALLS" && echo yes || echo no)"
check "prose mention #83 untouched"      "yes" "$(grep -q ' 83 ' "$BOARD_CALLS" && echo no || echo yes)"
check "prose mention #199 untouched"     "yes" "$(grep -q ' 199 ' "$BOARD_CALLS" && echo no || echo yes)"

# --- already-closed close-ref: no re-close, still boarded Done ---
: > "$calls"; : > "$BOARD_CALLS"
BODY="Fixes #62"
TITLE="fix: other"
rc=0; done_everywhere 43 || rc=$?
check "already-closed ref not re-closed" "yes" "$(grep -q 'gh issue close 62' "$calls" && echo no || echo yes)"
check "already-closed ref still Done"    "yes" "$(grep -q 'board status 62 Done' "$BOARD_CALLS" && echo yes || echo no)"

# --- title work-claim without body claim ---
: > "$calls"; : > "$BOARD_CALLS"
BODY="no refs here"
TITLE="feat: rail cleanup (#64)"
rc=0; done_everywhere 44 || rc=$?
check "title (#64) work-claim -> Ready"  "yes" "$(grep -q 'board status 64 Ready' "$BOARD_CALLS" && echo yes || echo no)"

# --- a close-ref never doubles as a work-claim Ready reset ---
: > "$calls"; : > "$BOARD_CALLS"
BODY="Closes #61. Part of #61."
TITLE="x (#61)"
rc=0; done_everywhere 45 || rc=$?
check "close-ref wins over work-claim"   "yes" "$(grep -q 'board status 61 Ready' "$BOARD_CALLS" && echo no || echo yes)"
check "close-ref still boarded Done"     "yes" "$(grep -q 'board status 61 Done' "$BOARD_CALLS" && echo yes || echo no)"

# --- unreadable body: warn + return 0, nothing mutated ---
: > "$calls"; : > "$BOARD_CALLS"
BODY=""; TITLE=""
rc=0; done_everywhere 46 || rc=$?
check "unreadable body returns 0"        "0" "$rc"
check "unreadable body mutates nothing"  "0" "$(wc -l < "$BOARD_CALLS" | tr -d ' ')"

# --- work-claim ref that gh cannot resolve (a PR number): skipped, rc 0 ---
: > "$calls"; : > "$BOARD_CALLS"
BODY="Part of #999"
TITLE="y"
rc=0; done_everywhere 47 || rc=$?
check "unresolvable work-claim skipped"  "yes" "$(grep -q ' 999 ' "$BOARD_CALLS" && echo no || echo yes)"
check "unresolvable work-claim rc 0"     "0" "$rc"

echo
if [ "$fails" -gt 0 ]; then echo "$fails FAILURES"; exit 1; fi
echo "ALL PASS"
