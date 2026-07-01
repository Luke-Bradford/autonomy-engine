"""Unit tests for lib/roles.py -- the multi-role org's config schema (#12).

validate_roles is the single validation authority for the `roles:` block:
enum-checked substrate/trigger, trigger-specific required sub-fields, sane
scalars. Pure (no filesystem); prompt-file existence is a separate,
path-taking check so doctor can report it distinctly."""
import os
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


class TestDefaults(unittest.TestCase):
    def test_default_roster_shape(self):
        # single source of truth for the standard roster (dashboard imports it)
        names = [r[0] for r in roles.DEFAULT_ROLES]
        self.assertEqual(names, ["coder", "pm", "qa", "researcher"])
        coder = roles.DEFAULT_ROLES[0]
        self.assertEqual(coder, ("coder", True, "engine", "loop"))
        # only coder enabled by default
        self.assertTrue(all(not r[1] for r in roles.DEFAULT_ROLES[1:]))


if __name__ == "__main__":
    unittest.main()
