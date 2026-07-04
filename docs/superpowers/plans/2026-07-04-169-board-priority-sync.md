# board.sh Priority-field sync (#169) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** `board.sh` also sets each item's Projects v2 **Priority** single-select from the issue's `p1/p2/p3` label (display-only enrichment, settled-decision D2/23), on both `add` and `status` calls.

**Architecture:** Generalize the existing Status-only `board_resolve_project` into a field-name-parametrized `board_resolve_field(owner, title, field_name, want_option)` (one user→org fallback, DRY); `board_resolve_project` becomes a thin `Status` wrapper so its tests stay green. A pure `plabel_to_priority(labels)` maps the engine p-label to the board option (p1→P0, p2→P1, p3→P2). A `set_single_select` helper factors the single-select mutation used by both Status and Priority. The main body fetches the issue's labels, resolves the Priority field only when a p-label exists, and sets it best-effort after the item is ensured.

**EMPIRICALLY VERIFIED against the live "Autonomy Progress" board (2026-07-04):**
- It has a **Priority** single-select with options exactly **P0/P1/P2** — the mapping matches.
- `field(name:$fn)` (GraphQL variable) parses fine, BUT `field(name:"Priority")` returns a
  **NOT_FOUND GraphQL error** (gh rc=1) for projects lacking that field (eBull/MVP boards) —
  error-driven control flow that would poison the resolver's rc. → Use `fields(first:50){nodes{
  ... on ProjectV2SingleSelectField{id name options{id name}}}}` **enumeration** and filter the
  field by name in Python: rc=0, no errors, returns every single-select. This replaces the Status
  query too (Status always exists, so behavior is unchanged for it).
- The gh call must therefore **not** `return 1` on rc — enumeration is rc=0 on success and the
  partial-data path is gone; a true total failure yields empty stdout → empty tokens → the body
  skips. (The existing mock `gh` always returns rc=0, so no current test exercised `|| return 1`.)

**Tech Stack:** bash 3.2.57, Python 3 stdlib, gh GraphQL.

## Global Constraints

- **bash 3.2.57**: no `mapfile`/globstar/`declare -A`/`${var,,}`.
- **Best-effort invariant**: every failure path `warn`s to stderr and the script still `exit 0` — board upkeep must NEVER block engineering. New paths follow the same posture: field-absent → skip silently, no p-label → leave Priority untouched (never guess), gh/JSON failure → warn+continue.
- **Projects v2 stays display-only (D2)**: board.sh WRITES display, never READS routing from it.
- Python 3 stdlib only; `shellcheck -S warning` clean; the script's executable body stays behind the `[ "${BASH_SOURCE[0]}" = "${0}" ] || return 0` guard (functions above it are sourced by the test).
- **Mapping (documented):** engine p1/p2/p3 (settled-decision 23, p1 highest) → board P0/P1/P2 (P0 highest). Highest-to-highest: p1→P0, p2→P1, p3→P2. No p-label → "" (untouched).

---

### Task 1: `plabel_to_priority` — pure p-label → board option mapping

**Files:** Modify `bin/board.sh` (add function above the guard); Test `tests/test_board_resolve.sh`.

**Interfaces:** Produces `plabel_to_priority(labels_newline_separated) -> "P0"|"P1"|"P2"|""` on stdout.

- [ ] **Step 1: Failing test** — append to `tests/test_board_resolve.sh` before the summary:
```bash
check "p1 maps to P0" "P0" "$(plabel_to_priority "$(printf 'bug\np1\nloop-ready')")"
check "p2 maps to P1" "P1" "$(plabel_to_priority "p2")"
check "p3 maps to P2" "P2" "$(plabel_to_priority "p3")"
check "no p-label -> empty" "" "$(plabel_to_priority "$(printf 'bug\nloop-ready')")"
check "non-p labels ignored, first p wins" "P1" "$(plabel_to_priority "$(printf 'enhancement\np2\np3')")"
```
- [ ] **Step 2: Run — expect FAIL** `bash tests/test_board_resolve.sh` → `command not found: plabel_to_priority`.
- [ ] **Step 3: Implement** in `bin/board.sh` after `warn()`:
```bash
# Map the engine's p-label (settled-decision 23: p1>p2>p3, p1 highest) to the
# operator board's Priority single-select option (P0>P1>P2, P0 highest):
# p1->P0, p2->P1, p3->P2. Echoes "" when no p-label is present -- the field is
# then left untouched (never guess a priority). $1 = newline-separated labels;
# first p-label wins (the board contract makes them mutually exclusive).
plabel_to_priority() {
  local l
  while IFS= read -r l; do
    case "$l" in
      p1) printf 'P0'; return 0 ;;
      p2) printf 'P1'; return 0 ;;
      p3) printf 'P2'; return 0 ;;
    esac
  done <<EOF
$1
EOF
  printf ''
}
```
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** `fix: plabel_to_priority maps engine p-labels to board Priority options (#169)`

---

### Task 2: generalize the resolver to any single-select field (DRY)

**Files:** Modify `bin/board.sh`; Test `tests/test_board_resolve.sh`.

**Interfaces:** Produces `board_resolve_field(owner, title, field_name, want_option) -> "<pid> <field_id> <option_id>"`. `board_resolve_project(owner,title,want_status)` becomes `board_resolve_field owner title Status want_status` (unchanged output/contract).

- [ ] **Step 1: Failing test** — add a Priority fixture case:
```bash
USER_RESPONSE='{"data":{"user":{"projectsV2":{"nodes":[{"id":"PID_U","title":"Autonomy Progress","field":{"id":"PRIO_FID","options":[{"id":"P0OPT","name":"P0"},{"id":"P1OPT","name":"P1"}]}}]}}}}'
ids="$(board_resolve_field "Luke-Bradford" "Autonomy Progress" "Priority" "P1")"
check "resolves a Priority field option" "PID_U PRIO_FID P1OPT" "$ids"
```
(existing `board_resolve_project` cases stay and must still pass.)
- [ ] **Step 2: Run — expect FAIL** (`board_resolve_field: command not found`).
- [ ] **Step 3: Implement** — replace `board_resolve_project` with `board_resolve_field` (field-name parametrized via a GraphQL `$fn` variable; the response key stays `field`, so the existing mock fixtures are unchanged), then add the thin wrapper. The two Python heredocs are unchanged except reading `WANT` instead of `STATUS`:
```bash
board_resolve_field() {
  local owner="$1" project_title="$2" field_name="$3" want_option="${4:-}"
  local meta ids
  meta="$(gh api graphql -f query='
    query($o:String!,$fn:String!){ user(login:$o){ projectsV2(first:30){ nodes{
      id title
      field(name:$fn){ ... on ProjectV2SingleSelectField{ id options{ id name } } }
    }}}}' -f o="$owner" -f fn="$field_name" 2>/dev/null)" || return 1
  ids="$(PROJECT_TITLE="$project_title" WANT="$want_option" python3 - "$meta" <<'PY' 2>/dev/null
import sys, json, os
t = os.environ["PROJECT_TITLE"]; want = os.environ.get("WANT", "")
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
      query($o:String!,$fn:String!){ organization(login:$o){ projectsV2(first:30){ nodes{
        id title
        field(name:$fn){ ... on ProjectV2SingleSelectField{ id options{ id name } } }
      }}}}' -f o="$owner" -f fn="$field_name" 2>/dev/null)" || return 1
    ids="$(PROJECT_TITLE="$project_title" WANT="$want_option" python3 - "$meta" <<'PY' 2>/dev/null
import sys, json, os
t = os.environ["PROJECT_TITLE"]; want = os.environ.get("WANT", "")
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

# Status is the default field the loop drives; keep the original public name +
# 3-arg contract as a thin wrapper so every caller/test stays unchanged.
board_resolve_project() { board_resolve_field "$1" "$2" "Status" "${3:-}"; }
```
- [ ] **Step 4: Run — expect PASS** (new Priority case + all existing `board_resolve_project` cases).
- [ ] **Step 5: Commit** `refactor: board_resolve_field generalizes the resolver to any single-select field (#169)`

---

### Task 3: sync Priority in the main body (best-effort, add + status)

**Files:** Modify `bin/board.sh` executable body.

- [ ] **Step 1: Add `set_single_select` helper** (above the guard) and route the existing Status mutation through it:
```bash
# One place for the single-select field write (Status + Priority share it).
# Best-effort caller-checked: returns gh's rc; the body warns on failure.
set_single_select() {
  gh api graphql -f query='mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){projectV2Item{id}}}' -f p="$1" -f i="$2" -f f="$3" -f o="$4" >/dev/null 2>&1
}
```
- [ ] **Step 2: Fetch labels + resolve Priority** — after the OWNER/PROJECT_TITLE guard, change the issue fetch to also pull labels and resolve the Priority field only when a p-label exists. Replace the `NID=` line with:
```bash
IVIEW="$(gh issue view "$issue" --json id,labels 2>/dev/null)" || { warn "issue #$issue not found (skip)"; exit 0; }
NID="$(printf '%s' "$IVIEW" | python3 -c 'import sys,json; print((json.load(sys.stdin) or {}).get("id",""))' 2>/dev/null)"
if [ -z "$NID" ]; then warn "issue #$issue not found (skip)"; exit 0; fi
LABELS="$(printf '%s' "$IVIEW" | python3 -c 'import sys,json
d=json.load(sys.stdin) or {}
for l in (d.get("labels") or []):
    print(l.get("name",""))' 2>/dev/null)"
WANT_PRIORITY="$(plabel_to_priority "$LABELS")"
PFID=""; POPT=""
if [ -n "$WANT_PRIORITY" ]; then
  pri_ids="$(board_resolve_field "$OWNER" "$PROJECT_TITLE" "Priority" "$WANT_PRIORITY")" || pri_ids=""
  read -r _PPID PFID POPT <<<"$pri_ids"
fi
```
(the original `board_resolve_project` call for Status stays exactly as-is at its current spot; PID/FID/OPT_ID unchanged.)
- [ ] **Step 3: Set Priority best-effort after the item is ensured** — insert immediately after the ITEM-resolution block (before `if [ "$cmd" = "add" ]`), so BOTH add and status enrich Priority:
```bash
if [ -n "${PFID:-}" ] && [ -n "${POPT:-}" ]; then
  if set_single_select "$PID" "$ITEM" "$PFID" "$POPT"; then
    warn "#$issue priority -> $WANT_PRIORITY"
  else
    warn "failed to set #$issue priority (skip)"
  fi
fi
```
- [ ] **Step 4: Route the Status mutation through the helper** — replace the inline `gh api graphql ... updateProjectV2ItemFieldValue ...` in the `status` branch with `if set_single_select "$PID" "$ITEM" "$FID" "$OPT_ID"; then`.
- [ ] **Step 5: Verify** `bash tests/test_board_resolve.sh` PASS; `bash tests/run_all.sh` PASS; `shellcheck -S warning bin/board.sh tests/test_board_resolve.sh` rc=0. Commit `feat: board.sh enriches the item's Priority field from the issue p-label (#169)`.

---

## Self-Review

- **Spec coverage:** display-only Priority set on add+status (Task 3) · explicit documented mapping (Task 1 + comment) · best-effort/field-absent-silent/no-p-label-untouched (Task 3 guards) · D2 write-only (no board reads added). ✅
- **Placeholder scan:** none.
- **Type consistency:** `board_resolve_field` 4-arg → 3-token out; `board_resolve_project` wrapper preserves the 3-arg contract; `set_single_select` 4-arg → rc.
