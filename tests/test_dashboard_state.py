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
    def _status(self, current, dash_boot, repos, behind_map=None):
        bm = behind_map or {}
        return ds.engine_status(
            dash_boot, repos,
            head_reader=lambda home=None: current,
            behind_reader=lambda running, cur, home=None: bm.get(running))

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


class TestTriggerHealth(unittest.TestCase):
    """trigger_health (#188c): missed-fire detection for the control room's
    trigger-health signal. Compares each cron role's persisted last_fire
    marker ($VARDIR/cron/<role>.last_fire, an epoch int -- see
    supervisor.sh:resolve_cron_due) against the SAME schedule math the
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

    def test_no_lanes_block_is_the_single_implicit_main_lane(self):
        d = self._repo("agent:\n  type: claude\n")
        st = ds.build_repo_state(d)
        self.assertEqual(
            st["lanes"], {"names": ["main"], "default": "main", "valid": True})

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
            st["lanes"], {"names": ["main"], "default": "main", "valid": True})
        for r in st["roles"]:
            self.assertEqual(r["lane"], "main")
