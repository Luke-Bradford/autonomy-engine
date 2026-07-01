#!/usr/bin/env python3
"""Role config schema for the multi-role org (#12) -- the single source of
truth for role enums, the standard roster's defaults, and `roles:` block
validation. Stdlib only.

The schema (docs/agent-org-design.md):

    roles:
      <name>:
        enabled: true|false
        substrate: engine | managed_agents | routine | actions
        trigger: { type: loop | cron | event, ... }   # or block form
        instances: <positive int>          # optional (parallel loop count)
        prompt: .autonomy/roles/<name>.md  # optional, repo-relative pack file

Trigger-specific requirements: cron needs `schedule`; event needs a non-empty
`on` list. An absent `roles:` block is valid -- the engine's defaults apply
(only the coder loop enabled).

Two checks, deliberately split: `validate_roles` is pure (shape/enums, no
filesystem); `check_prompt_files` takes the repo root and verifies prompt
paths are repo-relative pack files that exist. doctor.sh runs both via the
CLI entry `python3 lib/roles.py <target-repo>`, whose exit code carries the
whole verdict so callers never re-parse the config:
  0 = valid, roles: block present   3 = valid, no roles: block (defaults)
  1 = invalid (one error per stdout line)   2 = config unreadable
"""
import os
import sys
from datetime import datetime, timedelta, timezone

VALID_SUBSTRATES = ("engine", "managed_agents", "routine", "actions")
VALID_TRIGGERS = ("loop", "cron", "event")

# The standard roster and its defaults: (name, enabled, substrate, trigger).
# Only the coder loop is on by default; everything else is an explicit,
# per-repo opt-in. The dashboard renders this same roster.
DEFAULT_ROLES = (
    ("coder", True, "engine", "loop"),
    ("pm", False, "managed_agents", "cron"),
    ("qa", False, "routine", "event"),
    ("researcher", False, "managed_agents", "cron"),
)


def _is_positive_int(v):
    try:
        return int(str(v)) > 0
    except (TypeError, ValueError):
        return False


def validate_roles(config):
    """Shape/enum validation of the parsed config's `roles:` block. Returns a
    list of human-readable error strings, [] when valid (or when absent)."""
    errors = []
    roles = config.get("roles") if isinstance(config, dict) else None
    if not roles:
        return errors
    if not isinstance(roles, dict):
        return ["roles: must be a mapping of role name -> settings"]
    for name, cfg in roles.items():
        if not isinstance(cfg, dict):
            errors.append("roles.%s: must be a mapping (got %r)" % (name, cfg))
            continue
        substrate = cfg.get("substrate")
        if substrate is not None and substrate not in VALID_SUBSTRATES:
            errors.append("roles.%s: unknown substrate %r (valid: %s)"
                          % (name, substrate, ", ".join(VALID_SUBSTRATES)))
        trigger = cfg.get("trigger")
        if trigger is not None:
            if not isinstance(trigger, dict):
                errors.append("roles.%s: trigger must be a mapping with a 'type'" % name)
            else:
                ttype = trigger.get("type")
                if ttype not in VALID_TRIGGERS:
                    errors.append("roles.%s: unknown trigger type %r (valid: %s)"
                                  % (name, ttype, ", ".join(VALID_TRIGGERS)))
                elif ttype == "cron" and not str(trigger.get("schedule") or "").strip():
                    errors.append("roles.%s: trigger type cron requires a schedule" % name)
                elif ttype == "event":
                    on = trigger.get("on")
                    if not isinstance(on, list) or not on:
                        errors.append("roles.%s: trigger type event requires a "
                                      "non-empty 'on' list" % name)
        if "instances" in cfg and not _is_positive_int(cfg.get("instances")):
            errors.append("roles.%s: instances must be a positive integer" % name)
    return errors


def check_prompt_files(config, repo_root):
    """Verify each role's `prompt:` is a repo-relative path to an existing
    file inside the repo (never absolute, never escaping -- a pack file, not
    a shadow copy). Returns error strings, [] when fine."""
    errors = []
    roles = (config.get("roles") or {}) if isinstance(config, dict) else {}
    if not isinstance(roles, dict):
        return errors
    root = os.path.realpath(repo_root)
    for name, cfg in roles.items():
        if not isinstance(cfg, dict):
            continue
        prompt = cfg.get("prompt")
        if not prompt:
            continue
        prompt = str(prompt)
        if os.path.isabs(prompt):
            errors.append("roles.%s: prompt must be a repo-relative path, got "
                          "absolute %r" % (name, prompt))
            continue
        full = os.path.realpath(os.path.join(root, prompt))
        if not (full == root or full.startswith(root + os.sep)):
            errors.append("roles.%s: prompt path escapes the repo: %r" % (name, prompt))
            continue
        if not os.path.isfile(full):
            errors.append("roles.%s: prompt file not found: %s" % (name, prompt))
    return errors


def _cron_field(spec, lo, hi):
    """One cron field -> set of ints, or None if invalid. Supports the forms
    real schedules use: '*', '*/n', 'a', 'a-b', 'a,b,c' (parts may be ranges
    or steps)."""
    out = set()
    for part in str(spec).split(","):
        part = part.strip()
        step = 1
        if "/" in part:
            part, _, step_s = part.partition("/")
            try:
                step = int(step_s)
            except ValueError:
                return None
            if step < 1:
                return None
        if part == "*":
            lo_p, hi_p = lo, hi
        elif "-" in part:
            a, _, b = part.partition("-")
            try:
                lo_p, hi_p = int(a), int(b)
            except ValueError:
                return None
        else:
            try:
                lo_p = hi_p = int(part)
            except ValueError:
                return None
        if lo_p < lo or hi_p > hi or lo_p > hi_p:
            return None
        out.update(range(lo_p, hi_p + 1, step))
    return out or None


def cron_next_fire(expr, now_epoch):
    """Next fire time (epoch seconds, UTC -- GitHub Actions/Managed Agents
    cron semantics) strictly AFTER now, for a standard 5-field cron
    expression. None on anything unparseable. Searches day-by-day (<=366
    days) then hour/minute, so it's cheap."""
    if not expr:
        return None
    fields = str(expr).split()
    if len(fields) != 5:
        return None
    minutes = _cron_field(fields[0], 0, 59)
    hours = _cron_field(fields[1], 0, 23)
    doms = _cron_field(fields[2], 1, 31)
    months = _cron_field(fields[3], 1, 12)
    dows = _cron_field(fields[4], 0, 7)
    if None in (minutes, hours, doms, months, dows):
        return None
    if 7 in dows:  # cron allows 0 and 7 for Sunday
        dows = set(dows) | {0}
    start = datetime.fromtimestamp(int(now_epoch) + 60, timezone.utc).replace(
        second=0, microsecond=0)
    day = start.date()
    for _ in range(367):
        # cron dow: 0=Sunday; python weekday(): 0=Monday
        cron_dow = (day.weekday() + 1) % 7
        if day.month in months and day.day in doms and cron_dow in dows:
            for h in sorted(hours):
                for m in sorted(minutes):
                    cand = datetime(day.year, day.month, day.day, h, m,
                                    tzinfo=timezone.utc)
                    if cand >= start:
                        return int(cand.timestamp())
        day = day + timedelta(days=1)
    return None


def main(argv):
    if len(argv) != 2:
        print("usage: roles.py <target-repo>", file=sys.stderr)
        return 2
    repo = argv[1]
    cfg_path = os.path.join(repo, ".autonomy", "config.yaml")
    import config_parser
    try:
        with open(cfg_path, encoding="utf-8") as fh:
            config = config_parser.parse(fh.read())
    except OSError as exc:
        print("roles: cannot read %s: %s" % (cfg_path, exc), file=sys.stderr)
        return 2
    except ValueError as exc:
        print("roles: config.yaml does not parse: %s" % exc, file=sys.stderr)
        return 1
    errors = validate_roles(config) + check_prompt_files(config, repo)
    for e in errors:
        print(e)
    if errors:
        return 1
    return 0 if config.get("roles") else 3


if __name__ == "__main__":
    sys.exit(main(sys.argv))
