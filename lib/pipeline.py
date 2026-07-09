#!/usr/bin/env python3
"""Pipeline documents -- P1 of the agentic sequencer (#345).

A pipeline document is JSON (settled decision 2: stdlib only):
  {name, version, trigger_default?, caps{max_sessions_per_run},
   nodes[{id, type, brief_ref | legacy_prompt, runs_as?, context?}],
   edges[], containers[{id, kind: loop|stage, children[], ...}]}

P1 executes nodes in ARRAY ORDER (edges must be []; the typed dependency
walk is P2). The validator REFUSES anything the P1 runner cannot honor --
fail-safe, never accept-and-ignore (prevention-log #3): non-empty edges,
branch/for_each containers, context: own, activity types whose spec sheet
promises engine machinery P1 lacks, and unknown keys.

CLI (roles.py conventions; rc 0 ok / 1 invalid / 2 unreadable):
  pipeline.py validate <repo> <name>
  pipeline.py wrap <repo> <role>
  pipeline.py start <repo> <role> <state-file> [--lane <lane>]
  pipeline.py next <state-file> --brief-out <path> [--journal <path>]
  pipeline.py record <state-file> <node> <outcome> \
      [--session-log <p>] [--verdict <p>] [--journal <p>]
  pipeline.py ledger <journal-file> <role> [--pipeline <name>]
"""
import json
import os
import re
import sys
import time

_NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
_AGENT_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
VALID_EFFORTS = ("low", "medium", "high", "xhigh", "max")
VALID_CONTEXTS = ("project",)          # "own" is P2+ (dishonest to accept unconsumed)
# P1 accepts only the PURELY-INSTRUCTED activity verbs -- types whose spec
# sheet promises engine machinery P1 does not have (wait_watch: enforced
# polling; ask_human: SD-32 park/resume; handoff: enforced wiring;
# run_command: allowlist gate) are REJECTED like branch containers, not
# silently run as weaker plain sessions (the honesty invariant).
# SPEC_SHEETS -- the activity-catalog SSOT (v5 spec section 4; P3a #357).
# One entry per activity type + container kind: what the property pane
# renders (required first, optionals collapsed, guarded locked) and what
# the palette offers. NODE_TYPES / DEFERRED_NODE_TYPES are DERIVED from it
# below, so the canvas and the validator cannot drift. `deferred` entries
# carry the validator's exact refusal reason in `deferred_reason`.
SPEC_SHEETS = {
    "pick": {
        "label": "pick", "group": "source", "icon": "\U0001f3af",
        "required": [["source", "board query / PR set / file glob / git range"]],
        "optional": [["order", "priority / age"], ["limit", "max items"],
                     ["plan_source", "where an attached plan lives"]],
        "emits": "the picked item downstream activities reference",
        "deferred": False, "guarded": []},
    "agent_task": {
        "label": "agent task", "group": "work", "icon": "\U0001f528",
        "required": [["brief_ref", "prompt brief (sibling file) or library step"],
                     ["runs_as", "agent + model"]],
        "optional": [["effort", "reasoning effort"], ["allowed_tools", ""],
                     ["max_turns", ""], ["budget_usd", ""],
                     ["permission_mode", "beyond acceptEdits = frictioned"]],
        "emits": "session outcome (success/error)",
        "deferred": False, "guarded": ["budget ceilings"]},
    "plan": {
        "label": "plan", "group": "work", "icon": "\U0001f9e0",
        "required": [["runs_as", "agent + model"]],
        "optional": [["plan_template", ""], ["vagueness_rules", ""]],
        "emits": "verdict viable / too-vague (branch source)",
        "deferred": False, "guarded": []},
    "gather": {
        "label": "gather / research", "group": "work", "icon": "\U0001f50e",
        "required": [["collect", "what to collect"]],
        "optional": [["web_search", "on/off"], ["sources", ""]],
        "emits": "collected context for downstream briefs",
        "deferred": False, "guarded": []},
    "check": {
        "label": "check", "group": "verify", "icon": "✔️",
        "required": [["verify", "suite / review lens / browser / custom"]],
        "optional": [["pass_criteria", ""]],
        "emits": "success/failure -- the natural branch source",
        "deferred": False, "guarded": []},
    "subagent_review": {
        "label": "subagent review", "group": "verify", "icon": "\U0001f9d0",
        "required": [["lens", "code / security / UX"]],
        "optional": [["model_override", ""]],
        "emits": "review verdict",
        "deferred": False, "guarded": []},
    "triage": {
        "label": "triage", "group": "verify", "icon": "\U0001f3f7",
        "required": [["set", "the item set"], ["vocabulary", "labels"]],
        "optional": [["sibling_references", ""]],
        "emits": "labelled set",
        "deferred": False, "guarded": []},
    "summarize": {
        "label": "summarize", "group": "communicate", "icon": "\U0001f4dd",
        "required": [["destination", "issue/PR comment, new ticket, needs-you"]],
        "optional": [["template", ""]],
        "emits": "digest at the destination",
        "deferred": False, "guarded": []},
    "notify": {
        "label": "notify", "group": "communicate", "icon": "\U0001f4e3",
        "required": [["destination", "issue/PR comment, new ticket, needs-you"]],
        "optional": [["template", ""]],
        "emits": "notification at the destination",
        "deferred": False, "guarded": []},
    "ask_human": {
        "label": "ask human", "group": "communicate", "icon": "\U0001f64b",
        "required": [["question", "SD-32 escalation schema"]],
        "optional": [["answer_chips", ""], ["default_if_ignored", ""]],
        "emits": "the answer (parks; resume is an event)",
        "deferred": True, "deferred_reason": "P5 (SD-32 park/resume machinery)",
        "guarded": []},
    "handoff": {
        "label": "handoff", "group": "communicate", "icon": "\U0001f91d",
        "required": [["target", "assignment / stage"]],
        "optional": [["payload_note", ""]],
        "emits": "enforced wiring to the target",
        "deferred": True, "deferred_reason": "P2 (enforced wiring)",
        "guarded": []},
    "transform": {
        "label": "transform", "group": "work", "icon": "\U0001f6e0",
        "required": [["file_set", ""], ["instruction", ""]],
        "optional": [["per_file", "per-file vs whole-set"]],
        "emits": "transformed file set",
        "deferred": False, "guarded": []},
    "journal": {
        "label": "journal", "group": "ops", "icon": "\U0001f4d3",
        "required": [["record", "what to record"]],
        "optional": [],
        "emits": "run record",
        "deferred": False, "guarded": []},
    "housekeep": {
        "label": "housekeep", "group": "ops", "icon": "\U0001f9f9",
        "required": [["clean", "what to clean"]],
        "optional": [],
        "emits": "cleaned state",
        "deferred": False, "guarded": []},
    "git_ops": {
        "label": "git ops", "group": "ops", "icon": "\U0001f33f",
        "required": [["op", "branch / commit / push / PR / merge-via-gate"]],
        "optional": [],
        "emits": "git state change",
        "deferred": False, "guarded": ["merge always via safe_merge"]},
    "wait_watch": {
        "label": "wait / watch", "group": "ops", "icon": "⏳",
        "required": [["condition", "CI state / PR state / file / duration"]],
        "optional": [["timeout", "timeout -> failure edge"]],
        "emits": "condition met, or timeout failure",
        "deferred": True, "deferred_reason": "P5 (enforced engine polling)",
        "guarded": []},
    "run_command": {
        "label": "run command", "group": "ops", "icon": "＞_",
        "required": [["command", ""]],
        "optional": [["cwd", ""], ["timeout", ""]],
        "emits": "command outcome",
        "deferred": True, "deferred_reason": "P5 (allowlist gate)",
        "guarded": ["allowlist"]},
    "loop": {
        "label": "loop container", "group": "structure", "icon": "⟲",
        "required": [["exit_when", "verdict condition"],
                     ["max_rounds", "1..99"], ["children", ""]],
        "optional": [["runs_as", ""], ["join", "all | any"]],
        "emits": "container outcome (exit=success, cap=failure+capped)",
        "deferred": False, "guarded": ["caps"]},
    "stage": {
        "label": "stage container", "group": "structure", "icon": "\U0001f464",
        "required": [["children", ""]],
        "optional": [["runs_as", "shared runs-as for children"],
                     ["join", "all | any"]],
        "emits": "container outcome (last child success)",
        "deferred": False, "guarded": []},
    "branch": {
        "label": "branch", "group": "structure", "icon": "⚖️",
        "required": [["on", "verdict-labelled paths"]],
        "optional": [],
        "emits": "labelled path selection",
        "deferred": True, "deferred_reason": "P2c+ (verdict channel covers "
        "two-way today; branch containers later)", "guarded": []},
    "for_each": {
        "label": "for each", "group": "structure", "icon": "∀",
        "required": [["over", "item set (e.g. file glob)"]],
        "optional": [["max_parallel", ""]],
        "emits": "one child run per item",
        "deferred": True, "deferred_reason": "P5 (bounded fan-out per item)",
        "guarded": ["caps"]},
}
NODE_TYPES = frozenset(
    k for k, v in SPEC_SHEETS.items()
    if v["group"] != "structure" and not v["deferred"])
DEFERRED_NODE_TYPES = dict(
    (k, v["deferred_reason"]) for k, v in SPEC_SHEETS.items()
    if v["group"] != "structure" and v["deferred"])
_NODE_KEYS = frozenset(("id", "type", "brief_ref", "legacy_prompt",
                        "runs_as", "context", "join"))
_CONTAINER_KEYS = frozenset(("id", "kind", "children", "exit_when",
                             "max_rounds", "runs_as", "join"))
_EDGE_KEYS = frozenset(("from", "to", "on", "back", "max_bounces"))
EDGE_KINDS = ("success", "failure", "completion")
JOIN_KINDS = ("all", "any")
MAX_BOUNCES_CEIL = 9
_DOC_KEYS = frozenset(("name", "version", "trigger_default", "caps",
                       "nodes", "edges", "containers", "wrapped_from_role",
                       "params", "outputs"))
CONTAINER_KINDS = frozenset(("loop", "stage"))   # branch=P2, for_each=P5
MAX_ROUNDS_CEIL = 99
MAX_SESSIONS_CEIL = 500
MAX_PARALLEL_CEIL = 8
# --- Typed params/outputs (pipeline+trigger model Phase A, spec S3). The
#     declarations are validated here; VALUES are supplied by an invoker
#     (a trigger or a calling pipeline -- Phase B/C) via resolve_params. ---
PARAM_TYPES = ("string", "number", "bool", "enum",
               "repo", "agent", "model", "account", "secret")
_PARAM_KEYS = frozenset(("name", "type", "required", "default", "choices"))
_OUTPUT_KEYS = frozenset(("name", "type"))
_REF_RE = re.compile(r"\$\{([^}]*)\}")            # ${ ... } (the param language)


def _typed_ok(typ, val, choices=None):
    """Does `val` satisfy declared type `typ`? Used to type-check a declared
    DEFAULT at validate time (Codex CP1: catch {number, default:'abc'} early,
    not later in resolve_params). number/bool accept their JSON form or a
    coercible string; enum must be a choice; string-family accept any string."""
    if typ == "number":
        return (isinstance(val, (int, float)) and not isinstance(val, bool)) or \
               (isinstance(val, str) and re.match(r"^-?\d+(\.\d+)?$", val) is not None)
    if typ == "bool":
        return isinstance(val, bool) or \
               (isinstance(val, str) and val.lower() in ("true", "false"))
    if typ == "enum":
        return val in (choices or [])
    return isinstance(val, str)            # string/repo/agent/model/account/secret


class PipelineError(Exception):
    """Unreadable/invalid pipeline state -- callers REFUSE, never fall back."""


def load_doc(path):
    try:
        with open(path) as fh:
            doc = json.load(fh)
    except OSError as exc:
        raise PipelineError("unreadable pipeline document %s: %s" % (path, exc))
    except ValueError as exc:
        raise PipelineError("invalid JSON in %s: %s" % (path, exc))
    return doc


def _is_str(v):
    return isinstance(v, str) and v.strip() != ""


def _valid_brief_ref(ref):
    """Sibling-file basename only: no traversal, no subdirs (prevention-log #6)."""
    if not _is_str(ref):
        return False
    return ("/" not in ref and "\\" not in ref and ref not in (".", "..")
            and not ref.startswith("."))


def _valid_legacy_prompt(path):
    """Repo-relative, never absolute, never escaping (mirrors the supervisor's
    valid_prompt_path so a bound doc can't smuggle a path the runner would
    refuse only after a run state exists)."""
    if not _is_str(path) or os.path.isabs(path):
        return False
    parts = path.replace("\\", "/").split("/")
    return ".." not in parts and "" not in parts


def _top_units(doc):
    """Ordered top-level unit ids: nodes not inside any container, with each
    container appearing at the position of its FIRST child. The graph's
    vertices (edges may only reference these)."""
    child_to_con = {}
    for con in doc.get("containers") or []:
        if isinstance(con, dict):
            for c in (con.get("children") or []):
                if isinstance(c, str):     # garbage child = not a mapping key
                    child_to_con[c] = con.get("id")
    out, seen_con = [], set()
    for node in doc.get("nodes") or []:
        if not isinstance(node, dict):
            continue
        nid = node.get("id")
        if not isinstance(nid, str):       # unhashable/garbage id: the
            continue                       # validator names it; skip here
        con = child_to_con.get(nid)
        if con is None:
            out.append(nid)
        elif con not in seen_con:
            seen_con.add(con)
            out.append(con)
    return out


def valid_pipeline_name(name):
    """The ONE charset gate for `roles.<r>.pipeline` bindings -- shared by
    resolve_pipeline (dispatch, raises) and the dashboard viewer (display,
    degrades), so what dispatch refuses can never render healthy (CP2)."""
    return bool(_is_str(name) and _NAME_RE.match(name))


def effective_pipeline_dir(repo, name):
    """The SINGLE choke point for var-live pipeline resolution -- SD-34's model
    (config_parser.effective_config_path) applied to pipeline DOCUMENTS. Return
    the live shadow <repo>/var/autonomy/pipelines/<name> when it holds a
    pipeline.json, else the committed <repo>/.autonomy/pipelines/<name>. The
    dashboard's pipeline_save writer owns the shadow; the committed dir stays
    the shareable default that SEEDS it on first save. Consulted by BOTH
    resolve_pipeline (dispatch, raises on an invalid doc) and
    build_pipeline_view (display, degrades) so the two never disagree.

    Pure fs check -- never raises. PRECONDITION: `name` is charset-valid
    (valid_pipeline_name); both callers gate first, so no '/'/'..' reaches the
    join. A present-but-INVALID shadow is NOT a fallback case: the file exists,
    so this returns the shadow and the caller's load_doc/validate_doc refuses it
    (fail-safe, prevention-log #3) -- never a silent widen to committed."""
    committed = os.path.join(repo, ".autonomy", "pipelines", name)
    try:
        shadow = os.path.join(repo, "var", "autonomy", "pipelines", name)
        # Key on the shadow DIRECTORY, not just pipeline.json (Codex CP2): an
        # incomplete shadow (dir present, pipeline.json missing/invalid) is a
        # present-but-invalid shadow that must REFUSE (load_doc/validate_doc
        # raise at the call site), never a silent fallback to committed
        # (fail-safe, prevention-log #3). A SYMLINKED shadow is not a sanctioned
        # shadow -- ignore it so the resolver can never be redirected out of
        # var/ (the writer separately refuses to write through one).
        if os.path.isdir(shadow) and not os.path.islink(shadow):
            return shadow
    except (OSError, TypeError):
        pass
    return committed


def effective_edges(doc):
    """Declared edges, or -- when the document declares none (P1 docs,
    wrapped roles) -- the implicit success-chain over top-level units.
    Pure; the walker (start_run) and the canvas viewer share this so the
    graph they act on / display is one and the same."""
    if doc.get("edges"):
        return doc["edges"]
    order = _top_units(doc)
    return [{"from": a, "to": b, "on": "success"}
            for a, b in zip(order, order[1:])]


def _validate_runs_as(where, runs_as, errors):
    if runs_as is None:
        return
    if not isinstance(runs_as, dict):
        errors.append("%s: runs_as must be a mapping" % where)
        return
    for key in runs_as:
        if key not in ("model", "effort", "account", "agent"):
            errors.append("%s: runs_as.%s is not a known field" % (where, key))
    if "model" in runs_as and not _is_str(runs_as["model"]):
        errors.append("%s: runs_as.model must be a non-empty string" % where)
    if "account" in runs_as and not (_is_str(runs_as["account"])
                                     and _NAME_RE.match(runs_as["account"])):
        errors.append("%s: runs_as.account must be an account name "
                      "(charset [A-Za-z0-9._-]{1,64})" % where)
    if "effort" in runs_as and runs_as["effort"] not in VALID_EFFORTS:
        errors.append("%s: runs_as.effort %r invalid (valid: %s)"
                      % (where, runs_as.get("effort"), ", ".join(VALID_EFFORTS)))
    if "agent" in runs_as and not (_is_str(runs_as["agent"])
                                   and _AGENT_RE.match(runs_as["agent"])):
        errors.append("%s: runs_as.agent has invalid chars" % where)


def _validate_params_outputs(doc, errors):
    """params/outputs are typed declarations (spec S3). Refuse malformed -- an
    accepted-but-unconsumed decl is the fail-open the honesty invariant forbids."""
    params = doc.get("params")
    if params is not None:
        if not isinstance(params, list):
            errors.append("params: must be a list of declarations")
        else:
            seen = set()
            for i, p in enumerate(params):
                w = "params[%d]" % i
                if not isinstance(p, dict):
                    errors.append("%s: must be a mapping" % w)
                    continue
                for k in p:
                    if k not in _PARAM_KEYS:
                        errors.append("%s: unknown key %r" % (w, k))
                nm = p.get("name")
                if not (_is_str(nm) and _NAME_RE.match(nm)):
                    errors.append("%s: name required, charset [A-Za-z0-9._-]" % w)
                elif nm in seen:
                    errors.append("%s: duplicate param name %r" % (w, nm))
                else:
                    seen.add(nm)
                if p.get("type") not in PARAM_TYPES:
                    errors.append("%s: type must be one of %s"
                                  % (w, ", ".join(PARAM_TYPES)))
                typ = p.get("type")
                if typ == "enum":
                    ch = p.get("choices")
                    if not (isinstance(ch, list) and ch and all(_is_str(c) for c in ch)):
                        errors.append("%s: enum requires non-empty string choices" % w)
                    elif "default" in p and p["default"] not in ch:
                        errors.append("%s: default %r not in choices" % (w, p["default"]))
                elif "default" in p and typ in PARAM_TYPES and \
                        not _typed_ok(typ, p["default"]):
                    errors.append("%s: default %r does not match type %r"
                                  % (w, p["default"], typ))     # CP1: catch early
                if "required" in p and not isinstance(p["required"], bool):
                    errors.append("%s: required must be a bool" % w)
    outputs = doc.get("outputs")
    if outputs is not None:
        if not isinstance(outputs, list):
            errors.append("outputs: must be a list of declarations")
        else:
            for i, o in enumerate(outputs):
                w = "outputs[%d]" % i
                if not isinstance(o, dict):
                    errors.append("%s: must be a mapping" % w)
                    continue
                for k in o:
                    if k not in _OUTPUT_KEYS:
                        errors.append("%s: unknown key %r" % (w, k))
                if not (_is_str(o.get("name")) and _NAME_RE.match(o.get("name") or "")):
                    errors.append("%s: name required, charset [A-Za-z0-9._-]" % w)
                if o.get("type") not in PARAM_TYPES:
                    errors.append("%s: type must be one of %s"
                                  % (w, ", ".join(PARAM_TYPES)))


def validate_doc(doc, pipeline_dir=None):
    """Full-document validation. Returns error strings, [] = valid.
    pipeline_dir enables brief_ref existence checks (None for wrapped docs)."""
    if not isinstance(doc, dict):
        return ["pipeline document must be a JSON object"]
    errors = []
    for key in doc:
        if key not in _DOC_KEYS:
            errors.append("%r: key is not consumed in P1 -- remove it" % key)
    if not (_is_str(doc.get("name")) and _NAME_RE.match(doc["name"])):
        errors.append("name: required, charset [A-Za-z0-9._-]{1,64}")
    if not isinstance(doc.get("version"), int) or doc["version"] < 0:
        errors.append("version: required non-negative integer")
    trig = doc.get("trigger_default")
    if trig is not None:
        if not (isinstance(trig, dict)
                and trig.get("type") in ("loop", "cron", "event", "manual")):
            errors.append("trigger_default: must be {type: loop|cron|event|manual}")
    caps = doc.get("caps")
    if not isinstance(caps, dict) or not isinstance(
            caps.get("max_sessions_per_run"), int):
        errors.append("caps.max_sessions_per_run: required integer (ENFORCED cap)")
    elif not 1 <= caps["max_sessions_per_run"] <= MAX_SESSIONS_CEIL:
        errors.append("caps.max_sessions_per_run: must be 1..%d" % MAX_SESSIONS_CEIL)
    if isinstance(caps, dict) and "max_parallel" in caps:
        if not isinstance(caps["max_parallel"], int) or not (
                1 <= caps["max_parallel"] <= MAX_PARALLEL_CEIL):
            errors.append("caps.max_parallel: must be 1..%d (ENFORCED fan-out "
                          "ceiling; absent = sequential)" % MAX_PARALLEL_CEIL)
    _validate_params_outputs(doc, errors)

    nodes = doc.get("nodes")
    ids = []
    if not isinstance(nodes, list) or not nodes:
        errors.append("nodes: required non-empty list")
        nodes = []
    for i, node in enumerate(nodes):
        where = "nodes[%d]" % i
        if not isinstance(node, dict):
            errors.append("%s: must be a mapping" % where)
            continue
        for key in node:
            if key not in _NODE_KEYS:
                # Unknown keys are refused, not ignored: an accepted-and-
                # unconsumed field (a spec-real `on_fail`, `config`) would be
                # a silent no-op the operator believes is live.
                errors.append("%s: key %r is not consumed in P1 -- remove it "
                              "(or it lands with the phase that wires it)"
                              % (where, key))
        nid = node.get("id")
        if not (_is_str(nid) and _NAME_RE.match(nid)):
            errors.append("%s: id required, charset [A-Za-z0-9._-]{1,64}" % where)
        elif nid in ids:
            errors.append("%s: duplicate id %r" % (where, nid))
        else:
            ids.append(nid)
        ntype = node.get("type")
        if ntype in DEFERRED_NODE_TYPES:
            errors.append("%s: type %r needs engine machinery P1 does not "
                          "have -- lands with %s; P1 will not run it as a "
                          "weaker plain session"
                          % (where, ntype, DEFERRED_NODE_TYPES[ntype]))
        elif ntype not in NODE_TYPES:
            errors.append("%s: unknown type %r" % (where, ntype))
        has_brief = "brief_ref" in node
        has_legacy = "legacy_prompt" in node
        if has_brief == has_legacy:
            errors.append("%s: exactly one of brief_ref / legacy_prompt required"
                          % where)
        if has_brief:
            ref = node.get("brief_ref")
            if not _valid_brief_ref(ref):
                errors.append("%s: brief_ref must be a sibling filename "
                              "(no '/', no '..')" % where)
            elif pipeline_dir is not None and not os.path.isfile(
                    os.path.join(pipeline_dir, ref)):
                errors.append("%s: brief_ref %s does not exist beside "
                              "pipeline.json" % (where, ref))
        if has_legacy and not _valid_legacy_prompt(node.get("legacy_prompt")):
            errors.append("%s: legacy_prompt must be a repo-relative path "
                          "(no absolute, no '..')" % where)
        ctx = node.get("context", "project")
        if ctx not in VALID_CONTEXTS:
            errors.append("%s: context %r not supported in P1 (P1 runs every "
                          "node with project context; 'own' lands with P2+)"
                          % (where, ctx))
        if node.get("join", "all") not in JOIN_KINDS:
            errors.append("%s: join must be one of %s"
                          % (where, "|".join(JOIN_KINDS)))
        _validate_runs_as(where, node.get("runs_as"), errors)

    containers = doc.get("containers", [])
    if not isinstance(containers, list):
        errors.append("containers: must be a list")
        containers = []
    seen_children = set()
    cids = set(ids)
    for i, con in enumerate(containers):
        where = "containers[%d]" % i
        if not isinstance(con, dict):
            errors.append("%s: must be a mapping" % where)
            continue
        for key in con:
            if key not in _CONTAINER_KEYS:
                errors.append("%s: key %r is not consumed in P1 -- remove it"
                              % (where, key))
        cid = con.get("id")
        if not (_is_str(cid) and _NAME_RE.match(cid)):
            errors.append("%s: id required, charset [A-Za-z0-9._-]{1,64}" % where)
        elif cid in cids:
            errors.append("%s: duplicate id %r" % (where, cid))
        else:
            cids.add(cid)
        kind = con.get("kind")
        if kind not in CONTAINER_KINDS:
            errors.append("%s: kind %r not supported in P1 (loop/stage now; "
                          "branch is P2, for_each is P5)" % (where, kind))
        children = con.get("children")
        if not isinstance(children, list) or not children or not all(
                isinstance(c, str) and c in ids for c in children):
            errors.append("%s: children must be a non-empty list of node ids"
                          % where)
            children = []
        for c in children:
            if c in seen_children:
                errors.append("%s: node %r already belongs to another container"
                              % (where, c))
            seen_children.add(c)
        if children and ids:
            idx = [ids.index(c) for c in children if c in ids]
            if idx != list(range(min(idx), min(idx) + len(idx))):
                errors.append("%s: children must be contiguous in nodes order "
                              "and listed in that order" % where)
        if kind == "loop":
            if not _is_str(con.get("exit_when")):
                errors.append("%s: loop requires exit_when (instructed exit "
                              "condition)" % where)
            if not isinstance(con.get("max_rounds"), int) or not (
                    1 <= con["max_rounds"] <= MAX_ROUNDS_CEIL):
                errors.append("%s: loop requires max_rounds 1..%d (ENFORCED "
                              "runaway cap)" % (where, MAX_ROUNDS_CEIL))
        if kind == "stage":
            _validate_runs_as(where, con.get("runs_as"), errors)
        if con.get("join", "all") not in JOIN_KINDS:
            errors.append("%s: join must be one of %s"
                          % (where, "|".join(JOIN_KINDS)))

    # --- typed dependency edges (P2a, #349) --------------------------------
    edges = doc.get("edges")
    if not isinstance(edges, list):
        errors.append("edges: required list")
        edges = []
    con_by_id = {c.get("id"): c for c in containers if isinstance(c, dict)}
    child_ids = set()
    for c in containers:
        if isinstance(c, dict):
            # non-str entries already earned a children error above; keep
            # this set op TOTAL on garbage (unhashable dict, CP2)
            child_ids.update(x for x in (c.get("children") or [])
                             if isinstance(x, str))
    unit_order = _top_units(doc)
    units = set(unit_order)
    fwd = {}                      # non-back adjacency (cycle + ancestor checks)
    for i, e in enumerate(edges):
        where = "edges[%d]" % i
        if not isinstance(e, dict):
            errors.append("%s: must be a mapping" % where)
            continue
        for key in e:
            if key not in _EDGE_KEYS:
                errors.append("%s: key %r is not consumed in P2a -- remove it"
                              % (where, key))
        f, t = e.get("from"), e.get("to")
        for end, val in (("from", f), ("to", t)):
            if val in child_ids:
                errors.append("%s: %s %r is inside a container -- edges "
                              "connect top-level units; intra-container flow "
                              "stays array-order (P2b lifts)" % (where, end, val))
            elif val not in units:
                errors.append("%s: %s %r is not a top-level node or container "
                              "id" % (where, end, val))
        if e.get("on") not in EDGE_KINDS:
            errors.append("%s: on must be one of %s"
                          % (where, "|".join(EDGE_KINDS)))
        if e.get("back"):
            if not isinstance(e.get("max_bounces"), int) or not (
                    1 <= e["max_bounces"] <= MAX_BOUNCES_CEIL):
                errors.append("%s: a back-edge requires max_bounces 1..%d "
                              "(ENFORCED bounce cap)" % (where, MAX_BOUNCES_CEIL))
            tc = con_by_id.get(t)
            if tc is None or tc.get("kind") not in ("loop", "stage"):
                errors.append("%s: a back-edge must target a loop or stage "
                              "container" % where)
        elif "max_bounces" in e:
            errors.append("%s: max_bounces only belongs on a back-edge" % where)
        if f in units and t in units and not e.get("back"):
            fwd.setdefault(f, []).append(t)
    # Acyclicity over non-back edges (Kahn) -- back-edges are the ONE
    # sanctioned cycle mechanism (traversal-only, bounce-capped).
    indeg = dict((u, 0) for u in units)
    for f in fwd:
        for t in fwd[f]:
            indeg[t] += 1
    queue = [u for u in unit_order if indeg.get(u, 0) == 0]
    seen_n = 0
    while queue:
        u = queue.pop(0)
        seen_n += 1
        for t in fwd.get(u, ()):
            indeg[t] -= 1
            if indeg[t] == 0:
                queue.append(t)
    if seen_n < len(units):
        cyc = sorted(u for u in units if indeg.get(u, 0) > 0)
        errors.append("edges: cycle detected involving %s -- declare a "
                      "back-edge (back: true + max_bounces) or break the "
                      "cycle" % ", ".join(cyc))
    # A back-edge target must be an ANCESTOR of its from-node via forward
    # edges: a "forward" back:true edge is invisible to the cycle check and
    # would stall the walk (adversarial-review blocking fix).
    for i, e in enumerate(edges):
        if (isinstance(e, dict) and e.get("back")
                and e.get("from") in units and e.get("to") in units):
            stack, visited, found = [e["to"]], set(), False
            while stack:
                u = stack.pop()
                if u == e["from"]:
                    found = True
                    break
                if u in visited:
                    continue
                visited.add(u)
                stack.extend(fwd.get(u, ()))
            if not found:
                errors.append("edges[%d]: back-edge target %r is not an "
                              "ancestor of %r via forward edges -- a forward "
                              "back-edge would stall the walk"
                              % (i, e["to"], e["from"]))
    return errors


DEFAULT_PROMPT = ".autonomy/loop_prompt.md"

_LOOP_FOOTER = """<!-- pipeline:loop %(container)s -->
You are inside the loop "%(container)s", round %(round)d of at most %(max_rounds)d.
The round cap is enforced by the engine; the exit condition below is
instructed -- the engine cannot verify it, you must judge it.
Exit condition: %(exit_when)s
Before you finish this session, write a JSON file at
%(verdict_file)s (relative to the repo root):
  {"exit": true}   if the exit condition is satisfied
  {"exit": false}  if another round is needed
If you write nothing, the engine assumes another round is needed."""


def _node_by_id(doc, node_id):
    for node in doc.get("nodes", []):
        if node.get("id") == node_id:
            return node
    raise PipelineError("node %r not in pipeline %r"
                        % (node_id, doc.get("name")))


_VERDICT_FOOTER = """<!-- pipeline:verdict -->
Your structured verdict steers the graph: this activity has an on-failure
path. Before you finish, write a JSON file at %(verdict_file)s (relative to
the repo root):
  {"outcome": "success"}  the work is good -- the success path continues
  {"outcome": "failure"}  it must change -- the failure path runs instead
If you write nothing, your session's own outcome is the verdict."""


def compile_brief(pipeline_dir, doc, node_id, loop_ctx=None, verdict_ctx=None):
    """Compose the session brief for one node: fenced header + the node's
    brief file + (inside a loop) the round/verdict footer + (when an
    on-failure edge leaves the node) the structured-verdict footer. Fenced
    sections per the spec so future regeneration is recognisable."""
    node = _node_by_id(doc, node_id)
    ref = node.get("brief_ref")
    if not ref:
        raise PipelineError("node %r has no brief_ref (legacy nodes pass "
                            "their prompt path through, not the compiler)"
                            % node_id)
    try:
        with open(os.path.join(pipeline_dir, ref)) as fh:
            body = fh.read().rstrip()
    except OSError as exc:
        raise PipelineError("brief %s unreadable: %s" % (ref, exc))
    parts = ["<!-- pipeline:node %s (%s) -->" % (node_id, node.get("type")),
             body]
    if loop_ctx:
        parts.append(_LOOP_FOOTER % loop_ctx)
    if verdict_ctx:
        parts.append(_VERDICT_FOOTER % verdict_ctx)
    return "\n\n".join(parts) + "\n"


def wrap_role(settings, role):
    """A legacy role as a one-node pipeline (single dispatch path, operator
    kickoff decision). Byte-equivalence contract: the wrapped node's
    legacy_prompt is EXACTLY the prompt path run_session used before
    pipelines existed, and invalid runs_as values DEGRADE (dropped, like
    resolve_role_dispatch's blank-and-WARN) instead of refusing -- a config
    that ran yesterday must keep running after the upgrade. Bound
    (non-wrapped) pipelines are a NEW surface and stay strict from birth."""
    runs_as = {}
    if _is_str(settings.get("model")):
        runs_as["model"] = settings["model"]      # bash re-validates + blanks
    if settings.get("effort") in VALID_EFFORTS:
        runs_as["effort"] = settings["effort"]
    if _is_str(settings.get("account")) and _NAME_RE.match(settings["account"]):
        runs_as["account"] = settings["account"]
    if _is_str(settings.get("agent")) and _AGENT_RE.match(settings["agent"]):
        runs_as["agent"] = settings["agent"]
    node = {"id": "act", "type": "agent_task",
            "legacy_prompt": settings.get("prompt") or DEFAULT_PROMPT,
            "context": "project"}
    if runs_as:
        node["runs_as"] = runs_as
    return {"name": "legacy-%s" % role, "version": 0,
            "caps": {"max_sessions_per_run": 1},
            "nodes": [node], "edges": [], "containers": [],
            "wrapped_from_role": role}


def _check_legacy_prompts(repo, doc, what):
    """Early refuse (at run start, not mid-run) when a node's legacy_prompt
    does not exist in the repo -- a run state written for an unrunnable doc
    would strand in-flight."""
    for node in doc.get("nodes", []):
        lp = node.get("legacy_prompt")
        if lp and not os.path.isfile(os.path.join(repo, lp)):
            raise PipelineError("%s node %r legacy_prompt %s missing in repo"
                                % (what, node.get("id"), lp))


def resolve_pipeline(repo, role):
    """The ONE dispatch resolution: bound pipeline when the role names one,
    else the legacy wrap. A bound-but-missing/invalid pipeline RAISES --
    fail-safe, never a silent fallback that would change behaviour
    (prevention-log #3)."""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import roles
    cfg, rc = roles._load_config(repo)
    if rc != 0 or cfg is None:
        raise PipelineError("config unreadable/unparseable for %s (rc %d)"
                            % (repo, rc))
    try:
        settings = roles.role_settings(cfg, role)
    except KeyError:
        raise PipelineError("role %r is not dispatchable" % role)
    binding = (settings.get("pipeline") or "").strip()
    if not binding:
        doc = wrap_role(settings, role)
        errs = validate_doc(doc, None)
        if errs:
            raise PipelineError("wrapped role %r invalid: %s"
                                % (role, "; ".join(errs)))
        _check_legacy_prompts(repo, doc, "wrapped role %r" % role)
        return doc, {"pipeline_dir": None, "wrapped": True,
                     "from": doc["name"], "from_version": 0}
    if not valid_pipeline_name(binding):
        raise PipelineError("roles.%s.pipeline %r has invalid charset"
                            % (role, binding))
    # Read the var-live shadow when the operator has edited this pipeline in the
    # canvas (SD-34); a present-but-invalid shadow RAISES below, never a silent
    # fallback to the committed default (prevention-log #3). binding is
    # charset-gated just above, so the resolver's precondition holds.
    pdir = effective_pipeline_dir(repo, binding)
    doc = load_doc(os.path.join(pdir, "pipeline.json"))
    errs = validate_doc(doc, pdir)
    if errs:
        raise PipelineError("pipeline %r invalid: %s"
                            % (binding, "; ".join(errs)))
    _check_legacy_prompts(repo, doc, "pipeline %r" % binding)
    # P2b (#351): the P1/P2a multi-node cron/event refusal is LIFTED -- an
    # in-flight run joins the main loop's dispatch list regardless of its
    # trigger type, so a cron/event fire only STARTS the run and the loop
    # advances it with its own limit/backoff/pause handling.
    return doc, {"pipeline_dir": pdir, "wrapped": False,
                 "from": binding, "from_version": doc.get("version", 0)}


def _split_opts(args, opts):
    """Split `--flag value` pairs (keys pre-seeded in opts) from positionals."""
    pos, i = [], 0
    while i < len(args):
        if args[i] in opts and i + 1 < len(args):
            opts[args[i]] = args[i + 1]
            i += 2
        else:
            pos.append(args[i])
            i += 1
    return pos


def _atomic_write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(obj, fh, sort_keys=True)
    os.replace(tmp, path)


def _load_state(state_path):
    try:
        with open(state_path) as fh:
            state = json.load(fh)
    except OSError as exc:
        raise PipelineError("run state unreadable %s: %s" % (state_path, exc))
    except ValueError as exc:
        # Corrupt state is REFUSED loudly, never deleted: silently discarding
        # it would lose the run's journal record (fail-open). The log names
        # the path; the operator (or a later doctor slice) removes it.
        raise PipelineError("run state corrupt %s: %s -- refusing; inspect "
                            "and remove the file to recover" % (state_path, exc))
    if not isinstance(state, dict) or not isinstance(state.get("doc"), dict):
        raise PipelineError("run state corrupt %s: unexpected shape -- "
                            "refusing" % state_path)
    if state.get("status") == "in_progress" and state.get("fmt") != 2:
        raise PipelineError("run state %s predates the graph walk (P2a, fmt "
                            "2) -- remove the file to recover" % state_path)
    return state


def start_run(repo, role, state_path, lane=""):
    doc, meta = resolve_pipeline(repo, role)
    doc = dict(doc)
    # Implicit chain synthesis: P1 docs and wrapped roles become the
    # equivalent success-chain graph -- ONE walk engine, stored into the
    # state's embedded doc so a resumed run is stable.
    doc["edges"] = effective_edges(doc)
    # run_id: role[--lane]-timestamp-pid -- pid disambiguates same-second
    # starts across lanes/tests (second-granularity ids collide, weakening
    # the trust-ledger identity field).
    ident = "%s--%s" % (role, lane) if lane else role
    state = {"fmt": 2,
             "run_id": "%s-%s-%d" % (ident, time.strftime("%Y%m%dT%H%M%S"),
                                     os.getpid()),
             "role": role, "lane": lane, "doc": doc, "meta": meta,
             "started": int(time.time()), "sessions": 0,
             "units": dict((u, {"status": "pending"}) for u in _top_units(doc)),
             "container_pos": {}, "rounds": {}, "bounces": {},
             "nodes_done": [], "status": "in_progress"}
    _atomic_write_json(state_path, state)
    return state


def _container_of(doc, node_id):
    for con in doc.get("containers", []):
        if node_id in (con.get("children") or []):
            return con
    return None


def _con_by_id(doc, uid):
    for con in doc.get("containers", []):
        if con.get("id") == uid:
            return con
    return None


# --- the graph walk (P2a, #349) ----------------------------------------------
def _unit_join(doc, uid):
    con = _con_by_id(doc, uid)
    if con is not None:
        return con.get("join", "all")
    for node in doc.get("nodes", []):
        if node.get("id") == uid:
            return node.get("join", "all")
    return "all"


def _incoming_edges(doc, uid):
    """Non-back incoming edges only: back-edges are TRAVERSAL-ONLY and never
    gate readiness (else the target waits forever on its own downstream
    verdict -- deadlock, then a never-run graph completes as success:
    fail-open; adversarial-review blocking fix)."""
    return [e for e in doc.get("edges", [])
            if e.get("to") == uid and not e.get("back")]


def _edge_state(state, edge):
    """open (from not terminal yet) | satisfied | dead. A SKIPPED from
    deadens every outgoing edge -- completion means "ran either way";
    skipped never ran. A DISPATCHED from is still running: open."""
    fs = state["units"][edge["from"]]["status"]
    if fs in ("pending", "dispatched"):
        return "open"
    if fs == "skipped":
        return "dead"
    on = edge["on"]
    if on == "completion":
        return "satisfied"
    want = "success" if on == "success" else "failure"
    return "satisfied" if fs == want else "dead"


def _unit_ready(doc, state, uid):
    if state["units"][uid]["status"] != "pending":
        return False
    inc = _incoming_edges(doc, uid)
    if not inc:
        return True                                   # root
    states = [_edge_state(state, e) for e in inc]
    if _unit_join(doc, uid) == "any":
        return "open" not in states and "satisfied" in states
    return all(s == "satisfied" for s in states)


def _unit_dead(doc, state, uid):
    inc = _incoming_edges(doc, uid)
    if not inc:
        return False
    states = [_edge_state(state, e) for e in inc]
    if _unit_join(doc, uid) == "any":
        return all(s == "dead" for s in states)
    return "dead" in states


def _propagate_skips(doc, state):
    changed = True
    while changed:
        changed = False
        for uid in _top_units(doc):
            if (state["units"][uid]["status"] == "pending"
                    and _unit_dead(doc, state, uid)):
                state["units"][uid]["status"] = "skipped"
                changed = True


def _pick_candidates(doc, state):
    """Doc-order units eligible for dispatch: DISPATCHED units first-class
    (crash/limit reclaim -- duplicate work beats a stranded run; within one
    healthy dispatch cycle the supervisor records before asking again),
    then ready pending units."""
    out = []
    for uid in _top_units(doc):
        if (state["units"][uid]["status"] == "dispatched"
                or _unit_ready(doc, state, uid)):
            out.append(uid)
    return out


def _any_dispatched(doc, state):
    return any(state["units"][u]["status"] == "dispatched"
               for u in _top_units(doc))


def _expected_node(doc, state, uid):
    """The node id a session actually runs for this unit: the unit itself,
    or the container's current internal child (array-order, P1 machinery)."""
    con = _con_by_id(doc, uid)
    if con is None:
        return uid
    pos = int(state.get("container_pos", {}).get(uid, 0))
    return con["children"][pos]


def _reset_for_bounce(doc, state, target):
    """Re-pend the back-edge target container (fresh internal state -- each
    entry earns max_rounds again) and everything transitively downstream of
    it via non-back edges. UNIT statuses only: nodes_done is append-only
    session history and bounce counters + sessions survive."""
    fwd = {}
    for e in doc.get("edges", []):
        if not e.get("back"):
            fwd.setdefault(e["from"], []).append(e["to"])
    stack, reached = [target], set()
    while stack:
        u = stack.pop()
        if u in reached:
            continue
        reached.add(u)
        stack.extend(fwd.get(u, ()))
    for u in reached:
        state["units"][u] = {"status": "pending"}
        state["container_pos"].pop(u, None)
        state["rounds"].pop(u, None)


def _traverse_back_edges(doc, state, uid):
    """Fire at most one satisfied back-edge from the just-terminal unit.
    Cap exhausted = the edge does NOT fire and the source's terminal state
    stands -- an unhandled failure then fails the run (S29: parks for a
    human via the journal outcome)."""
    status = state["units"][uid]["status"]
    if status not in ("success", "failure"):
        return
    for e in doc.get("edges", []):
        if e.get("from") != uid or not e.get("back"):
            continue
        on = e.get("on")
        fires = (on == "completion"
                 or (on == "success" and status == "success")
                 or (on == "failure" and status == "failure"))
        if not fires:
            continue
        key = "%s->%s" % (uid, e["to"])
        n = int((state.get("bounces") or {}).get(key, 0))
        if n >= int(e.get("max_bounces", 0)):
            continue                      # ENFORCED cap: bounce denied
        state.setdefault("bounces", {})[key] = n + 1
        _reset_for_bounce(doc, state, e["to"])
        return


def _walk_outcome(doc, state):
    """Rules 6/6b/8: failure handled iff a satisfied outgoing
    failure/completion edge's target actually RAN (skipped targets do not
    count -- edge presence is not traversal)."""
    outcome, capped = "success", False
    for uid in _top_units(doc):
        u = state["units"][uid]
        if u["status"] != "failure":
            continue
        handled = False
        for e in doc.get("edges", []):
            if (e.get("from") == uid and not e.get("back")
                    and e.get("on") in ("failure", "completion")
                    and _edge_state(state, e) == "satisfied"
                    and state["units"][e["to"]]["status"] in
                    ("success", "failure")):
                handled = True
                break
        if not handled:
            outcome = "failure"
            if u.get("capped"):
                capped = True
    return "capped" if capped else outcome


def _effective_runs_as(doc, node):
    con = _container_of(doc, node["id"])
    merged = {}
    if con is not None and con.get("kind") == "stage":
        merged.update(con.get("runs_as") or {})
    merged.update(node.get("runs_as") or {})
    return merged


def _verdict_rel(state_path, node_id):
    """The PER-NODE verdict file's repo-relative path for the compiled
    brief: LOGDIR is always <repo>/var/autonomy-logs (in an ephemeral
    worktree, the worktree's own var/), and the supervisor derives the same
    name from the state base + node -- one naming rule on both sides,
    lane-safe, collision-free under parallel dispatch (P2b: a shared
    per-role file would collide the moment two nodes run at once)."""
    base = os.path.basename(state_path)
    if base.endswith(".json"):
        base = base[:-len(".json")]
    return "var/autonomy-logs/%s.%s.verdict.json" % (base, node_id)


def _loop_ctx(state, node, state_path):
    con = _container_of(state["doc"], node["id"])
    if con is None or con.get("kind") != "loop":
        return None
    return {"container": con["id"],
            "round": int(state["rounds"].get(con["id"], 1)),
            "max_rounds": con["max_rounds"],
            "exit_when": con["exit_when"],
            "verdict_file": _verdict_rel(state_path, node["id"])}


def _read_verdict_full(verdict_path):
    """Total (prevention-log #12): any unreadable/odd shape = {}. The file
    may carry {"exit": bool} (loop exit, P1) and/or
    {"outcome": "success"|"failure"} (the branch mechanism, P2a)."""
    if not verdict_path:
        return {}
    try:
        with open(verdict_path) as fh:
            verdict = json.load(fh)
    except (OSError, ValueError):
        return {}
    return verdict if isinstance(verdict, dict) else {}


def _read_verdict(verdict_path):
    """Loop-exit view: missing evidence never exits a loop early -- that
    would declare the exit condition met without evidence (fail-open). The
    max_rounds cap is the floor under a persistently absent verdict."""
    return _read_verdict_full(verdict_path).get("exit") is True


def _journal_append(journal_path, state):
    """One JSON line per completed run -- the run journal the trust ledger
    projects over (v5 §10). Single write() of line+newline in append mode;
    a torn line from a rare cross-lane interleave is TOLERATED by the total
    reader (skipped), and lost evidence lands on the safe side (watch)."""
    doc = state.get("doc") or {}
    meta = state.get("meta") or {}
    nodes_done = state.get("nodes_done") or []
    rec = {
        "run_id": state.get("run_id", ""),
        "role": state.get("role", ""),
        "pipeline": doc.get("name", ""),
        "pipeline_version": meta.get("from_version", 0),
        "wrapped": bool(meta.get("wrapped")),
        "outcome": state.get("outcome", "failure"),
        "pass": state.get("outcome") == "success",
        "started": int(state.get("started") or 0),
        "finished": int(time.time()),
        "sessions": int(state.get("sessions") or 0),
        "lane": state.get("lane", ""),
        "bounces": state.get("bounces") or {},
        "nodes": nodes_done,
        "merge_affecting": any(n.get("type") == "git_ops" for n in nodes_done
                               if isinstance(n, dict)),
    }
    line = json.dumps(rec, sort_keys=True) + "\n"
    with open(journal_path, "a") as fh:
        fh.write(line)


TRUST_MIN_RUNS = 20
TRUST_PASS_RATE = 0.95


def ledger(journal_path, role, pipeline_name=""):
    """Trust-ledger projection (v5 §10): PURE read over the journal, no
    stored tier. Total reader (prevention-log #12): junk lines are skipped --
    they reduce evidence, which keeps the tier on the safe side (watch).

    Trust is earned per ASSIGNMENT, not per role name: pass pipeline_name to
    scope the history to the role's CURRENT binding, so rebinding a role
    never inherits the previous pipeline's record. The pass-rate is computed
    over the most recent TRUST_MIN_RUNS runs (a rolling window), so §10's
    'demotion on pass-rate decay' actually responds to recent decay instead
    of being diluted by a long healthy history."""
    matched = []
    try:
        fh = open(journal_path)
    except OSError:
        return {"runs": 0, "passes": 0, "tier": "watch"}
    with fh:
        for line in fh:
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if not isinstance(rec, dict) or rec.get("role") != role:
                continue
            if pipeline_name and rec.get("pipeline") != pipeline_name:
                continue
            if rec.get("outcome") not in ("success", "failure", "capped"):
                continue
            matched.append(rec.get("pass") is True)
    runs = len(matched)
    passes = sum(1 for p in matched if p)
    window = matched[-TRUST_MIN_RUNS:]
    window_passes = sum(1 for p in window if p)
    tier = ("auto" if runs >= TRUST_MIN_RUNS
            and window_passes >= len(window) * TRUST_PASS_RATE else "watch")
    return {"runs": runs, "passes": passes, "tier": tier}


def _finish(state, state_path, outcome, journal_path):
    state["status"] = "done"
    state["outcome"] = outcome
    if journal_path:
        _journal_append(journal_path, state)
    try:
        os.unlink(state_path)
    except OSError:
        # Persist the DONE marker: a swallowed unlink failure would leave an
        # in_progress state on disk -> the last node re-runs and the journal
        # gets a duplicate line. With the marker, next_node refuses loudly.
        try:
            _atomic_write_json(state_path, state)
        except OSError as exc:
            # Both cleanup paths failed: the stale in_progress state WILL
            # replay the run next tick and double-journal -- returning
            # success here would be fail-open (Codex CP2). Refuse loudly;
            # the run IS journalled, only the state file needs operator help.
            raise PipelineError(
                "run %s finished (%s, journalled) but its state file %s "
                "could neither be removed nor marked done: %s -- remove it "
                "by hand" % (state.get("run_id"), outcome, state_path, exc))
    return {"status": "done", "outcome": outcome}


def _guard_in_progress(state, state_path):
    status = state.get("status")
    if status == "done":
        # A done-state on disk means a prior _finish could not unlink -- the
        # run is already journalled; refuse loudly rather than re-finish.
        raise PipelineError("run state %s is already done (outcome %r) but "
                            "could not be removed -- delete the file to "
                            "recover" % (state_path, state.get("outcome")))
    if status != "in_progress":
        # Unknown status lands on the REFUSE side, never the success side
        # (prevention-log #18: the reassuring verdict must be earned).
        raise PipelineError("run state %s has unexpected status %r -- "
                            "refusing" % (state_path, status))


def _prepare_step(state_path, state, uid, brief_path):
    doc = state["doc"]
    node = _node_by_id(doc, _expected_node(doc, state, uid))
    verdict_rel = _verdict_rel(state_path, node["id"])
    if node.get("legacy_prompt"):
        kind, prompt = "legacy", node["legacy_prompt"]
    else:
        pdir = (state.get("meta") or {}).get("pipeline_dir")
        verdict_ctx = None
        if _con_by_id(doc, uid) is None and any(
                e.get("from") == uid and e.get("on") == "failure"
                for e in doc.get("edges", [])):
            # An on-failure path leaves this node: its structured verdict is
            # load-bearing, so the brief must say where to write it.
            verdict_ctx = {"verdict_file": verdict_rel}
        text = compile_brief(pdir, doc, node["id"],
                             _loop_ctx(state, node, state_path),
                             verdict_ctx=verdict_ctx)
        with open(brief_path, "w") as fh:
            fh.write(text)
        kind, prompt = "compiled", brief_path
    return {"status": "node", "unit": uid, "node": node["id"], "kind": kind,
            "prompt": prompt, "verdict": verdict_rel,
            "runs_as": _effective_runs_as(doc, node)}


def _pick(state_path, state, n, brief_path_for, journal_path):
    """The dispatch protocol core: returns ("done", outcome-dict) or
    ("steps", [step...]) with the chosen units MARKED dispatched (one
    atomic state write). n is clamped to the doc's max_parallel AND the
    remaining session budget (the run cap can never be overshot by a
    batch -- Codex CP1)."""
    doc = state["doc"]
    cap = doc["caps"]["max_sessions_per_run"]
    avail = cap - state["sessions"]
    if avail <= 0 and not _any_dispatched(doc, state):
        return "done", _finish(state, state_path, "capped", journal_path)
    candidates = _pick_candidates(doc, state)
    if not candidates:
        if _any_dispatched(doc, state):
            # Only reachable through a driver bug (dispatched units ARE
            # candidates) -- refuse rather than finish around a live batch.
            raise PipelineError("no candidates but a batch is outstanding "
                                "in %s -- refusing" % state_path)
        pending = [u for u in _top_units(doc)
                   if state["units"][u]["status"] == "pending"]
        if pending:
            # Impossible on a validated DAG (a minimal pending unit always
            # has all-terminal parents) -- refuse loudly, never guess
            # (prevention-log #18).
            raise PipelineError("walk stalled with pending units %s in %s -- "
                                "refusing" % (", ".join(pending), state_path))
        return "done", _finish(state, state_path, _walk_outcome(doc, state),
                               journal_path)
    n_eff = max(1, min(n, int(doc["caps"].get("max_parallel", 1)), avail))
    steps = []
    for uid in candidates[:n_eff]:
        steps.append(_prepare_step(state_path, state, uid,
                                   brief_path_for(uid)))
        state["units"][uid]["status"] = "dispatched"
    _atomic_write_json(state_path, state)
    return "steps", steps


def next_node(state_path, brief_out, journal_path=""):
    state = _load_state(state_path)
    _guard_in_progress(state, state_path)
    kind, result = _pick(state_path, state, 1, lambda _uid: brief_out,
                         journal_path)
    if kind == "done":
        return result
    return result[0]


def ready_set(state_path, brief_dir, n, journal_path=""):
    """The batch view: up to n steps (clamped), units marked dispatched.
    [] when the run just finished (the finish itself has already happened,
    exactly like next_node's done path)."""
    state = _load_state(state_path)
    _guard_in_progress(state, state_path)
    base = os.path.basename(state_path)
    if base.endswith(".json"):
        base = base[:-len(".json")]
    kind, result = _pick(
        state_path, state, n,
        lambda uid: os.path.join(brief_dir, "%s.%s.brief.md" % (base, uid)),
        journal_path)
    if kind == "done":
        return []
    return result


def record_outcome(state_path, node_id, outcome, session_log="",
                   verdict_path="", journal_path=""):
    if outcome not in ("success", "error", "retry"):
        raise PipelineError("unrecordable outcome %r (only "
                            "success/error/retry are recorded)" % outcome)
    state = _load_state(state_path)
    doc = state["doc"]
    uid = None
    for cand in _top_units(doc):
        if (state["units"][cand]["status"] == "dispatched"
                and _expected_node(doc, state, cand) == node_id):
            uid = cand
            break
    if uid is None:
        raise PipelineError("record for node %r but no dispatched unit "
                            "expects it -- refusing (corrupt driver?)"
                            % node_id)
    if outcome == "retry":
        # usage_limit path: the node was NOT completed -- release the unit
        # (no nodes_done entry, no session count); it re-runs after the
        # reset, and nothing can finish around it meanwhile.
        state["units"][uid]["status"] = "pending"
        _atomic_write_json(state_path, state)
        return "CONTINUE"
    node = _node_by_id(doc, node_id)
    con = _con_by_id(doc, uid)
    verdict = _read_verdict_full(verdict_path)
    entry = {"id": node_id, "type": node.get("type"), "outcome": outcome,
             "unit": uid,
             "via": sorted(set(e["on"] for e in _incoming_edges(doc, uid)
                               if _edge_state(state, e) == "satisfied")),
             "session_log": os.path.basename(session_log) if session_log else ""}
    bounce_total = sum(int(v) for v in (state.get("bounces") or {}).values())
    if bounce_total:
        entry["bounce"] = bounce_total
    unit = state["units"][uid]

    if con is not None and con.get("kind") == "loop":
        entry["round"] = int(state["rounds"].get(uid, 1))
        if node_id == con["children"][-1]:
            # v5 §6: the structured verdict is part of the run journal, not
            # just a control signal -- record what the exit decision saw.
            entry["verdict_exit"] = verdict.get("exit") is True
    state["nodes_done"].append(entry)
    state["sessions"] += 1

    # --- resolve the UNIT's terminal state (decisions 3 + 6b) --------------
    if con is None:
        if outcome == "error":
            # An errored session's verdict never rescues it (fail-safe).
            unit["status"] = "failure"
        else:
            dep = verdict.get("outcome")
            if dep in ("success", "failure"):
                # The branch mechanism: a healthy session's structured
                # verdict steers the labeled paths.
                unit["status"] = dep
                entry["verdict_outcome"] = dep
            else:
                unit["status"] = "success"
    else:
        pos = int(state["container_pos"].get(uid, 0))
        children = con["children"]
        if outcome == "error":
            # 6b: a child error finishes the CONTAINER as failure so its
            # failure/completion edges can fire -- never the whole run.
            unit["status"] = "failure"
        elif con.get("kind") == "loop" and pos == len(children) - 1:
            if verdict.get("exit") is True:
                unit["status"] = "success"
            else:
                rnd = int(state["rounds"].get(uid, 1))
                if rnd >= con["max_rounds"]:
                    # 6b: cap-exit = container FAILURE carrying the cap
                    # marker (success would declare the exit condition met
                    # without evidence -- fail-open).
                    unit["status"] = "failure"
                    unit["capped"] = True
                else:
                    state["rounds"][uid] = rnd + 1
                    state["container_pos"][uid] = 0
                    unit["status"] = "pending"          # next round dispatches
        elif pos == len(children) - 1:
            unit["status"] = "success"                 # stage complete
        else:
            state["container_pos"][uid] = pos + 1      # mid-container
            unit["status"] = "pending"

    if unit["status"] not in ("pending", "dispatched"):
        _traverse_back_edges(doc, state, uid)
        _propagate_skips(doc, state)

    # --- walk end / caps ----------------------------------------------------
    # While ANY unit is still dispatched, the run can neither finish nor
    # cap-finish: the batch's remaining records land first (Codex CP1).
    if not _any_dispatched(doc, state):
        if not _pick_candidates(doc, state):
            pending = [u for u in _top_units(doc)
                       if state["units"][u]["status"] == "pending"]
            if pending:
                raise PipelineError("walk stalled with pending units %s in "
                                    "%s -- refusing"
                                    % (", ".join(pending), state_path))
            res = _finish(state, state_path, _walk_outcome(doc, state),
                          journal_path)
            return "DONE %s" % res["outcome"]
        if state["sessions"] >= doc["caps"]["max_sessions_per_run"]:
            # The RUN-level cap, decided HERE (record holds the journal
            # path) -- deciding it in next_node would lose the journal line.
            res = _finish(state, state_path, "capped", journal_path)
            return "DONE %s" % res["outcome"]
    _atomic_write_json(state_path, state)
    return "CONTINUE"


def _cli_validate(argv):
    if len(argv) != 2:
        print("usage: pipeline.py validate <repo> <name>", file=sys.stderr)
        return 2
    repo, name = argv
    if not _NAME_RE.match(name or ""):
        print("invalid pipeline name %r" % name)
        return 1
    pdir = os.path.join(repo, ".autonomy", "pipelines", name)
    try:
        doc = load_doc(os.path.join(pdir, "pipeline.json"))
    except PipelineError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    errs = validate_doc(doc, pdir)
    for e in errs:
        print(e)
    return 1 if errs else 0


def _print_step(step):
    print("NODE=%s" % step["node"])
    print("KIND=%s" % step["kind"])
    print("PROMPT=%s" % step["prompt"])
    print("VERDICT=%s" % step["verdict"])
    runs_as = step.get("runs_as") or {}
    for key in ("model", "effort", "account", "agent"):
        if runs_as.get(key):
            print("NODE_%s=%s" % (key.upper(), runs_as[key]))


def main(argv):
    if not argv:
        print(__doc__, file=sys.stderr)
        return 2
    cmd, rest = argv[0], argv[1:]
    if cmd == "validate":
        return _cli_validate(rest)
    if cmd == "wrap":
        if len(rest) != 2:
            print("usage: pipeline.py wrap <repo> <role>", file=sys.stderr)
            return 2
        try:
            doc, _meta = resolve_pipeline(rest[0], rest[1])
        except PipelineError as exc:
            print("pipeline wrap: %s" % exc, file=sys.stderr)
            return 1
        print(json.dumps(doc, indent=2, sort_keys=True))
        return 0
    if cmd == "start":
        # start <repo> <role> <state-file> [--lane <lane>]
        opts = {"--lane": ""}
        pos = _split_opts(rest, opts)
        try:
            state = start_run(pos[0], pos[1], pos[2], lane=opts["--lane"])
        except (IndexError, PipelineError) as exc:
            print("pipeline start: %s" % exc, file=sys.stderr)
            return 1
        print("RUN=%s" % state["run_id"])
        return 0
    if cmd == "next":
        # next <state-file> --brief-out <path> [--journal <path>]
        opts = {"--brief-out": "", "--journal": ""}
        pos = _split_opts(rest, opts)
        try:
            step = next_node(pos[0], opts["--brief-out"],
                             journal_path=opts["--journal"])
        except (IndexError, PipelineError) as exc:
            print("pipeline next: %s" % exc, file=sys.stderr)
            return 1
        if step["status"] == "done":
            print("DONE %s" % step["outcome"])
            return 0
        _print_step(step)
        return 0
    if cmd == "ready":
        # ready <state-file> --max <n> --brief-dir <dir> [--journal <p>]
        opts = {"--max": "1", "--brief-dir": "", "--journal": ""}
        pos = _split_opts(rest, opts)
        try:
            n = int(opts["--max"])
        except ValueError:
            print("pipeline ready: --max must be an integer", file=sys.stderr)
            return 1
        try:
            steps = ready_set(pos[0], opts["--brief-dir"], n,
                              journal_path=opts["--journal"])
        except (IndexError, PipelineError) as exc:
            print("pipeline ready: %s" % exc, file=sys.stderr)
            return 1
        if not steps:
            print("DONE")
            return 0
        for step in steps:
            _print_step(step)
            print("END")
        return 0
    if cmd == "record":
        # record <state-file> <node> <outcome> [--session-log p]
        #        [--verdict p] [--journal p]
        opts = {"--session-log": "", "--verdict": "", "--journal": ""}
        pos = _split_opts(rest, opts)
        try:
            print(record_outcome(pos[0], pos[1], pos[2],
                                 session_log=opts["--session-log"],
                                 verdict_path=opts["--verdict"],
                                 journal_path=opts["--journal"]))
        except (IndexError, PipelineError) as exc:
            print("pipeline record: %s" % exc, file=sys.stderr)
            return 1
        return 0
    if cmd == "ledger":
        opts = {"--pipeline": ""}
        pos = _split_opts(rest, opts)
        if len(pos) != 2:
            print("usage: pipeline.py ledger <journal> <role> "
                  "[--pipeline <name>]", file=sys.stderr)
            return 2
        led = ledger(pos[0], pos[1], pipeline_name=opts["--pipeline"])
        print("runs=%d passes=%d tier=%s" % (led["runs"], led["passes"],
                                             led["tier"]))
        return 0
    print("unknown subcommand %r" % cmd, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
