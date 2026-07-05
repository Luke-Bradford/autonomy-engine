# Board-Unresolved Warning Chip (#90 item a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a repo's config names a Projects board that board.sh cannot resolve, the dashboard's fleet rail shows a `⚠ board unresolved` chip instead of the misconfig staying invisible for the repo's whole life.

**Architecture:** Detector→marker→chip (the #292/#302 pattern: the dashboard renders the DETECTOR's own output, never re-derives a verdict). `board.sh` — the component that already resolves the board every sweep/status/add — writes `var/autonomy-logs/board-warning` (2 lines: epoch, its own warn message) whenever resolution fails, and REMOVES it whenever resolution succeeds or the board is deliberately off (empty title, SD-31 labels-only). `lib/dashboard_state.py` reads the marker totally (`read_board_warning`), `lib/dashboard_page.html` renders the chip next to the existing `laneWarn` badge.

**Tech Stack:** bash 3.2 (board.sh), Python 3 stdlib (dashboard_state), vanilla JS template string (dashboard_page.html).

## Global Constraints

- macOS `/bin/bash` 3.2.57 floor: no mapfile/globstar/assoc-arrays/case-mod expansions.
- Python 3 stdlib only.
- board.sh is best-effort (SD-6): the marker write/clear must NEVER fail the script — every filesystem op `2>/dev/null || true`-guarded; a marker failure never blocks board work.
- Repo-agnostic (SD-3): marker lives under the TARGET repo's `var/autonomy-logs/` (board.sh cwd), no engine-side paths.
- SD-24/SD-31: an EMPTY `project_title` is board-off-by-design (healthy — marker cleared, no chip). A NON-empty title with a missing/invalid `owner` IS a misconfig — marker written (Codex CP1 finding 1: clearing on "owner OR title empty" would fail open). Boards are never auto-created; the chip is display-only.
- Marker semantics: the marker reflects the LATEST resolution attempt's verdict — each command marks/clears per its OWN resolution outcome (add needs the project; status needs project+Status field+option; sweep needs project+Status+Done). `sweep` runs every supervisor tick, so it is the steady-state authority; a shallower command's clear self-corrects within one tick (documented, CP1 finding 2/3).
- Honesty caveat: gh failure and genuine not-found are indistinguishable at `board_resolve_field`'s caller (documented at bin/board.sh:52-57 — total failure yields empty stdout = "not found"). The marker message therefore says "not found (or lookup failed)" — mirror-the-detector, never claim more certainty than the detector has. Self-heals: next successful resolution removes the marker.
- Prevention-log 12/17: the dashboard reader is TOTAL — missing/torn/oversized/malformed marker → `None`, never an exception, never a fabricated alarm (warn is EARNED by a well-formed marker only).
- shellcheck -S warning clean, including tests/*.sh.

## Marker file contract

Path: `<target-repo>/var/autonomy-logs/board-warning`
```
<unix-epoch>
<one-line human message, board.sh's own warn text without the "board.sh: " prefix>
```
Written atomically (tmp + mv). Absent file = no warning. Dashboard rejects (returns None): unparseable epoch, empty message, missing lines, MORE than 2 content lines (a torn/corrupted write must not fabricate a warning — CP1 finding 5), message over 512 chars or file over 4096 bytes (oversize = malformed, rejected outright, never truncated-and-trusted — CP1 finding 4).

---

### Task 1: board.sh writes/clears the marker

**Files:**
- Modify: `bin/board.sh` (helpers near `warn()` ~line 19; wiring at the BOARD_CONFIGURED block ~389-406, sweep resolution ~440-445, status/add resolution ~477-480)
- Test: `tests/test_board_cli.sh` (extend the existing fake-gh subprocess harness)

**Interfaces:**
- Produces: marker file per the contract above. Consumed by Task 2's `read_board_warning`.

- [ ] **Step 1: Write the failing tests**

In `tests/test_board_cli.sh`, extend the fake `gh` so the project title it returns is overridable: in the `*projectsV2*` case replace the hardcoded `"Autonomy Progress"` title with `"${GH_PROJ_TITLE:-Autonomy Progress}"` (switch that case's `printf '%s' '...'` single-quoted literal to a format string with the title substituted, keeping the JSON otherwise identical). Thread `GH_PROJ_TITLE` through the `run()` env like `GH_SWEEP_REMAINING`.

Append after the existing checks (before the final exit):

```bash
# --- #90 item (a): board-unresolved marker ---------------------------------
MARKER="$TMP/repo/var/autonomy-logs/board-warning"

# M1: resolution fails (title mismatch) -> marker written, exit still 0.
rc="$(GH_PROJ_TITLE="Some Other Board" run p2 "" status 42 "In review")"
check "marker: not-found status exits 0" "0" "$rc"
check "marker: written on not-found" "1" "$([ -f "$MARKER" ] && echo 1 || echo 0)"
check "marker: line1 is an epoch" "1" "$(sed -n 1p "$MARKER" | grep -cE '^[0-9]+$')"
check "marker: message names the board" "1" "$(sed -n 2p "$MARKER" | grep -c "Autonomy Progress")"

# M2: next successful resolution clears it.
rc="$(run p2 "" status 42 "In review")"
check "marker: cleared on success" "0" "$([ -f "$MARKER" ] && echo 1 || echo 0)"

# M3: total gh failure -> marker written (indistinguishable from not-found;
# message hedges with "or lookup failed").
rc="$(run p2 1 status 42 "In review")"
check "marker: gh-fail exits 0" "0" "$rc"
check "marker: written on gh failure" "1" "$([ -f "$MARKER" ] && echo 1 || echo 0)"
check "marker: message hedges lookup" "1" "$(sed -n 2p "$MARKER" | grep -c "lookup failed")"

# M4: sweep resolution failure writes it too; sweep success clears it.
rc="$(GH_PROJ_TITLE="Some Other Board" run p2 "" sweep)"
check "marker: sweep not-found exits 0" "0" "$rc"
check "marker: written by sweep" "1" "$([ -f "$MARKER" ] && echo 1 || echo 0)"
rc="$(run p2 "" sweep)"
check "marker: cleared by sweep success" "0" "$([ -f "$MARKER" ] && echo 1 || echo 0)"

# M5: status option not a board column -> marker written (board exists but
# lacks the wanted column: a real board-contract misconfig, CP1 finding 3).
rc="$(run p2 "" status 42 "Bogus Column")"
check "marker: bad-column exits 0" "0" "$rc"
check "marker: written on missing column" "1" "$([ -f "$MARKER" ] && echo 1 || echo 0)"
check "marker: message names the column" "1" "$(sed -n 2p "$MARKER" | grep -c "Bogus Column")"
rc="$(run p2 "" status 42 "In review")"
check "marker: cleared by valid status" "0" "$([ -f "$MARKER" ] && echo 1 || echo 0)"

# M6: title set but owner MISSING -> misconfig, marker written (CP1 finding 1:
# this must NOT read as board-off-by-design).
cat > "$TMP/repo/.autonomy/config.yaml" <<'YML'
board:
  project_title: Autonomy Progress
YML
rc="$(run p2 "" status 42 "In review")"
check "marker: missing-owner exits 0" "0" "$rc"
check "marker: written on missing owner" "1" "$([ -f "$MARKER" ] && echo 1 || echo 0)"

# M7: owner fails the login grammar -> marker written.
cat > "$TMP/repo/.autonomy/config.yaml" <<'YML'
board:
  owner: bad_owner
  project_title: Autonomy Progress
YML
rc="$(run p2 "" status 42 "In review")"
check "marker: invalid-owner exits 0" "0" "$rc"
check "marker: written on invalid owner" "1" "$([ -f "$MARKER" ] && echo 1 || echo 0)"

# M8: empty title = board off by design (SD-31) -> stale marker CLEARED, no
# false alarm. (Marker still present from M7.)
cat > "$TMP/repo/.autonomy/config.yaml" <<'YML'
board:
  owner: Luke-Bradford
  project_title: ""
YML
rc="$(run p2 "" status 42 "In review")"
check "marker: empty-title exits 0" "0" "$rc"
check "marker: cleared when board off" "0" "$([ -f "$MARKER" ] && echo 1 || echo 0)"
# restore the real config for any later checks
cat > "$TMP/repo/.autonomy/config.yaml" <<'YML'
board:
  owner: Luke-Bradford
  project_title: Autonomy Progress
YML
```

- [ ] **Step 2: Run to verify they fail**

Run: `bash tests/test_board_cli.sh`
Expected: the new `marker:` checks FAIL (no marker is ever written), pre-existing checks still pass.

- [ ] **Step 3: Implement in board.sh**

Helpers, directly under `warn()` (~line 19):

```bash
# #90 item (a): persist the "configured board didn't resolve" verdict so the
# dashboard can surface it (detector->marker->chip; the dashboard renders THIS
# text, it never re-derives the verdict). Both best-effort: a marker fs error
# must never block board work (SD-6). Written atomically; absent = no warning.
BOARD_MARKER="var/autonomy-logs/board-warning"
board_mark_unresolved() {
  # $$-suffixed temp: concurrent board.sh runs must not clobber each other's
  # half-written temp before the mv (CP1 finding 6).
  { mkdir -p "$(dirname "$BOARD_MARKER")" \
      && printf '%s\n%s\n' "$(date +%s)" "$1" > "$BOARD_MARKER.tmp.$$" \
      && mv -f "$BOARD_MARKER.tmp.$$" "$BOARD_MARKER"; } 2>/dev/null || true
}
board_mark_resolved() { rm -f "$BOARD_MARKER" 2>/dev/null || true; }
```

Wiring — five touch points:

1. Rework the BOARD_CONFIGURED block (~392-405) to distinguish the three cases (CP1 finding 1):

```bash
OWNER="$(config_value_with_overlay board.owner board_owner)"
PROJECT_TITLE="$(config_value_with_overlay board.project_title board_project_title)"
BOARD_CONFIGURED=1
if [ -z "$PROJECT_TITLE" ]; then
  # Board off by design (SD-31 labels-only scaffold) -- not a misconfig.
  warn "board.owner/board.project_title not set in .autonomy/config.yaml (board updates skipped)"
  BOARD_CONFIGURED=0
  board_mark_resolved
elif [ -z "$OWNER" ]; then
  warn "board.project_title set but board.owner missing (board updates skipped)"
  BOARD_CONFIGURED=0
  board_mark_unresolved "board.project_title '$PROJECT_TITLE' set but board.owner missing -- board updates skipped"
else
  case "$OWNER" in
    -*|*[!A-Za-z0-9-]*)
      warn "board.owner '$OWNER' is not a valid GitHub login (board updates skipped)"
      BOARD_CONFIGURED=0
      board_mark_unresolved "board.owner '$OWNER' is not a valid GitHub login -- board updates skipped" ;;
  esac
fi
```
(The existing comment lines about #292 sweep degradation and prevention-log 6 re-validation stay in place around this block.)

2. Sweep project resolution (~442): the `[ -z "${SPID:-}" ]` branch adds, before its `exit 0`:
   `board_mark_unresolved "project '$PROJECT_TITLE' not found under '$OWNER' (or lookup failed) -- board updates skipped"`
   The `SFID/SDONE` missing branch (~443-445) adds:
   `board_mark_unresolved "board '$PROJECT_TITLE': Status field or '$DONE_NAME' option not found"`
   Immediately AFTER both guards pass (before `scan=`): `board_mark_resolved`.

3. status/add project resolution (~477-479): the `[ -z "${PID:-}" ]` branch adds the same not-found `board_mark_unresolved` line before its `exit 0`. For `add` (project is all it needs), clear right after the guard passes — but ONLY for add: `[ "$cmd" = "add" ] && board_mark_resolved`.

4. status field/option guards (~523-524, CP1 findings 2/3): each adds a mark before its `exit 0` —
   `board_mark_unresolved "board '$PROJECT_TITLE': Status field not found"` and
   `board_mark_unresolved "board '$PROJECT_TITLE': status '$status' is not a board column"` respectively.
   After BOTH pass (immediately before the `set_single_select` call at ~525): `board_mark_resolved`. A mutation failure after that is transient (network), not config — no mark.

5. No other changes — GH_FAIL flows through the same empty-ids branches, covered by construction.

- [ ] **Step 4: Run tests + shellcheck**

Run: `bash tests/test_board_cli.sh && shellcheck -S warning bin/board.sh tests/test_board_cli.sh`
Expected: all checks `ok`, shellcheck silent.

- [ ] **Step 5: Commit**

```bash
git add bin/board.sh tests/test_board_cli.sh
git commit -m "feat: board.sh persists a board-unresolved marker (#90 item a, detector side)"
```

---

### Task 2: dashboard_state reads the marker

**Files:**
- Modify: `lib/dashboard_state.py` (new `read_board_warning` near `read_heartbeat` ~line 1089; one line in `build_repo_state`'s return dict ~line 2092)
- Test: `tests/test_dashboard_state.py`

**Interfaces:**
- Consumes: the Task-1 marker file format.
- Produces: `build_repo_state(...)["board_warning"]` = `{"epoch": int, "message": str}` or `None`. Consumed by Task 3's render.

- [ ] **Step 1: Write the failing tests**

Follow the file's existing test-class style (find the `read_heartbeat`/marker-adjacent tests and mirror their fixture-tmpdir pattern):

```python
class TestReadBoardWarning(unittest.TestCase):
    def _w(self, tmp, content):
        p = os.path.join(tmp, "board-warning")
        with open(p, "w", encoding="utf-8") as f:
            f.write(content)
        return p

    def test_missing_file_is_none(self):
        self.assertIsNone(ds.read_board_warning("/nonexistent/board-warning"))

    def test_valid_marker_parses(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = self._w(tmp, "1751700000\nproject 'X' not found under 'o' (or lookup failed) -- board updates skipped\n")
            got = ds.read_board_warning(p)
            self.assertEqual(got["epoch"], 1751700000)
            self.assertIn("not found", got["message"])

    def test_garbage_epoch_is_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(ds.read_board_warning(self._w(tmp, "yesterday\nmsg\n")))

    def test_empty_message_is_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(ds.read_board_warning(self._w(tmp, "1751700000\n\n")))

    def test_truncated_single_line_is_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(ds.read_board_warning(self._w(tmp, "1751700000")))

    def test_oversized_file_rejected(self):
        # Oversize = malformed (board.sh never writes this) -> None, never a
        # truncated-and-trusted message (CP1 finding 4).
        with tempfile.TemporaryDirectory() as tmp:
            p = self._w(tmp, "1751700000\n" + "x" * 100000 + "\n")
            self.assertIsNone(ds.read_board_warning(p))

    def test_overlong_message_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = self._w(tmp, "1751700000\n" + "x" * 600 + "\n")
            self.assertIsNone(ds.read_board_warning(p))

    def test_extra_lines_rejected(self):
        # Contract is exactly 2 lines; extra lines = torn/corrupted write
        # (CP1 finding 5).
        with tempfile.TemporaryDirectory() as tmp:
            p = self._w(tmp, "1751700000\nmsg\nunexpected third line\n")
            self.assertIsNone(ds.read_board_warning(p))

    def test_build_repo_state_carries_key(self):
        # repo-alpha fixture has no marker -> None, key present.
        st = ds.build_repo_state(FIXTURE_REPO)
        self.assertIn("board_warning", st)
        self.assertIsNone(st["board_warning"])
```

(Use the module's existing import alias and fixture-repo constant — match whatever `test_build_repo_state`-style tests already use; if `FIXTURE_REPO` isn't the existing name, reuse the existing one.)

- [ ] **Step 2: Run to verify they fail**

Run: `python3 -m pytest tests/test_dashboard_state.py -k board_warning -x -q` (or `python3 -m unittest` if the suite runs that way — mirror run_all.sh)
Expected: FAIL `AttributeError: ... no attribute 'read_board_warning'`.

- [ ] **Step 3: Implement**

Near `read_heartbeat` (~line 1089):

```python
def read_board_warning(path):
    """#90 item (a): board.sh's board-unresolved marker (EXACTLY 2 lines:
    epoch, one-line message <=512 chars). TOTAL and STRICT: missing/torn/
    oversized/extra-lines/malformed -> None -- the warning chip is EARNED by
    a well-formed marker, never fabricated from corruption (prevention 12/18;
    CP1: oversize is rejected outright, not truncated-and-trusted)."""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            raw = f.read(4097)
    except OSError:
        return None
    if len(raw) > 4096:
        return None
    lines = raw.splitlines()
    if len(lines) != 2:
        return None
    try:
        epoch = int(lines[0].strip())
    except ValueError:
        return None
    message = lines[1].strip()
    if not message or len(message) > 512:
        return None
    return {"epoch": epoch, "message": message}
```

In `build_repo_state`'s return dict, next to `"heartbeat":` (~2092):

```python
        # #90 item (a): board.sh's own board-unresolved verdict (detector ->
        # marker -> chip; the render shows this text verbatim, no re-derivation).
        "board_warning": read_board_warning(os.path.join(logdir, "board-warning")),
```

- [ ] **Step 4: Run the tests**

Run: `bash tests/run_all.sh` (dashboard_state portion) — all pass.

- [ ] **Step 5: Commit**

```bash
git add lib/dashboard_state.py tests/test_dashboard_state.py
git commit -m "feat: dashboard state reads the board-unresolved marker (#90 item a)"
```

---

### Task 3: render the chip + browser verify

**Files:**
- Modify: `lib/dashboard_page.html` (repo header render ~line 1051-1062, next to `laneWarn`)

**Interfaces:**
- Consumes: `r.board_warning` (`{epoch, message}` or null) from Task 2.

- [ ] **Step 1: Implement the chip**

After the `laneWarn` const (~1052):

```js
    // #90 item (a): board.sh could not resolve the configured Projects board
    // (marker written by the detector itself; message shown verbatim). Short
    // fixed chip text -- the rail is narrow; the full message lives in title.
    const bw=r.board_warning;
    const boardWarn = bw&&bw.message
      ? `<span class="lbad" title="${esc(bw.message)} — board updates are being skipped (display only; fix .autonomy/config.yaml or create the board)">⚠ board unresolved</span>` : "";
```

And in the repo header template (~1062) render it after `laneWarn`:

```js
      ${repoHOpen}<span class="nm">${esc(dispName(r.name))}</span>${laneWarn}${boardWarn}
```

(Reuses the `.lbad` class — no new CSS. The skip-unchanged rebuild guard (#164/#238) is unaffected: the chip is plain static markup with no qreset/agox cells.)

- [ ] **Step 2: Full local gates**

Run: `bash tests/run_all.sh && shellcheck -S warning start bin/*.sh bin/agents/*.sh tests/*.sh templates/autonomy-pack/qa/*.sh`
Expected: suite green, shellcheck silent. (test_dashboard_server has fixed-byte-window assertions — if one breaks on innocent growth, widen it structurally, don't trim the feature.)

- [ ] **Step 3: Browser verify (dashboard skill loop)**

Build a throwaway repo (committed fixtures stay untouched):
```bash
mkdir -p /tmp/bw-repo/.autonomy /tmp/bw-repo/var/autonomy-logs
printf 'board:\n  owner: someone\n  project_title: Ghost Board\n' > /tmp/bw-repo/.autonomy/config.yaml
printf '%s\nproject '\''Ghost Board'\'' not found under '\''someone'\'' (or lookup failed) -- board updates skipped\n' "$(date +%s)" > /tmp/bw-repo/var/autonomy-logs/board-warning
```
Kill any port-squatter first (`lsof -tnP -iTCP:8790 | xargs kill 2>/dev/null`), launch `python3 bin/dashboard.py --repo /tmp/bw-repo --port 8790`, drive `/` via chrome-devtools: chip renders `⚠ board unresolved` with the message in the title, zero console errors, `/api/state` 200 and its repo name matches `bw-repo`. Then remove the marker file, confirm the chip disappears on the next poll. Also load `/` against `tests/fixtures/repo-alpha` (no marker → no chip, no errors). Kill the server.

- [ ] **Step 4: Commit**

```bash
git add lib/dashboard_page.html
git commit -m "feat: fleet rail renders the board-unresolved chip (#90 item a)"
```

---

### Task 4: PR

- [ ] Branch is `feat/90-board-warning-chip` (created before Task 1; all commits on it).
- [ ] Pre-push checklist (run_all + shellcheck + pre-flight-review), Codex checkpoint 2 on the diff.
- [ ] Push FOREGROUND, `gh pr create` per pr-authoring (security-model section: marker is repo-local under var/, written only by board.sh; the message embeds config-sourced strings — OWNER is grammar-validated before use (prevention 6), PROJECT_TITLE is data-only (never argv/filename) and the dashboard escapes the whole message via esc() before innerHTML, with strict 2-line/512-char parse limits; no new network surface). PR body must NOT contain any close-keyword+`#90` token sequence, even quoted/negated (#301) — say "#90 stays open (items b + onboarding UI remain)".
- [ ] Poll review bot + CI; resolve comments; merge via safe_merge.sh; board.sh status 90 back to "Ready" (multi-slice ticket stays open).
