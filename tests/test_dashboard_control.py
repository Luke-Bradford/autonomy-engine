"""Unit tests for lib/dashboard_control.py -- the P2 lifecycle control logic.
The safety-critical decision (what a control action does) is a pure function
returning a plan; the server merely executes it. So every safety property is
testable here without running launchctl or touching real LaunchAgents."""
import json
import os
import shutil
import subprocess
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
        # Slice 3a (SD-34): default scope lands in the var-live shadow, the
        # overlay write path is retired.
        p = dc.set_model_plan(self.repo, "claude-opus-4-8", "high", "default")
        self.assertEqual(p["live_set"], {"agent.model.primary": "claude-opus-4-8",
                                         "agent.effort": "high"})
        self.assertNotIn("overlay", p)
        self.assertNotIn("config_path", p)

    def test_default_scope_model_only_live(self):
        p = dc.set_model_plan(self.repo, "claude-sonnet-5", "", "default")
        self.assertEqual(p["live_set"], {"agent.model.primary": "claude-sonnet-5"})

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


class TestTriggerCtlPlan(unittest.TestCase):
    """Phase D1 (#383): the pure per-trigger marker planner. Path
    mechanics ONLY -- mode/fire-readiness/lane-routing validation happens
    in the caller (bin/dashboard.py execute path); the planner charset-
    gates and shapes the plan, never touches the filesystem."""

    def test_fire_touches_fire_marker(self):
        p = dc.trigger_ctl_plan("/w/tree", "trigger_fire", "adhoc-digest")
        self.assertEqual(p["touch"],
                         "/w/tree/var/trigger-ctl/fire/adhoc-digest")

    def test_stop_touches_stop_marker(self):
        p = dc.trigger_ctl_plan("/w/tree", "trigger_stop", "coder")
        self.assertEqual(p["touch"],
                         "/w/tree/var/trigger-ctl/stop/coder")

    def test_resume_removes_stop_marker(self):
        p = dc.trigger_ctl_plan("/w/tree", "trigger_resume", "coder")
        self.assertEqual(p["remove"],
                         "/w/tree/var/trigger-ctl/stop/coder")

    def test_lane_suffix_matches_supervisor_convention(self):
        p = dc.trigger_ctl_plan("/w/tree", "trigger_stop", "coder",
                                lane_suffix="qa")
        self.assertEqual(p["touch"],
                         "/w/tree/var/trigger-ctl/stop/coder--qa")

    def test_bad_name_charset_refused(self):
        for bad in ("../x", "", "a b", "x/y", None):
            p = dc.trigger_ctl_plan("/w/tree", "trigger_fire", bad)
            self.assertIn("error", p)

    def test_reserved_sidecar_name_refused(self):
        # a trigger named *.outcome can never be a real trigger
        # (validate_trigger refuses it at mint) -- the planner refuses too.
        p = dc.trigger_ctl_plan("/w/tree", "trigger_stop", "x.outcome")
        self.assertIn("error", p)

    def test_bad_lane_charset_refused(self):
        p = dc.trigger_ctl_plan("/w/tree", "trigger_stop", "coder",
                                lane_suffix="../x")
        self.assertIn("error", p)

    def test_unknown_action_refused(self):
        p = dc.trigger_ctl_plan("/w/tree", "trigger_nuke", "coder")
        self.assertIn("error", p)

    def test_actions_tuple_exported(self):
        self.assertEqual(dc.TRIGGER_CTL_ACTIONS,
                         ("trigger_fire", "trigger_stop", "trigger_resume"))


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
        for key, (_short, value) in cases.items():
            p = self.plan(key, value)
            self.assertNotIn("error", p, "%s: %r" % (key, p))
            # Slice 3a (SD-34): every editable key targets the live shadow.
            self.assertEqual(p["live_set"], {key: value})
            self.assertNotIn("overlay", p)
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
        p = self.plan("board.owner", "  padded-org  ")
        self.assertEqual(p["live_set"], {"board.owner": "padded-org"})


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


class TestVarLiveWriter(unittest.TestCase):
    """Workstreams slice 1: the var-live structural writer. UI edits land in
    var/autonomy/config.yaml (the preflight-surviving home); the committed
    file seeds it on first write (legacy overlay folded in, then deleted).
    Every refusal leaves every file untouched (SD-29 mechanics kept)."""

    COMMITTED = (
        "# top comment stays\n"
        "board:\n"
        "  owner: someone\n"
        "  project_title: \"\"\n"
        "agent:\n"
        "  type: claude\n"
        "  model:\n"
        "    primary: claude-sonnet-5\n"
        "    fallback: claude-sonnet-4-6\n"
        "merge_gate:\n"
        "  strategy: manual\n"
        "roles:\n"
        "  coder:\n"
        "    enabled: true\n"
    )

    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.repo = self._td.name
        os.makedirs(os.path.join(self.repo, ".autonomy", "roles"))
        with open(os.path.join(self.repo, ".autonomy", "roles", "qa.md"), "w") as fh:
            fh.write("qa rail\n")
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"), "w") as fh:
            fh.write(self.COMMITTED)
        # a git repo where var/ is ignored (the write-precondition)
        import subprocess
        subprocess.run(["git", "init", "-q", self.repo], check=True)
        with open(os.path.join(self.repo, ".gitignore"), "w") as fh:
            fh.write("var/\n")

    def tearDown(self):
        self._td.cleanup()

    def _live(self):
        return os.path.join(self.repo, "var", "autonomy", "config.yaml")

    def _parse(self, path):
        import config_parser
        with open(path) as fh:
            return config_parser.parse(fh.read())

    # --- roles_block_emit ---------------------------------------------------
    def test_emit_round_trips_through_the_parser(self):
        import config_parser
        roles = {
            "coder": {"enabled": True},
            "qa": {"enabled": True,
                   "trigger": {"type": "event", "on": ["pr.opened"]},
                   "gate": "auto-merge-on-pass",
                   "scope": {"labels": ["ready", "p1"]},
                   "prompt": ".autonomy/roles/qa.md"},
            "pm": {"enabled": False,
                   "trigger": {"type": "cron", "schedule": "0 */4 * * *"},
                   "model": "claude-haiku-4-5-20251001"},
        }
        block = dc.roles_block_emit(roles)
        parsed = config_parser.parse(block)
        self.assertEqual(parsed["roles"], roles)

    def test_emit_quotes_awkward_scalars(self):
        import config_parser
        roles = {"pm": {"enabled": True,
                        "trigger": {"type": "cron", "schedule": "*/30 * * * *"},
                        "account": "work: main"}}
        parsed = config_parser.parse(dc.roles_block_emit(roles))
        self.assertEqual(parsed["roles"], roles)

    def test_emit_refuses_unrepresentable_scalars(self):
        with self.assertRaises(ValueError) as ctx:
            dc.roles_block_emit({"pm": {"account": "has \"both\" 'quotes'"}})
        self.assertIn("pm", str(ctx.exception))

    # --- set_block ------------------------------------------------------------
    def test_set_block_replaces_only_the_block(self):
        new = dc.set_block(self.COMMITTED, "roles",
                           "roles:\n  coder:\n    enabled: false\n")
        self.assertIn("# top comment stays", new)
        self.assertIn("strategy: manual", new)
        self.assertIn("enabled: false", new)
        self.assertNotIn("enabled: true", new)

    def test_set_block_appends_when_absent(self):
        no_roles = "agent:\n  type: claude\n"
        new = dc.set_block(no_roles, "roles", "roles:\n  coder:\n    enabled: true\n")
        self.assertTrue(new.startswith("agent:"))
        self.assertIn("roles:\n  coder:\n    enabled: true", new)

    # --- structural_write ----------------------------------------------------
    def test_first_write_seeds_live_and_applies(self):
        res = dc.structural_write(self.repo, {"coder": {"enabled": False}})
        self.assertTrue(res["ok"], res)
        live = self._parse(self._live())
        self.assertEqual(live["roles"], {"coder": {"enabled": False}})
        self.assertEqual(live["agent"]["model"]["primary"], "claude-sonnet-5")
        # committed file untouched
        with open(os.path.join(self.repo, ".autonomy", "config.yaml")) as fh:
            self.assertEqual(fh.read(), self.COMMITTED)

    def test_first_write_folds_and_deletes_the_legacy_overlay(self):
        logdir = os.path.join(self.repo, "var", "autonomy-logs")
        os.makedirs(logdir)
        with open(os.path.join(logdir, "config-overrides"), "w") as fh:
            fh.write("model=claude-fable-5\neffort=medium\n")
        res = dc.structural_write(self.repo, {"coder": {"enabled": True}})
        self.assertTrue(res["ok"], res)
        live = self._parse(self._live())
        self.assertEqual(live["agent"]["model"]["primary"], "claude-fable-5")
        self.assertEqual(live["agent"]["effort"], "medium")
        self.assertFalse(os.path.exists(os.path.join(logdir, "config-overrides")))

    def test_second_write_edits_the_live_file(self):
        dc.structural_write(self.repo, {"coder": {"enabled": True}})
        dc.structural_write(self.repo, {
            "coder": {"enabled": True},
            "qa": {"enabled": True,
                   "trigger": {"type": "event", "on": ["pr.opened"]},
                   "prompt": ".autonomy/roles/qa.md"}})
        live = self._parse(self._live())
        self.assertIn("qa", live["roles"])

    def test_invalid_roles_refused_files_untouched(self):
        res = dc.structural_write(self.repo, {
            "qa": {"enabled": True, "trigger": {"type": "cron"}}})  # no schedule
        self.assertFalse(res["ok"])
        self.assertIn("schedule", res["error"])
        self.assertFalse(os.path.exists(self._live()))

    def test_non_roles_keys_never_drift(self):
        # the writer only replaces the roles block; everything else must be
        # byte-preserved in the live file relative to its seed.
        dc.structural_write(self.repo, {"coder": {"enabled": True}})
        live = self._parse(self._live())
        self.assertEqual(live["merge_gate"]["strategy"], "manual")
        self.assertEqual(live["board"]["owner"], "someone")

    def test_write_refused_when_var_not_gitignored(self):
        os.unlink(os.path.join(self.repo, ".gitignore"))
        res = dc.structural_write(self.repo, {"coder": {"enabled": True}})
        self.assertFalse(res["ok"])
        self.assertIn(".gitignore", res["error"])
        self.assertFalse(os.path.exists(self._live()))

    # --- drift ---------------------------------------------------------------
    def test_drift_absent_without_live(self):
        self.assertEqual(dc.live_config_drift(self.repo),
                         {"live": False, "differs": False})

    def test_drift_reported_when_live_differs(self):
        dc.structural_write(self.repo, {"coder": {"enabled": False}})
        d = dc.live_config_drift(self.repo)
        self.assertTrue(d["live"])
        self.assertTrue(d["differs"])

    def test_fold_skips_values_the_overlay_readers_ignored(self):
        # CP2: an invalid overlay value (readers ignored it) must never be
        # PROMOTED into effective config by the fold.
        logdir = os.path.join(self.repo, "var", "autonomy-logs")
        os.makedirs(logdir)
        with open(os.path.join(logdir, "config-overrides"), "w") as fh:
            fh.write("model=bad model id\neffort=nope\nfallback=claude-sonnet-5\n")
        res = dc.structural_write(self.repo, {"coder": {"enabled": True}})
        self.assertTrue(res["ok"], res)
        live = self._parse(self._live())
        self.assertEqual(live["agent"]["model"]["primary"], "claude-sonnet-5")
        self.assertEqual(live["agent"]["model"]["fallback"], "claude-sonnet-5")
        self.assertNotIn("effort", live["agent"])


class TestLiveScalarWrite(unittest.TestCase):
    """Slice 3a: scalar page edits land in the var-live shadow (the overlay
    write path retires for default-scope saves). Same seeding + refusal
    semantics as the slice-1 structural writer."""

    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.repo = self._td.name
        os.makedirs(os.path.join(self.repo, ".autonomy"))
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("agent:\n  model:\n    primary: claude-sonnet-5\n"
                     "    fallback: claude-sonnet-4-6\n")
        import subprocess
        subprocess.run(["git", "init", "-q", self.repo], check=True)
        with open(os.path.join(self.repo, ".gitignore"), "w") as fh:
            fh.write("var/\n")

    def tearDown(self):
        self._td.cleanup()

    def _live(self):
        return os.path.join(self.repo, "var", "autonomy", "config.yaml")

    def _parse_live(self):
        import config_parser
        with open(self._live()) as fh:
            return config_parser.parse(fh.read())

    def test_first_write_seeds_and_sets(self):
        res = dc.live_scalar_write(self.repo, {"agent.model.primary": "claude-opus-4-8"})
        self.assertTrue(res["ok"], res)
        cfg = self._parse_live()
        self.assertEqual(cfg["agent"]["model"]["primary"], "claude-opus-4-8")
        self.assertEqual(cfg["agent"]["model"]["fallback"], "claude-sonnet-4-6")

    def test_planner_model_key_writes(self):
        res = dc.live_scalar_write(self.repo, {"agent.planner.model": "claude-opus-4-8"})
        self.assertTrue(res["ok"], res)
        self.assertEqual(self._parse_live()["agent"]["planner"]["model"],
                         "claude-opus-4-8")

    def test_overlay_folds_and_retires_on_first_scalar_write(self):
        logdir = os.path.join(self.repo, "var", "autonomy-logs")
        os.makedirs(logdir)
        with open(os.path.join(logdir, "config-overrides"), "w") as fh:
            fh.write("effort=medium\n")
        res = dc.live_scalar_write(self.repo, {"agent.model.primary": "claude-opus-4-8"})
        self.assertTrue(res["ok"], res)
        self.assertEqual(self._parse_live()["agent"]["effort"], "medium")
        self.assertFalse(os.path.exists(os.path.join(logdir, "config-overrides")))

    def test_refused_when_var_not_ignored(self):
        os.unlink(os.path.join(self.repo, ".gitignore"))
        res = dc.live_scalar_write(self.repo, {"agent.effort": "low"})
        self.assertFalse(res["ok"])
        self.assertFalse(os.path.exists(self._live()))

    def test_config_set_plan_targets_live_not_overlay(self):
        plan = dc.config_set_plan(self.repo, "agent.model.primary", "claude-opus-4-8")
        self.assertNotIn("overlay", plan)
        self.assertEqual(plan.get("live_set"), {"agent.model.primary": "claude-opus-4-8"})

    def test_config_set_plan_planner_model_validated(self):
        bad = dc.config_set_plan(self.repo, "agent.planner.model", "not a model")
        self.assertIn("error", bad)
        good = dc.config_set_plan(self.repo, "agent.planner.model", "claude-opus-4-8")
        self.assertEqual(good.get("live_set"), {"agent.planner.model": "claude-opus-4-8"})

    def test_set_model_plan_default_scope_targets_live(self):
        plan = dc.set_model_plan(self.repo, "claude-opus-4-8", "high", "default")
        self.assertNotIn("overlay", plan)
        self.assertEqual(plan.get("live_set"),
                         {"agent.model.primary": "claude-opus-4-8",
                          "agent.effort": "high"})

    def test_create_scalar_refuses_over_top_level_scalar(self):
        # CP2: `agent: something` (scalar) must refuse, never be silently
        # replaced by a mapping.
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("agent: claude\n")
        res = dc.live_scalar_write(self.repo, {"agent.planner.model": "claude-opus-4-8"})
        self.assertFalse(res["ok"])
        self.assertFalse(os.path.exists(self._live()))


class TestWorkstreamAuthoring(unittest.TestCase):
    """Authoring slice: create/edit workstreams from the page -- ws_add,
    ws_set (patch), ws_prompt_set (rails live in the untracked
    var/autonomy/roles/, localize-on-write for tracked pack rails). All
    through the slice-1 structural writer: refusals leave files untouched."""

    ENGINE = os.path.join(HERE, "..")

    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.repo = self._td.name
        os.makedirs(os.path.join(self.repo, ".autonomy", "roles"))
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("agent:\n  model:\n    primary: claude-sonnet-5\n"
                     "roles:\n  coder:\n    enabled: true\n")
        with open(os.path.join(self.repo, ".autonomy", "roles", "qa.md"), "w") as fh:
            fh.write("committed qa rail\n")
        import subprocess
        subprocess.run(["git", "init", "-q", self.repo], check=True)
        with open(os.path.join(self.repo, ".gitignore"), "w") as fh:
            fh.write("var/\n")

    def tearDown(self):
        self._td.cleanup()

    def _roles(self):
        import config_parser
        with open(os.path.join(self.repo, "var", "autonomy", "config.yaml")) as fh:
            return config_parser.parse(fh.read())["roles"]

    # --- ws_add -----------------------------------------------------------
    def test_add_pm_from_template(self):
        res = dc.ws_add(self.repo, "pm", "pm", self.ENGINE)
        self.assertTrue(res["ok"], res)
        roles = self._roles()
        self.assertIn("pm", roles)
        self.assertFalse(roles["pm"].get("enabled"))       # lands disabled
        self.assertEqual(roles["pm"]["trigger"]["type"], "cron")
        rail = os.path.join(self.repo, roles["pm"]["prompt"])
        self.assertTrue(os.path.isfile(rail))
        self.assertTrue(roles["pm"]["prompt"].startswith("var/autonomy/roles/"))

    def test_add_custom_name_charset_gated(self):
        res = dc.ws_add(self.repo, "bad/name", "custom", self.ENGINE)
        self.assertFalse(res["ok"])

    def test_add_existing_name_refused(self):
        res = dc.ws_add(self.repo, "coder", "coder", self.ENGINE)
        self.assertFalse(res["ok"])
        self.assertIn("exists", res["error"])

    def test_add_unknown_template_refused(self):
        self.assertFalse(dc.ws_add(self.repo, "x", "wizard", self.ENGINE)["ok"])

    # --- ws_set -----------------------------------------------------------
    def test_set_enable_toggle(self):
        dc.ws_add(self.repo, "pm", "pm", self.ENGINE)
        res = dc.ws_set(self.repo, "pm", {"enabled": True})
        self.assertTrue(res["ok"], res)
        self.assertTrue(self._roles()["pm"]["enabled"])

    def test_set_cron_trigger(self):
        dc.ws_add(self.repo, "pm", "pm", self.ENGINE)
        res = dc.ws_set(self.repo, "pm",
                        {"trigger": {"type": "cron", "schedule": "0 */2 * * *"}})
        self.assertTrue(res["ok"], res)
        self.assertEqual(self._roles()["pm"]["trigger"],
                         {"type": "cron", "schedule": "0 */2 * * *"})

    def test_set_event_trigger_and_gate(self):
        dc.ws_add(self.repo, "qa", "qa", self.ENGINE)
        res = dc.ws_set(self.repo, "qa",
                        {"trigger": {"type": "event", "on": ["pr.opened"]},
                         "gate": "auto-merge-on-pass"})
        self.assertTrue(res["ok"], res)
        roles = self._roles()
        self.assertEqual(roles["qa"]["trigger"]["on"], ["pr.opened"])
        self.assertEqual(roles["qa"]["gate"], "auto-merge-on-pass")

    def test_set_scope_labels_and_model(self):
        res = dc.ws_set(self.repo, "coder",
                        {"scope_labels": ["ready", "p1"],
                         "model": "claude-sonnet-5", "effort": "medium"})
        self.assertTrue(res["ok"], res)
        roles = self._roles()
        self.assertEqual(roles["coder"]["scope"]["labels"], ["ready", "p1"])
        self.assertEqual(roles["coder"]["effort"], "medium")

    def test_set_invalid_trigger_refused_untouched(self):
        res = dc.ws_set(self.repo, "coder",
                        {"trigger": {"type": "cron"}})   # no schedule
        self.assertFalse(res["ok"])

    def test_set_unknown_role_refused(self):
        self.assertFalse(dc.ws_set(self.repo, "ghost", {"enabled": True})["ok"])

    def test_set_bad_event_name_refused(self):
        res = dc.ws_set(self.repo, "coder",
                        {"trigger": {"type": "event", "on": ["evil.event"]}})
        self.assertFalse(res["ok"])

    # --- prompt (rail) editing ---------------------------------------------
    def test_prompt_set_writes_var_rail(self):
        dc.ws_add(self.repo, "pm", "pm", self.ENGINE)
        res = dc.ws_prompt_set(self.repo, "pm", "my PM conditions:\n- p1 first\n")
        self.assertTrue(res["ok"], res)
        roles = self._roles()
        with open(os.path.join(self.repo, roles["pm"]["prompt"])) as fh:
            self.assertIn("p1 first", fh.read())

    def test_prompt_set_localizes_a_tracked_rail(self):
        # qa's committed rail must not be edited in place (preflight sweep /
        # user content); the write copies to var/ and repoints prompt:.
        dc.ws_add(self.repo, "qa", "qa", self.ENGINE)
        dc.ws_set(self.repo, "qa", {"prompt": ".autonomy/roles/qa.md"})
        res = dc.ws_prompt_set(self.repo, "qa", "custom sign-off rules\n")
        self.assertTrue(res["ok"], res)
        roles = self._roles()
        self.assertTrue(roles["qa"]["prompt"].startswith("var/autonomy/roles/"))
        with open(os.path.join(self.repo, ".autonomy", "roles", "qa.md")) as fh:
            self.assertEqual(fh.read(), "committed qa rail\n")   # untouched

    def test_prompt_get_reads_effective_rail(self):
        dc.ws_add(self.repo, "pm", "pm", self.ENGINE)
        got = dc.ws_prompt_get(self.repo, "pm")
        self.assertTrue(got["ok"], got)
        self.assertIn("PM", got["content"])

    def test_prompt_set_size_capped(self):
        dc.ws_add(self.repo, "pm", "pm", self.ENGINE)
        res = dc.ws_prompt_set(self.repo, "pm", "x" * 200001)
        self.assertFalse(res["ok"])

    def test_ws_set_prompt_escape_refused(self):
        # CP2: a prompt path escaping the repo must refuse at the WRITE
        # boundary, not just at read time.
        for bad in ("../outside.md", "/tmp/x.md"):
            res = dc.ws_set(self.repo, "coder", {"prompt": bad})
            self.assertFalse(res["ok"], bad)

    def test_localize_rolls_back_on_refused_repoint(self):
        # CP2: a refused config write during localization must leave no
        # new rail behind.
        dc.ws_add(self.repo, "qa", "qa", self.ENGINE)
        dc.ws_set(self.repo, "qa", {"prompt": ".autonomy/roles/qa.md"})
        os.unlink(os.path.join(self.repo, ".gitignore"))   # forces write refusal
        res = dc.ws_prompt_set(self.repo, "qa", "new content\n")
        self.assertFalse(res["ok"])
        # the pre-existing scaffolded rail is ROLLED BACK, never left holding
        # the refused content
        with open(os.path.join(self.repo, "var", "autonomy", "roles", "qa.md")) as fh:
            self.assertNotIn("new content", fh.read())

    def test_set_account_round_trips(self):
        # #337 review: 'runs as' saves through the SAME ws_set path #334
        # shipped -- prove the account field lands and clears.
        dc.ws_add(self.repo, "pm", "pm", self.ENGINE)
        res = dc.ws_set(self.repo, "pm", {"account": "local-llm"})
        self.assertTrue(res["ok"], res)
        self.assertEqual(self._roles()["pm"]["account"], "local-llm")
        res = dc.ws_set(self.repo, "pm", {"account": ""})
        self.assertTrue(res["ok"], res)
        self.assertNotIn("account", self._roles()["pm"])


class PipelineSaveTest(unittest.TestCase):
    """P3b (#365): the var-shadow pipeline writer. SD-29/SD-34 discipline --
    validate-before, stage + re-validate + deep-compare, reader-safe atomic
    publish, snapshot rollback; every refusal leaves the shadow byte-identical."""

    def _repo(self, gitignore="var/\n"):
        repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, repo, ignore_errors=True)
        subprocess.run(["git", "init", "-q", repo], check=True)
        if gitignore is not None:
            with open(os.path.join(repo, ".gitignore"), "w") as fh:
                fh.write(gitignore)
        committed = os.path.join(repo, ".autonomy", "pipelines", "flow")
        os.makedirs(committed)
        self.doc = {"name": "flow", "version": 1,
                    "caps": {"max_sessions_per_run": 16},
                    "nodes": [{"id": "a", "type": "pick", "brief_ref": "a.md"},
                              {"id": "b", "type": "check", "brief_ref": "b.md"}],
                    "edges": [{"from": "a", "to": "b", "on": "success"}]}
        with open(os.path.join(committed, "pipeline.json"), "w") as fh:
            json.dump(self.doc, fh)
        for n in ("a", "b"):
            with open(os.path.join(committed, n + ".md"), "w") as fh:
                fh.write("brief %s\n" % n)
        return repo

    def _shadow(self, repo):
        return os.path.join(repo, "var", "autonomy", "pipelines", "flow")

    def test_valid_save_writes_the_shadow(self):
        repo = self._repo()
        doc = dict(self.doc, version=2)
        res = dc.pipeline_save(repo, "flow", doc, {})
        self.assertTrue(res["ok"], res)
        p = os.path.join(self._shadow(repo), "pipeline.json")
        self.assertTrue(os.path.isfile(p))
        with open(p) as fh:
            self.assertEqual(json.load(fh)["version"], 2)
        self.assertTrue(os.path.isfile(os.path.join(self._shadow(repo), "a.md")))

    def test_edited_brief_written_seed_untouched_survives(self):
        repo = self._repo()
        res = dc.pipeline_save(repo, "flow", self.doc, {"a.md": "NEW a\n"})
        self.assertTrue(res["ok"], res)
        with open(os.path.join(self._shadow(repo), "a.md")) as fh:
            self.assertEqual(fh.read(), "NEW a\n")
        self.assertTrue(os.path.isfile(os.path.join(self._shadow(repo), "b.md")))

    def test_invalid_doc_refused_shadow_untouched(self):
        repo = self._repo()
        bad = dict(self.doc)
        bad["nodes"] = [{"id": "a", "type": "no_such_type", "brief_ref": "a.md"}]
        res = dc.pipeline_save(repo, "flow", bad, {})
        self.assertFalse(res["ok"])
        self.assertFalse(os.path.isdir(self._shadow(repo)))

    def test_brief_traversal_refused(self):
        repo = self._repo()
        res = dc.pipeline_save(repo, "flow", self.doc, {"../evil.md": "x"})
        self.assertFalse(res["ok"])
        self.assertIn("sibling basename", res["error"])
        self.assertFalse(os.path.isdir(self._shadow(repo)))

    def test_bad_name_charset_refused(self):
        repo = self._repo()
        res = dc.pipeline_save(repo, "../flow", self.doc, {})
        self.assertFalse(res["ok"])

    def test_gitignore_missing_refused(self):
        repo = self._repo(gitignore=None)     # var/ NOT ignored
        res = dc.pipeline_save(repo, "flow", self.doc, {})
        self.assertFalse(res["ok"])
        self.assertIn("gitignore", res["error"])
        self.assertFalse(os.path.isdir(self._shadow(repo)))

    def test_name_mismatch_refused(self):
        # the doc's own name must match the save target (Codex CP1 #2).
        repo = self._repo()
        res = dc.pipeline_save(repo, "flow", dict(self.doc, name="other"), {})
        self.assertFalse(res["ok"])
        self.assertIn("must match", res["error"])
        self.assertFalse(os.path.isdir(self._shadow(repo)))

    def test_neither_dir_refused_shadow_only_saves(self):
        # D3 (#383) gate lift: a name with NEITHER a committed pack NOR a
        # shadow dir still refuses (create-by-save would bypass
        # pipeline_create's collision + provenance discipline), but a
        # shadow-ONLY dir -- the pipeline_create case -- is now editable.
        repo = self._repo()
        res = dc.pipeline_save(repo, "ghost", dict(self.doc, name="ghost"), {})
        self.assertFalse(res["ok"])
        self.assertIn("no pipeline", res["error"])
        shadow_only = os.path.join(repo, "var", "autonomy", "pipelines", "solo")
        os.makedirs(shadow_only)
        doc = dict(self.doc, name="solo")
        with open(os.path.join(shadow_only, "pipeline.json"), "w") as fh:
            json.dump(doc, fh)
        for n in ("a", "b"):
            with open(os.path.join(shadow_only, n + ".md"), "w") as fh:
                fh.write("brief %s\n" % n)
        res = dc.pipeline_save(repo, "solo", dict(doc, version=2), {})
        self.assertTrue(res["ok"], res)
        with open(os.path.join(shadow_only, "pipeline.json")) as fh:
            self.assertEqual(json.load(fh)["version"], 2)

    def test_invalid_shadow_only_missing_briefs_refuses(self):
        # CP1 regression (D3): an INVALID shadow-only dir (brief file gone)
        # cannot seed itself -- a save that does not POST the missing briefs
        # refuses at the staged re-validate; posting them succeeds.
        repo = self._repo()
        shadow_only = os.path.join(repo, "var", "autonomy", "pipelines", "solo")
        os.makedirs(shadow_only)
        doc = dict(self.doc, name="solo")
        with open(os.path.join(shadow_only, "pipeline.json"), "w") as fh:
            json.dump(doc, fh)               # briefs MISSING -> dir invalid
        res = dc.pipeline_save(repo, "solo", doc, {})
        self.assertFalse(res["ok"])
        self.assertFalse(os.path.isfile(os.path.join(shadow_only, "a.md")))
        res = dc.pipeline_save(repo, "solo", doc,
                               {"a.md": "posted a\n", "b.md": "posted b\n"})
        self.assertTrue(res["ok"], res)
        with open(os.path.join(shadow_only, "a.md")) as fh:
            self.assertEqual(fh.read(), "posted a\n")

    def test_only_referenced_briefs_copied_no_symlinks(self):
        # staging is built from the doc's brief_refs -- never a blind copytree,
        # so stray files and symlinks in the pack are NOT laundered (Codex #7).
        repo = self._repo()
        committed = os.path.join(repo, ".autonomy", "pipelines", "flow")
        with open(os.path.join(committed, "extra.txt"), "w") as fh:
            fh.write("junk\n")
        os.symlink("/etc/passwd", os.path.join(committed, "evil.md"))
        self.assertTrue(dc.pipeline_save(repo, "flow", self.doc, {})["ok"])
        shadow = self._shadow(repo)
        self.assertFalse(os.path.exists(os.path.join(shadow, "extra.txt")))
        self.assertFalse(os.path.lexists(os.path.join(shadow, "evil.md")))
        self.assertEqual(sorted(os.listdir(shadow)),
                         ["a.md", "b.md", "pipeline.json"])

    def test_narrow_gitignore_refuses_pipeline_shadow(self):
        # a .gitignore ignoring ONLY the config file (not var/) leaves the
        # pipeline shadow UNPROTECTED -> preflight's `stash -u` would sweep it,
        # so the write must refuse (fail-safe). Confirms the directory pathspec
        # passed to git check-ignore is the RIGHT check for the pipeline shadow
        # (PR #366 review NITPICK; empirically verified against check-ignore).
        repo = self._repo(gitignore="var/autonomy/config.yaml\n")
        res = dc.pipeline_save(repo, "flow", dict(self.doc, version=2), {})
        self.assertFalse(res["ok"])
        self.assertIn("gitignore", res["error"])
        self.assertFalse(os.path.isdir(self._shadow(repo)))

    def test_symlinked_shadow_refused(self):
        # a symlinked shadow path must be refused, never written through (Codex CP2).
        repo = self._repo()
        outside = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, outside, ignore_errors=True)
        pdir = os.path.join(repo, "var", "autonomy", "pipelines")
        os.makedirs(pdir)
        os.symlink(outside, os.path.join(pdir, "flow"))
        res = dc.pipeline_save(repo, "flow", dict(self.doc, version=2), {})
        self.assertFalse(res["ok"])
        self.assertIn("clean directory", res["error"])
        self.assertEqual(os.listdir(outside), [])    # nothing written through it

    def test_invalid_shadow_not_used_as_seed(self):
        # a present-but-invalid shadow is NEVER trusted as a brief seed (no
        # laundering; Codex CP1 #6/#7): untouched briefs reset to committed.
        repo = self._repo()
        self.assertTrue(dc.pipeline_save(repo, "flow", dict(self.doc, version=2),
                                         {"a.md": "shadow a\n"})["ok"])
        shadow = self._shadow(repo)
        with open(os.path.join(shadow, "pipeline.json"), "w") as fh:
            fh.write("{ not json")                    # shadow now INVALID
        self.assertTrue(dc.pipeline_save(repo, "flow",
                                         dict(self.doc, version=3), {})["ok"])
        with open(os.path.join(shadow, "a.md")) as fh:
            self.assertEqual(fh.read(), "brief a\n")  # committed's, not laundered

    def test_install_failure_rolls_back_byte_identical(self):
        # fault injection on the atomic pipeline.json publish -> the prior
        # shadow is restored byte-identical (Codex CP1 #4).
        from unittest import mock
        repo = self._repo()
        self.assertTrue(dc.pipeline_save(repo, "flow",
                                         dict(self.doc, version=5), {})["ok"])
        p = os.path.join(self._shadow(repo), "pipeline.json")
        with open(p, "rb") as fh:
            before = fh.read()
        real = os.replace
        def boom(src, dst):
            if str(dst).endswith("pipeline.json"):
                raise OSError("disk full")
            return real(src, dst)
        with mock.patch("dashboard_control.os.replace", boom):
            res = dc.pipeline_save(repo, "flow", dict(self.doc, version=6), {})
        self.assertFalse(res["ok"])
        with open(p, "rb") as fh:
            self.assertEqual(fh.read(), before)       # rolled back byte-identical

    def test_oversize_doc_refused(self):
        # the serialized pipeline.json is capped too, not just briefs (Codex #9).
        repo = self._repo()
        huge = dict(self.doc)
        huge["nodes"] = self.doc["nodes"] + [
            {"id": "n%d" % i, "type": "pick", "brief_ref": "a.md"}
            for i in range(20000)]                    # serialized > 200 KiB
        res = dc.pipeline_save(repo, "flow", huge, {})
        self.assertFalse(res["ok"])
        self.assertIn("exceeds", res["error"])

    def test_refusal_over_existing_shadow_leaves_it_byte_identical(self):
        repo = self._repo()
        self.assertTrue(dc.pipeline_save(repo, "flow",
                                         dict(self.doc, version=5), {})["ok"])
        p = os.path.join(self._shadow(repo), "pipeline.json")
        with open(p, "rb") as fh:
            before = fh.read()
        bad = {"name": "flow", "version": 6, "nodes": "not a list"}
        res = dc.pipeline_save(repo, "flow", bad, {})
        self.assertFalse(res["ok"])
        with open(p, "rb") as fh:
            self.assertEqual(fh.read(), before)       # byte-identical

    def test_second_save_over_shadow_seeds_from_shadow_not_committed(self):
        repo = self._repo()
        self.assertTrue(dc.pipeline_save(repo, "flow", dict(self.doc, version=2),
                                         {"a.md": "shadow a\n"})["ok"])
        self.assertTrue(dc.pipeline_save(repo, "flow", dict(self.doc, version=3),
                                         {})["ok"])
        with open(os.path.join(self._shadow(repo), "a.md")) as fh:
            self.assertEqual(fh.read(), "shadow a\n")  # from shadow, not committed


class TriggerSaveTest(unittest.TestCase):
    """Phase D2 (#383): the SD-29 writer over the SD-34 trigger FILE shadow
    var/autonomy/triggers/<name>.json. Validate-before (validate_trigger,
    name==stem), gitignore guard, allow_nan canonical serialize + re-parse
    compare, symlink-refusing atomic install; every refusal leaves the
    shadow byte-identical. Binding/params problems WARN on success, never
    refuse (a save must be able to DISABLE a trigger whose pipeline
    vanished)."""

    def _repo(self, gitignore="var/\n", with_pipeline=True):
        repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, repo, ignore_errors=True)
        subprocess.run(["git", "init", "-q", repo], check=True)
        if gitignore is not None:
            with open(os.path.join(repo, ".gitignore"), "w") as fh:
                fh.write(gitignore)
        if with_pipeline:
            pdir = os.path.join(repo, ".autonomy", "pipelines", "flow")
            os.makedirs(pdir)
            doc = {"name": "flow", "version": 1,
                   "caps": {"max_sessions_per_run": 4},
                   "params": [{"name": "q", "type": "string",
                               "required": True}],
                   "nodes": [{"id": "a", "type": "pick",
                              "brief_ref": "a.md"}],
                   "edges": []}
            with open(os.path.join(pdir, "pipeline.json"), "w") as fh:
                json.dump(doc, fh)
            with open(os.path.join(pdir, "a.md"), "w") as fh:
                fh.write("work ${params.q}\n")
        return repo

    def _trig(self, **over):
        t = {"name": "adhoc", "pipeline": "flow",
             "params": {"q": "saved"},
             "firing": {"mode": "manual"},
             "concurrency": {"policy": "skip", "max": 1},
             "enabled": True}
        t.update(over)
        return t

    def _shadow(self, repo, name="adhoc"):
        return os.path.join(repo, "var", "autonomy", "triggers",
                            "%s.json" % name)

    def test_create_writes_canonical_shadow(self):
        repo = self._repo()
        res = dc.trigger_save(repo, "adhoc", self._trig())
        self.assertTrue(res["ok"], res)
        with open(self._shadow(repo)) as fh:
            raw = fh.read()
        self.assertEqual(json.loads(raw), self._trig())
        self.assertEqual(
            raw, json.dumps(self._trig(), indent=2, sort_keys=True) + "\n")
        self.assertNotIn("WARNING", res["message"])

    def test_overwrite_replaces_content(self):
        repo = self._repo()
        self.assertTrue(dc.trigger_save(repo, "adhoc", self._trig())["ok"])
        res = dc.trigger_save(repo, "adhoc", self._trig(enabled=False))
        self.assertTrue(res["ok"], res)
        with open(self._shadow(repo)) as fh:
            self.assertFalse(json.load(fh)["enabled"])

    def _refused_leaves_shadow(self, repo, name, trig, needle):
        before = None
        if os.path.isfile(self._shadow(repo, name)):
            with open(self._shadow(repo, name), "rb") as fh:
                before = fh.read()
        res = dc.trigger_save(repo, name, trig)
        self.assertFalse(res.get("ok"), res)
        self.assertIn(needle, res["error"])
        if before is None:
            self.assertFalse(os.path.exists(self._shadow(repo, name)))
        else:
            with open(self._shadow(repo, name), "rb") as fh:
                self.assertEqual(fh.read(), before)

    def test_bad_name_charset_refused(self):
        repo = self._repo()
        self._refused_leaves_shadow(repo, "../x", self._trig(), "charset")

    def test_non_dict_refused(self):
        repo = self._repo()
        self._refused_leaves_shadow(repo, "adhoc", ["nope"], "object")

    def test_validator_errors_refuse(self):
        repo = self._repo()
        # unknown key (the shim-internal events_csv can never be written)
        t = self._trig()
        t["firing"] = {"mode": "event", "event": "pr.opened",
                       "events_csv": "pr.opened"}
        self._refused_leaves_shadow(repo, "adhoc", t, "unknown key")
        # name != stem
        self._refused_leaves_shadow(repo, "other", self._trig(), "stem")
        # explicit empty run_windows
        self._refused_leaves_shadow(repo, "adhoc",
                                    self._trig(run_windows=[]),
                                    "run_windows")

    def test_gitignore_missing_refused(self):
        repo = self._repo(gitignore=None)
        self._refused_leaves_shadow(repo, "adhoc", self._trig(),
                                    "gitignore")

    def test_symlinked_shadow_refused(self):
        repo = self._repo()
        outside = os.path.join(repo, "outside.json")
        with open(outside, "w") as fh:
            fh.write("{}")
        os.makedirs(os.path.dirname(self._shadow(repo)))
        os.symlink(outside, self._shadow(repo))
        res = dc.trigger_save(repo, "adhoc", self._trig())
        self.assertFalse(res.get("ok"))
        with open(outside) as fh:
            self.assertEqual(fh.read(), "{}")     # never written through

    def test_tmp_symlink_squatter_cannot_redirect(self):
        repo = self._repo()
        outside = os.path.join(repo, "outside.json")
        with open(outside, "w") as fh:
            fh.write("untouched")
        os.makedirs(os.path.dirname(self._shadow(repo)))
        os.symlink(outside, self._shadow(repo) + ".tmp")
        res = dc.trigger_save(repo, "adhoc", self._trig())
        self.assertTrue(res["ok"], res)           # squatter replaced
        with open(outside) as fh:
            self.assertEqual(fh.read(), "untouched")
        with open(self._shadow(repo)) as fh:
            self.assertEqual(json.load(fh), self._trig())

    def test_byte_cap_refused(self):
        repo = self._repo()
        t = self._trig(params={"q": "x" * 70000})
        self._refused_leaves_shadow(repo, "adhoc", t, "bytes")

    def test_nan_refused(self):
        repo = self._repo()
        t = self._trig(params={"q": float("inf")})
        self._refused_leaves_shadow(repo, "adhoc", t, "JSON")

    def test_missing_pipeline_warns_but_saves(self):
        repo = self._repo(with_pipeline=False)
        res = dc.trigger_save(repo, "adhoc", self._trig())
        self.assertTrue(res["ok"], res)
        self.assertIn("WARNING", res["message"])
        self.assertIn("flow", res["message"])

    def test_unresolvable_params_warn_but_save(self):
        repo = self._repo()
        res = dc.trigger_save(repo, "adhoc", self._trig(params={}))
        self.assertTrue(res["ok"], res)           # required q unset
        self.assertIn("WARNING", res["message"])


class TriggerCtlPlanParamsTest(unittest.TestCase):
    """Phase D2 (#383): the fire plan gains an optional params payload --
    non-empty params become the marker BODY ({'write', 'content'}); empty
    keeps the D1 {'touch'} empty-marker byte-parity."""

    def test_fire_with_params_plans_a_write(self):
        p = dc.trigger_ctl_plan("/w/tree", "trigger_fire", "adhoc",
                                fire_params={"q": "x", "n": 3})
        self.assertEqual(p["write"],
                         "/w/tree/var/trigger-ctl/fire/adhoc")
        self.assertEqual(p["content"],
                         json.dumps({"q": "x", "n": 3}, sort_keys=True,
                                    allow_nan=False))

    def test_fire_without_params_stays_a_touch(self):
        for empty in (None, {}):
            p = dc.trigger_ctl_plan("/w/tree", "trigger_fire", "adhoc",
                                    fire_params=empty)
            self.assertEqual(p["touch"],
                             "/w/tree/var/trigger-ctl/fire/adhoc")

    def test_params_on_non_fire_actions_refused(self):
        for act in ("trigger_stop", "trigger_resume"):
            p = dc.trigger_ctl_plan("/w/tree", act, "adhoc",
                                    fire_params={"q": "x"})
            self.assertIn("error", p)

    def test_nan_params_refused(self):
        p = dc.trigger_ctl_plan("/w/tree", "trigger_fire", "adhoc",
                                fire_params={"q": float("nan")})
        self.assertIn("error", p)


class PipelineCreateTest(unittest.TestCase):
    """Phase D3 (#383): pipeline create-from-blank / clone into the SD-34
    var shadow + the provenance sidecar. SD-29/SD-37 discipline via the
    mkdir-CLAIM install shape (claim -> stage -> provenance -> rename over
    our own empty claim); every refusal leaves the tree byte-identical and
    every dashboard-created pipeline HAS a sidecar (binary end-state)."""

    def _repo(self, gitignore="var/\n"):
        repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, repo, ignore_errors=True)
        subprocess.run(["git", "init", "-q", repo], check=True)
        if gitignore is not None:
            with open(os.path.join(repo, ".gitignore"), "w") as fh:
                fh.write(gitignore)
        committed = os.path.join(repo, ".autonomy", "pipelines", "flow")
        os.makedirs(committed)
        self.doc = {"name": "flow", "version": 3,
                    "caps": {"max_sessions_per_run": 16},
                    "nodes": [{"id": "a", "type": "pick", "brief_ref": "a.md"},
                              {"id": "b", "type": "check", "brief_ref": "b.md"}],
                    "edges": [{"from": "a", "to": "b", "on": "success"}]}
        with open(os.path.join(committed, "pipeline.json"), "w") as fh:
            json.dump(self.doc, fh)
        for n in ("a", "b"):
            with open(os.path.join(committed, n + ".md"), "w") as fh:
                fh.write("brief %s\n" % n)
        return repo

    def _shadow(self, repo, name):
        return os.path.join(repo, "var", "autonomy", "pipelines", name)

    def _sidecar(self, repo, name):
        return self._shadow(repo, name) + ".provenance.json"

    def _tree(self, repo):
        """Full recursive snapshot {relpath: kind/bytes} for byte-identical
        refusal assertions (symlinks recorded as their target)."""
        snap = {}
        for root, dirs, files in os.walk(repo):
            if ".git" in dirs:
                dirs.remove(".git")
            for d in dirs:
                p = os.path.join(root, d)
                rel = os.path.relpath(p, repo)
                snap[rel] = ("LINK", os.readlink(p)) if os.path.islink(p) \
                    else "DIR"
            for f in files:
                p = os.path.join(root, f)
                rel = os.path.relpath(p, repo)
                if os.path.islink(p):
                    snap[rel] = ("LINK", os.readlink(p))
                else:
                    with open(p, "rb") as fh:
                        snap[rel] = fh.read()
        return snap

    # -- blank ------------------------------------------------------------

    def test_blank_create_dir_doc_brief_provenance(self):
        import pipeline as pl
        repo = self._repo()
        res = dc.pipeline_create(repo, "fresh")
        self.assertTrue(res["ok"], res)
        shadow = self._shadow(repo, "fresh")
        doc = pl.load_doc(os.path.join(shadow, "pipeline.json"))
        self.assertEqual(pl.validate_doc(doc, shadow), [])   # starter PIN
        self.assertEqual(doc["name"], "fresh")
        self.assertEqual(len(doc["nodes"]), 1)
        ref = doc["nodes"][0]["brief_ref"]
        self.assertTrue(os.path.isfile(os.path.join(shadow, ref)))
        with open(self._sidecar(repo, "fresh")) as fh:
            prov = json.load(fh)
        self.assertEqual(prov["created"], "blank")
        self.assertIsInstance(prov["at"], int)
        self.assertNotIn("source", prov)

    def test_blank_brief_prose_survives_substitution(self):
        # brief TEXT is substituted at prepare time -- the starter's
        # ${...} prose must be $${-escaped or the first run would refuse
        # (the Phase C footer lesson). Pin it against the real engine.
        import pipeline as pl
        out = pl.substitute(dc._BLANK_BRIEF, {})
        self.assertIn("${params.<name>}", out)

    def test_blank_create_is_dispatch_resolvable(self):
        # a trigger can bind the created name (the D2 flow) -- dispatch's
        # own resolver loads the shadow-only doc.
        import pipeline as pl
        repo = self._repo()
        self.assertTrue(dc.pipeline_create(repo, "fresh")["ok"])
        pdir = pl.effective_pipeline_dir(repo, "fresh")
        self.assertEqual(pdir, self._shadow(repo, "fresh"))
        doc = pl.load_doc(os.path.join(pdir, "pipeline.json"))
        self.assertEqual(pl.validate_doc(doc, pdir), [])

    # -- clone ------------------------------------------------------------

    def test_clone_copies_briefs_rewrites_name_keeps_version(self):
        repo = self._repo()
        res = dc.pipeline_create(repo, "flow2", source="flow")
        self.assertTrue(res["ok"], res)
        shadow = self._shadow(repo, "flow2")
        with open(os.path.join(shadow, "pipeline.json")) as fh:
            doc = json.load(fh)
        self.assertEqual(doc["name"], "flow2")
        self.assertEqual(doc["version"], 3)          # lineage kept
        self.assertEqual(doc["edges"], self.doc["edges"])
        for n in ("a.md", "b.md"):
            with open(os.path.join(shadow, n)) as fh:
                self.assertEqual(fh.read(), "brief %s\n" % n[0])
        with open(self._sidecar(repo, "flow2")) as fh:
            prov = json.load(fh)
        self.assertEqual(prov["created"], "clone")
        self.assertEqual(prov["source"], "flow")
        self.assertEqual(prov["source_version"], 3)

    def test_clone_fingerprint_is_the_shared_content_rule(self):
        # ONE fingerprint rule (pipeline.content_fingerprint: doc + briefs)
        # for the writer and the gallery reader -- recomputing over the
        # installed shadow must reproduce the recorded value exactly.
        import pipeline as pl
        repo = self._repo()
        self.assertTrue(dc.pipeline_create(repo, "flow2", source="flow")["ok"])
        shadow = self._shadow(repo, "flow2")
        doc = pl.load_doc(os.path.join(shadow, "pipeline.json"))
        with open(self._sidecar(repo, "flow2")) as fh:
            self.assertEqual(json.load(fh)["fingerprint"],
                             pl.content_fingerprint(doc, shadow))

    def test_bool_source_version_written_as_none(self):
        # `version: true` validates today (bool is an int subclass,
        # verified empirically -- the PREMISE assert below keeps this test
        # honest if the validator ever tightens); the reader's exact
        # schema rejects bools -- the writer coerces to the honest None so
        # the sidecar is never dropped whole (Codex CP2). Unconditional
        # asserts per review round 1: a guarded assert could pass vacuously.
        import pipeline as pl
        repo = self._repo()
        committed = os.path.join(repo, ".autonomy", "pipelines", "flow")
        with open(os.path.join(committed, "pipeline.json"), "w") as fh:
            json.dump(dict(self.doc, version=True), fh)
        self.assertEqual(pl.validate_doc(dict(self.doc, version=True),
                                         committed), [])   # premise pin
        res = dc.pipeline_create(repo, "flow2", source="flow")
        self.assertTrue(res["ok"], res)
        with open(self._sidecar(repo, "flow2")) as fh:
            self.assertIsNone(json.load(fh)["source_version"])

    def test_clone_of_effective_shadow_doc(self):
        # cloning a locally-edited pipeline clones what the operator SEES
        # (the effective doc = the shadow), not the stale committed pack.
        repo = self._repo()
        self.assertTrue(dc.pipeline_save(repo, "flow", dict(self.doc, version=9),
                                         {"a.md": "edited a\n"})["ok"])
        self.assertTrue(dc.pipeline_create(repo, "flow2", source="flow")["ok"])
        shadow = self._shadow(repo, "flow2")
        with open(os.path.join(shadow, "pipeline.json")) as fh:
            self.assertEqual(json.load(fh)["version"], 9)
        with open(os.path.join(shadow, "a.md")) as fh:
            self.assertEqual(fh.read(), "edited a\n")

    # -- refusals (each leaves the tree byte-identical) ---------------------

    def _refused(self, repo, name, source=None, needle=None):
        before = self._tree(repo)
        res = dc.pipeline_create(repo, name, source=source)
        self.assertFalse(res["ok"], res)
        if needle:
            self.assertIn(needle, res["error"])
        self.assertEqual(self._tree(repo), before)   # byte-identical
        return res

    def test_charset_name_refused(self):
        self._refused(self._repo(), "../evil")

    def test_reserved_suffix_refused(self):
        repo = self._repo()
        for nm in ("x.staging", "x.bak", "x.provenance.json", "x.trash"):
            self._refused(repo, nm, needle="reserved")

    def test_source_equals_name_refused(self):
        self._refused(self._repo(), "flow2", source="flow2",
                      needle="different name")

    def test_empty_source_refused_not_blank(self):
        # a malformed clone request must refuse, never degrade to a blank
        # create (CP1).
        self._refused(self._repo(), "flow2", source="")

    def test_missing_source_refused(self):
        self._refused(self._repo(), "flow2", source="nosuch")

    def test_invalid_source_refused_no_laundering(self):
        repo = self._repo()
        bad = os.path.join(repo, ".autonomy", "pipelines", "bad")
        os.makedirs(bad)
        with open(os.path.join(bad, "pipeline.json"), "w") as fh:
            fh.write("{ not json")
        self._refused(repo, "bad2", source="bad")

    def test_symlinked_source_brief_refuses(self):
        # a source whose brief is a symlink cannot clone: staging copies
        # regular files only, the staged re-validate flags the missing brief
        # (never silently drops it, never follows the link).
        repo = self._repo()
        committed = os.path.join(repo, ".autonomy", "pipelines", "flow")
        os.remove(os.path.join(committed, "b.md"))
        os.symlink("/etc/passwd", os.path.join(committed, "b.md"))
        self._refused(repo, "flow2", source="flow")

    def test_collision_committed_dir_refused(self):
        self._refused(self._repo(), "flow", needle="exists")

    def test_collision_committed_file_squatter_refused(self):
        repo = self._repo()
        with open(os.path.join(repo, ".autonomy", "pipelines", "squat"),
                  "w") as fh:
            fh.write("junk")
        self._refused(repo, "squat", needle="exists")

    def test_collision_shadow_refused(self):
        repo = self._repo()
        vroot = os.path.join(repo, "var", "autonomy", "pipelines")
        os.makedirs(os.path.join(vroot, "asdir"))
        with open(os.path.join(vroot, "asfile"), "w") as fh:
            fh.write("junk")
        os.symlink("/nonexistent", os.path.join(vroot, "aslink"))
        for nm in ("asdir", "asfile", "aslink"):
            self._refused(repo, nm, needle="exists")

    def test_gitignore_missing_refused(self):
        self._refused(self._repo(gitignore=None), "fresh", needle="gitignore")

    def test_sidecar_squatter_refused(self):
        repo = self._repo()
        vroot = os.path.join(repo, "var", "autonomy", "pipelines")
        os.makedirs(os.path.join(vroot, "d1.provenance.json"))
        self._refused(repo, "d1")
        os.symlink("/nonexistent", os.path.join(vroot, "d2.provenance.json"))
        self._refused(repo, "d2")

    def test_orphan_sidecar_overwritten(self):
        # a REGULAR-FILE sidecar orphaned by a hand-removed dir must not
        # brick the name forever -- the new create overwrites it.
        repo = self._repo()
        vroot = os.path.join(repo, "var", "autonomy", "pipelines")
        os.makedirs(vroot)
        with open(os.path.join(vroot, "fresh.provenance.json"), "w") as fh:
            fh.write('{"created": "clone", "stale": true}')
        self.assertTrue(dc.pipeline_create(repo, "fresh")["ok"])
        with open(self._sidecar(repo, "fresh")) as fh:
            prov = json.load(fh)
        self.assertEqual(prov["created"], "blank")
        self.assertNotIn("stale", prov)

    def test_provenance_install_failure_rolls_back(self):
        # a directory squatting the sidecar's .tmp path makes the provenance
        # install fail -> the WHOLE create rolls back (binary end-state,
        # no unprovenanced dashboard-created dir survives).
        repo = self._repo()
        vroot = os.path.join(repo, "var", "autonomy", "pipelines")
        os.makedirs(os.path.join(vroot, "fresh.provenance.json.tmp"))
        before = self._tree(repo)
        res = dc.pipeline_create(repo, "fresh")
        self.assertFalse(res["ok"], res)
        self.assertEqual(self._tree(repo), before)


class _ShadowLifecycleFixture(unittest.TestCase):
    """Shared fixture for the #388 shadow-lifecycle writers: a repo with a
    committed pipeline `flow`, a parseable config, and helpers to plant
    state files (in-flight runs), trigger files and trigger-ctl markers."""

    def _repo(self, config="roles: {}\n"):
        repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, repo, ignore_errors=True)
        subprocess.run(["git", "init", "-q", repo], check=True)
        with open(os.path.join(repo, ".gitignore"), "w") as fh:
            fh.write("var/\n")
        os.makedirs(os.path.join(repo, ".autonomy"))
        if config is not None:
            with open(os.path.join(repo, ".autonomy", "config.yaml"),
                      "w") as fh:
                fh.write(config)
        committed = os.path.join(repo, ".autonomy", "pipelines", "flow")
        os.makedirs(committed)
        doc = {"name": "flow", "version": 1,
               "caps": {"max_sessions_per_run": 4},
               "nodes": [{"id": "a", "type": "pick", "brief_ref": "a.md"}],
               "edges": []}
        with open(os.path.join(committed, "pipeline.json"), "w") as fh:
            json.dump(doc, fh)
        with open(os.path.join(committed, "a.md"), "w") as fh:
            fh.write("brief a\n")
        return repo

    def _trig_shadow(self, repo, name="adhoc"):
        return os.path.join(repo, "var", "autonomy", "triggers",
                            "%s.json" % name)

    def _pipe_shadow(self, repo, name):
        return os.path.join(repo, "var", "autonomy", "pipelines", name)

    def _write_trigger(self, repo, name="adhoc", where="var",
                       pipeline="flow", raw=None):
        d = os.path.join(repo, "var", "autonomy", "triggers") \
            if where == "var" else os.path.join(repo, ".autonomy", "triggers")
        os.makedirs(d, exist_ok=True)
        p = os.path.join(d, "%s.json" % name)
        if raw is not None:
            with open(p, "w") as fh:
                fh.write(raw)
            return p
        with open(p, "w") as fh:
            json.dump({"name": name, "pipeline": pipeline,
                       "firing": {"mode": "manual"}}, fh)
        return p

    def _state(self, repo, base, content="valid", pipeline="flow"):
        d = os.path.join(repo, "var", "autonomy-logs")
        os.makedirs(d, exist_ok=True)
        p = os.path.join(d, ".pipeline-run-%s.json" % base)
        with open(p, "w") as fh:
            if content == "valid":
                json.dump({"fmt": 2, "status": "in_progress",
                           "doc": {"name": pipeline}}, fh)
            else:
                fh.write(content)
        return p

    def _marker(self, repo, kind, basename):
        d = os.path.join(repo, "var", "trigger-ctl", kind)
        os.makedirs(d, exist_ok=True)
        p = os.path.join(d, basename)
        with open(p, "w") as fh:
            fh.write("")
        return p

    def _tree(self, repo):
        snap = {}
        for root, dirs, files in os.walk(repo):
            if ".git" in dirs:
                dirs.remove(".git")
            for d in dirs:
                p = os.path.join(root, d)
                rel = os.path.relpath(p, repo)
                snap[rel] = ("LINK", os.readlink(p)) if os.path.islink(p) \
                    else "DIR"
            for f in files:
                p = os.path.join(root, f)
                rel = os.path.relpath(p, repo)
                if os.path.islink(p):
                    snap[rel] = ("LINK", os.readlink(p))
                else:
                    with open(p, "rb") as fh:
                        snap[rel] = fh.read()
        return snap


class TriggerDeleteTest(_ShadowLifecycleFixture):
    """#388: trigger_delete removes ONLY the var-shadow trigger file;
    committed triggers refuse (SD-34); in-flight tokens and pending
    fire/queued markers refuse fail-closed; every refusal leaves the tree
    byte-identical."""

    def _refused(self, repo, name, needle):
        before = self._tree(repo)
        res = dc.trigger_delete(repo, name)
        self.assertFalse(res.get("ok"), res)
        self.assertIn(needle, res["error"])
        self.assertEqual(self._tree(repo), before)
        return res

    def test_charset_refused(self):
        self._refused(self._repo(), "../evil", "charset")

    def test_absent_shadow_with_committed_refuses_sd34(self):
        repo = self._repo()
        self._write_trigger(repo, where="committed")
        self._refused(repo, "adhoc", "committed")

    def test_absent_shadow_nothing_refuses(self):
        self._refused(self._repo(), "adhoc", "no trigger shadow")

    def test_symlink_shadow_refuses(self):
        repo = self._repo()
        os.makedirs(os.path.dirname(self._trig_shadow(repo)))
        os.symlink("/nonexistent", self._trig_shadow(repo))
        self._refused(repo, "adhoc", "not a clean file")

    def test_dir_shadow_refuses(self):
        repo = self._repo()
        os.makedirs(self._trig_shadow(repo))
        self._refused(repo, "adhoc", "not a clean file")

    def test_inflight_exact_token_refuses(self):
        repo = self._repo()
        self._write_trigger(repo)
        self._state(repo, "adhoc")
        self._refused(repo, "adhoc", "in-flight")

    def test_inflight_slot_token_refuses(self):
        repo = self._repo()
        self._write_trigger(repo)
        self._state(repo, "adhoc@2")
        self._refused(repo, "adhoc", "in-flight")

    def test_inflight_lane_token_refuses(self):
        repo = self._repo()
        self._write_trigger(repo)
        self._state(repo, "adhoc--beta")
        self._refused(repo, "adhoc", "in-flight")

    def test_inflight_child_token_refuses(self):
        repo = self._repo()
        self._write_trigger(repo)
        self._state(repo, "adhoc.c0.qa")
        self._refused(repo, "adhoc", "in-flight")

    def test_inflight_unreadable_state_still_matches_by_filename(self):
        # attribution is by FILENAME -- corrupt content cannot hide a run
        repo = self._repo()
        self._write_trigger(repo)
        self._state(repo, "adhoc@1", content="{corrupt")
        self._refused(repo, "adhoc", "in-flight")

    def test_unrelated_tokens_do_not_block(self):
        repo = self._repo()
        self._write_trigger(repo)
        for base in ("adhoc2", "adhocx", "adhoc.charlie", "other--adhoc"):
            self._state(repo, base)
        # reserved sidecar suffixes share the glob namespace and can
        # outlive their run -- never evidence of an in-flight run
        self._state(repo, "adhoc.outputs", content='{"x": 1}')
        self._state(repo, "adhoc.work.outputs", content='{"x": 1}')
        self._state(repo, "adhoc.c0.qa.outcome", content='{"x": 1}')
        res = dc.trigger_delete(repo, "adhoc")
        self.assertTrue(res["ok"], res)
        self.assertFalse(os.path.exists(self._trig_shadow(repo)))

    def test_fire_marker_refuses(self):
        repo = self._repo()
        self._write_trigger(repo)
        self._marker(repo, "fire", "adhoc")
        self._refused(repo, "adhoc", "fire")

    def test_queued_lane_marker_refuses(self):
        repo = self._repo()
        self._write_trigger(repo)
        self._marker(repo, "queued", "adhoc--beta")
        self._refused(repo, "adhoc", "queued")

    def test_stop_and_backoff_markers_do_not_block(self):
        repo = self._repo()
        self._write_trigger(repo)
        self._marker(repo, "stop", "adhoc")
        self._marker(repo, "backoff", "adhoc")
        self.assertTrue(dc.trigger_delete(repo, "adhoc")["ok"])

    def test_other_triggers_markers_do_not_block(self):
        repo = self._repo()
        self._write_trigger(repo)
        self._marker(repo, "fire", "other")
        self.assertTrue(dc.trigger_delete(repo, "adhoc")["ok"])

    def test_unlistable_logs_dir_refuses(self):
        repo = self._repo()
        self._write_trigger(repo)
        d = os.path.join(repo, "var", "autonomy-logs")
        os.makedirs(d)
        os.chmod(d, 0)
        self.addCleanup(os.chmod, d, 0o755)
        res = dc.trigger_delete(repo, "adhoc")
        self.assertFalse(res.get("ok"), res)
        self.assertIn("cannot", res["error"])

    def test_success_plain_delete(self):
        repo = self._repo()
        self._write_trigger(repo)
        res = dc.trigger_delete(repo, "adhoc")
        self.assertTrue(res["ok"], res)
        self.assertFalse(os.path.exists(self._trig_shadow(repo)))
        self.assertIn("removed", res["message"])

    def test_success_message_committed_resurfaces(self):
        repo = self._repo()
        self._write_trigger(repo, where="committed")
        self._write_trigger(repo, where="var")
        res = dc.trigger_delete(repo, "adhoc")
        self.assertTrue(res["ok"], res)
        self.assertIn("committed trigger resurfaces", res["message"])
        # the committed twin is untouched
        self.assertTrue(os.path.isfile(os.path.join(
            repo, ".autonomy", "triggers", "adhoc.json")))

    def test_success_message_shim_resurfaces(self):
        # a materialised shim's native file: the role of the same name
        # re-shims -- the exec-semantics flip runs BACKWARD; the message
        # names it (the page confirm mirrors it).
        repo = self._repo(config="roles:\n  adhoc:\n    enabled: true\n")
        self._write_trigger(repo, where="var")
        res = dc.trigger_delete(repo, "adhoc")
        self.assertTrue(res["ok"], res)
        self.assertIn("role shim resurfaces", res["message"])


class PipelineDeleteTest(_ShadowLifecycleFixture):
    """#388: pipeline_delete removes ONLY the var-shadow pipeline dir +
    its provenance sidecar via an atomic rename-detach into the
    delete-owned `.trash` scratch namespace. Committed templates refuse
    (SD-34); in-flight runs (content-attributed, unprovable state
    refuses) and pending markers of bound/unattributable triggers refuse
    fail-closed; every refusal leaves the tree byte-identical."""

    def _shadow_flow(self, repo, name="flow", doc_name=None):
        """Plant a shadow dir for `name` (default: shadows the committed
        `flow` -- the reset case)."""
        shadow = self._pipe_shadow(repo, name)
        os.makedirs(shadow)
        with open(os.path.join(shadow, "pipeline.json"), "w") as fh:
            json.dump({"name": doc_name or name, "version": 2,
                       "caps": {"max_sessions_per_run": 4},
                       "nodes": [{"id": "a", "type": "pick",
                                  "brief_ref": "a.md"}], "edges": []}, fh)
        with open(os.path.join(shadow, "a.md"), "w") as fh:
            fh.write("edited brief\n")
        return shadow

    def _refused(self, repo, name, needle):
        before = self._tree(repo)
        res = dc.pipeline_delete(repo, name)
        self.assertFalse(res.get("ok"), res)
        self.assertIn(needle, res["error"])
        self.assertEqual(self._tree(repo), before)
        return res

    def test_charset_refused(self):
        self._refused(self._repo(), "../evil", "charset")

    def test_absent_shadow_with_committed_refuses_sd34(self):
        self._refused(self._repo(), "flow", "committed")

    def test_absent_both_refuses(self):
        self._refused(self._repo(), "ghost", "no pipeline shadow")

    def test_symlink_shadow_refuses(self):
        repo = self._repo()
        vroot = os.path.join(repo, "var", "autonomy", "pipelines")
        os.makedirs(vroot)
        os.symlink("/nonexistent", os.path.join(vroot, "flow"))
        self._refused(repo, "flow", "not a clean directory")

    def test_file_shadow_refuses(self):
        repo = self._repo()
        vroot = os.path.join(repo, "var", "autonomy", "pipelines")
        os.makedirs(vroot)
        with open(os.path.join(vroot, "flow"), "w") as fh:
            fh.write("junk")
        self._refused(repo, "flow", "not a clean directory")

    def test_inflight_run_of_this_pipeline_refuses(self):
        repo = self._repo()
        self._shadow_flow(repo)
        self._state(repo, "sometrigger", pipeline="flow")
        self._refused(repo, "flow", "in-flight")

    def test_inflight_unreadable_state_refuses(self):
        repo = self._repo()
        self._shadow_flow(repo)
        self._state(repo, "sometrigger", content="{corrupt")
        self._refused(repo, "flow", "cannot prove")

    def test_inflight_nondict_and_docless_state_refuse(self):
        repo = self._repo()
        self._shadow_flow(repo)
        self._state(repo, "t1", content="[1, 2]")
        self._refused(repo, "flow", "cannot prove")
        os.unlink(os.path.join(repo, "var", "autonomy-logs",
                               ".pipeline-run-t1.json"))
        self._state(repo, "t2", content='{"fmt": 2, "status": "x"}')
        self._refused(repo, "flow", "cannot prove")

    def test_unrelated_inflight_doc_does_not_block(self):
        repo = self._repo()
        self._shadow_flow(repo)
        self._state(repo, "sometrigger", pipeline="otherpipe")
        self.assertTrue(dc.pipeline_delete(repo, "flow")["ok"])

    def test_reserved_sidecar_states_do_not_block(self):
        repo = self._repo()
        self._shadow_flow(repo)
        self._state(repo, "t.a.outputs", content="{corrupt")
        self._state(repo, "t.verdict", content="{corrupt")
        self.assertTrue(dc.pipeline_delete(repo, "flow")["ok"])

    def test_bound_native_trigger_fire_marker_refuses(self):
        repo = self._repo()
        self._shadow_flow(repo)
        self._write_trigger(repo, name="adhoc", pipeline="flow")
        self._marker(repo, "fire", "adhoc")
        self._refused(repo, "flow", "adhoc")

    def test_bound_shim_trigger_queued_marker_refuses(self):
        repo = self._repo(config="roles:\n  coder:\n    enabled: true\n"
                                 "    pipeline: flow\n")
        self._shadow_flow(repo)
        self._marker(repo, "queued", "coder")
        self._refused(repo, "flow", "coder")

    def test_unattributable_marker_refuses(self):
        repo = self._repo()
        self._shadow_flow(repo)
        self._marker(repo, "fire", "junkname")
        self._refused(repo, "flow", "junkname")

    def test_refused_stem_marker_refuses(self):
        # a broken trigger file's binding is unknowable -- its marker
        # cannot be proven not-ours (CP1 pass 2)
        repo = self._repo()
        self._shadow_flow(repo)
        self._write_trigger(repo, name="bad", raw="{corrupt")
        self._marker(repo, "fire", "bad")
        self._refused(repo, "flow", "bad")

    def test_prefix_ambiguous_refused_stem_marker_refuses(self):
        # marker `good--x`: valid trigger `good` is bound ELSEWHERE, but a
        # refused trigger literally named `good--x` bound HERE also exists
        # -- attribution to `good` alone would be fail-open (CP1 pass 2)
        repo = self._repo()
        self._shadow_flow(repo)
        self._write_trigger(repo, name="good", pipeline="otherpipe")
        self._write_trigger(repo, name="good--x", raw="{corrupt")
        self._marker(repo, "fire", "good--x")
        self._refused(repo, "flow", "good--x")

    def test_marker_of_valid_trigger_bound_elsewhere_passes(self):
        repo = self._repo()
        self._shadow_flow(repo)
        self._write_trigger(repo, name="other", pipeline="otherpipe")
        self._marker(repo, "fire", "other")
        self.assertTrue(dc.pipeline_delete(repo, "flow")["ok"])

    def test_config_unreadable_refuses_when_markers_pend(self):
        repo = self._repo(config="[unparseable\n")
        self._shadow_flow(repo)
        self._marker(repo, "fire", "whatever")
        self._refused(repo, "flow", "enumerate")

    def test_success_reset_removes_shadow_and_stale_sidecar(self):
        repo = self._repo()
        self._shadow_flow(repo)
        vroot = os.path.join(repo, "var", "autonomy", "pipelines")
        with open(os.path.join(vroot, "flow.provenance.json"), "w") as fh:
            fh.write('{"created": "blank", "at": 1}')
        res = dc.pipeline_delete(repo, "flow")
        self.assertTrue(res["ok"], res)
        self.assertIn("committed template", res["message"])
        self.assertFalse(os.path.exists(self._pipe_shadow(repo, "flow")))
        self.assertFalse(os.path.exists(
            os.path.join(vroot, "flow.provenance.json")))
        self.assertFalse(os.path.exists(
            self._pipe_shadow(repo, "flow") + ".trash"))
        # the committed template is untouched and resolves again
        import pipeline as pl
        self.assertEqual(pl.effective_pipeline_dir(repo, "flow"),
                         os.path.join(repo, ".autonomy", "pipelines", "flow"))

    def test_success_full_delete_of_created_pipeline(self):
        # create -> delete round-trip: dir AND sidecar gone
        repo = self._repo()
        self.assertTrue(dc.pipeline_create(repo, "fresh")["ok"])
        res = dc.pipeline_delete(repo, "fresh")
        self.assertTrue(res["ok"], res)
        self.assertIn("removed", res["message"])
        self.assertFalse(os.path.exists(self._pipe_shadow(repo, "fresh")))
        self.assertFalse(os.path.exists(
            self._pipe_shadow(repo, "fresh") + ".provenance.json"))
        self.assertFalse(os.path.exists(
            self._pipe_shadow(repo, "fresh") + ".trash"))

    def test_stale_trash_reclaimed(self):
        repo = self._repo()
        self._shadow_flow(repo)
        stale = self._pipe_shadow(repo, "flow") + ".trash"
        os.makedirs(os.path.join(stale, "junkdir"))
        res = dc.pipeline_delete(repo, "flow")
        self.assertTrue(res["ok"], res)
        self.assertFalse(os.path.exists(stale))

    def test_rename_failure_refuses_byte_identical(self):
        from unittest import mock
        repo = self._repo()
        self._shadow_flow(repo)
        before = self._tree(repo)
        with mock.patch("os.rename", side_effect=OSError("disk says no")):
            res = dc.pipeline_delete(repo, "flow")
        self.assertFalse(res.get("ok"), res)
        self.assertIn("detach", res["error"])
        self.assertEqual(self._tree(repo), before)
