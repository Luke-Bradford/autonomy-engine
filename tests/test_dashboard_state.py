"""Unit tests for lib/dashboard_state.py -- the read-only control-room state
model. Parses the engine's real emitted artifacts (stream-json session logs,
supervisor.log, the lock/sentinel lifecycle, config.yaml) into the shape the
P1 page renders. Stdlib only; no network (git/gh state is injected)."""
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))
FIX = os.path.join(HERE, "fixtures", "repo-alpha")
LOGDIR = os.path.join(FIX, "var", "autonomy-logs")

import dashboard_state as ds  # noqa: E402


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


if __name__ == "__main__":
    unittest.main()
