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

    def test_flow_list_inside_flow_mapping(self):
        # PR #33 review: commas inside a bracketed value must not split the
        # mapping -- `on: [a, b]` is one entry
        cfg = config_parser.parse("t: { type: event, on: [a, b] }\n")
        self.assertEqual(cfg["t"], {"type": "event", "on": ["a", "b"]})

    def test_nested_flow_mapping_still_rejected_with_depth_tracking(self):
        with self.assertRaises(ValueError):
            config_parser.parse("t: { a: { b: c }, d: e }\n")


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


class TestSetCli(unittest.TestCase):
    """#38: `config_parser.py --set <file> <dotted.key> <value>` -- the CLI
    face of set_scalar so bash callers (quickstart.sh) can write config
    without reimplementing YAML editing. Writes are atomic and the result
    must still parse, or the file is left untouched."""
    TEXT = (
        "# pack config\n"
        "board:\n"
        "  owner: CHANGE-ME          # GitHub user or org\n"
        '  project_title: "CHANGE-ME engineering board"\n'
        "agent:\n"
        "  type: claude               # claude | codex\n"
        "  model:\n"
        "    primary: claude-sonnet-5\n"
        "merge_gate:\n"
        "  strategy: manual\n"
    )

    def write_tmp(self, text):
        with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
            f.write(text)
            return f.name

    def run_set(self, path, key, value):
        return subprocess.run(
            [sys.executable, str(PARSER), "--set", path, key, value],
            capture_output=True, text=True,
        )

    def read_back(self, path, key):
        proc = subprocess.run(
            [sys.executable, str(PARSER), path, key],
            capture_output=True, text=True,
        )
        return proc.returncode, proc.stdout

    def test_set_bare_value(self):
        path = self.write_tmp(self.TEXT)
        proc = self.run_set(path, "merge_gate.strategy", "ci_only")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        rc, out = self.read_back(path, "merge_gate.strategy")
        self.assertEqual((rc, out), (0, "ci_only\n"))

    def test_set_preserves_comments_and_other_lines(self):
        path = self.write_tmp(self.TEXT)
        self.run_set(path, "board.owner", "some-org")
        text = Path(path).read_text()
        self.assertIn("# pack config\n", text)
        self.assertIn("owner: some-org          # GitHub user or org\n", text)
        self.assertIn("  type: claude               # claude | codex\n", text)

    def test_set_value_with_spaces_round_trips(self):
        path = self.write_tmp(self.TEXT)
        proc = self.run_set(path, "board.project_title", "My Fancy Board")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        rc, out = self.read_back(path, "board.project_title")
        self.assertEqual((rc, out), (0, "My Fancy Board\n"))

    def test_set_value_with_hash_round_trips(self):
        # unquoted, '#' would be comment-stripped on read-back -- must quote
        path = self.write_tmp(self.TEXT)
        proc = self.run_set(path, "board.project_title", "team #1 board")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        rc, out = self.read_back(path, "board.project_title")
        self.assertEqual((rc, out), (0, "team #1 board\n"))

    def test_set_same_value_is_byte_identical(self):
        path = self.write_tmp(self.TEXT)
        proc = self.run_set(path, "agent.model.primary", "claude-sonnet-5")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(Path(path).read_text(), self.TEXT)

    def test_set_missing_parent_fails_and_leaves_file_untouched(self):
        path = self.write_tmp(self.TEXT)
        proc = self.run_set(path, "nonexistent.block.key", "x")
        self.assertEqual(proc.returncode, 1)
        self.assertNotEqual(proc.stderr, "")
        self.assertEqual(Path(path).read_text(), self.TEXT)

    def test_set_mapping_target_fails_and_leaves_file_untouched(self):
        path = self.write_tmp(self.TEXT)
        proc = self.run_set(path, "agent.model", "flat")
        self.assertEqual(proc.returncode, 1)
        self.assertEqual(Path(path).read_text(), self.TEXT)

    def test_set_on_unparseable_file_fails_and_leaves_file_untouched(self):
        bad = "this line has no colon whatsoever\n"
        path = self.write_tmp(bad)
        proc = self.run_set(path, "board.owner", "x")
        self.assertEqual(proc.returncode, 1)
        self.assertEqual(Path(path).read_text(), bad)

    def test_set_preserves_file_permissions(self):
        # PR #39 review (WARNING): the atomic tmp+replace write must not
        # narrow the config's mode to mkstemp's 0600
        import os
        import stat
        path = self.write_tmp(self.TEXT)
        os.chmod(path, 0o644)
        proc = self.run_set(path, "board.owner", "some-org")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o644)

    def test_set_value_with_both_quote_kinds_is_refused(self):
        # the restricted parser has no escape support: a value that contains
        # both quote characters cannot be written safely -- refuse
        path = self.write_tmp(self.TEXT)
        proc = self.run_set(path, "board.project_title", "a\"b'c")
        self.assertEqual(proc.returncode, 1)
        self.assertEqual(Path(path).read_text(), self.TEXT)


class TestAgentOrgShapes(unittest.TestCase):
    """Increment-2 schema shapes (agent-org design spec, Layer 2) -- the
    restricted parser must keep handling these exact forms."""

    def test_models_flow_mapping(self):
        cfg = config_parser.parse(
            "roles:\n  coder:\n"
            "    models: { plan: claude-opus-4-8, implement: claude-sonnet-5, test: claude-haiku-4-5 }\n")
        self.assertEqual(cfg["roles"]["coder"]["models"],
                         {"plan": "claude-opus-4-8",
                          "implement": "claude-sonnet-5",
                          "test": "claude-haiku-4-5"})

    def test_scope_flow_mapping_with_list(self):
        cfg = config_parser.parse(
            "roles:\n  coder:\n"
            "    scope: { labels: [ready, bug], milestone: current }\n")
        self.assertEqual(cfg["roles"]["coder"]["scope"],
                         {"labels": ["ready", "bug"], "milestone": "current"})

    def test_scope_block_form(self):
        cfg = config_parser.parse(
            "roles:\n  qa:\n    scope:\n      target: diff\n")
        self.assertEqual(cfg["roles"]["qa"]["scope"], {"target": "diff"})

    def test_regression_after_tickets(self):
        cfg = config_parser.parse(
            "roles:\n  qa:\n    regression: { after_tickets: 10 }\n")
        self.assertEqual(cfg["roles"]["qa"]["regression"], {"after_tickets": "10"})

    def test_regression_every_cron(self):
        cfg = config_parser.parse(
            'roles:\n  qa:\n    regression: { every: "0 3 * * 0" }\n')
        self.assertEqual(cfg["roles"]["qa"]["regression"], {"every": "0 3 * * 0"})

    def test_tools_and_duties_inline_lists(self):
        cfg = config_parser.parse(
            "roles:\n  qa:\n    tools: [read, mcp]\n  pm:\n"
            "    duties: [groom, prioritise, unblock, spec-check]\n")
        self.assertEqual(cfg["roles"]["qa"]["tools"], ["read", "mcp"])
        self.assertEqual(cfg["roles"]["pm"]["duties"],
                         ["groom", "prioritise", "unblock", "spec-check"])


class TestEffectiveConfigPath(unittest.TestCase):
    """Workstreams slice 1: the var-live shadow resolver -- the SINGLE choke
    point that makes every reader (bash via the CLI, python via the API)
    agree on which config file is the truth. Committed .autonomy/config.yaml
    seeds; var/autonomy/config.yaml, when present, IS the effective config."""

    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.repo = Path(self._td.name)
        (self.repo / ".autonomy").mkdir()
        self.committed = self.repo / ".autonomy" / "config.yaml"
        self.committed.write_text("agent:\n  model:\n    primary: committed-model\n")
        self.live = self.repo / "var" / "autonomy" / "config.yaml"

    def tearDown(self):
        self._td.cleanup()

    def _mklive(self):
        self.live.parent.mkdir(parents=True)
        self.live.write_text("agent:\n  model:\n    primary: live-model\n")

    def test_no_live_returns_original(self):
        p = config_parser.effective_config_path(str(self.committed))
        self.assertEqual(p, str(self.committed))

    def test_live_present_returns_live(self):
        self._mklive()
        p = config_parser.effective_config_path(str(self.committed))
        self.assertEqual(p, str(self.live))

    def test_non_pack_path_never_resolves(self):
        other = self.repo / "settings.yaml"
        other.write_text("a: b\n")
        self._mklive()
        self.assertEqual(config_parser.effective_config_path(str(other)), str(other))

    def test_cli_reads_live_value_when_present(self):
        self._mklive()
        out = subprocess.run(
            [sys.executable, str(PARSER), str(self.committed), "agent.model.primary"],
            capture_output=True, text=True)
        self.assertEqual(out.stdout.strip(), "live-model")
        self.assertEqual(out.returncode, 0)

    def test_cli_reads_committed_without_live(self):
        out = subprocess.run(
            [sys.executable, str(PARSER), str(self.committed), "agent.model.primary"],
            capture_output=True, text=True)
        self.assertEqual(out.stdout.strip(), "committed-model")

    def test_set_cli_targets_the_committed_file(self):
        # quickstart --set is setup-time: it edits the SHAREABLE default,
        # never the live shadow (which the dashboard writer owns).
        self._mklive()
        subprocess.run(
            [sys.executable, str(PARSER), "--set", str(self.committed),
             "agent.model.primary", "new-model"], capture_output=True)
        self.assertIn("new-model", self.committed.read_text())
        self.assertIn("live-model", self.live.read_text())


if __name__ == "__main__":
    unittest.main()
