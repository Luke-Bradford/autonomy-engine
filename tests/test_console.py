"""Unit tests for bin/console.py -- the terminal control console. The testable
core (command dispatch, loop-state read, pause/resume, status) is exercised
directly; the read-eval loop and log-tail thread are thin I/O and not tested."""
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "bin"))

import console  # noqa: E402


class TestLoopState(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.repo, ignore_errors=True)
        os.makedirs(os.path.join(self.repo, "var", "autonomy-logs"))
        os.makedirs(os.path.join(self.repo, "var", "autonomy-supervisor.lock"))

    def _write_pid(self, pid):
        with open(os.path.join(self.repo, "var", "autonomy-supervisor.lock", "pid"), "w") as fh:
            fh.write(str(pid))

    def test_no_lock_is_stopped(self):
        self.assertEqual(console.loop_state(self.repo, pid_alive=lambda p: True),
                         "stopped")

    def test_dead_pid_is_stopped(self):
        self._write_pid(4242)
        self.assertEqual(console.loop_state(self.repo, pid_alive=lambda p: False),
                         "stopped")

    def test_live_pid_is_running(self):
        self._write_pid(4242)
        self.assertEqual(console.loop_state(self.repo, pid_alive=lambda p: True),
                         "running")

    def test_live_pid_with_pause_sentinel_is_paused(self):
        self._write_pid(4242)
        open(os.path.join(self.repo, "var", "autonomy-logs", "autonomy-PAUSE"), "w").close()
        self.assertEqual(console.loop_state(self.repo, pid_alive=lambda p: True),
                         "paused")

    def test_junk_pid_is_stopped(self):
        with open(os.path.join(self.repo, "var", "autonomy-supervisor.lock", "pid"), "w") as fh:
            fh.write("not-a-number")
        self.assertEqual(console.loop_state(self.repo, pid_alive=lambda p: True),
                         "stopped")


class TestStatusLines(unittest.TestCase):
    def test_empty(self):
        self.assertIn("no repos registered", console.status_lines(repos=[])[0])

    def test_lists_repos(self):
        with mock.patch.object(console, "loop_state", lambda r: "running"):
            lines = console.status_lines(repos=["/w/a", "/w/b"])
        self.assertEqual(len(lines), 2)
        self.assertIn("/w/a", lines[0])
        self.assertIn("running", lines[0])


class TestPauseResume(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.repo, ignore_errors=True)
        self.sentinel = os.path.join(self.repo, "var", "autonomy-logs", "autonomy-PAUSE")

    def test_pause_creates_sentinel_then_resume_removes(self):
        self.assertEqual(console._pause_resume("pause", self.repo).count("paused"), 1)
        self.assertTrue(os.path.exists(self.sentinel))
        console._pause_resume("resume", self.repo)
        self.assertFalse(os.path.exists(self.sentinel))

    def test_no_repos(self):
        # isolate from the real registry -- an empty arg must NOT read (or touch)
        # the operator's live repos.
        with mock.patch.object(console, "registered_repos", lambda *a, **k: []):
            self.assertIn("no repos", console._pause_resume("pause", ""))


class TestDispatch(unittest.TestCase):
    def test_blank_and_help_and_unknown(self):
        st = {}
        self.assertEqual(console.dispatch("", st), "")
        self.assertIn("commands:", console.dispatch("help", st))
        self.assertIn("unknown command", console.dispatch("frobnicate", st))

    def test_quit_sets_flag(self):
        st = {}
        console.dispatch("quit", st)
        self.assertTrue(st["quit"])

    def test_logs_toggle(self):
        st = {}
        console.dispatch("logs off", st)
        self.assertFalse(st["logs"])
        console.dispatch("logs on", st)
        self.assertTrue(st["logs"])

    def test_chat_without_arg(self):
        self.assertIn("usage: chat", console.dispatch("chat", {}))

    def test_web_opens_and_reports(self):
        with mock.patch.object(console.webbrowser, "open") as op:
            out = console.dispatch("web", {"port": 9099})
        op.assert_called_once()
        self.assertIn("9099", out)

    def test_status_routes(self):
        with mock.patch.object(console, "status_lines", lambda: ["OK line"]):
            self.assertEqual(console.dispatch("status", {}), "OK line")


class TestConciergeReply(unittest.TestCase):
    def test_no_local_account_is_a_notice(self):
        fake = mock.MagicMock()
        fake.list.return_value = [{"name": "claude", "kind": "claude_subscription"}]
        with mock.patch.object(console, "accts") as m:
            m.Accounts.return_value = fake
            out = console.concierge_reply("hi", repos=[])
        self.assertIn("no local LLM configured", out)

    def test_accounts_lib_absent_is_a_notice(self):
        with mock.patch.object(console, "accts", None):
            self.assertIn("accounts library unavailable",
                          console.concierge_reply("hi", repos=[]))


if __name__ == "__main__":
    unittest.main()
