#!/usr/bin/env bash
# tests/test_board_stall.sh -- approved-but-unmerged stall detection (#292).
# board.sh's sweep flags any open PR whose latest review-bot verdict is APPROVE,
# postdates the head commit, and is older than the threshold -- the "two green
# PRs sat unmerged for 90 minutes with zero signal" incident class
# (prevention-log #17 night). Verdict parsing follows review-resolution
# "Reading the gate": the bot COMMENT is the verdict source, never the check
# bucket. Sources the real board.sh; `gh` is mocked at the established seam.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_HOME="$(cd "$HERE/.." && pwd)"

# shellcheck source=/dev/null
source "$ENGINE_HOME/bin/board.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails + 1)); fi
}

AUTHOR="github-actions"
MARKER="Claude Code Review"

# Build PR fixtures with timestamps relative to now. Args:
#   mkpr <file> <head_age_secs> <review_age_secs|-> <verdict|->
# review "-" = no bot comment at all.
mkpr() {
  python3 - "$@" <<'EOF'
import json, sys, time
from datetime import datetime, timezone
path, head_age, review_age, verdict = sys.argv[1:5]
def iso(age):
    return datetime.fromtimestamp(time.time() - int(age), tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
d = {"commits": [{"oid": "cafe1234deadbeef", "committedDate": iso(head_age)}],
     "comments": []}
if review_age != "-":
    d["comments"] = [
        {"author": {"login": "someone-else"}, "createdAt": iso(9999999), "body": "unrelated"},
        {"author": {"login": "github-actions"},
         "createdAt": iso(review_age),
         "body": "## Claude Code Review\n\n### Verdict\n**%s**" % verdict}]
json.dump(d, open(path, "w"))
EOF
}

mkpr "$tmp/pr101.json" 4000 2700 "APPROVE"          # approved 45m ago, postdates head -> STALLED
mkpr "$tmp/pr102.json" 4000 300  "APPROVE"          # approved 5m ago -> too fresh
mkpr "$tmp/pr103.json" 1000 2700 "APPROVE"          # approve PREDATES head (push reset the gate) -> not stalled
mkpr "$tmp/pr104.json" 4000 -    "-"                # no bot comment yet -> not stalled
mkpr "$tmp/pr105.json" 4000 2700 "REQUEST CHANGES"  # blocking verdict -> not stalled
printf 'garbage not json' > "$tmp/pr106.json"       # unparseable -> skipped silently
# Stalled-shaped but NO head oid -> no per-head idempotency possible -> no claim.
python3 - "$tmp/pr107.json" <<'EOF'
import json, sys, time
from datetime import datetime, timezone
def iso(age):
    return datetime.fromtimestamp(time.time() - age, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
json.dump({"commits": [{"committedDate": iso(4000)}],
           "comments": [{"author": {"login": "github-actions"}, "createdAt": iso(2700),
                         "body": "## Claude Code Review\n**APPROVE**"}]},
          open(sys.argv[1], "w"))
EOF

gh() {
  case "$*" in
    "pr list"*) printf '101\n102\n103\n104\n105\n106\n107\n' ;;
    "pr view 101"*) cat "$tmp/pr101.json" ;;
    "pr view 102"*) cat "$tmp/pr102.json" ;;
    "pr view 103"*) cat "$tmp/pr103.json" ;;
    "pr view 104"*) cat "$tmp/pr104.json" ;;
    "pr view 105"*) cat "$tmp/pr105.json" ;;
    "pr view 106"*) cat "$tmp/pr106.json" ;;
    "pr view 107"*) cat "$tmp/pr107.json" ;;
    *) return 1 ;;
  esac
}

# --- scan: exactly the one genuinely-stalled PR is reported --------------------
out="$(board_stall_scan "$AUTHOR" "$MARKER" 1800)"; rc=$?
check "scan rc 0"                          "0"   "$rc"
check "exactly one stalled PR"             "1"   "$(printf '%s\n' "$out" | grep -c . )"
check "the stalled PR is #101"             "101" "$(printf '%s' "$out" | cut -f1)"
check "head oid carried for idempotency"   "cafe1234deadbeef" "$(printf '%s' "$out" | cut -f3)"
age="$(printf '%s' "$out" | cut -f2)"
ok=$([ "$age" -ge 44 ] && [ "$age" -le 46 ] && echo yes || echo no)
check "age is ~45 minutes"                 "yes" "$ok"

# --- fail-safe: gh list failure -> no claims, rc 0, warn -----------------------
gh() { return 1; }
out="$(board_stall_scan "$AUTHOR" "$MARKER" 1800 2>"$tmp/warn.txt")"; rc=$?
check "gh failure -> rc 0 (best-effort)"   "0"   "$rc"
check "gh failure -> no stall lines"       ""    "$out"
check "gh failure -> warns"                "1"   "$(grep -c "stall" "$tmp/warn.txt")"

# --- empty board -> nothing ----------------------------------------------------
gh() { case "$*" in "pr list"*) printf '' ;; *) return 1 ;; esac; }
out="$(board_stall_scan "$AUTHOR" "$MARKER" 1800)"; rc=$?
check "no open PRs -> rc 0, silent"        "0|"  "$rc|$out"

# --- flag: comments once per head oid, idempotent ------------------------------
: > "$tmp/comment-calls.log"
gh() {
  case "$*" in
    "pr view 101 --json comments"*)
      # existing comments contain no stall marker
      printf '{"comments":[{"body":"unrelated"}]}' ;;
    "pr comment"*)
      printf '%s\n' "$*" >> "$tmp/comment-calls.log" ;;
    *) return 1 ;;
  esac
}
board_stall_flag 101 45 cafe1234deadbeef; rc=$?
check "flag rc 0"                          "0" "$rc"
check "one comment posted"                 "1" "$(grep -c "pr comment 101" "$tmp/comment-calls.log")"
check "comment carries the head marker"    "1" "$(grep -c "autonomy-stall-flag cafe1234deadbeef" "$tmp/comment-calls.log")"

# Same head already flagged -> no second comment.
gh() {
  case "$*" in
    "pr view 101 --json comments"*)
      printf '{"comments":[{"body":"stall <!-- autonomy-stall-flag cafe1234deadbeef -->"}]}' ;;
    "pr comment"*)
      printf '%s\n' "$*" >> "$tmp/comment-calls.log" ;;
    *) return 1 ;;
  esac
}
board_stall_flag 101 45 cafe1234deadbeef; rc=$?
check "already flagged for this head -> rc 0, no repost" "1" "$(grep -c "pr comment 101" "$tmp/comment-calls.log")"

# Comment-read failure -> do NOT post (cannot prove idempotency), warn, rc 0.
gh() { return 1; }
board_stall_flag 101 45 cafe1234deadbeef 2>"$tmp/warn2.txt"; rc=$?
check "comment-read failure -> rc 0, nothing posted" "1|0" "$(grep -c "pr comment 101" "$tmp/comment-calls.log")|$rc"

# --- main path: labels-only repo (no board configured) still gets stall flags -
# #298 shipped stall detection with the in-code claim "a labels-only repo (no
# board) still gets stall flags", but the owner/project_title empty guard sat
# ABOVE the sweep block and exited first (Codex CP2 catch on the SD-31 scaffold
# change, which makes empty project_title the scaffold default). Subprocess
# test through the real CLI: sweep must run the stall scan WITHOUT a board,
# while status/add (board mutations) still skip cleanly.
SUBTMP="$tmp/mainpath"
mkdir -p "$SUBTMP/repo/.autonomy" "$SUBTMP/bin"
cat > "$SUBTMP/repo/.autonomy/config.yaml" <<'YML'
board:
  owner: CHANGE-ME
  project_title: ""
merge_gate:
  strategy: bot_comment
YML
cat > "$SUBTMP/bin/gh" <<SH
#!/usr/bin/env bash
args="\$*"
case "\$args" in
  "pr list"*) printf '101\n' ;;
  "pr view 101 --json commits,comments"*) cat "$tmp/pr101.json" ;;
  "pr view 101 --json comments"*) printf '{"comments":[{"body":"unrelated"}]}' ;;
  "pr comment"*) printf '%s\n' "\$args" >> "$SUBTMP/comments.log"; exit 0 ;;
  *) exit 1 ;;
esac
SH
chmod +x "$SUBTMP/bin/gh"

: > "$SUBTMP/comments.log"
( cd "$SUBTMP/repo" && PATH="$SUBTMP/bin:$PATH" "$ENGINE_HOME/bin/board.sh" sweep ) >/dev/null 2>&1
rc=$?
check "labels-only sweep: rc 0 (best-effort)"      "0" "$rc"
check "labels-only sweep: stall flag still posted" "1" "$(grep -c "pr comment 101" "$SUBTMP/comments.log")"

# status/add mutate the board -- with none configured they skip, post nothing.
: > "$SUBTMP/comments.log"
( cd "$SUBTMP/repo" && PATH="$SUBTMP/bin:$PATH" "$ENGINE_HOME/bin/board.sh" status 42 "In review" ) >/dev/null 2>&1
rc=$?
check "labels-only status: rc 0 (skip)"            "0" "$rc"
check "labels-only status: no gh writes"           "0" "$(grep -c . "$SUBTMP/comments.log")"

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails CHECK(S) FAILED"; exit 1; fi
