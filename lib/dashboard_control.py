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
import json
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

    # Slice 3a (SD-34): default-scope saves land in the var-live shadow --
    # the persistent overlay write path is retired (a shadow-of-a-shadow was
    # exactly the fable-5-vs-sonnet-5 confusion). The one-shot session scope
    # above is the only override left.
    live_set = {}
    if model:
        live_set["agent.model.primary"] = model
    if effort:
        live_set["agent.effort"] = effort
    return {"live_set": live_set,
            "message": "saved to the live config — applies from the next session"}


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
    # Slice 3a: the pair's thinking tier -- materialized into the planner
    # agent file by the supervisor each session (valid_model_id re-checks).
    "agent.planner.model": lambda v: bool(MODEL_RE.match(v)),
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
    # Slice 3a (SD-34): every page-editable key lands in the var-live shadow
    # -- one write home, no overlay-of-a-shadow, no tracked-file write for
    # preflight to sweep.
    return {"live_set": {key: value},
            "message": "%s saved to the live config — applies from the next session" % key}


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


TRIGGER_CTL_ACTIONS = ("trigger_fire", "trigger_stop", "trigger_resume")


def trigger_ctl_plan(marker_repo, action, name, lane_suffix=""):
    """Pure plan for a per-trigger marker write (Phase D1, #383).
    marker_repo = the VERIFIED consuming supervisor's repo (the caller
    resolves lanes via find_lane_service, execute_control-style);
    lane_suffix = "" for that repo's default-lane supervisor, else the
    lane name. Path mechanics ONLY: mode/fire-readiness/lane-routing
    validation happens in the caller. Charset gates BOTH name and lane
    (prevention-log #6, via triggers.marker_basename -- the one
    supervisor-parity rule) and refuses reserved sidecar suffixes
    (defense in depth: validate_trigger already refuses them at mint).
    Never touches the filesystem. fire/stop markers are EMPTY files;
    queued/ and backoff/ are supervisor-owned and never planned here."""
    if action not in TRIGGER_CTL_ACTIONS:
        return {"error": "unknown trigger action"}
    import pipeline as _pl
    import triggers as _tr
    try:
        base = _tr.marker_basename(name, lane_suffix or "")
    except Exception as exc:
        return {"error": str(exc)}
    if "." in base and base.rsplit(".", 1)[-1] in \
            _pl._RESERVED_SIDECAR_SUFFIXES:
        return {"error": "trigger name ends in a reserved sidecar suffix"}
    sub = "fire" if action == "trigger_fire" else "stop"
    path = os.path.join(marker_repo, "var", "trigger-ctl", sub, base)
    if action == "trigger_resume":
        return {"remove": path,
                "message": "stop marker removed — %s resumes" % base}
    if action == "trigger_fire":
        return {"touch": path,
                "message": "run-now marker set for %s — the supervisor "
                           "fires it on its next tick" % base}
    return {"touch": path,
            "message": "stop marker set — %s is frozen (no new fires, no "
                       "advance) until resumed" % base}


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


# --- workstreams slice 1: the var-live structural writer ---------------------
# UI config edits land in <repo>/var/autonomy/config.yaml -- the
# preflight-surviving home (a tracked-file edit would be stash-swept after 3
# dirty sessions; that sweep is why the legacy overlay existed). The committed
# .autonomy/config.yaml stays the shareable default that SEEDS the live file
# on first write (legacy overlay folded in, then deleted). Readers resolve via
# _cp.effective_config_path -- one choke point, no split-brain.
# SD-29 mechanics kept: validate BEFORE writing, re-parse + compare AFTER
# building the candidate; any refusal leaves every file untouched.

import subprocess as _subprocess  # noqa: E402  (writer-only dependency)
import shutil as _shutil  # noqa: E402  (pipeline_save dir stage/rollback)

import sys as _sys  # noqa: E402
_sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config_parser as _cp  # noqa: E402


_EMIT_TOKEN_RE = re.compile(r"^[A-Za-z0-9._/*-]+$")
_EMIT_KEY_RE = re.compile(r"^[A-Za-z0-9._-]+$")


def live_config_path(repo):
    return os.path.join(repo, "var", "autonomy", "config.yaml")


def _emit_scalar(val, where):
    """One scalar in the restricted subset, quoted when needed. Refuses what
    the subset cannot represent (newlines, both quote kinds) -- a refused
    emit must never become a mis-parsing write."""
    if isinstance(val, bool):
        return "true" if val else "false"
    if isinstance(val, int):
        return str(val)
    if isinstance(val, str):
        if "\n" in val:
            raise ValueError("%s: newlines are not representable" % where)
        if _EMIT_TOKEN_RE.match(val):
            return val
        if '"' not in val:
            return '"%s"' % val
        if "'" not in val:
            return "'%s'" % val
        raise ValueError("%s: cannot represent a value containing both "
                         "quote kinds" % where)
    raise ValueError("%s: unsupported value type %s" % (where, type(val).__name__))


def _emit_mapping(d, indent, where):
    lines = []
    pad = " " * indent
    for key in d:
        if not (isinstance(key, str) and _EMIT_KEY_RE.match(key)):
            raise ValueError("%s: key %r is not emittable" % (where, key))
        val = d[key]
        kwhere = "%s.%s" % (where, key)
        if isinstance(val, dict):
            lines.append("%s%s:" % (pad, key))
            lines.extend(_emit_mapping(val, indent + 2, kwhere))
        elif isinstance(val, list):
            items = []
            for item in val:
                # flow-list items stay bare tokens only: a quoted item inside
                # [] is outside the restricted subset's tested surface.
                if not (isinstance(item, str) and _EMIT_TOKEN_RE.match(item)):
                    raise ValueError("%s: list item %r is not emittable"
                                     % (kwhere, item))
                items.append(item)
            lines.append("%s%s: [%s]" % (pad, key, ", ".join(items)))
        else:
            lines.append("%s%s: %s" % (pad, key, _emit_scalar(val, kwhere)))
    return lines


def roles_block_emit(roles):
    """The `roles:` block as restricted-subset text. Raises ValueError with
    the offending role/key named when a value cannot be represented; the
    caller turns that into a refused write."""
    if not isinstance(roles, dict):
        raise ValueError("roles must be a mapping")
    lines = ["roles:"]
    lines.extend(_emit_mapping(roles, 2, "roles"))
    return "\n".join(lines) + "\n"


def set_block(text, key, block_text):
    """Replace the top-level `key:` block in TEXT with block_text; append
    when absent. The block runs from its key line to the next top-level key
    (first column-0 line that isn't blank or a comment). In-block comments
    are an accepted loss (SD-29); everything outside is byte-preserved."""
    lines = text.splitlines(keepends=True)
    start = end = None
    for i, ln in enumerate(lines):
        if start is None:
            if ln.startswith(key + ":"):
                start = i
            continue
        stripped = ln.strip()
        if ln[:1] not in (" ", "\t") and stripped and not stripped.startswith("#"):
            end = i
            break
    if start is None:
        joined = text
        if joined and not joined.endswith("\n"):
            joined += "\n"
        return joined + block_text
    if end is None:
        end = len(lines)
    if not block_text.endswith("\n"):
        block_text += "\n"
    return "".join(lines[:start]) + block_text + "".join(lines[end:])


# key -> (dotted target, the SAME validator the overlay readers applied) --
# a value the supervisor/dashboard would have IGNORED in the overlay must not
# become effective config through the fold (CP2). Invalid values are skipped:
# they were dead weight in the overlay too.
_OVERLAY_FOLD_KEYS = {
    "model": ("agent.model.primary", lambda v: bool(MODEL_RE.match(v))),
    "fallback": ("agent.model.fallback", lambda v: bool(MODEL_RE.match(v))),
    "effort": ("agent.effort", lambda v: v in VALID_EFFORTS),
    "board_owner": ("board.owner", _valid_text),
    "board_project_title": ("board.project_title", _valid_text),
}


def _fold_overlay(repo, text):
    """Fold the legacy persistent overlay's values into the seed TEXT via
    set_scalar. Returns (text, overlay_path_or_None): the path is returned
    ONLY when every readable value folded cleanly, so the caller deletes the
    overlay strictly after a successful write. Unreadable overlay -> no fold,
    no delete (values must never be silently lost)."""
    path = overrides_path(repo)
    try:
        with open(path, errors="replace") as fh:
            raw_lines = fh.read().splitlines()
    except OSError:
        return text, None
    for raw in raw_lines:
        k, sep, v = raw.partition("=")
        if not sep or not k or k != k.strip() or v != v.strip():
            continue                     # dirty line: supervisor ignored it too
        entry = _OVERLAY_FOLD_KEYS.get(k)
        if entry is None or not v:
            continue
        dotted, valid = entry
        if not valid(v):
            continue                     # readers ignored it; folding it would
                                         # PROMOTE an invalid value (CP2)
        try:
            text = _cp.set_scalar(text, dotted, v)
        except Exception:
            return text, None            # unfoldable -> keep the overlay file
    return text, path


def _var_live_protected(repo, rel="var/autonomy/config.yaml"):
    """The live file/dir must be invisible to git, or preflight's `stash -u`
    sweeps it (silent loss). Unknown/error = NOT protected (fail-safe: refuse
    the write rather than risk the sweep). `rel` is a repo-relative path under
    var/ (default: the config shadow; pipeline_save passes the pipeline shadow)."""
    try:
        rc = _subprocess.run(
            ["git", "-C", repo, "check-ignore", "-q", rel],
            stdout=_subprocess.DEVNULL, stderr=_subprocess.DEVNULL, timeout=10)
    except (OSError, _subprocess.SubprocessError):
        return False
    return rc.returncode == 0


def structural_write(repo, new_roles):
    """Apply a new `roles:` mapping to the repo's live config. Returns
    {ok: True, path, message} or {ok: False, error}. Refusals leave every
    file untouched."""
    committed = os.path.join(repo, ".autonomy", "config.yaml")
    live = live_config_path(repo)
    if not _var_live_protected(repo):
        return {"ok": False, "error":
                "var/ is not covered by this repo's .gitignore -- the loop's "
                "preflight would sweep the live config. Add a 'var/' line to "
                ".gitignore (and commit it) first."}
    overlay_to_delete = None
    try:
        if os.path.isfile(live):
            with open(live, encoding="utf-8") as fh:
                base = fh.read()
        else:
            with open(committed, encoding="utf-8") as fh:
                base = fh.read()
            base, overlay_to_delete = _fold_overlay(repo, base)
    except OSError as exc:
        return {"ok": False, "error": "cannot read config: %s" % exc}
    try:
        base_parsed = _cp.parse(base)
    except ValueError as exc:
        return {"ok": False, "error": "current config does not parse: %s" % exc}
    try:
        block = roles_block_emit(new_roles)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    candidate = set_block(base, "roles", block)
    try:
        cand_parsed = _cp.parse(candidate)
    except ValueError as exc:
        return {"ok": False, "error": "candidate config does not parse: %s" % exc}
    import roles as _roles
    errors = _roles.validate_roles(cand_parsed)
    if errors:
        return {"ok": False, "error": "; ".join(errors)}
    if cand_parsed.get("roles") != new_roles:
        return {"ok": False, "error":
                "re-parse mismatch: written roles would not read back "
                "identically -- write refused"}
    base_others = {k: v for k, v in base_parsed.items() if k != "roles"}
    cand_others = {k: v for k, v in cand_parsed.items() if k != "roles"}
    if base_others != cand_others:
        return {"ok": False, "error":
                "re-parse mismatch: a non-roles key drifted -- write refused"}
    os.makedirs(os.path.dirname(live), exist_ok=True)
    tmp = live + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(candidate)
        os.replace(tmp, live)
    except OSError as exc:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        return {"ok": False, "error": "could not write live config: %s" % exc}
    message = "saved to the live config -- applies next tick"
    if overlay_to_delete:
        # The stale overlay is NOT inert: _read_config/the supervisor still
        # apply it over the (now live) config (CP2).
        warn = _retire_overlay(overlay_to_delete)
        if warn:
            message += " -- WARNING: " + warn
    return {"ok": True, "path": live, "message": message}


def live_config_drift(repo):
    """{live, differs} for the page badge: does a live shadow exist, and does
    it differ (bytes) from the committed default? Best-effort, never raises."""
    committed = os.path.join(repo, ".autonomy", "config.yaml")
    live = live_config_path(repo)
    try:
        with open(live, "rb") as fh:
            live_b = fh.read()
    except OSError:
        return {"live": False, "differs": False}
    try:
        with open(committed, "rb") as fh:
            committed_b = fh.read()
    except OSError:
        return {"live": True, "differs": True}
    return {"live": True, "differs": live_b != committed_b}


def _retire_overlay(path):
    """Delete (or truncate) the legacy overlay after its values were folded.
    Returns a warning string when neither works -- the stale overlay still
    shadows model/effort and the caller must say so."""
    try:
        os.unlink(path)
        return None
    except OSError:
        try:
            with open(path, "w"):
                pass
            return None
        except OSError:
            return ("could not remove the legacy overlay (%s); its values "
                    "still shadow model/effort until it is deleted" % path)


def live_scalar_write(repo, live_set):
    """Slice 3a: apply {dotted key: value} scalar edits to the live shadow
    (values are validated by the CALLER against CONFIG_PAGE_KEYS -- this is
    the write mechanism, not the policy). Same seeding + refusal semantics
    as structural_write: first use seeds from committed + folds/retires the
    legacy overlay; any refusal leaves every file untouched."""
    committed = os.path.join(repo, ".autonomy", "config.yaml")
    live = live_config_path(repo)
    if not _var_live_protected(repo):
        return {"ok": False, "error":
                "var/ is not covered by this repo's .gitignore -- the loop's "
                "preflight would sweep the live config. Add a 'var/' line to "
                ".gitignore (and commit it) first."}
    overlay_to_delete = None
    try:
        if os.path.isfile(live):
            with open(live, encoding="utf-8") as fh:
                base = fh.read()
        else:
            with open(committed, encoding="utf-8") as fh:
                base = fh.read()
            base, overlay_to_delete = _fold_overlay(repo, base)
    except OSError as exc:
        return {"ok": False, "error": "cannot read config: %s" % exc}
    candidate = base
    for key in sorted(live_set):
        try:
            candidate = _cp.set_scalar(candidate, key, live_set[key])
        except KeyError:
            # set_scalar only rewrites EXISTING keys; a new key (e.g. the
            # first agent.planner.model) is created by re-emitting its
            # top-level block from the parsed dict (in-block comments are
            # SD-29's accepted loss; bytes outside the block are preserved).
            try:
                candidate = _create_scalar(candidate, key, live_set[key])
            except ValueError as exc:
                return {"ok": False, "error": str(exc)}
        except ValueError as exc:
            return {"ok": False, "error": "could not set value: %s" % exc}
    try:
        _cp.parse(candidate)
    except ValueError as exc:
        return {"ok": False, "error": "candidate config does not parse: %s" % exc}
    os.makedirs(os.path.dirname(live), exist_ok=True)
    tmp = live + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(candidate)
        os.replace(tmp, live)
    except OSError as exc:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        return {"ok": False, "error": "could not write live config: %s" % exc}
    message = "saved to the live config -- applies from the next session"
    if overlay_to_delete:
        warn = _retire_overlay(overlay_to_delete)
        if warn:
            message += " -- WARNING: " + warn
    return {"ok": True, "path": live, "message": message}


def _create_scalar(text, dotted, value):
    """Create a missing dotted scalar by re-emitting its top-level block.
    Raises ValueError when the path crosses a non-mapping or the value is
    not emittable (the caller refuses the write)."""
    parts = dotted.split(".")
    if len(parts) < 2:
        raise ValueError("cannot create top-level key %r from the page" % dotted)
    cfg = _cp.parse(text)
    top = parts[0]
    sub = cfg.get(top) if isinstance(cfg, dict) else None
    if sub is not None and not isinstance(sub, dict):
        # `agent: claude`-style scalar at the top key: silently replacing it
        # with a mapping would rewrite meaning the operator set (CP2).
        raise ValueError("%s: %r is not a mapping -- write refused" % (dotted, top))
    sub = sub if isinstance(sub, dict) else {}
    node = sub
    for p in parts[1:-1]:
        nxt = node.get(p)
        if nxt is None:
            nxt = {}
            node[p] = nxt
        if not isinstance(nxt, dict):
            raise ValueError("%s crosses a non-mapping value -- write refused" % dotted)
        node = nxt
    node[parts[-1]] = value
    block = top + ":\n" + "\n".join(_emit_mapping(sub, 2, top)) + "\n"
    return set_block(text, top, block)


# --- authoring slice: create/edit workstreams from the page ------------------
# A workstream IS a roles: entry (config-workstreams spec). UI-authored rails
# live in the UNTRACKED var/autonomy/roles/ (a tracked rail edit would be
# preflight sweep-bait, exactly like the config shadow); editing a tracked
# pack rail LOCALIZES it there first (copy + repoint prompt:) so committed
# content is never touched. Every structural change goes through
# structural_write -- validate-before, compare-after, refuse-untouched.

import re as _re  # noqa: E402
_WS_NAME_RE = _re.compile(r"^[A-Za-z0-9._-]{1,64}$")
_WS_TEMPLATES = {
    "coder": ("loop", None),
    "pm": ("cron", "roles/pm.md"),
    "qa": ("event", "roles/qa.md"),
    "researcher": ("cron", "roles/researcher.md"),
    "custom": ("loop", None),
}
_PROMPT_CAP = 200000
_DEFAULT_TRIGGERS = {
    "loop": {"type": "loop"},
    "cron": {"type": "cron", "schedule": "0 9 * * *"},
    "event": {"type": "event", "on": ["pr.opened"]},
}


def _effective_roles(repo):
    """(roles_dict, error) -- the CURRENT effective roles mapping (live shadow
    when present). Total: parse failure returns the error string."""
    path = _cp.effective_config_path(
        os.path.join(repo, ".autonomy", "config.yaml"))
    try:
        with open(path, encoding="utf-8") as fh:
            cfg = _cp.parse(fh.read())
    except (OSError, ValueError) as exc:
        return None, "cannot read config: %s" % exc
    roles = cfg.get("roles") if isinstance(cfg, dict) else None
    return (roles if isinstance(roles, dict) else {}), None


def _var_rail_path(name):
    return os.path.join("var", "autonomy", "roles", "%s.md" % name)


def ws_add(repo, name, template, engine_home):
    """Add a workstream from a template: scaffolds its rail into the
    untracked var/autonomy/roles/<name>.md and appends a DISABLED roles:
    entry with the template's default trigger."""
    name = (name or "").strip()
    if not _WS_NAME_RE.match(name):
        return {"ok": False, "error": "workstream name must be 1-64 chars of A-Za-z0-9._-"}
    if template not in _WS_TEMPLATES:
        return {"ok": False, "error": "unknown template %r" % template}
    roles, err = _effective_roles(repo)
    if err:
        return {"ok": False, "error": err}
    if name in roles:
        return {"ok": False, "error": "workstream %r already exists" % name}
    trig_kind, rail_tpl = _WS_TEMPLATES[template]
    rail_text = "# %s workstream\n\nDescribe this workstream's standing task here.\n" % name
    if rail_tpl:
        tpl_path = os.path.join(engine_home, "templates", "autonomy-pack", rail_tpl)
        try:
            with open(tpl_path, encoding="utf-8") as fh:
                rail_text = fh.read()
        except OSError:
            pass                       # template missing -> starter stub
    rail_rel = _var_rail_path(name)
    rail_abs = os.path.join(repo, rail_rel)
    entry = {"enabled": False,
             "trigger": dict(_DEFAULT_TRIGGERS[trig_kind]),
             "prompt": rail_rel}
    new_roles = dict(roles)
    new_roles[name] = entry
    # rail first (roles.py validates prompt existence), then the entry; a
    # refused write leaves an orphan rail in var/ -- inert and gitignored.
    try:
        os.makedirs(os.path.dirname(rail_abs), exist_ok=True)
        with open(rail_abs, "w", encoding="utf-8") as fh:
            fh.write(rail_text)
    except OSError as exc:
        return {"ok": False, "error": "could not write the rail: %s" % exc}
    res = structural_write(repo, new_roles)
    if not res.get("ok"):
        return res
    return {"ok": True,
            "message": "%s added (disabled) — set its trigger and prompt, then enable it" % name}


def ws_set(repo, name, patch):
    """Patch one workstream's entry. Allowed patch keys: enabled (bool),
    trigger ({type, schedule|on}), scope_labels (list), gate, model, effort,
    account, prompt. Values validated here (page-level policy) AND by
    roles.validate_roles inside structural_write (the SSOT)."""
    roles, err = _effective_roles(repo)
    if err:
        return {"ok": False, "error": err}
    if name not in roles:
        return {"ok": False, "error": "no workstream named %r" % name}
    entry = dict(roles[name] if isinstance(roles[name], dict) else {})
    for key, val in (patch or {}).items():
        if key == "enabled":
            entry["enabled"] = bool(val)
        elif key == "trigger":
            trig = val if isinstance(val, dict) else {}
            kind = str(trig.get("type") or "")
            if kind == "loop":
                entry["trigger"] = {"type": "loop"}
            elif kind == "manual":
                entry["trigger"] = {"type": "manual"}
            elif kind == "cron":
                entry["trigger"] = {"type": "cron",
                                    "schedule": str(trig.get("schedule") or "")}
            elif kind == "event":
                on = trig.get("on") if isinstance(trig.get("on"), list) else []
                entry["trigger"] = {"type": "event",
                                    "on": [str(x) for x in on]}
            else:
                return {"ok": False, "error": "unknown trigger type %r" % kind}
        elif key == "scope_labels":
            labels = [str(x).strip() for x in (val or []) if str(x).strip()]
            if labels:
                scope = entry.get("scope") if isinstance(entry.get("scope"), dict) else {}
                scope = dict(scope)
                scope["labels"] = labels
                entry["scope"] = scope
            else:
                entry.pop("scope", None)
        elif key == "gate":
            if val:
                entry["gate"] = str(val)
            else:
                entry.pop("gate", None)
        elif key == "prompt":
            if val:
                rel = str(val)
                full = os.path.realpath(os.path.join(repo, rel))
                root = os.path.realpath(repo)
                if os.path.isabs(rel) or not (full == root or full.startswith(root + os.sep)):
                    return {"ok": False, "error":
                            "prompt must be a repo-relative path inside the repo"}
                entry["prompt"] = rel
            else:
                entry.pop("prompt", None)
        elif key in ("model", "effort", "account"):
            if val:
                entry[key] = str(val)
            else:
                entry.pop(key, None)
        else:
            return {"ok": False, "error": "key %r is not patchable" % key}
    new_roles = dict(roles)
    new_roles[name] = entry
    return structural_write(repo, new_roles)


def _resolved_rail(repo, name):
    """(rel_path, error) for the workstream's prompt file. Standard roles
    without an explicit prompt: resolve to the pack's conventional rail
    (roles.py's own default); path is re-validated to stay inside the repo."""
    roles, err = _effective_roles(repo)
    if err:
        return None, err
    entry = roles.get(name)
    if entry is None:
        return None, "no workstream named %r" % name
    entry = entry if isinstance(entry, dict) else {}
    rel = str(entry.get("prompt") or "")
    if not rel:
        rel = ".autonomy/roles/%s.md" % name if name != "coder" else ".autonomy/loop_prompt.md"
    full = os.path.realpath(os.path.join(repo, rel))
    root = os.path.realpath(repo)
    if not (full == root or full.startswith(root + os.sep)):
        return None, "prompt path escapes the repo -- refused"
    return rel, None


def ws_prompt_get(repo, name):
    rel, err = _resolved_rail(repo, name)
    if err:
        return {"ok": False, "error": err}
    try:
        with open(os.path.join(repo, rel), encoding="utf-8", errors="replace") as fh:
            return {"ok": True, "path": rel, "content": fh.read()}
    except OSError:
        return {"ok": True, "path": rel, "content": ""}


def ws_prompt_set(repo, name, content):
    """Write the workstream's rail. UI-authored rails live under
    var/autonomy/roles/ (untracked); a rail anywhere else (a committed pack
    file) is LOCALIZED: content goes to the var rail and prompt: repoints --
    the committed file is never modified."""
    if not isinstance(content, str) or len(content) > _PROMPT_CAP:
        return {"ok": False, "error": "prompt must be a string under %d bytes" % _PROMPT_CAP}
    rel, err = _resolved_rail(repo, name)
    if err:
        return {"ok": False, "error": err}
    var_prefix = os.path.join("var", "autonomy", "roles") + os.sep
    target_rel = rel if rel.startswith(var_prefix) else _var_rail_path(name)
    target_abs = os.path.join(repo, target_rel)
    # snapshot for rollback: a refused localize must leave NO new/changed rail
    # behind (CP2 -- refusals leave files untouched).
    prior = None
    if os.path.isfile(target_abs):
        try:
            with open(target_abs, "rb") as fh:
                prior = fh.read()
        except OSError:
            prior = None
    try:
        os.makedirs(os.path.dirname(target_abs), exist_ok=True)
        tmp = target_abs + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(content)
        os.replace(tmp, target_abs)
    except OSError as exc:
        return {"ok": False, "error": "could not write the rail: %s" % exc}
    if target_rel != rel:
        res = ws_set(repo, name, {"prompt": target_rel})
        if not res.get("ok"):
            try:                                   # roll the rail back
                if prior is None:
                    os.unlink(target_abs)
                else:
                    with open(target_abs, "wb") as fh:
                        fh.write(prior)
            except OSError:
                pass
            return {"ok": False, "error":
                    "could not localize the rail (config write refused: %s) -- nothing changed"
                    % res.get("error")}
        return {"ok": True, "path": target_rel,
                "message": "rail localized to %s (the committed file is untouched)" % target_rel}
    return {"ok": True, "path": target_rel, "message": "rail saved"}


# --- P3b (#365): canvas pipeline editor -> var-live shadow writer ------------
# SD-34 (var-shadow home) applied to pipeline DOCUMENTS + SD-29 (double-
# validation, refuse-untouched) mechanics, generalized from structural_write to
# a DIRECTORY asset (pipeline.json + sibling briefs). Reader-safe install
# (pipeline.json published last) + snapshot rollback; a present-but-invalid
# shadow is never trusted as a seed (no laundering).

_PIPELINE_DOC_CAP = 200000   # per-file byte cap (the _PROMPT_CAP precedent)


def _pipeline_seed_dir(committed, shadow):
    """Where untouched briefs come from: the current shadow IF it is itself
    valid (so prior edits survive a later save), else the committed pack. A
    present-but-INVALID shadow is NEVER trusted as a seed -- no laundering of
    its arbitrary content (SD-34/prevention-log #3); the operator's posted doc
    is the fix and untouched briefs reset to the known-good committed base.
    Total -- any read error falls to committed."""
    import pipeline as _pl
    if os.path.isdir(shadow) and not os.path.islink(shadow):
        try:
            cur = _pl.load_doc(os.path.join(shadow, "pipeline.json"))
            if not _pl.validate_doc(cur, shadow):
                return shadow
        except _pl.PipelineError:
            pass
    return committed


def pipeline_save(repo, name, doc, briefs):
    """Whole-doc re-emit of a pipeline into its var-live shadow
    <repo>/var/autonomy/pipelines/<name>/ (SD-34 for pipeline documents; SD-29
    double-validation). `doc` is the full pipeline document; `briefs` maps
    sibling basenames -> content for briefs edited on the canvas. Untouched
    briefs are seeded per-ref from _pipeline_seed_dir so prior edits survive.
    Returns {ok: True, path, message} or {ok: False, error}; every refusal/
    exception leaves the shadow byte-identical. P3b edits a BOUND pipeline only
    -- a name with no committed pack is refused (creating/binding is P4)."""
    import pipeline as _pl
    # charset-gate the name BEFORE any path is built (prevention-log #6; the ONE
    # binding gate dispatch also uses -- what dispatch refuses can never be saved)
    if not _pl.valid_pipeline_name(name):
        return {"ok": False, "error": "pipeline name has invalid charset"}
    if not isinstance(doc, dict):
        return {"ok": False, "error": "pipeline document must be a JSON object"}
    if not isinstance(briefs, dict):
        return {"ok": False, "error": "briefs must be a mapping"}
    # the document's OWN name must match the save target, or the shadow dir
    # <name> would hold a doc named otherwise -- splitting binding / journal /
    # ledger / provenance (Codex CP1 #2).
    if doc.get("name") != name:
        return {"ok": False, "error":
                "document name %r must match the pipeline name %r"
                % (doc.get("name"), name)}
    for bname, bcontent in briefs.items():
        if not _pl._valid_brief_ref(bname):
            return {"ok": False, "error":
                    "brief %r is not a sibling basename (no paths, no dotfiles)"
                    % bname}
        if not isinstance(bcontent, str) or \
                len(bcontent.encode("utf-8")) > _PIPELINE_DOC_CAP:   # BYTES (#9)
            return {"ok": False, "error":
                    "brief %r must be a string under %d bytes"
                    % (bname, _PIPELINE_DOC_CAP)}
    # gitignore guard (SD-34): var/ must be ignored or preflight sweeps it.
    if not _var_live_protected(repo, os.path.join("var", "autonomy", "pipelines")):
        return {"ok": False, "error":
                "var/ is not covered by this repo's .gitignore -- the loop's "
                "preflight would sweep the pipeline shadow. Add a 'var/' line to "
                ".gitignore (and commit it) first."}
    # serialize once; cap the DOCUMENT too, not just briefs (#9), before validate
    serialized = json.dumps(doc, indent=2, sort_keys=True)
    if len(serialized.encode("utf-8")) > _PIPELINE_DOC_CAP:
        return {"ok": False, "error":
                "pipeline document exceeds %d bytes" % _PIPELINE_DOC_CAP}
    # structural pre-check (brief existence is re-checked post-stage)
    errs = _pl.validate_doc(doc, None)
    if errs:
        return {"ok": False, "error": "; ".join(errs)}
    committed = os.path.join(repo, ".autonomy", "pipelines", name)
    shadow = os.path.join(repo, "var", "autonomy", "pipelines", name)
    # BOUND pipelines only: a name with no committed pack is not editable even
    # if an orphan shadow exists (Codex CP1 #5).
    if not os.path.isdir(committed):
        return {"ok": False, "error":
                "no committed pipeline %r to edit (bind one first)" % name}
    # A symlinked or non-directory shadow path is NOT a sanctioned shadow:
    # refuse BEFORE we seed/stage, so the writer can never read or write
    # through a symlink out of var/ (path-escape guard, Codex CP2).
    if os.path.islink(shadow) or (os.path.exists(shadow) and not os.path.isdir(shadow)):
        return {"ok": False, "error":
                "the pipeline shadow path is not a clean directory -- refusing"}
    seed = _pipeline_seed_dir(committed, shadow)
    staging = shadow + ".staging"
    try:
        os.makedirs(os.path.dirname(shadow), exist_ok=True)
        _shutil.rmtree(staging, ignore_errors=True)
        os.makedirs(staging)
        with open(os.path.join(staging, "pipeline.json"), "w",
                  encoding="utf-8") as fh:
            fh.write(serialized)
        # staging gets EXACTLY the doc's referenced briefs -- posted edits, else
        # copied (regular files only) from the seed. No blind copytree, so stray
        # files / symlinks in a legacy or hostile pack are never laundered in (#7).
        for node in (doc.get("nodes") or []):
            ref = node.get("brief_ref") if isinstance(node, dict) else None
            if not (isinstance(ref, str) and _pl._valid_brief_ref(ref)):
                continue                          # validate_doc will flag it
            dst = os.path.join(staging, ref)
            if os.path.exists(dst):
                continue
            if ref in briefs:
                with open(dst, "w", encoding="utf-8") as fh:
                    fh.write(briefs[ref])
            else:
                src = os.path.join(seed, ref)
                if os.path.isfile(src) and not os.path.islink(src):
                    _shutil.copyfile(src, dst)
        # re-load + re-validate against staging (brief-existence NOW checked)
        reloaded = _pl.load_doc(os.path.join(staging, "pipeline.json"))
        errs2 = _pl.validate_doc(reloaded, staging)
        if errs2:
            _shutil.rmtree(staging, ignore_errors=True)
            return {"ok": False, "error": "; ".join(errs2)}
        if reloaded != doc:                       # SD-29 lossy-emit guard
            _shutil.rmtree(staging, ignore_errors=True)
            return {"ok": False, "error":
                    "re-parse mismatch: the written document would not read back "
                    "identically -- write refused"}
    except (OSError, _pl.PipelineError) as exc:
        _shutil.rmtree(staging, ignore_errors=True)
        return {"ok": False, "error": "could not stage the pipeline: %s" % exc}
    # install staging over the LIVE shadow reader-safely: briefs first (atomic
    # per file), then pipeline.json LAST via an atomic replace -- a concurrent
    # reader (dispatch/poll) never sees the shadow without a complete
    # pipeline.json, so there is no transient fallback-to-committed window (#3).
    # A copytree snapshot backs a wholesale restore if an install write fails (#4).
    backup = shadow + ".bak"
    _shutil.rmtree(backup, ignore_errors=True)
    had_shadow = os.path.isdir(shadow)
    keep = set(os.listdir(staging))
    consumed = False
    try:
        if not had_shadow:
            # first save: ATOMIC dir install -- the shadow appears complete or
            # not at all, so a reader keyed on the dir (effective_pipeline_dir)
            # never sees a partial shadow mid-install (Codex CP2).
            os.rename(staging, shadow)
            consumed = True
        else:
            _shutil.copytree(shadow, backup)      # rollback snapshot
            for entry in sorted(keep):            # briefs first, pipeline.json LAST
                if entry == "pipeline.json":
                    continue
                tmp = os.path.join(shadow, entry + ".tmp")
                _shutil.copyfile(os.path.join(staging, entry), tmp)
                os.replace(tmp, os.path.join(shadow, entry))
            tmp = os.path.join(shadow, "pipeline.json.tmp")
            _shutil.copyfile(os.path.join(staging, "pipeline.json"), tmp)
            os.replace(tmp, os.path.join(shadow, "pipeline.json"))   # PUBLISH (atomic)
    except OSError as exc:
        try:                                      # wholesale restore
            if had_shadow:
                _shutil.rmtree(shadow, ignore_errors=True)
                if os.path.isdir(backup):
                    os.rename(backup, shadow)
        except OSError:
            pass
        _shutil.rmtree(staging, ignore_errors=True)
        return {"ok": False, "error": "could not install the pipeline: %s" % exc}
    # prune stale files best-effort (only meaningful on an OVER-write -- a fresh
    # rename install already holds exactly the staged set). The save already
    # SUCCEEDED at the atomic publish; a leftover file is inert and must not
    # trigger a rollback of a good save.
    if had_shadow:
        try:
            for entry in os.listdir(shadow):
                if entry not in keep and not entry.endswith(".tmp"):
                    p = os.path.join(shadow, entry)
                    if os.path.isdir(p) and not os.path.islink(p):
                        _shutil.rmtree(p, ignore_errors=True)
                    else:
                        os.remove(p)
        except OSError:
            pass
    if not consumed:
        _shutil.rmtree(staging, ignore_errors=True)
    _shutil.rmtree(backup, ignore_errors=True)
    return {"ok": True, "path": os.path.relpath(shadow, repo),
            "message": "saved to the live pipeline shadow -- applies next run "
                       "(the committed pack is untouched)"}
