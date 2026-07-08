#!/usr/bin/env python3
"""Role config schema for the multi-role org -- the single source of truth
for role enums, the standard roster's defaults, and `roles:` block
validation. Stdlib only.

The schema (docs/superpowers/specs/2026-07-02-dynamic-agent-org-design.md):

    roles:
      <name>:
        enabled: true|false
        account: <name in the accounts registry>   # lib/accounts.py
        agent: <adapter name>      # claude | codex | ... (which CLI runs it)
        trigger: { type: loop | cron | event, ... } # or block form
        model: <model id>          effort: <level>
        models: { plan: ..., implement: ..., test: ... }   # per-phase override
        scope: { labels: [...], paths: [...], milestone: ..., query: ...,
                 target: diff|affected|full-regression }   # or bare target
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
# `manual` (config-workstreams spec): never auto-fires -- the workstream only
# runs on an explicit operator Run-now. Naturally inert everywhere else: the
# loop/cron/event enumerators each filter on their OWN type, so a manual role
# is simply never enumerated.
VALID_TRIGGERS = ("loop", "cron", "event", "manual")
# The v1 event vocabulary the supervisor's event bus (W2) can poll/emit. An
# event role's `on:` tokens must be a subset -- a role listening only for unknown
# events could never wake, so it is fail-closed at validation (not use-time).
# INVARIANT for anyone extending this: the supervisor's per-(role,event) seen-set
# (bin/supervisor.sh resolve_event_wakes) assumes every token is MONOTONIC or
# TERMINAL (PR/issue numbers grow, merges are final) so a token that scrolls off
# the poll page never re-enters it. A NON-monotonic event kind (e.g. a label that
# can be added then removed) would re-deliver under that model -- it needs a
# cumulative/high-water cursor, not this seen-set, so do not just add it here.
VALID_EVENTS = ("issue.created", "pr.opened", "pr.synchronize", "merge.done",
                "session.done")
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


# --- lanes (#147 lanes execution, Part 1) -----------------------------------
# A lane is a named worktree + role subset, keyed in the ONE committed
# .autonomy/config.yaml (settled-decisions 21-25; spec
# 2026-07-03-lanes-and-board-contract-design.md). A role "belongs to" the lane
# named by its `lane:` field, or the default lane when it sets none. Filtering
# is unified: `lane=None` resolves to the default lane, so a config with no
# lanes: block (every role -> the implicit "main" lane) filters to exactly
# today's set -- zero regression. An undeclared-lane role matches no real
# lane target and is refused-by-omission (never falls into the default lane,
# never crashes enumeration -- fail-safe, not fail-open).
_DEFAULT_LANE = "main"


def _declared_lane_names(config):
    """Declared `lanes:` keys in order, or [] when there is no valid block."""
    lanes = config.get("lanes") if isinstance(config, dict) else None
    if not isinstance(lanes, dict):
        return []
    return list(lanes)


def default_lane(config):
    """The default lane name: the first declared lane, else 'main' (the
    implicit lane when no `lanes:` block exists)."""
    names = _declared_lane_names(config)
    return names[0] if names else _DEFAULT_LANE


def lane_names(config):
    """Every lane name: declared keys in order, or ['main'] when none."""
    names = _declared_lane_names(config)
    return names if names else [_DEFAULT_LANE]


def lane_of_role(config, name):
    """The lane a role belongs to: its `lane:` (stripped) or the default lane.
    An undeclared lane string is returned verbatim -- callers filter by exact
    match, so it lands in no real lane (refused-by-omission)."""
    roles_blk = (config.get("roles") or {}) if isinstance(config, dict) else {}
    cfg = roles_blk.get(name) if isinstance(roles_blk, dict) else None
    lane = cfg.get("lane") if isinstance(cfg, dict) else None
    return lane.strip() if _is_nonempty_str(lane) else default_lane(config)


def _scope_labels(cfg):
    """The frozenset of non-empty string labels a role subscribes to via
    scope.labels ([] / absent / non-list -> empty). Coerces to str, drops
    empties -- overlap detection needs a clean set."""
    if not isinstance(cfg, dict):
        return frozenset()
    scope = cfg.get("scope")
    if not isinstance(scope, dict):
        return frozenset()
    labels = scope.get("labels")
    if not isinstance(labels, list):
        return frozenset()
    return frozenset(str(x).strip() for x in labels if _is_nonempty_str(x))


def _enabled_label_scopes(config):
    """(lane, frozenset(labels)) for every ENABLED executable role (loop/cron/
    event, any lane) that sets a non-empty scope.labels. The SINGLE source for
    both lane_overlaps and configured_scope_labels, so the two never diverge on
    what "an enabled scoped role" means."""
    roles_blk = (config.get("roles") or {}) if isinstance(config, dict) else {}
    out = []
    for lane in lane_names(config):
        names = list(dispatch_roles(config, lane))
        names += [n for (n, _s) in cron_roles(config, lane)]
        names += [n for (n, _e) in event_roles(config, lane)]
        for name in names:
            labels = _scope_labels(roles_blk.get(name)
                                   if isinstance(roles_blk, dict) else None)
            if labels:
                out.append((lane, labels))
    return out


def configured_scope_labels(config):
    """Sorted, de-duplicated union of every scope.label any enabled executable
    role subscribes to (#171). doctor's label check reads this ONE source to
    verify each configured label exists on the repo -- a typo'd label silently
    empties a role's board, so surfacing it is the point. [] when none."""
    out = set()
    for _lane, labels in _enabled_label_scopes(config):
        out |= set(labels)
    return sorted(out)


def lane_overlaps(config):
    """Deterministic WARN strings for executable roles in DIFFERENT lanes whose
    scope.labels intersect -- the label partition is the claim, so overlap
    'may double-work' (a doctor warning, never a runtime lease; settled-decision
    22). One line per (lane-pair, shared-label). Roles with no scope.labels
    never overlap (no partition claim -- the operator's stated risk). Covers
    every trigger type (loop/cron/event): once per-lane execution lands, a cron
    or event role pinned to a lane acts on that lane's board just as a loop role
    does, so its scope must be partitioned too (deferred PR-#162 NITPICK)."""
    info = _enabled_label_scopes(config)  # (lane, labelset), single source
    warnings = set()
    for i in range(len(info)):
        for j in range(i + 1, len(info)):
            la, sa = info[i]
            lb, sb = info[j]
            if la == lb:
                continue
            pair = tuple(sorted((la, lb)))
            for label in (sa & sb):
                warnings.add("lanes %s and %s have overlapping label scopes "
                             "(label %s) -- may double-work"
                             % (pair[0], pair[1], label))
    return sorted(warnings)


def _validate_lanes(config):
    """Shape/enum validation of the top-level `lanes:` block. [] when absent or
    valid. Fail-closed: bad names, non-mapping lanes, unknown keys, absolute or
    control-char worktrees, and duplicate worktree paths are all errors so
    Part 2's launchd/worktree inputs are safe."""
    errors = []
    lanes = config.get("lanes") if isinstance(config, dict) else None
    if lanes is None:
        return errors
    if not isinstance(lanes, dict) or not lanes:
        return ["lanes: must be a non-empty mapping of lane name -> settings"]
    seen_worktrees = {}
    for name in lanes:
        if not _ROLE_NAME_RE.match(str(name)):
            errors.append("lanes.%s: invalid lane name (allowed: letters, "
                          "digits, . _ -, max 64 chars)" % name)
        val = lanes[name]
        if not isinstance(val, dict):
            errors.append("lanes.%s: must be a mapping (got %r)" % (name, val))
            continue
        for key in sorted(val):
            if key != "worktree":
                errors.append("lanes.%s: unknown key %r (valid: worktree)"
                              % (name, key))
        if "worktree" in val:
            wt = val.get("worktree")
            if not _is_nonempty_str(wt):
                errors.append("lanes.%s: worktree must be a non-empty string"
                              % name)
                continue
            wt_s = wt.strip()
            if wt_s.startswith("/"):
                errors.append("lanes.%s: worktree must be a relative path, not "
                              "absolute (%r)" % (name, wt))
            elif any(ord(c) < 32 for c in wt_s):
                errors.append("lanes.%s: worktree contains control characters "
                              "(%r)" % (name, wt))
            elif wt_s in seen_worktrees:
                errors.append("lanes.%s: worktree %r duplicates lanes.%s"
                              % (name, wt_s, seen_worktrees[wt_s]))
            else:
                seen_worktrees[wt_s] = name
    return errors


def lanes_valid(config):
    """True when the top-level `lanes:` block is absent or valid, False when it
    is present-but-malformed. The SAME verdict `roles.py lanes` (and so the
    supervisor's `--lane` gate) reaches, exposed so read-only surfaces (the
    dashboard) can tell a healthy single-lane repo from broken config rather
    than reporting a malformed block as the implicit 'main' lane (which would
    show health where the supervisor actually REFUSES to dispatch)."""
    return not _validate_lanes(config)


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


# Knob-consumption status -- the SINGLE SOURCE for the fail-safe-honesty NOTEs
# (#149). Each entry is a knob the schema validates but the engine does NOT (yet)
# fully consume, mapped to what it actually does with it today. When #89 wires a
# knob, delete its entry here and every NOTE for it disappears for free. `gate`
# IS consumed on the QA merge-path, so it is honest ONLY for non-QA roles
# (special-cased in unwired_knob_notes); the rest are role-independent.
_KNOB_NOTES = {
    "gate":       "consumed only by the QA merge-path -- a no-op on other roles",
    "tools":      "not yet consumed by any role",
    "regression": "not yet fired (the QA rail mentions it; nothing schedules it)",
    "output":     "shapes the role's rail prose only -- not enforced by the engine",
    "web_search": "shapes the role's rail prose only -- not enforced by the engine",
    "self_test":  "not yet consumed",
    "duties":     "shapes the PM rail's prose only -- not enforced by the engine",
    "blockers":   "not yet consumed",
    "models":     "per-phase models are ignored -- the adapter takes a single model",
}


def _knob_meaningfully_set(val):
    """True only when the operator set a knob to a non-default, non-empty value.
    A `self_test: false`, an absent knob, or an empty list/mapping is the quiet
    default -- flagging it would be honesty-theatre noise, not a real no-op."""
    if val is None:
        return False
    if isinstance(val, bool):
        return val is True                 # only a TRUE bool is a surprising no-op
    if isinstance(val, (list, dict, str)):
        return len(val) > 0
    return True


def unwired_knob_notes(name, cfg):
    """fail-safe honesty (#149): one message per knob that role `name` sets to a
    meaningful value but the engine does not (fully) consume today. Single-sourced
    from _KNOB_NOTES, so the list shrinks automatically as #89 wires knobs.
    Deterministic order (dict insertion order). [] for a non-mapping config."""
    if not isinstance(cfg, dict):
        return []
    notes = []
    for knob, why in _KNOB_NOTES.items():
        if knob == "gate" and name == "qa":
            continue                       # gate is real on the QA merge-path
        if _knob_meaningfully_set(cfg.get(knob)):
            notes.append("roles.%s.%s is set but %s (wiring tracked in #89)"
                         % (name, knob, why))
    return notes


def validate_roles(config):
    """Shape/enum validation of the parsed config's `roles:` block. Returns a
    list of human-readable error strings, [] when valid (or when absent)."""
    errors = _validate_lanes(config)
    roles = config.get("roles") if isinstance(config, dict) else None
    if not roles:
        return errors
    if not isinstance(roles, dict):
        errors.append("roles: must be a mapping of role name -> settings")
        return errors
    valid_lanes = set(lane_names(config))
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
                elif ttype == "cron":
                    sched = str(trigger.get("schedule") or "").strip()
                    if not sched:
                        errors.append("roles.%s: trigger type cron requires a schedule" % name)
                    elif cron_next_fire(sched, 0) is None:
                        # A non-blank but unparseable schedule would pass silently
                        # and then never fire (cron-due always 'not-due') -- surface
                        # it at validation so doctor catches the misconfig.
                        errors.append("roles.%s: trigger schedule is not a valid "
                                      "cron expression: %r"
                                      % (name, trigger.get("schedule")))
                elif ttype == "event":
                    on = trigger.get("on")
                    if not isinstance(on, list) or not on:
                        errors.append("roles.%s: trigger type event requires a "
                                      "non-empty 'on' list" % name)
                    else:
                        for ev in on:
                            if ev not in VALID_EVENTS:
                                errors.append(
                                    "roles.%s: unknown event %r in 'on' (valid: "
                                    "%s)" % (name, ev, ", ".join(VALID_EVENTS)))
        if "lane" in cfg:
            lane = cfg.get("lane")
            if not _is_nonempty_str(lane):
                errors.append("roles.%s: lane must be a non-empty lane name"
                              % name)
            elif not _ROLE_NAME_RE.match(str(lane).strip()):
                errors.append("roles.%s: lane %r is not a valid lane name"
                              % (name, lane))
            elif lane.strip() not in valid_lanes:
                errors.append("roles.%s: lane %r is not a declared lane "
                              "(declared: %s)"
                              % (name, lane.strip(),
                                 ", ".join(sorted(valid_lanes))))
        if "account" in cfg and not _is_nonempty_str(cfg.get("account")):
            errors.append("roles.%s: account must be a non-empty account name"
                          % name)
        for field in ("agent", "model", "effort"):
            if field in cfg and not _is_nonempty_str(cfg.get(field)):
                errors.append("roles.%s: %s must be a non-empty string"
                              % (name, field))
        if "pipeline" in cfg:
            pval = cfg.get("pipeline")
            if not _is_nonempty_str(pval) or not _ROLE_NAME_RE.match(
                    str(pval).strip()):
                errors.append("roles.%s: pipeline must be a pipeline name "
                              "(charset [A-Za-z0-9._-]{1,64})" % name)
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


# Adapter names cross into a `source .../<name>.sh` path in supervisor.sh, so
# only the shell-safe charset the supervisor gates on ([A-Za-z0-9_-]) is valid.
_AGENT_NAME_RE = re.compile(r"^[A-Za-z0-9_-]+$")


def check_agent_adapters(config, agents_dir):
    """Verify each role's explicit `agent:` names an adapter that exists in the
    engine's agents dir (bin/agents/<name>.sh). validate_roles checks `agent:`
    only as a non-empty string; a typo'd/missing adapter is otherwise caught
    only at dispatch (the supervisor REFUSES the session -- fail-safe, never
    running a stale round-robin adapter). Surfacing it here lets doctor flag it
    before the loop runs. Pure -- the caller supplies the agents dir. An unset
    `agent:` (meaning the global $AGENT_TYPE) is not this check's concern."""
    errors = []
    roles_blk = (config.get("roles") or {}) if isinstance(config, dict) else {}
    if not isinstance(roles_blk, dict):
        return errors
    for name, cfg in roles_blk.items():
        if not isinstance(cfg, dict):
            continue
        agent = cfg.get("agent")
        if not _is_nonempty_str(agent):
            continue
        agent = str(agent)
        if not _AGENT_NAME_RE.match(agent):
            errors.append("roles.%s: agent %r has invalid chars "
                          "(allowed: A-Za-z0-9_-)" % (name, agent))
            continue
        if not os.path.isfile(os.path.join(agents_dir, agent + ".sh")):
            errors.append("roles.%s: agent adapter %r not found "
                          "(expected bin/agents/%s.sh)" % (name, agent, agent))
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


def _in_lane(config, name, lane):
    """True iff role `name` belongs to `lane` (lane=None -> the default lane).
    The unified lane filter. A role's resolved lane must ALSO be a declared
    lane: a role pinned to an undeclared lane matches no target (not even an
    explicit `--lane <that-undeclared-name>`), so it is refused-by-omission
    everywhere -- fail-safe, never fall into the default lane, never run a
    misconfigured role."""
    rl = lane_of_role(config, name)
    if rl not in lane_names(config):
        return False
    target = lane if lane is not None else default_lane(config)
    return rl == target


def _all_loop_roles(config):
    """Every enabled loop role, lane-UNfiltered, in the stable dispatch order
    (standard roster first, then custom roles in config order). The raw roster
    the lane filter and the settings guard build on."""
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


def dispatch_roles(config, lane=None):
    """Names of the loop roles the supervisor dispatches for `lane` (lane=None
    -> the default lane), in the stable roster order. A role is dispatched iff
    effectively enabled AND its effective trigger is 'loop' AND it belongs to
    the lane. With no `lanes:` block every role maps to the implicit 'main'
    lane, so lane=None returns exactly today's set (zero regression). Merge
    semantics mirror the dashboard roster (dashboard_state.build_roles)."""
    return [n for n in _all_loop_roles(config) if _in_lane(config, n, lane)]


def _role_schedule(cfg):
    """The cron `schedule` string for a role config, '' when absent/blank.
    Defensive against non-dict shapes (dispatch degrades, never crashes)."""
    cfg = cfg if isinstance(cfg, dict) else {}
    trigger = cfg.get("trigger")
    if not isinstance(trigger, dict):
        return ""
    sched = trigger.get("schedule")
    return str(sched).strip() if _is_nonempty_str(sched) else ""


def _all_cron_roles(config):
    """Every enabled cron role with a schedule, lane-UNfiltered, stable order."""
    roles_blk = (config.get("roles") or {}) if isinstance(config, dict) else {}
    if not isinstance(roles_blk, dict):
        roles_blk = {}
    out = []
    for name, d_enabled, _sub, d_trig in DEFAULT_ROLES:
        enabled, ttype = _effective(roles_blk.get(name), (d_enabled, d_trig))
        if enabled and ttype == "cron":
            sched = _role_schedule(roles_blk.get(name))
            if sched:
                out.append((name, sched))
    standard = tuple(r[0] for r in DEFAULT_ROLES)
    for name, cfg in roles_blk.items():
        if name in standard or not _ROLE_NAME_RE.match(str(name)):
            continue
        enabled, ttype = _effective(cfg, (False, "loop"))
        if enabled and ttype == "cron":
            sched = _role_schedule(cfg)
            if sched:
                out.append((name, sched))
    return out


def cron_roles(config, lane=None):
    """(name, schedule) pairs for the cron roles the scheduler fires in `lane`
    (lane=None -> the default lane), stable order. D6: a lane-less cron role
    maps to the default lane, so only the default supervisor fires it; a role
    pinned to a non-default lane fires only under that lane -- exactly-once,
    no cross-lane coordination. Degrades (skips) a schedule-less role rather
    than crashing."""
    return [(n, s) for (n, s) in _all_cron_roles(config)
            if _in_lane(config, n, lane)]


def all_cron_roles(config):
    """PUBLIC lane-UNfiltered (name, schedule) pairs. For consumers whose
    concern is lane-independent -- lib/pipeline.py's multi-node cron/event
    refusal (#345) must catch a role pinned to ANY lane -- as opposed to the
    scheduler's per-lane cron_roles()."""
    return _all_cron_roles(config)


def _role_events(cfg):
    """The event `on:` token list for a role config, [] when absent/blank.
    Keeps only non-empty string tokens. Defensive against non-dict shapes
    (dispatch degrades, never crashes)."""
    cfg = cfg if isinstance(cfg, dict) else {}
    trigger = cfg.get("trigger")
    if not isinstance(trigger, dict):
        return []
    on = trigger.get("on")
    if not isinstance(on, list):
        return []
    return [str(ev).strip() for ev in on if _is_nonempty_str(ev)]


def _all_event_roles(config):
    """Every enabled event role with an `on:` list, lane-UNfiltered, stable
    order."""
    roles_blk = (config.get("roles") or {}) if isinstance(config, dict) else {}
    if not isinstance(roles_blk, dict):
        roles_blk = {}
    out = []
    for name, d_enabled, _sub, d_trig in DEFAULT_ROLES:
        enabled, ttype = _effective(roles_blk.get(name), (d_enabled, d_trig))
        if enabled and ttype == "event":
            evs = _role_events(roles_blk.get(name))
            if evs:
                out.append((name, evs))
    standard = tuple(r[0] for r in DEFAULT_ROLES)
    for name, cfg in roles_blk.items():
        if name in standard or not _ROLE_NAME_RE.match(str(name)):
            continue
        enabled, ttype = _effective(cfg, (False, "loop"))
        if enabled and ttype == "event":
            evs = _role_events(cfg)
            if evs:
                out.append((name, evs))
    return out


def event_roles(config, lane=None):
    """(name, [event, ...]) pairs for the event roles the bus wakes in `lane`
    (lane=None -> the default lane), stable order. D6 applies as for cron_roles.
    Degrades (skips) an empty-`on:` role rather than crashing."""
    return [(n, e) for (n, e) in _all_event_roles(config)
            if _in_lane(config, n, lane)]


def all_event_roles(config):
    """PUBLIC lane-UNfiltered (name, [event, ...]) pairs -- the sibling of
    all_cron_roles(), same consumer and rationale."""
    return _all_event_roles(config)


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


def dispatchable_roles(config):
    """Every role the supervisor may run a session for: enabled loop roles
    (round-robined by the loop) PLUS enabled cron roles (fired by the W1
    scheduler) PLUS enabled event roles (woken by the W2 event bus) -- all three
    go through the same run_session path, so role_settings must resolve any of
    them. Loop roles keep their stable order; cron then event roles that are not
    already listed are appended. NOT filtered to a single lane (settings do not
    depend on lane, so a role in any DECLARED lane resolves without a KeyError
    on the per-lane path) -- but a role pinned to an UNDECLARED lane is excluded,
    because it can never run in any real lane (fail-safe: refuse, don't resolve
    a misconfigured role)."""
    valid = set(lane_names(config))
    names = []
    ordered = (list(_all_loop_roles(config))
               + [n for n, _ in _all_cron_roles(config)]
               + [n for n, _ in _all_event_roles(config)])
    for name in ordered:
        if name not in names and lane_of_role(config, name) in valid:
            names.append(name)
    return names


def role_settings(config, name):
    """The session settings the supervisor needs to dispatch `name`:
    account/model/effort/prompt/scope as strings ('' = unset, supervisor
    falls back to its agent.* resolution). KeyError when the role is not
    dispatchable (neither an enabled loop role nor an enabled cron role) -- the
    CLI turns that into exit 1 so the supervisor refuses cleanly."""
    if name not in dispatchable_roles(config):
        raise KeyError(name)
    roles_blk = (config.get("roles") or {}) if isinstance(config, dict) else {}
    cfg = roles_blk.get(name) if isinstance(roles_blk, dict) else None
    if not isinstance(cfg, dict):
        cfg = {}

    def _s(key):
        v = cfg.get(key)
        return str(v).strip() if _is_nonempty_str(v) else ""

    return {"account": _s("account"), "agent": _s("agent"),
            "model": _s("model"), "effort": _s("effort"),
            "prompt": _s("prompt"),
            "scope": render_scope(cfg.get("scope")),
            "pipeline": _s("pipeline")}


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
    # Workstreams slice 1: the var-live shadow, when present, IS the config
    # (config_parser.effective_config_path is the single resolver -- bash
    # readers get the identical answer through the same module's CLI).
    cfg_path = config_parser.effective_config_path(cfg_path)
    try:
        with open(cfg_path, encoding="utf-8") as fh:
            return config_parser.parse(fh.read()), 0
    except OSError as exc:
        print("roles: cannot read %s: %s" % (cfg_path, exc), file=sys.stderr)
        return None, 2
    except ValueError as exc:
        print("roles: config.yaml does not parse: %s" % exc, file=sys.stderr)
        return None, 1


def _extract_lane(args):
    """Split off an optional `--lane <name>` from a CLI arg list. Returns
    (positional_args, lane, err): lane is None when absent; err is a message
    string on malformed usage (missing value, repeated flag). Keeps the lane
    filter out of the positional grammar so `dispatch <repo> <role>` and
    `dispatch <repo> --lane <name>` stay unambiguous."""
    out = []
    lane = None
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--lane":
            if lane is not None or i + 1 >= len(args):
                return None, None, "malformed --lane"
            lane = args[i + 1]
            i += 2
        else:
            out.append(a)
            i += 1
    return out, lane, None


def _dispatch_main(argv):
    """`roles.py dispatch <target-repo> [role] | [--lane <name>]` -- the
    supervisor's dispatch contract. Without a role: enabled loop-role names for
    the lane (--lane, else the default lane), one per line (may be none). With a
    role: the six KEY=value session-settings lines (lane-independent). A role
    and --lane together is a usage error. Exit 1 on an undispatchable role (the
    supervisor REFUSES that session, fail-safe)."""
    pos, lane, err = _extract_lane(argv[1:])
    if (err is not None or pos is None or len(pos) not in (1, 2)
            or (len(pos) == 2 and lane is not None)):
        print("usage: roles.py dispatch <target-repo> [role] | "
              "roles.py dispatch <target-repo> [--lane <name>]",
              file=sys.stderr)
        return 2
    config, rc = _load_config(pos[0])
    if rc:
        return rc
    if len(pos) == 1:
        for name in dispatch_roles(config, lane):
            print(name)
        return 0
    try:
        s = role_settings(config, pos[1])
    except KeyError:
        print("roles: %r is not an enabled loop or cron role" % pos[1],
              file=sys.stderr)
        return 1
    for key in ("account", "agent", "model", "effort", "prompt", "scope"):
        print("%s=%s" % (key.upper(), s[key]))
    return 0


def _cron_main(argv):
    """`roles.py cron <target-repo>` -- one `NAME<TAB>SCHEDULE` line per enabled
    cron role (none prints nothing). The supervisor's scheduler enumerates
    due-ness from this; keeping the roster/merge logic in Python keeps the
    supervisor a thin caller."""
    pos, lane, err = _extract_lane(argv[1:])
    if err is not None or pos is None or len(pos) != 1:
        print("usage: roles.py cron <target-repo> [--lane <name>]",
              file=sys.stderr)
        return 2
    config, rc = _load_config(pos[0])
    if rc:
        return rc
    for name, sched in cron_roles(config, lane):
        print("%s\t%s" % (name, sched))
    return 0


def _cron_due_main(argv):
    """`roles.py cron-due <schedule> <last-fire-epoch> <now-epoch>` -- prints
    'due' when the schedule's next fire strictly after <last> is at or before
    <now>, else 'not-due'. Keeps ALL cron math in Python so the supervisor just
    tests the string. Unparseable schedule or non-integer epoch -> 'not-due'
    (fail-safe: under-fire, never over-fire). rc 0 either way."""
    if len(argv) != 4:
        print("usage: roles.py cron-due <schedule> <last> <now>",
              file=sys.stderr)
        return 2
    try:
        last = int(argv[2])
        now = int(argv[3])
    except (TypeError, ValueError):
        print("not-due")
        return 0
    nxt = cron_next_fire(argv[1], last)
    print("due" if (nxt is not None and nxt <= now) else "not-due")
    return 0


def _events_main(argv):
    """`roles.py events <target-repo>` -- one `NAME<TAB>EVENT[,EVENT...]` line per
    enabled event role (none prints nothing). The supervisor's event bus
    enumerates listeners from this; keeping the roster/merge logic in Python keeps
    the supervisor a thin caller. Events never contain a tab or comma."""
    pos, lane, err = _extract_lane(argv[1:])
    if err is not None or pos is None or len(pos) != 1:
        print("usage: roles.py events <target-repo> [--lane <name>]",
              file=sys.stderr)
        return 2
    config, rc = _load_config(pos[0])
    if rc:
        return rc
    for name, evs in event_roles(config, lane):
        print("%s\t%s" % (name, ",".join(evs)))
    return 0


def _scope_labels_main(argv):
    """`roles.py scope-labels <target-repo>` -- every scope.label configured by
    an enabled executable role, sorted, one per line (#171). doctor reads this to
    warn when a configured label doesn't exist on the repo. No labels / no roles:
    block -> nothing, rc 0. Unreadable/unparseable config -> the _load_config rc."""
    if len(argv) != 2:
        print("usage: roles.py scope-labels <target-repo>", file=sys.stderr)
        return 2
    config, rc = _load_config(argv[1])
    if rc:
        return rc
    for label in configured_scope_labels(config):
        print(label)
    return 0


def _knob_notes_main(argv):
    """`roles.py knob-notes <target-repo> [role]` -- one honest NOTE line per
    knob a role sets but the engine does not (yet) consume (#149). With a role,
    only that role; without, every configured role. The supervisor logs these at
    dispatch and doctor surfaces them, both from this single source. Best-effort:
    no roles: block or an unreadable role config prints nothing, never errors."""
    if len(argv) not in (2, 3):
        print("usage: roles.py knob-notes <target-repo> [role]", file=sys.stderr)
        return 2
    config, rc = _load_config(argv[1])
    if rc:
        return rc
    roles_cfg = config.get("roles") if isinstance(config, dict) else None
    if not isinstance(roles_cfg, dict):
        return 0
    names = [argv[2]] if len(argv) == 3 else list(roles_cfg)
    for name in names:
        for note in unwired_knob_notes(name, roles_cfg.get(name)):
            print(note)
    return 0


def _default_lane_main(argv):
    """`roles.py default-lane <target-repo>` -- print the default lane name
    (first declared lane, else 'main'). Part 2's per-lane supervisor/plist
    derives the default-lane launchd label from this."""
    if len(argv) != 2:
        print("usage: roles.py default-lane <target-repo>", file=sys.stderr)
        return 2
    config, rc = _load_config(argv[1])
    if rc:
        return rc
    print(default_lane(config))
    return 0


def _lanes_main(argv):
    """`roles.py lanes <target-repo>` -- every declared lane name, one per line
    (the default lane included; 'main' when no `lanes:` block). VALIDATES the
    `lanes:` block first: a malformed block prints its errors to stderr and
    returns rc 1 rather than falling back to a bogus roster. The supervisor
    validates a `--lane` flag against this output, so membership here is the
    authoritative gate (name charset+length and declared-ness in one) -- and a
    broken block must REFUSE, never silently validate a lane against a fallback.
    Part 2's per-lane supervisor derives its target lane set from this."""
    if len(argv) != 2:
        print("usage: roles.py lanes <target-repo>", file=sys.stderr)
        return 2
    config, rc = _load_config(argv[1])
    if rc:
        return rc
    errors = _validate_lanes(config)
    if errors:
        for e in errors:
            print(e, file=sys.stderr)
        return 1
    for name in lane_names(config):
        print(name)
    return 0


def _roles_in_lane(config, lane):
    """Set of enabled role names (loop + cron + event) that belong to `lane`."""
    names = set(dispatch_roles(config, lane))
    names.update(n for n, _ in cron_roles(config, lane))
    names.update(n for n, _ in event_roles(config, lane))
    return names


def _lane_report_main(argv):
    """`roles.py lane-report <target-repo>` -- diagnostic lines for doctor,
    each `LEVEL<TAB>message` (LEVEL in OK/WARN). Prints NOTHING when no
    `lanes:` block is declared (zero noise). Otherwise: one OK summary, a WARN
    per non-default lane that has roles (Part 1 cannot execute a non-default
    lane -- routing is live but per-lane supervisors land in Part 2 of #147),
    and a WARN per cross-lane label-scope overlap."""
    if len(argv) != 2:
        print("usage: roles.py lane-report <target-repo>", file=sys.stderr)
        return 2
    config, rc = _load_config(argv[1])
    if rc:
        return rc
    declared = _declared_lane_names(config)
    if not declared:
        return 0
    dl = default_lane(config)
    print("OK\tlanes: %d declared (default: %s)" % (len(declared), dl))
    for lane in declared:
        if lane == dl:
            continue
        n = len(_roles_in_lane(config, lane))
        if n > 0:
            print("WARN\tlane %r declared with %d role(s) but per-lane "
                  "execution lands in Part 2 (#147) -- these roles do NOT run "
                  "yet" % (lane, n))
    for w in lane_overlaps(config):
        print("WARN\t%s" % w)
    return 0


def main(argv):
    if len(argv) >= 2 and argv[1] == "knob-notes":
        return _knob_notes_main(argv[1:])
    if len(argv) >= 2 and argv[1] == "scope-labels":
        return _scope_labels_main(argv[1:])
    if len(argv) >= 2 and argv[1] == "default-lane":
        return _default_lane_main(argv[1:])
    if len(argv) >= 2 and argv[1] == "lanes":
        return _lanes_main(argv[1:])
    if len(argv) >= 2 and argv[1] == "lane-report":
        return _lane_report_main(argv[1:])
    if len(argv) >= 2 and argv[1] == "dispatch":
        return _dispatch_main(argv[1:])
    if len(argv) >= 2 and argv[1] == "cron":
        return _cron_main(argv[1:])
    if len(argv) >= 2 and argv[1] == "cron-due":
        return _cron_due_main(argv[1:])
    if len(argv) >= 2 and argv[1] == "events":
        return _events_main(argv[1:])
    if len(argv) != 2:
        print("usage: roles.py <target-repo> | roles.py dispatch "
              "<target-repo> [role] | roles.py knob-notes <target-repo> [role]",
              file=sys.stderr)
        return 2
    repo = argv[1]
    config, rc = _load_config(repo)
    if rc:
        return rc
    import accounts as accounts_mod
    # Match supervisor.sh's adapter seam: AUTONOMY_AGENTS_DIR override, else the
    # engine's own bin/agents (this file lives in lib/, so ../bin/agents).
    agents_dir = os.environ.get("AUTONOMY_AGENTS_DIR") or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), os.pardir, "bin", "agents")
    errors = (validate_roles(config) + check_prompt_files(config, repo)
              + check_agent_adapters(config, agents_dir)
              + account_errors(config, accounts_mod.Accounts()))
    for e in errors:
        print(e)
    if errors:
        return 1
    return 0 if config.get("roles") else 3


if __name__ == "__main__":
    sys.exit(main(sys.argv))
