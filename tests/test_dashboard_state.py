"""Unit tests for lib/dashboard_state.py -- the read-only control-room state
model. Parses the engine's real emitted artifacts (stream-json session logs,
supervisor.log, the lock/sentinel lifecycle, config.yaml) into the shape the
P1 page renders. Stdlib only; no network (git/gh state is injected)."""
import json
import os
import sys
import tempfile
import time
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
