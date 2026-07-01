import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ENGINE_ROOT = Path(__file__).resolve().parent.parent
PARSER = ENGINE_ROOT / "lib" / "config_parser.py"

sys.path.insert(0, str(ENGINE_ROOT / "lib"))
import config_parser  # noqa: E402

SAMPLE = """\
board:
  owner: Luke-Bradford
  project_title: "eBull engineering board"

agent:
  type: claude
  model:
    primary: claude-sonnet-5
    fallback: claude-sonnet-4-6
  config: {}

merge_gate:
  strategy: bot_comment
  author_login: github-actions
  marker: "Claude Code Review"
  doc_only_extensions: [".md"]

worktree:
  default_path: "../.{repo-slug}-autonomy"
"""


def run_parser(config_text: str, key: str):
    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
        f.write(config_text)
        path = f.name
    proc = subprocess.run(
        [sys.executable, str(PARSER), path, key],
        capture_output=True, text=True,
    )
    return proc.returncode, proc.stdout


class TestConfigParser(unittest.TestCase):
    def test_top_level_string(self):
        rc, out = run_parser(SAMPLE, "board.owner")
        self.assertEqual(rc, 0)
        self.assertEqual(out, "Luke-Bradford\n")

    def test_quoted_string_with_spaces(self):
        rc, out = run_parser(SAMPLE, "board.project_title")
        self.assertEqual(rc, 0)
        self.assertEqual(out, "eBull engineering board\n")

    def test_two_levels_of_nesting(self):
        rc, out = run_parser(SAMPLE, "agent.model.primary")
        self.assertEqual(rc, 0)
        self.assertEqual(out, "claude-sonnet-5\n")

    def test_list_value(self):
        rc, out = run_parser(SAMPLE, "merge_gate.doc_only_extensions")
        self.assertEqual(rc, 0)
        self.assertEqual(out, ".md\n")

    def test_empty_map_present_exits_zero_no_output(self):
        rc, out = run_parser(SAMPLE, "agent.config")
        self.assertEqual(rc, 0)
        self.assertEqual(out, "")

    def test_missing_key_exits_one(self):
        rc, out = run_parser(SAMPLE, "merge_gate.reviewer_login")
        self.assertEqual(rc, 1)
        self.assertEqual(out, "")

    def test_comment_stripped(self):
        text = "board:\n  owner: someone  # a trailing comment\n"
        rc, out = run_parser(text, "board.owner")
        self.assertEqual(rc, 0)
        self.assertEqual(out, "someone\n")

    def test_validate_mode_on_good_file(self):
        rc, out = run_parser(SAMPLE, "__validate__")
        self.assertEqual(rc, 0)

    def test_validate_mode_on_bad_file(self):
        rc, out = run_parser("this line has no colon whatsoever\n", "__validate__")
        self.assertEqual(rc, 1)


class TestFlowMapping(unittest.TestCase):
    """#12: the roles design uses inline flow mappings -- `trigger: { type:
    loop }` / `{ type: cron, schedule: "0 */6 * * *" }`. One level deep,
    scalar values only (matches the design doc exactly, nothing more)."""
    def test_simple_flow_mapping(self):
        cfg = config_parser.parse("trigger: { type: loop }\n")
        self.assertEqual(cfg["trigger"], {"type": "loop"})

    def test_flow_mapping_with_quoted_value(self):
        cfg = config_parser.parse('trigger: { type: cron, schedule: "0 */6 * * *" }\n')
        self.assertEqual(cfg["trigger"], {"type": "cron", "schedule": "0 */6 * * *"})

    def test_flow_mapping_nested_under_block(self):
        cfg = config_parser.parse(
            "roles:\n  coder:\n    enabled: true\n    trigger: { type: loop }\n")
        self.assertEqual(config_parser.get(cfg, "roles.coder.trigger.type"), "loop")
        self.assertIs(config_parser.get(cfg, "roles.coder.enabled"), True)

    def test_flow_list_still_works(self):
        cfg = config_parser.parse('on: [a, "b c"]\n')
        self.assertEqual(cfg["on"], ["a", "b c"])

    def test_quoted_comma_stays_in_value(self):
        cfg = config_parser.parse('m: { a: "x, y", b: z }\n')
        self.assertEqual(cfg["m"], {"a": "x, y", "b": "z"})

    def test_nested_flow_mapping_rejected(self):
        with self.assertRaises(ValueError):
            config_parser.parse("t: { a: { b: c } }\n")


class TestSetScalar(unittest.TestCase):
    """set_scalar rewrites ONE scalar in config text while preserving every
    other byte -- comments, blank lines, ordering (#24's 'save default')."""
    TEXT = (
        "# pack config\n"
        "agent:\n"
        "  type: claude               # claude | codex\n"
        "  model:\n"
        "    primary: claude-sonnet-5\n"
        "    fallback: claude-sonnet-4-6\n"
        "\n"
        "merge_gate:\n"
        "  strategy: manual\n"
    )

    def test_replaces_value_preserving_everything_else(self):
        out = config_parser.set_scalar(self.TEXT, "agent.model.primary", "claude-opus-4-8")
        self.assertIn("    primary: claude-opus-4-8\n", out)
        # everything else byte-identical
        self.assertIn("# pack config\n", out)
        self.assertIn("  type: claude               # claude | codex\n", out)
        self.assertIn("    fallback: claude-sonnet-4-6\n", out)
        self.assertIn("  strategy: manual\n", out)
        # and the new text still parses to the new value
        self.assertEqual(config_parser.get(config_parser.parse(out),
                                           "agent.model.primary"), "claude-opus-4-8")

    def test_keeps_trailing_comment_on_the_edited_line(self):
        text = "agent:\n  model:\n    primary: claude-sonnet-5  # main model\n"
        out = config_parser.set_scalar(text, "agent.model.primary", "claude-opus-4-8")
        self.assertIn("    primary: claude-opus-4-8  # main model\n", out)

    def test_inserts_missing_leaf_under_existing_parent(self):
        # agent.effort doesn't exist -> inserted directly under agent:
        out = config_parser.set_scalar(self.TEXT, "agent.effort", "high")
        self.assertEqual(config_parser.get(config_parser.parse(out),
                                           "agent.effort"), "high")
        # the rest untouched
        self.assertEqual(config_parser.get(config_parser.parse(out),
                                           "agent.model.primary"), "claude-sonnet-5")

    def test_missing_parent_raises(self):
        with self.assertRaises(KeyError):
            config_parser.set_scalar(self.TEXT, "nonexistent.block.key", "x")

    def test_refuses_to_overwrite_a_mapping(self):
        with self.assertRaises(ValueError):
            config_parser.set_scalar(self.TEXT, "agent.model", "flat-value")


if __name__ == "__main__":
    unittest.main()
