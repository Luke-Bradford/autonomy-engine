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
if qa_should_merge "gh_review" "true"; then r=merge; else r=refuse; fi
check "gh_review + completes_merge -> merge allowed" merge "$r"
# WHITELIST, not blacklist: a garbled/mis-scraped strategy fails toward refuse
if qa_should_merge "bot_commentX" "true"; then r=merge; else r=refuse; fi
check "unknown strategy value -> refuse (whitelist, fail-safe)" refuse "$r"
if qa_should_merge "strategy: bot_comment" "true"; then r=merge; else r=refuse; fi
check "scrape artifact as strategy -> refuse" refuse "$r"

# --- qa_gate_allows_merge: the role's `gate` knob (#123) layered ON TOP of the
# merge authority. WHITELIST: `auto-merge-on-pass` is the ONLY value that can
# auto-merge; everything else (wait-for-human, absent, unknown, a garbled
# scrape) is treated as wait-for-human and refuses (fail-safe, never fail-open).
if qa_gate_allows_merge "auto-merge-on-pass" "ci_only" "true"; then r=merge; else r=refuse; fi
check "auto-merge-on-pass + ci_only + completes -> merge allowed" merge "$r"
if qa_gate_allows_merge "auto-merge-on-pass" "bot_comment" "true"; then r=merge; else r=refuse; fi
check "auto-merge-on-pass defers to strategy whitelist (bot_comment ok)" merge "$r"
if qa_gate_allows_merge "auto-merge-on-pass" "manual" "true"; then r=merge; else r=refuse; fi
check "auto-merge-on-pass + manual strategy -> refuse (never bypasses authority)" refuse "$r"
if qa_gate_allows_merge "auto-merge-on-pass" "ci_only" "false"; then r=merge; else r=refuse; fi
check "auto-merge-on-pass + completes_merge false -> refuse" refuse "$r"
if qa_gate_allows_merge "wait-for-human" "ci_only" "true"; then r=merge; else r=refuse; fi
check "wait-for-human NEVER auto-merges (even ci_only + completes)" refuse "$r"
if qa_gate_allows_merge "wait-for-human" "manual" "true"; then r=merge; else r=refuse; fi
check "wait-for-human + manual -> refuse" refuse "$r"
if qa_gate_allows_merge "" "ci_only" "true"; then r=merge; else r=refuse; fi
check "absent gate -> refuse (safe default, opt-in required; fail-safe)" refuse "$r"
if qa_gate_allows_merge "auto-merge-on-passX" "ci_only" "true"; then r=merge; else r=refuse; fi
check "unknown/garbled gate value -> refuse (whitelist, fail-safe)" refuse "$r"
if qa_gate_allows_merge "gate: auto-merge-on-pass" "ci_only" "true"; then r=merge; else r=refuse; fi
check "scrape artifact as gate -> refuse (mis-scrape must not fail-open)" refuse "$r"

# --- qa_role_field: the REAL roles.qa scalar extractor the workflow uses.
# These exercise the actual awk (not a hand-passed string) so the fail-open
# vectors are covered end to end: a commented-out opt-in and a qa: block under
# another top-level namespace must NEVER surface as the live gate knob.
cfg="$(mktemp)"
printf '%s\n' 'roles:' '  coder:' '    gate: auto-merge-on-pass' \
  '  qa:' '    gate: auto-merge-on-pass' '    completes_merge: true' \
  '  pm:' '    gate: wait-for-human' >"$cfg"
check "qa_role_field reads roles.qa.gate (not a sibling role's)" "auto-merge-on-pass" "$(qa_role_field "$cfg" gate)"
check "qa_role_field reads roles.qa.completes_merge" "true" "$(qa_role_field "$cfg" completes_merge)"

printf '%s\n' 'roles:' '  qa:' '    #gate: auto-merge-on-pass' '    gate: wait-for-human' >"$cfg"
check "commented-out opt-in above the real knob -> real knob wins (no fail-open)" "wait-for-human" "$(qa_role_field "$cfg" gate)"

printf '%s\n' 'roles:' '  qa:' '    gate: wait-for-human # gate: auto-merge-on-pass' >"$cfg"
check "trailing comment stripped, not scraped as the value" "wait-for-human" "$(qa_role_field "$cfg" gate)"

printf '%s\n' 'roles:' '  qa:' '    # gate: auto-merge-on-pass' >"$cfg"
check "only a commented gate -> empty (refuse)" "" "$(qa_role_field "$cfg" gate)"

printf '%s\n' 'workflow:' '  qa:' '    gate: auto-merge-on-pass' 'roles:' '  qa:' '    gate: wait-for-human' >"$cfg"
check "qa: under another top-level namespace -> real roles.qa wins (no fail-open)" "wait-for-human" "$(qa_role_field "$cfg" gate)"

printf '%s\n' 'roles:' '  qa:' '    completes_merge: true' >"$cfg"
check "absent gate knob -> empty (refuse)" "" "$(qa_role_field "$cfg" gate)"

# A DEEPER-nested key named `gate` (e.g. under a nested mapping) is NOT
# roles.qa.gate -- only the direct child scalar counts (no fail-open).
printf '%s\n' 'roles:' '  qa:' '    scope:' '      gate: auto-merge-on-pass' >"$cfg"
check "nested (non-direct) gate key -> empty (refuse, no fail-open)" "" "$(qa_role_field "$cfg" gate)"
printf '%s\n' 'roles:' '  qa:' '    scope:' '      gate: auto-merge-on-pass' '    gate: wait-for-human' >"$cfg"
check "nested gate ignored, direct roles.qa.gate wins" "wait-for-human" "$(qa_role_field "$cfg" gate)"

# Quoted scalars (#129): the engine config_parser strips a matching pair of
# surrounding quotes, and lib/roles.py validates the *unquoted* enum -- so a
# doctor-valid `gate: "auto-merge-on-pass"` must extract as the bare enum, not
# with quotes (which the downstream whitelist would reject -> silent
# wait-for-human). Mirror config_parser: strip one matching '..'/".." pair.
printf '%s\n' 'roles:' '  qa:' '    gate: "auto-merge-on-pass"' >"$cfg"
check "double-quoted gate value -> bare enum (parity with config_parser)" "auto-merge-on-pass" "$(qa_role_field "$cfg" gate)"
printf '%s\n' 'roles:' '  qa:' "    gate: 'auto-merge-on-pass'" >"$cfg"
check "single-quoted gate value -> bare enum" "auto-merge-on-pass" "$(qa_role_field "$cfg" gate)"
printf '%s\n' 'roles:' '  qa:' '    completes_merge: "true"' >"$cfg"
check "quoted completes_merge -> bare true" "true" "$(qa_role_field "$cfg" completes_merge)"
printf '%s\n' 'roles:' '  qa:' '    gate: "auto-merge-on-pass"   # opt in' >"$cfg"
check "quoted value + trailing comment -> bare enum" "auto-merge-on-pass" "$(qa_role_field "$cfg" gate)"
# Only a MATCHED pair is stripped (config_parser: first==last==quote). A
# mismatched / unterminated quote is left verbatim -> the whitelist refuses
# (fail-safe: a garbled value never becomes a bare enum by accident).
printf '%s\n' 'roles:' '  qa:' '    gate: "auto-merge-on-pass' >"$cfg"
check "unterminated quote left verbatim (no accidental enum -> refuse)" '"auto-merge-on-pass' "$(qa_role_field "$cfg" gate)"
printf '%s\n' 'roles:' '  qa:' '    gate: ""' >"$cfg"
check "empty quoted value -> empty (refuse)" "" "$(qa_role_field "$cfg" gate)"

# Malformed duplicate-key configs must match the engine config_parser's
# LAST-WINS semantics -- an earlier `auto-merge-on-pass` can never outlive the
# effective (last) value and fail the merge gate open.
printf '%s\n' 'roles:' '  qa:' '    gate: auto-merge-on-pass' '  qa:' '    gate: wait-for-human' >"$cfg"
check "duplicate qa: blocks -> last wins (no fail-open)" "wait-for-human" "$(qa_role_field "$cfg" gate)"
printf '%s\n' 'roles:' '  qa:' '    gate: auto-merge-on-pass' 'roles:' '  coder:' '    enabled: true' >"$cfg"
check "a later roles: without qa REPLACES the earlier -> gate absent (refuse)" "" "$(qa_role_field "$cfg" gate)"
printf '%s\n' 'roles:' '  qa:' '    gate: auto-merge-on-pass' '    gate: wait-for-human' >"$cfg"
check "duplicate gate: keys in one qa block -> last wins" "wait-for-human" "$(qa_role_field "$cfg" gate)"

check "unreadable config -> empty (fail-safe, no abort)" "" "$(qa_role_field "$cfg.nope" gate)"
rm -f "$cfg"

# End-to-end: the extracted gate + strategy + completes flow into the decision.
cfg="$(mktemp)"
printf '%s\n' 'roles:' '  qa:' '    gate: auto-merge-on-pass' '    completes_merge: true' >"$cfg"
if qa_gate_allows_merge "$(qa_role_field "$cfg" gate)" ci_only "$(qa_role_field "$cfg" completes_merge)"; then r=merge; else r=refuse; fi
check "config auto-merge-on-pass + completes + ci_only -> merge (end to end)" merge "$r"
printf '%s\n' 'roles:' '  qa:' '    #gate: auto-merge-on-pass' '    completes_merge: true' >"$cfg"
if qa_gate_allows_merge "$(qa_role_field "$cfg" gate)" ci_only "$(qa_role_field "$cfg" completes_merge)"; then r=merge; else r=refuse; fi
check "config with only a commented opt-in -> refuse (end to end, no fail-open)" refuse "$r"
rm -f "$cfg"

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

# The python check-filter is itself an unverifiable-state boundary: if it
# crashes (missing python / gh output-shape change) or emits nothing, the
# resulting empty checks_json matches neither the failing nor the pending grep,
# so the function must NOT fall through to green. Same fail-safe class as ghfail.
GH_MODE=green
python3() { :; }                       # filter emits empty output, rc 0
qa_join_ready 42 >/dev/null 2>&1
check "python filter empty output -> REFUSE, never assumed green (fail-safe)" "1" "$?"
python3() { return 1; }                 # filter crashes (nonzero exit)
qa_join_ready 42 >/dev/null 2>&1
check "python filter nonzero exit -> REFUSE (fail-safe)" "1" "$?"
unset -f python3

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
