#!/usr/bin/env python3
"""Lifecycle control decisions for the P2 control surface (issue #10).

The safety boundary lives here as a pure `control_plan()` that, given a repo +
action + the resolved launchd service, returns exactly WHAT to do:

  - pause / resume  -> a file touch/remove of the graceful-stop sentinel
  - stop / start    -> a specific `launchctl bootout|bootstrap` argv, and ONLY
                       that -- never a free-form command

The server executes the plan; it never builds commands itself. So every safety
property (only launchctl, start refuses without an installed plist, unknown
actions do nothing) is unit-tested without running launchctl or touching real
LaunchAgents. Lifecycle only -- this module has no notion of any target-repo
trade/order/position path and can never touch one.
"""
import os
import plistlib
import re

VALID_ACTIONS = ("pause", "resume", "stop", "start")

# #24 live model/effort control. Model ids are a strict token (defense in
# depth: the value lands in a file the supervisor reads and in config.yaml,
# never a shell, but there is no reason to allow anything shell-metacharish).
# The set includes ':' for local-LLM ids (Ollama-style name:tag, e.g.
# qwen3:14b); kept in PARITY with supervisor.sh valid_model_id (#213).
# Efforts are the claude CLI's own accepted set (verified empirically).
MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,63}$")
VALID_EFFORTS = ("low", "medium", "high", "xhigh", "max")
VALID_SCOPES = ("session", "default")


def is_valid_action(action):
    return action in VALID_ACTIONS


def sentinel_path(repo):
    return os.path.join(repo, "var", "autonomy-logs", "autonomy-PAUSE")


def override_path(repo):
    return os.path.join(repo, "var", "autonomy-logs", "model-override")


def overrides_path(repo):
    """The PERSISTENT operator-override file (#202). Lives in the gitignored
    var/autonomy-logs (same home as the one-shot model-override) so a
    'save default' survives the supervisor's preflight stash-recovery that
    would otherwise sweep a tracked config.yaml edit into a stash."""
    return os.path.join(repo, "var", "autonomy-logs", "config-overrides")


# The config-page keys whose writes go to the untracked overlay instead of the
# tracked config.yaml. Dotted config key -> the short overlay key its consumer
# parses (mirrors the one-shot model-override format). model/effort are read by
# supervisor.sh:read_config_overlay (#202); board.owner/board.project_title are
# read by board.sh:config_value_with_overlay (#211) -- so a config-page 'save
# default' both survives the preflight stash-recovery AND takes effect.
# merge_gate.strategy stays config.yaml-written: its consumers (safe_merge.sh,
# doctor.sh) are guardrail files not yet wired to the overlay.
OVERLAY_KEYS = {"agent.model.primary": "model",
                "agent.model.fallback": "fallback",
                "agent.effort": "effort",
                "board.owner": "board_owner",
                "board.project_title": "board_project_title"}

_OVERLAY_MSG = ("saved as a local override (survives the loop's preflight; "
                "config.yaml stays the committed default) — applies next session")


def set_model_plan(repo, model, effort, scope):
    """Pure decision for the model/effort control (#24). Returns:
      scope=session -> {"write": override-file, "content": ..., "message"}
                       (one-shot; the supervisor consumes it at next session)
      scope=default -> {"overlay": overrides-file, "overlay_set": {short: val},
                        "message"}  (#202: an UNtracked overlay that shadows
                       config.yaml, so the write survives preflight recovery)
      {"error": ...} on any invalid input."""
    model = (model or "").strip()
    effort = (effort or "").strip()
    if scope not in VALID_SCOPES:
        return {"error": "unknown scope %r" % (scope,)}
    if not model and not effort:
        return {"error": "nothing to set — pick a model and/or an effort"}
    if model and not MODEL_RE.match(model):
        return {"error": "invalid model id"}
    if effort and effort not in VALID_EFFORTS:
        return {"error": "invalid effort (valid: %s)" % ", ".join(VALID_EFFORTS)}

    if scope == "session":
        content = ""
        if model:
            content += "model=%s\n" % model
        if effort:
            content += "effort=%s\n" % effort
        return {"write": override_path(repo), "content": content,
                "message": "override queued — applies to the NEXT session only"}

    overlay_set = {}
    if model:
        overlay_set["model"] = model
    if effort:
        overlay_set["effort"] = effort
    return {"overlay": overrides_path(repo), "overlay_set": overlay_set,
            "message": _OVERLAY_MSG}


VALID_STRATEGIES = ("manual", "ci_only", "bot_comment", "gh_review")


def _valid_text(value):
    """Free-text config values (board owner/title): single line, bounded, and
    writable by the restricted parser (no value can hold BOTH quote kinds)."""
    return (bool(value) and len(value) <= 200
            and "\n" not in value and "\r" not in value
            and not ('"' in value and "'" in value))


# The config page (#47) may write EXACTLY these keys, each with its own
# validator. Everything else in config.yaml stays file-edited on purpose
# (strategy-specific keys, roles, worktree policy -- higher-blast-radius,
# rarely touched).
CONFIG_PAGE_KEYS = {
    "board.owner": _valid_text,
    "board.project_title": _valid_text,
    "agent.model.primary": lambda v: bool(MODEL_RE.match(v)),
    "agent.model.fallback": lambda v: bool(MODEL_RE.match(v)),
    "agent.effort": lambda v: v in VALID_EFFORTS,
    "merge_gate.strategy": lambda v: v in VALID_STRATEGIES,
}

# STRUCTURAL truth (SD-28, #211/#282): keys that define the org's shape/gate,
# NOT operational knobs. These are writable ONLY via a config.yaml commit + PR
# through the normal gate (#87) -- never the page. There is no untracked overlay
# for structure (an overlay would silently NOT take effect for consumers like
# safe_merge.sh that read committed config.yaml), and writing the tracked
# config.yaml from the page is the revert-lie this whole ticket is about: the
# loop's preflight stash-recovery sweeps the dirty file and the save vanishes.
# So the page REFUSES them with a pointer to the commit-PR path rather than
# silently accepting a write it cannot honestly persist.
STRUCTURAL_KEYS = frozenset(["merge_gate.strategy"])


def config_set_plan(repo, key, value):
    """#47 config page write: one whitelisted dotted key, validated per key.
    Returns the same {config_path, config_set, message} shape as
    set_model_plan's default scope, so the server reuses one executor."""
    value = (value or "").strip()
    validator = CONFIG_PAGE_KEYS.get(key)
    if validator is None:
        return {"error": "key %r is not editable from the page" % (key,)}
    if key in STRUCTURAL_KEYS:
        return {"error": "%s is structural config — edit it via a "
                ".autonomy/config.yaml commit + PR (#87), not the page; "
                "the page can't persist it (a tracked-file write would be "
                "silently reverted by the loop's preflight stash-recovery)"
                % key}
    if not validator(value):
        return {"error": "invalid value for %s" % key}
    short = OVERLAY_KEYS.get(key)
    if short is not None:
        return {"overlay": overrides_path(repo), "overlay_set": {short: value},
                "message": "%s saved as a local override — applies next session" % key}
    return {"config_path": os.path.join(repo, ".autonomy", "config.yaml"),
            "config_set": {key: value},
            "message": "%s saved — applies from the next session" % key}


def _registered_lines(repos_file):
    """Registry entries normalized the same way incoming paths are (strip +
    trailing-slash removal), so dedupe/membership never depends on how a
    line was hand-edited (PR #48 review)."""
    try:
        with open(repos_file) as fh:
            return [ln.strip().rstrip("/") for ln in fh if ln.strip()]
    except OSError:
        return []


def repo_add_plan(path, repos_file):
    """#47: add a repo to the shared registry (the same file discovery,
    quickstart and control.sh use). Absolute existing directory only;
    already-registered is a friendly no-op."""
    path = (path or "").strip().rstrip("/")
    if not path or not os.path.isabs(path):
        return {"error": "repo path must be absolute"}
    path = os.path.abspath(path)
    if not os.path.isdir(path):
        return {"error": "%s is not a directory on this machine" % path}
    if path in _registered_lines(repos_file):
        return {"noop": True, "message": "%s is already registered" % path}
    message = "registered %s" % path
    if not os.path.isfile(os.path.join(path, ".autonomy", "config.yaml")):
        message += " — no .autonomy pack yet; run bin/quickstart.sh on it"
    return {"append": repos_file, "line": path, "message": message}


def repo_remove_plan(path, repos_file):
    """#47: remove a repo from the registry. Works for already-deleted
    directories (that is the main cleanup case)."""
    path = (path or "").strip().rstrip("/")
    if not path:
        return {"error": "repo path required"}
    if path not in _registered_lines(repos_file):
        return {"error": "%s is not registered" % path}
    return {"rewrite": repos_file, "drop": path,
            "message": "unregistered %s (its loop, if any, is untouched)" % path}


def find_service(repo, launch_agents_dir):
    """The installed launchd service for a watched repo (worktree), found by
    matching the plist that references this repo path -- robust to the slug not
    being re-derivable from the worktree. Returns {label, plist}, {"error": ...}
    or None. Only considers com.autonomy.*.supervisor plists.

    #309: the internal <key>Label</key> is content-verified against the
    filename-derived label -- launchctl bootout uses the filename-derived label
    while bootstrap uses the plist's INTERNAL one, so a stale/hand-edited
    mismatch would make stop and start act on DIFFERENT launchd targets.
    Refuse rather than pick either (fail-safe, prevention-log #3/#18)."""
    repo = os.path.abspath(repo)
    try:
        names = os.listdir(launch_agents_dir)
    except OSError:
        return None
    needle = "<string>%s</string>" % repo
    for name in sorted(names):
        if not (name.startswith("com.autonomy.") and name.endswith(".supervisor.plist")):
            continue
        path = os.path.join(launch_agents_dir, name)
        try:
            with open(path, errors="replace") as fh:
                text = fh.read()
        except OSError:
            continue
        if "--repo" in text and needle in text:
            label = name[:-len(".plist")]
            if _plist_label(text) != label:
                return {"error": "plist %s internal Label does not match its "
                                 "filename -- refusing (stale plist?)" % name}
            return {"label": label, "plist": path}
    return None


def _plist_label(text):
    """The plist's internal <key>Label</key> value, exactly (plistlib, not a
    substring scan -- a label echoed in a comment must not pass as the Label).
    Unparseable / Label-less -> None, which never equals a real label, so
    callers refuse (fail-safe)."""
    try:
        value = plistlib.loads(text.encode("utf-8", "replace")).get("Label")
    except Exception:
        return None
    return value if isinstance(value, str) else None


# Lane names share the supervisor's validate_lane shape (bin/supervisor.sh):
# 1-64 chars of [A-Za-z0-9._-]. Re-validated HERE before the value reaches any
# filename construction -- the POST body is a boundary (prevention-log #6).
_LANE_NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


def is_valid_lane_name(lane):
    return bool(_LANE_NAME_RE.fullmatch(lane or ""))


def parse_plist_args(text):
    """The --repo / --lane values from our own supervisor plist template
    (one <string> per line, rendered by setup_worktree.sh). Total: garbage
    text yields {repo: None, lane: None}."""
    out = {"repo": None, "lane": None}
    for key in ("repo", "lane"):
        m = re.search(r"<string>--%s</string>\s*<string>([^<]+)</string>" % key,
                      text)
        if m:
            out[key] = m.group(1)
    return out


def find_lane_service(repo, lane, launch_agents_dir, default_lane=None):
    """Resolve lane -> ITS launchd service, strictly (#147 / SD-21: one
    supervisor per lane; the DEFAULT lane keeps the LEGACY
    com.autonomy.<slug>.supervisor label with no --lane). Returns:
      None                      -- the registered repo's own service already
                                   runs this lane; caller uses the existing
                                   per-repo path.
      {"label","plist","repo"}  -- the lane's service; `repo` is ITS worktree
                                   (where the pause sentinel lives).
      {"error": ...}            -- refusal. NEVER falls back to a different
                                   lane's service: acting on the wrong loop is
                                   the fail-open direction.
    The label is CONSTRUCTED from the registered service's own label (slug) +
    the lane, then content-verified (--lane value AND the plist's internal
    Label): a stale/mismatched plist refuses -- launchctl stop uses the
    constructed label while start bootstraps the plist's internal one, so a
    mismatch would make the two act on different targets."""
    if not is_valid_lane_name(lane):
        return {"error": "invalid lane name"}
    own = find_service(repo, launch_agents_dir)
    if own is None:
        return {"error": "no launchd service installed for this repo -- run "
                         "setup_worktree.sh first"}
    if "error" in own:          # #309: stale own plist -- slug would be a lie
        return own
    try:
        with open(own["plist"], errors="replace") as fh:
            own_text = fh.read()
    except OSError:
        return {"error": "cannot read the repo's own plist"}
    own_lane = parse_plist_args(own_text).get("lane")
    seg = own["label"][len("com.autonomy."):-len(".supervisor")]
    is_default = (default_lane is not None and lane == default_lane)
    if own_lane == lane or (own_lane is None and is_default):
        return None
    slug = seg
    if own_lane and is_valid_lane_name(own_lane) and seg.endswith("." + own_lane):
        slug = seg[:-(len(own_lane) + 1)]
    label = ("com.autonomy.%s.supervisor" % slug if is_default
             else "com.autonomy.%s.%s.supervisor" % (slug, lane))
    plist = os.path.join(launch_agents_dir, label + ".plist")
    try:
        with open(plist, errors="replace") as fh:
            text = fh.read()
    except OSError:
        return {"error": "no service installed for lane '%s' -- run "
                         "setup_worktree.sh <target-repo> --lane %s"
                         % (lane, lane)}
    args = parse_plist_args(text)
    want_lane = None if is_default else lane
    if args.get("lane") != want_lane or not args.get("repo"):
        return {"error": "plist for lane '%s' does not match (lane=%r) -- "
                         "refusing" % (lane, args.get("lane"))}
    if _plist_label(text) != label:
        return {"error": "plist Label does not match its filename for lane "
                         "'%s' -- refusing (stale plist?)" % lane}
    return {"label": label, "plist": plist, "repo": args["repo"]}


def control_plan(repo, action, service, uid):
    """Pure decision: what a lifecycle action does. Returns one of:
      {"touch": path, "message": ...}   (pause)
      {"remove": path, "message": ...}  (resume)
      {"cmd": [launchctl ...], "message": ...}  (stop/start, needs a service)
      {"error": ...}
    """
    if not is_valid_action(action):
        return {"error": "unknown action %r" % (action,)}

    sentinel = sentinel_path(repo)
    if action == "pause":
        return {"touch": sentinel,
                "message": "graceful stop requested — the supervisor will finish "
                           "the current session, then idle"}
    if action == "resume":
        return {"remove": sentinel,
                "message": "resumed — the supervisor will pick up the next session"}

    # stop / start need the launchd service
    if not service:
        return {"error": "no launchd service installed for this repo — run "
                         "setup_worktree.sh first"}
    if "error" in service:      # #309: find_service refused (stale plist)
        return {"error": service["error"]}
    label, plist = service["label"], service["plist"]
    if action == "stop":
        return {"cmd": ["launchctl", "bootout", "gui/%d/%s" % (uid, label)],
                "message": "hard stop — booting out %s" % label}
    # start
    return {"cmd": ["launchctl", "bootstrap", "gui/%d" % uid, plist],
            "message": "started — bootstrapped %s" % label}


# The most a control toast's title line can readably show; a longer first line
# is truncated there and the full text moves to the expandable `detail` block.
_TOAST_REASON_MAX = 200


def format_cmd_error(cmd_name, stderr):
    """Split a failed control command's stderr into a SHORT toast reason
    (`error`) plus an optional full-text `detail` (#151 item 6). launchctl
    errors routinely exceed the ~200 chars a toast title can show; clipping
    them there hid the real cause. The page renders `error` inline and
    `detail` -- when present -- in an expandable block.

    `error` is the command name + the FIRST line of stderr (the actionable
    part), capped at _TOAST_REASON_MAX with an ellipsis. `detail` is the full
    stripped stderr, included ONLY when it carries more than the inline reason
    already shows (a longer first line, or more lines) -- so a short
    single-line failure never grows a redundant expander. Empty stderr degrades
    to a bare 'no error output' reason (never a crash)."""
    full = (stderr or "").strip()
    if not full:
        return {"error": "%s: command failed with no error output" % cmd_name}
    first = full.splitlines()[0]
    if len(first) > _TOAST_REASON_MAX:
        shown = first[:_TOAST_REASON_MAX - 1] + "…"
    else:
        shown = first
    out = {"error": "%s: %s" % (cmd_name, shown)}
    if full != shown:                       # more than the toast shows -> offer it
        out["detail"] = full
    return out
