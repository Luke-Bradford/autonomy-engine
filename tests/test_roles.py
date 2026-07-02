"""Unit tests for lib/roles.py -- the multi-role org's config schema (#12).

validate_roles is the single validation authority for the `roles:` block:
enum-checked substrate/trigger, trigger-specific required sub-fields, sane
scalars. Pure (no filesystem); prompt-file existence is a separate,
path-taking check so doctor can report it distinctly."""
import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))

import config_parser  # noqa: E402
import roles  # noqa: E402


def parse(text):
    return config_parser.parse(text)


class TestValidateRoles(unittest.TestCase):
    def test_no_roles_block_is_fine(self):
        self.assertEqual(roles.validate_roles({}), [])
        self.assertEqual(roles.validate_roles({"agent": {"type": "claude"}}), [])

    def test_design_doc_example_validates(self):
        cfg = parse(
            "roles:\n"
            "  coder:\n"
            "    enabled: true\n"
            "    substrate: engine\n"
            "    trigger: { type: loop }\n"
            "    instances: 1\n"
            "  pm:\n"
            "    enabled: false\n"
            "    substrate: managed_agents\n"
            '    trigger: { type: cron, schedule: "0 */6 * * *" }\n'
            "    prompt: .autonomy/roles/pm.md\n"
            "  qa:\n"
            "    enabled: false\n"
            "    substrate: actions\n"
            "    trigger:\n"
            "      type: event\n"
            "      on: [pull_request_review.approved, workflow_run.completed]\n"
            '      reconcile_cron: "*/10 * * * *"\n'
            "    scope: diff\n"
            "    completes_merge: true\n"
            "    prompt: .autonomy/roles/qa.md\n")
        self.assertEqual(roles.validate_roles(cfg), [])

    def test_unknown_substrate(self):
        cfg = parse("roles:\n  qa:\n    substrate: kubernetes\n    trigger: { type: event, on: [x] }\n")
        errs = roles.validate_roles(cfg)
        self.assertEqual(len(errs), 1)
        self.assertIn("substrate", errs[0])
        self.assertIn("qa", errs[0])

    def test_unknown_trigger_type(self):
        cfg = parse("roles:\n  pm:\n    trigger: { type: webhook }\n")
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("trigger" in e and "pm" in e for e in errs))

    def test_cron_requires_schedule(self):
        cfg = parse("roles:\n  pm:\n    trigger: { type: cron }\n")
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("schedule" in e for e in errs))

    def test_event_requires_on_list(self):
        cfg = parse("roles:\n  qa:\n    trigger: { type: event }\n")
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("on" in e for e in errs))

    def test_loop_needs_nothing_extra(self):
        cfg = parse("roles:\n  coder:\n    trigger: { type: loop }\n")
        self.assertEqual(roles.validate_roles(cfg), [])

    def test_instances_must_be_positive_int(self):
        for bad in ("0", "-1", "two"):
            cfg = parse("roles:\n  coder:\n    instances: %s\n" % bad)
            errs = roles.validate_roles(cfg)
            self.assertTrue(any("instances" in e for e in errs), bad)

    def test_role_must_be_a_mapping(self):
        cfg = parse("roles:\n  coder: banana\n")
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("coder" in e for e in errs))

    def test_custom_role_validated_like_standard(self):
        cfg = parse("roles:\n  security_sweeper:\n    substrate: bogus\n")
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("security_sweeper" in e for e in errs))


class TestPromptFiles(unittest.TestCase):
    def test_missing_prompt_file_reported(self):
        repo = tempfile.mkdtemp()
        cfg = parse("roles:\n  pm:\n    prompt: .autonomy/roles/pm.md\n")
        errs = roles.check_prompt_files(cfg, repo)
        self.assertTrue(any("pm.md" in e for e in errs))

    def test_present_prompt_file_ok(self):
        repo = tempfile.mkdtemp()
        os.makedirs(os.path.join(repo, ".autonomy", "roles"))
        open(os.path.join(repo, ".autonomy", "roles", "pm.md"), "w").close()
        cfg = parse("roles:\n  pm:\n    prompt: .autonomy/roles/pm.md\n")
        self.assertEqual(roles.check_prompt_files(cfg, repo), [])

    def test_absolute_or_escaping_prompt_path_rejected(self):
        repo = tempfile.mkdtemp()
        for bad in ("/etc/passwd", "../outside.md"):
            cfg = parse("roles:\n  pm:\n    prompt: %s\n" % bad)
            errs = roles.check_prompt_files(cfg, repo)
            self.assertTrue(any("pm" in e for e in errs), bad)


class TestCronNextFire(unittest.TestCase):
    """#18: the dashboard's cron-role 'next fire' countdown. UTC, standard
    5-field cron, restricted to the forms real schedules use (*, */n, lists,
    ranges, numbers). Pure + deterministic: epoch in, epoch out."""
    # 2026-07-01 21:30:00 UTC is a Wednesday
    NOW = 1782941400

    def _dt(self, epoch):
        import datetime
        return datetime.datetime.fromtimestamp(epoch, datetime.timezone.utc)

    def test_every_six_hours(self):
        nxt = roles.cron_next_fire("0 */6 * * *", self.NOW)
        d = self._dt(nxt)
        self.assertEqual((d.hour, d.minute, d.second), (0, 0, 0))
        self.assertGreater(nxt, self.NOW)
        self.assertLessEqual(nxt - self.NOW, 6 * 3600)

    def test_every_ten_minutes(self):
        nxt = roles.cron_next_fire("*/10 * * * *", self.NOW)
        self.assertEqual(self._dt(nxt).minute % 10, 0)
        self.assertGreater(nxt, self.NOW)
        self.assertLessEqual(nxt - self.NOW, 600)

    def test_daily_at_three(self):
        nxt = roles.cron_next_fire("0 3 * * *", self.NOW)
        d = self._dt(nxt)
        self.assertEqual((d.hour, d.minute), (3, 0))
        self.assertEqual(d.day, 2)  # 21:30 -> tomorrow 03:00

    def test_weekly_monday_nine(self):
        nxt = roles.cron_next_fire("0 9 * * 1", self.NOW)
        d = self._dt(nxt)
        self.assertEqual(d.weekday(), 0)  # Monday
        self.assertEqual((d.hour, d.minute), (9, 0))

    def test_day_of_month(self):
        nxt = roles.cron_next_fire("30 14 1 * *", self.NOW)
        d = self._dt(nxt)
        self.assertEqual((d.day, d.hour, d.minute), (1, 14, 30))
        self.assertEqual(d.month, 8)  # July 1st 14:30 already past -> Aug 1st

    def test_range_and_list(self):
        nxt = roles.cron_next_fire("0 9-17 * * 1,2,3,4,5", self.NOW)
        d = self._dt(nxt)
        self.assertIn(d.weekday(), (0, 1, 2, 3, 4))
        self.assertTrue(9 <= d.hour <= 17)

    def test_invalid_returns_none(self):
        self.assertIsNone(roles.cron_next_fire("not a cron", self.NOW))
        self.assertIsNone(roles.cron_next_fire("0 25 * * *", self.NOW))  # hour 25
        self.assertIsNone(roles.cron_next_fire("", self.NOW))
        self.assertIsNone(roles.cron_next_fire(None, self.NOW))

    def test_never_returns_now_or_past(self):
        # a boundary 'now' (exactly on a fire minute) returns the NEXT one
        on_boundary = roles.cron_next_fire("0 * * * *", self.NOW)
        d = self._dt(on_boundary)
        self.assertGreater(on_boundary, self.NOW)
        self.assertEqual(d.minute, 0)


class TestDefaults(unittest.TestCase):
    def test_default_roster_shape(self):
        # single source of truth for the standard roster (dashboard imports it)
        names = [r[0] for r in roles.DEFAULT_ROLES]
        self.assertEqual(names, ["coder", "pm", "qa", "researcher"])
        coder = roles.DEFAULT_ROLES[0]
        self.assertEqual(coder, ("coder", True, "engine", "loop"))
        # only coder enabled by default
        self.assertTrue(all(not r[1] for r in roles.DEFAULT_ROLES[1:]))


class TestIncrement2Fields(unittest.TestCase):
    """account/model/effort/models/scope shape validation (agent-org spec)."""

    def test_full_spec_example_validates(self):
        cfg = parse(
            "roles:\n"
            "  coder:\n"
            "    enabled: true\n"
            "    account: claude-sub\n"
            "    trigger: { type: loop }\n"
            "    model: claude-sonnet-5\n"
            "    effort: high\n"
            "    scope: { labels: [ready], milestone: current }\n"
            "  qa:\n"
            "    enabled: true\n"
            "    account: anthropic-work\n"
            "    trigger: { type: event, on: [pr.opened, pr.synchronize] }\n"
            "    model: claude-opus-4-8\n"
            "    scope: { target: diff }\n"
            "  researcher:\n"
            "    enabled: false\n"
            "    account: codex-sub\n"
            '    trigger: { type: cron, schedule: "0 3 * * *" }\n'
            "    models: { plan: claude-opus-4-8, implement: claude-sonnet-5, test: claude-haiku-4-5 }\n")
        self.assertEqual(roles.validate_roles(cfg), [])

    def test_account_must_be_nonempty(self):
        cfg = parse("roles:\n  coder:\n    account: \"\"\n")
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("account" in e and "coder" in e for e in errs))

    def test_model_and_effort_must_be_nonempty_strings(self):
        for field in ("model", "effort"):
            cfg = parse("roles:\n  coder:\n    %s: \"\"\n" % field)
            errs = roles.validate_roles(cfg)
            self.assertTrue(any(field in e for e in errs),
                            "expected an error for empty %s" % field)

    def test_models_unknown_phase(self):
        cfg = parse("roles:\n  coder:\n    models: { deploy: claude-sonnet-5 }\n")
        errs = roles.validate_roles(cfg)
        self.assertEqual(len(errs), 1)
        self.assertIn("deploy", errs[0])
        self.assertIn("plan", errs[0])  # error names the valid phases

    def test_models_must_be_mapping(self):
        cfg = parse("roles:\n  coder:\n    models: claude-sonnet-5\n")
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("models" in e for e in errs))

    def test_scope_bare_target_shorthand(self):
        # legacy form from the old template: scope: diff
        cfg = parse("roles:\n  qa:\n    scope: diff\n")
        self.assertEqual(roles.validate_roles(cfg), [])

    def test_scope_bare_string_must_be_valid_target(self):
        cfg = parse("roles:\n  qa:\n    scope: everything\n")
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("scope" in e and "everything" in e for e in errs))

    def test_scope_unknown_key(self):
        cfg = parse("roles:\n  coder:\n    scope: { repos: [a, b] }\n")
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("repos" in e for e in errs))

    def test_scope_labels_must_be_nonempty_list(self):
        cfg = parse("roles:\n  coder:\n    scope: { labels: ready }\n")
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("labels" in e for e in errs))

    def test_scope_target_enum(self):
        cfg = parse("roles:\n  qa:\n    scope: { target: everything }\n")
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("target" in e and "everything" in e for e in errs))

    def test_scope_empty_mapping_is_whole_board(self):
        cfg = parse("roles:\n  coder:\n    scope: {}\n")
        self.assertEqual(roles.validate_roles(cfg), [])


class TestBehaviourKnobs(unittest.TestCase):
    """QA/PM/Researcher/Coder behaviour knobs -- validated by value wherever
    they appear (custom agents get the same knobs)."""

    def test_spec_knob_examples_validate(self):
        cfg = parse(
            "roles:\n"
            "  qa:\n"
            "    gate: wait-for-human\n"
            "    tools: [read, mcp]\n"
            '    regression: { every: "0 3 * * 0" }\n'
            "  researcher:\n"
            "    output: handoff-to-pm\n"
            "    web_search: true\n"
            "  pm:\n"
            "    duties: [groom, prioritise, unblock, spec-check]\n"
            "  coder:\n"
            "    self_test: true\n"
            "    blockers: raise-to-pm\n")
        self.assertEqual(roles.validate_roles(cfg), [])

    def test_gate_enum(self):
        cfg = parse("roles:\n  qa:\n    gate: yolo-merge\n")
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("gate" in e and "yolo-merge" in e for e in errs))

    def test_output_enum(self):
        cfg = parse("roles:\n  researcher:\n    output: tweet\n")
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("output" in e for e in errs))

    def test_blockers_enum(self):
        cfg = parse("roles:\n  coder:\n    blockers: give-up\n")
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("blockers" in e for e in errs))

    def test_bool_knobs_must_be_bool(self):
        for knob in ("web_search", "self_test"):
            cfg = parse("roles:\n  r:\n    %s: yes\n" % knob)  # bare 'yes' parses as string
            errs = roles.validate_roles(cfg)
            self.assertTrue(any(knob in e for e in errs),
                            "expected an error for non-bool %s" % knob)

    def test_tools_subset(self):
        cfg = parse("roles:\n  qa:\n    tools: [read, bash]\n")
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("tools" in e for e in errs))

    def test_tools_empty_list_invalid(self):
        cfg = parse("roles:\n  qa:\n    tools: []\n")
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("tools" in e for e in errs))

    def test_duties_subset(self):
        cfg = parse("roles:\n  pm:\n    duties: [groom, moan]\n")
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("duties" in e for e in errs))

    def test_regression_after_tickets(self):
        cfg = parse("roles:\n  qa:\n    regression: { after_tickets: 10 }\n")
        self.assertEqual(roles.validate_roles(cfg), [])

    def test_regression_after_tickets_positive(self):
        cfg = parse("roles:\n  qa:\n    regression: { after_tickets: 0 }\n")
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("after_tickets" in e for e in errs))

    def test_regression_bad_cron(self):
        cfg = parse('roles:\n  qa:\n    regression: { every: "not cron" }\n')
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("regression" in e for e in errs))

    def test_regression_needs_exactly_one_key(self):
        cfg = parse('roles:\n  qa:\n    regression: { every: "0 3 * * 0", after_tickets: 5 }\n')
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("regression" in e for e in errs))
        cfg = parse("roles:\n  qa:\n    regression: {}\n")
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("regression" in e for e in errs))


class TestCheckAccounts(unittest.TestCase):
    """account: must name an entry in the accounts registry. Pure -- known
    names injected, same seam as check_prompt_files."""

    def test_known_account_passes(self):
        cfg = parse("roles:\n  coder:\n    account: claude-sub\n")
        self.assertEqual(roles.check_accounts(cfg, ["claude-sub"]), [])

    def test_unknown_account_is_error(self):
        cfg = parse("roles:\n  coder:\n    account: nope\n")
        errs = roles.check_accounts(cfg, ["claude-sub"])
        self.assertEqual(len(errs), 1)
        self.assertIn("nope", errs[0])
        self.assertIn("coder", errs[0])

    def test_empty_registry_fails_any_reference(self):
        cfg = parse("roles:\n  coder:\n    account: claude-sub\n")
        self.assertEqual(len(roles.check_accounts(cfg, [])), 1)

    def test_no_account_field_is_fine(self):
        cfg = parse("roles:\n  coder:\n    enabled: true\n")
        self.assertEqual(roles.check_accounts(cfg, []), [])

    def test_malformed_account_left_to_validate_roles(self):
        # shape errors are validate_roles' verdict; no duplicate report here
        cfg = parse('roles:\n  coder:\n    account: ""\n')
        self.assertEqual(roles.check_accounts(cfg, []), [])


class TestDispatchRoles(unittest.TestCase):
    def test_no_roles_block_defaults_to_coder(self):
        self.assertEqual(roles.dispatch_roles({}), ["coder"])
        self.assertEqual(roles.dispatch_roles({"agent": {"type": "claude"}}),
                         ["coder"])

    def test_standard_defaults_only_coder_runs(self):
        cfg = parse("roles:\n  pm:\n    trigger: { type: cron, schedule: \"0 0 * * *\" }\n")
        self.assertEqual(roles.dispatch_roles(cfg), ["coder"])

    def test_enabled_loop_roles_run_standard_order_first(self):
        cfg = parse(
            "roles:\n"
            "  qa:\n"
            "    enabled: true\n"
            "    trigger: { type: loop }\n"
            "  helper:\n"
            "    enabled: true\n"
            "  coder:\n"
            "    enabled: true\n")
        # standard roster order (coder, pm, qa, researcher), then custom
        self.assertEqual(roles.dispatch_roles(cfg), ["coder", "qa", "helper"])

    def test_disabled_coder_does_not_run(self):
        cfg = parse("roles:\n  coder:\n    enabled: false\n")
        self.assertEqual(roles.dispatch_roles(cfg), [])

    def test_cron_and_event_roles_are_not_dispatched(self):
        cfg = parse(
            "roles:\n"
            "  researcher:\n"
            "    enabled: true\n"
            "    trigger: { type: cron, schedule: \"0 3 * * *\" }\n"
            "  qa:\n"
            "    enabled: true\n"
            "    trigger: { type: event, on: [pr.opened] }\n")
        self.assertEqual(roles.dispatch_roles(cfg), ["coder"])

    def test_custom_role_needs_explicit_enabled(self):
        cfg = parse("roles:\n  helper:\n    account: claude-sub\n")
        self.assertEqual(roles.dispatch_roles(cfg), ["coder"])

    def test_standard_trigger_default_applies(self):
        # pm's roster default trigger is cron -> enabling it alone does not
        # make it a loop role
        cfg = parse("roles:\n  pm:\n    enabled: true\n")
        self.assertEqual(roles.dispatch_roles(cfg), ["coder"])

    def test_unsafe_role_names_filtered(self):
        # a name that could not survive shell word-splitting is never emitted
        self.assertEqual(
            roles.dispatch_roles({"roles": {"bad name": {"enabled": True}}}),
            ["coder"])

    def test_non_dict_roles_block_defaults(self):
        self.assertEqual(roles.dispatch_roles({"roles": "garbage"}), ["coder"])


class TestRenderScope(unittest.TestCase):
    def test_empty_scope_renders_nothing(self):
        self.assertEqual(roles.render_scope(None), "")
        self.assertEqual(roles.render_scope({}), "")

    def test_bare_target_shorthand(self):
        self.assertEqual(roles.render_scope("diff"),
                         "Scope: work ONLY within this scope: target: diff.")

    def test_mapping_renders_schema_order_one_line(self):
        line = roles.render_scope({"milestone": "current",
                                   "labels": ["ready", "bug"]})
        self.assertEqual(
            line,
            "Scope: work ONLY within this scope: "
            "labels: ready, bug; milestone: current.")
        self.assertNotIn("\n", line)

    def test_garbage_scope_renders_nothing(self):
        self.assertEqual(roles.render_scope(42), "")


class TestRoleSettings(unittest.TestCase):
    CFG = (
        "roles:\n"
        "  coder:\n"
        "    enabled: true\n"
        "    account: claude-sub\n"
        "    model: claude-opus-4-8\n"
        "    effort: high\n"
        "    scope: { labels: [ready] }\n"
        "    prompt: .autonomy/roles/coder.md\n"
        "    instances: 2\n"
        "  qa:\n"
        "    enabled: true\n"
        "    trigger: { type: loop }\n")

    def test_full_settings(self):
        s = roles.role_settings(parse(self.CFG), "coder")
        self.assertEqual(s["account"], "claude-sub")
        self.assertEqual(s["model"], "claude-opus-4-8")
        self.assertEqual(s["effort"], "high")
        self.assertEqual(s["prompt"], ".autonomy/roles/coder.md")
        self.assertEqual(s["scope"],
                         "Scope: work ONLY within this scope: labels: ready.")
        self.assertEqual(s["instances"], 2)

    def test_unset_fields_are_empty(self):
        s = roles.role_settings(parse(self.CFG), "qa")
        self.assertEqual(
            s, {"account": "", "model": "", "effort": "", "prompt": "",
                "scope": "", "instances": 1})

    def test_default_coder_with_no_roles_block(self):
        s = roles.role_settings({}, "coder")
        self.assertEqual(s["account"], "")
        self.assertEqual(s["instances"], 1)

    def test_undispatchable_role_raises(self):
        with self.assertRaises(KeyError):
            roles.role_settings(parse(self.CFG), "researcher")
        with self.assertRaises(KeyError):
            roles.role_settings({}, "qa")


class TestMainAccountWiring(unittest.TestCase):
    """roles.py <target-repo> folds check_accounts in, loading the registry
    from $HOME/.config/autonomy/accounts (accounts.py's default path)."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.repo = os.path.join(self.tmp, "repo")
        os.makedirs(os.path.join(self.repo, ".autonomy"))
        self.home = os.path.join(self.tmp, "home")
        os.makedirs(os.path.join(self.home, ".config", "autonomy"))
        with open(os.path.join(self.home, ".config", "autonomy", "accounts"),
                  "w", encoding="utf-8") as fh:
            json.dump({"accounts": {"claude-sub":
                                    {"kind": "claude_subscription"}}}, fh)
        self._old_home = os.environ.get("HOME")
        os.environ["HOME"] = self.home
        self.addCleanup(self._restore_home)

    def _restore_home(self):
        if self._old_home is None:
            os.environ.pop("HOME", None)
        else:
            os.environ["HOME"] = self._old_home

    def _write_config(self, text):
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"),
                  "w", encoding="utf-8") as fh:
            fh.write(text)

    def test_known_account_exits_0(self):
        self._write_config("roles:\n  coder:\n    account: claude-sub\n"
                           "    trigger: { type: loop }\n")
        self.assertEqual(roles.main(["roles.py", self.repo]), 0)

    def test_unknown_account_exits_1(self):
        self._write_config("roles:\n  coder:\n    account: no-such\n"
                           "    trigger: { type: loop }\n")
        self.assertEqual(roles.main(["roles.py", self.repo]), 1)

    def test_no_roles_block_still_exits_3(self):
        self._write_config("engine:\n  requires_claude_md: false\n")
        self.assertEqual(roles.main(["roles.py", self.repo]), 3)


if __name__ == "__main__":
    unittest.main()
