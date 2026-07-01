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
