import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ENGINE_ROOT = Path(__file__).resolve().parent.parent
PARSER = ENGINE_ROOT / "lib" / "config_parser.py"

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


if __name__ == "__main__":
    unittest.main()
