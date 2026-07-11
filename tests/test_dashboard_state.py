"""Unit tests for lib/dashboard_state.py -- the read-only control-room state
model. Parses the engine's real emitted artifacts (stream-json session logs,
supervisor.log, the lock/sentinel lifecycle, config.yaml) into the shape the
P1 page renders. Stdlib only; no network (git/gh state is injected)."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))
FIX = os.path.join(HERE, "fixtures", "repo-alpha")
LOGDIR = os.path.join(FIX, "var", "autonomy-logs")

import dashboard_state as ds  # noqa: E402


class TestMergeGateChain(unittest.TestCase):
    """#187 (UI-4 phase track, configured layer): the OUTLINE segments = the
    remaining merge-gate chain derived from the repo's OWN
    `merge_gate.strategy`, mirroring safe_merge.sh's four strategies. Read-only
    DISPLAY derivation -- it draws what the gate looks like, it never gates a
    merge. Acceptance (spec): 'degrade to truth, never guess' -- an unknown
    strategy degrades to the one certain fact (a PR was opened), never a fake
    tail. The QA/custom-role dimension is a documented follow-up; this slice is
    the universal layer only."""

    def test_manual_terminates_at_a_human(self):
        # safe_merge: manual leaves the PR open for the operator to merge
        self.assertEqual(
            ds.merge_gate_chain("manual"),
            [{"step": "pr"}, {"step": "review", "actor": "human"}])

    def test_empty_strategy_defaults_to_manual(self):
        # safe_merge uses ${STRATEGY:-manual}; the display must match
        self.assertEqual(ds.merge_gate_chain(""), ds.merge_gate_chain("manual"))
        self.assertEqual(ds.merge_gate_chain(None), ds.merge_gate_chain("manual"))

    def test_ci_only_merges_on_ci_no_review(self):
        self.assertEqual(
            ds.merge_gate_chain("ci_only"),
            [{"step": "pr"}, {"step": "merge"}])

    def test_bot_comment_has_a_bot_review_gate(self):
        self.assertEqual(
            ds.merge_gate_chain("bot_comment"),
            [{"step": "pr"}, {"step": "review", "actor": "bot"}, {"step": "merge"}])

    def test_gh_review_has_a_human_review_gate(self):
        self.assertEqual(
            ds.merge_gate_chain("gh_review"),
            [{"step": "pr"}, {"step": "review", "actor": "human"}, {"step": "merge"}])

    def test_unknown_strategy_degrades_to_pr_only(self):
        # never invent a tail we cannot vouch for
        self.assertEqual(ds.merge_gate_chain("mystery"), [{"step": "pr"}])

    def test_whitespace_and_case_are_tolerated(self):
        self.assertEqual(ds.merge_gate_chain("  bot_comment  "),
                         ds.merge_gate_chain("bot_comment"))

    def test_non_string_strategy_degrades_without_crashing(self):
        # build_repo_state renders the whole dashboard -- a malformed config
        # shape (e.g. an un-flattened `merge_gate:` dict block) must degrade,
        # never raise. None is unset -> manual; a dict/int is malformed -> [pr].
        for bad in ({"strategy": "bot_comment"}, 5, ["ci_only"]):
            self.assertEqual(ds.merge_gate_chain(bad), [{"step": "pr"}])

    def test_build_repo_state_reflects_configured_strategy_not_default(self):
        # Regression guard: build_repo_state must surface the repo's ACTUAL
        # strategy, never silently fall back to the manual chain. `_read_config`
        # flattens `merge_gate.strategy` onto the flat key `config["merge_gate"]`,
        # so the call site reads `config.get("merge_gate")` (a string), NOT
        # `config.get("merge_gate.strategy")` (which would be None -> always
        # manual -- the exact bug this asserts against).
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, True)
        os.makedirs(os.path.join(d, ".autonomy"))
        os.makedirs(os.path.join(d, "var", "autonomy-logs"))
        with open(os.path.join(d, ".autonomy", "config.yaml"), "w") as fh:
            fh.write('merge_gate:\n  strategy: "bot_comment"\n')
        st = ds.build_repo_state(d)
        self.assertEqual(st["config"]["merge_gate"], "bot_comment")
        self.assertEqual(
            st["merge_gate_chain"],
            [{"step": "pr"}, {"step": "review", "actor": "bot"}, {"step": "merge"}])


class TestPhaseTrack(unittest.TestCase):
    """#187 UI-4: the selected-lane center-zone phase track. `phase_track` marks
    the configured gate spine (a leading `branch` step + merge_gate_chain) with
    ONLY observed GitHub-flow facts carried on the focus_ticket. The acceptance
    test (from the spec, settled with the operator) is that the track must NEVER
    imply certainty it lacks: a step is 'done' only when a fact asserts it,
    'current' is the single live frontier gate, everything else is 'outline'
    (configured but not reached). Pure/total -- it feeds the whole-page render,
    so any focus/chain shape degrades, never raises."""

    BOT = [{"step": "pr"}, {"step": "review", "actor": "bot"}, {"step": "merge"}]
    MANUAL = [{"step": "pr"}, {"step": "review", "actor": "human"}]

    def _states(self, track):
        return [(s["step"], s["state"]) for s in track]

    def test_none_focus_is_empty(self):
        # no ticket in focus -> no track (never a phantom spine)
        self.assertEqual(ds.phase_track(None, self.BOT), [])
        self.assertEqual(ds.phase_track({}, self.BOT), [])

    def test_non_dict_focus_degrades_without_raising(self):
        # builder-totality: a malformed focus_ticket must yield [] on the
        # whole-page render path, never raise on .get() and blank the repo
        for bad in ("ticket", 7, ["#5"], object()):
            self.assertEqual(ds.phase_track(bad, self.BOT), [])

    def test_leading_step_is_always_branch(self):
        tr = ds.phase_track({"number": 1, "in_progress": True, "state": "open"},
                            self.BOT)
        self.assertEqual(tr[0]["step"], "branch")

    def test_completed_marks_every_step_done(self):
        # a merged ticket: every configured milestone is observably behind us
        tr = ds.phase_track({"number": 1, "completed": True,
                             "merged_epoch": 123}, self.BOT)
        self.assertEqual(self._states(tr),
                         [("branch", "done"), ("pr", "done"),
                          ("review", "done"), ("merge", "done")])

    def test_merged_epoch_alone_counts_as_completed(self):
        tr = ds.phase_track({"number": 1, "merged_epoch": 123}, self.MANUAL)
        self.assertTrue(all(s["state"] == "done" for s in tr))

    def test_open_pr_awaiting_review_marks_review_current(self):
        # variant A: an open PR (carries ci/review), review not yet approved ->
        # branch+pr observed done, review is the live frontier, merge outline
        tr = ds.phase_track(
            {"number": 5, "ci": "pending", "review": ""}, self.BOT)
        self.assertEqual(self._states(tr),
                         [("branch", "done"), ("pr", "done"),
                          ("review", "current"), ("merge", "outline")])

    def test_open_pr_approved_marks_merge_current(self):
        # review approved but not yet merged -> merge is the frontier
        tr = ds.phase_track(
            {"number": 5, "ci": "passing", "review": "approved"}, self.BOT)
        self.assertEqual(self._states(tr),
                         [("branch", "done"), ("pr", "done"),
                          ("review", "done"), ("merge", "current")])

    def test_open_pr_under_manual_never_asserts_a_merge(self):
        # manual chain has NO merge step (operator merges by hand); the track
        # must not invent one -- degrade to truth
        tr = ds.phase_track(
            {"number": 5, "ci": "passing", "review": ""}, self.MANUAL)
        self.assertEqual(self._states(tr),
                         [("branch", "done"), ("pr", "done"),
                          ("review", "current")])
        self.assertNotIn("merge", [s["step"] for s in tr])

    def test_issue_in_progress_marks_branch_current(self):
        # variant C: a session is working the ticket, no PR yet -> the branch is
        # the live frontier, every gate ahead is outline (not yet real)
        tr = ds.phase_track(
            {"number": 9, "state": "open", "in_progress": True}, self.BOT)
        self.assertEqual(self._states(tr),
                         [("branch", "current"), ("pr", "outline"),
                          ("review", "outline"), ("merge", "outline")])

    def test_issue_idle_marks_branch_done_rest_outline(self):
        # variant C, idle (last-worked, not busy): the branch happened but
        # nothing is live now -> no 'current', gates ahead stay outline
        tr = ds.phase_track(
            {"number": 9, "state": "open", "in_progress": False}, self.BOT)
        self.assertEqual(self._states(tr),
                         [("branch", "done"), ("pr", "outline"),
                          ("review", "outline"), ("merge", "outline")])

    def test_review_actor_glyph_is_preserved(self):
        tr = ds.phase_track(
            {"number": 5, "ci": "pending", "review": ""}, self.BOT)
        rev = [s for s in tr if s["step"] == "review"][0]
        self.assertEqual(rev["actor"], "bot")

    def test_at_most_one_current_in_every_shape(self):
        # the frontier is a single point -- never two live gates at once
        focuses = [
            {"number": 1, "completed": True, "merged_epoch": 1},
            {"number": 5, "ci": "pending", "review": ""},
            {"number": 5, "ci": "passing", "review": "approved"},
            {"number": 9, "state": "open", "in_progress": True},
            {"number": 9, "state": "open", "in_progress": False},
        ]
        for f in focuses:
            for chain in (self.BOT, self.MANUAL,
                          [{"step": "pr"}, {"step": "merge"}]):
                tr = ds.phase_track(f, chain)
                currents = [s for s in tr if s["state"] == "current"]
                self.assertLessEqual(len(currents), 1, (f, chain))

    def test_malformed_gate_chain_degrades_to_branch_only(self):
        # a bad chain (None / junk entries) must not raise and must not invent
        # steps -- the one certain fact is that a branch exists
        for bad in (None, "nope", [None, 5, {"noStep": 1}], 42):
            tr = ds.phase_track({"number": 1, "in_progress": True}, bad)
            self.assertEqual([s["step"] for s in tr], ["branch"])

    def test_does_not_mutate_the_shared_gate_chain(self):
        # merge_gate_chain is built once and shared; phase_track must copy, not
        # stamp 'state' onto the caller's segments
        chain = [{"step": "pr"}, {"step": "review", "actor": "bot"},
                 {"step": "merge"}]
        ds.phase_track({"number": 5, "ci": "pending", "review": ""}, chain)
        self.assertNotIn("state", chain[0])
        self.assertNotIn("state", chain[1])


class PhaseTrackEvidenceTest(unittest.TestCase):
    """#312 Slice B: board/tests milestones join the spine ONLY as evidence --
    done on an observed fact, empty otherwise; NEVER current/outline, and the
    gate frontier logic is byte-identical with them present."""

    BOT = [{"step": "pr"}, {"step": "review", "actor": "bot"},
           {"step": "merge"}]

    OPEN_PR = {"number": 5, "ci": "passing", "review": "approved"}

    def test_legacy_no_evidence_param_unchanged(self):
        tr = ds.phase_track(self.OPEN_PR, self.BOT)
        self.assertEqual([s["step"] for s in tr],
                         ["branch", "pr", "review", "merge"])

    def test_evidence_segments_inserted(self):
        tr = ds.phase_track(self.OPEN_PR, self.BOT,
                            {"board": True, "tests": "green"})
        self.assertEqual([s["step"] for s in tr],
                         ["board", "branch", "tests", "pr", "review", "merge"])
        self.assertEqual(tr[0]["state"], "done")            # board observed
        self.assertEqual(tr[2]["state"], "done")            # tests observed
        self.assertEqual(tr[2]["verdict"], "green")

    def test_no_evidence_is_empty_never_done(self):
        tr = ds.phase_track({"number": 5, "completed": True,
                             "merged_epoch": 9},
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
        self.assertEqual([s["step"] for s in tr],
                         ["branch", "pr", "review", "merge"])

    def test_falsy_focus_still_empty_track(self):
        self.assertEqual(
            ds.phase_track(None, self.BOT, {"board": True, "tests": "green"}),
            [])


class FocusIssueTest(unittest.TestCase):
    """#312 (CP1): evidence must be keyed on the ISSUE number. The open-PR
    focus variant's `number` is the PR number -- its issue ref comes from the
    branch name; completed/issue variants already carry the issue number."""

    def test_open_pr_variant_uses_branch_ref(self):
        ft = {"number": 313, "ci": "passing", "review": "",
              "branch": "feat/312-phase-track-slice-b"}
        self.assertEqual(ds.focus_issue(ft), 312)

    def test_open_pr_variant_no_branch_ref_none(self):
        ft = {"number": 313, "ci": "passing", "review": "",
              "branch": "hotfix"}
        self.assertIsNone(ds.focus_issue(ft))

    def test_completed_variant_number_is_issue(self):
        ft = {"number": 312, "completed": True, "merged_epoch": 9,
              "pr_number": 313}
        self.assertEqual(ds.focus_issue(ft), 312)

    def test_issue_variant_number_is_issue(self):
        ft = {"number": 312, "in_progress": True, "state": "open"}
        self.assertEqual(ds.focus_issue(ft), 312)

    def test_malformed_none(self):
        self.assertIsNone(ds.focus_issue(None))
        self.assertIsNone(ds.focus_issue({}))


class BoardTransitionsTest(unittest.TestCase):
    """#312 Slice B: board.sh's transition log -> the set of issues with an
    OBSERVED board write. Total: missing file -> empty set; garbled lines
    skipped, never raised -- evidence is EARNED (prevention-log #18)."""

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
        p = self._write("1751700000\t42\tIn Progress\n"
                        "1751700100\t42\tIn Review\n1751700200\t7\tDone\n")
        self.assertEqual(ds.board_transitions(p), {42, 7})

    def test_garbled_lines_skipped(self):
        # non-numeric epoch, non-numeric issue, empty status, wrong field
        # count: every garbled shape is skipped -- evidence is EARNED (CP1)
        p = self._write("junk\n\t\t\nx\t42\tDone\n1751700000\tNaN\tDone\n"
                        "1751700000\t42\t\n1751700000\t9\tDone\n")
        self.assertEqual(ds.board_transitions(p), {9})


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
                      self._tool_result("=== python: test_quota ===\nok\n"
                                        "ALL SUITES PASS\n"))
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

    def test_mentioning_run_all_is_not_executing_it(self):
        # CP2: grep -o emits a BARE marker line and the command NAMES
        # run_all.sh -- but doesn't execute it. Command-position match only.
        p = self._log(
            self._tool_use("t1", "grep -o 'ALL SUITES PASS' tests/run_all.sh"),
            self._tool_result("ALL SUITES PASS\n"))
        self.assertIsNone(ds.parse_session_log(p)["tests_ran"])

    def test_bare_command_position_run_all_counts(self):
        p = self._log(self._tool_use("t1", "./tests/run_all.sh"),
                      self._tool_result("ALL SUITES PASS\n"))
        self.assertEqual(ds.parse_session_log(p)["tests_ran"], "green")

    def test_source_quote_not_a_verdict(self):
        # cat-ing run_all.sh: gate-named command, but the marker is embedded
        # in the echo line, never a bare LINE
        p = self._log(self._tool_use("t1", "cat tests/run_all.sh"),
                      self._tool_result('if [ "$fail" -eq 0 ]; then echo '
                                        '"ALL SUITES PASS"; exit 0; fi\n'))
        self.assertIsNone(ds.parse_session_log(p)["tests_ran"])

    def test_string_content_shape(self):
        # tool_result content may be a plain string, not a block list
        o = {"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "t1",
             "content": "ALL SUITES PASS\n"}]}}
        p = self._log(self._tool_use("t1", "bash tests/run_all.sh"), o)
        self.assertEqual(ds.parse_session_log(p)["tests_ran"], "green")

    def test_absent_none(self):
        p = self._log({"type": "system", "subtype": "init",
                       "model": "m", "cwd": "/x"})
        self.assertIsNone(ds.parse_session_log(p)["tests_ran"])

    def test_heredoc_line_starting_with_run_all_is_not_a_gate(self):
        # review-bot BLOCKING on #313 round 3: with re.MULTILINE, `^` matched
        # the start of EVERY line, so a heredoc/multi-line string whose line
        # begins with run_all.sh earned a gate id without executing anything.
        p = self._log(
            self._tool_use("t1", 'cat <<EOF\nrun_all.sh\nEOF\n'
                                 'echo "ALL SUITES PASS"'),
            self._tool_result("run_all.sh\nALL SUITES PASS\n"))
        self.assertIsNone(ds.parse_session_log(p)["tests_ran"])

    def test_heredoc_line_starting_with_git_push_is_not_a_gate(self):
        p = self._log(
            self._tool_use("t1", 'cat <<EOF\ngit push\nEOF\n'
                                 'echo "ALL SUITES PASS"'),
            self._tool_result("git push\nALL SUITES PASS\n"))
        self.assertIsNone(ds.parse_session_log(p)["tests_ran"])

    def test_quoted_bash_run_all_is_not_a_gate(self):
        # review-bot BLOCKING on #313 round 2: `bash tests/run_all.sh` inside
        # a STRING (echo'd, not executed) must not earn a gate id -- the
        # bash/sh alternative needs command-position anchoring too.
        p = self._log(
            self._tool_use(
                "t1", 'echo "bash tests/run_all.sh"; echo "ALL SUITES PASS"'),
            self._tool_result("bash tests/run_all.sh\nALL SUITES PASS\n"))
        self.assertIsNone(ds.parse_session_log(p)["tests_ran"])

    def test_chained_bash_run_all_still_counts(self):
        p = self._log(
            self._tool_use("t1", "cd /w/tree && bash tests/run_all.sh 2>&1"),
            self._tool_result("ok\nALL SUITES PASS\n"))
        self.assertEqual(ds.parse_session_log(p)["tests_ran"], "green")

    def test_git_commit_mentioning_push_is_not_a_gate(self):
        # review-bot WARNING on #313: `git` + `push` merely CO-OCCURRING in a
        # command (push inside a commit message) must not earn a gate id --
        # push must be git's actual subcommand, in command position.
        p = self._log(
            self._tool_use("t1", 'git commit -m "push fix for failing test"'),
            self._tool_result("ALL SUITES PASS\n"))
        self.assertIsNone(ds.parse_session_log(p)["tests_ran"])

    def test_git_push_not_in_command_position_is_not_a_gate(self):
        p = self._log(self._tool_use("t1", "echo git push"),
                      self._tool_result("ALL SUITES PASS\n"))
        self.assertIsNone(ds.parse_session_log(p)["tests_ran"])

    def test_chained_git_push_still_counts(self):
        # the loop's real shape: git add/commit && git push -u origin <branch>
        p = self._log(
            self._tool_use("t1", "git add -A && git push -u origin feat/312-x"),
            self._tool_result("remote: ...\nALL SUITES PASS\n"))
        self.assertEqual(ds.parse_session_log(p)["tests_ran"], "green")

    def test_git_option_before_push_subcommand_counts(self):
        p = self._log(self._tool_use("t1", "git -C /w/tree push origin main"),
                      self._tool_result("ALL SUITES PASS\n"))
        self.assertEqual(ds.parse_session_log(p)["tests_ran"], "green")


class TestConfigOverlay(unittest.TestCase):
    """#202: the persistent operator overlay (var/autonomy-logs/config-overrides)
    shadows committed config.yaml for model/effort in the render model, and is
    RE-VALIDATED the same way the supervisor validates it -- a corrupt overlay
    must not show a value the supervisor silently ignores."""
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.repo = self._td.name
        os.makedirs(os.path.join(self.repo, ".autonomy"))
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("agent:\n  model:\n    primary: claude-sonnet-5\n  effort: low\n")
        self.logdir = os.path.join(self.repo, "var", "autonomy-logs")
        os.makedirs(self.logdir)

    def tearDown(self):
        self._td.cleanup()

    def _overlay(self, text):
        with open(os.path.join(self.logdir, "config-overrides"), "w") as fh:
            fh.write(text)

    def test_overlay_shadows_and_flags(self):
        self._overlay("model=claude-opus-4-8\n")
        cfg = ds._read_config(self.repo)
        self.assertEqual(cfg["model"], "claude-opus-4-8")   # overlay shadows committed
        self.assertEqual(cfg["effort"], "low")              # untouched key = committed
        self.assertEqual(cfg["overrides"], {"model": "claude-opus-4-8"})

    def test_invalid_overlay_ignored(self):
        self._overlay("model=bad;id\neffort=nope\n")
        cfg = ds._read_config(self.repo)
        self.assertEqual(cfg["model"], "claude-sonnet-5")   # committed, overlay rejected
        self.assertEqual(cfg["overrides"], {})

    def test_no_overlay_is_empty(self):
        cfg = ds._read_config(self.repo)
        self.assertEqual(cfg["model"], "claude-sonnet-5")
        self.assertEqual(cfg["overrides"], {})

    def test_whitespace_dirty_overlay_ignored_parity_with_supervisor(self):
        # The bash reader does NOT strip the line, so a stray-space key/value is
        # ignored there; the dashboard must ignore it identically (never display
        # a value the supervisor won't use).
        for dirty in (" model=claude-opus-4-8\n", "model=claude-opus-4-8 \n"):
            self._overlay(dirty)
            cfg = ds._read_config(self.repo)
            self.assertEqual(cfg["model"], "claude-sonnet-5", repr(dirty))
            self.assertEqual(cfg["overrides"], {}, repr(dirty))


class TestSessionParse(unittest.TestCase):
    def test_completed_session_status_and_result(self):
        s = ds.parse_session_log(os.path.join(LOGDIR, "session-20260701T090000.log"))
        self.assertEqual(s["status"], "done-ok")
        self.assertTrue(s["session_id"].endswith("0001"))
        self.assertEqual(s["model"], "claude-opus-4-8")  # [1m] suffix stripped
        self.assertIn("Merged #42", s["result_text"])
        self.assertAlmostEqual(s["cost_usd"], 1.2345, places=4)
        # terminal result carries authoritative token usage
        self.assertEqual(s["output_tokens"], 2600)

    def test_started_at_from_filename(self):
        s = ds.parse_session_log(os.path.join(LOGDIR, "session-20260701T090000.log"))
        self.assertEqual(s["started_at"], "2026-07-01T09:00:00Z")

    def test_running_session_has_no_result(self):
        s = ds.parse_session_log(os.path.join(LOGDIR, "session-20260701T093000.log"))
        self.assertEqual(s["status"], "running")
        # running: no terminal result, tokens summed from streamed turns
        self.assertEqual(s["output_tokens"], 60 + 200 + 30 + 45 + 260)

    def test_current_step_is_last_action(self):
        s = ds.parse_session_log(os.path.join(LOGDIR, "session-20260701T093000.log"))
        self.assertIn("consumer.py", s["current_step"])

    def test_in_progress_ticket_from_session_text(self):
        # the running fixture says "Working ticket #57" -> surface #57 even
        # before any PR exists
        s = ds.parse_session_log(os.path.join(LOGDIR, "session-20260701T093000.log"))
        self.assertEqual(s["ticket"], 57)

    def test_ticket_from_result_text(self):
        s = ds.parse_session_log(os.path.join(LOGDIR, "session-20260701T090000.log"))
        # no assistant text/tool ref, but the result text says "Merged #42" ->
        # the ticket is still recovered from the result
        self.assertEqual(s["ticket"], 42)

    def test_tokens_series_is_cumulative(self):
        s = ds.parse_session_log(os.path.join(LOGDIR, "session-20260701T090000.log"))
        # one point per assistant turn, monotonically non-decreasing
        self.assertEqual(s["tokens_series"], [40, 160, 460])

    def test_session_carries_mtime_for_liveness(self):
        s = ds.parse_session_log(os.path.join(LOGDIR, "session-20260701T093000.log"))
        self.assertIsInstance(s["updated_at"], int)
        self.assertGreater(s["updated_at"], 0)


class TestRepoRelativeFeedPaths(unittest.TestCase):
    """#186: the feed must print repo-relative paths, never absolute
    /Users/... on every Edit row. A file_path under the session cwd is
    stripped to its repo-relative form; a path outside the repo stays
    absolute (it honestly is not repo-relative -- mangling it would hide
    where it points)."""

    def test_relative_helper_strips_cwd_prefix(self):
        root = "/Users/op/Dev/repo-alpha"
        self.assertEqual(
            ds._repo_relative(root + "/src/queue/consumer.py", root),
            "src/queue/consumer.py")

    def test_relative_helper_leaves_outside_paths_absolute(self):
        root = "/Users/op/Dev/repo-alpha"
        # a sibling repo, and a home-dir path -- neither is under root
        self.assertEqual(
            ds._repo_relative("/Users/op/.claude/settings.json", root),
            "/Users/op/.claude/settings.json")
        self.assertEqual(
            ds._repo_relative("/Users/op/Dev/repo-beta/x.py", root),
            "/Users/op/Dev/repo-beta/x.py")

    def test_relative_helper_no_root_is_passthrough(self):
        # back-compat: no cwd known -> path unchanged
        self.assertEqual(ds._repo_relative("/a/b/c.py", ""), "/a/b/c.py")

    def test_relative_helper_no_partial_segment_match(self):
        # root is a prefix STRING of the path but not a path ancestor
        root = "/Users/op/Dev/repo"
        self.assertEqual(
            ds._repo_relative("/Users/op/Dev/repo-alpha/x.py", root),
            "/Users/op/Dev/repo-alpha/x.py")

    def test_summarize_tool_relativizes_file_path(self):
        root = "/Users/op/Dev/repo-alpha"
        self.assertEqual(
            ds._summarize_tool("Edit", {"file_path": root + "/lib/x.py"}, root),
            "lib/x.py")

    def test_feed_nodes_and_step_are_repo_relative(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, True)
        p = os.path.join(d, "session-20260701T120000.log")
        cwd = "/Users/op/Dev/repo-alpha"
        with open(p, "w") as fh:
            fh.write(json.dumps({"type": "system", "subtype": "init",
                                 "model": "claude-opus-4-8", "cwd": cwd,
                                 "session_id": "s1"}) + "\n")
            fh.write(json.dumps({"type": "assistant", "message": {
                "content": [{"type": "tool_use", "id": "t1", "name": "Edit",
                             "input": {"file_path": cwd + "/lib/dashboard_state.py"}}],
                "usage": {"output_tokens": 5}}}) + "\n")
        s = ds.parse_session_log(p)
        self.assertEqual(s["nodes"][0]["summary"], "lib/dashboard_state.py")
        self.assertIn("lib/dashboard_state.py", s["current_step"])
        self.assertNotIn("/Users/op", s["current_step"])


class TestActivityLiveness(unittest.TestCase):
    """Working-right-now vs idle is freshness of the log, not the lock pid."""
    def _sess(self, status, updated_at):
        return {"status": status, "updated_at": updated_at}

    def test_none_when_no_session(self):
        self.assertEqual(ds.activity_state(None, now=1000), "none")

    def test_done_when_session_finished(self):
        s = self._sess("done-ok", 900)
        self.assertEqual(ds.activity_state(s, now=1000), "done")

    def test_working_when_log_written_recently(self):
        s = self._sess("running", 980)
        self.assertEqual(ds.activity_state(s, now=1000, stale_secs=90), "working")

    def test_idle_when_log_stale(self):
        s = self._sess("running", 800)  # 200s old > 90s stale window
        self.assertEqual(ds.activity_state(s, now=1000, stale_secs=90), "idle")


class TestDisplayStatus(unittest.TestCase):
    """THE single source of truth for a repo's status label (#23). Every panel
    renders this one value -- lifecycle x activity collapsed exactly once,
    server-side, never re-derived per-panel in page JS."""
    def test_terminal_lifecycle_states_pass_through(self):
        for state in ("needs-setup", "missing", "error"):
            self.assertEqual(ds.display_status(state, "working"), state)

    def test_paused_with_live_session_is_stopping(self):
        # graceful stop requested but the current session is still running
        self.assertEqual(ds.display_status("paused", "working"), "stopping")

    def test_paused_without_live_session_is_paused(self):
        self.assertEqual(ds.display_status("paused", "idle"), "paused")
        self.assertEqual(ds.display_status("paused", "done"), "paused")
        self.assertEqual(ds.display_status("paused", "none"), "paused")

    def test_stopped_wins_over_stale_session_activity(self):
        # the operator's #23 report: dead supervisor + old session log must
        # NEVER render as working/in-progress anywhere
        for activity in ("working", "idle", "done", "none"):
            self.assertEqual(ds.display_status("stopped", activity), "stopped")

    def test_running_supervisor_activity_decides(self):
        self.assertEqual(ds.display_status("running", "working"), "working")
        self.assertEqual(ds.display_status("running", "idle"), "idle")
        self.assertEqual(ds.display_status("running", "done"), "idle")
        self.assertEqual(ds.display_status("running", "none"), "idle")


class TestTicketRef(unittest.TestCase):
    def test_extracts_issue_number_from_feat_branch(self):
        self.assertEqual(ds.extract_ticket_ref("feat/57-add-retry"), 57)
        self.assertEqual(ds.extract_ticket_ref("fix/1832-null-guard"), 1832)

    def test_none_when_no_number(self):
        self.assertIsNone(ds.extract_ticket_ref("main"))
        self.assertIsNone(ds.extract_ticket_ref("detached@abc123"))
        self.assertIsNone(ds.extract_ticket_ref(""))


class TestTicketHeuristic(unittest.TestCase):
    """#26: 'most-mentioned issue ref' picked the triage scan's noise (#1015)
    over the ticket actually worked (#649) in the live eBull session. The
    replacement is a signal ladder verified against that real log's shape:
    in-session branch creation > board.sh 'In Progress' (not superseded) >
    most-RECENT mention among repeat mentions > any mention."""

    def test_pick_branch_creation_wins(self):
        self.assertEqual(
            ds.pick_ticket({1015: 7, 649: 2}, {1015: 3, 649: 9},
                           branch_ticket=649, board_ticket=1816), 649)

    def test_pick_board_in_progress_when_no_branch(self):
        self.assertEqual(
            ds.pick_ticket({1015: 7, 1816: 2}, {1015: 9, 1816: 4},
                           branch_ticket=None, board_ticket=1816), 1816)

    def test_pick_recency_beats_raw_count(self):
        # both mentioned repeatedly -> the most RECENT wins, not the loudest
        self.assertEqual(
            ds.pick_ticket({1015: 7, 649: 3}, {1015: 5, 649: 12},
                           branch_ticket=None, board_ticket=None), 649)

    def test_pick_repeat_mentions_beat_stray_late_single(self):
        # a one-off ref at the tail (e.g. 'blocked by #99') must not out-rank
        # a ticket the session kept coming back to
        self.assertEqual(
            ds.pick_ticket({57: 4, 99: 1}, {57: 10, 99: 11},
                           branch_ticket=None, board_ticket=None), 57)

    def test_pick_single_mention_fallback(self):
        self.assertEqual(
            ds.pick_ticket({57: 1}, {57: 1},
                           branch_ticket=None, board_ticket=None), 57)

    def test_pick_nothing(self):
        self.assertIsNone(ds.pick_ticket({}, {}, None, None))

    # #151 item 3: the card shows "#N" with no hint why that ticket; expose the
    # rung of the pick_ticket ladder that chose it so the operator can trust or
    # discount the attribution. ticket_source mirrors the same ladder.
    def test_source_branch_creation_names_the_branch(self):
        src = ds.ticket_source({1015: 7, 649: 2}, {1015: 3, 649: 9},
                               branch_ticket=649, board_ticket=1816,
                               branch_name="feat/649-x")
        self.assertIn("branch", src.lower())
        self.assertIn("feat/649-x", src)

    def test_source_branch_creation_without_name(self):
        src = ds.ticket_source({}, {}, branch_ticket=649, board_ticket=None,
                               branch_name=None)
        self.assertIn("branch", src.lower())

    def test_source_board_in_progress(self):
        src = ds.ticket_source({1015: 7}, {1015: 9},
                               branch_ticket=None, board_ticket=1816)
        self.assertIn("board", src.lower())

    def test_source_recency_among_repeats(self):
        # repeats exist -> chosen came from the repeat pool, most recent
        src = ds.ticket_source({1015: 7, 649: 3}, {1015: 5, 649: 12},
                               branch_ticket=None, board_ticket=None)
        self.assertIn("mention", src.lower())
        self.assertIn("3", src)   # the winning ticket's repeat count

    def test_source_single_mention(self):
        src = ds.ticket_source({57: 1}, {57: 1},
                               branch_ticket=None, board_ticket=None)
        self.assertIn("once", src.lower())

    def test_source_none_when_no_ticket(self):
        self.assertIsNone(ds.ticket_source({}, {}, None, None))

    def test_force_create_branch_variants_recognized(self):
        # review NITPICK on PR #28: -B / -C force-create variants count too
        for cmd in ("git checkout -B fix/12-redo", "git switch -C feat/12-x"):
            m = ds._BRANCH_CREATE_RE.search(cmd)
            self.assertIsNotNone(m, cmd)
            self.assertEqual(ds.extract_ticket_ref(m.group(1)), 12)

    def test_triage_session_picks_branched_ticket(self):
        # the real eBull failure shape: #1015 out-mentions everything, #1816
        # went In Progress then Blocked, the branch created is fix/649-...
        s = ds.parse_session_log(os.path.join(HERE, "fixtures", "triage-session.log"))
        self.assertEqual(s["ticket"], 649)

    def test_superseded_board_status_is_not_trusted(self):
        # no branch created, and #1816's LAST board status is Blocked -> the
        # board signal is void; recency among repeat mentions picks #649
        # (mentioned twice, latest) over the louder-but-earlier #1015
        s = ds.parse_session_log(os.path.join(HERE, "fixtures", "triage-no-branch.log"))
        self.assertEqual(s["ticket"], 649)


class TestCompletedTicket(unittest.TestCase):
    """#25: tie the session's ticket to its merged PR so the page can say a
    ticket was COMPLETED (and when), not just list merged PRs."""
    MERGED = [
        {"number": 71, "title": "feat: other thing (#650)", "branch": "feat/650-other",
         "at": "2026-07-01T20:00:00Z"},
        {"number": 70, "title": "fix(sec): dedupe flag flip", "branch": "fix/649-sec-fundamentals",
         "at": "2026-07-01T21:30:00Z"},
    ]

    def test_matches_by_branch_convention(self):
        hit = ds.completed_ticket(649, self.MERGED)
        self.assertEqual(hit["number"], 70)

    def test_matches_by_title_ref_when_branch_unhelpful(self):
        merged = [{"number": 72, "title": "hotfix for #813 regression",
                   "branch": "hotfix-regression", "at": "2026-07-01T22:00:00Z"}]
        self.assertEqual(ds.completed_ticket(813, merged)["number"], 72)

    def test_no_match_returns_none(self):
        self.assertIsNone(ds.completed_ticket(999, self.MERGED))
        self.assertIsNone(ds.completed_ticket(None, self.MERGED))
        self.assertIsNone(ds.completed_ticket(649, []))

    def test_title_number_must_be_a_ref_not_substring(self):
        # '#6490' must not match ticket 649
        merged = [{"number": 73, "title": "work on #6490", "branch": "x",
                   "at": "2026-07-01T22:00:00Z"}]
        self.assertIsNone(ds.completed_ticket(649, merged))


class TestIsoEpoch(unittest.TestCase):
    def test_zulu_timestamp(self):
        self.assertEqual(ds.iso_epoch("1970-01-01T00:01:00Z"), 60)

    def test_bad_input_is_zero(self):
        self.assertEqual(ds.iso_epoch(""), 0)
        self.assertEqual(ds.iso_epoch(None), 0)
        self.assertEqual(ds.iso_epoch("not-a-date"), 0)


class TestActivityTree(unittest.TestCase):
    def test_subagent_nests_under_its_task_node(self):
        s = ds.parse_session_log(os.path.join(LOGDIR, "session-20260701T093000.log"))
        tree = ds.nest(s["nodes"])
        # root children: the Task spawn + the top-level Edit
        names = [n["name"] for n in tree]
        self.assertIn("Task", names)
        task = next(n for n in tree if n["name"] == "Task")
        # the subagent's Read call nests under the Task node
        child_names = [c["name"] for c in task["children"]]
        self.assertEqual(child_names, ["Read"])

    def test_node_summary_is_human_readable(self):
        s = ds.parse_session_log(os.path.join(LOGDIR, "session-20260701T090000.log"))
        edit = next(n for n in s["nodes"] if n["name"] == "Edit")
        self.assertIn("flaky.py", edit["summary"])


class TestSupervisorVoice(unittest.TestCase):
    def test_tail_returns_most_recent_last(self):
        lines = ds.read_supervisor_voice(os.path.join(LOGDIR, "supervisor.log"), limit=2)
        self.assertEqual(len(lines), 2)
        self.assertIn("session-20260701T093000.log", lines[-1])

    def test_missing_log_is_empty_not_error(self):
        self.assertEqual(ds.read_supervisor_voice(os.path.join(LOGDIR, "nope.log")), [])


class TestHeartbeat(unittest.TestCase):
    """read_heartbeat parses the supervisor's one-line structured liveness twin
    (#177): `ts \\t phase \\t until_epoch \\t reason`. Best-effort -> {}."""
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.p = os.path.join(self.d, "heartbeat")

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def _write(self, line):
        with open(self.p, "w") as fh:
            fh.write(line)

    def test_parses_all_fields(self):
        self._write("1893456000\tpace-wait\t1893456120\tsession clean -- next soon\n")
        hb = ds.read_heartbeat(self.p)
        self.assertEqual(hb["phase"], "pace-wait")
        self.assertEqual(hb["ts"], 1893456000)
        self.assertEqual(hb["until"], 1893456120)
        self.assertEqual(hb["reason"], "session clean -- next soon")

    def test_empty_until_is_zero(self):
        self._write("1893456000\tsession-running coder\t\trunning a coder session\n")
        hb = ds.read_heartbeat(self.p)
        self.assertEqual(hb["until"], 0)
        self.assertEqual(hb["phase"], "session-running coder")

    def test_missing_file_is_empty(self):
        self.assertEqual(ds.read_heartbeat(os.path.join(self.d, "nope")), {})

    def test_malformed_too_few_fields_is_empty(self):
        self._write("1893456000\tpace-wait\n")
        self.assertEqual(ds.read_heartbeat(self.p), {})

    def test_non_integer_ts_is_empty(self):
        self._write("notanint\tpace-wait\t0\treason\n")
        self.assertEqual(ds.read_heartbeat(self.p), {})

    def test_blank_phase_is_empty(self):
        self._write("1893456000\t\t0\treason\n")
        self.assertEqual(ds.read_heartbeat(self.p), {})

    def test_build_repo_state_includes_heartbeat(self):
        # the fixture repo ships a heartbeat file (added for #177 render)
        st = ds.build_repo_state(FIX, pid_is_alive=lambda p: True, git_in_flight=lambda p: {})
        self.assertIn("heartbeat", st)
        self.assertIsInstance(st["heartbeat"], dict)


class TestChoreography(unittest.TestCase):
    """read_choreography (#177 piece 3) parses the supervisor's cron-fire /
    event-wake / session-done HANDOFF lines out of supervisor.log into structured,
    role-chipped feed entries. Read-only + best-effort like read_heartbeat: a
    missing/torn/huge log degrades to []. Fail-safe: a line that does not match a
    known choreography shape (or has garbage refs) is skipped, never guessed."""
    TS = "2026-07-03T21:57:52Z"

    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.p = os.path.join(self.d, "supervisor.log")

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def _write(self, *lines):
        with open(self.p, "w") as fh:
            fh.write("".join(l if l.endswith("\n") else l + "\n" for l in lines))

    def test_cron_fire(self):
        self._write("%s cron: role 'pm' due (schedule '0 * * * *') -- firing" % self.TS)
        out = ds.read_choreography(self.p)
        self.assertEqual(len(out), 1)
        e = out[0]
        self.assertEqual(e["kind"], "cron")
        self.assertEqual(e["role"], "pm")
        self.assertEqual(e["event"], None)
        self.assertEqual(e["refs"], [])
        self.assertEqual(e["ts"], ds.iso_epoch(self.TS))
        self.assertEqual(e["at"], self.TS)

    def test_event_wake_numeric_refs(self):
        for ev in ("pr.opened", "issue.created", "merge.done"):
            self._write("%s event: role 'qa' woken by %s (175 176)" % (self.TS, ev))
            out = ds.read_choreography(self.p)
            self.assertEqual(len(out), 1, ev)
            self.assertEqual(out[0]["kind"], "event")
            self.assertEqual(out[0]["role"], "qa")
            self.assertEqual(out[0]["event"], ev)
            self.assertEqual(out[0]["refs"], ["175", "176"])

    SHA = "deadbeef0123456789abcdefdeadbeef01234567"  # a full 40-char git OID

    def test_pr_synchronize_ref_preserved(self):
        tok = "42:" + self.SHA
        self._write("%s event: role 'coder' woken by pr.synchronize (%s)" % (self.TS, tok))
        out = ds.read_choreography(self.p)
        self.assertEqual(out[0]["event"], "pr.synchronize")
        self.assertEqual(out[0]["refs"], [tok])

    def test_synchronize_short_sha_skipped(self):
        # a truncated OID is not the emitted shape -> not a real handoff
        self._write("%s event: role 'coder' woken by pr.synchronize (42:deadbeef)" % self.TS)
        self.assertEqual(ds.read_choreography(self.p), [])

    def test_session_done_wake(self):
        self._write("%s event: role 'researcher' woken by session.done" % self.TS)
        out = ds.read_choreography(self.p)
        self.assertEqual(out[0]["event"], "session.done")
        self.assertEqual(out[0]["refs"], [])

    def test_lane_label_prefix_tolerated(self):
        self._write("%s [fe] cron: role 'pm' due (schedule '@daily') -- firing" % self.TS)
        out = ds.read_choreography(self.p)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["role"], "pm")

    def test_label_containing_bracket_still_parses(self):
        # log() wraps a raw --label; a label with ']' must not blank the entry
        # (re.search, not a [^]]* strip).
        self._write("%s [we][rd] event: role 'qa' woken by pr.opened (9)" % self.TS)
        out = ds.read_choreography(self.p)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["refs"], ["9"])

    def test_empty_refs_skipped(self):
        self._write("%s event: role 'qa' woken by pr.opened ()" % self.TS)
        self.assertEqual(ds.read_choreography(self.p), [])

    def test_nonnumeric_ref_skipped(self):
        self._write("%s event: role 'qa' woken by pr.opened (abc)" % self.TS)
        self.assertEqual(ds.read_choreography(self.p), [])

    def test_synchronize_without_sha_skipped(self):
        self._write("%s event: role 'coder' woken by pr.synchronize (42)" % self.TS)
        self.assertEqual(ds.read_choreography(self.p), [])

    def test_non_choreography_lines_filtered(self):
        self._write(
            "%s session clean (open issues ~4) -- next session soon" % self.TS,
            "%s cron: role 'pm' session rc=1 (see supervisor.log)" % self.TS,
            "%s event: role 'qa' session failed -- leaving seen (re-deliver next tick)" % self.TS,
            "%s USAGE LIMIT -- backoff" % self.TS,
            "%s cron: role 'pm' due (schedule '@hourly') -- firing" % self.TS,
        )
        out = ds.read_choreography(self.p)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["kind"], "cron")

    def test_missing_file_is_empty(self):
        self.assertEqual(ds.read_choreography(os.path.join(self.d, "nope")), [])

    def test_unparseable_ts_keeps_entry_ts_zero(self):
        self._write("garbage cron: role 'pm' due (schedule '@daily') -- firing")
        out = ds.read_choreography(self.p)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["ts"], 0)
        self.assertEqual(out[0]["role"], "pm")

    def test_keep_bound_oldest_first(self):
        lines = ["%s cron: role 'r%d' due (schedule '@daily') -- firing" % (self.TS, i)
                 for i in range(20)]
        self._write(*lines)
        out = ds.read_choreography(self.p, keep=5)
        self.assertEqual(len(out), 5)
        self.assertEqual([e["role"] for e in out],
                         ["r15", "r16", "r17", "r18", "r19"])

    def test_build_repo_state_includes_choreography(self):
        st = ds.build_repo_state(FIX, pid_is_alive=lambda p: True, git_in_flight=lambda p: {})
        self.assertIn("choreography", st)
        self.assertIsInstance(st["choreography"], list)


class TestLifecycle(unittest.TestCase):
    def test_stopped_when_lock_pid_dead(self):
        st = ds.lifecycle_status(FIX, pid_is_alive=lambda p: False)
        self.assertEqual(st["state"], "stopped")

    def test_running_when_lock_pid_alive(self):
        st = ds.lifecycle_status(FIX, pid_is_alive=lambda p: True)
        self.assertEqual(st["state"], "running")
        self.assertEqual(st["pid"], 999999)

    def test_paused_when_sentinel_present(self):
        sentinel = os.path.join(LOGDIR, "autonomy-PAUSE")
        open(sentinel, "w").close()
        try:
            st = ds.lifecycle_status(FIX, pid_is_alive=lambda p: True)
            self.assertEqual(st["state"], "paused")
        finally:
            os.remove(sentinel)

    def test_needs_setup_when_no_pack(self):
        st = ds.lifecycle_status(os.path.join(HERE, "fixtures"), pid_is_alive=lambda p: False)
        self.assertEqual(st["state"], "needs-setup")


class TestQuotaWindows(unittest.TestCase):
    """5h + weekly % come straight from rate_limit_event.utilization -- the
    authoritative server-side number, tagged by rateLimitType."""
    def setUp(self):
        self.q = ds.parse_quota_windows(os.path.join(HERE, "fixtures", "quota-sample.log"))

    def test_latest_five_hour_window_utilization(self):
        # two five_hour events; the later resetsAt (1782639000) wins, at 0.9
        self.assertEqual(self.q["five_hour"]["resets_at"], 1782639000)
        self.assertAlmostEqual(self.q["five_hour"]["utilization"], 0.9)

    def test_seven_day_window(self):
        self.assertEqual(self.q["seven_day"]["resets_at"], 1782871200)
        self.assertAlmostEqual(self.q["seven_day"]["utilization"], 0.75)

    def test_no_rate_limit_events_returns_empty(self):
        q = ds.parse_quota_windows(os.path.join(LOGDIR, "session-20260701T090000.log"))
        self.assertEqual(q, {})


class TestAccountUsage(unittest.TestCase):
    """Real, account-wide usage from ~/.claude/projects/**/*.jsonl -- live
    session + token counts per rolling 5h / weekly window (dedup on message.id).
    This is the honest 'is the account busy' signal, not per-repo threshold
    events."""
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.now = 1_000_000.0
        # session A: two records, one inside 5h, plus a duplicate message.id
        self._sess("aaaa-1111", [
            (self.now - 600, "mA1", 100, 10),      # 10min ago -> 5h + weekly
            (self.now - 600, "mA1", 100, 10),      # DUP message.id -> ignored
            (self.now - 6 * 3600, "mA2", 50, 5),   # 6h ago -> weekly only
        ])
        # session B: one record inside 5h
        self._sess("bbbb-2222", [
            (self.now - 1200, "mB1", 200, 20),     # 20min ago -> 5h + weekly
        ])
        # session C: older than a week -> excluded entirely
        self._sess("cccc-3333", [
            (self.now - 8 * 24 * 3600, "mC1", 999, 99),
        ])

    def _sess(self, sid, recs):
        sub = os.path.join(self.dir, "-Users-op-Dev-x")
        os.makedirs(sub, exist_ok=True)
        with open(os.path.join(sub, sid + ".jsonl"), "w") as fh:
            for ts, mid, inp, out in recs:
                from datetime import datetime, timezone
                iso = datetime.fromtimestamp(ts, timezone.utc).isoformat().replace("+00:00", "Z")
                fh.write(json.dumps({"timestamp": iso, "type": "assistant",
                                     "message": {"id": mid, "usage": {
                                         "input_tokens": inp, "output_tokens": out}}}) + "\n")

    def test_five_hour_window(self):
        u = ds.account_usage(self.dir, now=self.now)
        # 5h: mA1 (session A) + mB1 (session B) = 2 sessions; tokens 110 + 220
        self.assertEqual(u["five_hour"]["sessions"], 2)
        self.assertEqual(u["five_hour"]["tokens"], 110 + 220)

    def test_weekly_window(self):
        u = ds.account_usage(self.dir, now=self.now)
        # weekly: sessions A (mA1,mA2) + B = 2 sessions; C excluded (>7d)
        self.assertEqual(u["seven_day"]["sessions"], 2)
        self.assertEqual(u["seven_day"]["tokens"], 110 + 55 + 220)

    def test_dedup_on_message_id(self):
        u = ds.account_usage(self.dir, now=self.now)
        # the duplicated mA1 must not double-count
        self.assertEqual(u["five_hour"]["tokens"], 330)

    def test_missing_dir(self):
        u = ds.account_usage(os.path.join(self.dir, "nope"), now=self.now)
        self.assertEqual(u["five_hour"]["sessions"], 0)

    def test_files_older_than_the_window_are_not_opened(self):
        # #31: history grows forever; a file whose mtime predates the 7-day
        # cutoff cannot contain in-window records (mtime = last write) and
        # must be skipped without reading. Proof: give an old-mtime file a
        # record that WOULD count if parsed -- it must not.
        self._sess("dddd-4444", [(self.now - 60, "mD1", 1000, 100)])
        path = os.path.join(self.dir, "-Users-op-Dev-x", "dddd-4444.jsonl")
        old = self.now - 8 * 24 * 3600
        os.utime(path, (old, old))
        u = ds.account_usage(self.dir, now=self.now)
        self.assertEqual(u["five_hour"]["tokens"], 330)  # mD1 not counted
        self.assertEqual(u["seven_day"]["sessions"], 2)


class TestRoles(unittest.TestCase):
    """Page is designed for the multi-role org now: Coder live, others as
    not-configured placeholders unless the pack declares them."""
    def test_default_roster_when_no_roles_block(self):
        roles = ds.build_roles({}, coder_status="working")
        names = [r["name"] for r in roles]
        self.assertEqual(names, ["coder", "pm", "qa", "researcher"])
        coder = roles[0]
        self.assertTrue(coder["enabled"])
        self.assertEqual(coder["substrate"], "engine")
        self.assertEqual(coder["trigger"], "loop")
        self.assertEqual(coder["status"], "working")
        # the unconfigured roles are placeholders
        self.assertFalse(roles[1]["enabled"])
        self.assertEqual(roles[1]["status"], "not-configured")

    def test_last_run_none_without_sessions(self):
        # #185 fleet rail: with no session history, every role row's last_run
        # is None (the page then renders no "last …" stat).
        roles = ds.build_roles({}, coder_status="idle")
        self.assertTrue(all(r["last_run"] is None for r in roles))

    def test_last_run_from_newest_matching_role_session(self):
        # #185 fleet rail: a role's last_run is the newest recent_sessions entry
        # dispatched to it -- {at: started_epoch, outcome}. recent_sessions is
        # newest-first, so the first match wins.
        sessions = [
            {"role": "qa", "started_epoch": 200, "outcome": "clean"},
            {"role": "coder", "started_epoch": 150, "outcome": "error"},
            {"role": "qa", "started_epoch": 100, "outcome": "error"},  # older qa
        ]
        roles = ds.build_roles({}, coder_status="idle", sessions=sessions)
        qa = next(r for r in roles if r["name"] == "qa")
        coder = next(r for r in roles if r["name"] == "coder")
        self.assertEqual(qa["last_run"], {"at": 200, "outcome": "clean"})
        self.assertEqual(coder["last_run"], {"at": 150, "outcome": "error"})

    def test_last_run_none_for_role_with_no_matching_session(self):
        sessions = [{"role": "coder", "started_epoch": 150, "outcome": "clean"}]
        roles = ds.build_roles({}, coder_status="idle", sessions=sessions)
        pm = next(r for r in roles if r["name"] == "pm")
        self.assertIsNone(pm["last_run"])

    def test_coder_row_carries_the_unified_display_status(self):
        # #23: the coder row must show the SAME label as the repo badge --
        # lifecycle-aware display status, not the raw activity axis
        roles = ds.build_roles({}, coder_status="stopping")
        self.assertEqual(roles[0]["status"], "stopping")
        roles = ds.build_roles({}, coder_status="stopped")
        self.assertEqual(roles[0]["status"], "stopped")

    def test_config_declared_role_overrides_placeholder(self):
        cfg_roles = {"qa": {"enabled": "true", "substrate": "routine",
                            "trigger": {"type": "event"}}}
        roles = ds.build_roles(cfg_roles, coder_status="idle")
        qa = next(r for r in roles if r["name"] == "qa")
        self.assertTrue(qa["enabled"])
        self.assertEqual(qa["substrate"], "routine")
        self.assertEqual(qa["trigger"], "event")

    def test_custom_role_appended(self):
        cfg_roles = {"security_sweeper": {"enabled": "true", "substrate": "routine",
                                          "trigger": {"type": "event"}}}
        roles = ds.build_roles(cfg_roles, coder_status="idle")
        self.assertIn("security_sweeper", [r["name"] for r in roles])

    def test_configured_role_without_substrate_shows_engine(self):
        # #164: a standard role the pack ENABLES without an explicit substrate:
        # runs on the local engine (W1/W2 execute every enabled role) -- it must
        # show "engine", NOT the legacy DEFAULT_ROLES substrate (pm->managed_agents,
        # qa->routine) which is what the operator saw badged CLOUD/ROUTINE.
        cfg_roles = {"pm": {"enabled": "true",
                            "trigger": {"type": "cron", "schedule": "0 */6 * * *"}},
                     "qa": {"enabled": "true", "trigger": {"type": "event"}}}
        roles = ds.build_roles(cfg_roles, coder_status="idle")
        pm = next(r for r in roles if r["name"] == "pm")
        qa = next(r for r in roles if r["name"] == "qa")
        self.assertEqual(pm["substrate"], "engine")
        self.assertEqual(qa["substrate"], "engine")

    def test_unconfigured_placeholder_has_no_substrate_badge(self):
        # #164: a not-configured placeholder isn't running anywhere, so it must
        # not claim a legacy substrate -- substrate is None and the page drops
        # the badge (truth-in-display). Coder always runs on the engine.
        roles = ds.build_roles({}, coder_status="idle")
        by = {r["name"]: r for r in roles}
        self.assertEqual(by["coder"]["substrate"], "engine")
        self.assertIsNone(by["pm"]["substrate"])
        self.assertIsNone(by["qa"]["substrate"])
        self.assertIsNone(by["researcher"]["substrate"])

    def test_explicit_substrate_still_respected(self):
        # #164: an explicit substrate: override is preserved (a role genuinely
        # pointed at a non-engine executor still displays it).
        cfg_roles = {"pm": {"enabled": "true", "substrate": "managed_agents",
                            "trigger": {"type": "cron", "schedule": "0 */6 * * *"}}}
        roles = ds.build_roles(cfg_roles, coder_status="idle")
        pm = next(r for r in roles if r["name"] == "pm")
        self.assertEqual(pm["substrate"], "managed_agents")

    def test_coder_substrate_is_always_engine(self):
        # #164: coder is the local loop role -- it always runs on the engine, so
        # a stray substrate: override on coder never displays anything else.
        cfg_roles = {"coder": {"enabled": "true", "substrate": "routine"}}
        roles = ds.build_roles(cfg_roles, coder_status="working")
        self.assertEqual(roles[0]["name"], "coder")
        self.assertEqual(roles[0]["substrate"], "engine")

    def test_enabled_cron_role_carries_next_fire(self):
        # #18: the page shows a live next-fire countdown for scheduled roles
        cfg_roles = {"pm": {"enabled": "true", "substrate": "managed_agents",
                            "trigger": {"type": "cron", "schedule": "0 */6 * * *"}}}
        now = 1782941400
        roles = ds.build_roles(cfg_roles, coder_status="idle", now=now)
        pm = next(r for r in roles if r["name"] == "pm")
        self.assertIsNotNone(pm["next_fire"])
        self.assertGreater(pm["next_fire"], now)
        self.assertLessEqual(pm["next_fire"] - now, 6 * 3600)

    def test_disabled_or_unscheduled_roles_have_no_next_fire(self):
        roles = ds.build_roles({}, coder_status="idle", now=1782941400)
        for r in roles:
            self.assertIsNone(r["next_fire"], r["name"])
        # enabled cron role with a GARBLED schedule -> None, not a crash
        cfg_roles = {"pm": {"enabled": "true",
                            "trigger": {"type": "cron", "schedule": "banana"}}}
        roles = ds.build_roles(cfg_roles, coder_status="idle", now=1782941400)
        pm = next(r for r in roles if r["name"] == "pm")
        self.assertIsNone(pm["next_fire"])


class TestParseSessionLogCached(unittest.TestCase):
    """#31: the server re-parses the newest session log on every state
    collection (per SSE client per 2s). The cached variant re-parses only
    when (mtime_ns, size) changes -- i.e. only when the log was written."""
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "session-20260701T090000.log")
        self._write('{"type":"system","subtype":"init","session_id":"s1","model":"m","cwd":"/w"}\n')

    def _write(self, text, mode="w"):
        with open(self.path, mode) as fh:
            fh.write(text)

    def test_unchanged_file_returns_cached_object(self):
        a = ds.parse_session_log_cached(self.path)
        b = ds.parse_session_log_cached(self.path)
        self.assertIs(a, b)  # identity = no re-parse

    def test_appended_file_reparses(self):
        a = ds.parse_session_log_cached(self.path)
        self._write('{"type":"assistant","message":{"id":"m1","usage":{"output_tokens":7},'
                    '"content":[{"type":"text","text":"hi"}]}}\n', mode="a")
        b = ds.parse_session_log_cached(self.path)
        self.assertIsNot(a, b)
        self.assertEqual(b["output_tokens"], 7)

    def test_missing_file_is_none_and_not_cached_forever(self):
        gone = os.path.join(self.dir, "session-20260701T100000.log")
        self.assertIsNone(ds.parse_session_log_cached(gone))
        with open(gone, "w") as fh:
            fh.write('{"type":"system","subtype":"init","session_id":"s2","model":"m","cwd":"/w"}\n')
        got = ds.parse_session_log_cached(gone)
        self.assertEqual(got["session_id"], "s2")


class TestModelOverrideRead(unittest.TestCase):
    """#24: the page shows a queued one-shot override honestly ('next session:
    opus/high') instead of pretending the change is already live."""
    def test_reads_pending_override(self):
        d = tempfile.mkdtemp()
        p = os.path.join(d, "model-override")
        with open(p, "w") as fh:
            fh.write("model=claude-opus-4-8\neffort=high\n")
        self.assertEqual(ds.read_model_override(p),
                         {"model": "claude-opus-4-8", "effort": "high"})

    def test_missing_file_is_empty(self):
        self.assertEqual(ds.read_model_override("/nope/model-override"), {})

    def test_junk_lines_ignored(self):
        d = tempfile.mkdtemp()
        p = os.path.join(d, "model-override")
        with open(p, "w") as fh:
            fh.write("bogus\nmodel=claude-sonnet-5\nwhat=ever\n")
        self.assertEqual(ds.read_model_override(p), {"model": "claude-sonnet-5"})


class TestRepoState(unittest.TestCase):
    def test_build_repo_state_composes_without_network(self):
        # git/gh injected so the test never shells out
        st = ds.build_repo_state(
            FIX,
            pid_is_alive=lambda p: True,
            git_in_flight=lambda repo: {"branch": "feat/x", "prs": []},
        )
        self.assertEqual(st["name"], "repo-alpha")
        self.assertEqual(st["lifecycle"]["state"], "running")
        self.assertEqual(st["current_session"]["status"], "running")
        self.assertTrue(st["voice"])
        self.assertEqual(st["git"]["branch"], "feat/x")
        self.assertEqual(st["config"]["model"], "claude-opus-4-8")

    def test_repo_state_carries_display_status(self):
        # running lock pid (injected alive) + a session log gone quiet -> the
        # ONE label every panel renders is "idle". `now` is pinned relative to
        # the fixture file's real mtime (a fresh CI checkout writes new mtimes,
        # so wall-clock now would flip this to "working" there).
        mtime = os.path.getmtime(os.path.join(LOGDIR, "session-20260701T093000.log"))
        st = ds.build_repo_state(
            FIX,
            pid_is_alive=lambda p: True,
            git_in_flight=lambda repo: {},
            now=mtime + 9999,
        )
        self.assertEqual(st["display_status"], "idle")
        coder = next(r for r in st["roles"] if r["name"] == "coder")
        self.assertEqual(coder["status"], st["display_status"])

    def test_repo_state_display_status_working_when_log_fresh(self):
        mtime = os.path.getmtime(os.path.join(LOGDIR, "session-20260701T093000.log"))
        st = ds.build_repo_state(
            FIX,
            pid_is_alive=lambda p: True,
            git_in_flight=lambda repo: {},
            now=mtime + 5,
        )
        self.assertEqual(st["display_status"], "working")

    def test_repo_state_display_status_stopped(self):
        st = ds.build_repo_state(
            FIX,
            pid_is_alive=lambda p: False,
            git_in_flight=lambda repo: {},
        )
        self.assertEqual(st["display_status"], "stopped")
        coder = next(r for r in st["roles"] if r["name"] == "coder")
        self.assertEqual(coder["status"], "stopped")


class TestConfigBoardKeys(unittest.TestCase):
    """#47: the config page needs board identity in the per-repo state."""
    def test_board_keys_exposed(self):
        tmp = tempfile.mkdtemp()
        os.makedirs(os.path.join(tmp, ".autonomy"))
        with open(os.path.join(tmp, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("board:\n  owner: some-org\n"
                     "  project_title: \"My Fancy Board\"\n"
                     "agent:\n  type: claude\n")
        st = ds.build_repo_state(tmp, pid_is_alive=lambda p: False,
                                              git_in_flight=lambda r: {})
        self.assertEqual(st["config"]["board_owner"], "some-org")
        self.assertEqual(st["config"]["board_title"], "My Fancy Board")

    def test_board_keys_default_empty(self):
        tmp = tempfile.mkdtemp()
        st = ds.build_repo_state(tmp, pid_is_alive=lambda p: False,
                                              git_in_flight=lambda r: {})
        self.assertEqual(st["config"].get("board_owner", ""), "")
        self.assertEqual(st["config"].get("board_title", ""), "")

    def test_board_keys_shadowed_by_overlay(self):
        # #211: a config-page 'save default' for board.* lands in the untracked
        # overlay; the page must show the EFFECTIVE (overlay) value, not the
        # stale committed one -- otherwise the save looks reverted. Consistent
        # with how model/effort already shadow config.yaml.
        tmp = tempfile.mkdtemp()
        os.makedirs(os.path.join(tmp, ".autonomy"))
        with open(os.path.join(tmp, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("board:\n  owner: committed-org\n"
                     "  project_title: Committed Board\n")
        os.makedirs(os.path.join(tmp, "var", "autonomy-logs"))
        with open(os.path.join(tmp, "var", "autonomy-logs",
                               "config-overrides"), "w") as fh:
            fh.write("board_owner=overlay-org\n"
                     "board_project_title=Overlay Board\n")
        st = ds.build_repo_state(tmp, pid_is_alive=lambda p: False,
                                              git_in_flight=lambda r: {})
        self.assertEqual(st["config"]["board_owner"], "overlay-org")
        self.assertEqual(st["config"]["board_title"], "Overlay Board")
        # flagged in `overrides` so the UI can label them "local override".
        self.assertEqual(st["config"]["overrides"].get("board_owner"),
                         "overlay-org")



class TestCodexUsage(unittest.TestCase):
    """#49: codex account usage from the codex CLI's own session rollouts.
    Shapes verified empirically against codex-cli 0.136.0 on this machine:
    event_msg/payload/token_count with rate_limits (primary=300min,
    secondary=10080min, plan_type, credits) and info.total_token_usage."""

    def _mk(self, tmp, rel, lines, age_days=0):
        p = os.path.join(tmp, "sessions", rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as fh:
            for ln in lines:
                fh.write(json.dumps(ln) + "\n")
        old = time.time() - age_days * 86400
        os.utime(p, (old, old))
        return p

    def _tc(self, pct5, pct7, tokens_in, tokens_out, credits=None, plan="plus"):
        return {"timestamp": "t", "type": "event_msg", "payload": {
            "type": "token_count",
            "info": {"total_token_usage": {
                "input_tokens": tokens_in, "cached_input_tokens": 0,
                "output_tokens": tokens_out, "reasoning_output_tokens": 0,
                "total_tokens": tokens_in + tokens_out}},
            "rate_limits": {
                "limit_id": "codex", "plan_type": plan, "credits": credits,
                "primary": {"used_percent": pct5, "window_minutes": 300,
                            "resets_at": 4102444800},
                "secondary": {"used_percent": pct7, "window_minutes": 10080,
                              "resets_at": 4102444900}}}}

    def test_absent_home_unavailable(self):
        tmp = tempfile.mkdtemp()
        u = ds.codex_usage(codex_home=os.path.join(tmp, "nope"))
        self.assertFalse(u["available"])

    def test_latest_snapshot_and_token_totals(self):
        tmp = tempfile.mkdtemp()
        self._mk(tmp, "2026/07/01/rollout-a.jsonl",
                 [self._tc(50.0, 20.0, 1000, 100)], age_days=1)
        self._mk(tmp, "2026/07/02/rollout-b.jsonl",
                 [self._tc(10.0, 5.0, 200, 20), self._tc(16.0, 10.0, 500, 50)],
                 age_days=0)
        u = ds.codex_usage(codex_home=tmp)
        self.assertTrue(u["available"])
        # newest file's LAST snapshot wins
        self.assertEqual(u["five_hour"]["pct"], 16.0)
        self.assertEqual(u["seven_day"]["pct"], 10.0)
        self.assertEqual(u["five_hour"]["resets_at"], 4102444800)
        self.assertEqual(u["plan"], "plus")
        self.assertIsNone(u["credits"])
        # totals: last cumulative per file, summed across files
        self.assertEqual(u["tokens_7d"]["input"], 1500)
        self.assertEqual(u["tokens_7d"]["output"], 150)
        self.assertEqual(u["sessions_7d"], 2)

    def test_old_files_pruned(self):
        tmp = tempfile.mkdtemp()
        self._mk(tmp, "2026/06/01/rollout-old.jsonl",
                 [self._tc(90.0, 90.0, 9000, 900)], age_days=9)
        u = ds.codex_usage(codex_home=tmp)
        self.assertFalse(u["available"])

    def test_credits_surface_when_api_billed(self):
        tmp = tempfile.mkdtemp()
        self._mk(tmp, "2026/07/02/rollout-c.jsonl",
                 [self._tc(1.0, 1.0, 10, 1, credits={"balance": 42.5})])
        u = ds.codex_usage(codex_home=tmp)
        self.assertEqual(u["credits"], {"balance": 42.5})


class TestCodexSessionParse(unittest.TestCase):
    """#49: supervisor session logs written by the codex adapter (exec --json)
    must yield token counts and a result instead of parsing to zeros."""

    def _write(self, lines):
        tmp = tempfile.mkdtemp()
        p = os.path.join(tmp, "session-x.log")
        with open(p, "w") as fh:
            for ln in lines:
                fh.write(json.dumps(ln) + "\n")
        return p

    def test_codex_turn_usage_counted(self):
        p = self._write([
            {"type": "thread.started", "thread_id": "th_1"},
            {"type": "turn.started"},
            {"type": "item.completed",
             "item": {"type": "agent_message", "text": "working on #12 now"}},
            {"type": "turn.completed",
             "usage": {"input_tokens": 900, "output_tokens": 40,
                       "reasoning_output_tokens": 10}},
        ])
        s = ds.parse_session_log(p)
        self.assertEqual(s["output_tokens"], 50)
        self.assertEqual(s["session_id"], "th_1")
        self.assertEqual(s["status"], "done-ok")
        self.assertIn("working on", s["current_step"])

    def test_codex_turn_failed_is_error(self):
        p = self._write([
            {"type": "thread.started", "thread_id": "th_2"},
            {"type": "turn.failed", "error": {"message": "boom"}},
        ])
        s = ds.parse_session_log(p)
        self.assertEqual(s["status"], "done-error")


class TestParseNeedsYou(unittest.TestCase):
    """The untriaged needs-you list (#189 degraded state): parse gh issue-list
    JSON into the human-decision queue, kept only for NEEDS_YOU_LABELS issues,
    newest first, total against any malformed input (fail-safe, Codex CP1)."""

    def test_parses_and_sorts_desc_by_updated(self):
        raw = json.dumps([
            {"number": 1, "title": "old", "url": "u1",
             "labels": [{"name": "needs-design"}], "updatedAt": "2026-07-01T00:00:00Z"},
            {"number": 2, "title": "new", "url": "u2",
             "labels": [{"name": "needs-design"}, {"name": "p2"}], "updatedAt": "2026-07-03T00:00:00Z"},
        ])
        out = ds.parse_needs_you(raw)
        self.assertEqual([i["number"] for i in out], [2, 1])
        self.assertEqual(out[0]["labels"], ["needs-design", "p2"])
        self.assertEqual(out[0]["updated_at"], "2026-07-03T00:00:00Z")

    def test_none_and_empty_and_garbage_yield_empty(self):
        for raw in (None, "", "not json", "{}", "[42]"):
            self.assertEqual(ds.parse_needs_you(raw), [])

    def test_non_engine_standard_labels_are_dropped(self):
        # only NEEDS_YOU_LABELS (engine-standard) matches; a repo's own extra
        # human-decision label (e.g. needs-spec) is not baked in (repo-agnostic).
        raw = json.dumps([
            {"number": 5, "title": "t", "url": "u", "labels": [{"name": "bug"}], "updatedAt": "z"},
            {"number": 6, "title": "t", "url": "u", "labels": [{"name": "needs-spec"}], "updatedAt": "z"},
        ])
        self.assertEqual(ds.parse_needs_you(raw), [])

    def test_entry_without_int_number_is_dropped(self):
        raw = json.dumps([
            {"number": None, "title": "t", "url": "u",
             "labels": [{"name": "needs-design"}], "updatedAt": "z"},
            {"title": "t2", "url": "u2",
             "labels": [{"name": "needs-design"}], "updatedAt": "z"},
        ])
        self.assertEqual(ds.parse_needs_you(raw), [])

    def test_malformed_shapes_do_not_crash(self):
        raw = json.dumps([
            {"number": 7, "title": "t", "url": "u", "labels": 1, "updatedAt": "z"},
            {"number": 8, "title": "t", "url": "u",
             "labels": [{"name": "needs-design"}], "updatedAt": 1},
            {"number": {}, "labels": [{"name": "needs-design"}], "updatedAt": "z"},
            42,
        ])
        out = ds.parse_needs_you(raw)
        self.assertEqual([i["number"] for i in out], [8])
        self.assertEqual(out[0]["updated_at"], "")

    def test_bool_number_is_not_treated_as_int(self):
        raw = json.dumps([{"number": True, "title": "t", "url": "u",
                           "labels": [{"name": "needs-design"}], "updatedAt": "z"}])
        self.assertEqual(ds.parse_needs_you(raw), [])

    def test_labels_normalised_to_names(self):
        raw = json.dumps([{"number": 7, "title": "t", "url": "u",
                           "labels": [{"name": "needs-design"}, {"color": "x"}],
                           "updatedAt": ""}])
        self.assertEqual(ds.parse_needs_you(raw)[0]["labels"], ["needs-design"])

    def test_question_attached_when_a_valid_block_present(self):
        # #189: a needs-design issue whose comments carry a valid
        # autonomy-question block gets a triaged `question` dict; one without
        # gets question=None (degrades to the untriaged row).
        q = {"question": "Ship it?", "recommendation": "yes",
             "reasoning_quote": "because", "effort_sunk": "2 sessions",
             "default_if_ignored": "hold", "answers": ["yes", "no"]}
        body = "prose\n```autonomy-question\n%s\n```\n" % json.dumps(q)
        raw = json.dumps([
            {"number": 1, "title": "triaged", "url": "u1",
             "labels": [{"name": "needs-design"}], "updatedAt": "2026-07-03T00:00:00Z",
             "comments": [{"body": body, "createdAt": "2026-07-03T01:00:00Z"}]},
            {"number": 2, "title": "untriaged", "url": "u2",
             "labels": [{"name": "needs-design"}], "updatedAt": "2026-07-02T00:00:00Z",
             "comments": [{"body": "just chatter", "createdAt": "z"}]},
        ])
        out = {i["number"]: i for i in ds.parse_needs_you(raw)}
        self.assertEqual(out[1]["question"]["question"], "Ship it?")
        self.assertEqual(out[1]["question"]["answers"], ["yes", "no"])
        self.assertIsNone(out[2]["question"])


class TestParseAutonomyQuestion(unittest.TestCase):
    """#189 triaged escalation: parse the fenced `autonomy-question` block from an
    issue's comments (SD-32 schema). Pure/total; strict schema; the NEWEST comment
    with a block is authoritative; any deviation degrades to None (fail-safe)."""

    GOOD = {"question": "Proceed with plan B?",
            "recommendation": "adopt plan B",
            "reasoning_quote": "A cannot satisfy the invariant",
            "effort_sunk": "3 sessions",
            "default_if_ignored": "stay on plan A",
            "answers": ["plan B", "discuss", "stay"]}

    def _comment(self, body, at):
        return {"body": body, "createdAt": at}

    def _fenced(self, obj, lang="autonomy-question", nl="\n"):
        return "leading prose%s```%s%s%s%s```%s" % (
            nl, lang, nl, json.dumps(obj), nl, nl)

    def test_valid_block_returns_dict(self):
        c = [self._comment(self._fenced(self.GOOD), "2026-07-03T00:00:00Z")]
        self.assertEqual(ds.parse_autonomy_question(c), self.GOOD)

    def test_newest_question_comment_wins(self):
        older = dict(self.GOOD, question="OLD")
        newer = dict(self.GOOD, question="NEW")
        c = [self._comment(self._fenced(older), "2026-07-01T00:00:00Z"),
             self._comment(self._fenced(newer), "2026-07-05T00:00:00Z")]
        self.assertEqual(ds.parse_autonomy_question(c)["question"], "NEW")

    def test_later_prose_only_comment_does_not_mask_question(self):
        c = [self._comment(self._fenced(self.GOOD), "2026-07-01T00:00:00Z"),
             self._comment("no block here", "2026-07-09T00:00:00Z")]
        self.assertEqual(ds.parse_autonomy_question(c)["question"],
                         self.GOOD["question"])

    def test_newest_block_malformed_does_not_fall_back_to_older(self):
        bad = dict(self.GOOD); bad.pop("answers")  # missing key
        c = [self._comment(self._fenced(self.GOOD), "2026-07-01T00:00:00Z"),
             self._comment(self._fenced(bad), "2026-07-05T00:00:00Z")]
        self.assertIsNone(ds.parse_autonomy_question(c))

    def test_extra_key_rejected(self):
        obj = dict(self.GOOD, sneaky="x")
        c = [self._comment(self._fenced(obj), "z")]
        self.assertIsNone(ds.parse_autonomy_question(c))

    def test_missing_key_rejected(self):
        obj = dict(self.GOOD); obj.pop("recommendation")
        c = [self._comment(self._fenced(obj), "z")]
        self.assertIsNone(ds.parse_autonomy_question(c))

    def test_too_many_answers_rejected(self):
        obj = dict(self.GOOD, answers=["a", "b", "c", "d"])
        c = [self._comment(self._fenced(obj), "z")]
        self.assertIsNone(ds.parse_autonomy_question(c))

    def test_empty_answers_rejected(self):
        obj = dict(self.GOOD, answers=[])
        c = [self._comment(self._fenced(obj), "z")]
        self.assertIsNone(ds.parse_autonomy_question(c))

    def test_non_string_answer_rejected(self):
        obj = dict(self.GOOD, answers=["ok", 3])
        c = [self._comment(self._fenced(obj), "z")]
        self.assertIsNone(ds.parse_autonomy_question(c))

    def test_wrong_type_scalar_rejected(self):
        obj = dict(self.GOOD, question=5)
        c = [self._comment(self._fenced(obj), "z")]
        self.assertIsNone(ds.parse_autonomy_question(c))

    def test_bad_json_rejected(self):
        c = [self._comment("```autonomy-question\n{not json}\n```", "z")]
        self.assertIsNone(ds.parse_autonomy_question(c))

    def test_non_object_json_rejected(self):
        c = [self._comment("```autonomy-question\n[1,2]\n```", "z")]
        self.assertIsNone(ds.parse_autonomy_question(c))

    def test_no_fence_returns_none(self):
        c = [self._comment("just a normal comment", "z")]
        self.assertIsNone(ds.parse_autonomy_question(c))

    def test_crlf_and_trailing_space_infostring(self):
        body = "x\r\n```autonomy-question   \r\n%s\r\n```\r\n" % json.dumps(self.GOOD)
        c = [self._comment(body, "z")]
        self.assertEqual(ds.parse_autonomy_question(c), self.GOOD)

    def test_total_against_bad_input(self):
        for bad in (None, [], "not a list", 42, [None], [{"body": 5}],
                    [{"createdAt": "z"}]):
            self.assertIsNone(ds.parse_autonomy_question(bad))


class ChildRunToleranceTest(unittest.TestCase):
    def test_child_run_state_files_never_crash_build_repo_state(self):
        # Phase C: child/slotted state files land in var/autonomy-logs; the
        # dashboard keeps the ROLE view until Phase D -- children are
        # invisible to its glob, but they must never crash the build.
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, True)
        os.makedirs(os.path.join(d, ".autonomy"))
        logdir = os.path.join(d, "var", "autonomy-logs")
        os.makedirs(logdir)
        with open(os.path.join(d, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("roles:\n  coder:\n    enabled: true\n")
        child = {"fmt": 2, "run_id": "coder.c0.qa-x-1", "role": "coder.c0.qa",
                 "lane": "", "doc": {"name": "qa-sweep", "nodes": []},
                 "meta": {}, "parent_run": "coder-x-1", "parent_node": "qa",
                 "call_depth": 1, "call_path": ["p", "qa-sweep"],
                 "units": {}, "status": "in_progress"}
        for fn in (".pipeline-run-coder.c0.qa.json",
                   ".pipeline-run-coder@2.json"):
            with open(os.path.join(logdir, fn), "w") as fh:
                json.dump(child, fh)
        with open(os.path.join(
                logdir, ".pipeline-run-coder.c0.qa.outcome.json"), "w") as fh:
            json.dump({"run_id": "x", "outcome": "success", "outputs": {}}, fh)
        st = ds.build_repo_state(d)          # must not raise
        self.assertIn("roles", st)


class ParseRunTokenTest(unittest.TestCase):
    """Phase D1 (#383): the filename-token parse twin of the supervisor's
    inflight_tokens rules -- strip @<digits> slot from the END, then
    --<lane>; reserved sidecar suffixes are never tokens."""

    def test_plain_token(self):
        got = ds._parse_run_token("adhoc-digest")
        self.assertEqual(got, {"token": "adhoc-digest", "name": "adhoc-digest",
                               "lane": "", "slot": 0, "child": False,
                               "parent": None})

    def test_slot_stripped_from_end(self):
        got = ds._parse_run_token("pr-sweep@1")
        self.assertEqual(got["name"], "pr-sweep")
        self.assertEqual(got["slot"], 1)

    def test_lane_then_slot(self):
        got = ds._parse_run_token("coder--qa@2", lane_hint="qa")
        self.assertEqual((got["name"], got["lane"], got["slot"]),
                         ("coder", "qa", 2))

    def test_lane_hint_only_strips_matching_suffix(self):
        # a trigger genuinely named a--b under NO lane keeps its full name
        got = ds._parse_run_token("a--b", lane_hint="")
        self.assertEqual(got["name"], "a--b")

    def test_child_token(self):
        got = ds._parse_run_token("adhoc-digest.c0.qa")
        self.assertTrue(got["child"])
        self.assertEqual(got["parent"], "adhoc-digest")

    def test_depth2_child_parent_is_last_call_segment(self):
        got = ds._parse_run_token("a.c0.qa.c1.x")
        self.assertEqual(got["parent"], "a.c0.qa")

    def test_reserved_sidecar_suffixes_never_tokens(self):
        for base in ("x.outputs", "x.verdict", "p.c0.qa.outcome",
                     "x.plan.outputs"):
            self.assertIsNone(ds._parse_run_token(base))

    def test_junk_refused(self):
        for base in ("x@@", "x@bad", "x@", "", "a b", "../x", "x@1@2"):
            self.assertIsNone(ds._parse_run_token(base))


class ListRunsTest(unittest.TestCase):
    """Phase D1 (#383): the runs list -- in-flight state files + a bounded
    journal tail; child linkage + @slot rows; total (never raises)."""

    FIXLOG = os.path.join(FIX, "var", "autonomy-logs")
    FIXJOURNAL = os.path.join(FIXLOG, "journal.jsonl")

    def test_fixture_inflight_and_journal_rows(self):
        runs = ds.list_runs(self.FIXLOG, self.FIXJOURNAL)
        by_token = dict((r["token"], r) for r in runs if r["token"])
        self.assertIn("adhoc-digest", by_token)
        self.assertIn("adhoc-digest.c0.qa", by_token)
        self.assertIn("pr-sweep@1", by_token)
        child = by_token["adhoc-digest.c0.qa"]
        self.assertTrue(child["child"])
        self.assertEqual(child["parent_run"],
                         "adhoc-digest-20260709T220000-7001")
        self.assertEqual(by_token["pr-sweep@1"]["slot"], 1)
        self.assertEqual(by_token["adhoc-digest"]["pipeline"], "fixture-flow")
        self.assertEqual(by_token["adhoc-digest"]["state"], "in-flight")
        self.assertEqual(by_token["adhoc-digest"]["status"], "in_progress")

    def test_fixture_journal_rows_trigger_keyed_and_child_flagged(self):
        runs = ds.list_runs(self.FIXLOG, self.FIXJOURNAL)
        fin = [r for r in runs if r["state"] == "finished"]
        self.assertTrue(fin)
        by_run = dict((r["run_id"], r) for r in fin)
        self.assertIn("adhoc-digest-20260707T080000-6001", by_run)
        cj = by_run.get("adhoc-digest.c0.qa-6002")
        self.assertIsNotNone(cj)
        self.assertTrue(cj["child"])
        self.assertEqual(cj["trigger"], "adhoc-digest.c0.qa")
        # grandfather display: the coder lines carry NO trigger -> role shown
        coder = [r for r in fin if r["trigger"] == "coder"]
        self.assertTrue(coder)

    def test_inflight_first_then_journal_newest_first(self):
        runs = ds.list_runs(self.FIXLOG, self.FIXJOURNAL)
        states = [r["state"] for r in runs]
        self.assertEqual(states, sorted(
            states, key=lambda s: 0 if s == "in-flight" else 1))
        fin = [r for r in runs if r["state"] == "finished"
               and r.get("finished")]
        self.assertEqual([r["finished"] for r in fin],
                         sorted([r["finished"] for r in fin], reverse=True))

    def test_corrupt_state_degrades_never_raises(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        with open(os.path.join(d, ".pipeline-run-broken.json"), "w") as fh:
            fh.write("{not json")
        runs = ds.list_runs(d, os.path.join(d, "journal.jsonl"))
        self.assertEqual(len(runs), 1)
        self.assertEqual(runs[0]["status"], "unreadable")
        self.assertEqual(runs[0]["token"], "broken")

    def test_sidecars_and_junk_filenames_skipped(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        for fn in (".pipeline-run-x.outputs.json",
                   ".pipeline-run-x.verdict.json",
                   ".pipeline-run-p.c0.qa.outcome.json",
                   ".pipeline-run-x@@.json"):
            with open(os.path.join(d, fn), "w") as fh:
                fh.write("{}")
        self.assertEqual(ds.list_runs(d, os.path.join(d, "journal.jsonl")),
                         [])

    def test_journal_limit_bounds_finished_rows(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        j = os.path.join(d, "journal.jsonl")
        with open(j, "w") as fh:
            for i in range(30):
                fh.write(json.dumps({"trigger": "t", "pipeline": "p",
                                     "outcome": "success", "pass": True,
                                     "run_id": "t-%d" % i, "finished": i,
                                     "started": i}) + "\n")
        runs = ds.list_runs(d, j, limit=5)
        self.assertEqual(len(runs), 5)
        self.assertEqual(runs[0]["run_id"], "t-29")


class BuildTriggersViewTest(unittest.TestCase):
    """Phase D1 (#383): the /api/triggers payload builder -- the route's
    totality boundary (prevention-log #21): every failure becomes a payload
    field, never an exception, never a healthy fallback."""

    def _tmp_copy(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        dst = os.path.join(d, "repo")
        shutil.copytree(FIX, dst)
        return dst

    def _mini_repo(self, triggers_json, journal_lines=None,
                   pipeline_params=None):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        os.makedirs(os.path.join(d, ".autonomy", "triggers"))
        pdir = os.path.join(d, ".autonomy", "pipelines", "flow")
        os.makedirs(pdir)
        doc = {"name": "flow", "version": 1,
               "caps": {"max_sessions_per_run": 5},
               "nodes": [{"id": "pick", "type": "pick",
                          "brief_ref": "pick.md"}]}
        if pipeline_params is not None:
            doc["params"] = pipeline_params
        with open(os.path.join(pdir, "pipeline.json"), "w") as fh:
            json.dump(doc, fh)
        with open(os.path.join(pdir, "pick.md"), "w") as fh:
            fh.write("pick brief\n")
        with open(os.path.join(d, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("roles: {}\n")
        for name, trig in triggers_json.items():
            with open(os.path.join(d, ".autonomy", "triggers",
                                   "%s.json" % name), "w") as fh:
                json.dump(trig, fh)
        logdir = os.path.join(d, "var", "autonomy-logs")
        os.makedirs(logdir)
        with open(os.path.join(logdir, "journal.jsonl"), "w") as fh:
            for r in (journal_lines or []):
                fh.write(json.dumps(r) + "\n")
        return d

    def test_fixture_happy_path(self):
        view = ds.build_triggers_view(FIX)
        self.assertNotIn("error", view)
        by_name = dict((t["name"], t) for t in view["triggers"])
        self.assertEqual(sorted(by_name),
                         ["adhoc-digest", "coder", "pr-sweep"])
        self.assertEqual(by_name["coder"]["kind"], "shim")
        self.assertEqual(by_name["adhoc-digest"]["kind"], "native")
        self.assertEqual(by_name["adhoc-digest"]["mode"], "manual")
        self.assertFalse(by_name["pr-sweep"]["enabled"])
        self.assertEqual(view["rollup"], {"fixture-flow": "watch"})
        self.assertTrue(by_name["adhoc-digest"]["fire_ready"])
        self.assertFalse(by_name["coder"]["fire_ready"])
        self.assertIn("manual", by_name["coder"]["fire_block_reason"])
        for t in by_name.values():
            self.assertTrue(t["window_open"])
            self.assertFalse(t["stopped"])
            self.assertFalse(t["fire_pending"])
            self.assertIsNone(t["backoff"])
        gal = dict((p["name"], p) for p in view["pipelines"])
        self.assertIn("fixture-flow", gal)
        self.assertEqual(gal["fixture-flow"]["version"], 2)
        self.assertEqual(gal["fixture-flow"]["source"], "committed")
        self.assertTrue(gal["fixture-flow"]["valid"])
        self.assertEqual(gal["fixture-flow"]["tier"], "watch")
        self.assertEqual(sorted(gal["fixture-flow"]["triggers"]),
                         ["adhoc-digest", "coder", "pr-sweep"])
        self.assertTrue(any(r["token"] == "pr-sweep@1" for r in view["runs"]))
        self.assertEqual(view["refused"], [])

    def test_disabled_zero_run_trigger_floors_rollup(self):
        # CP1: the floor must hold when the OTHER trigger is auto.
        lines = [{"role": "hot", "trigger": "hot", "pipeline": "flow",
                  "outcome": "success", "pass": True} for _ in range(20)]
        d = self._mini_repo(
            {"hot": {"name": "hot", "pipeline": "flow",
                     "firing": {"mode": "continuous"}},
             "cold": {"name": "cold", "pipeline": "flow", "enabled": False,
                      "firing": {"mode": "continuous"}}},
            journal_lines=lines)
        view = ds.build_triggers_view(d)
        tiers = dict((t["name"], t["tier"]) for t in view["triggers"])
        self.assertEqual(tiers["hot"], "auto")
        self.assertEqual(tiers["cold"], "watch")
        self.assertEqual(view["rollup"]["flow"], "watch")

    def test_refused_trigger_surfaces_verbatim_and_stays_out(self):
        d = self._tmp_copy()
        with open(os.path.join(d, ".autonomy", "triggers", "broken.json"),
                  "w") as fh:
            fh.write("{not json")
        view = ds.build_triggers_view(d)
        self.assertTrue(any("broken" in w for w in view["refused"]))
        self.assertNotIn("broken", [t["name"] for t in view["triggers"]])

    def test_marker_reads(self):
        d = self._tmp_copy()
        ctl = os.path.join(d, "var", "trigger-ctl")
        for sub, name in (("stop", "adhoc-digest"), ("fire", "adhoc-digest"),
                          ("queued", "pr-sweep")):
            os.makedirs(os.path.join(ctl, sub), exist_ok=True)
            with open(os.path.join(ctl, sub, name), "w"):
                pass
        os.makedirs(os.path.join(ctl, "backoff"), exist_ok=True)
        with open(os.path.join(ctl, "backoff", "coder"), "w") as fh:
            fh.write("1751880000\t3\n")
        view = ds.build_triggers_view(d)
        by_name = dict((t["name"], t) for t in view["triggers"])
        self.assertTrue(by_name["adhoc-digest"]["stopped"])
        self.assertTrue(by_name["adhoc-digest"]["fire_pending"])
        self.assertTrue(by_name["pr-sweep"]["queued"])
        self.assertEqual(by_name["coder"]["backoff"],
                         {"until": 1751880000, "count": 3})

    def test_corrupt_backoff_is_an_error_never_absence(self):
        # CP1 / prevention-log #18: present-but-unreadable degrades to an
        # error chip, never to the healthy None.
        d = self._tmp_copy()
        bdir = os.path.join(d, "var", "trigger-ctl", "backoff")
        os.makedirs(bdir)
        with open(os.path.join(bdir, "coder"), "w") as fh:
            fh.write("garbage no tab")
        view = ds.build_triggers_view(d)
        by_name = dict((t["name"], t) for t in view["triggers"])
        self.assertEqual(by_name["coder"]["backoff"],
                         {"error": "unreadable"})

    def test_run_window_closed_with_injected_now(self):
        d = self._mini_repo(
            {"windowed": {"name": "windowed", "pipeline": "flow",
                          "firing": {"mode": "manual"},
                          "run_windows": [{"start": "02:00",
                                           "end": "03:00"}]}})
        # 2026-07-10 12:00 UTC -- outside 02:00-03:00
        view = ds.build_triggers_view(d, now=1783080000)
        t = [x for x in view["triggers"] if x["name"] == "windowed"][0]
        self.assertFalse(t["window_open"])

    def test_unreadable_config_degrades_to_error_field(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        os.makedirs(os.path.join(d, ".autonomy"))
        with open(os.path.join(d, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("roles: [broken\n  - x\n")
        view = ds.build_triggers_view(d)
        self.assertIn("error", view)
        self.assertEqual(view["triggers"], [])
        self.assertEqual(view["pipelines"], [])

    def test_broken_pipeline_doc_degrades_gallery_row(self):
        d = self._mini_repo(
            {"t1": {"name": "t1", "pipeline": "flow",
                    "firing": {"mode": "manual"}}})
        with open(os.path.join(d, ".autonomy", "pipelines", "flow",
                               "pipeline.json"), "w") as fh:
            fh.write("{corrupt")
        view = ds.build_triggers_view(d)
        gal = dict((p["name"], p) for p in view["pipelines"])
        self.assertFalse(gal["flow"]["valid"])
        self.assertTrue(gal["flow"]["errors"])
        # fire-readiness is fail-safe on an unreadable doc
        t = [x for x in view["triggers"] if x["name"] == "t1"][0]
        self.assertFalse(t["fire_ready"])

    def test_fire_blocked_on_required_no_default_param(self):
        d = self._mini_repo(
            {"needy": {"name": "needy", "pipeline": "flow",
                       "firing": {"mode": "manual"}}},
            pipeline_params=[{"name": "ticket", "type": "string",
                              "required": True}])
        view = ds.build_triggers_view(d)
        t = [x for x in view["triggers"] if x["name"] == "needy"][0]
        self.assertFalse(t["fire_ready"])
        self.assertIn("ticket", t["fire_block_reason"])


class FireParamsProjectionTest(BuildTriggersViewTest):
    """Phase D2 (#383): declared-params projections for the authoring form
    (pipelines[].params) and the run-now overlay (triggers[].fire_params),
    plus the trigger_fire_ready overrides verdict the write side shares."""

    DECLS = [{"name": "q", "type": "string", "required": True},
             {"name": "n", "type": "number", "default": 3},
             {"name": "kind", "type": "enum", "choices": ["a", "b"],
              "required": False},
             {"name": "tok", "type": "secret", "default": "gh-label"}]

    def _params_repo(self, trig_params=None, mode="manual"):
        return self._mini_repo(
            {"adhoc": {"name": "adhoc", "pipeline": "flow",
                       "params": (trig_params if trig_params is not None
                                  else {"q": "saved"}),
                       "firing": {"mode": mode}}},
            pipeline_params=self.DECLS)

    def test_gallery_rows_carry_declared_params(self):
        d = self._params_repo()
        view = ds.build_triggers_view(d)
        gal = dict((p["name"], p) for p in view["pipelines"])
        params = dict((p["name"], p) for p in gal["flow"]["params"])
        self.assertEqual(sorted(params), ["kind", "n", "q", "tok"])
        self.assertTrue(params["q"]["required"])
        self.assertEqual(params["n"]["default"], 3)
        self.assertNotIn("default", params["q"])
        self.assertEqual(params["kind"]["choices"], ["a", "b"])
        self.assertEqual(params["tok"]["type"], "secret")
        # a secret's default is a LABEL (non-secret, SD-8) -- included so
        # the form can show it
        self.assertEqual(params["tok"]["default"], "gh-label")

    def test_invalid_doc_gallery_params_empty(self):
        d = self._params_repo()
        with open(os.path.join(d, ".autonomy", "pipelines", "flow",
                               "pipeline.json"), "w") as fh:
            fh.write("{corrupt")
        view = ds.build_triggers_view(d)
        gal = dict((p["name"], p) for p in view["pipelines"])
        self.assertEqual(gal["flow"]["params"], [])

    def test_manual_trigger_row_carries_fire_params(self):
        d = self._params_repo()
        view = ds.build_triggers_view(d)
        t = [x for x in view["triggers"] if x["name"] == "adhoc"][0]
        self.assertEqual([p["name"] for p in t["fire_params"]],
                         [p["name"] for p in
                          ds._declared_params({"params": self.DECLS})])
        self.assertTrue(t["fire_ready"])          # saved q + defaults

    def test_non_manual_trigger_fire_params_empty(self):
        d = self._params_repo(mode="continuous")
        view = ds.build_triggers_view(d)
        t = [x for x in view["triggers"] if x["name"] == "adhoc"][0]
        self.assertEqual(t["fire_params"], [])

    def test_unreadable_doc_fire_params_empty(self):
        d = self._params_repo()
        with open(os.path.join(d, ".autonomy", "pipelines", "flow",
                               "pipeline.json"), "w") as fh:
            fh.write("{corrupt")
        view = ds.build_triggers_view(d)
        t = [x for x in view["triggers"] if x["name"] == "adhoc"][0]
        self.assertEqual(t["fire_params"], [])

    def _trig(self, params=None, mode="manual"):
        return {"name": "adhoc", "pipeline": "flow",
                "params": params if params is not None else {"q": "saved"},
                "firing": {"mode": mode}}

    def test_fire_ready_overrides_none_is_d1_verdict(self):
        d = self._params_repo()
        ok, reason = ds.trigger_fire_ready(d, self._trig())
        self.assertTrue(ok)
        ok, reason = ds.trigger_fire_ready(d, self._trig(params={}))
        self.assertFalse(ok)                      # required q unset
        self.assertIn("q", reason)

    def test_fire_ready_overrides_fix_missing_required(self):
        d = self._params_repo()
        ok, reason = ds.trigger_fire_ready(d, self._trig(params={}),
                                           overrides={"q": "supplied"})
        self.assertTrue(ok, reason)

    def test_fire_ready_overrides_refusals(self):
        d = self._params_repo()
        trig = self._trig()
        ok, reason = ds.trigger_fire_ready(d, trig, overrides=["q"])
        self.assertFalse(ok)
        ok, reason = ds.trigger_fire_ready(d, trig,
                                           overrides={"ghost": "x"})
        self.assertFalse(ok)
        ok, reason = ds.trigger_fire_ready(d, trig,
                                           overrides={"q": ["list"]})
        self.assertFalse(ok)
        self.assertIn("scalar", reason)
        ok, reason = ds.trigger_fire_ready(
            d, trig, overrides={"tok": "hunter2 raw!"})
        self.assertFalse(ok)
        self.assertIn("tok", reason)
        self.assertNotIn("hunter2", reason)      # never echo the value
        ok, reason = ds.trigger_fire_ready(d, trig,
                                           overrides={"n": "abc"})
        self.assertFalse(ok)                      # type mismatch

    def test_fire_ready_existence_parity_with_start(self):
        # CP2 finding 2: the write-side verdict runs the SAME existence
        # checks start does (_resolve_run_params), so a payload naming an
        # unregistered repo is refused HERE, not accepted then rejected at
        # firecheck/start.
        d = self._mini_repo(
            {"adhoc": {"name": "adhoc", "pipeline": "flow",
                       "params": {"target": "/good"},
                       "firing": {"mode": "manual"}}},
            pipeline_params=[{"name": "target", "type": "repo",
                              "required": True}])
        trig = {"name": "adhoc", "pipeline": "flow",
                "params": {"target": "/good"}, "firing": {"mode": "manual"}}
        real = ds.pipeline_mod._registered_repos
        ds.pipeline_mod._registered_repos = lambda: {"/good"}
        try:
            ok, _ = ds.trigger_fire_ready(d, trig)          # saved good
            self.assertTrue(ok)
            ok, reason = ds.trigger_fire_ready(
                d, trig, overrides={"target": "/ghost"})
            self.assertFalse(ok)                            # existence
        finally:
            ds.pipeline_mod._registered_repos = real


class RepoStateTriggersTest(unittest.TestCase):
    """Phase D1 (#383): build_repo_state's additive trigger keys -- light
    rows for the fleet rail + trust for the repo card/needs-you. Nothing
    existing is removed; an unreadable trigger layer degrades to an error
    field with the role rows as the rail fallback."""

    def test_fixture_light_rows_and_trust(self):
        st = ds.build_repo_state(FIX, git_in_flight=lambda p: {})
        self.assertIn("roles", st)                     # untouched
        names = sorted(t["name"] for t in st["triggers"])
        self.assertEqual(names, ["adhoc-digest", "coder", "pr-sweep"])
        self.assertEqual(st["trust"]["rollup"], {"fixture-flow": "watch"})
        self.assertEqual(st["trust"]["refused"], [])
        for t in st["triggers"]:
            self.assertIn("tier", t)
            self.assertIn("window_open", t)
            self.assertFalse(t["stopped"])
            self.assertFalse(t["missed_fire"])

    def test_broken_trigger_layer_degrades_to_trust_error(self):
        # build_repo_state's guard: a raising/erroring build_triggers_view
        # becomes trust.error + triggers=[] (rail falls back to role rows),
        # never a crash. (A config that does not PARSE at all raises out of
        # _read_config before this layer -- pre-existing; the server wraps
        # per-repo exceptions into an error card.)
        real = ds.build_triggers_view
        ds.build_triggers_view = lambda *a, **k: (_ for _ in ()).throw(
            RuntimeError("boom"))
        try:
            st = ds.build_repo_state(FIX, git_in_flight=lambda p: {})
        finally:
            ds.build_triggers_view = real
        self.assertEqual(st["triggers"], [])
        self.assertIn("error", st["trust"])
        self.assertIn("roles", st)                     # the rail fallback

    def test_error_payload_from_trigger_layer_also_degrades(self):
        real = ds.build_triggers_view
        ds.build_triggers_view = lambda *a, **k: {
            "error": "triggers unavailable: x", "triggers": [], "rollup": {},
            "refused": [], "pipelines": [], "runs": []}
        try:
            st = ds.build_repo_state(FIX, git_in_flight=lambda p: {})
        finally:
            ds.build_triggers_view = real
        self.assertEqual(st["triggers"], [])
        self.assertEqual(st["trust"]["error"], "triggers unavailable: x")


class TriggerHealthNativesTest(unittest.TestCase):
    """Phase D1 (#383, CP1): native schedule triggers write the same
    var/cron/<name>.last_fire markers -- the config-cron-roles-only reader
    would miss a stalled native scheduler."""

    NOW = 2000000

    def _marker_dir(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        return d

    def test_native_schedule_stall_reported(self):
        d = self._marker_dir()
        with open(os.path.join(d, "t1.last_fire"), "w") as fh:
            fh.write("1000")                       # ancient
        out = ds.trigger_health({"roles": {}}, d, self.NOW,
                                schedule_triggers=[{"name": "t1",
                                                    "schedule": "*/15 * * * *"}])
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["role"], "t1")
        self.assertEqual(out[0]["kind"], "native")
        self.assertTrue(out[0]["missed"])

    def test_same_name_native_supersedes_role_row(self):
        d = self._marker_dir()
        cfg = {"roles": {"night": {"enabled": True,
                                    "trigger": {"type": "cron",
                                                "schedule": "*/15 * * * *"}}}}
        out = ds.trigger_health(cfg, d, self.NOW,
                                schedule_triggers=[{"name": "night",
                                                    "schedule": "*/15 * * * *"}])
        self.assertEqual([r["role"] for r in out], ["night"])   # ONE row
        self.assertEqual(out[0]["kind"], "native")

    def test_role_rows_gain_kind_and_junk_natives_skipped(self):
        d = self._marker_dir()
        cfg = {"roles": {"pm": {"enabled": True,
                                 "trigger": {"type": "cron",
                                             "schedule": "*/15 * * * *"}}}}
        out = ds.trigger_health(cfg, d, self.NOW,
                                schedule_triggers=[7, {"name": 1},
                                                   {"name": "x"}, "junk"])
        self.assertEqual([r["role"] for r in out], ["pm"])
        self.assertEqual(out[0]["kind"], "role")


class PipelineViewByNameTokenTest(unittest.TestCase):
    """Phase D1 (#383): canvas addressing grows name= (gallery cards,
    native triggers have no role) and token= (a run's own embedded doc,
    lit; child rows open the CHILD canvas w/ parent breadcrumb)."""

    def test_by_name_resolves_committed_pipeline(self):
        view = ds.build_pipeline_view(FIX, name="fixture-flow")
        self.assertNotIn("error", view)
        self.assertIsNone(view["role"])
        self.assertEqual(view["source"]["kind"], "pipeline")
        self.assertEqual(view["source"]["name"], "fixture-flow")
        self.assertEqual(view["source"]["version"], 2)
        self.assertEqual(view["errors"], [])
        self.assertTrue(view["edges_effective"])
        self.assertIsNone(view["ledger"])       # trust lives on /api/triggers
        self.assertIsNone(view["in_flight"])

    def test_by_name_charset_refused(self):
        self.assertIn("error", ds.build_pipeline_view(FIX, name="../x"))

    def test_by_token_renders_run_doc_with_breadcrumb(self):
        view = ds.build_pipeline_view(FIX, token="adhoc-digest.c0.qa")
        self.assertNotIn("error", view)
        self.assertEqual(view["source"]["kind"], "run")
        self.assertEqual(view["run"]["token"], "adhoc-digest.c0.qa")
        self.assertEqual(view["run"]["parent_run"],
                         "adhoc-digest-20260709T220000-7001")
        self.assertEqual(view["run"]["parent_token"], "adhoc-digest")
        self.assertTrue(view["run"]["child"])
        self.assertEqual(view["in_flight"]["units"],
                         {"pick": "dispatched"})
        # CP1: the fixture's MINIMAL embedded doc (no caps) must render as
        # DEGRADED truth -- errors populated, doc still visible.
        self.assertTrue(view["errors"])
        self.assertIsNotNone(view["doc"])

    def test_by_token_slotted_parent_breadcrumb(self):
        # #385 review round 1 WARNING, resolved by pinning the semantics:
        # the child token's .c<N>. segment IS the parent's own @slot by
        # construction (pipeline._child_token_name -- a parent running as
        # pr-sweep@1 spawns pr-sweep.c1.<node>), NOT a call index. The
        # breadcrumb therefore re-suffixes @<N> exactly.
        import pipeline as pl
        self.assertEqual(
            pl._child_token_name(
                "var/autonomy-logs/.pipeline-run-pr-sweep@1.json",
                {"lane": ""}, "qa"),
            "pr-sweep.c1.qa")            # the constructor's own grammar
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        logdir = os.path.join(d, "var", "autonomy-logs")
        os.makedirs(logdir)
        with open(os.path.join(logdir,
                               ".pipeline-run-pr-sweep.c1.qa.json"),
                  "w") as fh:
            json.dump({"fmt": 2, "run_id": "pr-sweep.c1.qa-9001",
                       "trigger": "pr-sweep.c1.qa", "status": "in_progress",
                       "parent_run": "pr-sweep-20260709T230000-7003",
                       "doc": {"name": "fixture-flow", "nodes": []},
                       "units": {}}, fh)
        view = ds.build_pipeline_view(d, token="pr-sweep.c1.qa")
        self.assertEqual(view["run"]["parent_token"], "pr-sweep@1")

    def test_by_token_grammar_matrix(self):
        ok = ds.build_pipeline_view(FIX, token="pr-sweep@1")
        self.assertNotIn("error", ok)
        self.assertEqual(ok["run"]["slot"], 1)
        for bad in ("x@bad", "x@@", "x.outputs", "p.c0.qa.outcome",
                    "../x", "a b"):
            self.assertIn("error", ds.build_pipeline_view(FIX, token=bad))

    def test_by_token_missing_state_is_an_error(self):
        self.assertIn("error",
                      ds.build_pipeline_view(FIX, token="no-such-run"))

    def test_exactly_one_selector(self):
        self.assertIn("error", ds.build_pipeline_view(FIX))
        self.assertIn("error", ds.build_pipeline_view(
            FIX, role="coder", name="fixture-flow"))
        self.assertIn("error", ds.build_pipeline_view(
            FIX, name="fixture-flow", token="pr-sweep@1"))

    def test_role_path_unchanged(self):
        view = ds.build_pipeline_view(FIX, "coder")
        self.assertEqual(view["role"], "coder")
        self.assertEqual(view["source"]["kind"], "pipeline")
        self.assertEqual(view["errors"], [])
        self.assertIsNotNone(view["ledger"])


if __name__ == "__main__":
    unittest.main()


class TestRecentSessions(unittest.TestCase):
    """recent_sessions (#148 part 2): the last ~N session summaries for the
    history panel -- role (from the .role sidecar), outcome, tokens, ticket --
    derived from files already on disk, no gh."""

    def _write(self, d, name, lines, role=None):
        with open(os.path.join(d, name), "w") as fh:
            for ln in lines:
                fh.write(json.dumps(ln) + "\n")
        if role is not None:
            with open(os.path.join(d, name[:-4] + ".role"), "w") as fh:
                fh.write(role)

    def _clean(self, ticket=57, toks=123):
        return [
            {"type": "assistant", "message": {"model": "claude-opus-4-8",
             "content": [{"type": "text", "text": "Working #%d" % ticket}],
             "usage": {"output_tokens": 10}}},
            {"type": "result", "is_error": False,
             "usage": {"output_tokens": toks}, "result": "done"},
        ]

    def test_newest_first_with_role_and_fields(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        self._write(d, "session-20260101T000000.log", self._clean(57, 100), role="coder")
        self._write(d, "session-20260101T010000.log", self._clean(88, 200), role="qa")
        got = ds.recent_sessions(d)
        self.assertEqual([s["log"] for s in got],
                         ["session-20260101T010000.log", "session-20260101T000000.log"])
        self.assertEqual(got[0]["role"], "qa")
        self.assertEqual(got[0]["outcome"], "clean")
        self.assertEqual(got[0]["tokens"], 200)
        self.assertEqual(got[0]["ticket"], 88)

    def test_carries_cost_from_result(self):
        # #186 lane-detail effort: recent_sessions must surface each session's
        # cost so ticket_effort can total $ across a ticket's sessions.
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        self._write(d, "session-a.log", [
            {"type": "assistant", "message": {"content": [
                {"type": "text", "text": "Working #42"}],
             "usage": {"output_tokens": 10}}},
            {"type": "result", "is_error": False, "total_cost_usd": 3.25,
             "usage": {"output_tokens": 100}, "result": "done"}])
        got = ds.recent_sessions(d)[0]
        self.assertAlmostEqual(got["cost"], 3.25, places=4)

    def test_cost_zero_when_result_omits_it(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        self._write(d, "session-a.log", self._clean(57, 100))   # no total_cost_usd
        self.assertEqual(ds.recent_sessions(d)[0]["cost"], 0)

    def test_outcome_error(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        self._write(d, "session-a.log", [{"type": "result", "is_error": True}])
        self.assertEqual(ds.recent_sessions(d)[0]["outcome"], "error")

    def test_outcome_rate_limited(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        self._write(d, "session-a.log", [
            {"type": "rate_limit_event",
             "rate_limit_info": {"status": "rejected", "isUsingOverage": False}},
            {"type": "result", "is_error": False, "usage": {"output_tokens": 5}},
        ])
        self.assertEqual(ds.recent_sessions(d)[0]["outcome"], "rate-limited")

    def test_outcome_running_when_no_result(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        self._write(d, "session-a.log", [
            {"type": "assistant", "message": {"content": [
                {"type": "text", "text": "hi"}], "usage": {"output_tokens": 3}}}])
        self.assertEqual(ds.recent_sessions(d)[0]["outcome"], "running")

    def test_missing_role_sidecar_is_blank(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        self._write(d, "session-a.log", self._clean())   # no role file
        self.assertEqual(ds.recent_sessions(d)[0]["role"], "")

    def test_limit_caps(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        for i in range(15):
            self._write(d, "session-%02d.log" % i, self._clean())
        self.assertEqual(len(ds.recent_sessions(d, limit=10)), 10)

    def test_empty_logdir(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        self.assertEqual(ds.recent_sessions(d), [])

    def test_corrupt_role_sidecar_degrades_not_raises(self):
        # a non-UTF-8 .role sidecar must not blow up the whole state response
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        self._write(d, "session-a.log", self._clean(42, 50))
        with open(os.path.join(d, "session-a.role"), "wb") as fh:
            fh.write(b"\xff\xfe bad bytes")
        got = ds.recent_sessions(d)          # must not raise
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]["ticket"], 42)


class TestRecentQuotaWindows(unittest.TestCase):
    """The 5-hour bar went 'dead' because quota was read from ONLY the newest
    session log, which often carries just one window type. recent_quota_windows
    merges the most-recent snapshot of each window across recent logs."""

    def _rle(self, wt, resets_at, util):
        return {"type": "rate_limit_event",
                "rate_limit_info": {"rateLimitType": wt, "resetsAt": resets_at,
                                    "utilization": util, "isUsingOverage": False}}

    def _log(self, d, name, events):
        with open(os.path.join(d, name), "w") as fh:
            for ev in events:
                fh.write(json.dumps(ev) + "\n")

    def test_merges_five_hour_from_older_log_when_newest_lacks_it(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        # older log holds the five_hour snapshot; the NEWEST holds only seven_day
        self._log(d, "session-20260101T000000.log", [self._rle("five_hour", 1000, 0.42)])
        self._log(d, "session-20260101T010000.log", [self._rle("seven_day", 2000, 0.60)])
        w = ds.recent_quota_windows(d)
        self.assertIn("five_hour", w)
        self.assertIn("seven_day", w)
        self.assertAlmostEqual(w["five_hour"]["utilization"], 0.42)
        self.assertAlmostEqual(w["seven_day"]["utilization"], 0.60)

    def test_takes_most_recent_snapshot_per_window(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        self._log(d, "session-20260101T000000.log", [self._rle("five_hour", 1000, 0.20)])
        self._log(d, "session-20260101T010000.log", [self._rle("five_hour", 5000, 0.55)])
        w = ds.recent_quota_windows(d)
        self.assertEqual(w["five_hour"]["resets_at"], 5000)
        self.assertAlmostEqual(w["five_hour"]["utilization"], 0.55)

    def test_empty_logdir(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        self.assertEqual(ds.recent_quota_windows(d), {})

    def test_finds_sparse_seven_day_many_logs_back(self):
        # The real bug: five_hour lands in ~every session log but seven_day is
        # SPARSE -- its most-recent event was ~18 logs back, past the old 12-log
        # window, so the weekly went missing. The scan must reach it. Here 20
        # logs all carry five_hour; only the OLDEST carries seven_day.
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        for i in range(20):
            events = [self._rle("five_hour", 9000 + i, 0.10)]
            if i == 0:                                   # oldest -> 20th-newest
                events.append(self._rle("seven_day", 7000, 0.63))
            self._log(d, "session-%03d.log" % i, events)
        w = ds.recent_quota_windows(d)
        self.assertIn("seven_day", w)                    # found despite being 20 back
        self.assertAlmostEqual(w["seven_day"]["utilization"], 0.63)
        self.assertIn("five_hour", w)
        self.assertEqual(w["five_hour"]["resets_at"], 9019)  # newest 5h window

    def test_peak_util_wins_over_later_spurious_low_at_same_window(self):
        # a session that just hit the limit logs a spurious low reading at the
        # SAME resets_at as the real ~peak; the peak must win (bar was reading 0%
        # right after the account maxed out).
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        self._log(d, "session-20260101T000000.log", [self._rle("five_hour", 9000, 0.99)])
        self._log(d, "session-20260101T010000.log", [self._rle("five_hour", 9000, 0.0)])  # newest, spurious 0
        w = ds.recent_quota_windows(d)
        self.assertAlmostEqual(w["five_hour"]["utilization"], 0.99)

    def test_newer_window_still_wins_over_older_higher_util(self):
        # a genuinely NEW window (higher resets_at) with low util must beat an
        # old window's high util -- recency of the window trumps peak.
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        self._log(d, "session-20260101T000000.log", [self._rle("five_hour", 1000, 0.95)])
        self._log(d, "session-20260101T010000.log", [self._rle("five_hour", 9000, 0.10)])  # new window
        w = ds.recent_quota_windows(d)
        self.assertEqual(w["five_hour"]["resets_at"], 9000)
        self.assertAlmostEqual(w["five_hour"]["utilization"], 0.10)

    def test_partial_window_dict_degrades_not_keyerror(self):
        # parse_quota_windows is the sole producer today and always sets both
        # keys, but the merge must degrade gracefully -- not KeyError -- if a
        # producer ever hands back a partial window (missing utilization). Stub
        # the producer at the seam to feed two logs' worth of partial dicts.
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        self._log(d, "session-20260101T000000.log", [self._rle("five_hour", 1000, 0.5)])
        self._log(d, "session-20260101T010000.log", [self._rle("five_hour", 2000, 0.5)])
        # SAME resets_at both times forces the utilization comparison branch --
        # the one that indexed win["utilization"] directly and would KeyError.
        partial = iter([{"five_hour": {"resets_at": 2000}},
                        {"five_hour": {"resets_at": 2000}}])
        orig = ds.parse_quota_windows
        ds.parse_quota_windows = lambda _p: next(partial)
        try:
            w = ds.recent_quota_windows(d)   # must not raise
        finally:
            ds.parse_quota_windows = orig
        self.assertEqual(w["five_hour"]["resets_at"], 2000)


class TestSessionRole(unittest.TestCase):
    """The dashboard attributes the live session to its dispatched role from the
    `session-<ts>.role` sidecar the supervisor writes (#148), never by parsing
    the voice log."""

    def test_role_read_from_marker(self):
        d = tempfile.mkdtemp()
        try:
            log = os.path.join(d, "session-20260701T120000.log")
            open(log, "w").close()
            with open(os.path.join(d, "session-20260701T120000.role"), "w") as fh:
                fh.write("qa\n")
            self.assertEqual(ds._session_role(log), "qa")
        finally:
            shutil.rmtree(d)

    def test_role_empty_when_no_marker(self):
        d = tempfile.mkdtemp()
        try:
            log = os.path.join(d, "session-20260701T120000.log")
            open(log, "w").close()
            self.assertEqual(ds._session_role(log), "")
        finally:
            shutil.rmtree(d)

    def test_build_repo_state_carries_current_session_role(self):
        repo = tempfile.mkdtemp()
        try:
            logdir = os.path.join(repo, "var", "autonomy-logs")
            os.makedirs(logdir)
            log = os.path.join(logdir, "session-20260701T120000.log")
            with open(log, "w") as fh:
                fh.write('{"type":"system","subtype":"init"}\n')
            with open(os.path.join(logdir, "session-20260701T120000.role"), "w") as fh:
                fh.write("researcher\n")
            state = ds.build_repo_state(repo, git_in_flight=lambda _p: {})
            self.assertEqual(state["current_session"]["role"], "researcher")
        finally:
            shutil.rmtree(repo)

    def test_build_repo_state_role_empty_without_marker(self):
        repo = tempfile.mkdtemp()
        try:
            logdir = os.path.join(repo, "var", "autonomy-logs")
            os.makedirs(logdir)
            with open(os.path.join(logdir, "session-20260701T120000.log"), "w") as fh:
                fh.write('{"type":"system","subtype":"init"}\n')
            state = ds.build_repo_state(repo, git_in_flight=lambda _p: {})
            self.assertEqual(state["current_session"]["role"], "")
        finally:
            shutil.rmtree(repo)

    def test_build_repo_state_roles_carry_last_run(self):
        # #185 fleet rail: roles built by build_repo_state are enriched with the
        # last-run summary from the repo's own recent_sessions. The FIX fixture's
        # newest session (role qa) gives the qa row a last_run.
        state = ds.build_repo_state(FIX, git_in_flight=lambda _p: {})
        for r in state["roles"]:
            self.assertIn("last_run", r)
        qa = next(r for r in state["roles"] if r["name"] == "qa")
        self.assertIsNotNone(qa["last_run"])
        self.assertEqual(set(qa["last_run"]), {"at", "outcome"})


class TestEngineVersion(unittest.TestCase):
    """#166 slice 1: the engine 'update available' truth signal. Each service
    records the engine sha it booted from; the dashboard compares to the engine
    checkout's current HEAD and shows a chip when they diverge. Fail-safe: a
    corrupt / unreadable / non-hex sha never manufactures a false stale, and an
    unreadable current HEAD reports nothing stale (never cry wolf)."""

    def _git_repo(self):
        d = tempfile.mkdtemp()
        env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t",
                   GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")

        def g(*args):
            subprocess.run(["git", "-C", d] + list(args), check=True, env=env,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        g("init", "-q")
        return d, g

    # -- engine_head_sha (real git) --
    def test_head_sha_reads_engine_checkout(self):
        d, g = self._git_repo()
        try:
            open(os.path.join(d, "a"), "w").close()
            g("add", "a")
            g("commit", "-qm", "one")
            self.assertRegex(ds.engine_head_sha(d), r"^[0-9a-f]{40}$")
        finally:
            shutil.rmtree(d)

    def test_head_sha_empty_on_non_repo(self):
        d = tempfile.mkdtemp()
        try:
            self.assertEqual(ds.engine_head_sha(d), "")
        finally:
            shutil.rmtree(d)

    # -- engine_commits_behind (real git) --
    def test_commits_behind_counts_new_commits(self):
        d, g = self._git_repo()
        try:
            open(os.path.join(d, "a"), "w").close()
            g("add", "a")
            g("commit", "-qm", "one")
            first = ds.engine_head_sha(d)
            open(os.path.join(d, "b"), "w").close()
            g("add", "b")
            g("commit", "-qm", "two")
            head = ds.engine_head_sha(d)
            self.assertEqual(ds.engine_commits_behind(first, head, d), 1)
            self.assertEqual(ds.engine_commits_behind(head, head, d), 0)
        finally:
            shutil.rmtree(d)

    def test_commits_behind_none_on_bad_input(self):
        self.assertIsNone(ds.engine_commits_behind("", "a" * 40, "/nonexistent"))
        self.assertIsNone(
            ds.engine_commits_behind("d" * 40, "c" * 40, "/nonexistent/xyz"))

    # -- engine_checkout_behind_origin (#270): HEAD vs origin/main, real git --
    def test_checkout_behind_none_when_not_a_repo(self):
        # fail-safe: git fetch fails outside a repo -> contribute nothing, never
        # invent staleness (and never raise).
        self.assertIsNone(ds.engine_checkout_behind_origin("/nonexistent/xyz"))

    def test_checkout_behind_none_when_no_origin_remote(self):
        # a repo with no `origin` remote (offline / detached-serving analogue):
        # the fetch fails, so the reader stays silent rather than erroring.
        d, g = self._git_repo()
        try:
            open(os.path.join(d, "a"), "w").close()
            g("add", "a")
            g("commit", "-qm", "one")
            self.assertIsNone(ds.engine_checkout_behind_origin(d))
        finally:
            shutil.rmtree(d)

    def test_checkout_behind_counts_commits_origin_has(self):
        # a real local "origin": clone, advance origin/main by one commit, then
        # the clone (HEAD behind) reports 1; even-with-origin reports 0.
        up, ug = self._git_repo()
        cl = tempfile.mkdtemp()
        try:
            open(os.path.join(up, "a"), "w").close()
            ug("add", "a")
            ug("commit", "-qm", "one")
            ug("branch", "-M", "main")
            subprocess.run(["git", "clone", "-q", up, cl],
                           check=True, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL)
            self.assertEqual(ds.engine_checkout_behind_origin(cl), 0)
            open(os.path.join(up, "b"), "w").close()
            ug("add", "b")
            ug("commit", "-qm", "two")
            self.assertEqual(ds.engine_checkout_behind_origin(cl), 1)
        finally:
            shutil.rmtree(up)
            shutil.rmtree(cl)

    # -- read_engine_boot_sha (pure file IO + hex validation) --
    def _logdir_with(self, content):
        d = tempfile.mkdtemp()
        if content is not None:
            with open(os.path.join(d, "engine_sha"), "w") as fh:
                fh.write(content)
        return d

    def test_boot_sha_valid_hex(self):
        sha = "0123456789abcdef" * 2 + "01234567"  # 40 hex
        d = self._logdir_with(sha + "\n")
        try:
            self.assertEqual(ds.read_engine_boot_sha(d), sha)
        finally:
            shutil.rmtree(d)

    def test_boot_sha_absent_returns_empty(self):
        d = self._logdir_with(None)
        try:
            self.assertEqual(ds.read_engine_boot_sha(d), "")
        finally:
            shutil.rmtree(d)

    def test_boot_sha_rejects_malformed(self):
        # non-hex, uppercase (git emits lowercase), too short, too long, blank
        for bad in ["not-a-sha\n", "A" * 40 + "\n", "a" * 39 + "\n",
                    "a" * 41 + "\n", "\n", "   \n", "abc def\n"]:
            d = self._logdir_with(bad)
            try:
                self.assertEqual(ds.read_engine_boot_sha(d), "",
                                 "expected '' for %r" % bad)
            finally:
                shutil.rmtree(d)

    # -- engine_status composition (readers injected, no git) --
    def _status(self, current, dash_boot, repos, behind_map=None,
                checkout_behind=None):
        bm = behind_map or {}
        return ds.engine_status(
            dash_boot, repos,
            head_reader=lambda home=None: current,
            behind_reader=lambda running, cur, home=None: bm.get(running),
            checkout_behind_reader=lambda: checkout_behind)

    def test_status_all_fresh_not_stale(self):
        cur = "a" * 40
        repos = [{"name": "r", "engine_boot": cur,
                  "lifecycle": {"state": "running"}}]
        st = self._status(cur, cur, repos)
        self.assertFalse(st["stale"])
        self.assertFalse(st["dashboard"]["stale"])
        self.assertIsNone(st["behind"])
        self.assertEqual(st["supervisors"],
                         [{"repo": "r", "sha": cur, "behind": None,
                           "stale": False}])

    def test_status_dashboard_behind(self):
        cur, old = "b" * 40, "a" * 40
        repos = [{"name": "r", "engine_boot": cur,
                  "lifecycle": {"state": "running"}}]
        st = self._status(cur, old, repos, behind_map={old: 3})
        self.assertTrue(st["stale"])
        self.assertTrue(st["dashboard"]["stale"])
        self.assertEqual(st["dashboard"]["behind"], 3)
        self.assertEqual(st["behind"], 3)

    def test_status_paused_supervisor_counts_as_stale(self):
        # a LIVE-but-paused loop is still booted from old code
        cur, old = "b" * 40, "a" * 40
        repos = [{"name": "r", "engine_boot": old,
                  "lifecycle": {"state": "paused"}}]
        st = self._status(cur, cur, repos, behind_map={old: 2})
        self.assertTrue(st["stale"])
        self.assertEqual(st["supervisors"][0]["stale"], True)
        self.assertEqual(st["behind"], 2)

    def test_status_stopped_supervisor_ignored(self):
        # a stopped supervisor keeps a stale lock pid -- gate on STATE, not pid,
        # so its old engine_sha never fakes a restart chip (Codex CP2)
        cur, old = "b" * 40, "a" * 40
        repos = [{"name": "r", "engine_boot": old,
                  "lifecycle": {"state": "stopped", "pid": 999}}]
        st = self._status(cur, cur, repos)  # dashboard fresh, supervisor stopped
        self.assertFalse(st["stale"])
        self.assertEqual(st["supervisors"], [])

    def test_status_current_unreadable_never_stale(self):
        old = "a" * 40
        repos = [{"name": "r", "engine_boot": "b" * 40,
                  "lifecycle": {"state": "running"}}]
        st = self._status("", old, repos)  # head unreadable -> ''
        self.assertFalse(st["stale"])
        self.assertFalse(st["dashboard"]["stale"])
        self.assertFalse(st["supervisors"][0]["stale"])

    def test_status_behind_is_max_across_stale(self):
        cur, d_old, s_old = "c" * 40, "a" * 40, "b" * 40
        repos = [{"name": "r", "engine_boot": s_old,
                  "lifecycle": {"state": "running"}}]
        st = self._status(cur, d_old, repos, behind_map={d_old: 2, s_old: 5})
        self.assertTrue(st["stale"])
        self.assertEqual(st["behind"], 5)

    def test_status_live_supervisor_unknown_sha_flagged(self):
        # a LIVE supervisor with no valid recorded sha (pre-feature / torn write)
        # is flagged stale -- hiding an unknown is fail-open (Codex CP2). sha ""
        # and behind None, but it drives the chip so the operator restarts.
        cur = "a" * 40
        repos = [{"name": "r", "engine_boot": "",
                  "lifecycle": {"state": "running"}}]
        st = self._status(cur, cur, repos)
        self.assertTrue(st["stale"])
        self.assertEqual(st["supervisors"],
                         [{"repo": "r", "sha": "", "behind": None,
                           "stale": True}])
        self.assertIsNone(st["behind"])  # unknown-sha contributes no count

    def test_status_unknown_sha_not_stale_when_head_unreadable(self):
        # no reference point (current == "") -> never cry wolf, even unknown sha
        repos = [{"name": "r", "engine_boot": "",
                  "lifecycle": {"state": "running"}}]
        st = self._status("", "a" * 40, repos)
        self.assertFalse(st["stale"])
        self.assertFalse(st["supervisors"][0]["stale"])

    # -- chip model (#240): the per-component decision the render consumes.
    # engine_status embeds it so the branch logic that had the cry-wolf bug is
    # exercised by run_all.sh, not only by the browser verify loop.
    def test_chip_hidden_when_nothing_stale(self):
        cur = "a" * 40
        repos = [{"name": "r", "engine_boot": cur,
                  "lifecycle": {"state": "running"}}]
        chip = self._status(cur, cur, repos)["chip"]
        self.assertFalse(chip["show"])
        self.assertEqual(chip["mode"], "none")

    def test_chip_dashboard_stale_is_a_restart_cta(self):
        # the dashboard is the shell the operator restarts -> mode 'dashboard',
        # carrying ITS OWN behind count for the CTA.
        cur, old = "b" * 40, "a" * 40
        repos = [{"name": "r", "engine_boot": cur,
                  "lifecycle": {"state": "running"}}]
        chip = self._status(cur, old, repos, behind_map={old: 3})["chip"]
        self.assertTrue(chip["show"])
        self.assertEqual(chip["mode"], "dashboard")
        self.assertEqual(chip["dashboard_behind"], 3)

    def test_chip_supervisor_only_is_informational_not_dashboard(self):
        # defect 1: dashboard CURRENT, only a supervisor behind -> mode
        # 'supervisors' (informational), never a dashboard restart demand.
        cur, old = "b" * 40, "a" * 40
        repos = [{"name": "r", "engine_boot": old,
                  "lifecycle": {"state": "running"}}]
        chip = self._status(cur, cur, repos, behind_map={old: 5})["chip"]
        self.assertTrue(chip["show"])
        self.assertEqual(chip["mode"], "supervisors")
        self.assertIsNone(chip["dashboard_behind"])
        self.assertEqual(chip["supervisors"],
                         [{"repo": "r", "behind": 5, "known": True}])

    def test_chip_unknown_sha_supervisor_marked_unknown_no_count(self):
        # defect 2: a pre-tracking supervisor (sha "") is 'known': False so the
        # render says 'version unknown', never a borrowed count.
        cur = "a" * 40
        repos = [{"name": "r", "engine_boot": "",
                  "lifecycle": {"state": "running"}}]
        chip = self._status(cur, cur, repos)["chip"]
        self.assertEqual(chip["mode"], "supervisors")
        self.assertEqual(chip["supervisors"],
                         [{"repo": "r", "behind": None, "known": False}])

    def test_chip_dashboard_stale_wins_and_lists_stale_supervisors(self):
        # both behind -> the dashboard CTA is primary; stale supervisors still
        # ride along (the render footnotes them), each with its own truth.
        cur, d_old, s_unknown = "c" * 40, "a" * 40, ""
        repos = [{"name": "r", "engine_boot": s_unknown,
                  "lifecycle": {"state": "running"}}]
        chip = self._status(cur, d_old, repos, behind_map={d_old: 2})["chip"]
        self.assertEqual(chip["mode"], "dashboard")
        self.assertEqual(chip["dashboard_behind"], 2)
        self.assertEqual(chip["supervisors"],
                         [{"repo": "r", "behind": None, "known": False}])

    # -- checkout-vs-origin axis (#270): the third staleness comparison --
    def test_checkout_stale_when_origin_ahead(self):
        # process + supervisor current, but the serving checkout is behind
        # origin/main -> a real 'pull' signal (the #270 incident: boot==HEAD hid
        # merged commits the checkout wasn't serving).
        cur = "a" * 40
        repos = [{"name": "r", "engine_boot": cur,
                  "lifecycle": {"state": "running"}}]
        st = self._status(cur, cur, repos, checkout_behind=4)
        self.assertTrue(st["stale"])
        self.assertEqual(st["checkout"], {"behind": 4, "stale": True})
        self.assertEqual(st["chip"]["mode"], "checkout")
        self.assertEqual(st["chip"]["checkout_behind"], 4)

    def test_checkout_fetch_failure_is_silent(self):
        # fail-safe: reader returns None (fetch/rev-list failed, offline) ->
        # contributes no staleness, never a false chip.
        cur = "a" * 40
        repos = [{"name": "r", "engine_boot": cur,
                  "lifecycle": {"state": "running"}}]
        st = self._status(cur, cur, repos, checkout_behind=None)
        self.assertFalse(st["stale"])
        self.assertEqual(st["checkout"], {"behind": None, "stale": False})
        self.assertFalse(st["chip"]["show"])

    def test_checkout_behind_zero_not_stale(self):
        cur = "a" * 40
        repos = [{"name": "r", "engine_boot": cur,
                  "lifecycle": {"state": "running"}}]
        st = self._status(cur, cur, repos, checkout_behind=0)
        self.assertFalse(st["stale"])
        self.assertEqual(st["checkout"], {"behind": None, "stale": False})

    def test_ladder_process_stale_beats_checkout(self):
        # both the dashboard process (boot<HEAD) AND the checkout (HEAD<origin)
        # are behind -> the loud pull+restart 'dashboard' CTA wins.
        cur, old = "b" * 40, "a" * 40
        repos = [{"name": "r", "engine_boot": cur,
                  "lifecycle": {"state": "running"}}]
        chip = self._status(cur, old, repos, behind_map={old: 3},
                            checkout_behind=2)["chip"]
        self.assertEqual(chip["mode"], "dashboard")
        self.assertEqual(chip["dashboard_behind"], 3)

    def test_ladder_checkout_beats_supervisors(self):
        # dashboard current, a supervisor behind AND the checkout behind ->
        # checkout (a pull the operator can act on now) outranks the
        # informational supervisors note.
        cur, old = "b" * 40, "a" * 40
        repos = [{"name": "r", "engine_boot": old,
                  "lifecycle": {"state": "running"}}]
        chip = self._status(cur, cur, repos, behind_map={old: 5},
                            checkout_behind=2)["chip"]
        self.assertEqual(chip["mode"], "checkout")
        self.assertEqual(chip["checkout_behind"], 2)


class TestTokenTimeline(unittest.TestCase):
    """token_timeline (#188a): the tokens-over-time series that replaces the
    instantaneous 0-tok/min readout. Backfilled ENTIRELY from the session-*.log
    totals already on disk (no gh, no live sampler): each session is ONE point
    at its accrual bucket (its log's mtime, a tz-safe real epoch), so we never
    fabricate a distributed curve we did not measure. Zero-filled, oldest-first,
    best-effort per artifact like recent_sessions/recent_quota_windows."""

    NOW = 1893456000          # 900-aligned epoch -> clean bucket arithmetic
    BUCKET = 900
    WINDOW = 86400            # 24h -> 96 buckets

    def _write(self, d, name, toks, mtime):
        path = os.path.join(d, name)
        with open(path, "w") as fh:
            fh.write(json.dumps({"type": "assistant", "message": {
                "content": [], "usage": {"output_tokens": toks}}}) + "\n")
            fh.write(json.dumps({"type": "result", "is_error": False,
                                 "usage": {"output_tokens": toks}}) + "\n")
        os.utime(path, (mtime, mtime))
        return path

    def test_missing_dir_returns_empty(self):
        # OSError on the dir (never created) -> [] (mirrors recent_sessions)
        self.assertEqual(
            ds.token_timeline("/no/such/logdir", self.NOW,
                              window_secs=self.WINDOW, bucket_secs=self.BUCKET), [])

    def test_empty_dir_is_zero_filled_window(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        series = ds.token_timeline(d, self.NOW, window_secs=self.WINDOW,
                                   bucket_secs=self.BUCKET)
        self.assertEqual(len(series), self.WINDOW // self.BUCKET)   # 96 buckets
        self.assertTrue(all(pt["tokens"] == 0 for pt in series))
        # oldest-first, contiguous, aligned, last bucket == floor(now)
        buckets = [pt["bucket"] for pt in series]
        self.assertEqual(buckets, sorted(buckets))
        self.assertEqual(buckets[-1], self.NOW)                    # NOW is aligned
        for i in range(1, len(buckets)):
            self.assertEqual(buckets[i] - buckets[i - 1], self.BUCKET)

    def test_session_lands_in_its_mtime_bucket(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        mt = self.NOW - 3600                                       # 1h ago, aligned
        self._write(d, "session-x.log", 500, mt)
        series = ds.token_timeline(d, self.NOW, window_secs=self.WINDOW,
                                   bucket_secs=self.BUCKET)
        by_bucket = {pt["bucket"]: pt["tokens"] for pt in series}
        self.assertEqual(by_bucket[mt], 500)
        self.assertEqual(sum(pt["tokens"] for pt in series), 500)  # nothing elsewhere

    def test_two_sessions_same_bucket_sum(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        mt = self.NOW - self.BUCKET
        self._write(d, "session-a.log", 100, mt + 10)             # same bucket
        self._write(d, "session-b.log", 250, mt + 800)            # same bucket
        series = ds.token_timeline(d, self.NOW, window_secs=self.WINDOW,
                                   bucket_secs=self.BUCKET)
        by_bucket = {pt["bucket"]: pt["tokens"] for pt in series}
        self.assertEqual(by_bucket[mt], 350)

    def test_session_outside_window_ignored(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        self._write(d, "session-old.log", 999, self.NOW - self.WINDOW - 5000)
        series = ds.token_timeline(d, self.NOW, window_secs=self.WINDOW,
                                   bucket_secs=self.BUCKET)
        self.assertEqual(sum(pt["tokens"] for pt in series), 0)

    def test_corrupt_log_degrades_not_raises(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        bad = os.path.join(d, "session-bad.log")
        with open(bad, "w") as fh:
            fh.write("not json at all\n{partial")
        os.utime(bad, (self.NOW - 900, self.NOW - 900))
        self._write(d, "session-ok.log", 77, self.NOW - 900)
        series = ds.token_timeline(d, self.NOW, window_secs=self.WINDOW,
                                   bucket_secs=self.BUCKET)          # must not raise
        self.assertEqual(sum(pt["tokens"] for pt in series), 77)

    def test_build_repo_state_includes_token_timeline(self):
        st = ds.build_repo_state(FIX, git_in_flight=lambda p: {}, now=self.NOW)
        self.assertIn("token_timeline", st)
        self.assertIsInstance(st["token_timeline"], list)


class TestQuotaForecast(unittest.TestCase):
    """quota_forecast (#188b): burn-rate exhaustion forecast per quota window,
    extrapolated PURELY from the utilization the dashboard already shows
    (parse_quota_windows) -- no new source, no gh. Linear from the window's
    average burn; omits a window when no honest forecast exists."""

    NOW = 1000000
    FIVE_H = 18000

    def _win(self, util, resets_at, wtype="five_hour"):
        return {wtype: {"utilization": util, "resets_at": resets_at,
                        "overage": False}}

    def test_slow_burn_resets_before_exhaustion_is_safe(self):
        # halfway through a 5h window, only 25% used -> hits 100% long after reset
        w = self._win(0.25, self.NOW + 9000)     # window_start = now-9000, elapsed=9000
        f = ds.quota_forecast(w, self.NOW)["five_hour"]
        self.assertEqual(f["projected_exhaust_epoch"], self.NOW + 27000)
        self.assertFalse(f["exhausts_before_reset"])
        self.assertEqual(f["resets_at"], self.NOW + 9000)

    def test_fast_burn_exhausts_before_reset(self):
        # halfway through, 75% used -> hits 100% before the window resets
        w = self._win(0.75, self.NOW + 9000)
        f = ds.quota_forecast(w, self.NOW)["five_hour"]
        self.assertEqual(f["projected_exhaust_epoch"], self.NOW + 3000)
        self.assertTrue(f["exhausts_before_reset"])

    def test_already_at_limit_reports_exhausted_now(self):
        w = self._win(1.0, self.NOW + 5000)
        f = ds.quota_forecast(w, self.NOW)["five_hour"]
        self.assertEqual(f["projected_exhaust_epoch"], self.NOW)
        self.assertTrue(f["exhausts_before_reset"])   # resets_at is in the future

    def test_zero_utilization_omitted(self):
        # no burn to extrapolate -> no honest forecast
        self.assertNotIn("five_hour", ds.quota_forecast(self._win(0.0, self.NOW + 9000), self.NOW))

    def test_nonpositive_elapsed_omitted(self):
        # resets_at further out than the window length -> window_start in the future
        w = self._win(0.4, self.NOW + self.FIVE_H + 500)
        self.assertNotIn("five_hour", ds.quota_forecast(w, self.NOW))

    def test_unknown_window_type_omitted(self):
        self.assertEqual(ds.quota_forecast({"monthly": {"utilization": 0.5,
                                            "resets_at": self.NOW + 100}}, self.NOW), {})

    def test_non_mapping_input_is_empty(self):
        self.assertEqual(ds.quota_forecast(None, self.NOW), {})
        self.assertEqual(ds.quota_forecast([], self.NOW), {})

    def test_seven_day_window_length_used(self):
        # 7d window (604800s); half elapsed, 10% used -> slow, safe
        w = self._win(0.10, self.NOW + 302400, wtype="seven_day")   # elapsed=302400
        f = ds.quota_forecast(w, self.NOW)["seven_day"]
        # t = (0.9/0.1)*302400 = 2721600
        self.assertEqual(f["projected_exhaust_epoch"], self.NOW + 2721600)
        self.assertFalse(f["exhausts_before_reset"])

    def test_build_repo_state_includes_quota_forecast(self):
        st = ds.build_repo_state(FIX, git_in_flight=lambda p: {}, now=self.NOW)
        self.assertIn("quota_forecast", st)
        self.assertIsInstance(st["quota_forecast"], dict)


class TestAttachQuotaForecast(unittest.TestCase):
    """attach_quota_forecast (#188b render seam): threads each window's burn-rate
    forecast onto the window dict itself, so the quota card -- which renders ONE
    selected window (the live account window or the log-scan max across repos) --
    carries the matching forecast by construction instead of pairing two
    separately-keyed structures at render time (the source-correspondence trap).
    Non-mutating (the live windows come from a shared usage cache) and total
    (best-effort, never raises; degrade-to-truth on omission)."""

    NOW = 1000000

    def _win(self, util, resets_at, wtype="five_hour"):
        return {wtype: {"utilization": util, "resets_at": resets_at, "overage": False}}

    def test_forecast_attached_onto_window(self):
        w = self._win(0.75, self.NOW + 9000)
        out = ds.attach_quota_forecast(w, self.NOW)
        self.assertEqual(out["five_hour"]["forecast"],
                         ds.quota_forecast(w, self.NOW)["five_hour"])

    def test_input_not_mutated(self):
        # the live windows are a shared cache dict (cu.live_quota) -- attach must
        # never write back into the caller's structure.
        w = self._win(0.75, self.NOW + 9000)
        ds.attach_quota_forecast(w, self.NOW)
        self.assertNotIn("forecast", w["five_hour"])

    def test_omitted_window_gets_no_forecast_key(self):
        # zero burn -> quota_forecast omits it -> no fabricated projection.
        out = ds.attach_quota_forecast(self._win(0.0, self.NOW + 9000), self.NOW)
        self.assertNotIn("forecast", out["five_hour"])

    def test_stale_forecast_dropped_when_not_recomputed(self):
        # an input window carrying a stale forecast whose fresh forecast is now
        # omitted must LOSE it (degrade-to-truth, never fail-open on a mismatch).
        w = self._win(0.0, self.NOW + 9000)
        w["five_hour"]["forecast"] = {"projected_exhaust_epoch": 42}
        out = ds.attach_quota_forecast(w, self.NOW)
        self.assertNotIn("forecast", out["five_hour"])

    def test_non_window_keys_passthrough(self):
        w = self._win(0.75, self.NOW + 9000)
        w["source"] = "live"   # live_quota carries a non-dict 'source' string
        out = ds.attach_quota_forecast(w, self.NOW)
        self.assertEqual(out["source"], "live")

    def test_non_mapping_passthrough(self):
        self.assertIsNone(ds.attach_quota_forecast(None, self.NOW))
        self.assertEqual(ds.attach_quota_forecast([], self.NOW), [])

    def test_build_repo_state_quota_windows_carry_forecast(self):
        # the two build-site paths agree: every window the top-level forecast
        # covers carries that same forecast on the displayed `quota` window.
        st = ds.build_repo_state(FIX, git_in_flight=lambda p: {}, now=self.NOW)
        for wt, f in st["quota_forecast"].items():
            self.assertEqual(st["quota"][wt].get("forecast"), f)


class TestTriggerHealth(unittest.TestCase):
    """trigger_health (#188c): missed-fire detection for the control room's
    trigger-health signal. Compares each cron role's persisted last_fire
    marker ($VARDIR/cron/<role>.last_fire, an epoch int -- see
    supervisor.sh:resolve_trigger_cron_due) against the SAME schedule math the
    supervisor itself uses (roles.cron_next_fire), so this reader can never
    drift from what actually fires. A fire expected well in the past that the
    marker never advanced past is a MISSED fire -- the 2026-07-03 swept-state
    incident (a stalled/backed-off scheduler looking identical to a healthy
    one)."""

    NOW = 2000000
    GRACE = 300

    def _config(self, schedule="*/15 * * * *", name="pm"):
        return {"roles": {name: {"enabled": True,
                                  "trigger": {"type": "cron", "schedule": schedule}}}}

    def _marker_dir(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        return d

    def _write_marker(self, d, name, epoch):
        with open(os.path.join(d, "%s.last_fire" % name), "w") as fh:
            fh.write(str(epoch))

    def test_no_cron_roles_is_empty(self):
        d = self._marker_dir()
        self.assertEqual(ds.trigger_health({"roles": {}}, d, self.NOW), [])

    def test_never_armed_role_is_unknown_not_missed(self):
        # no marker file at all -- degrade to 'unknown', never fabricate a miss
        d = self._marker_dir()
        out = ds.trigger_health(self._config(), d, self.NOW)
        self.assertEqual(len(out), 1)
        self.assertIsNone(out[0]["last_fire"])
        self.assertFalse(out[0]["missed"])

    def test_recently_advanced_marker_is_healthy(self):
        d = self._marker_dir()
        self._write_marker(d, "pm", self.NOW - 60)   # fired a minute ago
        out = ds.trigger_health(self._config(), d, self.NOW)
        self.assertFalse(out[0]["missed"])
        self.assertIsNotNone(out[0]["expected_next"])

    def _repo_with_cron(self, marker_epoch, schedule="*/15 * * * *", name="pm"):
        repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, repo, ignore_errors=True)
        os.makedirs(os.path.join(repo, ".autonomy"))
        os.makedirs(os.path.join(repo, "var", "autonomy-logs"))
        os.makedirs(os.path.join(repo, "var", "cron"))
        with open(os.path.join(repo, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("roles:\n  %s:\n    enabled: true\n"
                     "    trigger:\n      type: cron\n      schedule: \"%s\"\n"
                     % (name, schedule))
        if marker_epoch is not None:
            self._write_marker(os.path.join(repo, "var", "cron"), name, marker_epoch)
        return repo

    def test_build_repo_state_flags_missed_fire_on_role(self):
        # #188c render seam: build_repo_state annotates each role row with a
        # `missed_fire` flag from trigger_health, so the fleet rail can surface
        # the swept-state incident (a stalled cron fire) that otherwise looks
        # identical to a healthy idle role.
        repo = self._repo_with_cron(self.NOW - 3600)   # frozen an hour ago -> missed
        st = ds.build_repo_state(repo, git_in_flight=lambda _p: {}, now=self.NOW)
        pm = next(r for r in st["roles"] if r["name"] == "pm")
        self.assertTrue(pm["missed_fire"])
        # ONLY the stale cron role is flagged -- every other row (no cron
        # schedule, or not overdue) stays False; no fabricated alarm.
        self.assertEqual([r["name"] for r in st["roles"] if r["missed_fire"]], ["pm"])

    def test_build_repo_state_healthy_cron_not_flagged(self):
        repo = self._repo_with_cron(self.NOW - 60)     # fired a minute ago -> healthy
        st = ds.build_repo_state(repo, git_in_flight=lambda _p: {}, now=self.NOW)
        pm = next(r for r in st["roles"] if r["name"] == "pm")
        self.assertFalse(pm["missed_fire"])

    def test_stale_marker_past_expected_fire_plus_grace_is_missed(self):
        d = self._marker_dir()
        # every-15-min schedule; marker frozen an hour ago -> expected fires
        # long since passed and were never advanced past -> missed
        self._write_marker(d, "pm", self.NOW - 3600)
        out = ds.trigger_health(self._config(), d, self.NOW, grace_secs=self.GRACE)
        self.assertTrue(out[0]["missed"])

    def test_expected_fire_within_grace_window_not_yet_missed(self):
        d = self._marker_dir()
        # schedule fires every 15 min; marker just barely behind, inside grace
        self._write_marker(d, "pm", self.NOW - 60)
        out = ds.trigger_health(self._config(), d, self.NOW, grace_secs=self.GRACE)
        self.assertFalse(out[0]["missed"])

    def test_corrupt_marker_degrades_to_unknown(self):
        d = self._marker_dir()
        with open(os.path.join(d, "pm.last_fire"), "w") as fh:
            fh.write("not-an-epoch")
        out = ds.trigger_health(self._config(), d, self.NOW)
        self.assertIsNone(out[0]["last_fire"])
        self.assertFalse(out[0]["missed"])

    def test_unparseable_schedule_omits_expected_next(self):
        d = self._marker_dir()
        self._write_marker(d, "pm", self.NOW - 3600)
        out = ds.trigger_health(self._config(schedule="garbage"), d, self.NOW)
        self.assertIsNone(out[0]["expected_next"])
        self.assertFalse(out[0]["missed"])

    def test_missing_cron_dir_degrades_to_unknown_not_missed(self):
        # the dir itself absent (role never fired, or fresh install) reads
        # the same as an absent marker file -- unknown, not a fabricated miss
        out = ds.trigger_health(self._config(), "/no/such/cron/dir", self.NOW)
        self.assertEqual(len(out), 1)
        self.assertIsNone(out[0]["last_fire"])
        self.assertFalse(out[0]["missed"])

    def test_non_mapping_config_is_empty(self):
        d = self._marker_dir()
        self.assertEqual(ds.trigger_health(None, d, self.NOW), [])

    def test_build_repo_state_includes_trigger_health(self):
        st = ds.build_repo_state(FIX, git_in_flight=lambda p: {}, now=self.NOW)
        self.assertIn("trigger_health", st)
        self.assertIsInstance(st["trigger_health"], list)


class TestTicketEffort(unittest.TestCase):
    """ticket_effort (#186 lane detail): the total work a single ticket has
    cost -- session count, output tokens, $ -- summed across every recent
    session that worked it. Pure over the recent_sessions() list; total by
    construction (feeds the whole-dashboard render, so it must never raise)."""

    NOW = 1893456000

    def _s(self, ticket, tokens, cost):
        return {"ticket": ticket, "tokens": tokens, "cost": cost}

    def test_sums_only_matching_ticket(self):
        sessions = [self._s(82, 60000, 8.00), self._s(82, 36000, 4.40),
                    self._s(57, 5000, 1.00)]
        got = ds.ticket_effort(sessions, 82)
        self.assertEqual(got, {"sessions": 2, "tokens": 96000, "cost": 12.40})

    def test_no_active_ticket_is_none(self):
        self.assertIsNone(ds.ticket_effort([self._s(82, 10, 1.0)], None))

    def test_ticket_absent_from_sessions_is_none(self):
        self.assertIsNone(ds.ticket_effort([self._s(57, 10, 1.0)], 82))

    def test_empty_sessions_is_none(self):
        self.assertIsNone(ds.ticket_effort([], 82))

    def test_cost_rounds_to_cents(self):
        got = ds.ticket_effort([self._s(9, 1, 0.111), self._s(9, 1, 0.222)], 9)
        self.assertEqual(got["cost"], 0.33)

    def test_non_numeric_fields_degrade_to_zero_not_raise(self):
        # a torn session dict (missing/None/garbage tokens or cost) must
        # contribute 0, never blow up the render (prevention-log #12).
        sessions = [self._s(5, None, None), {"ticket": 5},
                    {"ticket": 5, "tokens": "x", "cost": "y"},
                    self._s(5, 100, 2.0)]
        got = ds.ticket_effort(sessions, 5)
        self.assertEqual(got, {"sessions": 4, "tokens": 100, "cost": 2.0})

    def test_build_repo_state_includes_ticket_effort(self):
        # the FIX fixture's newest session works #57; ticket_effort totals it.
        st = ds.build_repo_state(FIX, git_in_flight=lambda p: {}, now=self.NOW)
        self.assertIn("ticket_effort", st)
        eff = st["ticket_effort"]
        self.assertIsNotNone(eff)
        self.assertEqual(set(eff), {"sessions", "tokens", "cost"})
        self.assertGreaterEqual(eff["sessions"], 1)


class TestRepoStateLanes(unittest.TestCase):
    """#147 dashboard slice: build_repo_state exposes the repo's lane topology
    (declared lanes in order + the default lane) and tags each role row with
    its lane, so a later render slice can group the repo card by lane. Data
    layer only -- display, never gates dispatch (SD-21/22). A repo with no
    `lanes:` block is one implicit lane named 'main' (zero migration)."""

    def _repo(self, config_text):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, True)
        os.makedirs(os.path.join(d, ".autonomy"))
        os.makedirs(os.path.join(d, "var", "autonomy-logs"))
        with open(os.path.join(d, ".autonomy", "config.yaml"), "w") as fh:
            fh.write(config_text)
        return d

    def _write_session(self, repo, ts, role):
        """Write a minimal session-<ts>.log + its .role sidecar so
        latest_session() + _session_role() resolve to `role`. latest_session
        sorts by name, so a lexically-greater ts is 'newest'."""
        logdir = os.path.join(repo, "var", "autonomy-logs")
        with open(os.path.join(logdir, "session-%s.log" % ts), "w") as fh:
            fh.write('{"type":"result","subtype":"success","is_error":false,'
                     '"duration_ms":1000,"total_cost_usd":0.1,'
                     '"usage":{"output_tokens":10}}\n')
        with open(os.path.join(logdir, "session-%s.role" % ts), "w") as fh:
            fh.write(role)

    def test_no_lanes_block_is_the_single_implicit_main_lane(self):
        d = self._repo("agent:\n  type: claude\n")
        st = ds.build_repo_state(d)
        self.assertEqual(
            st["lanes"],
            {"names": ["main"], "default": "main", "valid": True,
             "active": "main", "active_at": None})

    def test_declared_lanes_surface_in_order_first_is_default(self):
        d = self._repo(
            "lanes:\n"
            "  main:\n"
            "    worktree: ../x-main\n"
            "  frontend:\n"
            "    worktree: ../x-fe\n")
        st = ds.build_repo_state(d)
        self.assertEqual(st["lanes"]["names"], ["main", "frontend"])
        self.assertEqual(st["lanes"]["default"], "main")
        self.assertTrue(st["lanes"]["valid"])

    def test_each_role_is_tagged_with_its_lane(self):
        # A role's `lane:` routes it; a role without one belongs to the default
        # lane (a not-configured standard placeholder included).
        d = self._repo(
            "lanes:\n"
            "  main:\n"
            "    worktree: ../x-main\n"
            "  frontend:\n"
            "    worktree: ../x-fe\n"
            "roles:\n"
            "  coder:\n"
            "    lane: frontend\n"
            "    scope:\n"
            "      labels: [ready]\n")
        st = ds.build_repo_state(d)
        by_name = {r["name"]: r for r in st["roles"]}
        self.assertEqual(by_name["coder"]["lane"], "frontend")
        self.assertEqual(by_name["pm"]["lane"], "main")

    def test_malformed_lanes_block_is_flagged_invalid_not_faked_healthy(self):
        # A present-but-malformed `lanes:` block (here a bare scalar) makes the
        # supervisor REFUSE to dispatch a lane -- so the dashboard must not
        # report it as a healthy single 'main' lane. `valid` is False (the same
        # verdict `roles.py lanes` reaches); the render keys off it to flag
        # broken config. Still total: build_repo_state never raises (prev-log
        # #12), so `names`/`default` degrade to the implicit 'main'.
        d = self._repo("lanes: nonsense\nroles:\n  coder:\n    enabled: true\n")
        st = ds.build_repo_state(d)
        self.assertFalse(st["lanes"]["valid"])
        self.assertEqual(st["lanes"]["names"], ["main"])
        self.assertEqual(st["lanes"]["default"], "main")
        by_name = {r["name"]: r for r in st["roles"]}
        self.assertEqual(by_name["coder"]["lane"], "main")

    def test_lane_topology_degrades_when_config_is_unreadable(self):
        # build_repo_state renders the WHOLE dashboard: a missing config must
        # still yield the implicit single lane, never raise (SD-6 fail-safe).
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, True)
        st = ds.build_repo_state(d)
        self.assertEqual(
            st["lanes"],
            {"names": ["main"], "default": "main", "valid": True,
             "active": "main", "active_at": None})
        for r in st["roles"]:
            self.assertEqual(r["lane"], "main")

    # --- #258 slice 1: lanes.active / active_at (default selection source) ---
    # The center zone becomes the selected lane; the default selection is the
    # most-recently-active lane, sourced from server truth (not client guess).

    def test_active_lane_is_the_newest_sessions_declared_lane(self):
        # newest session (lexically-greater ts) works a role in lane 'frontend';
        # an older one is in 'main' -> active is the NEWEST lane, with an epoch.
        d = self._repo(
            "lanes:\n  main:\n    worktree: ../x-main\n"
            "  frontend:\n    worktree: ../x-fe\n"
            "roles:\n  coder:\n    lane: frontend\n"
            "    scope:\n      labels: [ready]\n")
        self._write_session(d, "20260701T090000", "pm")      # older -> main
        self._write_session(d, "20260701T093000", "coder")   # newest -> frontend
        st = ds.build_repo_state(d)
        self.assertEqual(st["lanes"]["active"], "frontend")
        self.assertIsInstance(st["lanes"]["active_at"], int)
        self.assertGreater(st["lanes"]["active_at"], 0)

    def test_active_lane_defaults_when_no_sessions(self):
        d = self._repo(
            "lanes:\n  main:\n    worktree: ../x-main\n"
            "  frontend:\n    worktree: ../x-fe\n")
        st = ds.build_repo_state(d)
        self.assertEqual(st["lanes"]["active"], "main")   # == default
        self.assertIsNone(st["lanes"]["active_at"])

    def test_active_lane_falls_back_when_role_lane_undeclared(self):
        # A role routed to a lane that isn't a declared name -> lane_of_role
        # returns it VERBATIM (dispatch refuses by omission). active must NOT
        # surface an undeclared lane as selectable -- degrade to the default
        # lane (fail-safe, never fail-open display; Codex CP1 finding 1).
        d = self._repo(
            "lanes:\n  main:\n    worktree: ../x-main\n"
            "  frontend:\n    worktree: ../x-fe\n"
            "roles:\n  coder:\n    lane: ghost\n"
            "    scope:\n      labels: [ready]\n")
        self._write_session(d, "20260701T093000", "coder")
        st = ds.build_repo_state(d)
        self.assertEqual(st["lanes"]["active"], "main")   # not 'ghost'

    def test_active_lane_degrades_to_main_on_malformed_block(self):
        # malformed `lanes:` -> names degrade to ['main']; active follows,
        # never raises (prev-log #12, degrade-to-truth).
        d = self._repo("lanes: nonsense\nroles:\n  coder:\n    enabled: true\n")
        self._write_session(d, "20260701T093000", "coder")
        st = ds.build_repo_state(d)
        self.assertEqual(st["lanes"]["active"], "main")

    def test_active_lane_does_not_surface_an_invalid_lane_name(self):
        # A well-formed mapping but an INVALID lane name -> valid:False (the
        # supervisor's --lane gate REFUSES it). names/default still echo the raw
        # key for the ⚠ badge, but `active` must NOT default-SELECT a lane the
        # engine won't run -- degrade to 'main' (Codex CP2: fail-safe, never
        # fail-open display).
        d = self._repo(
            "lanes:\n  badname!:\n    worktree: ../x\n"
            "roles:\n  coder:\n    lane: badname!\n"
            "    scope:\n      labels: [ready]\n")
        self._write_session(d, "20260701T093000", "coder")
        st = ds.build_repo_state(d)
        self.assertFalse(st["lanes"]["valid"])
        self.assertEqual(st["lanes"]["active"], "main")   # not 'badname!'


class TestParseStallFlag(unittest.TestCase):
    """#292 piece 2: surface the sweep's approved-but-unmerged stall flag as a
    PR-row age chip. The dashboard does NOT re-parse review verdicts (that
    parity contract lives in board.sh/safe_merge alone -- a third copy would
    drift); it renders the sweep's own output: the PR comment carrying the
    `autonomy-stall-flag <head_oid>` marker. Total + best-effort: any parse
    failure -> None (no chip), never an exception."""

    OID = "cafe1234deadbeef"
    NOW = 1751680000

    def _comment(self, age_min_stated, flagged_secs_ago, oid=None):
        body = ("⚠ **Approved but unmerged for %dm.** Latest review "
                "verdict is APPROVE...\n\n<!-- autonomy-stall-flag %s -->"
                % (age_min_stated, oid or self.OID))
        ts = self.NOW - flagged_secs_ago
        import datetime as _dt
        iso = _dt.datetime.fromtimestamp(
            ts, tz=_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        return {"body": body, "createdAt": iso}

    def test_current_head_flag_yields_running_age(self):
        # flagged at 45m stalled, 10 minutes ago -> chip shows 55m now.
        out = ds.parse_stall_flag([self._comment(45, 600)], self.OID, self.NOW)
        self.assertIsNotNone(out)
        self.assertEqual(out["age_min"], 55)
        self.assertEqual(out["flagged_epoch"], self.NOW - 600)

    def test_stale_oid_flag_is_dropped(self):
        # a new push moved the head -> the old flag no longer applies (the
        # gate reset); chip must vanish, not lie.
        out = ds.parse_stall_flag(
            [self._comment(45, 600, oid="0ldhead0000")], self.OID, self.NOW)
        self.assertIsNone(out)

    def test_latest_marker_comment_wins(self):
        # two flags (older head + re-flag on the current head): the current
        # head's is used even when an unrelated comment follows it.
        comments = [
            self._comment(30, 4000, oid="0ldhead0000"),
            self._comment(45, 600),
            {"body": "unrelated chatter", "createdAt": "2026-07-05T01:00:00Z"},
        ]
        out = ds.parse_stall_flag(comments, self.OID, self.NOW)
        self.assertEqual(out["age_min"], 55)

    def test_unparseable_stated_age_falls_back_to_flag_age(self):
        c = {"body": "stalled <!-- autonomy-stall-flag %s -->" % self.OID,
             "createdAt": self._comment(0, 600)["createdAt"]}
        out = ds.parse_stall_flag([c], self.OID, self.NOW)
        self.assertEqual(out["age_min"], 10)

    def test_total_on_garbage(self):
        # None/empty/malformed inputs -> None, never raises.
        self.assertIsNone(ds.parse_stall_flag(None, self.OID, self.NOW))
        self.assertIsNone(ds.parse_stall_flag([], self.OID, self.NOW))
        self.assertIsNone(ds.parse_stall_flag([{"body": None}], self.OID, self.NOW))
        self.assertIsNone(ds.parse_stall_flag(
            [{"body": "<!-- autonomy-stall-flag %s -->" % self.OID,
              "createdAt": "not-a-date"}], self.OID, self.NOW))
        self.assertIsNone(ds.parse_stall_flag(
            [self._comment(45, 600)], "", self.NOW))
        self.assertIsNone(ds.parse_stall_flag("garbage", self.OID, self.NOW))
        # malformed `now` too (Codex CP2): totality covers every argument.
        for bad_now in (None, "bad", float("nan")):
            self.assertIsNone(ds.parse_stall_flag(
                [self._comment(45, 600)], self.OID, bad_now))


class TestWedgedStatus(unittest.TestCase):
    """#81 slice 2 (SD-32 §9): the dashboard consumes lib/health.py's wedged
    truth. display_status (the status-vocab SSOT, #23) gains a `wedged` token:
    a RUNNING supervisor whose heartbeat claims a working session but whose
    liveness has gone silent past the threshold must not render as a healthy
    'working' -- that is the display lie ./start status already refuses.
    Fail-safe direction: `wedged` is only ever EARNED from health.classify
    (prev-log #18); unknown/idle/ok health leave the display unchanged."""

    def test_display_status_wedged_only_when_running(self):
        self.assertEqual(
            ds.display_status("running", "working", health_state="wedged"),
            "wedged")
        self.assertEqual(
            ds.display_status("running", "idle", health_state="wedged"),
            "wedged")
        # terminal / paused lifecycles win -- a dead or pausing supervisor is
        # reported as such, not as a wedged worker.
        self.assertEqual(
            ds.display_status("paused", "working", health_state="wedged"),
            "stopping")
        self.assertEqual(
            ds.display_status("stopped", "idle", health_state="wedged"),
            "stopped")
        self.assertEqual(
            ds.display_status("needs-setup", "none", health_state="wedged"),
            "needs-setup")

    def test_display_status_unchanged_for_non_wedged_health(self):
        for hs in (None, "ok", "idle", "unknown", "garbage"):
            self.assertEqual(
                ds.display_status("running", "working", health_state=hs),
                "working")
            self.assertEqual(
                ds.display_status("running", "idle", health_state=hs),
                "idle")

    def _repo(self, hb_age, phase="session-running coder"):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, True)
        os.makedirs(os.path.join(d, ".autonomy"))
        logdir = os.path.join(d, "var", "autonomy-logs")
        os.makedirs(logdir)
        os.makedirs(os.path.join(d, "var", "autonomy-supervisor.lock"))
        with open(os.path.join(d, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("agent:\n  type: claude\n")
        with open(os.path.join(d, "var", "autonomy-supervisor.lock", "pid"), "w") as fh:
            fh.write("12345")
        ts = int(time.time()) - hb_age
        with open(os.path.join(logdir, "heartbeat"), "w") as fh:
            fh.write("%d\t%s\t0\tworking on a ticket\n" % (ts, phase))
        return d

    def test_build_repo_state_wedged_integration(self):
        # alive pid + session-running heartbeat gone silent past the default
        # 900s threshold -> the composed status is `wedged`, and the health
        # record (state+reason) is exposed for the render.
        d = self._repo(hb_age=2000)
        st = ds.build_repo_state(d, pid_is_alive=lambda p: True,
                                 git_in_flight=lambda p: {})
        self.assertEqual(st["display_status"], "wedged")
        self.assertEqual(st["health"]["state"], "wedged")
        self.assertTrue(st["health"]["reason"])

    def test_build_repo_state_fresh_working_not_wedged(self):
        d = self._repo(hb_age=10)
        st = ds.build_repo_state(d, pid_is_alive=lambda p: True,
                                 git_in_flight=lambda p: {})
        self.assertNotEqual(st["display_status"], "wedged")
        self.assertEqual(st["health"]["state"], "ok")

    def test_build_repo_state_idle_phase_never_wedged(self):
        # a legitimately sleeping loop (pace-wait) is idle, however old the
        # heartbeat -- health.classify's phase gate, surfaced end-to-end.
        d = self._repo(hb_age=90000, phase="pace-wait")
        st = ds.build_repo_state(d, pid_is_alive=lambda p: True,
                                 git_in_flight=lambda p: {})
        self.assertNotEqual(st["display_status"], "wedged")
        self.assertEqual(st["health"]["state"], "idle")

    def test_wedged_after_config_knob_honoured(self):
        # health.wedged_after: 60 -> a 120s-silent working session is wedged.
        d = self._repo(hb_age=120)
        with open(os.path.join(d, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("agent:\n  type: claude\nhealth:\n  wedged_after: 60\n")
        st = ds.build_repo_state(d, pid_is_alive=lambda p: True,
                                 git_in_flight=lambda p: {})
        self.assertEqual(st["display_status"], "wedged")

    def test_read_heartbeat_delegates_to_health(self):
        # slice 5 (SD-32 zero-drift): one parser. Both readers agree on a
        # real record AND on rejection of a torn one.
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, True)
        p = os.path.join(d, "heartbeat")
        with open(p, "w") as fh:
            fh.write("1751680000\tpace-wait\t1751680300\twaiting\n")
        import health as health_mod
        self.assertEqual(ds.read_heartbeat(p),
                         health_mod.read_heartbeat(d))
        with open(p, "w") as fh:
            fh.write("torn\n")
        self.assertEqual(ds.read_heartbeat(p), {})
        self.assertIsNone(health_mod.read_heartbeat(d))


class TestLaneStatus(unittest.TestCase):
    """#147 per-lane lifecycle: lane_status(worktree) -- the coarse display
    status for a SIBLING lane's worktree, from the SAME sources the repo card
    uses (supervisor lock pid + PAUSE sentinel via lifecycle_status, heartbeat
    phase, lib/health wedged truth). Vocabulary is a subset of
    display_status's so lifecycleCluster maps buttons unchanged."""

    def _wt(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, True)
        os.makedirs(os.path.join(d, ".autonomy"))
        os.makedirs(os.path.join(d, "var", "autonomy-logs"))
        with open(os.path.join(d, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("agent:\n  type: claude\n")
        return d

    def _lock(self, d, alive_pid):
        lockdir = os.path.join(d, "var", "autonomy-supervisor.lock")
        os.makedirs(lockdir, exist_ok=True)
        with open(os.path.join(lockdir, "pid"), "w") as fh:
            fh.write(str(alive_pid))

    def _hb(self, d, ts, phase):
        with open(os.path.join(d, "var", "autonomy-logs", "heartbeat"), "w") as fh:
            fh.write("%d\t%s\t0\treason text\n" % (ts, phase))

    def test_no_lock_is_stopped(self):
        self.assertEqual(ds.lane_status(self._wt()), "stopped")

    def test_dead_pid_is_stopped(self):
        d = self._wt()
        self._lock(d, 99999999)   # certainly-dead pid
        self.assertEqual(ds.lane_status(d), "stopped")

    def test_sentinel_over_live_pid_is_paused(self):
        d = self._wt()
        self._lock(d, os.getpid())
        open(os.path.join(d, "var", "autonomy-logs", "autonomy-PAUSE"), "a").close()
        self.assertEqual(ds.lane_status(d), "paused")

    def test_sentinel_while_working_is_stopping(self):
        d = self._wt()
        self._lock(d, os.getpid())
        open(os.path.join(d, "var", "autonomy-logs", "autonomy-PAUSE"), "a").close()
        now = int(time.time())
        self._hb(d, now, "session-running coder")
        self.assertEqual(ds.lane_status(d, now=now), "stopping")

    def test_live_working_fresh_is_working(self):
        d = self._wt()
        self._lock(d, os.getpid())
        now = int(time.time())
        self._hb(d, now, "session-running coder")
        self.assertEqual(ds.lane_status(d, now=now), "working")

    def test_live_nonworking_phase_is_idle(self):
        d = self._wt()
        self._lock(d, os.getpid())
        now = int(time.time())
        self._hb(d, now, "board-empty")
        self.assertEqual(ds.lane_status(d, now=now), "idle")

    def test_live_working_stale_is_wedged(self):
        d = self._wt()
        self._lock(d, os.getpid())
        now = int(time.time())
        self._hb(d, now - 3600, "session-running coder")
        self.assertEqual(ds.lane_status(d, now=now), "wedged")


class TestLaneServices(unittest.TestCase):
    """#147: build_repo_state(launch_agents_dir=...) resolves each DECLARED
    lane's service + coarse status into lanes.services. Declared lanes ONLY
    (an undeclared lane never appears); declared-but-unprovisioned reads
    installed:False with no status; the registered repo's own lane defers its
    status to the card (own:True, status None). No launch_agents_dir (every
    existing caller) or a single-lane repo -> NO services key (byte-compat).
    Any surprise inside the resolution omits the key -- buttons vanish, the
    render never lies or throws (fail-safe direction for a display)."""

    _CFG = ("lanes:\n"
            "  main:\n    worktree: ../x-main\n"
            "  qa:\n    worktree: ../x-qa\n"
            "roles:\n  coder:\n    enabled: true\n"
            "    trigger: { type: loop }\n")

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.repo = os.path.join(self.tmp, ".myrepo-autonomy")
        os.makedirs(os.path.join(self.repo, ".autonomy"))
        os.makedirs(os.path.join(self.repo, "var", "autonomy-logs"))
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"), "w") as fh:
            fh.write(self._CFG)
        self.la = os.path.join(self.tmp, "LaunchAgents")
        os.makedirs(self.la)
        self._plist("com.autonomy.myrepo.supervisor", self.repo, None)

    def _plist(self, label, repo, lane):
        lane_args = ""
        if lane:
            lane_args = ("    <string>--lane</string>\n"
                         "    <string>%s</string>\n" % lane)
        with open(os.path.join(self.la, label + ".plist"), "w") as fh:
            fh.write('<?xml version="1.0"?>\n<plist version="1.0"><dict>\n'
                     "  <key>Label</key><string>%s</string>\n"
                     "  <key>ProgramArguments</key><array>\n"
                     "    <string>/bin/bash</string>\n"
                     "    <string>/eng/bin/supervisor.sh</string>\n"
                     "    <string>--repo</string>\n"
                     "    <string>%s</string>\n"
                     "%s  </array>\n</dict></plist>\n" % (label, repo, lane_args))

    def test_no_launch_agents_dir_means_no_services_key(self):
        st = ds.build_repo_state(self.repo)
        self.assertNotIn("services", st["lanes"])

    def test_single_lane_repo_has_no_services_key(self):
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("agent:\n  type: claude\n")
        st = ds.build_repo_state(self.repo, launch_agents_dir=self.la)
        self.assertNotIn("services", st["lanes"])

    def test_own_lane_defers_status_to_the_card(self):
        st = ds.build_repo_state(self.repo, launch_agents_dir=self.la)
        svc = st["lanes"]["services"]["main"]
        self.assertEqual(svc, {"installed": True, "own": True, "status": None})

    def test_declared_unprovisioned_lane_is_uninstalled(self):
        st = ds.build_repo_state(self.repo, launch_agents_dir=self.la)
        svc = st["lanes"]["services"]["qa"]
        self.assertEqual(svc, {"installed": False, "own": False, "status": None})

    def test_provisioned_sibling_lane_carries_its_status(self):
        qa_wt = os.path.join(self.tmp, ".myrepo-qa-autonomy")
        os.makedirs(os.path.join(qa_wt, ".autonomy"))
        os.makedirs(os.path.join(qa_wt, "var", "autonomy-logs"))
        with open(os.path.join(qa_wt, ".autonomy", "config.yaml"), "w") as fh:
            fh.write(self._CFG)
        self._plist("com.autonomy.myrepo.qa.supervisor", qa_wt, "qa")
        st = ds.build_repo_state(self.repo, launch_agents_dir=self.la)
        svc = st["lanes"]["services"]["qa"]
        self.assertEqual(svc["installed"], True)
        self.assertEqual(svc["own"], False)
        self.assertEqual(svc["status"], "stopped")   # no live lock pid

    def test_services_covers_declared_lanes_only(self):
        st = ds.build_repo_state(self.repo, launch_agents_dir=self.la)
        self.assertEqual(sorted(st["lanes"]["services"]), ["main", "qa"])

    def test_malformed_lanes_block_omits_services(self):
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("lanes:\n  main: notamap\n")
        st = ds.build_repo_state(self.repo, launch_agents_dir=self.la)
        self.assertNotIn("services", st["lanes"])


class TestReadBoardWarning(unittest.TestCase):
    """#90 item (a): board.sh's board-unresolved marker (EXACTLY 2 lines:
    epoch, message<=512). TOTAL + STRICT reader -- the warning chip is EARNED
    by a well-formed marker; corruption never fabricates an alarm."""

    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.d, ignore_errors=True)

    def _w(self, content):
        p = os.path.join(self.d, "board-warning")
        with open(p, "w", encoding="utf-8") as f:
            f.write(content)
        return p

    def test_missing_file_is_none(self):
        self.assertIsNone(
            ds.read_board_warning(os.path.join(self.d, "nope")))

    def test_valid_marker_parses(self):
        p = self._w("1751700000\nproject 'X' not found under 'o' "
                    "(or lookup failed) -- board updates skipped\n")
        got = ds.read_board_warning(p)
        self.assertEqual(got["epoch"], 1751700000)
        self.assertIn("not found", got["message"])

    def test_garbage_epoch_is_none(self):
        self.assertIsNone(ds.read_board_warning(self._w("yesterday\nmsg\n")))

    def test_empty_message_is_none(self):
        self.assertIsNone(ds.read_board_warning(self._w("1751700000\n\n")))

    def test_truncated_single_line_is_none(self):
        self.assertIsNone(ds.read_board_warning(self._w("1751700000")))

    def test_oversized_file_rejected(self):
        # Oversize = malformed (board.sh never writes this) -> None, never a
        # truncated-and-trusted message (CP1 finding 4).
        p = self._w("1751700000\n" + "x" * 100000 + "\n")
        self.assertIsNone(ds.read_board_warning(p))

    def test_overlong_message_rejected(self):
        p = self._w("1751700000\n" + "x" * 600 + "\n")
        self.assertIsNone(ds.read_board_warning(p))

    def test_extra_lines_rejected(self):
        # Contract is exactly 2 lines; extra lines = torn/corrupted write
        # (CP1 finding 5).
        p = self._w("1751700000\nmsg\nunexpected third line\n")
        self.assertIsNone(ds.read_board_warning(p))

    def test_build_repo_state_carries_key(self):
        # repo-alpha fixture has no marker -> None, key present.
        st = ds.build_repo_state(FIX, pid_is_alive=lambda p: True,
                                 git_in_flight=lambda p: {})
        self.assertIn("board_warning", st)
        self.assertIsNone(st["board_warning"])

    def test_oversized_multibyte_rejected(self):
        # 3-byte UTF-8 chars: ~2000 chars but >4096 BYTES -- the size limit
        # is a byte contract (review NITPICK on #311).
        p = self._w("1751700000\n" + "⚠" * 2000 + "\n")
        self.assertIsNone(ds.read_board_warning(p))


class TestBuildOrg(unittest.TestCase):
    """#326 slice 1: the Org & Workflow read model -- planner/coder pair +
    the FULL merged role roster with honest trigger detail. Degrades to
    truth (prevention-log 15/18): malformed roles: -> valid False + error,
    never blank/default cards; a missing planner agent file renders as
    not-scaffolded, never invented."""
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.repo = self._td.name
        os.makedirs(os.path.join(self.repo, ".autonomy", "roles"))
        with open(os.path.join(self.repo, ".autonomy", "roles", "qa.md"), "w") as fh:
            fh.write("qa rail\n")

    def tearDown(self):
        self._td.cleanup()

    def _config(self, text):
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"), "w") as fh:
            fh.write(text)

    def _planner(self, text):
        d = os.path.join(self.repo, ".claude", "agents")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "planner.md"), "w") as fh:
            fh.write(text)

    FULL = (
        "agent:\n"
        "  effort: high\n"
        "  model:\n"
        "    primary: claude-sonnet-5\n"
        "    fallback: claude-sonnet-4-6\n"
        "roles:\n"
        "  coder:\n"
        "    enabled: true\n"
        "  qa:\n"
        "    enabled: true\n"
        "    trigger: { type: event, on: [pr.opened] }\n"
        "    gate: auto-merge-on-pass\n"
        "    scope: { labels: [ready] }\n"
        "    prompt: .autonomy/roles/qa.md\n"
        "  researcher:\n"
        "    enabled: false\n"
        "    trigger: { type: cron, schedule: \"0 9 * * *\" }\n"
        "    prompt: .autonomy/roles/qa.md\n"
        "  scribe:\n"
        "    enabled: true\n"
        "    trigger: { type: cron, schedule: \"*/30 * * * *\" }\n"
        "    model: claude-haiku-4-5-20251001\n"
        "    prompt: .autonomy/roles/qa.md\n"
    )

    def test_pair_from_agent_file_and_config(self):
        self._config(self.FULL)
        self._planner("---\nname: planner\nmodel: claude-opus-4-8\n---\nbody\n")
        org = ds.build_org(self.repo)
        self.assertTrue(org["valid"])
        self.assertEqual(org["pair"]["planner"],
                         {"scaffolded": True, "model": "claude-opus-4-8",
                          "source": "agent-file"})
        self.assertEqual(org["pair"]["coder"]["model"], "claude-sonnet-5")
        self.assertEqual(org["pair"]["coder"]["fallback"], "claude-sonnet-4-6")
        self.assertEqual(org["pair"]["coder"]["effort"], "high")

    def test_planner_not_scaffolded_is_stated_never_invented(self):
        self._config(self.FULL)
        org = ds.build_org(self.repo)
        self.assertEqual(org["pair"]["planner"],
                         {"scaffolded": False, "model": "", "source": "none"})

    def test_planner_garbage_frontmatter_scaffolded_model_unknown(self):
        self._config(self.FULL)
        self._planner("no frontmatter at all\n")
        org = ds.build_org(self.repo)
        self.assertEqual(org["pair"]["planner"],
                         {"scaffolded": True, "model": "", "source": "agent-file"})

    def test_full_roster_with_trigger_detail(self):
        self._config(self.FULL)
        org = ds.build_org(self.repo)
        rows = {r["name"]: r for r in org["roles"]}
        # the standard four always present, plus the custom role
        for name in ("coder", "pm", "qa", "researcher", "scribe"):
            self.assertIn(name, rows)
        self.assertEqual(rows["coder"]["trigger_kind"], "loop")
        self.assertEqual(rows["coder"]["trigger_detail"], "round-robin")
        self.assertEqual(rows["qa"]["trigger_kind"], "event")
        self.assertEqual(rows["qa"]["trigger_detail"], "pr.opened")
        self.assertEqual(rows["qa"]["gate"], "auto-merge-on-pass")
        self.assertEqual(rows["qa"]["scope_labels"], ["ready"])
        self.assertTrue(rows["qa"]["enabled"])
        self.assertEqual(rows["researcher"]["trigger_kind"], "cron")
        self.assertEqual(rows["researcher"]["trigger_detail"], "0 9 * * *")
        self.assertFalse(rows["researcher"]["enabled"])
        self.assertEqual(rows["scribe"]["trigger_kind"], "cron")
        self.assertEqual(rows["scribe"]["model"], "claude-haiku-4-5-20251001")
        self.assertFalse(rows["pm"]["configured"])

    def test_malformed_roles_block_degrades_to_invalid(self):
        self._config("roles: just-a-scalar\n")
        org = ds.build_org(self.repo)
        self.assertFalse(org["valid"])
        self.assertNotEqual(org["error"], "")

    def test_invalid_role_entry_degrades_to_invalid(self):
        self._config("roles:\n  qa:\n    enabled: true\n"
                     "    trigger: { type: cron }\n"
                     "    prompt: .autonomy/roles/qa.md\n")  # cron w/o schedule
        org = ds.build_org(self.repo)
        self.assertFalse(org["valid"])

    def test_missing_config_is_invalid_not_blank(self):
        org = ds.build_org(self.repo)
        self.assertFalse(org["valid"])
        self.assertNotEqual(org["error"], "")

    def test_unwired_knob_notes_surface(self):
        self._config("agent:\n  model:\n    primary: claude-sonnet-5\n"
                     "roles:\n  coder:\n    enabled: true\n    self_test: true\n")
        org = ds.build_org(self.repo)
        rows = {r["name"]: r for r in org["roles"]}
        self.assertTrue(any("self_test" in n for n in rows["coder"]["notes"]))

    def test_syntax_invalid_config_is_total_and_invalid(self):
        # CP2: _read_config re-parses the same file and only guards OSError --
        # a syntax error must NOT raise out of build_org; it renders invalid
        # with the standard roster still present (badge, never a blank card).
        self._config(": bad\n")
        org = ds.build_org(self.repo)
        self.assertFalse(org["valid"])
        self.assertNotEqual(org["error"], "")
        self.assertEqual(len(org["roles"]), 4)   # standard roster best-effort


    def test_planner_config_key_wins_over_agent_file(self):
        # Slice 3a: agent.planner.model (live-shadow editable) beats the
        # agent-file frontmatter; an invalid value degrades honestly.
        self._config(self.FULL.replace("agent:\n",
                     "agent:\n  planner:\n    model: claude-fable-5\n"))
        self._planner("---\nname: planner\nmodel: claude-opus-4-8\n---\nbody\n")
        org = ds.build_org(self.repo)
        self.assertEqual(org["pair"]["planner"],
                         {"scaffolded": True, "model": "claude-fable-5",
                          "source": "config"})

    def test_planner_invalid_config_value_falls_back_honestly(self):
        self._config(self.FULL.replace("agent:\n",
                     "agent:\n  planner:\n    model: \"bad model\"\n"))
        self._planner("---\nname: planner\nmodel: claude-opus-4-8\n---\nbody\n")
        org = ds.build_org(self.repo)
        self.assertEqual(org["pair"]["planner"]["source"], "config-invalid")
        self.assertEqual(org["pair"]["planner"]["model"], "claude-opus-4-8")

    def test_var_live_shadow_is_the_effective_config(self):
        # Workstreams slice 1: var/autonomy/config.yaml, when present, IS the
        # config for every reader (single resolver in config_parser).
        self._config(self.FULL)
        live_dir = os.path.join(self.repo, "var", "autonomy")
        os.makedirs(live_dir)
        with open(os.path.join(live_dir, "config.yaml"), "w") as fh:
            fh.write("agent:\n  model:\n    primary: live-model\n"
                     "roles:\n  coder:\n    enabled: true\n")
        org = ds.build_org(self.repo)
        self.assertEqual(org["pair"]["coder"]["model"], "live-model")

    def test_pack_missing_flag_explicit(self):
        # #334 NITPICK: the init-pack button gates on an explicit flag, not
        # error-text substrings.
        org = ds.build_org(self.repo)          # setUp made no config.yaml
        self.assertTrue(org["pack_missing"])
        self._config("agent:\n  model:\n    primary: claude-sonnet-5\n")
        self.assertFalse(ds.build_org(self.repo)["pack_missing"])


class TestBuildPipelineView(unittest.TestCase):
    """P3a (#357): the canvas viewer's read model. Pure + TOTAL: every
    missing/corrupt artifact degrades to a field, never an exception, and an
    invalid bound pipeline renders its ERRORS with the doc kept visible --
    never a healthy-looking wrap fallback (prevention-log #3/#15)."""

    def _tmp_repo(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        repo = os.path.join(tmp, "repo-alpha")
        shutil.copytree(FIX, repo)
        return repo

    def test_bound_role_view(self):
        v = ds.build_pipeline_view(FIX, "coder")
        self.assertEqual(v["source"]["kind"], "pipeline")
        self.assertEqual(v["source"]["name"], "fixture-flow")
        self.assertEqual(v["source"]["version"], 2)
        self.assertEqual(v["errors"], [])
        self.assertTrue(any(e.get("back") for e in v["edges_effective"]))
        self.assertTrue(v["last_run"]["pass"])       # NEWEST line wins
        self.assertEqual(v["last_run"]["bounces"], {"review->coding": 1})
        self.assertEqual(v["ledger"]["runs"], 2)
        self.assertIn("tier", v["ledger"])

    def test_wrapped_role_view(self):
        # no `pipeline:` binding -> the auto-wrap doc, honestly labelled
        repo = self._tmp_repo()
        with open(os.path.join(repo, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("agent:\n  type: \"claude\"\n")
        v = ds.build_pipeline_view(repo, "coder")
        self.assertEqual(v["source"]["kind"], "wrapped")
        self.assertEqual(v["errors"], [])
        self.assertTrue(all(e["on"] == "success" for e in v["edges_effective"]))
        self.assertIsNone(v["last_run"])             # journal has no legacy runs

    def test_invalid_doc_renders_errors_not_fallback(self):
        repo = self._tmp_repo()
        pj = os.path.join(repo, ".autonomy", "pipelines", "fixture-flow",
                          "pipeline.json")
        with open(pj) as fh:
            doc = json.load(fh)
        doc["nodes"][0]["type"] = "teleport"          # unknown node type
        with open(pj, "w") as fh:
            json.dump(doc, fh)
        v = ds.build_pipeline_view(repo, "coder")
        self.assertTrue(v["errors"])
        self.assertEqual(v["source"]["kind"], "pipeline")
        self.assertIsNotNone(v["doc"])                # degraded truth, visible

    def test_unreadable_json_degrades(self):
        repo = self._tmp_repo()
        pj = os.path.join(repo, ".autonomy", "pipelines", "fixture-flow",
                          "pipeline.json")
        with open(pj, "w") as fh:
            fh.write("{nope")
        v = ds.build_pipeline_view(repo, "coder")
        self.assertIsNone(v["doc"])
        self.assertTrue(v["errors"])
        self.assertEqual(v["edges_effective"], [])

    def test_missing_journal_means_no_lighting(self):
        repo = self._tmp_repo()
        os.remove(os.path.join(repo, "var", "autonomy-logs", "journal.jsonl"))
        v = ds.build_pipeline_view(repo, "coder")
        self.assertIsNone(v["last_run"])
        self.assertIsNone(v["ledger"])
        self.assertEqual(v["errors"], [])             # doc itself still fine

    def test_inflight_state_projected(self):
        repo = self._tmp_repo()
        state = {"fmt": 2, "run_id": "coder-x-1", "role": "coder",
                 "doc": {"name": "fixture-flow"}, "sessions": 3,
                 "units": {"pick": {"status": "success"},
                           "plan": {"status": "dispatched"},
                           "coding": {"status": "pending"}},
                 "status": "in_progress"}
        sp = os.path.join(repo, "var", "autonomy-logs",
                          ".pipeline-run-coder.json")
        with open(sp, "w") as fh:
            json.dump(state, fh)
        v = ds.build_pipeline_view(repo, "coder")
        self.assertEqual(v["in_flight"]["units"]["plan"], "dispatched")
        self.assertEqual(v["in_flight"]["sessions"], 3)

    def test_corrupt_inflight_is_none(self):
        repo = self._tmp_repo()
        sp = os.path.join(repo, "var", "autonomy-logs",
                          ".pipeline-run-coder.json")
        with open(sp, "w") as fh:
            fh.write("not json")
        v = ds.build_pipeline_view(repo, "coder")
        self.assertIsNone(v["in_flight"])

    def test_unknown_role_errors(self):
        v = ds.build_pipeline_view(FIX, "ghost")
        self.assertIn("error", v)
        self.assertIn("ghost", v["error"])

    def test_traversal_binding_refused_like_dispatch(self):
        # CP2: the viewer must apply the DISPATCHER's pipeline-name charset
        # gate. `pipeline: ../outside` would otherwise render healthy (and
        # read outside .autonomy/pipelines) while resolve_pipeline refuses
        # it -- a display lie + traversal read.
        repo = self._tmp_repo()
        outside = os.path.join(repo, ".autonomy", "outside")
        shutil.copytree(os.path.join(repo, ".autonomy", "pipelines",
                                     "fixture-flow"), outside)
        with open(os.path.join(repo, ".autonomy", "config.yaml"), "w") as fh:
            fh.write('roles:\n  coder:\n    pipeline: "../outside"\n'
                     'agent:\n  type: "claude"\n')
        v = ds.build_pipeline_view(repo, "coder")
        self.assertIsNone(v["doc"])
        self.assertTrue(any("charset" in e for e in v["errors"]))
        self.assertEqual(v["edges_effective"], [])

    def test_garbage_doc_shape_is_total(self):
        # CP2: a shape the validator has no error path for must still come
        # back as a degraded errors field, never a 500 out of the route.
        repo = self._tmp_repo()
        pj = os.path.join(repo, ".autonomy", "pipelines", "fixture-flow",
                          "pipeline.json")
        with open(pj) as fh:
            doc = json.load(fh)
        doc["containers"] = [{"id": "L", "kind": "loop",
                              "children": [{"bad": "unhashable"}],
                              "exit_when": "done", "max_rounds": 1}]
        with open(pj, "w") as fh:
            json.dump(doc, fh)
        v = ds.build_pipeline_view(repo, "coder")
        self.assertTrue(v["errors"])

    # -- P3b (#365): the viewer reads the var-live shadow + brief texts --------

    def _shadow_dir(self, repo):
        d = os.path.join(repo, "var", "autonomy", "pipelines", "fixture-flow")
        os.makedirs(d)
        return d

    def test_view_reads_the_shadow_when_present(self):
        repo = self._tmp_repo()
        shadow = self._shadow_dir(repo)
        # a MINIMAL valid one-node shadow doc, version 42, distinct from
        # committed (caps + edges required)
        with open(os.path.join(shadow, "pipeline.json"), "w") as fh:
            json.dump({"name": "fixture-flow", "version": 42,
                       "caps": {"max_sessions_per_run": 16},
                       "nodes": [{"id": "only", "type": "pick",
                                  "brief_ref": "only.md"}], "edges": []}, fh)
        with open(os.path.join(shadow, "only.md"), "w") as fh:
            fh.write("x\n")
        v = ds.build_pipeline_view(repo, "coder")
        self.assertEqual(v["source"]["kind"], "pipeline")
        self.assertTrue(v["source"]["shadow"])
        self.assertEqual(v["doc"]["version"], 42)      # shadow, not committed
        self.assertEqual(v["errors"], [])

    def test_committed_view_marks_shadow_false(self):
        v = ds.build_pipeline_view(FIX, "coder")       # no shadow on the fixture
        self.assertFalse(v["source"]["shadow"])

    def test_invalid_shadow_renders_errors_not_fallback(self):
        repo = self._tmp_repo()
        shadow = self._shadow_dir(repo)
        # valid EXCEPT the node type, so the unknown-type error is the sole
        # failure (caps + edges present)
        with open(os.path.join(shadow, "pipeline.json"), "w") as fh:
            json.dump({"name": "fixture-flow", "version": 1,
                       "caps": {"max_sessions_per_run": 16},
                       "nodes": [{"id": "a", "type": "no_such_type",
                                  "brief_ref": "a.md"}], "edges": []}, fh)
        with open(os.path.join(shadow, "a.md"), "w") as fh:
            fh.write("x\n")
        v = ds.build_pipeline_view(repo, "coder")
        self.assertTrue(v["source"]["shadow"])
        self.assertTrue(v["errors"])                   # shadow's errors, shown
        self.assertEqual(v["source"]["kind"], "pipeline")   # NOT a wrap fallback

    def test_view_carries_brief_texts(self):
        # the pane must seed its brief textarea from server truth, or an
        # edit-writes-only save blindly overwrites the brief (Codex CP1 #8).
        v = ds.build_pipeline_view(FIX, "coder")
        self.assertIn("briefs", v)
        self.assertIn("pick.md", v["briefs"])          # a real fixture brief
        self.assertTrue(v["briefs"]["pick.md"])        # its text, non-empty

    def test_briefs_total_on_unreadable(self):
        # a brief_ref whose file is missing degrades to an absent key, never an
        # exception (builders are total).
        repo = self._tmp_repo()
        os.remove(os.path.join(repo, ".autonomy", "pipelines",
                               "fixture-flow", "pick.md"))
        v = ds.build_pipeline_view(repo, "coder")
        self.assertNotIn("pick.md", v["briefs"])       # dropped, no crash
        self.assertIn("plan.md", v["briefs"])          # siblings still read


class GalleryProvenanceTest(BuildTriggersViewTest):
    """Phase D3 (#383): gallery source value `local` (shadow-only dir) +
    the provenance sidecar projection. The reader is TOTAL with an EXACT
    schema -- junk can neither crash the payload nor fabricate a lineage
    claim (silence is the safe side of a display lie)."""

    def _git(self, d):
        subprocess.run(["git", "init", "-q", d], check=True)
        with open(os.path.join(d, ".gitignore"), "w") as fh:
            fh.write("var/\n")
        # _mini_repo's committed doc omits `edges`, which validate_doc
        # requires -- an INVALID doc is a fine display fixture but refuses
        # as a clone SOURCE (no laundering). Make it valid for clone tests.
        pj = os.path.join(d, ".autonomy", "pipelines", "flow",
                          "pipeline.json")
        with open(pj) as fh:
            doc = json.load(fh)
        doc["edges"] = []
        with open(pj, "w") as fh:
            json.dump(doc, fh)
        return d

    def _local(self, d, name, doc_extra=None):
        """Hand-made shadow-only pipeline dir (valid one-node doc)."""
        pdir = os.path.join(d, "var", "autonomy", "pipelines", name)
        os.makedirs(pdir)
        doc = {"name": name, "version": 1,
               "caps": {"max_sessions_per_run": 4},
               "nodes": [{"id": "work", "type": "agent_task",
                          "brief_ref": "work.md"}],
               "edges": [], "containers": []}
        doc.update(doc_extra or {})
        with open(os.path.join(pdir, "pipeline.json"), "w") as fh:
            json.dump(doc, fh)
        with open(os.path.join(pdir, "work.md"), "w") as fh:
            fh.write("work brief\n")
        return pdir

    def _sidecar(self, d, name, payload):
        vroot = os.path.join(d, "var", "autonomy", "pipelines")
        os.makedirs(vroot, exist_ok=True)
        p = os.path.join(vroot, "%s.provenance.json" % name)
        with open(p, "w") as fh:
            if isinstance(payload, str):
                fh.write(payload)
            else:
                json.dump(payload, fh)
        return p

    def _rows(self, d):
        return dict((p["name"], p)
                    for p in ds.build_triggers_view(d)["pipelines"])

    def test_shadow_only_dir_is_source_local(self):
        d = self._mini_repo({})
        self._local(d, "solo")
        rows = self._rows(d)
        self.assertEqual(rows["solo"]["source"], "local")
        self.assertTrue(rows["solo"]["valid"])
        self.assertIsNone(rows["solo"]["provenance"])   # no sidecar: no claim
        self.assertEqual(rows["flow"]["source"], "committed")
        self.assertIsNone(rows["flow"]["provenance"])

    def test_blank_provenance_projected(self):
        d = self._mini_repo({})
        self._local(d, "solo")
        self._sidecar(d, "solo", {"created": "blank", "at": 1783080000})
        prov = self._rows(d)["solo"]["provenance"]
        self.assertEqual(prov, {"created": "blank", "at": 1783080000})

    def test_clone_provenance_diverged_flips_on_edit(self):
        # writer-driven: pipeline_create's fingerprint must read back as
        # NOT diverged (writer/reader canonicalization parity), then a doc
        # edit flips it. fingerprint itself is not part of the payload.
        import dashboard_control as dcx
        d = self._git(self._mini_repo({}))
        self.assertTrue(dcx.pipeline_create(d, "flow2", source="flow")["ok"])
        prov = self._rows(d)["flow2"]["provenance"]
        self.assertEqual(prov["created"], "clone")
        self.assertEqual(prov["source"], "flow")
        self.assertEqual(prov["source_version"], 1)
        self.assertIs(prov["diverged"], False)
        self.assertNotIn("fingerprint", prov)
        pj = os.path.join(d, "var", "autonomy", "pipelines", "flow2",
                          "pipeline.json")
        with open(pj) as fh:
            doc = json.load(fh)
        doc["version"] = 2
        with open(pj, "w") as fh:
            json.dump(doc, fh)
        prov = self._rows(d)["flow2"]["provenance"]
        self.assertIs(prov["diverged"], True)

    def test_reformatted_but_equal_doc_is_not_diverged(self):
        # diverged is a CONTENT verdict: rewriting the file with different
        # whitespace/key order but identical content stays False (the
        # reader recomputes the canonical serialization, never raw bytes).
        import dashboard_control as dcx
        d = self._git(self._mini_repo({}))
        self.assertTrue(dcx.pipeline_create(d, "flow2", source="flow")["ok"])
        pj = os.path.join(d, "var", "autonomy", "pipelines", "flow2",
                          "pipeline.json")
        with open(pj) as fh:
            doc = json.load(fh)
        with open(pj, "w") as fh:
            json.dump(doc, fh, sort_keys=False)   # same content, new bytes
        prov = self._rows(d)["flow2"]["provenance"]
        self.assertIs(prov["diverged"], False)

    def test_brief_edit_flips_diverged(self):
        # briefs are pipeline content: the fingerprint covers doc + briefs
        # (pipeline.content_fingerprint), so editing only a brief must
        # read as diverged too (Codex CP2 -- a doc-only hash would leave
        # the gallery claiming "not diverged" after a brief rewrite).
        import dashboard_control as dcx
        d = self._git(self._mini_repo({}))
        self.assertTrue(dcx.pipeline_create(d, "flow2", source="flow")["ok"])
        brief = os.path.join(d, "var", "autonomy", "pipelines", "flow2",
                             "pick.md")
        with open(brief, "w") as fh:
            fh.write("rewritten brief\n")
        prov = self._rows(d)["flow2"]["provenance"]
        self.assertIs(prov["diverged"], True)

    def test_junk_sidecars_read_as_none(self):
        d = self._mini_repo({})
        cases = [
            "{not json",                                     # unparseable
            '"a string"',                                    # non-dict
            {"created": "made-up", "at": 1},                 # bad created
            {"created": "blank"},                            # at missing
            {"created": "blank", "at": True},                # bool is not an epoch
            {"created": "blank", "at": 1, "extra": 1},       # unknown key
            {"created": "clone", "at": 1},                   # clone w/o lineage
            {"created": "clone", "at": 1, "source": "../up",
             "source_version": 1, "fingerprint": "sha256:" + "0" * 64},
            {"created": "clone", "at": 1, "source": "flow",
             "source_version": "3", "fingerprint": "sha256:" + "0" * 64},
            {"created": "clone", "at": 1, "source": "flow",
             "source_version": 1, "fingerprint": "md5:junk"},
        ]
        for i, payload in enumerate(cases):
            name = "junk%d" % i
            self._local(d, name)
            self._sidecar(d, name, payload)
        rows = self._rows(d)
        for i in range(len(cases)):
            self.assertIsNone(rows["junk%d" % i]["provenance"],
                              "case %d fabricated a claim" % i)

    def test_sidecar_next_to_committed_ignored(self):
        # a sidecar for a name that HAS a committed pack is stale junk --
        # never attached (the row is a template, not a local creation).
        d = self._mini_repo({})
        self._sidecar(d, "flow", {"created": "blank", "at": 1})
        rows = self._rows(d)
        self.assertEqual(rows["flow"]["source"], "committed")
        self.assertIsNone(rows["flow"]["provenance"])

    def test_symlinked_var_entry_skipped(self):
        # effective_pipeline_dir ignores a symlinked shadow as unsanctioned;
        # the gallery must not list a row the resolver refuses to serve.
        d = self._mini_repo({})
        target = self._local(d, "realdir")
        vroot = os.path.join(d, "var", "autonomy", "pipelines")
        os.symlink(target, os.path.join(vroot, "ghostlink"))
        rows = self._rows(d)
        self.assertNotIn("ghostlink", rows)
        self.assertIn("realdir", rows)

    def test_invalid_local_dir_renders_errors_with_provenance(self):
        # a broken local clone still shows its lineage (the doc errors and
        # the provenance are independent truths); diverged stays ABSENT --
        # no doc to compare, no claim.
        d = self._mini_repo({})
        pdir = self._local(d, "brokeclone")
        with open(os.path.join(pdir, "pipeline.json"), "w") as fh:
            fh.write("{corrupt")
        self._sidecar(d, "brokeclone",
                      {"created": "clone", "at": 1, "source": "flow",
                       "source_version": 1,
                       "fingerprint": "sha256:" + "0" * 64})
        rows = self._rows(d)
        self.assertFalse(rows["brokeclone"]["valid"])
        self.assertTrue(rows["brokeclone"]["errors"])
        prov = rows["brokeclone"]["provenance"]
        self.assertEqual(prov["source"], "flow")
        self.assertNotIn("diverged", prov)
