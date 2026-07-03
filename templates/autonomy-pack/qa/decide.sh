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
  # our own qa-gate check is always pending at this point -- exclude it.
  # Guard the substitution: a python-filter failure (missing python, gh
  # output-shape change) or empty output is an unverifiable CI state -- refuse
  # rather than let an empty checks_json fall through to green below. Same
  # fail-safe invariant as the gh-failure branch above (prevention-log #2/#3).
  local filtered
  if ! filtered="$(printf '%s' "$checks_json" | python3 -c '
import json, sys
checks = json.load(sys.stdin)
print(json.dumps([c for c in checks if c.get("name") != "'"$QA_CONTEXT"'"]))')" \
     || [ -z "$filtered" ]; then
    echo "qa_gate: REFUSE -- cannot filter CI state (python filter failed/empty) -- refusing rather than assuming green" >&2
    return 1
  fi
  checks_json="$filtered"
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
  # WHITELIST of merge-permitting strategies -- anything else (manual, empty,
  # a garbled scrape) refuses. Fail-safe: unknown never means merge.
  case "$strategy" in
    ci_only|bot_comment|gh_review) return 0 ;;
    *) return 1 ;;
  esac
}

qa_role_field() {
  # Extract a scalar under roles.qa from the pack config (#123). Comment-safe
  # and scoped to the TOP-LEVEL `roles:` block then the `qa:` sub-block: a
  # commented-out `#gate:` line, a trailing `# ...` comment, or a `qa:` block
  # nested under some OTHER top-level namespace can NEVER be mis-read as the
  # live knob -- any of those would fail OPEN on the merge gate. No match (or an
  # unreadable file) yields empty, which every consumer treats as refuse.
  local config="$1" key="$2"
  # LAST-WINS, mirroring the engine's config_parser on duplicate keys (a later
  # `roles:` block REPLACES an earlier one; a later duplicate key overrides): we
  # clear on each `roles:` entry and keep the last direct-child match, printing
  # at END -- so a malformed duplicate-key config can never make an earlier
  # `auto-merge-on-pass` outlive the effective (last) value.
  awk -v key="$key" '
    /^[^[:space:]#]/ { inroles=0; inqa=0 }               # any top-level key resets scope
    $0 ~ /^roles:[[:space:]]*(#.*)?$/ { inroles=1; val=""; next } # a new roles: replaces prior
    inroles && /^  [A-Za-z_][A-Za-z0-9_]*:/ {            # a 2-space role key
      inqa = ($0 ~ /^  qa:[[:space:]]*(#.*)?$/) ? 1 : 0  # only the qa: sub-block
      qaind = -1; next                                   # (re)arm direct-child indent
    }
    inqa {
      if ($0 ~ /^[[:space:]]*(#.*)?$/) next              # ignore blank / comment-only
      s = $0; sub(/[^ ].*$/, "", s); ind = length(s)     # count leading SPACES (YAML)
      if (qaind < 0) qaind = ind                         # first direct child fixes the level
      if (ind != qaind) next                             # deeper key is NOT roles.qa.<key>
      if ($0 ~ ("^[[:space:]]+" key ":")) {              # the direct, uncommented scalar
        line=$0; sub(/#.*/, "", line)                    # strip a trailing comment
        sub("^[[:space:]]+" key ":[[:space:]]*", "", line)
        gsub(/[[:space:]]+$/, "", line)                  # strip trailing space
        val=line                                         # last match wins
      }
    }
    END { if (length(val)) print val }
  ' "$config" 2>/dev/null
  return 0                                               # fail-safe: never propagate awk's rc
}

qa_gate_allows_merge() {
  # The role's `gate` knob (#123) layered ON TOP of qa_should_merge. WHITELIST:
  # `auto-merge-on-pass` is the ONLY value that can auto-merge -- every other
  # state (`wait-for-human`, an absent knob, an unknown value, or a garbled
  # config scrape that comes through empty) is treated as `wait-for-human` and
  # refuses. Fail-safe, never fail-open: a mis-scrape can never silently enable
  # an auto-merge, and the knob never bypasses the merge authority -- an
  # `auto-merge-on-pass` still has to satisfy qa_should_merge (a merge-permitting
  # strategy + completes_merge=true).
  local gate="$1" strategy="$2" completes_merge="$3"
  case "$gate" in
    auto-merge-on-pass) qa_should_merge "$strategy" "$completes_merge" ;;
    *) return 1 ;;
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
