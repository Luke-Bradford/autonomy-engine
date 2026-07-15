"""Tests for lib/review_prompt.py -- the scope-aware review charter (#468).

The bug these lock down: the review bot's charter was hardcoded to the bash/
Python engine, so a `studio/` TypeScript diff got reviewed by a bot told it
reviews bash. It answered "none of the stated invariants apply here" and then
emitted an ARBITRARY verdict -- six studio PRs merged on APPROVEs that certified
nothing, and PR #466 drew NEEDS DISCUSSION off identical reasoning.

These call the real functions with real path lists -- no mocks.
"""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ENGINE_ROOT = Path(__file__).resolve().parent.parent
CLI = ENGINE_ROOT / "lib" / "review_prompt.py"

sys.path.insert(0, str(ENGINE_ROOT / "lib"))
import review_prompt  # noqa: E402

# Distinguishing markers: a rule that appears in exactly one charter.
ENGINE_MARKER = "3.2.57"          # bash-3.2 rule -- engine only
STUDIO_MARKER = "reducer is PURE"  # reducer purity -- studio only

STUDIO_FILES = [
    "studio/packages/server/src/scheduler/alarms.ts",
    "studio/packages/shared/src/schemas/wakeup.ts",
]
ENGINE_FILES = ["bin/supervisor.sh", "lib/config_parser.py"]


class TestClassifyScope(unittest.TestCase):
    def test_studio_only_diff_is_studio(self):
        self.assertEqual(review_prompt.classify_scope(STUDIO_FILES), review_prompt.SCOPE_STUDIO)

    def test_engine_only_diff_is_engine(self):
        self.assertEqual(review_prompt.classify_scope(ENGINE_FILES), review_prompt.SCOPE_ENGINE)

    def test_mixed_diff_is_mixed(self):
        self.assertEqual(
            review_prompt.classify_scope(STUDIO_FILES + ENGINE_FILES),
            review_prompt.SCOPE_MIXED,
        )

    def test_studio_docs_still_count_as_studio(self):
        self.assertEqual(
            review_prompt.classify_scope(["studio/docs/2026-07-14-foundation-overview.md"]),
            review_prompt.SCOPE_STUDIO,
        )

    def test_a_path_merely_containing_studio_is_not_studio(self):
        # `docs/studio-notes.md` is an ENGINE path -- only the `studio/` PREFIX counts.
        self.assertEqual(
            review_prompt.classify_scope(["docs/studio-notes.md", "bin/studio_helper.sh"]),
            review_prompt.SCOPE_ENGINE,
        )

    # --- fail-safe: prevention-log #3, a silent fallback that widens = fail-open ---

    def test_empty_file_list_is_mixed_not_skip(self):
        self.assertEqual(review_prompt.classify_scope([]), review_prompt.SCOPE_MIXED)

    def test_none_file_list_is_mixed_not_skip(self):
        self.assertEqual(review_prompt.classify_scope(None), review_prompt.SCOPE_MIXED)

    def test_blank_entries_are_mixed_not_skip(self):
        self.assertEqual(review_prompt.classify_scope(["", "   "]), review_prompt.SCOPE_MIXED)


class TestBuildSystemRules(unittest.TestCase):
    def test_studio_charter_omits_engine_bash_rules(self):
        """THE #468 REGRESSION: a studio diff must never be judged by bash-3.2 rules."""
        rules = review_prompt.build_system_rules(review_prompt.SCOPE_STUDIO)
        self.assertNotIn(ENGINE_MARKER, rules)
        self.assertNotIn("mapfile", rules)
        self.assertNotIn("PyYAML", rules)

    def test_studio_charter_carries_studio_invariants(self):
        rules = review_prompt.build_system_rules(review_prompt.SCOPE_STUDIO)
        self.assertIn(STUDIO_MARKER, rules)
        self.assertIn("run_events", rules)
        self.assertIn("IMMUTABLE pipeline version", rules)
        self.assertIn("No fail-open", rules)
        self.assertIn("TypeScript", rules)

    def test_studio_charter_states_the_engine_rules_do_not_apply(self):
        """The bot must be told EXPLICITLY, or it re-derives 'out of scope'."""
        rules = review_prompt.build_system_rules(review_prompt.SCOPE_STUDIO)
        self.assertIn("EXEMPT", rules)

    def test_engine_charter_unchanged_in_substance(self):
        rules = review_prompt.build_system_rules(review_prompt.SCOPE_ENGINE)
        self.assertIn(ENGINE_MARKER, rules)
        self.assertIn("repo-agnostic", rules)
        self.assertIn("Merge-gate fail-safe", rules)
        self.assertNotIn(STUDIO_MARKER, rules)

    def test_mixed_charter_carries_both(self):
        rules = review_prompt.build_system_rules(review_prompt.SCOPE_MIXED)
        self.assertIn(ENGINE_MARKER, rules)
        self.assertIn(STUDIO_MARKER, rules)

    def test_mixed_charter_scopes_each_ruleset_to_its_own_tree(self):
        rules = review_prompt.build_system_rules(review_prompt.SCOPE_MIXED)
        self.assertIn("ONLY to files under its own tree", rules)

    def test_unknown_scope_falls_back_to_both_never_none(self):
        """Fail-safe: an unrecognised scope reviews MORE strictly, never less."""
        rules = review_prompt.build_system_rules("wat")
        self.assertIn(ENGINE_MARKER, rules)
        self.assertIn(STUDIO_MARKER, rules)

    def test_every_charter_binds_the_verdict_to_the_findings(self):
        """#468 root cause: an unbound verdict is a coin-flip an automated rail reads."""
        for scope in (
            review_prompt.SCOPE_STUDIO,
            review_prompt.SCOPE_ENGINE,
            review_prompt.SCOPE_MIXED,
        ):
            rules = review_prompt.build_system_rules(scope)
            self.assertIn("Verdict discipline", rules, scope)
            self.assertIn("Any [BLOCKING] finding -> **REQUEST CHANGES**", rules, scope)
            self.assertIn("No [BLOCKING] findings -> **APPROVE**", rules, scope)
            # NEEDS DISCUSSION must be barred as an "out of charter" escape hatch.
            self.assertIn("Never use it to mean 'this is outside my charter'", rules, scope)

    def test_every_charter_keeps_the_diff_only_discipline(self):
        for scope in (
            review_prompt.SCOPE_STUDIO,
            review_prompt.SCOPE_ENGINE,
            review_prompt.SCOPE_MIXED,
        ):
            rules = review_prompt.build_system_rules(scope)
            self.assertIn("Review ONLY the diff", rules, scope)


class TestBuildPayload(unittest.TestCase):
    def test_payload_shape_and_cache_control(self):
        p = review_prompt.build_payload(review_prompt.SCOPE_STUDIO, "diff", "desc", "comments")
        self.assertEqual(p["model"], "claude-sonnet-5")
        self.assertEqual(p["max_tokens"], 16000)
        self.assertEqual(p["system"][0]["cache_control"], {"type": "ephemeral"})
        self.assertIn(STUDIO_MARKER, p["system"][0]["text"])

    def test_payload_embeds_diff_description_and_comments(self):
        p = review_prompt.build_payload(
            review_prompt.SCOPE_ENGINE, "THEDIFF", "THEDESC", "THECOMMENTS"
        )
        content = p["messages"][0]["content"]
        self.assertIn("THEDIFF", content)
        self.assertIn("THEDESC", content)
        self.assertIn("THECOMMENTS", content)

    def test_empty_comments_render_a_placeholder(self):
        p = review_prompt.build_payload(review_prompt.SCOPE_ENGINE, "d", "desc", "")
        self.assertIn("(no comments yet)", p["messages"][0]["content"])


class TestCli(unittest.TestCase):
    """Drive the real CLI the workflow calls -- end to end, no mocks."""

    def _run(self, files_text):
        with tempfile.TemporaryDirectory() as td:
            d = Path(td)
            (d / "files.txt").write_text(files_text)
            (d / "pr.diff").write_text("+ some diff")
            (d / "desc.txt").write_text("# title")
            (d / "comments.txt").write_text("")
            out = d / "request.json"
            proc = subprocess.run(
                [
                    sys.executable,
                    str(CLI),
                    str(d / "files.txt"),
                    str(d / "pr.diff"),
                    str(d / "desc.txt"),
                    str(d / "comments.txt"),
                    str(out),
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            return json.loads(out.read_text()), proc.stdout

    def test_cli_studio_diff_writes_studio_charter(self):
        payload, stdout = self._run("studio/packages/server/src/scheduler/alarms.ts\n")
        self.assertIn("scope=studio", stdout)
        self.assertIn(STUDIO_MARKER, payload["system"][0]["text"])
        self.assertNotIn(ENGINE_MARKER, payload["system"][0]["text"])

    def test_cli_engine_diff_writes_engine_charter(self):
        payload, stdout = self._run("bin/supervisor.sh\n")
        self.assertIn("scope=engine", stdout)
        self.assertIn(ENGINE_MARKER, payload["system"][0]["text"])

    def test_cli_mixed_diff_writes_both(self):
        payload, stdout = self._run("bin/supervisor.sh\nstudio/packages/shared/src/x.ts\n")
        self.assertIn("scope=mixed", stdout)
        self.assertIn(ENGINE_MARKER, payload["system"][0]["text"])
        self.assertIn(STUDIO_MARKER, payload["system"][0]["text"])

    def test_cli_missing_files_list_still_produces_a_charter(self):
        """A read failure must not silently produce a charter-less review."""
        with tempfile.TemporaryDirectory() as td:
            d = Path(td)
            (d / "pr.diff").write_text("+ diff")
            (d / "desc.txt").write_text("t")
            (d / "comments.txt").write_text("")
            out = d / "request.json"
            proc = subprocess.run(
                [
                    sys.executable,
                    str(CLI),
                    str(d / "does-not-exist.txt"),
                    str(d / "pr.diff"),
                    str(d / "desc.txt"),
                    str(d / "comments.txt"),
                    str(out),
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            payload = json.loads(out.read_text())
            # unreadable -> MIXED -> BOTH charters, never none
            self.assertIn(ENGINE_MARKER, payload["system"][0]["text"])
            self.assertIn(STUDIO_MARKER, payload["system"][0]["text"])

    def test_cli_rejects_wrong_arg_count(self):
        proc = subprocess.run([sys.executable, str(CLI), "only-one"], capture_output=True, text=True)
        self.assertEqual(proc.returncode, 2)


if __name__ == "__main__":
    unittest.main()
