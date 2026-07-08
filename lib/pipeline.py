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
NODE_TYPES = frozenset((
    "pick", "agent_task", "plan", "gather", "check", "subagent_review",
    "summarize", "notify", "transform", "triage", "journal", "housekeep",
    "git_ops",
))
DEFERRED_NODE_TYPES = {
    "wait_watch": "P5 (enforced engine polling)",
    "ask_human": "P5 (SD-32 park/resume machinery)",
    "handoff": "P2 (enforced wiring)",
    "run_command": "P5 (allowlist gate)",
}
_NODE_KEYS = frozenset(("id", "type", "brief_ref", "legacy_prompt",
                        "runs_as", "context"))
_CONTAINER_KEYS = frozenset(("id", "kind", "children", "exit_when",
                             "max_rounds", "runs_as"))
_DOC_KEYS = frozenset(("name", "version", "trigger_default", "caps",
                       "nodes", "edges", "containers", "wrapped_from_role"))
CONTAINER_KINDS = frozenset(("loop", "stage"))   # branch=P2, for_each=P5
MAX_ROUNDS_CEIL = 99
MAX_SESSIONS_CEIL = 500


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
        _validate_runs_as(where, node.get("runs_as"), errors)

    edges = doc.get("edges")
    if not isinstance(edges, list):
        errors.append("edges: required list (must be [] in P1)")
    elif edges:
        errors.append("edges: typed dependency edges are a P2 feature -- P1 "
                      "executes nodes in array order; edges must be []")

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
                c in ids for c in children):
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


def compile_brief(pipeline_dir, doc, node_id, loop_ctx=None):
    """Compose the session brief for one node: fenced header + the node's
    brief file + (inside a loop) the round/verdict footer. Fenced sections
    per the spec so future regeneration is recognisable."""
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
    if not _NAME_RE.match(binding):
        raise PipelineError("roles.%s.pipeline %r has invalid charset"
                            % (role, binding))
    pdir = os.path.join(repo, ".autonomy", "pipelines", binding)
    doc = load_doc(os.path.join(pdir, "pipeline.json"))
    errs = validate_doc(doc, pdir)
    if errs:
        raise PipelineError("pipeline %r invalid: %s"
                            % (binding, "; ".join(errs)))
    _check_legacy_prompts(repo, doc, "pipeline %r" % binding)
    # P1 advances one node per LOOP iteration (SD-12); a cron/event role's
    # trigger fires run_session once per due-tick, so a multi-node pipeline
    # bound to one would stall mid-run until the next fire. Refuse honestly;
    # P2's dispatch work lifts this.
    trig_names = set(n for n, _ in (roles.cron_roles(cfg) or []))
    trig_names.update(n for n, _ in (roles.event_roles(cfg) or []))
    if len(doc.get("nodes") or []) > 1 and role in trig_names:
        raise PipelineError("pipeline %r has %d nodes but role %r fires on a "
                            "cron/event trigger -- P1 advances one node per "
                            "loop iteration, so the run would stall between "
                            "fires; multi-node cron/event dispatch lands in "
                            "P2" % (binding, len(doc["nodes"]), role))
    return doc, {"pipeline_dir": pdir, "wrapped": False,
                 "from": binding, "from_version": doc.get("version", 0)}


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
    print("unknown subcommand %r" % cmd, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
