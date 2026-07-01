### Task 2: Config parser (`lib/config_parser.py`)

**Files:**
- Create: `lib/config_parser.py`
- Test: `tests/test_config_parser.py`

**Interfaces:**
- Produces: CLI `python3 lib/config_parser.py <config-file> <dotted.key>` — prints the value (one
  line per item if it's a list) and exits 0 if the key is present (including an empty map, printed
  as nothing), exits 1 if the key is absent, exits 1 with a message on stderr if the file doesn't
  parse. A special second-arg value `__validate__` parses the file and returns 0/1 without doing a
  key lookup — used by `doctor.sh`'s fast preflight check.
- Consumes: nothing (this is the first component; every later bash script calls this CLI).

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_config_parser.py
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
python3 -m unittest tests.test_config_parser -v
```
Expected: `ModuleNotFoundError` or `FileNotFoundError` (`lib/config_parser.py` doesn't exist yet).

- [ ] **Step 3: Implement `lib/config_parser.py`**

```python
#!/usr/bin/env python3
"""Restricted YAML-subset parser for .autonomy/config.yaml.

Supports exactly what config.yaml needs: nested mappings (2-space indent),
scalar strings (quoted or bare), booleans, empty maps ({}), and inline
lists (["a", "b"]). No anchors, multi-doc, block scalars, or flow mappings.
Deliberately small and dependency-free -- see the pack-seam spec's
"Parser" note for why this exists instead of PyYAML.
"""
import sys


def _strip_comment(line: str) -> str:
    in_quote = None
    out = []
    for ch in line:
        if in_quote:
            out.append(ch)
            if ch == in_quote:
                in_quote = None
            continue
        if ch in ('"', "'"):
            in_quote = ch
            out.append(ch)
            continue
        if ch == "#":
            break
        out.append(ch)
    return "".join(out)


def _parse_scalar(raw: str):
    raw = raw.strip()
    if raw == "" or raw == "{}":
        return {}
    if raw == "true":
        return True
    if raw == "false":
        return False
    if raw.startswith("[") and raw.endswith("]"):
        inner = raw[1:-1].strip()
        if not inner:
            return []
        return [_parse_scalar(p.strip()) for p in inner.split(",")]
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in ("'", '"'):
        return raw[1:-1]
    return raw


def parse(text: str) -> dict:
    root: dict = {}
    stack = [(-1, root)]
    for lineno, raw_line in enumerate(text.splitlines(), start=1):
        line = _strip_comment(raw_line).rstrip()
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip(" "))
        content = line.strip()
        if ":" not in content:
            raise ValueError(f"line {lineno}: expected 'key: value', got {content!r}")
        key, _, value = content.partition(":")
        key = key.strip()
        if not key:
            raise ValueError(f"line {lineno}: empty key")
        while stack and stack[-1][0] >= indent:
            stack.pop()
        parent = stack[-1][1]
        value = value.strip()
        if value == "":
            child: dict = {}
            parent[key] = child
            stack.append((indent, child))
        else:
            parent[key] = _parse_scalar(value)
    return root


def get(config: dict, dotted_key: str):
    node = config
    for part in dotted_key.split("."):
        if not isinstance(node, dict) or part not in node:
            raise KeyError(dotted_key)
        node = node[part]
    return node


def main(argv: list) -> int:
    if len(argv) != 3:
        print("usage: config_parser.py <config-file> <dotted.key>", file=sys.stderr)
        return 2
    path, dotted_key = argv[1], argv[2]
    with open(path, encoding="utf-8") as f:
        text = f.read()
    try:
        config = parse(text)
    except ValueError as e:
        print(str(e), file=sys.stderr)
        return 1
    if dotted_key == "__validate__":
        return 0
    try:
        value = get(config, dotted_key)
    except KeyError:
        return 1
    if isinstance(value, list):
        for item in value:
            print(item)
    elif isinstance(value, dict):
        pass
    elif isinstance(value, bool):
        print("true" if value else "false")
    else:
        print(value)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
touch tests/__init__.py
python3 -m unittest tests.test_config_parser -v
```
Expected: all 9 tests `ok`.

- [ ] **Step 5: Commit**

```bash
git add lib/config_parser.py tests/test_config_parser.py tests/__init__.py
git commit -m "feat: add restricted YAML-subset config parser"
git push
```

---

