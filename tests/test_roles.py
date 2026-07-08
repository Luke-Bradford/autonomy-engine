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

    def test_pipeline_binding_validates_charset(self):
        cfg = {"roles": {"coder": {"enabled": True, "pipeline": "../evil"}}}
        self.assertTrue(any("pipeline" in e for e in roles.validate_roles(cfg)))
        cfg = {"roles": {"coder": {"enabled": True, "pipeline": ""}}}
        self.assertTrue(any("pipeline" in e for e in roles.validate_roles(cfg)))
        cfg = {"roles": {"coder": {"enabled": True,
                                   "pipeline": "ticket-to-merge"}}}
        self.assertEqual(roles.validate_roles(cfg), [])

    def test_design_doc_example_validates(self):
        cfg = parse(
            "roles:\n"
            "  coder:\n"
            "    enabled: true\n"
            "    substrate: engine\n"
            "    trigger: { type: loop }\n"
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
            "      on: [pr.opened, pr.synchronize]\n"
            '      reconcile_cron: "*/10 * * * *"\n'
            "    scope: diff\n"
            "    completes_merge: true\n"
            "    prompt: .autonomy/roles/qa.md\n")
        self.assertEqual(roles.validate_roles(cfg), [])

    def test_researcher_config_example_validates(self):
        # The exact `researcher:` example documented in
        # templates/autonomy-pack/config.yaml (W5b, #127) -- read-only cron
        # future-thinker. If this drifts from the shipped comment it is a real
        # config-vs-validator bug, not a test to paper over.
        cfg = parse(
            "roles:\n"
            "  researcher:\n"
            "    enabled: false\n"
            "    account: codex-sub\n"
            '    trigger: { type: cron, schedule: "0 3 * * *" }\n'
            "    output: handoff-to-pm\n"
            "    web_search: false\n"
            "    prompt: .autonomy/roles/researcher.md\n")
        self.assertEqual(roles.validate_roles(cfg), [])

    def test_unknown_substrate(self):
        cfg = parse("roles:\n  qa:\n    substrate: kubernetes\n    trigger: { type: event, on: [pr.opened] }\n")
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

    def test_cron_unparseable_schedule_rejected(self):
        # a non-blank but invalid schedule would pass the blank check yet never
        # fire (cron-due always not-due) -- validation must catch it.
        cfg = parse('roles:\n  pm:\n    trigger: { type: cron, schedule: "not a cron" }\n')
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("valid" in e and "cron" in e for e in errs))

    def test_cron_valid_schedule_accepted(self):
        cfg = parse('roles:\n  pm:\n    trigger: { type: cron, schedule: "*/5 * * * *" }\n')
        self.assertEqual(roles.validate_roles(cfg), [])

    def test_event_requires_on_list(self):
        cfg = parse("roles:\n  qa:\n    trigger: { type: event }\n")
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("on" in e for e in errs))

    def test_event_unknown_token_rejected(self):
        # a non-empty on: with an unknown event would accept a role that can
        # never wake -- fail-closed at validation.
        cfg = parse("roles:\n  qa:\n    trigger: { type: event, on: [pr.exploded] }\n")
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("pr.exploded" in e for e in errs))

    def test_event_mixed_known_unknown_rejected(self):
        cfg = parse("roles:\n  qa:\n    trigger: { type: event, on: [pr.opened, nope.bad] }\n")
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("nope.bad" in e for e in errs))

    def test_event_known_tokens_accepted(self):
        cfg = parse("roles:\n  qa:\n    trigger:\n      type: event\n"
                    "      on: [pr.opened, pr.synchronize, issue.created, merge.done, session.done]\n")
        self.assertEqual(roles.validate_roles(cfg), [])

    def test_loop_needs_nothing_extra(self):
        cfg = parse("roles:\n  coder:\n    trigger: { type: loop }\n")
        self.assertEqual(roles.validate_roles(cfg), [])

    def test_instances_knob_is_retired_and_ignored(self):
        # D1 (#147): instances: is retired in favour of lanes -- a leftover in an
        # old config is inert (no longer validated), not an error.
        cfg = parse("roles:\n  coder:\n    enabled: true\n    instances: 2\n")
        self.assertEqual(roles.validate_roles(cfg), [])

    def test_role_must_be_a_mapping(self):
        cfg = parse("roles:\n  coder: banana\n")
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("coder" in e for e in errs))

    def test_custom_role_validated_like_standard(self):
        cfg = parse("roles:\n  security_sweeper:\n    substrate: bogus\n")
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("security_sweeper" in e for e in errs))


class TestUnwiredKnobNotes(unittest.TestCase):
    """fail-safe honesty (#149): a knob the operator set that the engine does
    not (fully) consume yet must be surfaced, not silently ignored."""

    def test_true_bool_knob_is_flagged(self):
        notes = roles.unwired_knob_notes("coder", {"self_test": True})
        self.assertEqual(len(notes), 1)
        self.assertIn("roles.coder.self_test", notes[0])
        self.assertIn("#89", notes[0])

    def test_false_bool_knob_is_not_flagged(self):
        # a false/default bool is the quiet default, not a surprising no-op
        self.assertEqual(roles.unwired_knob_notes("coder", {"self_test": False}), [])

    def test_absent_knob_is_not_flagged(self):
        self.assertEqual(roles.unwired_knob_notes("coder", {}), [])

    def test_empty_collections_are_not_flagged(self):
        self.assertEqual(
            roles.unwired_knob_notes("coder", {"tools": [], "regression": {}}), [])

    def test_nonempty_collection_knobs_are_flagged(self):
        notes = roles.unwired_knob_notes(
            "coder", {"tools": ["read"], "models": {"plan": "opus"}})
        joined = " ".join(notes)
        self.assertIn("roles.coder.tools", joined)
        self.assertIn("roles.coder.models", joined)

    def test_gate_is_flagged_on_non_qa_but_not_on_qa(self):
        # gate IS consumed on the QA merge-path -> honest only for other roles
        self.assertTrue(
            any("gate" in n for n in roles.unwired_knob_notes("coder", {"gate": "auto-merge-on-pass"})))
        self.assertEqual(roles.unwired_knob_notes("qa", {"gate": "auto-merge-on-pass"}), [])

    def test_non_dict_config_is_empty(self):
        self.assertEqual(roles.unwired_knob_notes("coder", None), [])


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

    def test_researcher_rail_path_drift_guard(self):
        # W5b (#127): the documented researcher `prompt:` and the shipped rail
        # path must not silently drift. Existence is the invariant that catches
        # the original bug (config pointed at a rail onboard never scaffolded).
        repo = tempfile.mkdtemp()
        cfg = parse("roles:\n  researcher:\n"
                    "    prompt: .autonomy/roles/researcher.md\n")
        # absent -> reported (this is today's state before the rail ships)
        errs = roles.check_prompt_files(cfg, repo)
        self.assertTrue(any("researcher.md" in e for e in errs))
        # present at that exact path -> clean
        os.makedirs(os.path.join(repo, ".autonomy", "roles"))
        open(os.path.join(repo, ".autonomy", "roles", "researcher.md"),
             "w").close()
        self.assertEqual(roles.check_prompt_files(cfg, repo), [])

    def test_absolute_or_escaping_prompt_path_rejected(self):
        repo = tempfile.mkdtemp()
        for bad in ("/etc/passwd", "../outside.md"):
            cfg = parse("roles:\n  pm:\n    prompt: %s\n" % bad)
            errs = roles.check_prompt_files(cfg, repo)
            self.assertTrue(any("pm" in e for e in errs), bad)


class TestAgentAdapters(unittest.TestCase):
    """check_agent_adapters: an explicit role `agent:` must name an adapter
    that exists in the engine agents dir (fail-safe -- #98)."""

    def _agents_dir(self, *names):
        d = tempfile.mkdtemp()
        for n in names:
            open(os.path.join(d, n + ".sh"), "w").close()
        return d

    def test_present_adapter_ok(self):
        agents = self._agents_dir("claude", "codex")
        cfg = parse("roles:\n  prep:\n    agent: codex\n")
        self.assertEqual(roles.check_agent_adapters(cfg, agents), [])

    def test_missing_adapter_reported(self):
        agents = self._agents_dir("claude", "codex")
        cfg = parse("roles:\n  prep:\n    agent: ghost\n")
        errs = roles.check_agent_adapters(cfg, agents)
        self.assertTrue(any("prep" in e and "ghost" in e for e in errs))

    def test_unset_agent_is_not_checked(self):
        # no `agent:` -> use the global $AGENT_TYPE; not this check's concern
        agents = self._agents_dir("claude")
        cfg = parse("roles:\n  coder:\n    enabled: true\n")
        self.assertEqual(roles.check_agent_adapters(cfg, agents), [])

    def test_invalid_charset_rejected(self):
        # a traversal-shaped name never reaches a source path -- rejected, not
        # silently "not found"
        agents = self._agents_dir("claude")
        cfg = parse("roles:\n  prep:\n    agent: ../../etc/x\n")
        errs = roles.check_agent_adapters(cfg, agents)
        self.assertTrue(any("prep" in e and "invalid chars" in e for e in errs))


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


class _FakeRegistry:
    """Stand-in for accounts.Accounts -- doctor only uses is_corrupt/list/
    index_path (the injected seam)."""
    def __init__(self, corrupt=False, names=(), index_path="/x/accounts"):
        self._corrupt = corrupt
        self._names = list(names)
        self.index_path = index_path
    def is_corrupt(self):
        return self._corrupt
    def list(self):
        return [{"name": n} for n in self._names]


class TestAccountErrors(unittest.TestCase):
    """account_errors: doctor's registry-aware account check (#59). A corrupt
    registry must say 'unreadable', not 'account not found'."""

    def test_healthy_registry_delegates_to_check_accounts(self):
        cfg = parse("roles:\n  coder:\n    account: work\n")
        reg = _FakeRegistry(names=["work"])
        self.assertEqual(roles.account_errors(cfg, reg), [])

    def test_healthy_registry_reports_unknown(self):
        cfg = parse("roles:\n  coder:\n    account: nope\n")
        reg = _FakeRegistry(names=["work"])
        errs = roles.account_errors(cfg, reg)
        self.assertEqual(len(errs), 1)
        self.assertIn("nope", errs[0])

    def test_corrupt_registry_says_unreadable_not_not_found(self):
        cfg = parse("roles:\n  coder:\n    account: work\n")
        reg = _FakeRegistry(corrupt=True, index_path="/cfg/accounts")
        errs = roles.account_errors(cfg, reg)
        self.assertEqual(len(errs), 1)
        self.assertIn("unreadable", errs[0])
        self.assertIn("/cfg/accounts", errs[0])
        self.assertNotIn("not found", errs[0])

    def test_corrupt_registry_ignored_when_no_role_uses_an_account(self):
        # a corrupt registry nothing references is not doctor's concern
        cfg = parse("roles:\n  coder:\n    enabled: true\n")
        reg = _FakeRegistry(corrupt=True)
        self.assertEqual(roles.account_errors(cfg, reg), [])

    def test_corrupt_registry_ignored_for_no_roles_config(self):
        reg = _FakeRegistry(corrupt=True)
        self.assertEqual(roles.account_errors(parse("roles: {}\n"), reg), [])


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
        self.assertNotIn("instances", s)   # retired (D1, #147)

    def test_unset_fields_are_empty(self):
        s = roles.role_settings(parse(self.CFG), "qa")
        self.assertEqual(
            s, {"account": "", "agent": "", "model": "", "effort": "",
                "prompt": "", "scope": "", "pipeline": ""})

    def test_role_settings_exposes_pipeline(self):
        cfg = parse("roles:\n  coder:\n    enabled: true\n"
                    "    pipeline: ticket-to-merge\n")
        self.assertEqual(roles.role_settings(cfg, "coder")["pipeline"],
                         "ticket-to-merge")

    def test_default_coder_with_no_roles_block(self):
        s = roles.role_settings({}, "coder")
        self.assertEqual(s["account"], "")
        self.assertNotIn("instances", s)

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


class TestRoleAgent(unittest.TestCase):
    """Per-role agent: picks which adapter (claude/codex/...) runs the role,
    letting one repo run coder on a cloud agent and prep on a local one (#78)."""
    def test_role_settings_includes_agent(self):
        cfg = parse("roles:\n"
                    "  prep:\n"
                    "    enabled: true\n"
                    "    agent: codex\n"
                    "    account: local-llm\n")
        s = roles.role_settings(cfg, "prep")
        self.assertEqual(s["agent"], "codex")

    def test_agent_empty_when_unset(self):
        cfg = parse("roles:\n  coder:\n    enabled: true\n")
        self.assertEqual(roles.role_settings(cfg, "coder")["agent"], "")

    def test_non_string_agent_rejected(self):
        cfg = parse("roles:\n  coder:\n    enabled: true\n    agent: []\n")
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("agent" in e for e in errs), errs)


class TestDispatchCli(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        os.makedirs(os.path.join(self.tmp, ".autonomy"))

    def _write(self, text):
        with open(os.path.join(self.tmp, ".autonomy", "config.yaml"),
                  "w", encoding="utf-8") as fh:
            fh.write(text)

    def _run(self, *argv):
        import io
        from contextlib import redirect_stdout
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = roles.main(["roles.py"] + list(argv))
        return rc, buf.getvalue()

    def test_enumerate_default_roster(self):
        self._write("agent:\n  type: claude\n")
        rc, out = self._run("dispatch", self.tmp)
        self.assertEqual(rc, 0)
        self.assertEqual(out, "coder\n")

    def test_enumerate_enabled_loop_roles(self):
        self._write("roles:\n"
                    "  coder:\n    enabled: true\n"
                    "  qa:\n    enabled: true\n    trigger: { type: loop }\n")
        rc, out = self._run("dispatch", self.tmp)
        self.assertEqual(rc, 0)
        self.assertEqual(out.split(), ["coder", "qa"])

    def test_enumerate_all_disabled_prints_nothing(self):
        self._write("roles:\n  coder:\n    enabled: false\n")
        rc, out = self._run("dispatch", self.tmp)
        self.assertEqual(rc, 0)
        self.assertEqual(out, "")

    def test_role_settings_key_value_lines(self):
        self._write("roles:\n"
                    "  coder:\n"
                    "    enabled: true\n"
                    "    account: claude-sub\n"
                    "    model: claude-opus-4-8\n"
                    "    scope: { labels: [ready] }\n")
        rc, out = self._run("dispatch", self.tmp, "coder")
        self.assertEqual(rc, 0)
        lines = out.splitlines()
        self.assertIn("ACCOUNT=claude-sub", lines)
        self.assertIn("MODEL=claude-opus-4-8", lines)
        self.assertIn("EFFORT=", lines)
        self.assertIn("PROMPT=", lines)
        self.assertIn(
            "SCOPE=Scope: work ONLY within this scope: labels: ready.", lines)
        self.assertIn("AGENT=", lines)
        self.assertEqual(len(lines), 6)

    def test_dispatch_role_emits_agent_line(self):
        self._write("roles:\n"
                    "  coder:\n"
                    "    enabled: true\n"
                    "    agent: codex\n")
        rc, out = self._run("dispatch", self.tmp, "coder")
        self.assertEqual(rc, 0)
        lines = out.splitlines()
        self.assertIn("AGENT=codex", lines)
        # ACCOUNT/AGENT/MODEL/EFFORT/PROMPT/SCOPE (INSTANCES retired, D1 #147)
        self.assertEqual(len(lines), 6)

    def test_undispatchable_role_exits_1(self):
        self._write("agent:\n  type: claude\n")
        rc, _ = self._run("dispatch", self.tmp, "qa")
        self.assertEqual(rc, 1)

    def test_unreadable_config_exits_2(self):
        rc, _ = self._run("dispatch", os.path.join(self.tmp, "nope"))
        self.assertEqual(rc, 2)

    def test_validation_cli_still_works(self):
        self._write("agent:\n  type: claude\n")
        rc, _ = self._run(self.tmp)
        self.assertEqual(rc, 3)  # valid, no roles: block


class TestCronRoles(unittest.TestCase):
    """cron_roles enumerates enabled cron-trigger roles with a non-blank
    schedule, in dispatch_roles' stable order (standard roster first, then
    custom roles in config order). The supervisor's scheduler consumes it."""

    def test_no_roles_block_has_no_cron_roles(self):
        self.assertEqual(roles.cron_roles({}), [])
        self.assertEqual(roles.cron_roles({"agent": {"type": "claude"}}), [])

    def test_enabled_cron_role_appears_with_schedule(self):
        cfg = parse(
            "roles:\n"
            "  pm:\n"
            "    enabled: true\n"
            '    trigger: { type: cron, schedule: "0 3 * * *" }\n')
        self.assertEqual(roles.cron_roles(cfg), [("pm", "0 3 * * *")])

    def test_custom_cron_role_appears(self):
        cfg = parse(
            "roles:\n"
            "  nightly:\n"
            "    enabled: true\n"
            '    trigger: { type: cron, schedule: "*/5 * * * *" }\n')
        self.assertEqual(roles.cron_roles(cfg), [("nightly", "*/5 * * * *")])

    def test_standard_before_custom_order(self):
        cfg = parse(
            "roles:\n"
            "  nightly:\n"
            "    enabled: true\n"
            '    trigger: { type: cron, schedule: "*/5 * * * *" }\n'
            "  pm:\n"
            "    enabled: true\n"
            '    trigger: { type: cron, schedule: "0 3 * * *" }\n')
        self.assertEqual(roles.cron_roles(cfg),
                         [("pm", "0 3 * * *"), ("nightly", "*/5 * * * *")])

    def test_blank_or_missing_schedule_skipped(self):
        # a cron role with no schedule cannot fire -- skipped (validate_roles
        # would reject it, but dispatch must degrade, not crash).
        cfg = parse("roles:\n  pm:\n    enabled: true\n    trigger: { type: cron }\n")
        self.assertEqual(roles.cron_roles(cfg), [])

    def test_loop_and_disabled_cron_excluded(self):
        cfg = parse(
            "roles:\n"
            "  coder:\n"
            "    enabled: true\n"
            "    trigger: { type: loop }\n"
            "  pm:\n"
            "    enabled: false\n"
            '    trigger: { type: cron, schedule: "0 3 * * *" }\n')
        self.assertEqual(roles.cron_roles(cfg), [])

    def test_unsafe_role_names_filtered(self):
        self.assertEqual(
            roles.cron_roles({"roles": {"bad name": {
                "enabled": True,
                "trigger": {"type": "cron", "schedule": "0 3 * * *"}}}}),
            [])

    def test_non_dict_roles_block(self):
        self.assertEqual(roles.cron_roles({"roles": "garbage"}), [])


class TestEventRoles(unittest.TestCase):
    """event_roles enumerates enabled event-trigger roles with a non-empty on:
    list, in dispatch_roles' stable order. The supervisor's event bus consumes it."""

    def test_no_roles_block_has_no_event_roles(self):
        self.assertEqual(roles.event_roles({}), [])

    def test_enabled_event_role_appears_with_on_list(self):
        cfg = parse(
            "roles:\n"
            "  qa:\n"
            "    enabled: true\n"
            "    trigger: { type: event, on: [pr.opened, pr.synchronize] }\n")
        self.assertEqual(roles.event_roles(cfg),
                         [("qa", ["pr.opened", "pr.synchronize"])])

    def test_custom_event_role_appears(self):
        cfg = parse(
            "roles:\n"
            "  notify:\n"
            "    enabled: true\n"
            "    trigger: { type: event, on: [merge.done] }\n")
        self.assertEqual(roles.event_roles(cfg), [("notify", ["merge.done"])])

    def test_standard_before_custom_order(self):
        cfg = parse(
            "roles:\n"
            "  notify:\n"
            "    enabled: true\n"
            "    trigger: { type: event, on: [merge.done] }\n"
            "  qa:\n"
            "    enabled: true\n"
            "    trigger: { type: event, on: [pr.opened] }\n")
        self.assertEqual(roles.event_roles(cfg),
                         [("qa", ["pr.opened"]), ("notify", ["merge.done"])])

    def test_empty_on_list_skipped(self):
        # defense in depth -- validate_roles rejects it, enumeration must not crash.
        self.assertEqual(
            roles.event_roles({"roles": {"qa": {
                "enabled": True, "trigger": {"type": "event", "on": []}}}}),
            [])

    def test_loop_cron_and_disabled_event_excluded(self):
        cfg = parse(
            "roles:\n"
            "  coder:\n    enabled: true\n    trigger: { type: loop }\n"
            "  pm:\n    enabled: true\n    trigger: { type: cron, schedule: \"0 3 * * *\" }\n"
            "  qa:\n    enabled: false\n    trigger: { type: event, on: [pr.opened] }\n")
        self.assertEqual(roles.event_roles(cfg), [])

    def test_unsafe_role_names_filtered(self):
        self.assertEqual(
            roles.event_roles({"roles": {"bad name": {
                "enabled": True, "trigger": {"type": "event", "on": ["pr.opened"]}}}}),
            [])


class TestDispatchableRoles(unittest.TestCase):
    """A cron role must be dispatchable: the scheduler fires it via the same
    run_session -> roles.py dispatch <role> path, so role_settings has to
    resolve it (else every cron fire is refused -- the W1 feature is inert)."""

    def test_cron_role_is_dispatchable(self):
        cfg = parse(
            "roles:\n"
            "  pm:\n"
            "    enabled: true\n"
            '    trigger: { type: cron, schedule: "0 3 * * *" }\n')
        self.assertIn("pm", roles.dispatchable_roles(cfg))

    def test_role_settings_resolves_a_cron_role(self):
        cfg = parse(
            "roles:\n"
            "  pm:\n"
            "    enabled: true\n"
            "    account: pm-acct\n"
            '    trigger: { type: cron, schedule: "0 3 * * *" }\n')
        s = roles.role_settings(cfg, "pm")
        self.assertEqual(s["account"], "pm-acct")

    def test_loop_roles_still_first_and_cron_appended(self):
        cfg = parse(
            "roles:\n"
            "  coder:\n"
            "    enabled: true\n"
            "  pm:\n"
            "    enabled: true\n"
            '    trigger: { type: cron, schedule: "0 3 * * *" }\n')
        self.assertEqual(roles.dispatchable_roles(cfg), ["coder", "pm"])

    def test_disabled_cron_role_not_dispatchable(self):
        cfg = parse("roles:\n  pm:\n    enabled: false\n"
                    '    trigger: { type: cron, schedule: "0 3 * * *" }\n')
        self.assertNotIn("pm", roles.dispatchable_roles(cfg))
        with self.assertRaises(KeyError):
            roles.role_settings(cfg, "pm")

    def test_event_role_is_dispatchable(self):
        # the event bus fires an event role via the same run_session ->
        # roles.py dispatch <role> path, so role_settings must resolve it.
        cfg = parse(
            "roles:\n"
            "  qa:\n"
            "    enabled: true\n"
            "    account: qa-acct\n"
            "    trigger: { type: event, on: [pr.opened] }\n")
        self.assertIn("qa", roles.dispatchable_roles(cfg))
        self.assertEqual(roles.role_settings(cfg, "qa")["account"], "qa-acct")

    def test_loop_cron_event_order(self):
        cfg = parse(
            "roles:\n"
            "  coder:\n    enabled: true\n"
            "  pm:\n    enabled: true\n    trigger: { type: cron, schedule: \"0 3 * * *\" }\n"
            "  qa:\n    enabled: true\n    trigger: { type: event, on: [pr.opened] }\n")
        self.assertEqual(roles.dispatchable_roles(cfg), ["coder", "pm", "qa"])


class TestCronCli(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        os.makedirs(os.path.join(self.tmp, ".autonomy"))

    def _write(self, text):
        with open(os.path.join(self.tmp, ".autonomy", "config.yaml"),
                  "w", encoding="utf-8") as fh:
            fh.write(text)

    def _run(self, *argv):
        import io
        from contextlib import redirect_stdout
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = roles.main(["roles.py"] + list(argv))
        return rc, buf.getvalue()

    def test_cron_verb_emits_name_tab_schedule(self):
        self._write(
            "roles:\n"
            "  pm:\n"
            "    enabled: true\n"
            '    trigger: { type: cron, schedule: "0 3 * * *" }\n')
        rc, out = self._run("cron", self.tmp)
        self.assertEqual(rc, 0)
        self.assertEqual(out, "pm\t0 3 * * *\n")

    def test_cron_verb_empty_when_none(self):
        self._write("agent:\n  type: claude\n")
        rc, out = self._run("cron", self.tmp)
        self.assertEqual(rc, 0)
        self.assertEqual(out, "")

    def test_cron_verb_unreadable_config_exits_2(self):
        rc, _ = self._run("cron", os.path.join(self.tmp, "nope"))
        self.assertEqual(rc, 2)

    def test_cron_due_fires_when_slot_elapsed(self):
        # last fire at epoch 0; a */5 slot (300s) has elapsed by now=600.
        rc, out = self._run("cron-due", "*/5 * * * *", "0", "600")
        self.assertEqual(rc, 0)
        self.assertEqual(out, "due\n")

    def test_cron_due_not_due_before_slot(self):
        # last fire at 0; next */5 slot is 300; now=100 is before it.
        rc, out = self._run("cron-due", "*/5 * * * *", "0", "100")
        self.assertEqual(rc, 0)
        self.assertEqual(out, "not-due\n")

    def test_cron_due_unparseable_schedule_is_not_due(self):
        rc, out = self._run("cron-due", "not a cron", "0", "999999")
        self.assertEqual(rc, 0)
        self.assertEqual(out, "not-due\n")

    def test_cron_due_non_int_epoch_is_not_due(self):
        rc, out = self._run("cron-due", "*/5 * * * *", "x", "y")
        self.assertEqual(rc, 0)
        self.assertEqual(out, "not-due\n")

    def test_dispatch_resolves_cron_role_settings(self):
        # the scheduler fires a cron role through `dispatch <repo> <role>`;
        # it must resolve (rc 0), not refuse -- else the fire is inert.
        self._write(
            "roles:\n"
            "  pm:\n"
            "    enabled: true\n"
            "    account: pm-acct\n"
            '    trigger: { type: cron, schedule: "0 3 * * *" }\n')
        rc, out = self._run("dispatch", self.tmp, "pm")
        self.assertEqual(rc, 0)
        self.assertIn("ACCOUNT=pm-acct", out.splitlines())

    def test_events_verb_emits_name_tab_events(self):
        self._write(
            "roles:\n"
            "  qa:\n"
            "    enabled: true\n"
            "    trigger: { type: event, on: [pr.opened, pr.synchronize] }\n")
        rc, out = self._run("events", self.tmp)
        self.assertEqual(rc, 0)
        self.assertEqual(out, "qa\tpr.opened,pr.synchronize\n")

    def test_events_verb_empty_when_none(self):
        self._write("agent:\n  type: claude\n")
        rc, out = self._run("events", self.tmp)
        self.assertEqual(rc, 0)
        self.assertEqual(out, "")

    def test_events_verb_unreadable_config_exits_2(self):
        rc, _ = self._run("events", os.path.join(self.tmp, "nope"))
        self.assertEqual(rc, 2)

    def test_dispatch_resolves_event_role_settings(self):
        self._write(
            "roles:\n"
            "  qa:\n"
            "    enabled: true\n"
            "    account: qa-acct\n"
            "    trigger: { type: event, on: [pr.opened] }\n")
        rc, out = self._run("dispatch", self.tmp, "qa")
        self.assertEqual(rc, 0)
        self.assertIn("ACCOUNT=qa-acct", out.splitlines())


class TestLaneValidation(unittest.TestCase):
    """`lanes:` block + role `lane:` schema (#147 lanes execution, Part 1).
    Fail-closed: undeclared lanes, bad names, unknown keys, unsafe worktrees."""

    def test_no_lanes_block_is_fine(self):
        self.assertEqual(roles.validate_roles(parse("agent:\n  type: claude\n")), [])

    def test_valid_lanes_block(self):
        cfg = parse(
            "lanes:\n"
            "  main:     { worktree: ../.repo-autonomy }\n"
            "  frontend: { worktree: ../.repo-frontend }\n"
            "roles:\n"
            "  coder:\n    enabled: true\n    lane: main\n"
            "  coder-fe:\n    enabled: true\n    trigger: { type: loop }\n    lane: frontend\n")
        self.assertEqual(roles.validate_roles(cfg), [])

    def test_lanes_block_must_be_nonempty_mapping(self):
        self.assertTrue(roles.validate_roles(parse("lanes: []\n")))
        self.assertTrue(roles.validate_roles(parse("lanes:\n  main: notamap\n")))

    def test_bad_lane_name_charset(self):
        errs = roles.validate_roles(parse("lanes:\n  'bad name': {}\n"))
        self.assertTrue(any("invalid lane name" in e for e in errs))

    def test_unknown_lane_key_rejected(self):
        errs = roles.validate_roles(parse("lanes:\n  main: { bogus: 1 }\n"))
        self.assertTrue(any("unknown key" in e for e in errs))

    def test_absolute_worktree_rejected(self):
        errs = roles.validate_roles(parse("lanes:\n  main: { worktree: /abs/path }\n"))
        self.assertTrue(any("relative path" in e for e in errs))

    def test_duplicate_worktree_rejected(self):
        errs = roles.validate_roles(parse(
            "lanes:\n"
            "  a: { worktree: ../same }\n"
            "  b: { worktree: ../same }\n"))
        self.assertTrue(any("duplicate" in e.lower() for e in errs))

    def test_invalid_lanes_caught_without_roles_block(self):
        # validate_roles must inspect lanes: even when roles: is absent
        errs = roles.validate_roles(parse("lanes:\n  main: { bogus: 1 }\n"))
        self.assertTrue(errs)

    def test_role_lane_must_be_declared(self):
        errs = roles.validate_roles(parse(
            "lanes:\n  main: {}\n"
            "roles:\n  coder: { enabled: true, lane: ghost }\n"))
        self.assertTrue(any("not a declared lane" in e for e in errs))

    def test_role_lane_main_ok_without_block(self):
        # no lanes: block -> implicit lane is 'main'; lane: main is valid
        self.assertEqual(roles.validate_roles(parse(
            "roles:\n  coder: { enabled: true, lane: main }\n")), [])

    def test_role_lane_bad_charset(self):
        errs = roles.validate_roles(parse(
            "roles:\n  coder: { enabled: true, lane: 'x y' }\n"))
        self.assertTrue(any("lane" in e for e in errs))


class TestLaneHelpers(unittest.TestCase):
    def test_default_lane_no_block(self):
        self.assertEqual(roles.default_lane(parse("agent:\n  type: claude\n")), "main")

    def test_default_lane_is_first_declared(self):
        cfg = parse("lanes:\n  frontend: {}\n  main: {}\n")
        self.assertEqual(roles.default_lane(cfg), "frontend")
        self.assertEqual(roles.lane_names(cfg), ["frontend", "main"])

    def test_lane_of_role(self):
        cfg = parse(
            "lanes:\n  main: {}\n  fe: {}\n"
            "roles:\n"
            "  coder: { enabled: true }\n"
            "  coder-fe: { enabled: true, lane: fe }\n")
        self.assertEqual(roles.lane_of_role(cfg, "coder"), "main")
        self.assertEqual(roles.lane_of_role(cfg, "coder-fe"), "fe")

    def test_lanes_valid_absent_block(self):
        # No `lanes:` block is the healthy implicit single-lane case.
        self.assertTrue(roles.lanes_valid(parse("agent:\n  type: claude\n")))

    def test_lanes_valid_valid_block(self):
        self.assertTrue(roles.lanes_valid(parse("lanes:\n  main: {}\n  fe: {}\n")))

    def test_lanes_valid_false_on_malformed_block(self):
        # Mirrors the `roles.py lanes` refusal: a non-mapping block and a
        # bad-charset lane name are both invalid (not silently 'main').
        self.assertFalse(roles.lanes_valid(parse("lanes: nonsense\n")))
        self.assertFalse(roles.lanes_valid(parse("lanes:\n  'bad name!': {}\n")))

    def test_overlap_disjoint_none(self):
        cfg = parse(
            "lanes:\n  main: {}\n  fe: {}\n"
            "roles:\n"
            "  coder:\n    enabled: true\n    scope: { labels: [ready] }\n"
            "  coder-fe:\n    enabled: true\n    lane: fe\n    scope: { labels: [design] }\n")
        self.assertEqual(roles.lane_overlaps(cfg), [])

    def test_overlap_intersecting_warns(self):
        cfg = parse(
            "lanes:\n  main: {}\n  fe: {}\n"
            "roles:\n"
            "  coder:\n    enabled: true\n    scope: { labels: [ready] }\n"
            "  coder-fe:\n    enabled: true\n    lane: fe\n    scope: { labels: [ready, area:fe] }\n")
        w = roles.lane_overlaps(cfg)
        self.assertEqual(len(w), 1)
        self.assertIn("ready", w[0])
        self.assertIn("fe", w[0])
        self.assertIn("main", w[0])

    def test_overlap_no_labels_never_overlaps(self):
        cfg = parse(
            "lanes:\n  main: {}\n  fe: {}\n"
            "roles:\n"
            "  coder: { enabled: true }\n"
            "  coder-fe: { enabled: true, lane: fe }\n")
        self.assertEqual(roles.lane_overlaps(cfg), [])

    def test_overlap_includes_cron_role(self):
        # A cron role pinned to a non-default lane whose scope.labels intersect
        # a loop role in another lane must warn: once per-lane execution lands
        # both can act on the same label (deferred PR-#162 NITPICK, #147 Part2).
        cfg = parse(
            "lanes:\n  main: {}\n  fe: {}\n"
            "roles:\n"
            "  coder:\n    enabled: true\n    scope: { labels: [ready] }\n"
            "  pm:\n    enabled: true\n    lane: fe\n"
            "    trigger: { type: cron, schedule: '0 9 * * *' }\n"
            "    scope: { labels: [ready] }\n")
        w = roles.lane_overlaps(cfg)
        self.assertEqual(len(w), 1)
        self.assertIn("ready", w[0])
        self.assertIn("fe", w[0])
        self.assertIn("main", w[0])

    def test_overlap_includes_event_role(self):
        # Same for an event role in a different lane (deferred PR-#162 NITPICK).
        cfg = parse(
            "lanes:\n  main: {}\n  fe: {}\n"
            "roles:\n"
            "  coder:\n    enabled: true\n    scope: { labels: [ready] }\n"
            "  qa:\n    enabled: true\n    lane: fe\n"
            "    trigger: { type: event, on: [pr.opened] }\n"
            "    scope: { labels: [ready] }\n")
        w = roles.lane_overlaps(cfg)
        self.assertEqual(len(w), 1)
        self.assertIn("ready", w[0])

    def test_overlap_cron_same_lane_no_warn(self):
        # A cron role and a loop role in the SAME lane never warn -- the lane
        # is one worktree, serialized under one supervisor lock (no double-work).
        cfg = parse(
            "lanes:\n  main: {}\n"
            "roles:\n"
            "  coder:\n    enabled: true\n    scope: { labels: [ready] }\n"
            "  pm:\n    enabled: true\n"
            "    trigger: { type: cron, schedule: '0 9 * * *' }\n"
            "    scope: { labels: [ready] }\n")
        self.assertEqual(roles.lane_overlaps(cfg), [])


class TestLaneDispatchFilter(unittest.TestCase):
    def test_no_lanes_dispatch_identical_to_today(self):
        cfg = parse(
            "roles:\n"
            "  coder: { enabled: true }\n"
            "  qa:\n    enabled: true\n    trigger: { type: loop }\n")
        self.assertEqual(roles.dispatch_roles(cfg), roles.dispatch_roles(cfg, None))
        self.assertEqual(roles.dispatch_roles(cfg), ["coder", "qa"])

    def test_pinned_role_excluded_from_default(self):
        cfg = parse(
            "lanes:\n  main: {}\n  fe: {}\n"
            "roles:\n"
            "  coder: { enabled: true }\n"
            "  coder-fe:\n    enabled: true\n    trigger: { type: loop }\n    lane: fe\n")
        self.assertEqual(roles.dispatch_roles(cfg), ["coder"])
        self.assertEqual(roles.dispatch_roles(cfg, "fe"), ["coder-fe"])

    def test_undeclared_lane_role_excluded_everywhere(self):
        # fail-safe: never fall into default lane, never crash
        cfg = parse(
            "lanes:\n  main: {}\n"
            "roles:\n"
            "  coder: { enabled: true }\n"
            "  ghosty:\n    enabled: true\n    trigger: { type: loop }\n    lane: ghost\n")
        self.assertEqual(roles.dispatch_roles(cfg), ["coder"])
        self.assertNotIn("ghosty", roles.dispatch_roles(cfg, "main"))
        # even naming the undeclared lane explicitly must not surface it
        self.assertEqual(roles.dispatch_roles(cfg, "ghost"), [])

    def test_undeclared_lane_role_not_dispatchable(self):
        # fail-safe: settings must NOT resolve for a role pinned to a lane that
        # was never declared -- else `dispatch <repo> <role>` runs a misconfig
        cfg = parse(
            "lanes:\n  main: {}\n"
            "roles:\n"
            "  coder:\n    enabled: true\n"
            "  ghosty:\n    enabled: true\n    trigger: { type: loop }\n    lane: ghost\n")
        self.assertNotIn("ghosty", roles.dispatchable_roles(cfg))
        with self.assertRaises(KeyError):
            roles.role_settings(cfg, "ghosty")

    def test_cron_event_default_lane_only(self):
        cfg = parse(
            "lanes:\n  main: {}\n  fe: {}\n"
            "roles:\n"
            "  pm:\n    enabled: true\n    trigger: { type: cron, schedule: '0 * * * *' }\n"
            "  qa:\n    enabled: true\n    trigger: { type: event, on: [pr.opened] }\n    lane: fe\n")
        self.assertEqual([n for n, _ in roles.cron_roles(cfg)], ["pm"])
        self.assertEqual([n for n, _ in roles.event_roles(cfg)], [])
        self.assertEqual([n for n, _ in roles.event_roles(cfg, "fe")], ["qa"])

    def test_dispatchable_roles_lane_unaware(self):
        # settings guard must still resolve a role pinned to a non-default lane
        cfg = parse(
            "lanes:\n  main: {}\n  fe: {}\n"
            "roles:\n"
            "  coder: { enabled: true }\n"
            "  coder-fe:\n    enabled: true\n    trigger: { type: loop }\n    lane: fe\n")
        self.assertIn("coder-fe", roles.dispatchable_roles(cfg))


class TestLaneCLI(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.tmp, ".autonomy"))
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def _write(self, text):
        with open(os.path.join(self.tmp, ".autonomy", "config.yaml"),
                  "w", encoding="utf-8") as fh:
            fh.write(text)

    def _run(self, *argv):
        import io
        from contextlib import redirect_stdout
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = roles.main(["roles.py"] + list(argv))
        return rc, buf.getvalue()

    def test_default_lane_cli(self):
        self._write("lanes:\n  fe: {}\n  main: {}\n")
        rc, out = self._run("default-lane", self.tmp)
        self.assertEqual(rc, 0)
        self.assertEqual(out.strip(), "fe")

    def test_dispatch_with_lane_flag(self):
        self._write(
            "lanes:\n  main: {}\n  fe: {}\n"
            "roles:\n"
            "  coder: { enabled: true }\n"
            "  coder-fe:\n    enabled: true\n    trigger: { type: loop }\n    lane: fe\n")
        rc, out = self._run("dispatch", self.tmp, "--lane", "fe")
        self.assertEqual(rc, 0)
        self.assertEqual(out.split(), ["coder-fe"])

    def test_dispatch_role_and_lane_together_is_error(self):
        self._write("roles:\n  coder: { enabled: true }\n")
        rc, _ = self._run("dispatch", self.tmp, "coder", "--lane", "main")
        self.assertEqual(rc, 2)

    def test_lanes_cli_prints_declared_in_order(self):
        self._write("lanes:\n  main: {}\n  fe: {}\n")
        rc, out = self._run("lanes", self.tmp)
        self.assertEqual(rc, 0)
        self.assertEqual(out.split(), ["main", "fe"])

    def test_lanes_cli_prints_main_without_block(self):
        self._write("roles:\n  coder: { enabled: true }\n")
        rc, out = self._run("lanes", self.tmp)
        self.assertEqual(rc, 0)
        self.assertEqual(out.split(), ["main"])

    def test_lanes_cli_refuses_malformed_block(self):
        # A `lanes:` block present but not a mapping must REFUSE (rc 1), never
        # fall back to printing 'main' -- the supervisor validates --lane against
        # this output, so a broken block must not silently validate a lane.
        self._write("lanes: []\n")
        rc, out = self._run("lanes", self.tmp)
        self.assertEqual(rc, 1)
        self.assertEqual(out.strip(), "")

    def test_lanes_cli_refuses_bad_lane_name(self):
        self._write("lanes:\n  'bad/name': {}\n")
        rc, _ = self._run("lanes", self.tmp)
        self.assertEqual(rc, 1)

    def test_lane_report_silent_without_block(self):
        self._write("roles:\n  coder: { enabled: true }\n")
        rc, out = self._run("lane-report", self.tmp)
        self.assertEqual(rc, 0)
        self.assertEqual(out, "")

    def test_lane_report_declares_and_warns(self):
        self._write(
            "lanes:\n  main: {}\n  fe: {}\n"
            "roles:\n"
            "  coder: { enabled: true }\n"
            "  coder-fe:\n    enabled: true\n    trigger: { type: loop }\n    lane: fe\n")
        rc, out = self._run("lane-report", self.tmp)
        self.assertEqual(rc, 0)
        self.assertIn("OK", out)
        self.assertIn("default: main", out)
        self.assertIn("WARN", out)
        self.assertIn("Part 2", out)


class TestConfiguredScopeLabels(unittest.TestCase):
    """#171: configured_scope_labels -- the union of scope.labels across every
    enabled executable role (the single source doctor's label check reads)."""

    def test_union_across_roles_and_triggers_sorted_deduped(self):
        cfg = parse(
            "roles:\n"
            "  coder:\n    enabled: true\n    scope: { labels: [ready, bug] }\n"
            "  reviewer:\n    enabled: true\n    trigger: { type: loop }\n"
            "    scope: { labels: [bug, docs] }\n"
            "  groomer:\n    enabled: true\n"
            "    trigger: { type: cron, schedule: \"0 9 * * *\" }\n"
            "    scope: { labels: [triage] }\n")
        self.assertEqual(roles.configured_scope_labels(cfg),
                         ["bug", "docs", "ready", "triage"])

    def test_role_without_scope_contributes_nothing(self):
        cfg = parse("roles:\n  coder: { enabled: true }\n")
        self.assertEqual(roles.configured_scope_labels(cfg), [])

    def test_disabled_role_labels_ignored(self):
        cfg = parse(
            "roles:\n"
            "  coder:\n    enabled: true\n    scope: { labels: [ready] }\n"
            "  reviewer:\n    enabled: false\n    scope: { labels: [ghost] }\n")
        self.assertEqual(roles.configured_scope_labels(cfg), ["ready"])

    def test_empty_or_garbage_config(self):
        self.assertEqual(roles.configured_scope_labels({}), [])
        self.assertEqual(roles.configured_scope_labels(None), [])

    def test_lane_overlaps_still_works_after_shared_helper_refactor(self):
        # proves the _enabled_label_scopes extraction preserved lane_overlaps.
        cfg = parse(
            "lanes:\n  main: {}\n  fe: {}\n"
            "roles:\n"
            "  coder:\n    enabled: true\n    scope: { labels: [shared] }\n"
            "  coder-fe:\n    enabled: true\n    trigger: { type: loop }\n"
            "    lane: fe\n    scope: { labels: [shared] }\n")
        overlaps = roles.lane_overlaps(cfg)
        self.assertTrue(any("shared" in w for w in overlaps))


class TestScopeLabelsCli(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.tmp, ".autonomy"))
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def _write(self, text):
        with open(os.path.join(self.tmp, ".autonomy", "config.yaml"),
                  "w", encoding="utf-8") as fh:
            fh.write(text)

    def _run(self, *argv):
        import io
        from contextlib import redirect_stdout
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = roles.main(["roles.py"] + list(argv))
        return rc, buf.getvalue()

    def test_prints_sorted_labels_one_per_line(self):
        self._write(
            "roles:\n"
            "  coder:\n    enabled: true\n    scope: { labels: [ready, bug] }\n")
        rc, out = self._run("scope-labels", self.tmp)
        self.assertEqual(rc, 0)
        self.assertEqual(out.split(), ["bug", "ready"])

    def test_no_labels_prints_nothing(self):
        self._write("roles:\n  coder: { enabled: true }\n")
        rc, out = self._run("scope-labels", self.tmp)
        self.assertEqual(rc, 0)
        self.assertEqual(out.strip(), "")

    def test_unreadable_config_returns_rc2(self):
        rc, _ = self._run("scope-labels", os.path.join(self.tmp, "nope"))
        self.assertEqual(rc, 2)


if __name__ == "__main__":
    unittest.main()
