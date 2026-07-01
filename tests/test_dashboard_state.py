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

    def test_no_ticket_when_none_mentioned(self):
        s = ds.parse_session_log(os.path.join(LOGDIR, "session-20260701T090000.log"))
        # the completed fixture's result text mentions #42 (merged) -> that's the
        # ticket it worked
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


class TestTicketRef(unittest.TestCase):
    def test_extracts_issue_number_from_feat_branch(self):
        self.assertEqual(ds.extract_ticket_ref("feat/57-add-retry"), 57)
        self.assertEqual(ds.extract_ticket_ref("fix/1832-null-guard"), 1832)

    def test_none_when_no_number(self):
        self.assertIsNone(ds.extract_ticket_ref("main"))
        self.assertIsNone(ds.extract_ticket_ref("detached@abc123"))
        self.assertIsNone(ds.extract_ticket_ref(""))


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
        roles = ds.build_roles({}, activity="working")
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

    def test_config_declared_role_overrides_placeholder(self):
        cfg_roles = {"qa": {"enabled": "true", "substrate": "routine",
                            "trigger": {"type": "event"}}}
        roles = ds.build_roles(cfg_roles, activity="idle")
        qa = next(r for r in roles if r["name"] == "qa")
        self.assertTrue(qa["enabled"])
        self.assertEqual(qa["substrate"], "routine")
        self.assertEqual(qa["trigger"], "event")

    def test_custom_role_appended(self):
        cfg_roles = {"security_sweeper": {"enabled": "true", "substrate": "routine",
                                          "trigger": {"type": "event"}}}
        roles = ds.build_roles(cfg_roles, activity="idle")
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


if __name__ == "__main__":
    unittest.main()
