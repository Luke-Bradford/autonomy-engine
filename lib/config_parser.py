#!/usr/bin/env python3
"""Restricted YAML-subset parser for .autonomy/config.yaml.

Supports exactly what config.yaml needs: nested mappings (2-space indent),
scalar strings (quoted or bare), booleans, empty maps ({}), and inline
lists (["a", "b"]). No anchors, multi-doc, block scalars, or flow mappings.
Deliberately small and dependency-free -- see the pack-seam spec's
"Parser" note for why this exists instead of PyYAML.
"""
import os
import stat
import sys
import tempfile


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


def _split_top(inner: str) -> list:
    """Split flow-collection innards on top-level commas, respecting quotes
    and bracket/brace depth (a comma inside `[a, b]` is not a separator)."""
    parts, buf, quote, depth = [], [], None, 0
    for ch in inner:
        if quote:
            buf.append(ch)
            if ch == quote:
                quote = None
        elif ch in ('"', "'"):
            quote = ch
            buf.append(ch)
        elif ch in ("[", "{"):
            depth += 1
            buf.append(ch)
        elif ch in ("]", "}"):
            depth -= 1
            buf.append(ch)
        elif ch == "," and depth == 0:
            parts.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
    if buf or parts:
        parts.append("".join(buf))
    return parts


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
        return [_parse_scalar(p.strip()) for p in _split_top(inner)]
    if raw.startswith("{") and raw.endswith("}"):
        # inline flow mapping, ONE level of scalar values -- exactly what the
        # roles schema uses (`trigger: { type: cron, schedule: "..." }`).
        out = {}
        for part in _split_top(raw[1:-1].strip()):
            part = part.strip()
            if ":" not in part:
                raise ValueError(f"flow mapping entry needs 'key: value', got {part!r}")
            key, _, value = part.partition(":")
            value = value.strip()
            if value.startswith("{"):
                raise ValueError("nested flow mappings are not supported")
            out[key.strip()] = _parse_scalar(value)
        return out
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


def set_scalar(text: str, dotted_key: str, value: str) -> str:
    """Rewrite ONE scalar in config text, preserving every other byte --
    comments (incl. the edited line's trailing comment), blank lines, order.
    If the leaf key is missing but its parent mapping exists, a new line is
    inserted directly under the parent. Raises KeyError when the parent path
    doesn't exist, ValueError when the target is a mapping (not a scalar).
    Powers the dashboard's 'save as default' write-back (#24)."""
    parts = dotted_key.split(".")
    lines = text.splitlines(True)
    stack = []  # [(indent, key), ...] path to the current line
    parent_line = None  # index of the line that opens the parent mapping
    parent_indent = 0
    for i, raw_line in enumerate(lines):
        line = _strip_comment(raw_line).rstrip()
        if not line.strip() or ":" not in line.strip():
            continue
        indent = len(line) - len(line.lstrip(" "))
        key, _, val = line.strip().partition(":")
        key = key.strip()
        while stack and stack[-1][0] >= indent:
            stack.pop()
        stack.append((indent, key))
        path = [k for _, k in stack]
        if path == parts:
            if val.strip() == "" and i + 1 < len(lines):
                # key opens a mapping (children more indented) -> refuse
                nxt = _strip_comment(lines[i + 1]).rstrip()
                if nxt.strip() and len(nxt) - len(nxt.lstrip(" ")) > indent:
                    raise ValueError("%s is a mapping, not a scalar" % dotted_key)
            # replace the value, keep indentation + any trailing comment
            body = raw_line.rstrip("\n")
            head = body[:indent] + key + ":"
            rest = body[len(_strip_comment(body).rstrip()):]  # the comment tail
            lines[i] = head + " " + str(value) + rest + "\n"
            return "".join(lines)
        if path == parts[:-1]:
            parent_line, parent_indent = i, indent
    if parent_line is None:
        raise KeyError(dotted_key)
    new = " " * (parent_indent + 2) + parts[-1] + ": " + str(value) + "\n"
    lines.insert(parent_line + 1, new)
    return "".join(lines)


def _cli_str(value) -> str:
    """Render a parsed scalar exactly the way the get CLI prints it, so
    --set can compare 'current' with the incoming string value."""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _format_scalar(value: str) -> str:
    """Format a string value for writing: bare when every character is safe
    for the restricted parser, else quoted with whichever quote the value
    doesn't contain. The parser has no escape support, so a value holding
    BOTH quote kinds cannot be written -- refuse."""
    if value == "":
        return '""'
    if all(c.isalnum() or c in "._/-" for c in value):
        return value
    if '"' not in value:
        return '"' + value + '"'
    if "'" not in value:
        return "'" + value + "'"
    raise ValueError(
        "value contains both single and double quotes -- "
        "unsupported by the restricted parser")


def _set_cli(path: str, dotted_key: str, value: str) -> int:
    """`--set <file> <key> <value>`: comment-preserving scalar write for
    bash callers (quickstart.sh, #38). Atomic (tmp + os.replace in the same
    directory); the file is left untouched on any failure. Setting the
    already-current value is a byte-identical no-op."""
    with open(path, encoding="utf-8") as f:
        text = f.read()
    try:
        config = parse(text)
    except ValueError as e:
        print("config_parser.py --set: refusing to edit a file that does not "
              "parse: %s" % e, file=sys.stderr)
        return 1
    try:
        current = get(config, dotted_key)
    except KeyError:
        current = None  # missing leaf: set_scalar inserts under the parent
    if isinstance(current, (str, bool, int, float)) and _cli_str(current) == value:
        return 0
    try:
        new_text = set_scalar(text, dotted_key, _format_scalar(value))
        reread = get(parse(new_text), dotted_key)
    except (KeyError, ValueError) as e:
        print("config_parser.py --set: %s" % e, file=sys.stderr)
        return 1
    if _cli_str(reread) != value:
        print("config_parser.py --set: refusing -- written value would read "
              "back as %r" % reread, file=sys.stderr)
        return 1
    directory = os.path.dirname(os.path.abspath(path))
    fd, tmp_path = tempfile.mkstemp(dir=directory, prefix=".config-set-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(new_text)
        # mkstemp creates 0600; keep the config's own mode (PR #39 review)
        os.chmod(tmp_path, stat.S_IMODE(os.stat(path).st_mode))
        os.replace(tmp_path, path)
    except BaseException:
        os.unlink(tmp_path)
        raise
    return 0


def main(argv: list) -> int:
    if len(argv) == 5 and argv[1] == "--set":
        return _set_cli(argv[2], argv[3], argv[4])
    if len(argv) != 3:
        print("usage: config_parser.py <config-file> <dotted.key>\n"
              "       config_parser.py --set <config-file> <dotted.key> <value>",
              file=sys.stderr)
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
