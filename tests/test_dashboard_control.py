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


class TestConfigSetPlan(unittest.TestCase):
    """#47: config page writes. Whitelisted dotted keys only, per-key
    validation; the plan reuses the config_set execution path the server
    already has for set_model."""
    def setUp(self):
        self.repo = "/tmp/some-repo"

    def plan(self, key, value):
        return dc.config_set_plan(self.repo, key, value)

    def test_valid_keys_produce_config_set(self):
        cases = {
            "board.owner": "some-org",
            "board.project_title": "My Fancy Board",
            "agent.model.primary": "claude-opus-4-8",
            "agent.model.fallback": "claude-sonnet-5",
            "agent.effort": "high",
            "merge_gate.strategy": "ci_only",
        }
        for key, value in cases.items():
            p = self.plan(key, value)
            self.assertNotIn("error", p, "%s: %r" % (key, p))
            self.assertEqual(p["config_set"], {key: value})
            self.assertEqual(p["config_path"],
                             os.path.join(self.repo, ".autonomy", "config.yaml"))

    def test_unknown_key_refused(self):
        self.assertIn("error", self.plan("merge_gate.author_login", "x"))
        self.assertIn("error", self.plan("engine.account_key", "x"))
        self.assertIn("error", self.plan("evil..key", "x"))

    def test_bad_values_refused_per_key(self):
        self.assertIn("error", self.plan("merge_gate.strategy", "yolo"))
        self.assertIn("error", self.plan("agent.effort", "extreme"))
        self.assertIn("error", self.plan("agent.model.primary", "bad;model"))
        self.assertIn("error", self.plan("board.owner", "two\nlines"))
        self.assertIn("error", self.plan("board.project_title", "a\"b'c"))
        self.assertIn("error", self.plan("board.owner", ""))
        self.assertIn("error", self.plan("board.project_title", "x" * 300))

    def test_values_are_stripped(self):
        p = self.plan("board.owner", "  padded-org  ")
        self.assertEqual(p["config_set"], {"board.owner": "padded-org"})


class TestRepoRegistryPlans(unittest.TestCase):
    """#47: add/remove watched repos from the page. The registry file is the
    same one dashboard discovery + quickstart + control.sh use."""
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.reg = os.path.join(self.tmp, "repos")
        self.repo = os.path.join(self.tmp, "proj")
        os.makedirs(self.repo)

    def test_add_fresh_repo(self):
        p = dc.repo_add_plan(self.repo, self.reg)
        self.assertEqual(p.get("append"), self.reg)
        self.assertEqual(p.get("line"), self.repo)

    def test_add_normalizes_and_dedupes(self):
        with open(self.reg, "w") as fh:
            fh.write(self.repo + "\n")
        p = dc.repo_add_plan(self.repo + "/", self.reg)
        self.assertTrue(p.get("noop"), p)

    def test_add_missing_dir_refused(self):
        self.assertIn("error", dc.repo_add_plan(os.path.join(self.tmp, "nope"), self.reg))

    def test_add_relative_path_refused(self):
        self.assertIn("error", dc.repo_add_plan("relative/path", self.reg))

    def test_add_hints_when_pack_missing(self):
        p = dc.repo_add_plan(self.repo, self.reg)
        self.assertIn("quickstart", p.get("message", ""))

    def test_add_dedupes_against_trailing_slash_entries(self):
        # PR #48 review: registry lines are normalized before compare, so a
        # manually-edited "path/" entry still dedupes
        with open(self.reg, "w") as fh:
            fh.write(self.repo + "/\n")
        p = dc.repo_add_plan(self.repo, self.reg)
        self.assertTrue(p.get("noop"), p)

    def test_remove_matches_trailing_slash_entries(self):
        with open(self.reg, "w") as fh:
            fh.write(self.repo + "/\n")
        p = dc.repo_remove_plan(self.repo, self.reg)
        self.assertEqual(p.get("drop"), self.repo)

    def test_remove_registered(self):
        with open(self.reg, "w") as fh:
            fh.write("/other\n" + self.repo + "\n")
        p = dc.repo_remove_plan(self.repo, self.reg)
        self.assertEqual(p.get("rewrite"), self.reg)
        self.assertEqual(p.get("drop"), self.repo)

    def test_remove_unregistered_refused(self):
        with open(self.reg, "w") as fh:
            fh.write("/other\n")
        self.assertIn("error", dc.repo_remove_plan(self.repo, self.reg))

    def test_remove_works_for_deleted_dir(self):
        gone = os.path.join(self.tmp, "gone")
        with open(self.reg, "w") as fh:
            fh.write(gone + "\n")
        p = dc.repo_remove_plan(gone, self.reg)
        self.assertEqual(p.get("drop"), gone)



if __name__ == "__main__":
    unittest.main()
