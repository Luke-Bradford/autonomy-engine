#!/usr/bin/env bash
# tests/test_safe_merge_done_everywhere.sh -- done_everywhere() executes the
# SD-26 completion checklist at the merge chokepoint: verify/close the issues
# GITHUB ITSELF linked as closing refs (closingIssuesReferences -- the
# server-side grammar; #301: a prose regex matched NEGATED phrases like
# "does NOT close #90" and closed them), board them Done; board the PR's
# still-open WORK-CLAIM tickets (explicit "Part of #N" in the body, or (#N)
# in the title) back to Ready; never touch prose-mention issues; and NEVER
# fail the caller -- every hygiene failure warns and continues (the merge has
# already landed; SD-6 best-effort board).
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

# gh mock: PR body/title/server close-refs per scenario; issue states per
# scenario map. BODY_RC simulates the `gh pr view --json body` CALL failing
# (vs an empty but successfully-read body); CLOSEREFS_RC the same for the
# closingIssuesReferences call; CLOSE_FAIL makes `gh issue close` fail.
# CLOSE_REFS is newline-separated issue numbers -- what GitHub's own closing-
# keyword grammar linked (negations never appear here; that's the point).
BODY=""; TITLE=""; CLOSE_REFS=""; BODY_RC=0; CLOSEREFS_RC=0; CLOSE_FAIL=""
gh() {
  printf 'gh %s\n' "$*" >> "$calls"
  case "$*" in
    "pr view"*"--json closingIssuesReferences"*)
      [ "$CLOSEREFS_RC" != "0" ] && return "$CLOSEREFS_RC"
      [ -n "$CLOSE_REFS" ] && printf '%s\n' "$CLOSE_REFS" ;;
    "pr view"*"--json body"*)  [ "$BODY_RC" != "0" ] && return "$BODY_RC"; printf '%s\n' "$BODY" ;;
    "pr view"*"--json title"*) printf '%s\n' "$TITLE" ;;
    "issue view 61 "*) printf 'OPEN\n' ;;
    "issue view 62 "*) printf 'CLOSED\n' ;;
    "issue view 63 "*) printf 'OPEN\n' ;;
    "issue view 64 "*) printf 'OPEN\n' ;;
    "issue view 90 "*) printf 'OPEN\n' ;;
    "issue view"*) return 1 ;;   # unknown ref (e.g. a PR number) -> error
    "issue close"*) [ -n "$CLOSE_FAIL" ] && return 1 ;;
  esac
  return 0
}

# --- happy path: server close-ref still open -> closed + Done; claim -> Ready
: > "$calls"; : > "$BOARD_CALLS"
CLOSE_REFS="61"
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

# --- #301 REGRESSION: a NEGATED phrase in the body ("does NOT close #90")
# never appears in GitHub's server refs -- it must close/board NOTHING, even
# though the old prose regex matched the bigram "close #90".
: > "$calls"; : > "$BOARD_CALLS"
CLOSE_REFS=""
BODY="This PR ships item (c) but does NOT close #90 -- the onboarding-UI build remains. Also won't fix #61 here, and never resolves #63."
TITLE="feat: scaffold empty project_title"
rc=0; done_everywhere 52 || rc=$?
check "negated 'does NOT close #90' closes nothing" "yes" "$(grep -q 'gh issue close' "$calls" && echo no || echo yes)"
check "negated refs board nothing Done"             "yes" "$(grep -q 'Done' "$BOARD_CALLS" && echo no || echo yes)"
check "negated-body rc 0"                           "0" "$rc"

# --- #301: the server refs are the ONLY close authority -- a body 'Closes #61'
# GitHub did NOT link (e.g. inside a code block) must not close either.
: > "$calls"; : > "$BOARD_CALLS"
CLOSE_REFS=""
BODY="In a code fence: \`Closes #61\` (not a real closing keyword position)."
TITLE="docs: example"
rc=0; done_everywhere 53 || rc=$?
check "body-only close phrase without server link closes nothing" "yes" "$(grep -q 'gh issue close' "$calls" && echo no || echo yes)"

# --- #301: closingIssuesReferences CALL failure -> warn, skip the close pass,
# work-claims still process (best-effort; a missed close is the safe side).
: > "$calls"; : > "$BOARD_CALLS"
CLOSE_REFS=""; CLOSEREFS_RC=1
BODY="Part of #63."
TITLE="w"
rc=0; done_everywhere 54 || rc=$?
CLOSEREFS_RC=0
check "close-refs call failure rc 0"          "0" "$rc"
check "close-refs call failure closes nothing" "yes" "$(grep -q 'gh issue close' "$calls" && echo no || echo yes)"
check "close-refs call failure still processes claims" "yes" "$(grep -q 'board status 63 Ready' "$BOARD_CALLS" && echo yes || echo no)"

# --- already-closed close-ref: no re-close, still boarded Done ---
: > "$calls"; : > "$BOARD_CALLS"
CLOSE_REFS="62"
BODY="Fixes #62"
TITLE="fix: other"
rc=0; done_everywhere 43 || rc=$?
check "already-closed ref not re-closed" "yes" "$(grep -q 'gh issue close 62' "$calls" && echo no || echo yes)"
check "already-closed ref still Done"    "yes" "$(grep -q 'board status 62 Done' "$BOARD_CALLS" && echo yes || echo no)"

# --- title work-claim without body claim ---
: > "$calls"; : > "$BOARD_CALLS"
CLOSE_REFS=""
BODY="no refs here"
TITLE="feat: rail cleanup (#64)"
rc=0; done_everywhere 44 || rc=$?
check "title (#64) work-claim -> Ready"  "yes" "$(grep -q 'board status 64 Ready' "$BOARD_CALLS" && echo yes || echo no)"

# --- a close-ref never doubles as a work-claim Ready reset ---
: > "$calls"; : > "$BOARD_CALLS"
CLOSE_REFS="61"
BODY="Closes #61. Part of #61."
TITLE="x (#61)"
rc=0; done_everywhere 45 || rc=$?
check "close-ref wins over work-claim"   "yes" "$(grep -q 'board status 61 Ready' "$BOARD_CALLS" && echo no || echo yes)"
check "close-ref still boarded Done"     "yes" "$(grep -q 'board status 61 Done' "$BOARD_CALLS" && echo yes || echo no)"

# --- UNREADABLE body (gh CALL fails): warn + return 0, nothing mutated ---
: > "$calls"; : > "$BOARD_CALLS"
CLOSE_REFS=""; BODY=""; TITLE=""; BODY_RC=1
rc=0; done_everywhere 46 || rc=$?
BODY_RC=0
check "unreadable body returns 0"        "0" "$rc"
check "unreadable body mutates nothing"  "0" "$(wc -l < "$BOARD_CALLS" | tr -d ' ')"

# --- EMPTY-but-readable body (post-hoc codex finding 2): title work-claims
# must still process -- an empty body is data, not an error ---
: > "$calls"; : > "$BOARD_CALLS"
CLOSE_REFS=""; BODY=""; TITLE="feat: rail cleanup (#64)"
rc=0; done_everywhere 50 || rc=$?
check "empty body + title claim -> Ready"  "yes" "$(grep -q 'board status 64 Ready' "$BOARD_CALLS" && echo yes || echo no)"
check "empty body rc 0"                    "0" "$rc"

# --- close FAILURE must not board Done (post-hoc codex finding 1): the board
# must never say Done while the issue is still open ---
: > "$calls"; : > "$BOARD_CALLS"
CLOSE_REFS="61"; BODY="Closes #61"; TITLE="x"; CLOSE_FAIL=1
rc=0; done_everywhere 51 || rc=$?
CLOSE_FAIL=""
check "failed close -> NOT boarded Done"   "yes" "$(grep -q 'board status 61 Done' "$BOARD_CALLS" && echo no || echo yes)"
check "failed close rc 0"                  "0" "$rc"

# --- MULTI close-ref + work-claim on a NON-LAST ref (review-bot finding on
# PR #283): de_close is newline-separated, so a space-padded case-glob missed
# interior entries -- #61 must stay Done-only, never Ready-reset ---
: > "$calls"; : > "$BOARD_CALLS"
CLOSE_REFS="61
62"
BODY="Closes #61, closes #62.

Part of #61."
TITLE="multi (#61)"
rc=0; done_everywhere 48 || rc=$?
check "multi-close: first ref boarded Done"     "yes" "$(grep -q 'board status 61 Done' "$BOARD_CALLS" && echo yes || echo no)"
check "multi-close: second ref boarded Done"    "yes" "$(grep -q 'board status 62 Done' "$BOARD_CALLS" && echo yes || echo no)"
check "multi-close: no Ready-reset on interior close-ref" "yes" "$(grep -q 'board status 61 Ready' "$BOARD_CALLS" && echo no || echo yes)"

# --- work-claim ref that gh cannot resolve (a PR number): skipped, rc 0 ---
: > "$calls"; : > "$BOARD_CALLS"
CLOSE_REFS=""; BODY="Part of #999"; TITLE="y"
rc=0; done_everywhere 47 || rc=$?
check "unresolvable work-claim skipped"  "yes" "$(grep -q ' 999 ' "$BOARD_CALLS" && echo no || echo yes)"
check "unresolvable work-claim rc 0"     "0" "$rc"

# --- unresolvable CLOSE-ref (round-2 review finding): must be skipped like
# the work-claim loop -- never close-attempted, never boarded Done ---
: > "$calls"; : > "$BOARD_CALLS"
CLOSE_REFS="999
61"
BODY="Closes #999. Closes #61."
TITLE="z"
rc=0; done_everywhere 49 || rc=$?
check "unresolvable close-ref not boarded Done"    "yes" "$(grep -q ' 999 ' "$BOARD_CALLS" && echo no || echo yes)"
check "unresolvable close-ref not close-attempted" "yes" "$(grep -q 'gh issue close 999' "$calls" && echo no || echo yes)"
check "sibling resolvable close-ref still Done"    "yes" "$(grep -q 'board status 61 Done' "$BOARD_CALLS" && echo yes || echo no)"
check "unresolvable close-ref rc 0"                "0" "$rc"

echo
if [ "$fails" -gt 0 ]; then echo "$fails FAILURES"; exit 1; fi
echo "ALL PASS"
