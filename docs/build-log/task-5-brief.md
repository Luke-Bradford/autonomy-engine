### Task 5: `board.sh` — generic board updater (user/org auto-detect)

**Files:**
- Create: `bin/board.sh`
- Test: `tests/test_board_resolve.sh`

**Interfaces:**
- Consumes: `python3 lib/config_parser.py` (Task 2); reads `board.owner`/`board.project_title` from
  `.autonomy/config.yaml` in the CURRENT WORKING DIRECTORY when run standalone (matches today's
  convention of running from the target repo checkout).
- Produces: `board_resolve_project(owner, project_title, [want_status]) -> prints "<project_id>
  <status_field_id> <option_id>"` (fields may be empty if not found) — this is what Task 4's
  `doctor_full_report` sources and calls, and what this file's own CLI body uses internally.

- [ ] **Step 1: Write the failing test (mocking `gh` as a shell function)**

```bash
# tests/test_board_resolve.sh
#!/usr/bin/env bash
# Unit test for board.sh's board_resolve_project -- user-then-org fallback.
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
  if printf '%s' "$*" | grep -q 'organization(login'; then
    printf '%s' "$ORG_RESPONSE"
  else
    printf '%s' "$USER_RESPONSE"
  fi
}

USER_RESPONSE='{"data":{"user":{"projectsV2":{"nodes":[{"id":"PID_USER","title":"eBull engineering board","field":{"id":"FID_USER","options":[{"id":"OPT1","name":"In Progress"}]}}]}}}}'
ids="$(board_resolve_project "Luke-Bradford" "eBull engineering board" "In Progress")"
check "user-owned project found directly" "PID_USER FID_USER OPT1" "$ids"

USER_RESPONSE='{"data":{"user":{"projectsV2":{"nodes":[]}}}}'
ORG_RESPONSE='{"data":{"organization":{"projectsV2":{"nodes":[{"id":"PID_ORG","title":"org board","field":{"id":"FID_ORG","options":[]}}]}}}}'
ids="$(board_resolve_project "some-org" "org board" "")"
check "falls back to organization when user has no match" "PID_ORG FID_ORG " "$ids"

USER_RESPONSE='{"data":{"user":{"projectsV2":{"nodes":[]}}}}'
ORG_RESPONSE='{"data":{"organization":null}}'
ids="$(board_resolve_project "nobody" "nothing" "")"
check "neither user nor org match -> empty" "" "$(printf '%s' "$ids" | tr -d ' ')"

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails CHECK(S) FAILED"; exit 1; fi
```

- [ ] **Step 2: Run to verify it fails**

```bash
chmod +x tests/test_board_resolve.sh
bash tests/test_board_resolve.sh
```
Expected: fails (`bin/board.sh` doesn't exist yet).

- [ ] **Step 3: Implement `bin/board.sh`**

```bash
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
# BEST-EFFORT BY DESIGN: board upkeep must NEVER block engineering work. Every
# failure path warns to stderr and exits 0.
set -uo pipefail
BOARD_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

warn() { echo "board.sh: $*" >&2; }

# Resolve a GitHub Projects v2 project's node ID + Status field id + option
# id for $3 (want_status), trying a user-owned project first, then an
# org-owned one (Codex strategic-fit finding -- today's eBull-only version
# assumed user()). Prints "<project_id> <status_field_id> <option_id>" or
# nothing if no project with that title is found under either shape.
board_resolve_project() {
  local owner="$1" project_title="$2" want_status="${3:-}"
  local meta
  meta="$(gh api graphql -f query='
    query($o:String!){ user(login:$o){ projectsV2(first:30){ nodes{
      id title
      field(name:"Status"){ ... on ProjectV2SingleSelectField{ id options{ id name } } }
    }}}}' -f o="$owner" 2>/dev/null)" || return 1

  local ids
  ids="$(PROJECT_TITLE="$project_title" STATUS="$want_status" python3 - "$meta" <<'PY' 2>/dev/null
import sys, json, os
t = os.environ["PROJECT_TITLE"]; want = os.environ.get("STATUS", "")
d = json.loads(sys.argv[1])
proj = next((n for n in d["data"]["user"]["projectsV2"]["nodes"] if n["title"] == t), None)
if not proj:
    print(); sys.exit(0)
f = proj.get("field") or {}
oid = ""
for o in (f.get("options") or []):
    if o["name"].lower() == want.lower():
        oid = o["id"]
print(proj["id"], f.get("id", ""), oid)
PY
)"
  if [ -z "${ids// /}" ]; then
    meta="$(gh api graphql -f query='
      query($o:String!){ organization(login:$o){ projectsV2(first:30){ nodes{
        id title
        field(name:"Status"){ ... on ProjectV2SingleSelectField{ id options{ id name } } }
      }}}}' -f o="$owner" 2>/dev/null)" || return 1
    ids="$(PROJECT_TITLE="$project_title" STATUS="$want_status" python3 - "$meta" <<'PY' 2>/dev/null
import sys, json, os
t = os.environ["PROJECT_TITLE"]; want = os.environ.get("STATUS", "")
d = json.loads(sys.argv[1])
org = (d.get("data") or {}).get("organization")
if not org:
    print(); sys.exit(0)
proj = next((n for n in org["projectsV2"]["nodes"] if n["title"] == t), None)
if not proj:
    print(); sys.exit(0)
f = proj.get("field") or {}
oid = ""
for o in (f.get("options") or []):
    if o["name"].lower() == want.lower():
        oid = o["id"]
print(proj["id"], f.get("id", ""), oid)
PY
)"
  fi
  printf '%s' "$ids"
}

[ "${BASH_SOURCE[0]}" = "${0}" ] || return 0

cmd="${1:-}"; issue="${2:-}"; status="${3:-}"
if [ -z "$cmd" ] || [ -z "$issue" ]; then
  warn 'usage: board.sh status <issue#> "<Status>" | add <issue#>'
  exit 0
fi

OWNER="$(python3 "$BOARD_HOME/lib/config_parser.py" .autonomy/config.yaml board.owner 2>/dev/null || echo)"
PROJECT_TITLE="$(python3 "$BOARD_HOME/lib/config_parser.py" .autonomy/config.yaml board.project_title 2>/dev/null || echo)"
if [ -z "$OWNER" ] || [ -z "$PROJECT_TITLE" ]; then
  warn "board.owner/board.project_title not set in .autonomy/config.yaml (skip)"; exit 0
fi

ids="$(board_resolve_project "$OWNER" "$PROJECT_TITLE" "$status")" || { warn "board metadata query failed (skip)"; exit 0; }
read -r PID FID OPT_ID <<<"$ids"
if [ -z "${PID:-}" ]; then warn "project '$PROJECT_TITLE' not found under '$OWNER' (skip)"; exit 0; fi

NID="$(gh issue view "$issue" --json id --jq .id 2>/dev/null)" || { warn "issue #$issue not found (skip)"; exit 0; }
if [ -z "$NID" ]; then warn "issue #$issue not found (skip)"; exit 0; fi

ITEM="$(gh api graphql -f query='query($n:ID!){node(id:$n){... on Issue{projectItems(first:20){nodes{id project{id}}}}}}' -f n="$NID" 2>/dev/null \
  | PID="$PID" python3 -c 'import sys,json,os; d=json.load(sys.stdin); p=os.environ["PID"]; ns=d["data"]["node"]["projectItems"]["nodes"]; print(next((i["id"] for i in ns if i["project"]["id"]==p), ""))' 2>/dev/null)"

if [ -z "${ITEM:-}" ]; then
  ITEM="$(gh api graphql -f query='mutation($p:ID!,$c:ID!){addProjectV2ItemById(input:{projectId:$p,contentId:$c}){item{id}}}' -f p="$PID" -f c="$NID" --jq '.data.addProjectV2ItemById.item.id' 2>/dev/null)"
  if [ -z "${ITEM:-}" ]; then warn "could not add #$issue to board (skip)"; exit 0; fi
  warn "added #$issue to board"
fi

if [ "$cmd" = "add" ]; then exit 0; fi

if [ "$cmd" = "status" ]; then
  if [ -z "${FID:-}" ]; then warn "Status field not found (skip)"; exit 0; fi
  if [ -z "${OPT_ID:-}" ]; then warn "status '$status' is not a board column (skip)"; exit 0; fi
  if gh api graphql -f query='mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){projectV2Item{id}}}' -f p="$PID" -f i="$ITEM" -f f="$FID" -f o="$OPT_ID" >/dev/null 2>&1; then
    warn "#$issue -> $status"
  else
    warn "failed to set #$issue status (skip)"
  fi
  exit 0
fi

warn "unknown command '$cmd' (skip)"
exit 0
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bash tests/test_board_resolve.sh
```
Expected: `ALL PASS`.

- [ ] **Step 5: Re-run Task 4's test to confirm the forward dependency is now satisfied**

```bash
bash tests/test_doctor.sh
```
Expected: still `ALL PASS` (unchanged — `test_doctor.sh` doesn't exercise `doctor_full_report`, but
this confirms nothing broke).

- [ ] **Step 6: shellcheck**

```bash
shellcheck -S warning bin/board.sh
```
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add bin/board.sh tests/test_board_resolve.sh
git commit -m "feat: add generic board.sh with user/org auto-detect"
git push
```

---

