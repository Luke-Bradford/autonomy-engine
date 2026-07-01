"""Unit tests for lib/dashboard_control.py -- the P2 lifecycle control logic.
The safety-critical decision (what a control action does) is a pure function
returning a plan; the server merely executes it. So every safety property is
testable here without running launchctl or touching real LaunchAgents."""
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))
import dashboard_control as dc  # noqa: E402


PLIST = """<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>com.autonomy.myrepo.supervisor</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string>
    <string>/eng/bin/supervisor.sh</string>
    <string>--repo</string>
    <string>%s</string>
  </array>
</dict></plist>
"""


class TestSetModelPlan(unittest.TestCase):
    """#24: live model/effort control. The plan is pure and fully validated
    here; the server only executes it. Two scopes: 'session' (one-shot
    override file the supervisor consumes) and 'default' (config.yaml keys)."""
    def setUp(self):
        self.repo = "/w/tree"

    def test_session_scope_writes_override_file(self):
        p = dc.set_model_plan(self.repo, "claude-opus-4-8", "high", "session")
        self.assertEqual(p["write"], "/w/tree/var/autonomy-logs/model-override")
        self.assertEqual(p["content"], "model=claude-opus-4-8\neffort=high\n")

    def test_session_scope_model_only(self):
        p = dc.set_model_plan(self.repo, "claude-opus-4-8", "", "session")
        self.assertEqual(p["content"], "model=claude-opus-4-8\n")

    def test_session_scope_effort_only(self):
        p = dc.set_model_plan(self.repo, "", "max", "session")
        self.assertEqual(p["content"], "effort=max\n")

    def test_default_scope_returns_config_keys(self):
        p = dc.set_model_plan(self.repo, "claude-opus-4-8", "high", "default")
        self.assertEqual(p["config_path"], "/w/tree/.autonomy/config.yaml")
        self.assertEqual(p["config_set"], {"agent.model.primary": "claude-opus-4-8",
                                           "agent.effort": "high"})

    def test_rejects_bad_model_string(self):
        for bad in ("opus; rm -rf /", "a b", "x\ny", "claude$(boom)"):
            self.assertIn("error", dc.set_model_plan(self.repo, bad, "", "session"))

    def test_rejects_unknown_effort(self):
        self.assertIn("error", dc.set_model_plan(self.repo, "", "turbo", "session"))

    def test_valid_efforts(self):
        for e in ("low", "medium", "high", "xhigh", "max"):
            self.assertNotIn("error", dc.set_model_plan(self.repo, "", e, "session"))

    def test_rejects_empty_request(self):
        self.assertIn("error", dc.set_model_plan(self.repo, "", "", "session"))

    def test_rejects_unknown_scope(self):
        self.assertIn("error", dc.set_model_plan(self.repo, "claude-sonnet-5", "", "forever"))


class TestControlPlan(unittest.TestCase):
    def setUp(self):
        self.repo = "/w/tree"
        self.svc = {"label": "com.autonomy.myrepo.supervisor", "plist": "/la/x.plist"}

    def test_pause_touches_sentinel(self):
        p = dc.control_plan(self.repo, "pause", None, 501)
        self.assertEqual(p, {"touch": "/w/tree/var/autonomy-logs/autonomy-PAUSE",
                             "message": "graceful stop requested — the supervisor will finish the current session, then idle"})

    def test_resume_removes_sentinel(self):
        p = dc.control_plan(self.repo, "resume", None, 501)
        self.assertEqual(p["remove"], "/w/tree/var/autonomy-logs/autonomy-PAUSE")

    def test_stop_with_service_is_bootout(self):
        p = dc.control_plan(self.repo, "stop", self.svc, 501)
        self.assertEqual(p["cmd"], ["launchctl", "bootout",
                                    "gui/501/com.autonomy.myrepo.supervisor"])

    def test_start_with_service_is_bootstrap(self):
        p = dc.control_plan(self.repo, "start", self.svc, 501)
        self.assertEqual(p["cmd"], ["launchctl", "bootstrap", "gui/501", "/la/x.plist"])

    def test_stop_without_service_errors(self):
        p = dc.control_plan(self.repo, "stop", None, 501)
        self.assertIn("error", p)
        self.assertNotIn("cmd", p)

    def test_start_without_service_errors(self):
        p = dc.control_plan(self.repo, "start", None, 501)
        self.assertIn("error", p)

    def test_unknown_action_errors(self):
        p = dc.control_plan(self.repo, "delete-everything", self.svc, 501)
        self.assertIn("error", p)
        self.assertNotIn("cmd", p)
        self.assertNotIn("touch", p)

    def test_any_cmd_is_launchctl_only(self):
        # safety: the only commands this module ever plans are launchctl subverbs
        for action in ("stop", "start"):
            p = dc.control_plan(self.repo, action, self.svc, 501)
            self.assertEqual(p["cmd"][0], "launchctl")
            self.assertIn(p["cmd"][1], ("bootout", "bootstrap"))


class TestFindService(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def _write(self, name, repo):
        with open(os.path.join(self.dir, name), "w") as fh:
            fh.write(PLIST % repo)

    def test_matches_plist_referencing_the_repo(self):
        self._write("com.autonomy.myrepo.supervisor.plist", "/Users/op/.myrepo-autonomy")
        svc = dc.find_service("/Users/op/.myrepo-autonomy", self.dir)
        self.assertIsNotNone(svc)
        self.assertEqual(svc["label"], "com.autonomy.myrepo.supervisor")
        self.assertTrue(svc["plist"].endswith("com.autonomy.myrepo.supervisor.plist"))

    def test_no_match_returns_none(self):
        self._write("com.autonomy.other.supervisor.plist", "/some/other/repo")
        self.assertIsNone(dc.find_service("/Users/op/.myrepo-autonomy", self.dir))

    def test_missing_dir_returns_none(self):
        self.assertIsNone(dc.find_service("/x", os.path.join(self.dir, "nope")))

    def test_ignores_non_autonomy_plists(self):
        with open(os.path.join(self.dir, "com.example.other.plist"), "w") as fh:
            fh.write(PLIST % "/Users/op/.myrepo-autonomy")  # references repo but wrong prefix
        self.assertIsNone(dc.find_service("/Users/op/.myrepo-autonomy", self.dir))


class TestActionValidation(unittest.TestCase):
    def test_valid_actions(self):
        self.assertTrue(dc.is_valid_action("pause"))
        self.assertTrue(dc.is_valid_action("resume"))
        self.assertTrue(dc.is_valid_action("stop"))
        self.assertTrue(dc.is_valid_action("start"))

    def test_invalid_actions(self):
        for a in ("", "PAUSE", "rm", "bootstrap", None, "trade"):
            self.assertFalse(dc.is_valid_action(a))


if __name__ == "__main__":
    unittest.main()
