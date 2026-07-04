#!/usr/bin/env bash
# Unit test for board.sh's resolver (user-then-org fallback, now field-name
# parametrized) + the p-label -> Priority-option mapping (#169).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=/dev/null
source "$HERE/../bin/board.sh"

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails + 1)); fi
}

USER_RESPONSE='{}'
ORG_RESPONSE='{}'
gh() {
  # $1=api $2=graphql -f query=... -f o=...
  # here-string, not `printf | grep -q`: under `set -o pipefail` a matching
  # grep -q exits before the producer finishes and SIGPIPEs it (prevention-log #7).
  if grep -q 'organization(login' <<<"$*"; then
    printf '%s' "$ORG_RESPONSE"
  else
    printf '%s' "$USER_RESPONSE"
  fi
}

# --- board_resolve_project (Status via the thin wrapper) ---------------------
USER_RESPONSE='{"data":{"user":{"projectsV2":{"nodes":[{"id":"PID_USER","title":"eBull engineering board","fields":{"nodes":[{"id":"FID_USER","name":"Status","options":[{"id":"OPT1","name":"In Progress"}]}]}}]}}}}'
ids="$(board_resolve_project "Luke-Bradford" "eBull engineering board" "In Progress")"
check "user-owned project Status option found directly" "PID_USER FID_USER OPT1" "$ids"

USER_RESPONSE='{"data":{"user":{"projectsV2":{"nodes":[]}}}}'
ORG_RESPONSE='{"data":{"organization":{"projectsV2":{"nodes":[{"id":"PID_ORG","title":"org board","fields":{"nodes":[{"id":"FID_ORG","name":"Status","options":[]}]}}]}}}}'
ids="$(board_resolve_project "some-org" "org board" "")"
check "falls back to organization when user has no match" "PID_ORG FID_ORG " "$ids"

USER_RESPONSE='{"data":{"user":{"projectsV2":{"nodes":[]}}}}'
ORG_RESPONSE='{"data":{"organization":null}}'
ids="$(board_resolve_project "nobody" "nothing" "")"
check "neither user nor org match -> empty" "" "$(printf '%s' "$ids" | tr -d ' ')"

# --- board_resolve_field (Priority) ------------------------------------------
# a project carrying BOTH single-selects; the resolver filters by field name.
USER_RESPONSE='{"data":{"user":{"projectsV2":{"nodes":[{"id":"PID_U","title":"Autonomy Progress","fields":{"nodes":[{"id":"SFID","name":"Status","options":[{"id":"SOPT","name":"In review"}]},{"id":"PRIO_FID","name":"Priority","options":[{"id":"P0OPT","name":"P0"},{"id":"P1OPT","name":"P1"},{"id":"P2OPT","name":"P2"}]}]}}]}}}}'
ORG_RESPONSE='{}'
ids="$(board_resolve_field "Luke-Bradford" "Autonomy Progress" "Priority" "P1")"
check "resolves a Priority field option by name" "PID_U PRIO_FID P1OPT" "$ids"
# and Status off the SAME enumerated project (no field-name cross-talk)
ids="$(board_resolve_field "Luke-Bradford" "Autonomy Progress" "Status" "In review")"
check "resolves Status off the same enumerated project" "PID_U SFID SOPT" "$ids"

# field-absent: project found but no Priority field -> pid + empty field/opt,
# so the body skips silently (best-effort). No empty MIDDLE token.
USER_RESPONSE='{"data":{"user":{"projectsV2":{"nodes":[{"id":"PID_NP","title":"NoPrio","fields":{"nodes":[{"id":"S","name":"Status","options":[]}]}}]}}}}'
ids="$(board_resolve_field "Luke-Bradford" "NoPrio" "Priority" "P0")"
check "absent Priority field -> project id only" "PID_NP" "$(printf '%s' "$ids" | cut -d' ' -f1)"
check "absent Priority field -> empty field id" "" "$(printf '%s' "$ids" | cut -d' ' -f2)"

# Priority resolves via the org fallback too.
USER_RESPONSE='{"data":{"user":{"projectsV2":{"nodes":[]}}}}'
ORG_RESPONSE='{"data":{"organization":{"projectsV2":{"nodes":[{"id":"PID_O","title":"org board","fields":{"nodes":[{"id":"OPRIO","name":"Priority","options":[{"id":"OP2","name":"P2"}]}]}}]}}}}'
ids="$(board_resolve_field "some-org" "org board" "Priority" "P2")"
check "Priority resolves via org fallback" "PID_O OPRIO OP2" "$ids"

# --- plabel_to_priority ------------------------------------------------------
check "p1 maps to P0" "P0" "$(plabel_to_priority "$(printf 'bug\np1\nloop-ready')")"
check "p2 maps to P1" "P1" "$(plabel_to_priority "p2")"
check "p3 maps to P2" "P2" "$(plabel_to_priority "p3")"
check "no p-label -> empty" "" "$(plabel_to_priority "$(printf 'bug\nloop-ready')")"
check "highest p-label wins (p2+p3 -> P1)" "P1" "$(plabel_to_priority "$(printf 'p3\np2')")"
check "highest p-label wins (p1+p3 -> P0)" "P0" "$(plabel_to_priority "$(printf 'p3\np1')")"
check "non-p labels never match (priority1 ignored)" "" "$(plabel_to_priority "$(printf 'priority1\nsp1\np11')")"

# --- board_sweep_scan (#252): closed-issue -> Done sweep candidate scan -------
# PID-scoped node query with in-bash cursor pagination. The mock gh returns
# PAGE1 for the first (no-cursor) call and PAGE2 once a `cursor=` arg appears,
# proving the scan follows hasNextPage to the tail. done_opt = OPT_DONE.
#   PAGE1: an OPEN item (skip) + an already-Done CLOSED item (idempotent skip),
#          hasNextPage=true -> the scan must fetch page 2.
#   PAGE2: a CLOSED item in a non-Done column (sweep), a CLOSED item with NO
#          Status (closed SHOULD be Done -> sweep), and a draft/PR row whose
#          content lacks `state` (skip). hasNextPage=false.
SWEEP_PAGE1='{"data":{"node":{"items":{"pageInfo":{"hasNextPage":true,"endCursor":"CUR1"},"nodes":[{"id":"IT_OPEN","status":{"optionId":"OPT_INPROG"},"content":{"state":"OPEN"}},{"id":"IT_DONE","status":{"optionId":"OPT_DONE"},"content":{"state":"CLOSED"}}]}},"rateLimit":{"remaining":4900}}}'
SWEEP_PAGE2='{"data":{"node":{"items":{"pageInfo":{"hasNextPage":false,"endCursor":"CUR2"},"nodes":[{"id":"IT_STALE","status":{"optionId":"OPT_BLOCKED"},"content":{"state":"CLOSED"}},{"id":"IT_NOSTATUS","status":null,"content":{"state":"CLOSED"}},{"id":"IT_DRAFT","status":null,"content":{}}]}},"rateLimit":{"remaining":4899}}}'
gh() {
  # here-string, not `printf|grep -q` (SIGPIPE under pipefail; prevention-log #7)
  if grep -q 'cursor=' <<<"$*"; then printf '%s' "$SWEEP_PAGE2"; else printf '%s' "$SWEEP_PAGE1"; fi
}

scan="$(board_sweep_scan "PID_X" "OPT_DONE")"
{ IFS= read -r remaining_line; ids="$(cat)"; } <<EOF
$scan
EOF
check "sweep_scan reports remaining from last page" "4899" "$remaining_line"
check "sweep_scan reaches page 2 (stale closed non-Done swept)" "1" "$(printf '%s\n' "$ids" | grep -c '^IT_STALE$')"
check "sweep_scan sweeps a closed issue with NO status" "1" "$(printf '%s\n' "$ids" | grep -c '^IT_NOSTATUS$')"
check "sweep_scan idempotent: already-Done closed item NOT swept" "0" "$(printf '%s\n' "$ids" | grep -c '^IT_DONE$')"
check "sweep_scan skips OPEN item" "0" "$(printf '%s\n' "$ids" | grep -c '^IT_OPEN$')"
check "sweep_scan skips draft/PR (no state)" "0" "$(printf '%s\n' "$ids" | grep -c '^IT_DRAFT$')"

# gh failure on the very first page -> remaining unknown (-1) and NO ids
# (fail-safe: never fabricate a sweep target when board state is unknown; the
# caller reads -1, skips the rate-limit gate, and mutates nothing).
gh() { return 1; }
scan="$(board_sweep_scan "PID_X" "OPT_DONE")"
{ IFS= read -r remaining_line; ids="$(cat)"; } <<EOF
$scan
EOF
check "sweep_scan gh-failure: remaining unknown (-1)" "-1" "$remaining_line"
check "sweep_scan gh-failure: yields no ids" "" "$(printf '%s' "$ids" | tr -d ' \n')"

# Page-2 failure AFTER page 1 accumulated a real target -> all-or-nothing: an
# INCOMPLETE scan emits NO ids (the tail is retried next pass), never a partial
# target set. PAGE1 has a closed non-Done item + hasNextPage=true; the paginated
# (cursor=) call fails.
SWEEP_P1_HAS='{"data":{"node":{"items":{"pageInfo":{"hasNextPage":true,"endCursor":"CUR1"},"nodes":[{"id":"IT_P1","status":{"optionId":"OPT_BLOCKED"},"content":{"state":"CLOSED"}}]}},"rateLimit":{"remaining":4000}}}'
gh() {
  if grep -q 'cursor=' <<<"$*"; then return 1; else printf '%s' "$SWEEP_P1_HAS"; fi
}
scan="$(board_sweep_scan "PID_X" "OPT_DONE")"
{ IFS= read -r _r; ids="$(cat)"; } <<EOF
$scan
EOF
check "sweep_scan incomplete (page-2 fail): discards page-1 ids" "" "$(printf '%s' "$ids" | tr -d ' \n')"

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails CHECK(S) FAILED"; exit 1; fi
