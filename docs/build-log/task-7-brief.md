### Task 7: `unblock_dependents.sh` — verbatim port

**Files:**
- Create: `bin/unblock_dependents.sh`
- Test: `tests/test_unblock_dependents.sh`

**Interfaces:**
- Consumes: nothing (pure `gh`-driven script, already fully repo-agnostic today).
- Produces: CLI `bin/unblock_dependents.sh <merged-pr-number>` — called by `safe_merge.sh` (Task 6)
  after every successful merge. Defines `blocker_clauses_of`, `confirms_block`, `extract_blockers`
  as testable pure functions.

- [ ] **Step 1: Write the failing test (ported verbatim from eBull's `test_unblock_dependents.sh`)**

```bash
# tests/test_unblock_dependents.sh
#!/usr/bin/env bash
# Unit test for unblock_dependents.sh pure matchers. Sources the REAL script
# (its gh-driven body is guarded by a BASH_SOURCE==$0 check, so sourcing only
# defines the helpers) and table-tests the regexes that decide whether a
# ticket is "blocked by #X" and which other blockers remain. No gh, no network.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$HERE/../bin/unblock_dependents.sh"

fails=0
judge() {
  if [ "$1" = "$2" ]; then echo "ok   - $3"; else
    echo "FAIL - $3 (expected '$2', got '$1')"; fails=$((fails + 1)); fi
}

B1822='Part of #1815. **Blocked by** #1820 (P0 foundation) + P2 analytics -- the signals must be computed and stored before they can be backtested.'
B1815=$'> | P2 -- new signals | #1823 | blocked by #1820 |\n> | P5a -- backtest harness | #1822 | blocked by #1820 + #1823 |'

check_confirm() {
  local want="$1" desc="$2" body="$3" x="$4" got
  if confirms_block "$body" "$x"; then got=yes; else got=no; fi
  judge "$got" "$want" "$desc"
}

check_confirm yes "plain blocked by"            "Blocked by #1820"                       1820
check_confirm yes "markdown-bold blocked by"    "Part of #1815. **Blocked by** #1820 (P0)" 1820
check_confirm yes "hyphenated blocked-by"       "blocked-by #843"                         843
check_confirm yes "trailing punctuation"        "Blocked by #1820."                       1820
check_confirm yes "one of several blockers"     "Blocked by #1820 and #1823"              1823
check_confirm no  "prefix-digit must not match" "Blocked by #1820"                        182
check_confirm no  "suffix-digit must not match" "Blocked by #182"                         1820
check_confirm no  "mention outside blocked line" $'Implements #1820\nsee notes'           1820
check_confirm no  "no blocked-by line at all"    "Part of #1815. Closes #1820."           1820
check_confirm no  "parent (Part of #X) not a block"  "$B1822"                             1815
check_confirm yes "real blocker after the phrase"    "$B1822"                             1820
check_confirm no  "UPPERCASE: parent not a block"    "Part of #1815. **BLOCKED BY** #1820" 1815
check_confirm yes "UPPERCASE: real blocker"          "Part of #1815. **BLOCKED BY** #1820" 1820
check_confirm no  "table row-subject (only) not a block" "| P2 | #1823 | blocked by #1820 |" 1823
check_confirm yes "#1815: #1823 is a real P5a blocker"   "$B1815"                            1823
check_confirm yes "#1815 table: #1820 blocks every row"  "$B1815"                            1820

check_extract() {
  local want="$1" desc="$2" body="$3" got
  got="$(extract_blockers "$body" | tr '\n' ' ' | sed 's/ *$//')"
  judge "$got" "$want" "$desc"
}

check_extract "1820"      "single blocker"            "Blocked by #1820 (P0 foundation)"
check_extract "1820 1823" "two blockers, sorted"      "Blocked by #1823 and #1820"
check_extract "843"       "ignores non-blocked refs"  $'Part of #1815. Closes #999.\nBlocked by #843'
check_extract ""          "no blocked-by line"        "Part of #1815. Closes #1820."
check_extract "1820"      "#1822: parent #1815 excluded" "$B1822"
check_extract "1820 1823" "#1815 P5a: subject excluded"  "$B1815"
check_extract "1820"      "UPPERCASE: parent excluded"   "Part of #1815. **BLOCKED BY** #1820"

if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails FAILED"; exit 1; fi
```

- [ ] **Step 2: Run to verify it fails**

```bash
chmod +x tests/test_unblock_dependents.sh
bash tests/test_unblock_dependents.sh
```
Expected: fails (`bin/unblock_dependents.sh` doesn't exist yet).

- [ ] **Step 3: Implement `bin/unblock_dependents.sh`** (verbatim port of eBull's
  `scripts/autonomy/unblock_dependents.sh` — already fully repo-agnostic, no changes needed beyond
  its new location)

```bash
#!/usr/bin/env bash
# bin/unblock_dependents.sh -- post-merge dependent notifier.
#
# When a PR merges and closes issue #X, any open ticket whose body says
# "Blocked by #X" is surfaced here. DELIBERATELY NOTIFY-ONLY -- it does NOT
# move board cards or edit issue bodies (a full-population scan falsified the
# naive "strip the block line + move to Todo" approach: some issues match the
# phrase yet are not actually unblocked, e.g. a parent-issue table listing).
#
# BEST-EFFORT BY DESIGN: this runs AFTER the merge already happened (called
# from safe_merge.sh). It must NEVER fail the caller -- every path warns to
# stderr and exits 0.
#
# Usage:  bin/unblock_dependents.sh <merged-pr-number>
set -uo pipefail

warn() { echo "unblock_dependents: $*" >&2; }

blocker_clauses_of() {
  printf '%s\n' "$1" | grep -iE 'blocked[ -]by' \
    | tr '[:upper:]' '[:lower:]' | sed -E 's/^.*blocked[ -]by//'
}

confirms_block() { blocker_clauses_of "$1" | grep -E "#$2([^0-9]|$)" >/dev/null; }

extract_blockers() { blocker_clauses_of "$1" | grep -oE '#[0-9]+' | tr -d '#' | sort -u; }

[ "${BASH_SOURCE[0]}" = "${0}" ] || return 0

PR="${1:-}"
if [ -z "$PR" ]; then warn 'usage: unblock_dependents.sh <pr-number>'; exit 0; fi

REPO_SLUG="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
if [ -z "$REPO_SLUG" ]; then warn "cannot resolve repo slug (skip)"; exit 0; fi

closed="$(gh pr view "$PR" --json closingIssuesReferences \
  -q '.closingIssuesReferences[].number' 2>/dev/null || true)"
if [ -z "$closed" ]; then warn "PR #$PR closed no tracked issues (nothing to do)"; exit 0; fi

issue_is_open() {
  [ "$(gh issue view "$1" --json state -q .state 2>/dev/null || echo CLOSED)" = "OPEN" ]
}

for X in $closed; do
  candidates="$(gh search issues --repo "$REPO_SLUG" --state open "blocked by #$X" \
    --json number -q '.[].number' 2>/dev/null || true)"
  [ -n "$candidates" ] || continue

  for D in $candidates; do
    [ "$D" = "$X" ] && continue

    body="$(gh issue view "$D" --json body -q .body 2>/dev/null || true)"
    [ -n "$body" ] || continue

    confirms_block "$body" "$X" || continue

    marker="<!-- autonomy:unblock-notice blocker=#$X -->"
    if gh api --paginate "repos/{owner}/{repo}/issues/$D/comments" \
        --jq '.[].body' 2>/dev/null | grep -F "$marker" >/dev/null; then
      warn "#$D already notified for blocker #$X (skip)"
      continue
    fi

    others="$(extract_blockers "$body")"
    remaining=""
    for B in $others; do
      { [ "$B" = "$X" ] || [ "$B" = "$D" ]; } && continue
      if issue_is_open "$B"; then remaining="$remaining #$B"; fi
    done

    if [ -n "$remaining" ]; then
      status_line="Still blocked by:$remaining (open)."
    else
      status_line="No other issue-referenced blockers remain -- ready to move to **Todo** if nothing out-of-band blocks it (e.g. infra/decision not tracked by an issue)."
    fi

    comment="🔓 Blocker #$X merged (PR #$PR). $status_line

$marker"
    if gh issue comment "$D" --body "$comment" >/dev/null 2>&1; then
      echo "unblock_dependents: notified #$D (blocker #$X merged; $status_line)"
    else
      warn "failed to comment on #$D (skip)"
    fi
  done
done

exit 0
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bash tests/test_unblock_dependents.sh
```
Expected: `ALL PASS`.

- [ ] **Step 5: shellcheck**

```bash
shellcheck -S warning bin/unblock_dependents.sh
```
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add bin/unblock_dependents.sh tests/test_unblock_dependents.sh
git commit -m "feat: port unblock_dependents.sh verbatim (already repo-agnostic)"
git push
```

---

