#!/usr/bin/env python3
"""Machine-local engine settings -- ONE obvious place for simple host config
like the dashboard port.

File: ~/.config/autonomy/settings   (override with $AUTONOMY_SETTINGS)
Format: `key = value` lines; `#` comments and blank lines ignored. Stdlib only.

This is distinct from the two config surfaces that already exist:
  - ~/.config/autonomy/repos          -- the loop-repo registry (one path/line)
  - <repo>/.autonomy/config.yaml      -- per-target-repo pack (board, model, gate)
Settings here are about THIS machine hosting the control room (e.g. the port),
not about any one repo. Absent file -> all defaults, so it's optional.
"""
import os

SETTINGS_FILE = os.environ.get(
    "AUTONOMY_SETTINGS", os.path.expanduser("~/.config/autonomy/settings"))

DEFAULT_PORT = 8787


def read(path=None):
    """Parse the settings file into a {key: value} dict of strings. Returns {}
    if the file is absent or unreadable -- settings are always optional."""
    out = {}
    try:
        with open(path or SETTINGS_FILE) as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                if key:
                    out[key] = value.strip()
    except OSError:
        pass
    return out


def get(key, default=None, path=None):
    """One setting's value (string), or `default` if unset."""
    return read(path).get(key, default)


def port(default=DEFAULT_PORT, path=None):
    """The dashboard port from settings, falling back to `default`. A missing or
    non-integer / out-of-range value falls back too -- a bad setting must never
    crash the launcher, just use the default."""
    raw = get("port", None, path)
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return default
    return n if 1 <= n <= 65535 else default


if __name__ == "__main__":
    # `python3 lib/settings.py port` prints the resolved port -- the shell
    # launchers read it this way (no bash YAML/int parsing needed).
    import sys
    what = sys.argv[1] if len(sys.argv) > 1 else "port"
    if what == "port":
        print(port())
    else:
        print(get(what, ""))
