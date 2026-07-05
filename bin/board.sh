#!/usr/bin/env bash
# bin/board.sh -- generic GitHub Projects v2 board updater. Reads
# board.owner / board.project_title from the target repo's
# .autonomy/config.yaml. Uses the ambient `gh` auth (must carry the `project`
# scope) -- no PAT, no Action, no repo secret.
#
# Usage (run FROM the target repo checkout):
#   board.sh status <issue#> "<Status>"
#   board.sh add    <issue#>
#
# Also enriches the item's Priority single-select from the issue's p-label
# (#169, display-only per settled-decision D2) on both add and status.
#
# BEST-EFFORT BY DESIGN: board upkeep must NEVER block engineering work. Every
# failure path warns to stderr and exits 0.
set -uo pipefail
BOARD_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

warn() { echo "board.sh: $*" >&2; }

# Map the engine's p-label (settled-decision 23: p1>p2>p3, p1 highest) to the
# operator board's Priority single-select option (P0>P1>P2, P0 highest):
# p1->P0, p2->P1, p3->P2. Echoes "" when no p-label is present -- the field is
# then left untouched (never guess a priority). $1 = newline-separated labels;
# HIGHEST present p-label wins deterministically (not label order), so a stray
# extra p-label can never downgrade a real one.
plabel_to_priority() {
  local l has1="" has2="" has3=""
  while IFS= read -r l; do
    case "$l" in
      p1) has1=1 ;;
      p2) has2=1 ;;
      p3) has3=1 ;;
    esac
  done <<EOF
$1
EOF
  if [ -n "$has1" ]; then printf 'P0'
  elif [ -n "$has2" ]; then printf 'P1'
  elif [ -n "$has3" ]; then printf 'P2'
  fi
}

# Resolve a Projects v2 project + one of its single-select fields in one pass,
# trying a user-owned project first then an org-owned one (Codex strategic-fit
# finding -- today's eBull-only version assumed user()). Prints
# "<project_id> <field_id> <option_id>" (field_id/option_id empty when the
# field or the wanted option is absent) or nothing if no project with that
# title exists under either shape. field_name selects the single-select field
# (Status | Priority) so one copy of the fallback serves both (DRY).
#
# The query ENUMERATES `fields(first:100)` and filters by name in Python rather
# than `field(name:<n>)`: the latter returns a NOT_FOUND GraphQL error (gh rc=1)
# for projects that lack the field, poisoning the whole call. Enumeration is
# rc=0 and yields every single-select. So we do NOT gate on gh's rc -- a true
# total failure yields empty stdout, which Python turns into empty tokens and
# the body treats as "not found -> skip". option_id is non-empty ONLY when the
# field matched (fld.id non-empty), so the 3-token line never has an empty
# MIDDLE field -- safe under `read` word-splitting.
board_resolve_field() {
  local owner="$1" project_title="$2" field_name="$3" want_option="${4:-}"
  local meta ids
  meta="$(gh api graphql -f query='
    query($o:String!){ user(login:$o){ projectsV2(first:30){ nodes{
      id title
      fields(first:100){ nodes{ ... on ProjectV2SingleSelectField{ id name options{ id name } } } }
    }}}}' -f o="$owner" 2>/dev/null)"

  ids="$(PROJECT_TITLE="$project_title" FIELD="$field_name" WANT="$want_option" python3 - "$meta" <<'PY' 2>/dev/null
import sys, json, os
t = os.environ["PROJECT_TITLE"]; fname = os.environ["FIELD"]; want = os.environ.get("WANT", "")
try:
    d = json.loads(sys.argv[1])
except Exception:
    print(); sys.exit(0)
u = (d.get("data") or {}).get("user") or {}
nodes = (u.get("projectsV2") or {}).get("nodes") or []
proj = next((n for n in nodes if n and n.get("title") == t), None)
if not proj:
    print(); sys.exit(0)
fields = (proj.get("fields") or {}).get("nodes") or []
fld = next((f for f in fields if f and f.get("name") == fname), None) or {}
oid = ""
for o in (fld.get("options") or []):
    if o["name"].lower() == want.lower():
        oid = o["id"]
print(proj["id"], fld.get("id", ""), oid)
PY
)"
  if [ -z "${ids// /}" ]; then
    meta="$(gh api graphql -f query='
      query($o:String!){ organization(login:$o){ projectsV2(first:30){ nodes{
        id title
        fields(first:100){ nodes{ ... on ProjectV2SingleSelectField{ id name options{ id name } } } }
      }}}}' -f o="$owner" 2>/dev/null)"
    ids="$(PROJECT_TITLE="$project_title" FIELD="$field_name" WANT="$want_option" python3 - "$meta" <<'PY' 2>/dev/null
import sys, json, os
t = os.environ["PROJECT_TITLE"]; fname = os.environ["FIELD"]; want = os.environ.get("WANT", "")
try:
    d = json.loads(sys.argv[1])
except Exception:
    print(); sys.exit(0)
org = (d.get("data") or {}).get("organization")
if not org:
    print(); sys.exit(0)
nodes = (org.get("projectsV2") or {}).get("nodes") or []
proj = next((n for n in nodes if n and n.get("title") == t), None)
if not proj:
    print(); sys.exit(0)
fields = (proj.get("fields") or {}).get("nodes") or []
fld = next((f for f in fields if f and f.get("name") == fname), None) or {}
oid = ""
for o in (fld.get("options") or []):
    if o["name"].lower() == want.lower():
        oid = o["id"]
print(proj["id"], fld.get("id", ""), oid)
PY
)"
  fi
  printf '%s' "$ids"
}

# Status is the field the loop drives; keep the original public name + 3-arg
# contract as a thin wrapper so every existing caller/test stays unchanged.
board_resolve_project() { board_resolve_field "$1" "$2" "Status" "${3:-}"; }

# One place for the single-select field write (Status + Priority share it).
# Returns gh's rc; the caller warns on failure (best-effort).
set_single_select() {
  gh api graphql -f query='mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){projectV2Item{id}}}' -f p="$1" -f i="$2" -f f="$3" -f o="$4" >/dev/null 2>&1
}

# --- #252: closed-issue -> Done sweep ---------------------------------------
# GitHub ProjectV2's built-in "item closed -> set Status Done" workflow CANNOT
# be enabled via API (GraphQL exposes only deleteProjectV2Workflow; the toggle
# is UI-only). So closed issues freeze in their old column and the board lies.
# The `sweep` command below moves every project item whose linked issue is
# CLOSED and whose Status is not already the Done option -> Done. Best-effort
# (SD #6) + fail-safe (SD #4): a gh/parse failure yields NO sweep targets (never
# a wrong write), and every path warns + exits 0.

# Scan a project's items (by global node id -- no user/org fallback or title
# ambiguity) for closed-but-not-Done issues. Paginates in bash, threading the
# ProjectV2 items cursor until hasNextPage is false or the page cap is hit
# (warns if capped -- no silent truncation). Prints line 1 = the GraphQL
# rateLimit.remaining seen on the LAST page (-1 if unknown), then one item id
# per line for items whose content is an Issue with state==CLOSED and whose
# Status optionId != <done_opt>. Idempotent: already-Done items yield no id; a
# closed issue with no/other Status yields its id (a closed issue SHOULD be
# Done). Drafts (DraftIssue) and PRs never match `... on Issue` -> skipped.
#   $1 = project node id, $2 = Done option id.
board_sweep_scan() {
  local pid="$1" done_opt="$2"
  # Page cap bounds a runaway paginate. Sanitized to a positive int HERE (inside
  # the function) so it is self-contained when sourced -- no source-time work
  # before the "sourcing only defines functions" guard (review nitpick).
  local max_pages; case "${SWEEP_MAX_PAGES:-}" in ''|*[!0-9]*|0) max_pages=20 ;; *) max_pages="$SWEEP_MAX_PAGES" ;; esac
  local frag='pageInfo{ hasNextPage endCursor } nodes{ id status: fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue{ optionId } } content{ ... on Issue{ state } } }'
  local q_first="query(\$pid:ID!){ node(id:\$pid){ ... on ProjectV2{ items(first:100){ $frag } } } rateLimit{ remaining } }"
  local q_page="query(\$pid:ID!,\$cursor:String!){ node(id:\$pid){ ... on ProjectV2{ items(first:100, after:\$cursor){ $frag } } } rateLimit{ remaining } }"
  local cursor="" page=0 remaining=-1 resp parsed meta hn ec ids all_ids="" scan_ok=1
  while [ "$page" -lt "$max_pages" ]; do
    page=$((page + 1))
    if [ -z "$cursor" ]; then
      resp="$(gh api graphql -f query="$q_first" -f pid="$pid" 2>/dev/null)"
    else
      resp="$(gh api graphql -f query="$q_page" -f pid="$pid" -f cursor="$cursor" 2>/dev/null)"
    fi
    parsed="$(DONE_OPT="$done_opt" python3 - "$resp" <<'PY' 2>/dev/null
import sys, json, os
done = os.environ.get("DONE_OPT", "")
try:
    d = json.loads(sys.argv[1])
except Exception:
    sys.exit(0)                    # gh/parse failure -> print nothing (fail-safe)
data = d.get("data") or {}
node = data.get("node") or {}
items = node.get("items")
if items is None:
    sys.exit(0)                    # not a project / no items -> nothing this page
remaining = -1
rl = data.get("rateLimit") or {}
if isinstance(rl.get("remaining"), int):
    remaining = rl["remaining"]
pi = items.get("pageInfo") or {}
has_next = 1 if pi.get("hasNextPage") else 0
end_cur = pi.get("endCursor") or ""
out_ids = []
for it in (items.get("nodes") or []):
    if not it:
        continue
    c = it.get("content") or {}
    if c.get("state") != "CLOSED":     # only closed real Issues (drafts/PRs lack state)
        continue
    st = it.get("status") or {}
    if st.get("optionId") == done:     # idempotent: already Done -> skip
        continue
    out_ids.append(it["id"])
print("%d\t%d\t%s" % (remaining, has_next, end_cur))
for i in out_ids:
    print(i)
PY
)"
    # gh/parse failure or non-project mid-pagination -> INCOMPLETE scan. Mark it
    # and stop: an incomplete scan yields NO ids (all-or-nothing), so we never
    # emit a partial target set built from only the pages that happened to load.
    if [ -z "$parsed" ]; then scan_ok=0; break; fi
    # First line = meta (remaining<TAB>hasNext<TAB>endCursor), rest = item ids.
    { IFS= read -r meta; ids="$(cat)"; } <<EOF
$parsed
EOF
    IFS=$'\t' read -r remaining hn ec <<<"$meta"
    if [ -n "$ids" ]; then all_ids="$all_ids$ids
"; fi
    [ "$hn" = "1" ] || break          # last page reached -> clean completion
    if [ -z "$ec" ]; then scan_ok=0; break; fi  # hasNext but no cursor: malformed -> incomplete
    cursor="$ec"
  done
  if [ "$scan_ok" = "1" ] && [ "$page" -ge "$max_pages" ] && [ "$hn" = "1" ]; then
    # A deliberate cap (not a failure): the pages we DID scan are complete and
    # their ids are valid -- keep them and warn (no silent truncation). Gated on
    # scan_ok so a fail-safe abort landing on the cap page is not mislabeled a
    # cap hit (its ids are already discarded).
    warn "sweep: hit page cap ($max_pages) -- swept the first $((max_pages * 100)) items this pass"
  fi
  printf '%s\n' "$remaining"
  # Emit ids only for a clean (or deliberately capped) scan; an incomplete scan
  # (a page failure/malformed cursor) emits none -- the tail is retried next pass.
  [ "$scan_ok" = "1" ] && printf '%s' "$all_ids"
}

# Overlay-aware config read (#211). A config-page 'save default' for board.owner
# / board.project_title lands in the untracked var/autonomy-logs/config-overrides
# overlay (short keys board_owner / board_project_title) -- the SAME overlay the
# supervisor reads for model/effort (#202) -- so the setting survives the
# preflight stash-recovery that would otherwise sweep a tracked config.yaml edit
# back to committed. This reader shadows config.yaml with the overlay, mirroring
# the supervisor's last-wins parse (a later duplicate key wins; an empty value is
# treated as unset so a blank override never blanks a committed value).
#   $1 = dotted config key (config.yaml fallback), $2 = short overlay key.
# Paths are cwd-relative, exactly like the config.yaml reads below -- board.sh
# runs FROM the target-repo checkout, whose var/ holds the overlay. Best-effort:
# an unreadable/absent overlay falls straight through to config.yaml, never errors
# (settled-decision 6). Extractable to a shared lib/ helper if safe_merge/doctor
# -- guardrail files -- are wired to the same overlay in an attended change.
config_value_with_overlay() {
  local config_key="$1" overlay_short="$2"
  local overlay_file="var/autonomy-logs/config-overrides"
  local val="" line k v
  if [ -f "$overlay_file" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      k="${line%%=*}"; v="${line#*=}"
      if [ "$k" = "$overlay_short" ] && [ -n "$v" ]; then val="$v"; fi
    done <"$overlay_file"
  fi
  if [ -n "$val" ]; then
    printf '%s' "$val"
  else
    python3 "$BOARD_HOME/lib/config_parser.py" .autonomy/config.yaml "$config_key" 2>/dev/null || echo
  fi
}

# --- #292: approved-but-unmerged stall detection ------------------------------
# The merge path can stall invisibly: green CI + a fresh APPROVE verdict on the
# latest head, and nothing merges (the prevention-log-#17 night sat that way
# for ~90 minutes with zero signal). Each sweep, flag any open PR in that
# state older than the threshold. Verdict parsing follows review-resolution
# "Reading the gate": the review-bot COMMENT is the verdict (author + marker +
# APPROVE text, postdating the head commit) -- never the CI check bucket.
# Best-effort like everything here: any gh/parse failure yields NO stall
# claims (a false "stalled" alarm on garbage data would be its own noise) and
# never blocks the sweep. bot_comment gate only -- manual/ci_only merges have
# no autonomous verdict to stall on, and gh_review repos see approved PRs in
# GitHub's own UI.

# Scan open PRs; print one "<pr>\t<age_minutes>\t<head_oid>" line per stalled
# PR. $1 = review author login, $2 = comment marker, $3 = threshold seconds.
board_stall_scan() {
  local author="$1" marker="$2" threshold="$3"
  local prs pr now blob line
  prs="$(gh pr list --state open --limit 200 --json number --jq '.[].number' 2>/dev/null)" \
    || { warn "stall: gh pr list failed (skip)"; return 0; }
  [ -n "$prs" ] || return 0
  now="$(date -u +%s)"
  while IFS= read -r pr; do
    [ -n "$pr" ] || continue
    blob="$(gh pr view "$pr" --json commits,comments 2>/dev/null)" || continue
    # One total parse per PR: emits "<age_min>\t<head_oid>" ONLY when the
    # latest marker comment is a non-blocking APPROVE that postdates the head
    # commit AND is older than the threshold; silent otherwise. Every parse
    # failure is silent-not-stalled -- the earned-verdict direction.
    # CONTRACT: verdict semantics deliberately mirror safe_merge.sh's
    # merge_gate_bot_comment bug-for-bug (same APPROVE/blocking regexes, same
    # >=-at-equal-timestamps chronology) -- this detector reports "the gate
    # WOULD pass yet nothing merged", so it must agree with the gate it
    # watches, not be independently stricter.
    line="$(printf '%s' "$blob" | python3 -c '
import json, re, sys
from datetime import datetime, timezone

def epoch(iso):
    return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp())

author, marker, threshold, now = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
try:
    d = json.load(sys.stdin)
    head = (d.get("commits") or [])[-1]
    head_epoch = epoch(head["committedDate"])
    bot = [c for c in (d.get("comments") or [])
           if (c.get("author") or {}).get("login") == author
           and marker in (c.get("body") or "")]
    if not bot:
        sys.exit(0)
    latest = sorted(bot, key=lambda c: c.get("createdAt") or "")[-1]
    body = latest.get("body") or ""
    if re.search(r"REQUEST CHANGES|\[BLOCKING\]|must fix before merge", body, re.I):
        sys.exit(0)
    if not re.search(r"APPROVE", body, re.I):
        sys.exit(0)
    review_epoch = epoch(latest["createdAt"])
    if review_epoch < head_epoch:
        sys.exit(0)          # push reset the gate -- not an approved head
    if now - review_epoch <= threshold:
        sys.exit(0)          # approved, but not stalled yet
    oid = head.get("oid") or ""
    if not oid:
        sys.exit(0)          # no head oid -> no per-head idempotency -> no claim
    print("%d\t%s" % ((now - review_epoch) // 60, oid))
except Exception:
    sys.exit(0)              # unparseable -> no claim, never a false alarm
' "$author" "$marker" "$threshold" "$now" 2>/dev/null)"
    [ -n "$line" ] && printf '%s\t%s\n' "$pr" "$line"
  done <<EOF
$prs
EOF
  return 0
}

# Post the stall comment on a PR, once per head oid (the hidden marker makes
# re-sweeps idempotent; a new push = new oid = the gate reset anyway). When
# the existing comments cannot be READ, post nothing -- idempotency cannot be
# proven, and a duplicate-comment storm is worse than one quiet sweep.
board_stall_flag() {
  local pr="$1" age_min="$2" head_oid="$3"
  local existing
  existing="$(gh pr view "$pr" --json comments --jq '.comments[].body' 2>/dev/null)" \
    || { warn "stall: cannot read #$pr comments -- not posting (idempotency unprovable)"; return 0; }
  case "$existing" in
    *"autonomy-stall-flag $head_oid"*) return 0 ;;
  esac
  gh pr comment "$pr" --body "⚠ **Approved but unmerged for ${age_min}m.** Latest review verdict is APPROVE on the current head and CI had its chance -- the merge path may be stalled (safe_merge not invoked, or its gate read differs). Detected by the board sweep (#292).

<!-- autonomy-stall-flag $head_oid -->" >/dev/null 2>&1 \
    || warn "stall: failed to comment on #$pr (skip)"
  return 0
}

[ "${BASH_SOURCE[0]}" = "${0}" ] || return 0

# GraphQL rate-limit floor for the `sweep` mutation batch (skip when the shared
# 5k/hr pool is nearly spent, so board hygiene never starves the loop's own API
# budget). Sanitized to a non-negative integer -- a bad env value can never
# misgate or emit an arithmetic error (best-effort). Below the guard: it is used
# only by the executable body, so sourcing stays functions-only.
case "${SWEEP_RATELIMIT_FLOOR:-}" in ''|*[!0-9]*) SWEEP_RATELIMIT_FLOOR=100 ;; esac

# #292: approved-but-unmerged threshold (seconds). Same sanitization pattern.
case "${STALL_AFTER_SECS:-}" in ''|*[!0-9]*) STALL_AFTER_SECS=1800 ;; esac

cmd="${1:-}"
if [ -z "$cmd" ]; then
  warn 'usage: board.sh status <issue#> "<Status>" | add <issue#> | sweep'
  exit 0
fi
# Validate the command BEFORE any side effect (resolve/issue-view/add/priority):
# an unknown command must not mutate the board on its way to the usage warning.
case "$cmd" in
  status|add|sweep) ;;
  *) warn "unknown command '$cmd' (use: status | add | sweep)"; exit 0 ;;
esac

# OWNER/PROJECT_TITLE are needed by EVERY command (status, add, sweep) -- resolve
# + validate once, before the per-command arg checks (so `sweep`, which takes no
# <issue#>, is not rejected by the issue-required check below).
OWNER="$(config_value_with_overlay board.owner board_owner)"
PROJECT_TITLE="$(config_value_with_overlay board.project_title board_project_title)"
if [ -z "$OWNER" ] || [ -z "$PROJECT_TITLE" ]; then
  warn "board.owner/board.project_title not set in .autonomy/config.yaml (skip)"; exit 0
fi
# board.owner crosses into gh argv (as a GraphQL variable); re-validate it
# against the GitHub login grammar at the point of use (prevention-log 6) even
# though config also validates -- a stray '-' or non-login char never reaches
# gh. Best-effort: an invalid owner warns and skips, never errors.
case "$OWNER" in
  ""|-*|*[!A-Za-z0-9-]*)
    warn "board.owner '$OWNER' is not a valid GitHub login (skip)"; exit 0 ;;
esac

# #252: sweep closed issues -> Done. Takes NO <issue#>, so it is handled before
# the issue-required check. Idempotent, rate-limit-gated, best-effort.
if [ "$cmd" = "sweep" ]; then
  # #292: stall detection rides the sweep tick, BEFORE the Projects-board
  # resolution below -- a labels-only repo (no board) still gets stall flags.
  # Only under a bot_comment gate: manual/ci_only have no autonomous verdict
  # to stall on; gh_review surfaces approved PRs in GitHub's own UI.
  gate_strategy="$(python3 "$BOARD_HOME/lib/config_parser.py" .autonomy/config.yaml merge_gate.strategy 2>/dev/null || echo)"
  if [ "$gate_strategy" = "bot_comment" ]; then
    stall_author="$(python3 "$BOARD_HOME/lib/config_parser.py" .autonomy/config.yaml merge_gate.author_login 2>/dev/null || echo)"
    stall_author="${stall_author:-github-actions}"
    stall_marker="$(python3 "$BOARD_HOME/lib/config_parser.py" .autonomy/config.yaml merge_gate.marker 2>/dev/null || echo)"
    stall_marker="${stall_marker:-Claude Code Review}"
    stalls="$(board_stall_scan "$stall_author" "$stall_marker" "$STALL_AFTER_SECS")"
    if [ -n "$stalls" ]; then
      while IFS="$(printf '\t')" read -r spr sage soid; do
        [ -n "$spr" ] || continue
        warn "stall: PR #$spr approved+unmerged for ${sage}m (head ${soid})"
        board_stall_flag "$spr" "$sage" "$soid"
      done <<EOF
$stalls
EOF
    fi
  fi

  DONE_NAME="$(config_value_with_overlay board.done_status board_done_status)"
  [ -n "$DONE_NAME" ] || DONE_NAME="Done"
  sweep_ids="$(board_resolve_field "$OWNER" "$PROJECT_TITLE" "Status" "$DONE_NAME")"
  read -r SPID SFID SDONE <<<"$sweep_ids"
  if [ -z "${SPID:-}" ]; then warn "sweep: project '$PROJECT_TITLE' not found under '$OWNER' (skip)"; exit 0; fi
  if [ -z "${SFID:-}" ] || [ -z "${SDONE:-}" ]; then
    warn "sweep: Status field or '$DONE_NAME' option not found on the board (skip)"; exit 0
  fi
  scan="$(board_sweep_scan "$SPID" "$SDONE")"
  swept=0
  # Brace group (not a subshell) with here-doc redirection: `exit 0` exits the
  # script and `swept` persists. Line 1 = rateLimit.remaining; rest = item ids.
  { IFS= read -r sweep_remaining
    if [ "${sweep_remaining:-0}" -ge 0 ] 2>/dev/null && [ "${sweep_remaining:-0}" -lt "$SWEEP_RATELIMIT_FLOOR" ]; then
      warn "sweep: GraphQL rate limit low ($sweep_remaining < $SWEEP_RATELIMIT_FLOOR) -- skipping the mutation batch to protect the loop's API budget"
      exit 0
    fi
    while IFS= read -r item_id; do
      [ -n "$item_id" ] || continue
      if set_single_select "$SPID" "$item_id" "$SFID" "$SDONE"; then
        swept=$((swept + 1))
      else
        warn "sweep: failed to set an item to $DONE_NAME (skip)"
      fi
    done
  } <<EOF
$scan
EOF
  [ "$swept" -gt 0 ] && warn "sweep: moved $swept closed issue(s) to $DONE_NAME"
  exit 0
fi

# status / add require an <issue#>.
issue="${2:-}"; status="${3:-}"
if [ -z "$issue" ]; then
  warn 'usage: board.sh status <issue#> "<Status>" | add <issue#> | sweep'
  exit 0
fi

ids="$(board_resolve_project "$OWNER" "$PROJECT_TITLE" "$status")"
read -r PID FID OPT_ID <<<"$ids"
if [ -z "${PID:-}" ]; then warn "project '$PROJECT_TITLE' not found under '$OWNER' (skip)"; exit 0; fi

# Issue node id + labels in one call; the p-label drives the Priority field.
IVIEW="$(gh issue view "$issue" --json id,labels 2>/dev/null)"
NID="$(printf '%s' "$IVIEW" | python3 -c 'import sys,json; print((json.load(sys.stdin) or {}).get("id",""))' 2>/dev/null)"
if [ -z "$NID" ]; then warn "issue #$issue not found (skip)"; exit 0; fi
LABELS="$(printf '%s' "$IVIEW" | python3 -c 'import sys,json
d = json.load(sys.stdin) or {}
for l in (d.get("labels") or []):
    print(l.get("name", ""))' 2>/dev/null)"
WANT_PRIORITY="$(plabel_to_priority "$LABELS")"
PFID=""; POPT=""
if [ -n "$WANT_PRIORITY" ]; then
  # Independent of the Status resolve above: its own failure just leaves
  # PFID/POPT empty (Priority skipped), never aborts the run.
  pri_ids="$(board_resolve_field "$OWNER" "$PROJECT_TITLE" "Priority" "$WANT_PRIORITY")"
  read -r _ PFID POPT <<<"$pri_ids"
fi

ITEM="$(gh api graphql -f query='query($n:ID!){node(id:$n){... on Issue{projectItems(first:20){nodes{id project{id}}}}}}' -f n="$NID" 2>/dev/null \
  | PID="$PID" python3 -c 'import sys,json,os; d=json.load(sys.stdin); p=os.environ["PID"]; ns=d["data"]["node"]["projectItems"]["nodes"]; print(next((i["id"] for i in ns if i["project"]["id"]==p), ""))' 2>/dev/null)"

if [ -z "${ITEM:-}" ]; then
  ITEM="$(gh api graphql -f query='mutation($p:ID!,$c:ID!){addProjectV2ItemById(input:{projectId:$p,contentId:$c}){item{id}}}' -f p="$PID" -f c="$NID" --jq '.data.addProjectV2ItemById.item.id' 2>/dev/null)"
  if [ -z "${ITEM:-}" ]; then warn "could not add #$issue to board (skip)"; exit 0; fi
  warn "added #$issue to board"
fi

# Priority enrichment (display-only, D2): best-effort on BOTH add and status.
# Set only when the field AND a matching option resolved (field-absent -> both
# empty -> skipped silently). fid=="" implies opt=="" in the resolver, so the
# read above never shifts tokens; even a hypothetical shift only makes the
# mutation fail -> warn+skip, never a wrong write that matters (display field).
if [ -n "${PFID:-}" ] && [ -n "${POPT:-}" ]; then
  if set_single_select "$PID" "$ITEM" "$PFID" "$POPT"; then
    warn "#$issue priority -> $WANT_PRIORITY"
  else
    warn "failed to set #$issue priority (skip)"
  fi
fi

if [ "$cmd" = "add" ]; then exit 0; fi

if [ "$cmd" = "status" ]; then
  if [ -z "${FID:-}" ]; then warn "Status field not found (skip)"; exit 0; fi
  if [ -z "${OPT_ID:-}" ]; then warn "status '$status' is not a board column (skip)"; exit 0; fi
  if set_single_select "$PID" "$ITEM" "$FID" "$OPT_ID"; then
    warn "#$issue -> $status"
  else
    warn "failed to set #$issue status (skip)"
  fi
  exit 0
fi

# Unreachable: cmd was validated to status|add|sweep up top and every path exits
# above. Defensive catch-all keeps the best-effort exit-0 contract regardless.
exit 0
