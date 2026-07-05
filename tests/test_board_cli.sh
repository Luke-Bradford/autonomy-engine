#!/usr/bin/env bash
# Body-level (subprocess) tests for board.sh (#169): the Priority enrichment
# path + the best-effort exit-0 invariant. A fake `gh` on PATH returns canned
# Projects v2 / issue JSON and records the single-select mutations so we can
# assert the mapped Priority option (and Status) were written. board.sh runs as
# a real subprocess from a temp repo (real config_parser reads the config.yaml).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails + 1)); fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/repo/.autonomy" "$TMP/bin"
cat > "$TMP/repo/.autonomy/config.yaml" <<'YML'
board:
  owner: Luke-Bradford
  project_title: Autonomy Progress
YML

# Fake gh: dispatch on the joined argv. GH_LABELS sets the issue's p-label;
# GH_FAIL=1 makes every call fail (rc 1, empty) to drive the best-effort path.
# Mutations are appended to $TMP/mutations as "SET f=<fid> o=<optid>".
cat > "$TMP/bin/gh" <<SH
#!/usr/bin/env bash
set -uo pipefail
if [ -n "\${GH_FAIL:-}" ]; then exit 1; fi
args="\$*"
case "\$args" in
  *"issue view"*)
    printf '{"id":"ISSUE_NODE","labels":[{"name":"%s"},{"name":"loop-ready"}]}' "\${GH_LABELS:-p2}" ;;
  *updateProjectV2ItemFieldValue*)
    echo "SET \$args" >> "$TMP/mutations"
    printf '{"data":{"updateProjectV2ItemFieldValue":{"projectV2Item":{"id":"ITEM"}}}}' ;;
  *addProjectV2ItemById*)
    printf 'ITEM' ;;
  *projectItems*)
    printf '{"data":{"node":{"projectItems":{"nodes":[{"id":"ITEM","project":{"id":"PID"}}]}}}}' ;;
  *rateLimit*)
    # #252 sweep scan (node(id:\$pid){...ProjectV2{items}} rateLimit) -- one closed
    # non-Done item (sweep), one already-Done closed item (idempotent skip), one
    # OPEN item (skip). GH_SWEEP_REMAINING drives the rate-limit gate.
    printf '{"data":{"node":{"items":{"pageInfo":{"hasNextPage":false,"endCursor":"C"},"nodes":[{"id":"SWEEP_ITEM","status":{"optionId":"OPT_BLOCKED"},"content":{"state":"CLOSED"}},{"id":"DONE_ITEM","status":{"optionId":"DONEOPT"},"content":{"state":"CLOSED"}},{"id":"OPEN_ITEM","status":{"optionId":"OPT_BLOCKED"},"content":{"state":"OPEN"}}]}},"rateLimit":{"remaining":%s}}}' "\${GH_SWEEP_REMAINING:-5000}" ;;
  *projectsV2*)
    printf '%s' '{"data":{"user":{"projectsV2":{"nodes":[{"id":"PID","title":"'"\${GH_PROJ_TITLE:-Autonomy Progress}"'","fields":{"nodes":[{"id":"SFID","name":"Status","options":[{"id":"SOPT","name":"In review"},{"id":"DONEOPT","name":"Done"}]},{"id":"PFID","name":"Priority","options":[{"id":"P0OPT","name":"P0"},{"id":"P1OPT","name":"P1"},{"id":"P2OPT","name":"P2"}]}]}}]}}}}' ;;
  *) printf '{}' ;;
esac
SH
chmod +x "$TMP/bin/gh"

# run <labels> <fail> <board.sh args...> -> prints rc; resets the mutations log.
run() {
  local labels="$1" fail="$2"; shift 2
  : > "$TMP/mutations"
  ( cd "$TMP/repo" && PATH="$TMP/bin:$PATH" GH_LABELS="$labels" GH_FAIL="$fail" GH_SWEEP_REMAINING="${GH_SWEEP_REMAINING:-5000}" GH_PROJ_TITLE="${GH_PROJ_TITLE:-}" "$ROOT/bin/board.sh" "$@" ) >/dev/null 2>&1
  echo "$?"
}
muts() { cat "$TMP/mutations" 2>/dev/null; }

# A: status with a p2 label -> exit 0, BOTH Status and Priority written.
rc="$(run p2 "" status 42 "In review")"
check "status: exit 0" "0" "$rc"
check "status: Priority set to P1 (from p2)" "1" "$(muts | grep -c 'f=PFID -f o=P1OPT')"
check "status: Status set to SOPT"           "1" "$(muts | grep -c 'f=SFID -f o=SOPT')"

# B: add with a p1 label -> exit 0, ONLY Priority written (add never sets Status).
rc="$(run p1 "" add 42)"
check "add: exit 0" "0" "$rc"
check "add: Priority set to P0 (from p1)" "1" "$(muts | grep -c 'f=PFID -f o=P0OPT')"
check "add: no Status mutation on add"    "0" "$(muts | grep -c 'f=SFID')"

# C: no p-label -> no Priority mutation at all (field left untouched).
rc="$(run bug "" add 42)"
check "no p-label: exit 0" "0" "$rc"
check "no p-label: zero mutations" "0" "$(muts | grep -c 'SET')"

# D: gh totally failing -> still exit 0 (best-effort never blocks engineering).
rc="$(run p2 1 status 42 "In review")"
check "gh failure: still exit 0" "0" "$rc"
check "gh failure: no mutation recorded" "0" "$(muts | grep -c 'SET')"

# E: an invalid board.owner is rejected at the point of use (prevention-log 6)
# -> exit 0, gh never called for a resolve/mutation.
printf 'board:\n  owner: "-rf; evil"\n  project_title: Autonomy Progress\n' > "$TMP/repo/.autonomy/config.yaml"
rc="$(run p2 "" status 42 "In review")"
check "invalid owner: still exit 0" "0" "$rc"
check "invalid owner: no mutation recorded" "0" "$(muts | grep -c 'SET')"
printf 'board:\n  owner: Luke-Bradford\n  project_title: Autonomy Progress\n' > "$TMP/repo/.autonomy/config.yaml"

# G: #252 sweep -- moves ONLY the closed non-Done item to Done. Runs with NO
# <issue#> arg (decomposed before the issue-required usage check).
rc="$(run p2 "" sweep)"
check "sweep: exit 0" "0" "$rc"
check "sweep: one mutation recorded (only the stale closed item)" "1" "$(muts | grep -c 'SET')"
check "sweep: mutates SWEEP_ITEM" "1" "$(muts | grep -c 'i=SWEEP_ITEM')"
check "sweep: sets it to the Done option" "1" "$(muts | grep -c 'o=DONEOPT')"
check "sweep: does NOT touch the already-Done item" "0" "$(muts | grep -c 'i=DONE_ITEM')"
check "sweep: does NOT touch the OPEN item" "0" "$(muts | grep -c 'i=OPEN_ITEM')"

# H: rate-limit low (remaining < floor) -> skip the mutation batch, still exit 0.
rc="$(GH_SWEEP_REMAINING=50 run p2 "" sweep)"
check "sweep rate-limit-low: exit 0" "0" "$rc"
check "sweep rate-limit-low: zero mutations" "0" "$(muts | grep -c 'SET')"

# I: gh totally failing during sweep -> exit 0, no mutation (best-effort).
rc="$(run p2 1 sweep)"
check "sweep gh-failure: exit 0" "0" "$rc"
check "sweep gh-failure: zero mutations" "0" "$(muts | grep -c 'SET')"

# J: an unknown command must NOT mutate the board on its way to the usage warn
# (validated before any resolve/issue-view/add/priority side effect).
rc="$(run p2 "" frobnicate 42 "In review")"
check "unknown command: exit 0" "0" "$rc"
check "unknown command: zero mutations (no side effects)" "0" "$(muts | grep -c 'SET')"

# --- #90 item (a): board-unresolved marker (detector->marker->chip) ---------
# board.sh persists its own resolution verdict to var/autonomy-logs/
# board-warning (2 lines: epoch, message) so the dashboard can surface it;
# a successful resolution removes it. Best-effort throughout (exit 0 always).
MARKER="$TMP/repo/var/autonomy-logs/board-warning"

# M1: resolution fails (title mismatch) -> marker written, exit still 0.
rc="$(GH_PROJ_TITLE="Some Other Board" run p2 "" status 42 "In review")"
check "marker: not-found status exits 0" "0" "$rc"
check "marker: written on not-found" "1" "$([ -f "$MARKER" ] && echo 1 || echo 0)"
check "marker: line1 is an epoch" "1" "$(sed -n 1p "$MARKER" | grep -cE '^[0-9]+$')"
check "marker: message names the board" "1" "$(sed -n 2p "$MARKER" | grep -c "Autonomy Progress")"

# M2: next successful resolution clears it.
rc="$(GH_PROJ_TITLE="" run p2 "" status 42 "In review")"
check "marker: cleared on success" "0" "$([ -f "$MARKER" ] && echo 1 || echo 0)"

# M3: total gh failure -> marker written (indistinguishable from not-found at
# the resolver's caller; message hedges with "or lookup failed").
rc="$(run p2 1 status 42 "In review")"
check "marker: gh-fail exits 0" "0" "$rc"
check "marker: written on gh failure" "1" "$([ -f "$MARKER" ] && echo 1 || echo 0)"
check "marker: message hedges lookup" "1" "$(sed -n 2p "$MARKER" | grep -c "lookup failed")"

# M4: sweep resolution failure writes it too; sweep success clears it.
rc="$(GH_PROJ_TITLE="Some Other Board" run p2 "" sweep)"
check "marker: sweep not-found exits 0" "0" "$rc"
check "marker: written by sweep" "1" "$([ -f "$MARKER" ] && echo 1 || echo 0)"
rc="$(GH_PROJ_TITLE="" run p2 "" sweep)"
check "marker: cleared by sweep success" "0" "$([ -f "$MARKER" ] && echo 1 || echo 0)"

# M5: status option not a board column -> marker written (board exists but
# lacks the wanted column: a real board-contract misconfig).
rc="$(run p2 "" status 42 "Bogus Column")"
check "marker: bad-column exits 0" "0" "$rc"
check "marker: written on missing column" "1" "$([ -f "$MARKER" ] && echo 1 || echo 0)"
check "marker: message names the column" "1" "$(sed -n 2p "$MARKER" | grep -c "Bogus Column")"
rc="$(run p2 "" status 42 "In review")"
check "marker: cleared by valid status" "0" "$([ -f "$MARKER" ] && echo 1 || echo 0)"

# M6: title set but owner MISSING -> misconfig, marker written (must NOT read
# as board-off-by-design; only an empty TITLE is the SD-31 off switch).
printf 'board:\n  project_title: Autonomy Progress\n' > "$TMP/repo/.autonomy/config.yaml"
rc="$(run p2 "" status 42 "In review")"
check "marker: missing-owner exits 0" "0" "$rc"
check "marker: written on missing owner" "1" "$([ -f "$MARKER" ] && echo 1 || echo 0)"

# M7: owner fails the login grammar -> marker written.
printf 'board:\n  owner: bad_owner\n  project_title: Autonomy Progress\n' > "$TMP/repo/.autonomy/config.yaml"
rc="$(run p2 "" status 42 "In review")"
check "marker: invalid-owner exits 0" "0" "$rc"
check "marker: written on invalid owner" "1" "$([ -f "$MARKER" ] && echo 1 || echo 0)"

# M8: empty title = board off by design (SD-31) -> stale marker CLEARED, no
# false alarm. (Marker still present from M7.)
printf 'board:\n  owner: Luke-Bradford\n  project_title: ""\n' > "$TMP/repo/.autonomy/config.yaml"
rc="$(run p2 "" status 42 "In review")"
check "marker: empty-title exits 0" "0" "$rc"
check "marker: cleared when board off" "0" "$([ -f "$MARKER" ] && echo 1 || echo 0)"
printf 'board:\n  owner: Luke-Bradford\n  project_title: Autonomy Progress\n' > "$TMP/repo/.autonomy/config.yaml"

# F: #211 overlay-aware read seam. Source the real board.sh (its guard makes a
# `source` define functions only) and exercise config_value_with_overlay
# directly: a config-page 'save default' lands in the untracked
# var/autonomy-logs/config-overrides overlay and must SHADOW the committed
# config.yaml so the setting doesn't silently revert (#202/#211). No mocks --
# real config_parser reads a real config.yaml + a real overlay file on disk.
# shellcheck source=/dev/null
. "$ROOT/bin/board.sh"
UT="$(mktemp -d)"
mkdir -p "$UT/.autonomy" "$UT/var/autonomy-logs"
printf 'board:\n  owner: committed-owner\n  project_title: Committed Board\n' > "$UT/.autonomy/config.yaml"
cd "$UT" || exit 1
# No overlay -> falls back to the committed config.yaml value.
check "overlay absent: owner from config"  committed-owner   "$(config_value_with_overlay board.owner board_owner)"
check "overlay absent: title from config"  "Committed Board" "$(config_value_with_overlay board.project_title board_project_title)"
# Overlay present -> shadows config.yaml (the #211 fix).
printf 'board_owner=overlay-org\nboard_project_title=Overlay Board\n' > var/autonomy-logs/config-overrides
check "overlay shadows config owner"  overlay-org     "$(config_value_with_overlay board.owner board_owner)"
check "overlay shadows config title"  "Overlay Board" "$(config_value_with_overlay board.project_title board_project_title)"
# Overlay key present but empty -> treat as unset, fall back to config (never
# blank out a committed value with an empty override).
printf 'board_owner=\n' > var/autonomy-logs/config-overrides
check "overlay empty value: config fallback"  committed-owner  "$(config_value_with_overlay board.owner board_owner)"
cd "$ROOT" || exit 1
rm -rf "$UT"

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails CHECK(S) FAILED"; exit 1; fi
