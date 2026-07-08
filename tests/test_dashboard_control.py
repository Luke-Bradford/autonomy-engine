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

    def test_default_scope_writes_overlay_not_config(self):
        # #202: default-saves route to the untracked overlay (survives the
        # preflight stash-recovery), NOT the tracked config.yaml.
        p = dc.set_model_plan(self.repo, "claude-opus-4-8", "high", "default")
        self.assertEqual(p["overlay"], "/w/tree/var/autonomy-logs/config-overrides")
        self.assertEqual(p["overlay_set"], {"model": "claude-opus-4-8",
                                            "effort": "high"})
        self.assertNotIn("config_path", p)

    def test_default_scope_model_only_overlay(self):
        p = dc.set_model_plan(self.repo, "claude-sonnet-5", "", "default")
        self.assertEqual(p["overlay_set"], {"model": "claude-sonnet-5"})

    def test_rejects_bad_model_string(self):
        for bad in ("opus; rm -rf /", "a b", "x\ny", "claude$(boom)"):
            self.assertIn("error", dc.set_model_plan(self.repo, bad, "", "session"))

    def test_accepts_local_llm_colon_model(self):
        # #213: Ollama-style name:tag ids carry a colon; accept them so BYO-LLM
        # roles can be set from the UI. Parity with supervisor.sh valid_model_id.
        p = dc.set_model_plan(self.repo, "qwen3:14b", "", "session")
        self.assertNotIn("error", p)
        self.assertEqual(p["content"], "model=qwen3:14b\n")

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

    def test_stop_with_error_service_propagates_refusal(self):
        # #309: find_service refused (stale plist) -- stop/start must surface
        # THAT reason, not act on a half-known service or claim none installed.
        p = dc.control_plan(self.repo, "stop", {"error": "stale plist?"}, 501)
        self.assertEqual(p["error"], "stale plist?")
        self.assertNotIn("cmd", p)

    def test_start_with_error_service_propagates_refusal(self):
        p = dc.control_plan(self.repo, "start", {"error": "stale plist?"}, 501)
        self.assertEqual(p["error"], "stale plist?")
        self.assertNotIn("cmd", p)

    def test_pause_unaffected_by_error_service(self):
        # pause/resume are sentinel-only; a stale plist must not block them
        p = dc.control_plan(self.repo, "pause", {"error": "stale plist?"}, 501)
        self.assertIn("touch", p)

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


class TestFormatCmdError(unittest.TestCase):
    """#151 item 6: a failed control command's stderr is split into a SHORT
    toast reason (`error`) plus an optional full-text `detail` the page shows
    in an expandable block. launchctl errors routinely exceed the ~200 chars a
    toast title can show; clipping there hid the real cause. `detail` appears
    ONLY when the full stderr carries more than the inline reason already does,
    so a short single-line error never grows a redundant expander."""

    def test_empty_stderr_names_the_command_no_detail(self):
        r = dc.format_cmd_error("bootout", "")
        self.assertIn("bootout", r["error"])
        self.assertNotIn("detail", r)

    def test_short_single_line_is_inline_no_detail(self):
        r = dc.format_cmd_error("bootout", "  Boot-out failed: 5: I/O error\n")
        self.assertIn("Boot-out failed: 5: I/O error", r["error"])
        self.assertNotIn("detail", r)          # nothing more to expand

    def test_long_single_line_truncates_error_keeps_full_detail(self):
        line = "x" * 400
        r = dc.format_cmd_error("bootstrap", line)
        self.assertLess(len(r["error"]), 260)  # title stays short
        self.assertTrue(r["error"].endswith("…"))
        self.assertEqual(r["detail"], line)    # full text preserved

    def test_multiline_error_is_first_line_detail_is_full(self):
        stderr = "first line problem\nstack frame 1\nstack frame 2"
        r = dc.format_cmd_error("bootout", stderr)
        self.assertIn("first line problem", r["error"])
        self.assertNotIn("stack frame", r["error"])
        self.assertEqual(r["detail"], stderr)  # every line kept for the expander

    def test_detail_never_loses_stderr_content(self):
        stderr = ("Bootstrap failed: 5: Input/output error\n"
                  "Try re-running as root, or check the plist path is readable\n") * 5
        r = dc.format_cmd_error("bootstrap", stderr)
        self.assertEqual(r["detail"], stderr.strip())


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

    def test_label_echoed_outside_label_key_does_not_pass(self):
        # Codex CP2 on #309: the filename-derived label appearing in a COMMENT
        # (or any non-Label string) must not satisfy the check -- only the
        # actual <key>Label</key> value counts. A substring scan would pass
        # this; the plistlib comparison refuses.
        text = (PLIST % "/Users/op/.myrepo-autonomy").replace(
            "<dict>",
            "<dict><!-- <string>com.autonomy.stale.supervisor</string> -->", 1)
        with open(os.path.join(self.dir, "com.autonomy.stale.supervisor.plist"),
                  "w") as fh:
            fh.write(text)
        svc = dc.find_service("/Users/op/.myrepo-autonomy", self.dir)
        self.assertIn("error", svc)
        self.assertIn("stale plist", svc["error"])

    def test_unparseable_plist_refuses_not_trusts(self):
        # content-matches --repo but is not valid plist XML: the Label cannot
        # be verified, so refuse (fail-safe) rather than act on the filename.
        with open(os.path.join(self.dir, "com.autonomy.myrepo.supervisor.plist"),
                  "w") as fh:
            fh.write("<string>--repo</string>\n"
                     "<string>/Users/op/.myrepo-autonomy</string>\n"
                     "not a plist <<<")
        svc = dc.find_service("/Users/op/.myrepo-autonomy", self.dir)
        self.assertIn("error", svc)

    def test_internal_label_mismatch_refuses_stale_plist(self):
        # #309: filename says .stale., internal Label says .myrepo. -- launchctl
        # stop (filename-derived label) and start (internal Label) would act on
        # DIFFERENT targets; find_service must refuse, not pick either.
        self._write("com.autonomy.stale.supervisor.plist", "/Users/op/.myrepo-autonomy")
        svc = dc.find_service("/Users/op/.myrepo-autonomy", self.dir)
        self.assertIn("error", svc)
        self.assertIn("stale plist", svc["error"])
        self.assertNotIn("label", svc)


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

    def test_structural_key_refused_with_pr_guidance(self):
        # SD-28 (#211/#282): merge_gate.strategy is STRUCTURAL truth -- writable
        # ONLY via a config.yaml commit + PR (#87), never from the page. Writing
        # it to the tracked config.yaml here would be silently swept by the
        # loop's preflight stash-recovery (the revert-lie). config_set_plan must
        # REFUSE it with a clear pointer to the commit-PR path -- never a plan
        # that touches config.yaml or an overlay.
        p = self.plan("merge_gate.strategy", "ci_only")
        self.assertIn("error", p)
        self.assertIn("#87", p["error"])
        self.assertNotIn("config_set", p)
        self.assertNotIn("config_path", p)
        self.assertNotIn("overlay", p)

    def test_model_effort_keys_route_to_overlay(self):
        # #202: the model/effort keys write the untracked overlay instead.
        # #211: board.owner/board.project_title join them -- board.sh now reads
        # the overlay (config_value_with_overlay), so the config-page save both
        # survives preflight AND takes effect.
        cases = {
            "agent.model.primary": ("model", "claude-opus-4-8"),
            "agent.model.fallback": ("fallback", "claude-sonnet-5"),
            "agent.effort": ("effort", "high"),
            "board.owner": ("board_owner", "some-org"),
            "board.project_title": ("board_project_title", "My Fancy Board"),
        }
        for key, (short, value) in cases.items():
            p = self.plan(key, value)
            self.assertNotIn("error", p, "%s: %r" % (key, p))
            self.assertEqual(p["overlay"],
                             os.path.join(self.repo, "var", "autonomy-logs",
                                          "config-overrides"))
            self.assertEqual(p["overlay_set"], {short: value})
            self.assertNotIn("config_path", p)

    def test_unknown_key_refused(self):
        self.assertIn("error", self.plan("merge_gate.author_login", "x"))
        self.assertIn("error", self.plan("engine.account_key", "x"))
        self.assertIn("error", self.plan("evil..key", "x"))

    def test_bad_values_refused_per_key(self):
        # (merge_gate.strategy is refused structurally regardless of value --
        # see test_structural_key_refused_with_pr_guidance.)
        self.assertIn("error", self.plan("agent.effort", "extreme"))
        self.assertIn("error", self.plan("agent.model.primary", "bad;model"))
        self.assertIn("error", self.plan("board.owner", "two\nlines"))
        self.assertIn("error", self.plan("board.project_title", "a\"b'c"))
        self.assertIn("error", self.plan("board.owner", ""))
        self.assertIn("error", self.plan("board.project_title", "x" * 300))

    def test_values_are_stripped(self):
        # board.owner now routes to the overlay (#211); the value is still
        # trimmed before it is persisted.
        p = self.plan("board.owner", "  padded-org  ")
        self.assertEqual(p["overlay_set"], {"board_owner": "padded-org"})


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


LANE_PLIST = """<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>%s</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string>
    <string>/eng/bin/supervisor.sh</string>
    <string>--repo</string>
    <string>%s</string>
    <string>--lane</string>
    <string>%s</string>
  </array>
</dict></plist>
"""


class TestFindLaneService(unittest.TestCase):
    """#147: lane -> ITS launchd service, strictly (SD-21: one supervisor per
    lane; the default lane keeps the LEGACY com.autonomy.<slug>.supervisor
    label with no --lane). Resolution is label-CONSTRUCTED + content-verified,
    never scanned-and-guessed; every mismatch REFUSES -- there is no fallback
    to a different lane's service (that would be acting on the wrong loop,
    the fail-open direction)."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.repo = "/Users/op/.myrepo-autonomy"
        with open(os.path.join(self.dir, "com.autonomy.myrepo.supervisor.plist"), "w") as fh:
            fh.write(PLIST % self.repo)

    def _lane_plist(self, label_mid, worktree, lane):
        name = "com.autonomy.%s.supervisor.plist" % label_mid
        with open(os.path.join(self.dir, name), "w") as fh:
            fh.write(LANE_PLIST % ("com.autonomy.%s.supervisor" % label_mid,
                                   worktree, lane))

    def test_sibling_lane_resolves_label_and_worktree(self):
        self._lane_plist("myrepo.qa", "/Users/op/.myrepo-qa-autonomy", "qa")
        svc = dc.find_lane_service(self.repo, "qa", self.dir)
        self.assertEqual(svc["label"], "com.autonomy.myrepo.qa.supervisor")
        self.assertEqual(svc["repo"], "/Users/op/.myrepo-qa-autonomy")

    def test_missing_sibling_plist_is_error_never_default(self):
        svc = dc.find_lane_service(self.repo, "qa", self.dir)
        self.assertIn("error", svc)
        self.assertIn("setup_worktree", svc["error"])

    def test_lane_content_mismatch_is_error(self):
        # a plist named .qa. whose --lane says something else: refuse
        self._lane_plist("myrepo.qa", "/Users/op/.myrepo-qa-autonomy", "prod")
        self.assertIn("error", dc.find_lane_service(self.repo, "qa", self.dir))

    def test_stale_own_plist_propagates_find_service_refusal(self):
        # #309: the repo's OWN plist has filename != internal Label; lane
        # resolution derives the slug from that label, so it must refuse with
        # the stale-plist reason, not construct labels off a lie.
        os.remove(os.path.join(self.dir, "com.autonomy.myrepo.supervisor.plist"))
        with open(os.path.join(self.dir, "com.autonomy.stale.supervisor.plist"), "w") as fh:
            fh.write(PLIST % self.repo)   # internal Label stays .myrepo.
        svc = dc.find_lane_service(self.repo, "qa", self.dir)
        self.assertIn("error", svc)
        self.assertIn("stale plist", svc["error"])

    def test_own_lane_returns_none_when_registered_is_that_lane(self):
        # registered worktree runs lane qa itself -> None (use existing path)
        os.remove(os.path.join(self.dir, "com.autonomy.myrepo.supervisor.plist"))
        self._lane_plist("myrepo.qa", self.repo, "qa")
        self.assertIsNone(dc.find_lane_service(self.repo, "qa", self.dir))

    def test_default_lane_of_default_registration_is_none(self):
        # registered worktree IS the default-lane service (no --lane in its
        # plist); requesting the default lane by name -> own path (None).
        self.assertIsNone(dc.find_lane_service(self.repo, "main", self.dir,
                                               default_lane="main"))

    def test_no_own_service_is_error(self):
        self.assertIn("error", dc.find_lane_service("/nope", "qa", self.dir))

    def test_bad_lane_name_is_error_before_io(self):
        self.assertIn("error", dc.find_lane_service(self.repo, "../x", self.dir))

    def test_default_lane_from_nonown_registration_uses_legacy_label(self):
        # registered worktree IS lane qa; requested lane = default 'main':
        # resolve the LEGACY com.autonomy.myrepo.supervisor (SD-21), never
        # a constructed .main. label (Codex CP1 High-1).
        os.remove(os.path.join(self.dir, "com.autonomy.myrepo.supervisor.plist"))
        self._lane_plist("myrepo.qa", self.repo, "qa")
        with open(os.path.join(self.dir, "com.autonomy.myrepo.supervisor.plist"), "w") as fh:
            fh.write(PLIST % "/Users/op/.myrepo-autonomy-main")
        svc = dc.find_lane_service(self.repo, "main", self.dir, default_lane="main")
        self.assertEqual(svc["label"], "com.autonomy.myrepo.supervisor")
        self.assertEqual(svc["repo"], "/Users/op/.myrepo-autonomy-main")

    def test_label_content_mismatch_is_error(self):
        # plist file named .qa. whose internal Label says something else:
        # stop (constructed label) and start (plist's internal Label) would
        # act on different launchd targets -- refuse (Codex CP1 Med-5).
        name = "com.autonomy.myrepo.qa.supervisor.plist"
        with open(os.path.join(self.dir, name), "w") as fh:
            fh.write(LANE_PLIST % ("com.autonomy.OTHER.supervisor",
                                   "/Users/op/.myrepo-qa-autonomy", "qa"))
        self.assertIn("error", dc.find_lane_service(self.repo, "qa", self.dir))


class TestParsePlistArgs(unittest.TestCase):
    def test_repo_and_lane_extracted(self):
        text = LANE_PLIST % ("com.autonomy.x.qa.supervisor", "/wt", "qa")
        self.assertEqual(dc.parse_plist_args(text), {"repo": "/wt", "lane": "qa"})

    def test_no_lane_is_none(self):
        text = PLIST % "/wt"
        self.assertEqual(dc.parse_plist_args(text), {"repo": "/wt", "lane": None})

    def test_garbage_text_is_total(self):
        self.assertEqual(dc.parse_plist_args("not xml at all"),
                         {"repo": None, "lane": None})


if __name__ == "__main__":
    unittest.main()
