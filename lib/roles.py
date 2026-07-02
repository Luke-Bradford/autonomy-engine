#!/usr/bin/env python3
"""Role config schema for the multi-role org -- the single source of truth
for role enums, the standard roster's defaults, and `roles:` block
validation. Stdlib only.

The schema (docs/superpowers/specs/2026-07-02-dynamic-agent-org-design.md):

    roles:
      <name>:
        enabled: true|false
        account: <name in the accounts registry>   # lib/accounts.py
        trigger: { type: loop | cron | event, ... } # or block form
        model: <model id>          effort: <level>
        models: { plan: ..., implement: ..., test: ... }   # per-phase override
        scope: { labels: [...], paths: [...], milestone: ..., query: ...,
                 target: diff|affected|full-regression }   # or bare target
        instances: <positive int>          # optional (parallel loop count)
        prompt: .autonomy/roles/<name>.md  # optional, repo-relative pack file
        # behaviour knobs (validated by value; custom agents share them):
        gate: wait-for-human|auto-merge-on-pass   tools: [read] | [read, mcp]
        regression: { every: <cron> } | { after_tickets: <n> }
        output: raise-issues|handoff-to-pm        web_search: true|false
        duties: [groom, prioritise, unblock, spec-check]
        self_test: true|false     blockers: raise-to-pm|raise-to-human
        substrate: engine|managed_agents|routine|actions   # legacy, optional

Trigger-specific requirements: cron needs `schedule`; event needs a non-empty
`on` list. An absent `roles:` block is valid -- the engine's defaults apply
(only the coder loop enabled).

Three checks, deliberately split: `validate_roles` is pure (shape/enums, no
filesystem); `check_prompt_files` takes the repo root and verifies prompt
paths are repo-relative pack files that exist; `check_accounts` takes the
registry's known names and verifies every `account:` reference resolves.
doctor.sh runs all three via the CLI entry `python3 lib/roles.py
<target-repo>`, whose exit code carries the whole verdict so callers never
re-parse the config:
  0 = valid, roles: block present   3 = valid, no roles: block (defaults)
  1 = invalid (one error per stdout line)   2 = config unreadable
"""
import os
import re
import sys
from datetime import datetime, timedelta, timezone

VALID_SUBSTRATES = ("engine", "managed_agents", "routine", "actions")
VALID_TRIGGERS = ("loop", "cron", "event")
VALID_PHASES = ("plan", "implement", "test")
VALID_SCOPE_TARGETS = ("diff", "affected", "full-regression")
_SCOPE_KEYS = ("labels", "paths", "milestone", "query", "target")
VALID_GATES = ("wait-for-human", "auto-merge-on-pass")
VALID_TOOLS = ("read", "mcp")
VALID_OUTPUTS = ("raise-issues", "handoff-to-pm")
VALID_DUTIES = ("groom", "prioritise", "unblock", "spec-check")
VALID_BLOCKERS = ("raise-to-pm", "raise-to-human")
_ENUM_KNOBS = (("gate", VALID_GATES), ("output", VALID_OUTPUTS),
               ("blockers", VALID_BLOCKERS))
_BOOL_KNOBS = ("web_search", "self_test")

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


def _is_nonempty_str(v):
    return isinstance(v, str) and bool(v.strip())


def _validate_scope(name, scope):
    """`scope:` -- what an agent works over. Either a bare target string
    (legacy shorthand: `scope: diff`) or a mapping with any of labels/paths
    (non-empty inline lists), milestone/query (non-empty strings), target
    (diff | affected | full-regression). Empty mapping = whole open board
    (today's behaviour)."""
    if scope is None:
        return []
    if isinstance(scope, str):
        if scope not in VALID_SCOPE_TARGETS:
            return ["roles.%s: unknown scope target %r (valid: %s)"
                    % (name, scope, ", ".join(VALID_SCOPE_TARGETS))]
        return []
    if not isinstance(scope, dict):
        return ["roles.%s: scope must be a mapping or a target string" % name]
    errors = []
    for key in sorted(scope):
        val = scope[key]
        if key not in _SCOPE_KEYS:
            errors.append("roles.%s: unknown scope key %r (valid: %s)"
                          % (name, key, ", ".join(_SCOPE_KEYS)))
        elif key in ("labels", "paths"):
            if not isinstance(val, list) or not val or \
                    not all(str(v).strip() for v in val):
                errors.append("roles.%s: scope.%s must be a non-empty list"
                              % (name, key))
        elif key == "target":
            if val not in VALID_SCOPE_TARGETS:
                errors.append("roles.%s: unknown scope target %r (valid: %s)"
                              % (name, val, ", ".join(VALID_SCOPE_TARGETS)))
        elif not _is_nonempty_str(val):
            errors.append("roles.%s: scope.%s must be a non-empty string"
                          % (name, key))
    return errors


def _validate_knobs(name, cfg):
    """Behaviour knobs (design spec, Layer 2 knob table). Validated by value
    wherever they appear -- custom agents share the standard roster's knobs.
    `gate: auto-merge-on-pass` still routes through merge_gate.strategy; the
    knob never bypasses the merge authority."""
    errors = []
    for knob, valid in _ENUM_KNOBS:
        if knob in cfg and cfg.get(knob) not in valid:
            errors.append("roles.%s: %s must be one of %s (got %r)"
                          % (name, knob, ", ".join(valid), cfg.get(knob)))
    for knob in _BOOL_KNOBS:
        if knob in cfg and not isinstance(cfg.get(knob), bool):
            errors.append("roles.%s: %s must be true or false" % (name, knob))
    tools = cfg.get("tools")
    if tools is not None and (not isinstance(tools, list) or not tools
                              or any(t not in VALID_TOOLS for t in tools)):
        errors.append("roles.%s: tools must be a non-empty list from [%s]"
                      % (name, ", ".join(VALID_TOOLS)))
    duties = cfg.get("duties")
    if duties is not None and (not isinstance(duties, list) or not duties
                               or any(d not in VALID_DUTIES for d in duties)):
        errors.append("roles.%s: duties must be a non-empty list from [%s]"
                      % (name, ", ".join(VALID_DUTIES)))
    regression = cfg.get("regression")
    if regression is not None:
        if not isinstance(regression, dict) or sorted(regression) not in (
                ["after_tickets"], ["every"]):
            errors.append("roles.%s: regression must be { every: <cron> } or "
                          "{ after_tickets: <n> }" % name)
        elif "every" in regression and \
                cron_next_fire(regression["every"], 0) is None:
            errors.append("roles.%s: regression.every is not a valid cron "
                          "schedule: %r" % (name, regression["every"]))
        elif "after_tickets" in regression and \
                not _is_positive_int(regression["after_tickets"]):
            errors.append("roles.%s: regression.after_tickets must be a "
                          "positive integer" % name)
    return errors


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
        if "account" in cfg and not _is_nonempty_str(cfg.get("account")):
            errors.append("roles.%s: account must be a non-empty account name"
                          % name)
        for field in ("model", "effort"):
            if field in cfg and not _is_nonempty_str(cfg.get(field)):
                errors.append("roles.%s: %s must be a non-empty string"
                              % (name, field))
        models = cfg.get("models")
        if models is not None:
            if not isinstance(models, dict) or not models:
                errors.append("roles.%s: models must be a non-empty mapping "
                              "of phase -> model" % name)
            else:
                for phase in sorted(models):
                    if phase not in VALID_PHASES:
                        errors.append(
                            "roles.%s: unknown models phase %r (valid: %s)"
                            % (name, phase, ", ".join(VALID_PHASES)))
                    elif not _is_nonempty_str(models[phase]):
                        errors.append("roles.%s: models.%s must be a model "
                                      "name" % (name, phase))
        errors.extend(_validate_scope(name, cfg.get("scope")))
        errors.extend(_validate_knobs(name, cfg))
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


def check_accounts(config, known_account_names):
    """Verify each role's `account:` names an entry in the machine accounts
    registry (lib/accounts.py, increment 1). Pure -- the caller supplies the
    known names; the CLI entry loads the real registry. A reference to a
    missing account is an error: that agent could never resolve auth
    (fail-safe, never fail-open). Shape problems (non-string/empty) are
    validate_roles' verdict, not duplicated here."""
    errors = []
    roles_blk = (config.get("roles") or {}) if isinstance(config, dict) else {}
    if not isinstance(roles_blk, dict):
        return errors
    known = set(known_account_names or ())
    for name, cfg in roles_blk.items():
        if not isinstance(cfg, dict):
            continue
        account = cfg.get("account")
        if not _is_nonempty_str(account):
            continue
        if account not in known:
            errors.append("roles.%s: account %r not found in the accounts "
                          "registry -- create it first: "
                          "python3 lib/accounts.py set %r <kind> [credential]"
                          % (name, account, account))
    return errors


def account_errors(config, registry):
    """Doctor's account-reference check against a registry object (injected so
    tests never touch the real registry). A CORRUPT registry reads as empty,
    which would make every `account:` reference look 'not found -- create it
    first'; following that advice runs accounts.set, which clobbers the
    unreadable entries (#59). So when the registry is unreadable, emit ONE
    'unreadable' error and skip the not-found pass (it can't see the real
    entries); otherwise delegate to check_accounts.

    Only relevant when some role actually references an account -- a corrupt
    registry that nothing uses is not doctor's concern (a no-account config,
    including a no-roles one, must not fail on it)."""
    roles_blk = (config.get("roles") or {}) if isinstance(config, dict) else {}
    has_reference = isinstance(roles_blk, dict) and any(
        _is_nonempty_str(cfg.get("account"))
        for cfg in roles_blk.values() if isinstance(cfg, dict))
    if not has_reference:
        return []
    if registry.is_corrupt():
        return ["accounts registry at %s is unreadable/corrupt -- fix or "
                "remove it before validating role accounts"
                % registry.index_path]
    known = [e["name"] for e in registry.list()]
    return check_accounts(config, known)


# Role names land in supervisor shell word-splitting and log lines: same safe
# charset as account names (lib/accounts.py). dispatch never emits others.
_ROLE_NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


def as_bool(v):
    """Config booleans arrive as real bools from config_parser but may be
    strings from older/hand-edited packs -- one lenient reading, shared with
    the dashboard (dashboard_state aliases this)."""
    if isinstance(v, bool):
        return v
    return str(v).strip().lower() in ("true", "1", "yes", "on")


def _effective(cfg, key_default_pairs):
    """(enabled, trigger_type) for a role config dict, given its roster
    defaults. Defensive against non-dict shapes -- dispatch may see a config
    that validate_roles would reject; it must degrade, not crash."""
    cfg = cfg if isinstance(cfg, dict) else {}
    d_enabled, d_trig = key_default_pairs
    enabled = as_bool(cfg.get("enabled")) if "enabled" in cfg else d_enabled
    trigger = cfg.get("trigger")
    ttype = trigger.get("type") if isinstance(trigger, dict) else None
    return enabled, (ttype or d_trig)


def dispatch_roles(config):
    """Names of the roles the supervisor's loop dispatches, in a stable
    order: standard roster first (DEFAULT_ROLES order), then custom roles in
    config order. A role is dispatched iff effectively enabled AND its
    effective trigger type is 'loop' -- cron/event roles belong to increment
    4's scheduler/event bus. Merge semantics mirror the dashboard roster
    (dashboard_state.build_roles): standard roles default from DEFAULT_ROLES,
    custom roles default to enabled=false / trigger=loop. No roles: block ->
    ['coder'] (today's behaviour)."""
    roles_blk = (config.get("roles") or {}) if isinstance(config, dict) else {}
    if not isinstance(roles_blk, dict):
        roles_blk = {}
    out = []
    for name, d_enabled, _sub, d_trig in DEFAULT_ROLES:
        enabled, ttype = _effective(roles_blk.get(name), (d_enabled, d_trig))
        if enabled and ttype == "loop":
            out.append(name)
    standard = tuple(r[0] for r in DEFAULT_ROLES)
    for name, cfg in roles_blk.items():
        if name in standard or not _ROLE_NAME_RE.match(str(name)):
            continue
        enabled, ttype = _effective(cfg, (False, "loop"))
        if enabled and ttype == "loop":
            out.append(name)
    return out


def render_scope(scope):
    """One-line scope directive for the session's system prompt -- the
    supervisor appends it to the pack's hard_rules. '' when scope is absent
    or empty (whole open board, today's behaviour). The bare-string
    shorthand ('scope: diff') renders as its target. Never multi-line: the
    value crosses a KEY=value pipe to bash."""
    if not scope:
        return ""
    if isinstance(scope, str):
        parts = [("target", scope)]
    elif isinstance(scope, dict):
        parts = []
        for key in _SCOPE_KEYS:  # stable schema order
            if key not in scope:
                continue
            val = scope[key]
            if isinstance(val, list):
                val = ", ".join(str(v) for v in val)
            parts.append((key, str(val)))
        if not parts:
            return ""
    else:
        return ""
    rendered = "; ".join("%s: %s" % (k, v) for k, v in parts)
    return "Scope: work ONLY within this scope: %s." % rendered


def role_settings(config, name):
    """The session settings the supervisor needs to dispatch `name`:
    account/model/effort/prompt/scope as strings ('' = unset, supervisor
    falls back to its agent.* resolution) plus instances (int >= 1).
    KeyError when the role is not dispatchable (not in dispatch_roles) --
    the CLI turns that into exit 1 so the supervisor refuses cleanly."""
    if name not in dispatch_roles(config):
        raise KeyError(name)
    roles_blk = (config.get("roles") or {}) if isinstance(config, dict) else {}
    cfg = roles_blk.get(name) if isinstance(roles_blk, dict) else None
    if not isinstance(cfg, dict):
        cfg = {}

    def _s(key):
        v = cfg.get(key)
        return str(v).strip() if _is_nonempty_str(v) else ""

    instances = cfg.get("instances")
    instances = int(str(instances)) if _is_positive_int(instances) else 1
    return {"account": _s("account"), "model": _s("model"),
            "effort": _s("effort"), "prompt": _s("prompt"),
            "scope": render_scope(cfg.get("scope")), "instances": instances}


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
            first_day = day == start.date()
            for h in sorted(hours):
                # on the starting day, hours before `start` can never match --
                # skip them instead of allocating 60 datetimes each
                if first_day and h < start.hour:
                    continue
                for m in sorted(minutes):
                    if first_day and h == start.hour and m < start.minute:
                        continue
                    cand = datetime(day.year, day.month, day.day, h, m,
                                    tzinfo=timezone.utc)
                    if cand >= start:
                        return int(cand.timestamp())
        day = day + timedelta(days=1)
    return None


def _load_config(repo):
    """(config, rc) -- rc 0 on success, else the CLI exit code (2 unreadable,
    1 unparseable) with an explanation on stderr. Shared by the validation
    and dispatch entries."""
    cfg_path = os.path.join(repo, ".autonomy", "config.yaml")
    import config_parser
    try:
        with open(cfg_path, encoding="utf-8") as fh:
            return config_parser.parse(fh.read()), 0
    except OSError as exc:
        print("roles: cannot read %s: %s" % (cfg_path, exc), file=sys.stderr)
        return None, 2
    except ValueError as exc:
        print("roles: config.yaml does not parse: %s" % exc, file=sys.stderr)
        return None, 1


def _dispatch_main(argv):
    """`roles.py dispatch <target-repo> [role]` -- the supervisor's dispatch
    contract. Without a role: enabled loop-role names, one per line (may be
    none). With a role: the six KEY=value session-settings lines. Exit 1 on
    an undispatchable role (the supervisor REFUSES that session, fail-safe)."""
    if len(argv) not in (2, 3):
        print("usage: roles.py dispatch <target-repo> [role]", file=sys.stderr)
        return 2
    config, rc = _load_config(argv[1])
    if rc:
        return rc
    if len(argv) == 2:
        for name in dispatch_roles(config):
            print(name)
        return 0
    try:
        s = role_settings(config, argv[2])
    except KeyError:
        print("roles: %r is not an enabled loop role" % argv[2],
              file=sys.stderr)
        return 1
    for key in ("account", "model", "effort", "prompt", "scope"):
        print("%s=%s" % (key.upper(), s[key]))
    print("INSTANCES=%d" % s["instances"])
    return 0


def main(argv):
    if len(argv) >= 2 and argv[1] == "dispatch":
        return _dispatch_main(argv[1:])
    if len(argv) != 2:
        print("usage: roles.py <target-repo> | roles.py dispatch "
              "<target-repo> [role]", file=sys.stderr)
        return 2
    repo = argv[1]
    config, rc = _load_config(repo)
    if rc:
        return rc
    import accounts as accounts_mod
    errors = (validate_roles(config) + check_prompt_files(config, repo)
              + account_errors(config, accounts_mod.Accounts()))
    for e in errors:
        print(e)
    if errors:
        return 1
    return 0 if config.get("roles") else 3


if __name__ == "__main__":
    sys.exit(main(sys.argv))
