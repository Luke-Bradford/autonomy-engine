#!/usr/bin/env bash
# Unit test for the QA merge-gate decision script (#13) that onboard scaffolds
# into a target repo (.autonomy/qa/decide.sh) and the qa-merge-gate workflow
# sources. Tests source the REAL script and mock only `gh` (network).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=/dev/null
source "$HERE/../templates/autonomy-pack/qa/decide.sh"

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails + 1)); fi
}

# --- qa_should_merge: the never-silent-merge bottleneck ---
if qa_should_merge "manual" "true"; then r=merge; else r=refuse; fi
check "strategy manual -> NEVER merges (even completes_merge=true)" refuse "$r"
if qa_should_merge "" "true"; then r=merge; else r=refuse; fi
check "empty strategy (defaults to manual) -> refuse" refuse "$r"
if qa_should_merge "bot_comment" "false"; then r=merge; else r=refuse; fi
check "completes_merge false -> refuse" refuse "$r"
if qa_should_merge "bot_comment" ""; then r=merge; else r=refuse; fi
check "completes_merge unset -> refuse (opt-in only)" refuse "$r"
if qa_should_merge "bot_comment" "true"; then r=merge; else r=refuse; fi
check "bot_comment + completes_merge -> merge allowed" merge "$r"
if qa_should_merge "ci_only" "true"; then r=merge; else r=refuse; fi
check "ci_only + completes_merge -> merge allowed" merge "$r"

# --- qa_join_ready: approved + CI green on the head SHA, fail-safe ---
GH_MODE=""
gh() {
  case "$GH_MODE $1 $2" in
    *"pr view"*)
      case "$GH_MODE" in
        notapproved*) echo "REVIEW_REQUIRED abc123" ;;
        *) echo "APPROVED abc123" ;;
      esac ;;
    *"pr checks"*)
      case "$GH_MODE" in
        *ghfail*) return 1 ;;
        *pending*) echo '[{"name":"lint","state":"PENDING"}]' ;;
        *failing*) echo '[{"name":"lint","state":"FAILURE"}]' ;;
        *ownonly*) echo '[{"name":"qa-gate","state":"PENDING"}]' ;;
        *) echo '[{"name":"lint","state":"SUCCESS"},{"name":"qa-gate","state":"PENDING"}]' ;;
      esac ;;
    *) return 1 ;;
  esac
}

GH_MODE=green
out="$(qa_join_ready 42 2>/dev/null)"; rc=$?
check "approved + green (own qa-gate check excluded) -> ready" "0" "$rc"
check "ready emits the head sha (verdict binds to THIS commit)" "abc123" "$out"

GH_MODE=notapproved
qa_join_ready 42 >/dev/null 2>&1; check "not approved -> not ready" "1" "$?"

GH_MODE=pending
qa_join_ready 42 >/dev/null 2>&1; check "CI pending -> not ready" "1" "$?"

GH_MODE=failing
qa_join_ready 42 >/dev/null 2>&1; check "CI failing -> not ready" "1" "$?"

GH_MODE=ghfail
qa_join_ready 42 >/dev/null 2>&1
check "gh failure -> REFUSE, never assumed green (fail-safe invariant)" "1" "$?"

GH_MODE=ownonly
qa_join_ready 42 >/dev/null 2>&1
check "only our own qa-gate check exists -> ready (no third-party CI)" "0" "$?"

# --- verdict extraction from a QA run transcript ---
t="$(mktemp)"
printf 'thinking...\nQA-VERDICT: pass\n' >"$t"
check "verdict pass extracted" "pass" "$(qa_extract_verdict "$t")"
printf 'looked bad\nQA-VERDICT: fail\ntrailing\n' >"$t"
check "verdict fail extracted (last wins)" "fail" "$(qa_extract_verdict "$t")"
printf 'no verdict line at all\n' >"$t"
check "missing verdict -> fail (fail-safe)" "fail" "$(qa_extract_verdict "$t")"
rm -f "$t"

# --- qa_post_verdict / qa_complete_merge emit exactly the expected gh calls ---
calls="$(mktemp)"
gh() { printf '%s\n' "$*" >>"$calls"; }
qa_post_verdict abc123 success "QA pass" myorg/myrepo
case "$(cat "$calls")" in
  *"api repos/myorg/myrepo/statuses/abc123"*) r=yes ;;
  *) r=no ;;
esac
check "verdict posted as commit status on the exact sha" yes "$r"
: >"$calls"
qa_complete_merge 42
case "$(cat "$calls")" in
  *"pr merge 42 --squash"*) r=yes ;;
  *) r=no ;;
esac
check "merge completes via gh pr merge --squash" yes "$r"
rm -f "$calls"

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails CHECK(S) FAILED"; exit 1; fi
