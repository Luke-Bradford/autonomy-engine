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
import re

VALID_ACTIONS = ("pause", "resume", "stop", "start")

# #24 live model/effort control. Model ids are a strict token (defense in
# depth: the value lands in a file the supervisor reads and in config.yaml,
# never a shell, but there is no reason to allow anything shell-metacharish).
# Efforts are the claude CLI's own accepted set (verified empirically).
MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\[\]-]{0,63}$")
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


# The model/effort keys whose page-writes go to the untracked overlay instead
# of the tracked config.yaml. Dotted config key -> the short overlay key the
# supervisor/dashboard already parse (mirrors the one-shot model-override
# format). board.*/merge_gate.* stay config.yaml-written because their
# consumers (board.sh, safe_merge, doctor) have no overlay read seam.
OVERLAY_KEYS = {"agent.model.primary": "model",
                "agent.model.fallback": "fallback",
                "agent.effort": "effort"}

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


def config_set_plan(repo, key, value):
    """#47 config page write: one whitelisted dotted key, validated per key.
    Returns the same {config_path, config_set, message} shape as
    set_model_plan's default scope, so the server reuses one executor."""
    value = (value or "").strip()
    validator = CONFIG_PAGE_KEYS.get(key)
    if validator is None:
        return {"error": "key %r is not editable from the page" % (key,)}
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
    being re-derivable from the worktree. Returns {label, plist} or None.
    Only considers com.autonomy.*.supervisor plists."""
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
            return {"label": name[:-len(".plist")], "plist": path}
    return None


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
    label, plist = service["label"], service["plist"]
    if action == "stop":
        return {"cmd": ["launchctl", "bootout", "gui/%d/%s" % (uid, label)],
                "message": "hard stop — booting out %s" % label}
    # start
    return {"cmd": ["launchctl", "bootstrap", "gui/%d" % uid, plist],
            "message": "started — bootstrapped %s" % label}
