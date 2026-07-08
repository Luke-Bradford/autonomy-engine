# Phase Track Slice B Implementation Plan (#312)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the two SD-32-approved observed milestones to the #187 phase track — a `board` segment evidenced by board.sh's own transition log (new, this slice) and a `tests` segment evidenced by run_all.sh gate markers parsed from session logs.

**Architecture:** board.sh appends one line per SUCCESSFUL status transition to an engine-owned append-only log under `var/autonomy-logs/` (best-effort, warn-never-block). `parse_session_log` gains a `tests_ran` verdict by line-exact-matching run_all.sh's terminal markers inside tool_result content. `phase_track` gains an optional `evidence` param; evidence segments are INSERTED AFTER gate stamping so the frontier (`current`) logic is untouched, and they carry only `done` (evidence exists) or `empty` (no evidence) — never guessed. Renderer + CSS add the `empty` treatment and a red/green tests verdict.

**Tech Stack:** bash 3.2.57 (board.sh), Python 3 stdlib (lib/dashboard_state.py, bin/dashboard.py), vanilla JS/CSS (lib/dashboard_page.html).

## Global Constraints

- macOS `/bin/bash` 3.2.57: no `mapfile`, no globstar, no `declare -A`, no `${var,,}`.
- Python 3 stdlib only.
- board.sh is BEST-EFFORT: every failure path warns to stderr and exits 0; the new log write must never block a transition (SD-6).
- `phase_track` / `parse_session_log` / `board_transitions` are total: feed the whole-page render, must never raise (prevention-log #12).
- Degrade to truth: a milestone is `done` ONLY on evidence; absent/garbled → `empty` (prevention-log #18 — the healthy verdict is EARNED). Never fail-open (#3).
- `shellcheck -S warning` clean incl. tests/*.sh (prevention-log #19).
- Repo-agnostic: no target-repo values in bin/ or lib/.
- Evidence log path: `var/autonomy-logs/board-transitions.log`, relative to the target repo cwd (board.sh contract: run FROM the target repo; same idiom as `BOARD_MARKER`).
- Log line format: `<epoch>\t<issue>\t<status>` (status verbatim as written, e.g. `In Progress`).

---

### Task 1: board.sh transition log

**Files:**
- Modify: `bin/board.sh` (status success branch, ~line 584)
- Test: `tests/test_board_cli.sh`

**Interfaces:**
- Produces: append-only `var/autonomy-logs/board-transitions.log`, one `epoch\tissue\tstatus` line per successful Status mutation. Task 2's parser consumes this exact format.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_board_cli.sh` (before the final summary/exit block):

```bash
# T: transition log (#312 Slice B) -- a SUCCESSFUL status write appends one
# epoch<TAB>issue<TAB>status line to var/autonomy-logs/board-transitions.log;
# a FAILED mutation appends nothing. Best-effort: rc stays 0 either way.
TLOG="$TMP/repo/var/autonomy-logs/board-transitions.log"
rm -f "$TLOG"
rc="$(run p2 "" status 42 "In review")"
check "tlog: successful status exits 0" "0" "$rc"
check "tlog: one line appended" "1" "$(wc -l < "$TLOG" 2>/dev/null | tr -d ' ')"
tline="$(tail -1 "$TLOG" 2>/dev/null)"
check "tlog: line is epoch<TAB>issue<TAB>status" "42	In review" "$(printf '%s' "$tline" | cut -f2-)"
check "tlog: epoch field numeric" "1" "$(printf '%s' "$tline" | cut -f1 | grep -c '^[0-9][0-9]*$')"
rc="$(GH_MUTFAIL=1 run p2 "" status 42 "In review")"
check "tlog: failed mutation exits 0" "0" "$rc"
check "tlog: failed mutation appends nothing" "1" "$(wc -l < "$TLOG" | tr -d ' ')"
```

The fake `gh` needs a `GH_MUTFAIL` knob — in the `cat > "$TMP/bin/gh"` heredoc, change the `*updateProjectV2ItemFieldValue*` case to:

```bash
  *updateProjectV2ItemFieldValue*)
    if [ -n "\${GH_MUTFAIL:-}" ]; then exit 1; fi
    echo "SET \$args" >> "$TMP/mutations"
    printf '{"data":{"updateProjectV2ItemFieldValue":{"projectV2Item":{"id":"ITEM"}}}}' ;;
```

And thread `GH_MUTFAIL="${GH_MUTFAIL:-}"` through the `run()` env line (next to `GH_ISSUE_EMPTY`).

NOTE: with `GH_MUTFAIL=1` the earlier Priority mutation also fails — that path already warn-skips, so only the two new checks observe it.

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test_board_cli.sh`
Expected: `FAIL - tlog: one line appended` (no log written yet); prior checks all `ok`.

- [ ] **Step 3: Implement**

In `bin/board.sh`, the status success branch currently reads:

```bash
  if set_single_select "$PID" "$ITEM" "$FID" "$OPT_ID"; then
    warn "#$issue -> $status"
  else
    warn "failed to set #$issue status (skip)"
  fi
```

Change to:

```bash
  if set_single_select "$PID" "$ITEM" "$FID" "$OPT_ID"; then
    warn "#$issue -> $status"
    # #312 Slice B: append-only transition log -- the engine-owned evidence
    # the dashboard's phase track stamps its `board` milestone from. ONLY a
    # confirmed write lands here (this success branch), so a log line is an
    # honest observed fact. Best-effort like every board.sh path (SD-6): an
    # fs failure warns and never blocks the transition that just succeeded.
    { mkdir -p var/autonomy-logs \
        && printf '%s\t%s\t%s\n' "$(date +%s)" "$issue" "$status" \
           >> var/autonomy-logs/board-transitions.log; } 2>/dev/null \
      || warn "transition log write failed (skip)"
  else
    warn "failed to set #$issue status (skip)"
  fi
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bash tests/test_board_cli.sh` — all `ok`, exit 0.
Run: `shellcheck -S warning bin/board.sh tests/test_board_cli.sh` — clean.

- [ ] **Step 5: Commit**

```bash
git add bin/board.sh tests/test_board_cli.sh
git commit -m "feat: board.sh logs successful status transitions (#312 Slice B evidence source)"
```

---

### Task 2: `board_transitions` parser in dashboard_state

**Files:**
- Modify: `lib/dashboard_state.py` (new function near `phase_track`)
- Test: `tests/test_dashboard_state.py`

**Interfaces:**
- Consumes: Task 1's log format (`epoch\tissue\tstatus` lines).
- Produces: `board_transitions(path) -> set[int]` — the set of issue numbers with at least one logged transition. Missing/unreadable file → `set()`. Garbled lines skipped. Task 5 calls it.

- [ ] **Step 1: Write the failing test**

Add to `tests/test_dashboard_state.py`:

```python
class BoardTransitionsTest(unittest.TestCase):
    """#312 Slice B: board.sh's transition log -> the set of issues with an
    OBSERVED board write. Total: missing file -> empty set; garbled lines
    skipped, never raised."""

    def _write(self, body):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        p = os.path.join(d, "board-transitions.log")
        with open(p, "w") as fh:
            fh.write(body)
        return p

    def test_missing_file_empty(self):
        self.assertEqual(ds.board_transitions("/nonexistent/x.log"), set())

    def test_parses_issues(self):
        p = self._write("1751700000\t42\tIn Progress\n1751700100\t42\tIn Review\n1751700200\t7\tDone\n")
        self.assertEqual(ds.board_transitions(p), {42, 7})

    def test_garbled_lines_skipped(self):
        # non-numeric epoch, non-numeric issue, empty status, wrong field
        # count: every garbled shape is skipped -- evidence is EARNED (CP1)
        p = self._write("junk\n\t\t\nx\t42\tDone\n1751700000\tNaN\tDone\n"
                        "1751700000\t42\t\n1751700000\t9\tDone\n")
        self.assertEqual(ds.board_transitions(p), {9})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m unittest tests.test_dashboard_state.BoardTransitionsTest -v`
Expected: FAIL — `AttributeError: module ... has no attribute 'board_transitions'`.

- [ ] **Step 3: Implement**

In `lib/dashboard_state.py`, directly above `def phase_track`:

```python
def board_transitions(path):
    """Issue numbers with at least one OBSERVED board write, from board.sh's
    append-only transition log (#312 Slice B). Each line is
    `epoch\\tissue\\tstatus`, written only on a CONFIRMED Status mutation, so
    membership here is honest evidence for the phase track's `board` segment.

    Total by construction (feeds the whole-page render): a missing/unreadable
    file is the normal pre-Slice-B state and yields an empty set; a garbled
    line (fs hiccup, partial append) is skipped, never raised. The verdict is
    EARNED, not defaulted (prevention-log #18) -- absence of evidence keeps
    the segment EMPTY downstream."""
    issues = set()
    try:
        with open(path, errors="replace") as fh:
            for line in fh:
                parts = line.rstrip("\n").split("\t")
                # strict 3-field shape: numeric epoch, numeric issue,
                # non-empty status. Anything less is a garbled/partial line
                # and must NOT light a milestone (CP1 -- evidence is earned).
                if len(parts) != 3 or not parts[2]:
                    continue
                if not parts[0].isdigit():
                    continue
                try:
                    issues.add(int(parts[1]))
                except ValueError:
                    continue
    except OSError:
        return set()
    return issues
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m unittest tests.test_dashboard_state.BoardTransitionsTest -v` — PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/dashboard_state.py tests/test_dashboard_state.py
git commit -m "feat: board_transitions parser -- observed board writes from the transition log (#312)"
```

---

### Task 3: `tests_ran` verdict in parse_session_log

**Files:**
- Modify: `lib/dashboard_state.py` (`parse_session_log`)
- Test: `tests/test_dashboard_state.py`

**Interfaces:**
- Produces: `parse_session_log(path)["tests_ran"]` ∈ `"green" | "red" | None`. Derived ONLY from line-exact run_all.sh terminal markers (`ALL SUITES PASS` / `ONE OR MORE SUITES FAILED`) inside tool_result content, AND only for tool_results whose originating tool_use command invoked the gate (`run_all.sh` directly, or `git push` — the pre-push hook runs the gate and its output lands in the push's result). Both filters together (CP1): a `printf 'ALL SUITES PASS'` can't fake green (wrong command), and cat/grep-ing the script's source can't either (never a bare marker LINE). Latest marker wins. Task 5 consumes it via `current_session`.

- [ ] **Step 1: Write the failing test**

Add to `tests/test_dashboard_state.py` (a helper writing stream-json lines likely exists — reuse the file's established session-log fixture idiom; the JSON payloads below are the contract):

```python
class TestsRanVerdictTest(unittest.TestCase):
    """#312 Slice B: the gate verdict is parsed from run_all.sh's terminal
    markers in tool_result content. TWO honesty filters (CP1): the result must
    belong to a tool_use whose command actually invoked the gate (run_all.sh
    or git push -- the pre-push hook), and the marker must be LINE-EXACT (so
    quoting the script's source can never fake a green). Latest marker wins;
    absent -> None."""

    def _log(self, *lines):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        p = os.path.join(d, "session-20260705T010101.log")
        with open(p, "w") as fh:
            fh.write("\n".join(json.dumps(o) for o in lines) + "\n")
        return p

    @staticmethod
    def _tool_use(tid, command):
        return {"type": "assistant", "message": {"usage": {}, "content": [
            {"type": "tool_use", "id": tid, "name": "Bash",
             "input": {"command": command}}]}}

    @staticmethod
    def _tool_result(text, tid="t1"):
        return {"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": tid,
             "content": [{"type": "text", "text": text}]}]}}

    def test_green_from_run_all(self):
        p = self._log(self._tool_use("t1", "bash tests/run_all.sh"),
                      self._tool_result("=== python: test_quota ===\nok\nALL SUITES PASS\n"))
        self.assertEqual(ds.parse_session_log(p)["tests_ran"], "green")

    def test_green_from_push_hook(self):
        p = self._log(self._tool_use("t1", "git push -u origin feat/312-x"),
                      self._tool_result("remote: ...\nALL SUITES PASS\n"))
        self.assertEqual(ds.parse_session_log(p)["tests_ran"], "green")

    def test_red_then_green_latest_wins(self):
        p = self._log(self._tool_use("t1", "bash tests/run_all.sh"),
                      self._tool_result("ONE OR MORE SUITES FAILED\n", "t1"),
                      self._tool_use("t2", "bash tests/run_all.sh"),
                      self._tool_result("ALL SUITES PASS\n", "t2"))
        self.assertEqual(ds.parse_session_log(p)["tests_ran"], "green")

    def test_red(self):
        p = self._log(self._tool_use("t1", "bash tests/run_all.sh"),
                      self._tool_result("FAIL - x\nONE OR MORE SUITES FAILED\n"))
        self.assertEqual(ds.parse_session_log(p)["tests_ran"], "red")

    def test_non_gate_command_cannot_fake_green(self):
        # a bare marker line from the WRONG command (printf/echo) is ignored
        p = self._log(self._tool_use("t1", "printf 'ALL SUITES PASS\\n'"),
                      self._tool_result("ALL SUITES PASS\n"))
        self.assertIsNone(ds.parse_session_log(p)["tests_ran"])

    def test_source_quote_not_a_verdict(self):
        # cat-ing run_all.sh: gate-named command, but the marker is embedded
        # in the echo line, never a bare LINE
        p = self._log(self._tool_use("t1", "cat tests/run_all.sh"),
                      self._tool_result('if [ "$fail" -eq 0 ]; then echo "ALL SUITES PASS"; exit 0; fi\n'))
        self.assertIsNone(ds.parse_session_log(p)["tests_ran"])

    def test_string_content_shape(self):
        # tool_result content may be a plain string, not a block list
        o = {"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "t1", "content": "ALL SUITES PASS\n"}]}}
        p = self._log(self._tool_use("t1", "bash tests/run_all.sh"), o)
        self.assertEqual(ds.parse_session_log(p)["tests_ran"], "green")

    def test_absent_none(self):
        p = self._log({"type": "system", "subtype": "init", "model": "m", "cwd": "/x"})
        self.assertIsNone(ds.parse_session_log(p)["tests_ran"])
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m unittest tests.test_dashboard_state.TestsRanVerdictTest -v`
Expected: FAIL — `KeyError: 'tests_ran'` (or None vs "green").

- [ ] **Step 3: Implement**

In `parse_session_log`:

1. Module level (near the other `_*_RE` regexes):

```python
# #312 Slice B: run_all.sh's terminal verdict markers, LINE-EXACT (^...$,
# MULTILINE). Line-exactness is one of the two honesty gates: the run PRINTS
# the bare marker on its own line, while quoting the script's source (cat/grep
# in a tool_result) yields `...echo "ALL SUITES PASS"...` -- never a bare line.
_GATE_GREEN_RE = re.compile(r"^ALL SUITES PASS$", re.MULTILINE)
_GATE_RED_RE = re.compile(r"^ONE OR MORE SUITES FAILED$", re.MULTILINE)
# The other honesty gate (CP1): a marker only counts inside the RESULT of a
# command that actually invoked the gate -- run_all.sh directly, or git push
# (the pre-push hook runs the gate; its output lands in the push's result).
# Any other command (printf/echo) can't fake a verdict.
_GATE_CMD_RE = re.compile(r"run_all\.sh|\bgit\b[^\n|;&]*\bpush\b")
```

2. Initialise `tests_ran = None` and `gate_tool_ids = set()` next to the other accumulators (`rate_limited = False` block).

3. In the existing `tool_use` handling (the `if block.get("type") == "tool_use":` branch, right after `cmd = str(inp.get("command") or "")` is computed... note `cmd` is assigned a few lines below the mention scan — add after that assignment):

```python
                        if _GATE_CMD_RE.search(cmd) and block.get("id"):
                            gate_tool_ids.add(block.get("id"))
```

4. New branch in the line loop (after the `elif t == "result":` branch, before the codex branches):

```python
            elif t == "user":
                # tool_result content: the gate verdict (#312 Slice B), but
                # ONLY for results of a gate-invoking tool_use (gate_tool_ids).
                # The content field is a block list OR a plain string depending
                # on the emitter -- normalise to text, then line-exact-match
                # the run_all.sh terminal markers. Latest marker wins (a red
                # run followed by a green re-run is honestly green).
                for block in ((o.get("message") or {}).get("content") or []):
                    if (not isinstance(block, dict)
                            or block.get("type") != "tool_result"
                            or block.get("tool_use_id") not in gate_tool_ids):
                        continue
                    content = block.get("content")
                    if isinstance(content, str):
                        texts = [content]
                    elif isinstance(content, list):
                        texts = [c.get("text") or "" for c in content
                                 if isinstance(c, dict) and c.get("type") == "text"]
                    else:
                        continue
                    for text in texts:
                        g = None
                        for m in _GATE_GREEN_RE.finditer(text):
                            g = ("green", m.start())
                        for m in _GATE_RED_RE.finditer(text):
                            if g is None or m.start() > g[1]:
                                g = ("red", m.start())
                        if g:
                            tests_ran = g[0]
```

5. Add `"tests_ran": tests_ran,` to the returned dict (next to `"rate_limited"`).

Guard check: `(o.get("message") or {}).get("content")` may be a plain string on some emitters — the `for block in ... or []` iteration over a string would yield characters; add `if not isinstance(blocks, list): continue` (bind `blocks` first). Keep the function total.

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m unittest tests.test_dashboard_state -v` — all PASS (existing suite must stay green: the new `user` branch must not disturb anything else).

- [ ] **Step 5: Commit**

```bash
git add lib/dashboard_state.py tests/test_dashboard_state.py
git commit -m "feat: parse_session_log extracts the run_all gate verdict (tests_ran, #312)"
```

---

### Task 4: evidence segments in phase_track

**Files:**
- Modify: `lib/dashboard_state.py` (`phase_track`)
- Test: `tests/test_dashboard_state.py`

**Interfaces:**
- Consumes: nothing new from Tasks 1–3 (evidence arrives pre-digested).
- Produces: `phase_track(focus, gate_chain, evidence=None)`. `evidence` is `None` (legacy: track unchanged, no new segments) or a dict `{"board": bool, "tests": "green"|"red"|None}`. With evidence: segment `{"step":"board","state":"done"|"empty"}` INSERTED at position 0; segment `{"step":"tests","state":"done","verdict":"green"|"red"}` or `{"step":"tests","state":"empty"}` inserted right after `branch`. Gate segments (`branch` + chain) keep their exact Slice A states. Task 5 passes evidence; Task 6 renders `empty` + `verdict`.

- [ ] **Step 1: Write the failing test**

Add to `tests/test_dashboard_state.py` (inside or alongside the existing phase-track test class, reusing its `self.BOT` chain constant):

```python
class PhaseTrackEvidenceTest(unittest.TestCase):
    """#312 Slice B: board/tests milestones join the spine ONLY as evidence --
    done on an observed fact, empty otherwise; NEVER current/outline, and the
    gate frontier logic is byte-identical with them present."""

    BOT = [{"step": "pr"}, {"step": "review", "actor": "bot"}, {"step": "merge"}]

    OPEN_PR = {"number": 5, "ci": "passing", "review": "approved"}

    def _steps(self, track):
        return [(s["step"], s["state"]) for s in track]

    def test_legacy_no_evidence_param_unchanged(self):
        tr = ds.phase_track(self.OPEN_PR, self.BOT)
        self.assertEqual([s["step"] for s in tr], ["branch", "pr", "review", "merge"])

    def test_evidence_segments_inserted(self):
        tr = ds.phase_track(self.OPEN_PR, self.BOT,
                            {"board": True, "tests": "green"})
        self.assertEqual([s["step"] for s in tr],
                         ["board", "branch", "tests", "pr", "review", "merge"])
        self.assertEqual(tr[0]["state"], "done")            # board observed
        self.assertEqual(tr[2]["state"], "done")            # tests observed
        self.assertEqual(tr[2]["verdict"], "green")

    def test_no_evidence_is_empty_never_done(self):
        tr = ds.phase_track({"number": 5, "completed": True, "merged_epoch": 9},
                            self.BOT, {"board": False, "tests": None})
        by = {s["step"]: s for s in tr}
        # completed marks every GATE done -- but a milestone without evidence
        # stays empty even on a completed ticket (never imply certainty)
        self.assertEqual(by["board"]["state"], "empty")
        self.assertEqual(by["tests"]["state"], "empty")
        self.assertNotIn("verdict", by["tests"])
        self.assertEqual(by["merge"]["state"], "done")

    def test_red_tests_are_observed_done_with_verdict(self):
        tr = ds.phase_track(self.OPEN_PR, self.BOT,
                            {"board": False, "tests": "red"})
        by = {s["step"]: s for s in tr}
        self.assertEqual(by["tests"]["state"], "done")
        self.assertEqual(by["tests"]["verdict"], "red")

    def test_frontier_unmoved_by_empty_milestones(self):
        # open PR, review NOT approved: frontier must stay on `review`,
        # not get eaten by an empty tests/board segment
        tr = ds.phase_track({"number": 5, "ci": "pending", "review": ""},
                            self.BOT, {"board": False, "tests": None})
        by = {s["step"]: s for s in tr}
        self.assertEqual(by["review"]["state"], "current")
        self.assertEqual(by["tests"]["state"], "empty")

    def test_malformed_evidence_degrades(self):
        tr = ds.phase_track(self.OPEN_PR, self.BOT, "junk")
        self.assertEqual([s["step"] for s in tr], ["branch", "pr", "review", "merge"])
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m unittest tests.test_dashboard_state.PhaseTrackEvidenceTest -v`
Expected: FAIL — evidence segments absent / TypeError on the third arg.

- [ ] **Step 3: Implement**

Change the signature to `def phase_track(focus, gate_chain, evidence=None):` and extend the docstring with:

```
    #312 Slice B: `evidence` (optional) carries the two SD-32 observed-
    milestone sources, pre-digested by the caller:
        {"board": bool, "tests": "green"|"red"|None}
    With evidence present, a `board` segment (position 0) and a `tests`
    segment (right after `branch`) join the spine as EVIDENCE-ONLY marks:
    `done` when the fact was observed (tests also carry a `verdict`),
    `empty` otherwise -- never `current`, never `outline`, and never
    inferred from ticket state (a completed ticket with no logged board
    write keeps an EMPTY board segment: certainty is earned, prevention-log
    #18). They are inserted AFTER gate stamping, so the Slice A frontier
    logic is untouched by construction. A malformed (non-dict) evidence
    degrades to the legacy no-evidence track.
```

Then, at the END of the function, replace each of the three `return spine` sites with `return _with_evidence(spine, evidence)` and add above `phase_track`:

```python
def _with_evidence(spine, evidence):
    """Insert the #312 evidence-only milestone segments into a fully-stamped
    gate spine. Evidence marks are done/empty ONLY -- inserting after gate
    stamping keeps the frontier (`current`) logic byte-identical."""
    if not isinstance(evidence, dict):
        return spine
    board = {"step": "board",
             "state": "done" if evidence.get("board") else "empty"}
    verdict = evidence.get("tests")
    if verdict in ("green", "red"):
        tests = {"step": "tests", "state": "done", "verdict": verdict}
    else:
        tests = {"step": "tests", "state": "empty"}
    out = [board]
    for seg in spine:
        out.append(seg)
        if seg.get("step") == "branch":
            out.append(tests)
    return out
```

(Empty spine — the falsy-focus `return []` — must stay `[]`: keep that early return AS IS, do not wrap it.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m unittest tests.test_dashboard_state -v` — all PASS (the existing PhaseTrack tests prove legacy calls are byte-identical).

- [ ] **Step 5: Commit**

```bash
git add lib/dashboard_state.py tests/test_dashboard_state.py
git commit -m "feat: phase_track evidence segments -- board + tests milestones, done/empty only (#312)"
```

---

### Task 5: `focus_issue` resolver + wire evidence in bin/dashboard.py

**CP1 finding this task exists for:** the open-PR focus variant's `number` is the **PR number** (bin/dashboard.py:711 builds it from the top open PR), while the transition log and `sess["ticket"]` are **issue numbers**. Keying evidence on `ft["number"]` would leave PR-backed tracks permanently empty. The issue number for that variant lives in the branch name (`feat/<n>-…`), which `ds.extract_ticket_ref` already parses.

**Files:**
- Modify: `lib/dashboard_state.py` (new `focus_issue`), `bin/dashboard.py:711` (add `branch` to the open-PR focus) and `bin/dashboard.py:1070-1072` (the `ft["track"]` attach point)
- Test: `tests/test_dashboard_state.py`

**Interfaces:**
- Consumes: `ds.board_transitions(path) -> set[int]` (Task 2), `current_session["tests_ran"]` (Task 3), `ds.phase_track(ft, chain, evidence)` (Task 4), existing `ds.extract_ticket_ref(branch)`.
- Produces: `focus_issue(focus) -> int | None` — the ISSUE number for any of the three focus variants, or None when it can't be honestly derived (evidence then stays empty).

- [ ] **Step 1: Write the failing test**

```python
class FocusIssueTest(unittest.TestCase):
    """#312 (CP1): evidence must be keyed on the ISSUE number. The open-PR
    focus variant's `number` is the PR number -- its issue ref comes from the
    branch name; completed/issue variants already carry the issue number."""

    def test_open_pr_variant_uses_branch_ref(self):
        ft = {"number": 313, "ci": "passing", "review": "",
              "branch": "feat/312-phase-track-slice-b"}
        self.assertEqual(ds.focus_issue(ft), 312)

    def test_open_pr_variant_no_branch_ref_none(self):
        ft = {"number": 313, "ci": "passing", "review": "", "branch": "hotfix"}
        self.assertIsNone(ds.focus_issue(ft))

    def test_completed_variant_number_is_issue(self):
        ft = {"number": 312, "completed": True, "merged_epoch": 9, "pr_number": 313}
        self.assertEqual(ds.focus_issue(ft), 312)

    def test_issue_variant_number_is_issue(self):
        ft = {"number": 312, "in_progress": True, "state": "open"}
        self.assertEqual(ds.focus_issue(ft), 312)

    def test_malformed_none(self):
        self.assertIsNone(ds.focus_issue(None))
        self.assertIsNone(ds.focus_issue({}))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m unittest tests.test_dashboard_state.FocusIssueTest -v`
Expected: FAIL — no attribute `focus_issue`.

- [ ] **Step 3: Implement**

In `lib/dashboard_state.py`, next to `phase_track`:

```python
def focus_issue(focus):
    """The ISSUE number behind a focus_ticket, for keying #312 evidence.
    The three variants carry it differently (CP1): the open-PR variant's
    `number` is the PR NUMBER -- its issue ref is parsed from the branch
    name; the completed and issue-only variants' `number` IS the issue.
    None when it can't be honestly derived (evidence then stays empty --
    a wrong key would light another ticket's milestones). Total: any
    malformed focus -> None."""
    if not isinstance(focus, dict) or not focus:
        return None
    if "ci" in focus or "review" in focus:
        return extract_ticket_ref(str(focus.get("branch") or ""))
    n = focus.get("number")
    return n if isinstance(n, int) else None
```

In `bin/dashboard.py:709-711`, add the branch to the open-PR focus:

```python
        focus = {"number": top["number"], "title": top["title"], "url": top["url"],
                 "branch": top["branch"], "ci": top["ci"], "review": top["review"]}
```

At the attach point (`bin/dashboard.py:1070-1072`), replace:

```python
        ft = git.get("focus_ticket")
        if ft:
            ft["track"] = ds.phase_track(ft, st.get("merge_gate_chain"))
```

with:

```python
        ft = git.get("focus_ticket")
        if ft:
            # #312 Slice B evidence, pre-digested for phase_track and keyed on
            # the ISSUE number (focus_issue -- the open-PR variant's `number`
            # is the PR number): the board milestone from board.sh's own
            # transition log (written only on a confirmed write), the tests
            # verdict from THIS ticket's live/most-recent session -- scoped so
            # another ticket's gate run can never light this track.
            issue = ds.focus_issue(ft)
            evidence = {
                "board": issue is not None and issue in ds.board_transitions(
                    os.path.join(repo, "var", "autonomy-logs",
                                 "board-transitions.log")),
                "tests": (sess.get("tests_ran")
                          if issue is not None and sess.get("ticket") == issue
                          else None),
            }
            ft["track"] = ds.phase_track(ft, st.get("merge_gate_chain"),
                                         evidence)
```

(Check `extract_ticket_ref`'s exact signature/behaviour before use — it already parses `feat/<n>-…`-style refs for parse_session_log; reuse as-is, do not re-implement.)

- [ ] **Step 4: Run the full python suite**

Run: `python3 -m unittest tests.test_dashboard_state tests.test_dashboard_server -v` — PASS (test_dashboard_server exercises `_collect_one` end-to-end; any breakage surfaces here).

- [ ] **Step 5: Commit**

```bash
git add lib/dashboard_state.py bin/dashboard.py tests/test_dashboard_state.py
git commit -m "feat: dashboard wires #312 evidence into the phase track, keyed on the real issue number"
```

---

### Task 6: render + CSS for `empty` and the tests verdict

**Files:**
- Modify: `lib/dashboard_page.html` (CSS ~line 138, renderer ~line 651)

**Interfaces:**
- Consumes: segments with `state: "empty"` and `verdict: "green"|"red"` from Task 4.

- [ ] **Step 1: CSS**

After `.ptrack .pseg.outline{...}` (line 138), add:

```css
.ptrack .pseg.empty{color:var(--dim);opacity:.45;border-color:transparent}
.ptrack .pseg.done.vred{color:var(--bad,#e05555);border-color:currentColor}
```

(`empty` is deliberately border-free and faded: SD-32 reserves dashed for the configured OUTLINE layer and dotted for the future prompt-phases layer, so no-evidence gets NO border idiom at all. If `--bad` doesn't exist as a CSS var, use the page's existing failure color token — grep for `c-failing`/`c-error` color and reuse it.)

- [ ] **Step 2: Renderer**

Replace the `segs` mapping (lines 652-656):

```js
        const segs=trk.map(s=>{
          const lbl=s.step==="review"?(s.actor==="bot"?"🤖 review":"👤 review")
                   :s.step==="tests"&&s.verdict?(s.verdict==="green"?"tests ✓":"tests ✗")
                   :s.step;
          const tip=s.state==="done"?"observed — done":s.state==="current"?"in progress now":s.state==="empty"?"no evidence — not observed":"configured — not yet reached";
          const vcls=s.verdict==="red"?" vred":"";
          return `<span class="pseg ${esc(s.state)}${vcls}" title="${esc(tip)}">${esc(lbl)}</span>`;
        }).join(`<span class="psep">→</span>`);
```

(`tests ✗` keeps state `done` — a red run IS an observed fact; the `vred` class carries the color. The tip for a red-done segment stays "observed — done", which is honest: the gate ran.)

- [ ] **Step 3: Full local gates**

Run: `bash tests/run_all.sh` — `ALL SUITES PASS`.
Run: `shellcheck -S warning start bin/*.sh bin/agents/*.sh tests/*.sh templates/autonomy-pack/qa/*.sh` — clean.

- [ ] **Step 4: Browser verify (dashboard skill loop)**

Kill any stale server first (`lsof -tnP -iTCP:8790 | xargs kill 2>/dev/null`). Launch `python3 bin/dashboard.py --repo tests/fixtures/repo-alpha --port 8790`. To see the new segments live, build a throwaway /tmp repo fixture with a `var/autonomy-logs/board-transitions.log` containing the ISSUE number and a session log whose gate tool_use (`bash tests/run_all.sh`) precedes a bare `ALL SUITES PASS` tool_result (established /tmp-fixture technique). CP1: the fixture MUST exercise the PR≠issue case — an issue-only focus keyed by session ticket (issue N) AND, if feasible with the fixture's gh-free git state, verify via `/api/state` JSON that a PR-variant track keys evidence off the branch ref, not the PR number. Assert: track shows `board → branch → tests ✓ → …`, evidence-less repos show faded `board`/`tests` (empty), ZERO console errors, `/api/state` 200. Kill the server.

- [ ] **Step 5: Commit**

```bash
git add lib/dashboard_page.html
git commit -m "feat: phase track renders empty milestones + red/green tests verdict (#312)"
```

---

### Task 7: ship

- [ ] Branch was created before Task 1 (`feat/312-phase-track-slice-b`); run pre-flight-review + pre-push-checklist; Codex checkpoint 2; push FOREGROUND; open PR per pr-authoring (security model: new parsed inputs are engine-owned local files — transition log + session logs; both parsers total, evidence-only, no privilege; board.sh write is best-effort append inside the repo's own var/). Poll bot + CI; resolve comments; `safe_merge.sh`; `board.sh status 312 Done` after MERGED confirmation.
