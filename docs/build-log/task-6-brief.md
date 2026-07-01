### Task 6: `safe_merge.sh` — generic merge gate (4 strategies)

**Files:**
- Create: `bin/safe_merge.sh`
- Test: `tests/test_safe_merge_doc_only.sh`
- Test: `tests/test_merge_gate_strategies.sh`

**Interfaces:**
- Consumes: `python3 lib/config_parser.py` (Task 2); `bin/unblock_dependents.sh` (Task 7 — called at
  the end of a successful merge; write this task assuming it exists, land Task 7 immediately after).
- Produces: CLI `bin/safe_merge.sh <pr-number>` (run from the target repo checkout) — the only
  merge path the loop is allowed to use. Also defines `is_doc_only(files, extensions_csv)` and
  `ci_check(pr, strategy)` as testable functions.

- [ ] **Step 1: Write the failing tests**

```bash
# tests/test_safe_merge_doc_only.sh
#!/usr/bin/env bash
# Unit test for safe_merge.sh::is_doc_only(), parameterized by extension list.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$HERE/../bin/safe_merge.sh"

fails=0
check() {
  local want="$1" desc="$2" files="$3" exts="$4" got
  if is_doc_only "$files" "$exts"; then got=doc; else got=strict; fi
  if [ "$got" = "$want" ]; then echo "ok   - $desc"; else
    echo "FAIL - $desc (expected '$want', got '$got')"; fails=$((fails + 1)); fi
}

check doc    "single .md"                      "docs/a.md"                            ".md"
check doc    "multiple .md"                     $'docs/a.md\ndocs/b.md'                 ".md"
check doc    "nested .md paths"                 $'README.md\ndocs/specs/ui/x.md'        ".md"
check strict "one code file among md disqualifies" $'docs/a.md\napp/x.py'               ".md"
check strict "code file alone"                  "app/services/scoring.py"               ".md"
check strict "favicon PR (svg + html)"          $'frontend/index.html\nfrontend/public/favicon.svg' ".md"
check strict "empty diff"                       ""                                      ".md"
check strict ".md as a directory, not extension" "docs/readme.md/thing.py"              ".md"
check strict "non-md extension that contains md" "docs/x.mdx"                           ".md"
check strict ".rst not in configured list"       "docs/a.rst"                            ".md"
check doc    ".rst IS in configured list"        "docs/a.rst"                            ".md,.rst"

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails FAILED"; exit 1; fi
```

```bash
# tests/test_merge_gate_strategies.sh
#!/usr/bin/env bash
# Unit tests for safe_merge.sh's ci_check -- the fail-safe fix (Codex finding:
# a gh API failure must never look identical to "green").
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$HERE/../bin/safe_merge.sh"

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails + 1)); fi
}

MOCK_CHECKS_JSON=""
gh() {
  if [ "$1" = "pr" ] && [ "$2" = "checks" ]; then
    if [ "$MOCK_CHECKS_JSON" = "__FAIL__" ]; then return 1; fi
    echo "$MOCK_CHECKS_JSON"
    return 0
  fi
  echo "unmocked gh call: $*" >&2
  return 1
}

MOCK_CHECKS_JSON='[{"name":"lint","state":"SUCCESS"}]'
check "all green -> ci_check passes" "0" "$(ci_check 1 bot_comment >/dev/null 2>&1; echo $?)"

MOCK_CHECKS_JSON='[{"name":"lint","state":"FAILURE"}]'
check "a failing check -> refuse" "1" "$(ci_check 1 bot_comment >/dev/null 2>&1; echo $?)"

MOCK_CHECKS_JSON='[{"name":"lint","state":"PENDING"}]'
check "a pending check -> refuse" "1" "$(ci_check 1 bot_comment >/dev/null 2>&1; echo $?)"

MOCK_CHECKS_JSON='[]'
check "zero checks, ci_only -> refuse" "1" "$(ci_check 1 ci_only >/dev/null 2>&1; echo $?)"
check "zero checks, bot_comment -> pass (approval is the real gate)" "0" "$(ci_check 1 bot_comment >/dev/null 2>&1; echo $?)"

MOCK_CHECKS_JSON="__FAIL__"
check "gh call itself fails -> refuse, not silently green" "1" "$(ci_check 1 ci_only >/dev/null 2>&1; echo $?)"

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails FAILED"; exit 1; fi
```

- [ ] **Step 2: Run both to verify they fail**

```bash
chmod +x tests/test_safe_merge_doc_only.sh tests/test_merge_gate_strategies.sh
bash tests/test_safe_merge_doc_only.sh
bash tests/test_merge_gate_strategies.sh
```
Expected: both fail (`bin/safe_merge.sh` doesn't exist yet).

- [ ] **Step 3: Implement `bin/safe_merge.sh`**

```bash
#!/usr/bin/env bash
# bin/safe_merge.sh -- generic mechanical merge gate. Refuses to merge unless
# the target repo's .autonomy/config.yaml merge_gate.strategy is satisfied on
# the PR's LATEST commit. Run FROM the target repo checkout.
#
# Usage: safe_merge.sh <pr-number>
set -euo pipefail
SAFE_MERGE_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Doc-only predicate, parameterized by the strategy's configured extension
# list (comma-separated, e.g. ".md,.rst"). Pure string logic, unit-tested.
is_doc_only() {
  local files="$1" extensions_csv="$2"
  [ -n "$files" ] || return 1
  local ext pattern="" IFS=','
  read -ra exts <<<"$extensions_csv"
  for ext in "${exts[@]}"; do
    ext="$(printf '%s' "$ext" | sed 's/^\.//')"
    if [ -n "$pattern" ]; then pattern="$pattern|"; fi
    pattern="${pattern}\\.${ext}\$"
  done
  ! printf '%s\n' "$files" | grep -qvE "$pattern"
}

# CI check, generalized (Codex finding: a `gh` API failure must never look
# identical to "green"). Returns 0 = green, 1 = refuse.
ci_check() {
  local pr="$1" strategy="$2"
  local checks_json
  if ! checks_json="$(gh pr checks "$pr" --json name,state 2>/dev/null)"; then
    echo "safe_merge: REFUSE -- cannot verify CI state (gh pr checks failed) -- refusing rather than assuming green" >&2
    return 1
  fi
  if echo "$checks_json" | grep -qiE '"state":"(fail|failure|error|cancelled|timed_out)"'; then
    echo "safe_merge: REFUSE -- a CI check failed on #$pr" >&2
    return 1
  fi
  if echo "$checks_json" | grep -qiE '"state":"(pending|queued|in_progress)"'; then
    echo "safe_merge: REFUSE -- CI still running on #$pr (re-check later)" >&2
    return 1
  fi
  if [ "$strategy" = "ci_only" ] && [ "$checks_json" = "[]" ]; then
    echo "safe_merge: REFUSE -- ci_only requires at least one configured check; use manual for a repo with no CI, or add one" >&2
    return 1
  fi
  return 0
}

merge_gate_bot_comment() {
  local pr="$1" author_login="$2" marker="$3" doc_only_extensions="$4"
  local head_time; head_time="$(gh pr view "$pr" --json commits -q '.commits[-1].committedDate')"
  [ -n "$head_time" ] || { echo "safe_merge: cannot resolve PR #$pr head commit time" >&2; return 1; }

  local files n_listed n_changed
  files="$(gh api --paginate "repos/{owner}/{repo}/pulls/$pr/files" --jq '.[].filename')"
  n_listed="$(printf '%s\n' "$files" | grep -c . || true)"
  n_changed="$(gh pr view "$pr" --json changedFiles -q '.changedFiles')"
  if [ "$n_listed" = "$n_changed" ] && is_doc_only "$files" "$doc_only_extensions"; then
    local doc_block
    doc_block="$(gh pr view "$pr" --json comments -q \
      "[.comments[] | select(.author.login==\"$author_login\" and (.body|contains(\"$marker\")))]
       | sort_by(.createdAt) | last | .body // \"\"")"
    if printf '%s' "$doc_block" | grep -qiE 'REQUEST CHANGES|\[BLOCKING\]|must fix before merge'; then
      echo "safe_merge: REFUSE -- doc-only PR #$pr but latest bot comment blocks" >&2
      return 1
    fi
    echo "safe_merge: doc-only PR #$pr (every changed file matches doc_only_extensions), CI green, no blocking comment -- merging."
    return 0
  fi

  local latest
  latest="$(gh pr view "$pr" --json comments -q \
    "[.comments[] | select(.author.login==\"$author_login\" and (.body|contains(\"$marker\")))]
     | sort_by(.createdAt) | last")"
  [ -n "$latest" ] && [ "$latest" != "null" ] || {
    echo "safe_merge: REFUSE -- no review comment from $author_login on #$pr yet" >&2; return 1; }
  local review_time review_body
  review_time="$(printf '%s' "$latest" | python3 -c 'import sys,json;print(json.load(sys.stdin)["createdAt"])')"
  review_body="$(printf '%s' "$latest" | python3 -c 'import sys,json;print(json.load(sys.stdin)["body"])')"

  if [[ "$review_time" < "$head_time" ]]; then
    echo "safe_merge: REFUSE -- latest review ($review_time) predates head commit ($head_time); push reset the gate" >&2
    return 1
  fi
  if printf '%s' "$review_body" | grep -qiE 'REQUEST CHANGES|\[BLOCKING\]|must fix before merge'; then
    echo "safe_merge: REFUSE -- latest review requests changes / has blocking findings" >&2
    return 1
  fi
  if ! printf '%s' "$review_body" | grep -qiE 'APPROVE'; then
    echo "safe_merge: REFUSE -- latest review is not an APPROVE" >&2
    return 1
  fi
  echo "safe_merge: gates pass on #$pr (review $review_time >= head $head_time) -- merging."
  return 0
}

merge_gate_gh_review() {
  local pr="$1" reviewer_login="$2"
  [ -n "$reviewer_login" ] || { echo "safe_merge: REFUSE -- merge_gate.strategy=gh_review but reviewer_login is not set in config.yaml" >&2; return 1; }
  local head_time; head_time="$(gh pr view "$pr" --json commits -q '.commits[-1].committedDate')"
  [ -n "$head_time" ] || { echo "safe_merge: cannot resolve PR #$pr head commit time" >&2; return 1; }

  local latest
  latest="$(gh pr view "$pr" --json reviews -q \
    "[.reviews[] | select(.author.login==\"$reviewer_login\")] | sort_by(.submittedAt) | last")"
  [ -n "$latest" ] && [ "$latest" != "null" ] || {
    echo "safe_merge: REFUSE -- no review from $reviewer_login on #$pr yet" >&2; return 1; }
  local review_time review_state
  review_time="$(printf '%s' "$latest" | python3 -c 'import sys,json;print(json.load(sys.stdin)["submittedAt"])')"
  review_state="$(printf '%s' "$latest" | python3 -c 'import sys,json;print(json.load(sys.stdin)["state"])')"

  if [[ "$review_time" < "$head_time" ]]; then
    echo "safe_merge: REFUSE -- latest review from $reviewer_login ($review_time) predates head commit ($head_time)" >&2
    return 1
  fi
  if [ "$review_state" != "APPROVED" ]; then
    echo "safe_merge: REFUSE -- latest review from $reviewer_login is '$review_state', not APPROVED" >&2
    return 1
  fi
  echo "safe_merge: gates pass on #$pr ($reviewer_login APPROVED at $review_time >= head $head_time) -- merging."
  return 0
}

[ "${BASH_SOURCE[0]}" = "${0}" ] || return 0

PR="${1:?usage: safe_merge.sh <pr-number>}"
CONFIG_GET() { python3 "$SAFE_MERGE_HOME/lib/config_parser.py" .autonomy/config.yaml "$1" 2>/dev/null; }

STRATEGY="$(CONFIG_GET merge_gate.strategy)"; STRATEGY="${STRATEGY:-manual}"

if [ "$STRATEGY" = "manual" ]; then
  echo "safe_merge: manual-mode -- PR #$PR left open for the operator to review/merge."
  exit 0
fi

ci_check "$PR" "$STRATEGY" || exit 1

case "$STRATEGY" in
  ci_only)
    echo "safe_merge: CI green, ci_only strategy -- merging #$PR."
    ;;
  bot_comment)
    author_login="$(CONFIG_GET merge_gate.author_login)"; author_login="${author_login:-github-actions}"
    marker="$(CONFIG_GET merge_gate.marker)"; marker="${marker:-Claude Code Review}"
    doc_only_extensions="$(CONFIG_GET merge_gate.doc_only_extensions | paste -sd, -)"; doc_only_extensions="${doc_only_extensions:-.md}"
    merge_gate_bot_comment "$PR" "$author_login" "$marker" "$doc_only_extensions" || exit 1
    ;;
  gh_review)
    reviewer_login="$(CONFIG_GET merge_gate.reviewer_login)"
    merge_gate_gh_review "$PR" "$reviewer_login" || exit 1
    ;;
  *)
    echo "safe_merge: REFUSE -- unknown merge_gate.strategy '$STRATEGY' in config.yaml" >&2
    exit 1
    ;;
esac

gh pr merge "$PR" --squash --delete-branch
"$SAFE_MERGE_HOME/bin/unblock_dependents.sh" "$PR" || true
```

- [ ] **Step 4: Run both tests to verify they pass**

```bash
bash tests/test_safe_merge_doc_only.sh
bash tests/test_merge_gate_strategies.sh
```
Expected: both `ALL PASS`.

**Note:** `merge_gate_bot_comment` and `merge_gate_gh_review` (the multi-`gh`-call strategy bodies)
are deliberately NOT unit-tested end-to-end here — mocking their full multi-call `gh` sequences adds
disproportionate bash-test-harness complexity for the value versus the two functions already
covered (`is_doc_only`, `ci_check`, which carry the actual new/changed logic this spec introduces).
The `bot_comment` path (eBull's real, already-proven mechanism) is validated by Task 13's acceptance
run against a real eBull PR; `gh_review` isn't exercised against any real repo in this spec.

- [ ] **Step 5: shellcheck**

```bash
shellcheck -S warning bin/safe_merge.sh
```
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add bin/safe_merge.sh tests/test_safe_merge_doc_only.sh tests/test_merge_gate_strategies.sh
git commit -m "feat: add generic safe_merge.sh with 4 merge-gate strategies"
git push
```

---

