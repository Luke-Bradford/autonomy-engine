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
