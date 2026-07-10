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
    "call_pipeline": {
        "label": "call pipeline", "group": "work", "icon": "\U0001f4de",
        "required": [["pipeline", "the pipeline to run as a CHILD run"]],
        "optional": [["params", "override the child's saved defaults "
                      "(values may use ${...})"],
                     ["wait", "true (default): wait, read outputs, child "
                      "outcome drives edges; false: detach"]],
        "emits": "child outcome (success/failure); outputs -> "
                 "${nodes.<id>.output.*} when waited",
        "deferred": False, "guarded": ["depth cap", "cycle refusal"]},
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
                        "runs_as", "context", "join",
                        "pipeline", "params", "wait", "secrets"))
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
MAX_CALL_DEPTH = 3
# Sidecar files (.pipeline-run-<x>.<node>.outputs.json / .verdict.json and
# .pipeline-run-<child>.outcome.json) share the state files' glob namespace;
# the supervisor's inflight_tokens skips these suffixes, so names that would
# END in one are refused where they are minted (node ids here, trigger names
# in triggers.py) -- a run may never take a shape the token scan skips.
_RESERVED_SIDECAR_SUFFIXES = frozenset(("outputs", "verdict", "outcome"))
# --- Typed params/outputs (pipeline+trigger model Phase A, spec S3). The
#     declarations are validated here; VALUES are supplied by an invoker
#     (a trigger or a calling pipeline -- Phase B/C) via resolve_params. ---
PARAM_TYPES = ("string", "number", "bool", "enum",
               "repo", "agent", "model", "account", "secret")
# Outputs exclude enum (an output decl has no choices channel, so an enum
# output could never be checked -- fail-open) and secret (the run-outputs
# file is plaintext on disk; a secret VALUE must never be invited into it).
OUTPUT_TYPES = tuple(t for t in PARAM_TYPES if t not in ("enum", "secret"))
_PARAM_KEYS = frozenset(("name", "type", "required", "default", "choices"))
_OUTPUT_KEYS = frozenset(("name", "type"))
_REF_RE = re.compile(r"\$\{([^}]*)\}")            # ${ ... } (the param language)
# The secret env channel (Phase C, decision 11): a node's `secrets:` map is
# {ENV_VAR: "${params.<secret-typed>}"} -- EXACT ref only, no interpolation.
_SECRET_ENV_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
_SECRET_ENV_DENY = ("ANTHROPIC_", "AUTONOMY_", "CLAUDE_", "LD_", "DYLD_")
_SECRET_ENV_DENY_EXACT = frozenset(
    ("PATH", "HOME", "SHELL", "IFS", "ENV", "BASH_ENV", "PYTHONPATH"))


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


class MissingNodeOutput(PipelineError):
    """A ${nodes.<id>.output.<x>} whose node has not (yet) recorded that
    output. The ONE error class default() maps to its fallback -- the
    findings-return channel (a back-edge target's first visit legitimately
    predates the source's outputs). Every other resolution failure (a
    typo'd param, an unknown run field) stays a hard PipelineError."""


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
    # Scalar blocks (nodes: 5, containers: 5, children: true) are the shape
    # checks' finding; this walk stays TOTAL (validate_doc calls it on
    # garbage docs before those checks run).
    nodes_blk = doc.get("nodes")
    cons_blk = doc.get("containers")
    child_to_con = {}
    for con in (cons_blk if isinstance(cons_blk, list) else []):
        if isinstance(con, dict):
            children = con.get("children")
            for c in (children if isinstance(children, list) else []):
                if isinstance(c, str):     # garbage child = not a mapping key
                    child_to_con[c] = con.get("id")
    out, seen_con = [], set()
    for node in (nodes_blk if isinstance(nodes_blk, list) else []):
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


# --- The ${...} dynamic-param language (spec S3.1). Stdlib, NO eval/exec: a
#     hand-rolled resolver over named refs + a closed pure-function allowlist.
#     Fail-safe: any unresolvable ref / unknown function / type mismatch RAISES
#     PipelineError -- never a silent empty string. Proven in isolation here;
#     Phase B wires it into compile_brief/dispatch. ---
_ESC = "\x00AE_DOLLAR_BRACE\x00"          # sentinel for the $${ escape


def _resolve_ref(path, ctx):
    """A dotted reference: params.<n> | nodes.<id>.output.<n> | run.<field>."""
    parts = path.split(".")
    if parts[0] == "params" and len(parts) == 2:
        d = ctx.get("params", {})
        if parts[1] not in d:
            raise PipelineError("unknown param reference ${params.%s}" % parts[1])
        return d[parts[1]]
    if parts[0] == "nodes" and len(parts) == 4 and parts[2] == "output":
        outs = ctx.get("nodes", {}).get(parts[1])
        if outs is None or parts[3] not in outs:
            raise MissingNodeOutput("unknown node output ${nodes.%s.output.%s}"
                                    % (parts[1], parts[3]))
        return outs[parts[3]]
    if parts[0] == "run" and len(parts) == 2:
        d = ctx.get("run", {})
        if parts[1] not in d:
            raise PipelineError("unknown run field ${run.%s}" % parts[1])
        return d[parts[1]]
    raise PipelineError("unresolvable reference ${%s}" % path)


def _slug(s):
    s = re.sub(r"[^a-z0-9]+", "-", _to_str(s).lower()).strip("-")
    return s or "x"


# fn -> (impl, min_args, max_args | None for variadic). Arity is enforced so a
# wrong-arity call is a fail-safe language error, never an IndexError (Codex CP1).
_ALLOWED_FUNCS = {
    "default": (lambda a: a[0] if a[0] not in (None, "", False) else a[1], 2, 2),
    "concat":  (lambda a: "".join(_to_str(x) for x in a), 1, None),
    "slug":    (lambda a: _slug(a[0]), 1, 1),
}
_CALL_RE = re.compile(r"^([a-z_]+)\((.*)\)$", re.S)


def _split_args(s):
    """Top-level comma split respecting quotes + one level of nested parens.
    No eval: a hand tokenizer, so arbitrary Python can never execute."""
    args, buf, depth, quote = [], [], 0, None
    for ch in s:
        if quote:
            buf.append(ch)
            if ch == quote:
                quote = None
        elif ch in "'\"":
            quote = ch
            buf.append(ch)
        elif ch == "(":
            depth += 1
            buf.append(ch)
        elif ch == ")":
            depth -= 1
            buf.append(ch)
        elif ch == "," and depth == 0:
            args.append("".join(buf).strip())
            buf = []
        else:
            buf.append(ch)
    if quote is not None or depth != 0:
        raise PipelineError("malformed expression: unbalanced quotes/parens")
    tail = "".join(buf).strip()
    if tail or args:
        args.append(tail)
    return args


def _resolve_arg(tok, ctx):
    tok = tok.strip()
    if len(tok) >= 2 and tok[0] == tok[-1] and tok[0] in "'\"":
        return tok[1:-1]                            # string literal
    if _CALL_RE.match(tok):
        return _resolve_expr(tok, ctx)              # nested call
    if re.match(r"^-?\d+$", tok):
        return int(tok)
    return _resolve_ref(tok, ctx)                    # a reference


def _resolve_expr(expr, ctx):
    """One ${...} body: a closed-allowlist function call or a dotted reference.
    A hand-rolled parse -- there is NO eval anywhere, so ${__import__(...)} is
    just an unknown function that RAISES (test_no_eval_arbitrary_expr_refuses)."""
    expr = expr.strip()
    m = _CALL_RE.match(expr)
    if m and m.group(1) == "default":
        # default() is the ONE lazy function: its first argument may be a
        # back-edge-visible node output that legitimately does not exist yet
        # (findings-return, decision 7 in the Phase C plan). ONLY
        # MissingNodeOutput maps to the fallback -- a typo'd param stays a
        # hard error. The _ALLOWED_FUNCS entry stays: the static checker and
        # arity errors still read it.
        args_raw = _split_args(m.group(2))
        if len(args_raw) != 2:
            raise PipelineError("function 'default' arity: expected 2, got %d"
                                % len(args_raw))
        try:
            first = _resolve_arg(args_raw[0], ctx)
        except MissingNodeOutput:
            return _resolve_arg(args_raw[1], ctx)
        if first in (None, "", False):
            return _resolve_arg(args_raw[1], ctx)
        return first
    if m:
        fn, raw = m.group(1), m.group(2)
        spec = _ALLOWED_FUNCS.get(fn)
        if spec is None:
            raise PipelineError("unknown function %r (allowed: %s)"
                                % (fn, ", ".join(sorted(_ALLOWED_FUNCS))))
        impl, lo, hi = spec
        args = [_resolve_arg(a, ctx) for a in _split_args(raw)]
        if len(args) < lo or (hi is not None and len(args) > hi):
            raise PipelineError("function %r arity: expected %s, got %d"
                                % (fn, lo if hi == lo else "%s+" % lo, len(args)))
        try:
            return impl(args)
        except PipelineError:
            raise
        except Exception as exc:                 # any impl slip -> language error
            raise PipelineError("function %r failed: %s" % (fn, exc))
    return _resolve_ref(expr, ctx)


def _to_str(v):
    if isinstance(v, bool):
        return "true" if v else "false"
    return "" if v is None else str(v)


def substitute(value, ctx):
    """Resolve ${...} in one scalar. A field that is EXACTLY ${ref} keeps ref's
    TYPED value; an embedded ${ref} interpolates as a string. $${ is a literal
    ${. Non-strings pass through. Raises PipelineError on any bad reference."""
    if not isinstance(value, str):
        return value
    protected = value.replace("$${", _ESC)
    if "${" in _REF_RE.sub("", protected):
        # an opener the ref regex could not consume = unterminated ${...} --
        # a typo must RAISE, never silently stay a literal (Codex CP2)
        raise PipelineError("unterminated ${...} reference in %r "
                            "(write $${ for a literal ${)" % value)
    m = _REF_RE.fullmatch(protected)
    if m:                                          # whole-value -> typed
        out = _resolve_expr(m.group(1), ctx)
        return out if not isinstance(out, str) else out.replace(_ESC, "${")
    def repl(mo):
        return _to_str(_resolve_expr(mo.group(1), ctx))
    return _REF_RE.sub(repl, protected).replace(_ESC, "${")


def _coerce(name, typ, value, choices):
    """Type-check/coerce one resolved value. Fail-safe: a mismatch RAISES."""
    if typ == "number":
        if isinstance(value, bool):
            raise PipelineError("param %r: expected number" % name)
        try:
            return int(value) if str(value).lstrip("-").isdigit() else float(value)
        except (TypeError, ValueError):
            raise PipelineError("param %r: %r is not a number" % (name, value))
    if typ == "bool":
        if isinstance(value, bool):
            return value
        if str(value).lower() in ("true", "false"):
            return str(value).lower() == "true"
        raise PipelineError("param %r: %r is not a bool" % (name, value))
    if typ == "enum" and value not in (choices or []):
        raise PipelineError("param %r: %r not in choices %s" % (name, value, choices))
    # string/repo/agent/model/account/secret carry through as strings here; the
    # concrete existence checks (a real repo/account) belong to Phase B dispatch.
    return value


def resolve_params(declared, overrides):
    """Merge pipeline DEFAULTS with an invoker's OVERRIDES (a trigger OR a
    calling pipeline -- the same slot, spec S3), type-check, and return
    {name: typed_value}. A required param with neither default nor override
    RAISES (fail-safe). Unknown override keys RAISE. A `secret` param's
    value is a credential LABEL (SD-8: index names are non-secret) and
    passes through charset-gated; the VALUE resolves only supervisor-side
    at the env sink (Phase C -- the secret_lookup seam is deleted)."""
    if not isinstance(declared, list):
        raise PipelineError("params declaration must be a list")
    if not isinstance(overrides, dict):
        raise PipelineError("overrides must be a mapping")
    by_name = {}
    for p in declared:
        if isinstance(p, dict) and _is_str(p.get("name")):
            by_name[p["name"]] = p
    for k in overrides:
        if k not in by_name:
            raise PipelineError("override for undeclared param %r" % k)
    out = {}
    for name, p in by_name.items():
        typ = p.get("type")
        if name in overrides:
            value = overrides[name]
        elif "default" in p:
            value = p["default"]
        elif p.get("required"):
            raise PipelineError("required param %r has no value" % name)
        else:
            continue                                   # optional, unset -> absent
        if typ == "secret":
            if not (_is_str(value) and _NAME_RE.match(value)):
                # NEVER echo the rejected value: a misconfigured invoker may
                # have pasted a REAL credential where the label belongs, and
                # this message flows to supervisor.log (SD-8).
                raise PipelineError(
                    "param %r: a secret's value is a credential LABEL "
                    "(charset [A-Za-z0-9._-]{1,64}) -- the value resolves "
                    "only at the dispatch env sink" % name)
        else:
            value = _coerce(name, typ, value, p.get("choices"))
        out[name] = value
    return out


def write_output(path, name, value):
    """Append/overwrite one named output in the per-run outputs file, atomically
    (tmp + os.replace) so a concurrent reader never sees a torn file."""
    cur = read_outputs(path)
    cur[name] = value
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(cur, fh)
    os.replace(tmp, path)


def read_outputs(path):
    """Total reader: missing/corrupt/non-object -> {} (never raises)."""
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def project_outputs(declared, raw):
    """Project a run's raw outputs onto the pipeline's DECLARED outputs: keep
    only declared names (an activity cannot leak an undeclared value to a
    caller, spec S3) AND type-check each present value (Codex CP1: a declared
    `number` output written as 'abc' RAISES, never passes invalid data on). A
    declared output the run did not produce is simply absent -- a downstream
    ${nodes.id.output.x} ref then raises at resolve time (fail-safe)."""
    decls = {o["name"]: o for o in (declared or [])
             if isinstance(o, dict) and _is_str(o.get("name"))}
    out = {}
    for k, v in (raw or {}).items():
        if k not in decls:
            continue
        typ = decls[k].get("type")
        if typ not in OUTPUT_TYPES:
            # an unvalidated decl (enum/secret/garbage) must not become a
            # skipped check -- fail-safe, never pass-through (Codex CP2)
            raise PipelineError("output %r: unsupported declared type %r"
                                % (k, typ))
        if not _typed_ok(typ, v):
            raise PipelineError("output %r: %r does not match declared type %r"
                                % (k, v, typ))
        out[k] = v
    return out


def substitute_doc(doc, ctx):
    """Deep copy of doc with every STRING scalar run through substitute().
    NOT in the dispatch path: prepare substitutes each channel exactly once
    itself (a whole-doc pass composed with a field pass would double-resolve
    -- values must stay inert). Kept for consumers that need one total pass
    over a template (call_pipeline's params mapping is the expected one).
    Non-strings pass through untouched; the input doc is never mutated."""
    def walk(v):
        if isinstance(v, dict):
            return {k: walk(x) for k, x in v.items()}
        if isinstance(v, list):
            return [walk(x) for x in v]
        return substitute(v, ctx)
    return walk(doc)


def _has_ref(v):
    return isinstance(v, str) and "${" in v.replace("$${", "")


def _validate_runs_as(where, runs_as, errors):
    if runs_as is None:
        return
    if not isinstance(runs_as, dict):
        errors.append("%s: runs_as must be a mapping" % where)
        return
    for key in runs_as:
        if key not in ("model", "effort", "account", "agent"):
            errors.append("%s: runs_as.%s is not a known field" % (where, key))
    # A ${...}-bearing field defers to the POST-SUBSTITUTION concrete check
    # in _prepare_step (refuse-not-drop) -- check_refs has already validated
    # the reference statically. A ref-free field keeps the P1 checks.
    if "model" in runs_as and not _has_ref(runs_as["model"]) \
            and not _is_str(runs_as["model"]):
        errors.append("%s: runs_as.model must be a non-empty string" % where)
    if "account" in runs_as and not _has_ref(runs_as["account"]) \
            and not (_is_str(runs_as["account"])
                     and _NAME_RE.match(runs_as["account"])):
        errors.append("%s: runs_as.account must be an account name "
                      "(charset [A-Za-z0-9._-]{1,64})" % where)
    if "effort" in runs_as and not _has_ref(runs_as["effort"]) \
            and runs_as["effort"] not in VALID_EFFORTS:
        errors.append("%s: runs_as.effort %r invalid (valid: %s)"
                      % (where, runs_as.get("effort"), ", ".join(VALID_EFFORTS)))
    if "agent" in runs_as and not _has_ref(runs_as["agent"]) \
            and not (_is_str(runs_as["agent"])
                     and _AGENT_RE.match(runs_as["agent"])):
        errors.append("%s: runs_as.agent has invalid chars" % where)


def _secret_ref_param(ref):
    """'${params.x}' -> 'x'; anything else -> None. No regex re-use of the
    generic scanner: the EXACT form is the security property."""
    if not isinstance(ref, str):
        return None
    m = re.match(r"^\$\{params\.([A-Za-z0-9._-]{1,64})\}$", ref)
    return m.group(1) if m else None


def _validate_secrets_field(where, node, doc, errors):
    """The secret env channel's ONLY doc surface (decision 11): a node's
    secrets: {ENV_VAR: ${params.<secret-typed>}}. Key charset-gated and
    denylisted (never shadow engine/auth vars); value must be EXACTLY a
    ${params.<name>} ref to a declared secret param -- a secret never mixes
    into a string or function."""
    sec = node.get("secrets")
    if sec is None:
        return
    if node.get("type") == "call_pipeline":
        return   # Task 3's type-branch owns that refusal -- one error, not two
    if not isinstance(sec, dict) or not sec:
        errors.append("%s: secrets must be a non-empty mapping "
                      "ENV_VAR -> ${params.<secret-typed>}" % where)
        return
    decl = {p.get("name"): p for p in (doc.get("params") or [])
            if isinstance(p, dict)}
    for var, ref in sec.items():
        if not (isinstance(var, str) and _SECRET_ENV_RE.match(var)):
            errors.append("%s: secrets key %r must match "
                          "[A-Z][A-Z0-9_]{0,63}" % (where, var))
        elif var in _SECRET_ENV_DENY_EXACT or any(
                var.startswith(p) for p in _SECRET_ENV_DENY):
            errors.append("%s: secrets key %r would shadow an engine/auth "
                          "variable -- refused" % (where, var))
        pname = _secret_ref_param(ref)
        if pname is None:
            errors.append("%s: secrets.%s must be EXACTLY "
                          "${params.<name>} -- a secret never mixes into a "
                          "string or function" % (where, var))
        elif (decl.get(pname) or {}).get("type") != "secret":
            errors.append("%s: secrets.%s references %r which is not a "
                          "declared secret param" % (where, var, pname))


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
                if o.get("type") not in OUTPUT_TYPES:
                    errors.append("%s: type must be one of %s (enum/secret are "
                                  "not output types: no choices channel / the "
                                  "run-outputs file is plaintext)"
                                  % (w, ", ".join(OUTPUT_TYPES)))


_RUN_FIELDS = ("id", "pipeline", "trigger", "repo")
# Fields that are file PATHS resolved before substitution runs -- a ${} here
# would dispatch a garbage path, so they stay ref-free forever.
_REF_FREE_FIELDS = ("brief_ref", "legacy_prompt")


def _ancestors(doc, uid):
    """Strict ancestor UNIT ids of top-level unit `uid` over
    effective_edges (traversal edges only -- back-edges excluded: an output
    'from the future' via a back-edge is not statically guaranteed).
    TOTAL over garbage doc shapes: check_refs runs inside validate_doc
    BEFORE the node/edge shape checks, so a malformed edges list must
    degrade to 'no ancestors' (which REFUSES node-output refs -- the safe
    side) rather than crash the validator."""
    parents = {}
    try:
        edges = effective_edges(doc)
    except Exception:
        return set()
    for e in edges:
        if not isinstance(e, dict) or e.get("back"):
            continue
        parents.setdefault(e.get("to"), set()).add(e.get("from"))
    seen, stack = set(), list(parents.get(uid, ()))
    while stack:
        cur = stack.pop()
        if cur in seen:
            continue
        seen.add(cur)
        stack.extend(parents.get(cur, ()))
    return seen


def _unit_node_ids(doc, uid):
    """Node ids a UNIT contributes to the reference namespace: itself for a
    plain node, its children for a container. Total over garbage shapes."""
    con = None
    for c in doc.get("containers") or []:
        if isinstance(c, dict) and c.get("id") == uid:
            con = c
            break
    if con is None:
        return [uid]
    return [ch for ch in (con.get("children") or []) if isinstance(ch, str)]


def _soft_visible(doc, unit):
    """Node ids whose outputs `unit` may reference ONLY inside default():
    back-edge sources that re-run this unit when they bounce. src is
    soft-visible to unit iff unit lies on the re-run stretch -- unit is the
    back-edge target or downstream of it, AND strictly upstream of src."""
    soft = set()
    try:
        edges = effective_edges(doc)
    except Exception:
        return soft
    anc_of_unit = _ancestors(doc, unit)
    for e in edges:
        if not (isinstance(e, dict) and e.get("back")):
            continue
        src, tgt = e.get("from"), e.get("to")
        if not (isinstance(src, str) and isinstance(tgt, str)):
            continue
        if (unit == tgt or tgt in anc_of_unit) and unit in _ancestors(doc, src):
            soft.update(_unit_node_ids(doc, src))
    return soft


def _check_expr_static(expr, declared_params, allowed_nodes, soft_nodes,
                       errors, where, soft_ok=False):
    """Parse ONE ${...} body without resolving anything. Mirrors
    _resolve_expr's grammar exactly -- if this accepts, resolution can only
    fail on run-time-only facts (a node that wrote no outputs). soft_nodes
    are back-edge-visible node ids, legal ONLY as default()'s first argument
    (soft_ok) -- the findings-return channel, decision 7."""
    expr = expr.strip()
    m = _CALL_RE.match(expr)
    if m:
        fn, raw = m.group(1), m.group(2)
        spec = _ALLOWED_FUNCS.get(fn)
        if spec is None:
            errors.append("%s: unknown function %r (allowed: %s)"
                          % (where, fn, ", ".join(sorted(_ALLOWED_FUNCS))))
            return
        _impl, lo, hi = spec
        try:
            args = _split_args(raw)
        except PipelineError as exc:
            errors.append("%s: %s" % (where, exc))
            return
        if len(args) < lo or (hi is not None and len(args) > hi):
            errors.append("%s: function %r arity: expected %s, got %d"
                          % (where, fn, lo if hi == lo else "%s+" % lo,
                             len(args)))
        for j, a in enumerate(args):
            a = a.strip()
            if len(a) >= 2 and a[0] == a[-1] and a[0] in "'\"":
                continue                              # string literal
            if re.match(r"^-?\d+$", a):
                continue                              # int literal
            _check_expr_static(a, declared_params, allowed_nodes, soft_nodes,
                               errors, where,
                               soft_ok=(fn == "default" and j == 0))
        return
    parts = expr.split(".")
    if parts[0] == "params" and len(parts) == 2:
        decl = declared_params.get(parts[1])
        if decl is None:
            errors.append("%s: ${params.%s} is not a declared param"
                          % (where, parts[1]))
        elif decl.get("type") == "secret":
            errors.append("%s: ${params.%s} is secret-typed -- its only "
                          "sink is a node's secrets: map (the env channel); "
                          "briefs, runs_as and call params never carry a "
                          "secret" % (where, parts[1]))
        return
    if parts[0] == "nodes" and len(parts) == 4 and parts[2] == "output":
        if parts[1] in allowed_nodes:
            return
        if soft_ok and parts[1] in soft_nodes:
            return
        errors.append("%s: ${nodes.%s.output.%s} does not name a strict "
                      "upstream node -- its outputs cannot exist yet (a "
                      "back-edge-visible node's outputs may be read only as "
                      "default()'s first argument)"
                      % (where, parts[1], parts[3]))
        return
    if parts[0] == "run" and len(parts) == 2:
        if parts[1] not in _RUN_FIELDS:
            errors.append("%s: ${run.%s} unknown (fields: %s)"
                          % (where, parts[1], ", ".join(_RUN_FIELDS)))
        return
    errors.append("%s: unresolvable reference ${%s}" % (where, expr))


def check_refs(doc, errors):
    """Static validation of every ${...} in activity string fields (spec
    S3.1: an unresolved/unknown ref or non-allowlisted function is a
    VALIDATOR error -- refuse, don't run). Field-blind scan like
    _refuse_refs_in_activity_fields was, except brief_ref/legacy_prompt
    which must stay ref-free (they are paths, resolved before substitution).
    Also refuses an unterminated '${' (substitute would raise at prepare
    time -- catching it at validate time keeps 'validating == runnable')."""
    # Garbage BLOCK shapes (a scalar where a list belongs: params: 5,
    # nodes: 5, containers: 5, children: true) and garbage id shapes are
    # the SHAPE checks' finding, later in validate_doc -- here they just
    # degrade to empty (refs then refuse as undeclared/non-upstream, the
    # safe side); this scan must stay total, it runs before those checks
    # (review round 1, PR #375 -- same-class scan over every block).
    def _lst(v):
        return v if isinstance(v, list) else []

    declared = {p.get("name"): p for p in _lst(doc.get("params"))
                if isinstance(p, dict)}
    con_of = {}
    for con in _lst(doc.get("containers")):
        if isinstance(con, dict):
            for ch in _lst(con.get("children")):
                if isinstance(ch, str):
                    con_of[ch] = con.get("id")
    # A detached (wait:false) call's outputs NEVER return to this run --
    # referencing them is statically dead, refuse with the specific reason
    # (decisions 3+7).
    detached = set()
    for n in _lst(doc.get("nodes")):
        if isinstance(n, dict) and n.get("type") == "call_pipeline" \
                and n.get("wait") is False and isinstance(n.get("id"), str):
            detached.add(n["id"])

    def _allowed_node_ids(nid, unit):
        """Referenceable node ids for a node: every node an ancestor UNIT
        contributes (a container's children included -- the latent gap
        decision 9 fixes), plus EARLIER siblings in its own container (the
        walk runs container children in order; later siblings stay refused
        -- in a loop they would read the previous round's value)."""
        allowed = set()
        for a in _ancestors(doc, unit):
            allowed.update(_unit_node_ids(doc, a))
        cid = con_of.get(nid)
        if cid is not None:
            sibs = _unit_node_ids(doc, cid)
            if nid in sibs:
                allowed.update(sibs[:sibs.index(nid)])   # EARLIER siblings only
        return allowed

    def scan(where, v, unit, nid=None):
        if isinstance(v, str):
            if "${" in v.replace("$${", ""):
                allowed = _allowed_node_ids(nid, unit) if unit else set()
                soft = _soft_visible(doc, unit) if unit else set()
                allowed -= detached
                soft -= detached
                protected = v.replace("$${", _ESC)
                bodies = _REF_RE.findall(protected)
                stripped = _REF_RE.sub("", protected)
                if "${" in stripped:
                    errors.append("%s: unterminated ${ reference" % where)
                for b in bodies:
                    for did in detached:
                        if ("nodes.%s.output." % did) in b:
                            errors.append("%s: ${nodes.%s.output...} names a "
                                          "detached (wait:false) call -- its "
                                          "outputs never return" % (where, did))
                    _check_expr_static(b, declared, allowed, soft, errors,
                                       where)
        elif isinstance(v, dict):
            for k, x in v.items():
                scan("%s.%s" % (where, k), x, unit, nid)
        elif isinstance(v, list):
            for j, x in enumerate(v):
                scan("%s[%d]" % (where, j), x, unit, nid)

    for i, node in enumerate(_lst(doc.get("nodes"))):
        if not isinstance(node, dict):
            continue
        where = "nodes[%d]" % i
        for f in _REF_FREE_FIELDS:
            val = node.get(f)
            if isinstance(val, str) and "${" in val:
                errors.append("%s.%s: is a file path -- ${...} is never "
                              "substituted in paths" % (where, f))
        nid = node.get("id")
        unit = con_of.get(nid, nid) if isinstance(nid, str) else None
        # 'secrets' is excluded from the generic ref scan: its own validator
        # (_validate_secrets_field) owns the exact-ref rule, and the generic
        # scanner would double-refuse the deliberate secret ref inside it.
        clean = {k: v for k, v in node.items()
                 if k not in _REF_FREE_FIELDS and k != "secrets"}
        scan(where, clean, unit, nid)
    for i, con in enumerate(_lst(doc.get("containers"))):
        if isinstance(con, dict):
            scan("containers[%d]" % i, con, con.get("id"))


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
    # Phase B: substitution IS wired into prepare now, so ${...} in activity
    # fields is validated statically (check_refs) instead of refused
    # wholesale. The Phase A gate (_refuse_refs_in_activity_fields) is
    # DELETED in this same commit -- a validating doc is still a runnable
    # doc, the honesty invariant just moved from "refuse" to "check".
    check_refs(doc, errors)

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
        elif nid.rsplit(".", 1)[-1] in _RESERVED_SIDECAR_SUFFIXES:
            # A child token ends with the node id (<parent>.c<slot>.<id>);
            # a reserved last component would make the child's state file
            # look like a sidecar to the supervisor's token scan -- the
            # child would start but never dispatch (stranded).
            errors.append("%s: id %r ends in a reserved sidecar suffix "
                          "(%s) -- rename the node"
                          % (where, nid,
                             "/".join(sorted(_RESERVED_SIDECAR_SUFFIXES))))
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
        if ntype == "call_pipeline":
            # A call node carries NO session surface -- the child's own doc
            # declares its briefs/runs_as/secrets ('secrets' forward-refs
            # Task 7's node key; listing it now is a no-op until _NODE_KEYS
            # gains it there, and keeps the two tasks commit-independent).
            for bad in ("brief_ref", "legacy_prompt", "runs_as", "secrets"):
                if bad in node:
                    errors.append("%s: %r does not belong on call_pipeline "
                                  "(the child's own doc carries it)"
                                  % (where, bad))
            if not valid_pipeline_name(node.get("pipeline")):
                errors.append("%s: pipeline: required, charset "
                              "[A-Za-z0-9._-]{1,64} (existence is checked at "
                              "call time)" % where)
            cparams = node.get("params")
            if cparams is not None:
                if not isinstance(cparams, dict):
                    errors.append("%s: params must be a mapping of "
                                  "name -> scalar" % where)
                else:
                    for k, v in cparams.items():
                        if not (isinstance(k, str) and _NAME_RE.match(k)):
                            errors.append("%s: params key %r invalid charset"
                                          % (where, k))
                        if not (isinstance(v, (str, int, float, bool))
                                or v is None):
                            errors.append("%s: params.%s must be a scalar"
                                          % (where, k))
            if "wait" in node and not isinstance(node["wait"], bool):
                errors.append("%s: wait must be a bool" % where)
        else:
            for bad in ("pipeline", "params", "wait"):
                if bad in node:
                    errors.append("%s: %r only belongs on call_pipeline"
                                  % (where, bad))
            if has_brief == has_legacy:
                errors.append("%s: exactly one of brief_ref / legacy_prompt "
                              "required" % where)
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
        _validate_secrets_field(where, node, doc, errors)

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
            # non-str/non-list children already earned an error above; keep
            # this set op TOTAL on garbage (unhashable dict, scalar children)
            ch = c.get("children")
            child_ids.update(x for x in (ch if isinstance(ch, list) else [])
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
    # P2b (#351): the P1/P2a multi-node cron/event refusal is LIFTED -- an
    # in-flight run joins the main loop's dispatch list regardless of its
    # trigger type, so a cron/event fire only STARTS the run and the loop
    # advances it with its own limit/backoff/pause handling.
    return resolve_pipeline_doc(repo, binding)


def resolve_pipeline_doc(repo, name):
    """By-NAME pipeline resolution (trigger-started runs; also the bound
    branch of resolve_pipeline -- extracted in Phase B, behaviour
    byte-identical). Reads the var-live shadow when the operator has edited
    this pipeline in the canvas (SD-34/SD-37); a present-but-invalid shadow
    RAISES, never a silent fallback to the committed default
    (prevention-log #3). Validates, checks legacy prompts. Fail-safe."""
    if not valid_pipeline_name(name):
        raise PipelineError("pipeline name %r has invalid charset" % (name,))
    pdir = effective_pipeline_dir(repo, name)
    doc = load_doc(os.path.join(pdir, "pipeline.json"))
    errs = validate_doc(doc, pdir)
    if errs:
        raise PipelineError("pipeline %r invalid: %s"
                            % (name, "; ".join(errs)))
    _check_legacy_prompts(repo, doc, "pipeline %r" % name)
    return doc, {"pipeline_dir": pdir, "wrapped": False,
                 "from": name, "from_version": doc.get("version", 0)}


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
    _check_call_name_headroom(doc, role)
    doc = dict(doc)
    # Implicit chain synthesis: P1 docs and wrapped roles become the
    # equivalent success-chain graph -- ONE walk engine, stored into the
    # state's embedded doc so a resumed run is stable.
    doc["edges"] = effective_edges(doc)
    # run_id: role[--lane]-timestamp-pid -- pid disambiguates same-second
    # starts across lanes/tests (second-granularity ids collide, weakening
    # the trust-ledger identity field).
    ident = "%s--%s" % (role, lane) if lane else role
    run_id = "%s-%s-%d" % (ident, time.strftime("%Y%m%dT%H%M%S"), os.getpid())
    # trigger/kind/params/run: ONE state shape with trigger-started runs
    # (Phase B) -- the walk code never branches on kind. For a shim the
    # trigger IS the role (name byte-equal, the trust-continuity contract).
    state = {"fmt": 2,
             "run_id": run_id,
             "role": role, "lane": lane, "doc": doc, "meta": meta,
             "trigger": role, "kind": "shim", "params": {},
             "run": {"id": run_id, "pipeline": doc["name"],
                     "trigger": role, "repo": repo},
             "started": int(time.time()), "sessions": 0,
             "units": dict((u, {"status": "pending"}) for u in _top_units(doc)),
             "container_pos": {}, "rounds": {}, "bounces": {},
             "nodes_done": [], "status": "in_progress"}
    _atomic_write_json(state_path, state)
    return state


def _registered_repos():
    """The control-unit registry (bin/control.sh, one absolute path per
    line). Raises OSError when unreadable -- the CALLER decides whether the
    run needed it (a run with no repo-typed params never asks)."""
    path = os.path.expanduser("~/.config/autonomy/repos")
    with open(path, encoding="utf-8") as fh:
        return set(ln.strip() for ln in fh if ln.strip())


def _known_accounts():
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import accounts
    # Accounts.list() returns dict ROWS (lib/accounts.py:384) -- set() over
    # them would raise TypeError (Codex CP1; the plan named the class
    # `Registry`, the real class is `Accounts` -- verified against the
    # accounts tests). Project NAMES totally: drop any row that isn't
    # readable as one (prevention-log #12).
    out = set()
    for row in accounts.Accounts().list():
        name = row.get("name") if isinstance(row, dict) else row
        if isinstance(name, str) and name:
            out.add(name)
    return out


def check_param_existence(declared, resolved, *, known_repos, known_accounts):
    """repo/account-typed params must name REGISTERED entities (spec S11:
    'selects among engine-registered checkouts, validated -- never an
    arbitrary path'). Reader failure REFUSES a run that uses the type
    (can't verify = don't run); types not used never read the registry."""
    types = {p["name"]: p.get("type") for p in declared
             if isinstance(p, dict) and _is_str(p.get("name"))}
    for name, value in resolved.items():
        typ = types.get(name)
        if typ == "repo":
            try:
                reg = known_repos()
            except Exception as exc:
                raise PipelineError("param %r: cannot read the repo "
                                    "registry (%s) -- refusing" % (name, exc))
            if value not in reg:
                raise PipelineError("param %r: %r is not a registered "
                                    "checkout" % (name, value))
        elif typ == "account":
            try:
                known = known_accounts()
            except Exception as exc:
                raise PipelineError("param %r: cannot read the accounts "
                                    "index (%s) -- refusing" % (name, exc))
            if value not in known:
                raise PipelineError("param %r: %r is not a known account"
                                    % (name, value))


def _resolve_run_params(repo, doc, overrides, *, known_repos=None,
                        known_accounts=None):
    """Invoker param resolution for a parameterised run (a trigger OR a
    calling pipeline -- the same slot, spec S3). Secret params resolve to
    credential LABELS here (non-secret, SD-8); the VALUE resolves only
    supervisor-side at the env sink. Phase B's no-sink refusal retired in
    the same commit that landed the sink (the honesty invariant)."""
    declared = doc.get("params") or []
    params = resolve_params(declared, overrides)
    check_param_existence(
        declared, params,
        known_repos=known_repos or _registered_repos,
        known_accounts=known_accounts or _known_accounts)
    return params


def start_run_trigger(repo, trigger_name, state_path, lane="", *,
                      known_repos=None, known_accounts=None,
                      event_fields=None):
    """Start a run for a NATIVE trigger: load+validate the trigger, resolve
    the pipeline BY NAME, resolve params (required-unset refuses HERE,
    before a session is burned -- _resolve_run_params, shared with
    start_child_run), run the repo/account existence checks, write fmt-2
    state. event_fields = the event payload for an event-mode trigger's
    firing.map (decision 13); refused on non-event triggers, required when
    the trigger maps. A shim with pipeline '' never reaches this function
    -- shims start through start_run(repo, role)."""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import triggers as triggers_mod
    trig = triggers_mod.load_trigger(repo, trigger_name)
    if not trig["pipeline"]:
        raise PipelineError("trigger %r has no pipeline binding -- shim "
                            "triggers start through start_run" % trigger_name)
    # The Phase B event-role collision chokepoint retired HERE, in the same
    # commit that shims event roles and swaps the loop to the trigger event
    # resolver (decision 15): natives supersede shims, so exactly one
    # enumerator can fire an event name -- the refusal's reason to exist is
    # structurally gone. The config read existed only for that probe; a
    # native start no longer requires a readable config (enumeration still
    # does -- dispatch is unaffected).
    firing = trig.get("firing") or {}
    overrides = dict(trig["params"])
    mapping = firing.get("map") or {}
    if event_fields is not None and firing.get("mode") != "event":
        raise PipelineError("trigger %r: event fields supplied to a "
                            "non-event trigger -- refusing" % trigger_name)
    if firing.get("mode") == "event" and mapping and event_fields is None:
        raise PipelineError("trigger %r maps event payload fields but no "
                            "event fields were supplied -- an event run "
                            "starts from the event resolver" % trigger_name)
    if event_fields is not None:
        fields = dict(event_fields)
        fields.setdefault("event", firing.get("event", ""))
        for pname, fld in mapping.items():
            if fld not in fields or fields[fld] in (None, ""):
                raise PipelineError("trigger %r: event payload has no field "
                                    "%r for param %r" % (trigger_name, fld,
                                                         pname))
            overrides[pname] = fields[fld]
    doc, meta = resolve_pipeline_doc(repo, trig["pipeline"])
    _check_call_name_headroom(doc, trigger_name)
    if event_fields is not None:
        decl_types = {p.get("name"): p.get("type")
                      for p in (doc.get("params") or []) if isinstance(p, dict)}
        for pname in mapping:
            if decl_types.get(pname) == "secret":
                raise PipelineError("trigger %r: firing.map targets secret "
                                    "param %r -- an event payload is never a "
                                    "credential" % (trigger_name, pname))
    params = _resolve_run_params(repo, doc, overrides,
                                 known_repos=known_repos,
                                 known_accounts=known_accounts)
    doc = dict(doc)
    doc["edges"] = effective_edges(doc)
    ident = "%s--%s" % (trigger_name, lane) if lane else trigger_name
    run_id = "%s-%s-%d" % (ident, time.strftime("%Y%m%dT%H%M%S"),
                           os.getpid())
    # "role": trigger_name keeps every existing state consumer -- journal,
    # dashboard state-file glob, ledger -- working without a branch; Phase E
    # renames the key when trust re-keys.
    state = {"fmt": 2, "run_id": run_id,
             "role": trigger_name, "lane": lane, "doc": doc, "meta": meta,
             "trigger": trigger_name, "kind": "native", "params": params,
             "run": {"id": run_id, "pipeline": doc["name"],
                     "trigger": trigger_name, "repo": repo},
             "started": int(time.time()), "sessions": 0,
             "units": dict((u, {"status": "pending"}) for u in _top_units(doc)),
             "container_pos": {}, "rounds": {}, "bounces": {},
             "nodes_done": [], "status": "in_progress"}
    _atomic_write_json(state_path, state)
    return state


def _state_base(state_path):
    base = os.path.basename(state_path)
    if base.endswith(".json"):
        base = base[:-len(".json")]
    return base


def _run_outcome_rel(state_path):
    """The parked child outcome, derived exactly like the verdict/outputs
    sidecars -- one naming rule everywhere, lane/slot-safe for free."""
    return "var/autonomy-logs/%s.outcome.json" % _state_base(state_path)


def _child_token_name(parent_state_path, parent_state, node_id):
    """<parent-name>.c<parent-slot>.<node-id> -- parsed from the state
    FILENAME with inflight_tokens' exact rules (strip @slot from the end,
    then --lane), so both sides agree by construction."""
    base = _state_base(parent_state_path)
    if base.startswith(".pipeline-run-"):
        base = base[len(".pipeline-run-"):]
    slot = "0"
    if "@" in base:
        base, slot = base.rsplit("@", 1)
    lane = parent_state.get("lane") or ""
    if lane and base.endswith("--%s" % lane):
        base = base[:-(len(lane) + 2)]
    return "%s.c%s.%s" % (base, slot, node_id)


def _check_call_name_headroom(doc, run_name):
    """Every call node must yield a charset-legal child token:
    <run_name>.c<slot>.<node_id> with slot up to MAX_PARALLEL_CEIL-1 (the
    widest slot a parent can occupy -- derived, so raising the ceiling can
    never silently under-count this check). Raises PipelineError naming the
    first offender. Called at RUN START (CP1: an over-long trigger name
    must refuse the run up front, not fail every call node one by one at
    sweep time -- same verdict, delivered before any session burns)."""
    for n in doc.get("nodes") or []:
        if not (isinstance(n, dict) and n.get("type") == "call_pipeline"):
            continue
        worst = "%s.c%d.%s" % (run_name, MAX_PARALLEL_CEIL - 1,
                               n.get("id", ""))
        if not _NAME_RE.match(worst):
            raise PipelineError(
                "call node %r: child token %r would exceed the 64-char name "
                "limit -- shorten the trigger or node name (refusing the run "
                "up front rather than failing every call at sweep time)"
                % (n.get("id"), worst))


def start_child_run(repo, parent_state_path, parent_state, node):
    """Spawn the CHILD run for a call_pipeline node (spec S4): a real run,
    resolved+parameterised exactly like a trigger-started run -- the caller
    occupies the trigger's override slot. Returns (child_name,
    child_state_path); raises PipelineError on every refusal (the caller
    records the call unit as failed -- a broken call must fail the node,
    never crash the walk)."""
    child_name = _child_token_name(parent_state_path, parent_state, node["id"])
    if not _NAME_RE.match(child_name):
        raise PipelineError("child run name %r is over 64 chars or invalid "
                            "-- shorten the trigger/pipeline/node names"
                            % child_name)
    depth = int(parent_state.get("call_depth") or 0) + 1
    if depth > MAX_CALL_DEPTH:
        raise PipelineError("call depth %d exceeds MAX_CALL_DEPTH=%d"
                            % (depth, MAX_CALL_DEPTH))
    call_path = list(parent_state.get("call_path")
                     or [parent_state.get("doc", {}).get("name", "")])
    if node["pipeline"] in call_path:
        raise PipelineError("call cycle: %s -> %s"
                            % (" -> ".join(call_path), node["pipeline"]))
    doc, meta = resolve_pipeline_doc(repo, node["pipeline"])
    _check_call_name_headroom(doc, child_name)      # grandchild headroom
    ctx = _substitution_ctx(parent_state_path, parent_state)
    overrides = {}
    for k, v in (node.get("params") or {}).items():
        overrides[k] = substitute(v, ctx)     # ONE pass; values stay inert
    params = _resolve_run_params(repo, doc, overrides)
    doc = dict(doc)
    doc["edges"] = effective_edges(doc)
    lane = parent_state.get("lane") or ""
    child_base = "%s--%s" % (child_name, lane) if lane else child_name
    child_state_path = os.path.join(os.path.dirname(parent_state_path),
                                    ".pipeline-run-%s.json" % child_base)
    if os.path.exists(child_state_path):
        raise PipelineError("child state %s already exists -- a previous "
                            "child was interrupted mid-consume; remove the "
                            "file to recover" % child_state_path)
    run_id = "%s-%s-%d" % (child_name, time.strftime("%Y%m%dT%H%M%S"),
                           os.getpid())
    state = {"fmt": 2, "run_id": run_id,
             "role": child_name, "lane": lane, "doc": doc, "meta": meta,
             "trigger": child_name, "kind": "native", "params": params,
             "run": {"id": run_id, "pipeline": doc["name"],
                     "trigger": child_name, "repo": repo},
             "parent_run": parent_state.get("run_id", ""),
             "parent_node": node["id"],
             "call_depth": depth, "call_path": call_path + [node["pipeline"]],
             "started": int(time.time()), "sessions": 0,
             "units": dict((u, {"status": "pending"}) for u in _top_units(doc)),
             "container_pos": {}, "rounds": {}, "bounces": {},
             "nodes_done": [], "status": "in_progress"}
    _atomic_write_json(child_state_path, state)
    return child_name, child_state_path


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


def _node_outputs_rel(state_path, node_id):
    """Per-NODE outputs sidecar, derived exactly like the verdict file --
    one naming rule both sides, lane/slot-safe for free."""
    base = os.path.basename(state_path)
    if base.endswith(".json"):
        base = base[:-len(".json")]
    return "var/autonomy-logs/%s.%s.outputs.json" % (base, node_id)


def _collect_node_outputs(state_path, state):
    """{node_id: {name: value}} for every recorded-successful node, read
    TOTALLY from the sidecars (read_outputs: missing/corrupt -> {}). A node
    that wrote nothing simply has no entry -- a ref to it refuses at
    substitute time with the Phase A 'unknown node output' error.
    call_pipeline entries contribute on failure too (decision 8: a failed
    QA child's findings are exactly the value the back-edge loops back);
    plain nodes stay success-only (an errored session's sidecar is
    untrustworthy)."""
    logdir = os.path.dirname(state_path)
    out = {}
    for entry in state.get("nodes_done", []):
        usable = entry.get("outcome") == "success" or (
            entry.get("type") == "call_pipeline"
            and entry.get("outcome") in ("success", "failure"))
        if not usable:
            continue
        nid = entry.get("id")
        rel = _node_outputs_rel(state_path, nid)
        vals = read_outputs(os.path.join(logdir, os.path.basename(rel)))
        if vals:
            out[nid] = vals
    return out


_OUTPUTS_FOOTER = """<!-- pipeline:outputs -->
A later activity reads this activity's named outputs. Before you finish,
write a JSON object of them to %(outputs_file)s (relative to the repo
root), e.g. {"branch": "feat/x-123"}. Downstream references
($${nodes.%(node_id)s.output.<name>}) refuse to run if the name they need
is missing -- write every output you produced."""
# The $${ above is the documented prose escape: the footer is appended to the
# brief BEFORE substitute() runs over the composed text, and a live
# ${nodes.<this-node>...} ref would try to resolve THIS node's not-yet-written
# outputs and refuse its own dispatch. substitute() renders it back to ${.


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
        # Additive Phase B field: evidence for Phase E's per-trigger trust
        # re-key starts accumulating now; ledger() does NOT read it yet.
        "trigger": state.get("trigger", ""),
        # Additive Phase C field: links a child run's line to its parent.
        "parent_run": state.get("parent_run", ""),
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


def _write_child_outcome(state, state_path, outcome):
    """Park {outcome, outputs} for the parent's sweep. Outputs = the child's
    DECLARED outputs projected from its node sidecars in completion order;
    call entries contribute on failure too (decision 8). A projection
    failure DOWNGRADES the parked outcome to failure with the error named
    -- unvalidated data never crosses runs (fail-safe)."""
    raw = {}
    logdir = os.path.dirname(state_path)
    for entry in state.get("nodes_done", []):
        if not isinstance(entry, dict):
            continue
        usable = entry.get("outcome") == "success" or (
            entry.get("type") == "call_pipeline"
            and entry.get("outcome") in ("success", "failure"))
        if not usable:
            continue
        rel = _node_outputs_rel(state_path, entry.get("id"))
        raw.update(read_outputs(os.path.join(logdir, os.path.basename(rel))))
    payload = {"run_id": state.get("run_id", ""), "outcome": outcome}
    try:
        payload["outputs"] = project_outputs(
            (state.get("doc") or {}).get("outputs") or [], raw)
    except PipelineError as exc:
        payload = {"run_id": state.get("run_id", ""), "outcome": "failure",
                   "error": "outputs projection failed: %s" % exc}
    path = os.path.join(os.path.dirname(state_path), os.path.basename(
        _run_outcome_rel(state_path)))
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, sort_keys=True)
    os.replace(tmp, path)


def _finish(state, state_path, outcome, journal_path):
    state["status"] = "done"
    state["outcome"] = outcome
    # Sidecar FIRST: a write failure raises and leaves the run in_progress
    # so it retries -- never a silently lost outcome the parent waits on.
    if state.get("parent_run"):
        _write_child_outcome(state, state_path, outcome)
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


def _substitution_ctx(state_path, state):
    # Secret-typed params are STRIPPED (defense in depth, decision 11): the
    # secrets: map resolves its labels from state['params'] directly, and an
    # escaped ${params.<secret>} that reaches the generic resolver raises
    # "unknown param" at prepare instead of leaking a label into a brief.
    params = dict(state.get("params") or {})
    for p in (state.get("doc") or {}).get("params") or []:
        if isinstance(p, dict) and p.get("type") == "secret":
            params.pop(p.get("name"), None)
    return {"params": params,
            "nodes": _collect_node_outputs(state_path, state),
            "run": state.get("run") or {}}


def _concrete_runs_as_check(node_id, runs_as):
    """The SAME concrete gates _validate_runs_as applies to ref-free fields,
    re-run on POST-substitution values. REFUSES (raises) -- never the
    wrap_role warn-and-drop: dropping a trigger's chosen model would
    silently change what the operator parameterised (prevention-log #3/#15;
    the supervisor's bash-side re-validation stays as defense in depth,
    prevention-log #6)."""
    errs = []
    _validate_runs_as("node %r (resolved)" % node_id, runs_as, errs)
    for k, v in (runs_as or {}).items():
        if _has_ref(v):
            errs.append("node %r: runs_as.%s still carries ${ after "
                        "substitution" % (node_id, k))
    if errs:
        raise PipelineError("; ".join(errs))


def _doc_briefs_reference(pdir, doc, needle):
    """True when any sibling brief file mentions `needle` -- total reader
    (an unreadable brief refuses later at ITS compile; here absence of
    evidence just means no footer)."""
    if not pdir:
        return False
    for n in doc.get("nodes", []):
        ref = n.get("brief_ref")
        if not ref:
            continue
        try:
            with open(os.path.join(pdir, ref)) as fh:
                if needle in fh.read():
                    return True
        except OSError:
            continue
    return False


def _prepare_step(state_path, state, uid, brief_path):
    doc = state["doc"]
    node = _node_by_id(doc, _expected_node(doc, state, uid))
    verdict_rel = _verdict_rel(state_path, node["id"])
    ctx = _substitution_ctx(state_path, state)
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
        # Downstream consumers of THIS node's outputs? Tell the agent where
        # to write them (same contract as the verdict footer).
        consumers = "${nodes.%s.output." % node["id"]
        if consumers in json.dumps(doc) or _doc_briefs_reference(
                pdir, doc, consumers):
            text += "\n\n" + _OUTPUTS_FOOTER % {
                "outputs_file": _node_outputs_rel(state_path, node["id"]),
                "node_id": node["id"]}
        # Brief TEXT substitution: string interpolation over the composed
        # brief (body + footers). A stray unknown ref RAISES here -- refuse
        # the dispatch, never send a template to an agent. Prose ${ must be
        # escaped $${ (documented in docs/pipelines.md).
        text = substitute(text, ctx)
        with open(brief_path, "w") as fh:
            fh.write(text)
        kind, prompt = "compiled", brief_path
    # runs_as resolves from its TEMPLATE form in exactly ONE substitute pass
    # (the stored doc keeps templates so a later bounce re-resolves fresh).
    # Never substitute a runs_as value twice: the second pass would re-parse
    # ${...} inside an already-substituted PARAM VALUE -- the injection
    # channel the inertness argument (single-pass re.sub, Phase A PR #372)
    # forbids. A value that still carries a literal ${ after the single
    # pass is data; the concrete check below refuses it (never dispatched).
    merged = {k: substitute(v, ctx)
              for k, v in _effective_runs_as(doc, node).items()}
    _concrete_runs_as_check(node["id"], merged)
    # The secret env channel (decision 11): resolve each secrets: ref to its
    # LABEL from state['params'] (labels are non-secret, SD-8). Refused, not
    # dropped, when unresolvable -- a session missing a declared secret is a
    # broken constraint artifact (prevention-log #3).
    secrets_map = {}
    for var, ref in (node.get("secrets") or {}).items():
        pname = _secret_ref_param(ref)
        label = (state.get("params") or {}).get(pname) if pname else None
        if not (isinstance(label, str) and _NAME_RE.match(label)):
            raise PipelineError("node %r: secrets.%s has no resolvable "
                                "credential label -- refusing dispatch"
                                % (node["id"], var))
        secrets_map[var] = label
    step = {"status": "node", "unit": uid, "node": node["id"], "kind": kind,
            "prompt": prompt, "verdict": verdict_rel, "runs_as": merged}
    if secrets_map:
        step["secrets"] = secrets_map
    return step


def _record_call_entry(state, uid, nid, outcome, extra):
    """Append a call node's journal entry + resolve the unit terminal state
    through the SAME rails a session record uses (via/back-edges/skips).
    Does NOT touch state["sessions"] -- the budget is RESERVED at call START
    (_start_call_unit, decision 4), never at consumption. Containers: a call
    node inside a container advances container_pos exactly like
    record_outcome's mid-container arm."""
    doc = state["doc"]
    entry = {"id": nid, "type": "call_pipeline", "outcome": outcome,
             "unit": uid,
             "via": sorted(set(e["on"] for e in _incoming_edges(doc, uid)
                               if _edge_state(state, e) == "satisfied")),
             "session_log": ""}
    entry.update(extra)
    state["nodes_done"].append(entry)
    unit = state["units"][uid]
    unit.pop("child", None)
    con = _con_by_id(doc, uid)
    status = "success" if outcome == "success" else "failure"
    if con is None:
        unit["status"] = status
    else:
        pos = int(state["container_pos"].get(uid, 0))
        children = con["children"]
        if status == "failure":
            unit["status"] = "failure"
        elif pos == len(children) - 1:
            # loop-exit verdicts come from sessions; a call as the last loop
            # child exits on success (documented in docs/pipelines.md)
            unit["status"] = "success"
        else:
            state["container_pos"][uid] = pos + 1
            unit["status"] = "pending"
    if unit["status"] not in ("pending", "dispatched"):
        _traverse_back_edges(doc, state, uid)
        _propagate_skips(doc, state)


def _child_alive(child_state_path):
    """EARNED liveness: the child state file exists, parses, and says
    in_progress. A done-marked state (_finish's could-not-unlink marker) or
    unreadable/garbage state is NOT alive -- treating it as alive would make
    a lost sidecar wait forever (CP1; prevention-log #18: the reassuring
    verdict is earned). Total reader."""
    try:
        with open(child_state_path, encoding="utf-8") as fh:
            st = json.load(fh)
        return isinstance(st, dict) and st.get("status") == "in_progress"
    except (OSError, ValueError):
        return False


def _unlink_quiet(path):
    try:
        os.unlink(path)
    except OSError:
        pass


def _sweep_call_units(state_path, state):
    """Consume terminal children of dispatched call units. The reclaim rule
    refined for calls: sidecar present -> consume; child ALIVE (in_progress
    by its own state, _child_alive) -> keep waiting (NEVER a duplicate
    child); no sidecar + child not alive + state file GONE -> restart the
    child (external interference; duplicate work beats a stranded run); no
    usable sidecar + child done-or-garbage -> record failure
    (prevention-log #18)."""
    doc = state["doc"]
    logdir = os.path.dirname(state_path)
    for uid in _top_units(doc):
        unit = state["units"][uid]
        if unit.get("status") != "dispatched" or "child" not in unit:
            continue
        nid = _expected_node(doc, state, uid)
        child = unit["child"]
        lane = state.get("lane") or ""
        child_base = "%s--%s" % (child, lane) if lane else child
        child_state = os.path.join(logdir,
                                   ".pipeline-run-%s.json" % child_base)
        sidecar = os.path.join(logdir,
                               ".pipeline-run-%s.outcome.json" % child_base)
        try:
            with open(sidecar, encoding="utf-8") as fh:
                payload = json.load(fh)
            if not isinstance(payload, dict):
                raise ValueError("not an object")
        except OSError:
            if _child_alive(child_state):
                continue                          # child alive: wait
            if not os.path.exists(child_state):
                del unit["child"]                 # vanished: restart
                _start_call_unit(state_path, state, uid,
                                 _node_by_id(doc, nid))
                continue
            # done-marked/garbage child state with NO sidecar: the outcome
            # is unrecoverable -- record failure, never wait forever
            _record_call_entry(state, uid, nid, "failure",
                               {"child_run": child,
                                "error": "child finished but its outcome "
                                         "sidecar is missing"})
            continue
        except ValueError as exc:
            if _child_alive(child_state):
                continue                          # child alive: not terminal yet
            _record_call_entry(state, uid, nid, "failure",
                               {"child_run": child,
                                "error": "corrupt child outcome: %s" % exc})
            _unlink_quiet(sidecar)
            continue
        outcome = "success" if payload.get("outcome") == "success" \
            else "failure"                        # earned, never defaulted
        outs = payload.get("outputs")
        if isinstance(outs, dict) and outs:
            rel = _node_outputs_rel(state_path, nid)
            path = os.path.join(logdir, os.path.basename(rel))
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(outs, fh)
            os.replace(tmp, path)
        extra = {"child_run": payload.get("run_id", child),
                 "child_outcome": str(payload.get("outcome"))}
        if "error" in payload:
            extra["error"] = str(payload["error"])
        _record_call_entry(state, uid, nid, outcome, extra)
        _unlink_quiet(sidecar)


def _start_call_unit(state_path, state, uid, node):
    """Dispatch a call candidate: RESERVE one budget unit (decision 4 --
    sessions += 1 at START, whatever happens next), then start the child
    (wait:true parks the unit dispatched; wait:false records success NOW).
    Start failures record a named unit failure -- the walk continues on
    failure edges, never crashes (prevention-log #3: a refused call is a
    loud failure, not a skipped node). A RESTART from the sweep (vanished
    child) also passes through here and pays a fresh budget unit --
    deliberate: restarts are dispatches, and the cap is what bounds a
    pathological delete-restart loop."""
    repo = (state.get("run") or {}).get("repo", "")
    nid = node["id"]
    state["sessions"] += 1                       # the cap counts dispatches
    try:
        child_name, _cpath = start_child_run(repo, state_path, state, node)
    except PipelineError as exc:
        _record_call_entry(state, uid, nid, "failure",
                           {"child_run": "", "error": str(exc)})
        return
    if node.get("wait", True):
        state["units"][uid]["status"] = "dispatched"
        state["units"][uid]["child"] = child_name
    else:
        _record_call_entry(state, uid, nid, "success",
                           {"child_run": child_name, "detached": True})


def _pick(state_path, state, n, brief_path_for, journal_path):
    """The dispatch protocol core: returns ("done", outcome-dict),
    ("steps", [step...]) with the chosen units MARKED dispatched (one
    atomic state write), or ("waiting", None) when every dispatched unit
    is a call unit waiting on its child. n is clamped to the doc's
    max_parallel AND the remaining session budget (the run cap can never
    be overshot by a batch -- Codex CP1); call dispatches reserve their
    budget unit before the step budget is computed, so the two channels
    share ONE cap."""
    doc = state["doc"]
    _sweep_call_units(state_path, state)
    cap = doc["caps"]["max_sessions_per_run"]
    if cap - state["sessions"] <= 0 and not _any_dispatched(doc, state):
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
    # Call pass FIRST: reservations land before the step budget is computed
    # (the plan's interleaved loop could overshoot the cap when a call and
    # agent steps shared one frontier -- the old code's cannot-overshoot
    # guarantee is preserved by sequencing the two passes).
    step_candidates = []
    for uid in candidates:
        nid = _expected_node(doc, state, uid)
        node = _node_by_id(doc, nid)
        if node is not None and node.get("type") == "call_pipeline":
            if state["units"][uid]["status"] == "dispatched":
                continue                # waiting on its child (sweep owns it)
            if state["sessions"] >= cap:
                continue                # budget spent: stays pending (dec. 4)
            _start_call_unit(state_path, state, uid, node)
            continue
        step_candidates.append(uid)
    avail = cap - state["sessions"]
    if avail <= 0:
        # The budget is spent -- possibly by a call reservation THIS pass.
        # Only RECLAIM re-emission may proceed (a crashed dispatched unit
        # must never strand); fresh pending units stay pending, and the
        # next _pick entry cap-finishes or waits (CP2: the max(1,..) floor
        # below must never let a pending unit overshoot the cap a call
        # just exhausted).
        step_candidates = [u for u in step_candidates
                           if state["units"][u]["status"] == "dispatched"]
    n_eff = max(1, min(n, int(doc["caps"].get("max_parallel", 1)), avail))
    steps = []
    for uid in step_candidates[:n_eff]:
        steps.append(_prepare_step(state_path, state, uid,
                                   brief_path_for(uid)))
        state["units"][uid]["status"] = "dispatched"
    _atomic_write_json(state_path, state)
    if steps:
        return "steps", steps
    if _any_dispatched(doc, state):
        return "waiting", None
    # every candidate this pass was a call unit that resolved immediately
    # (wait:false or start-failure) -- re-enter for the next frontier; the
    # tail recursion is bounded (each re-entry consumed candidates into
    # terminal states or finishes/waits -- at most len(units) frames)
    return _pick(state_path, state, n, brief_path_for, journal_path)


def next_node(state_path, brief_out, journal_path=""):
    state = _load_state(state_path)
    _guard_in_progress(state, state_path)
    kind, result = _pick(state_path, state, 1, lambda _uid: brief_out,
                         journal_path)
    if kind == "done":
        return result
    if kind == "waiting":
        return {"status": "waiting"}
    return result[0]


def ready_set(state_path, brief_dir, n, journal_path=""):
    """The batch view: up to n steps (clamped), units marked dispatched.
    [] when the run just finished (the finish itself has already happened,
    exactly like next_node's done path); the sentinel string "WAITING" when
    every dispatched unit is a call unit waiting on its child run (Phase C
    -- the CLI is the only non-test consumer and prints it verbatim)."""
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
    if kind == "waiting":
        return "WAITING"
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
    for var in sorted(step.get("secrets") or {}):
        # labels are index names -- non-secret (SD-8)
        print("NODE_SECRET=%s=%s" % (var, step["secrets"][var]))


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
        # start <repo> <name> <state-file> [--lane <l>] [--kind shim|native]
        #       [--event-field k=v ...]
        # default shim = start_run(repo, role): every pre-Phase-B caller
        # unchanged; native = start_run_trigger (trigger-started run).
        # Collect the repeatable --event-field BEFORE _split_opts (it only
        # handles single-valued opts). k is closed to item|sha ('event' is
        # implicit); v charset-gated -- payload fields land in params.
        ev_fields, rest2 = {}, []
        i = 0
        while i < len(rest):
            if rest[i] == "--event-field" and i + 1 < len(rest):
                kv = rest[i + 1]
                k, _, v = kv.partition("=")
                # Per-key gates, byte-parity with _event_native_wakes'
                # supervisor-side checks (prevention-log #6): item is a
                # PR/issue NUMBER, sha is alphanumeric -- a looser CLI
                # charset would let a direct call bypass the resolver's gate.
                ok = (re.match(r"^\d{1,20}$", v) if k == "item"
                      else re.match(r"^[A-Za-z0-9]{1,64}$", v)
                      if k == "sha" else None)
                if not ok:
                    print("pipeline start: bad --event-field %r" % kv,
                          file=sys.stderr)
                    return 2
                if k in ev_fields:
                    # payload mapping is a control boundary: a silent
                    # last-wins on a duplicate field is fail-open (CP1)
                    print("pipeline start: duplicate --event-field %r" % k,
                          file=sys.stderr)
                    return 2
                ev_fields[k] = v
                i += 2
            else:
                rest2.append(rest[i])
                i += 1
        rest = rest2
        opts = {"--lane": "", "--kind": "shim"}
        pos = _split_opts(rest, opts)
        if opts["--kind"] not in ("shim", "native"):
            print("pipeline start: --kind must be shim|native",
                  file=sys.stderr)
            return 2
        if ev_fields and opts["--kind"] != "native":
            print("pipeline start: --event-field requires --kind native",
                  file=sys.stderr)
            return 2
        try:
            if opts["--kind"] == "native":
                state = start_run_trigger(pos[0], pos[1], pos[2],
                                          lane=opts["--lane"],
                                          event_fields=ev_fields or None)
            else:
                state = start_run(pos[0], pos[1], pos[2],
                                  lane=opts["--lane"])
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
        if step["status"] == "waiting":
            print("WAITING")
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
        if steps == "WAITING":
            print("WAITING")
            return 0
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
