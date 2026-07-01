#!/usr/bin/env bash
# .autonomy/qa/decide.sh -- the QA merge-gate's decision logic (#13).
# Scaffolded into the target repo by onboard.sh and sourced by the
# qa-merge-gate GitHub Actions workflow (and by the engine's tests).
#
# Contract (macOS bash 3.2 compatible; `gh` is the only external tool):
#   qa_join_ready <pr>          rc 0 + prints head SHA when the PR is APPROVED
#                               and every check EXCEPT our own qa-gate context
#                               is green on the current head. Any `gh` failure
#                               is a refusal -- never assumed green (fail-safe,
#                               same invariant as safe_merge's ci_check).
#   qa_should_merge <strategy> <completes_merge>
#                               rc 0 only when completes_merge is exactly
#                               "true" AND merge_gate.strategy is not manual/
#                               empty. `manual` NEVER auto-merges -- the QA
#                               verdict is advisory there.
#   qa_extract_verdict <file>   prints pass|fail from the LAST "QA-VERDICT:"
#                               line of a QA run transcript; no line -> fail.
#   qa_post_verdict <sha> <state> <desc> <owner/repo>
#                               posts the verdict as a commit status (context
#                               qa-gate) on exactly that sha.
#   qa_complete_merge <pr>      squash-merges via gh.

QA_CONTEXT="qa-gate"

qa_join_ready() {
  local pr="$1"
  local info decision sha
  if ! info="$(gh pr view "$pr" --json reviewDecision,headRefOid \
               -q '.reviewDecision + " " + .headRefOid' 2>/dev/null)"; then
    echo "qa_gate: REFUSE -- cannot read PR #$pr state (gh failed)" >&2
    return 1
  fi
  read -r decision sha <<<"$info"
  if [ "$decision" != "APPROVED" ]; then
    echo "qa_gate: not ready -- review decision is '${decision:-none}'" >&2
    return 1
  fi
  local checks_json
  if ! checks_json="$(gh pr checks "$pr" --json name,state 2>/dev/null)"; then
    echo "qa_gate: REFUSE -- cannot verify CI state (gh failed) -- refusing rather than assuming green" >&2
    return 1
  fi
  # our own qa-gate check is always pending at this point -- exclude it
  checks_json="$(printf '%s' "$checks_json" | python3 -c '
import json, sys
checks = json.load(sys.stdin)
print(json.dumps([c for c in checks if c.get("name") != "'"$QA_CONTEXT"'"]))')"
  if printf '%s' "$checks_json" | grep -qiE '"state":[[:space:]]*"(fail|failure|error|cancelled|timed_out)"'; then
    echo "qa_gate: not ready -- a CI check is failing on #$pr" >&2
    return 1
  fi
  if printf '%s' "$checks_json" | grep -qiE '"state":[[:space:]]*"(pending|queued|in_progress|expected)"'; then
    echo "qa_gate: not ready -- CI still running on #$pr" >&2
    return 1
  fi
  printf '%s\n' "$sha"
  return 0
}

qa_should_merge() {
  local strategy="$1" completes_merge="$2"
  [ "$completes_merge" = "true" ] || return 1
  case "$strategy" in
    ''|manual) return 1 ;;   # manual (and unset->manual) NEVER auto-merges
    *) return 0 ;;
  esac
}

qa_extract_verdict() {
  local transcript="$1" verdict
  verdict="$(grep -E '^QA-VERDICT:' "$transcript" 2>/dev/null | tail -1 \
             | sed 's/^QA-VERDICT:[[:space:]]*//')"
  case "$verdict" in
    pass) echo pass ;;
    *) echo fail ;;          # absent/garbled verdict is a FAIL (fail-safe)
  esac
}

qa_post_verdict() {
  local sha="$1" state="$2" desc="$3" repo="$4"
  gh api "repos/$repo/statuses/$sha" \
    -f state="$state" -f context="$QA_CONTEXT" -f description="$desc" >/dev/null
}

qa_complete_merge() {
  local pr="$1"
  gh pr merge "$pr" --squash
}
