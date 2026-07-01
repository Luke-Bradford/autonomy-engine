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
_MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\[\]-]{0,63}$")
VALID_EFFORTS = ("low", "medium", "high", "xhigh", "max")
VALID_SCOPES = ("session", "default")


def is_valid_action(action):
    return action in VALID_ACTIONS


def sentinel_path(repo):
    return os.path.join(repo, "var", "autonomy-logs", "autonomy-PAUSE")


def override_path(repo):
    return os.path.join(repo, "var", "autonomy-logs", "model-override")


def set_model_plan(repo, model, effort, scope):
    """Pure decision for the model/effort control (#24). Returns:
      scope=session -> {"write": override-file, "content": ..., "message"}
                       (one-shot; the supervisor consumes it at next session)
      scope=default -> {"config_path": ..., "config_set": {dotted: value},
                        "message"}  (the server rewrites config.yaml)
      {"error": ...} on any invalid input."""
    model = (model or "").strip()
    effort = (effort or "").strip()
    if scope not in VALID_SCOPES:
        return {"error": "unknown scope %r" % (scope,)}
    if not model and not effort:
        return {"error": "nothing to set — pick a model and/or an effort"}
    if model and not _MODEL_RE.match(model):
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

    config_set = {}
    if model:
        config_set["agent.model.primary"] = model
    if effort:
        config_set["agent.effort"] = effort
    return {"config_path": os.path.join(repo, ".autonomy", "config.yaml"),
            "config_set": config_set,
            "message": "saved as the repo default — applies from the next session"}


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
