# Sequencer P1 — pipeline document + compiler + sequential runner (#345)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pipelines become the engine's dispatch unit: a JSON pipeline document
validates, compiles per-node briefs, and runs sequentially (one node-session per
supervisor iteration) with enforced caps and a run journal carrying trust-ledger
fields; legacy roles auto-wrap as one-node pipelines on the SAME dispatch path.

**Architecture:** New stdlib-only `lib/pipeline.py` owns schema/validate/wrap/
compile/state-machine/journal/ledger behind a `roles.py`-style CLI.
`bin/supervisor.sh` `run_session` swaps its prompt-selection block for a
pipeline-node resolution step; everything else (preflight, adapter contract,
auth, rules compose, invoke, outcome classify) is untouched. Run state lives in
`$LOGDIR/.pipeline-run-<role>.json` (atomic rewrite per node); journal is
append-only `$LOGDIR/journal.jsonl`.

**Tech Stack:** bash 3.2.57, Python 3 stdlib (json/os/re/sys/time), existing
test harnesses (`tests/test_*.sh` check() pattern; `unittest` via run_all.sh).

## Global Constraints

- macOS `/bin/bash` 3.2.57 floor: NO `mapfile`, NO globstar, NO `declare -A`, NO `${var,,}`.
- Python 3 **stdlib only**; config via `lib/config_parser.py`; JSON via `json`.
- Every script's executable body guarded by `[ "${BASH_SOURCE[0]}" = "${0}" ] || return 0` (supervisor.sh already is; pipeline.py uses `if __name__ == "__main__":`).
- `shellcheck -S warning` clean, tests included.
- Fail-safe never fail-open: an unresolvable/invalid pipeline REFUSES the session (rc 2) — NEVER silently falls back to the legacy prompt (prevention-log #3).
- Repo-agnostic `bin/`/`lib/`: pipeline docs live in the target pack (`.autonomy/pipelines/<name>/`); templates may use examples.
- SD-12: one session per supervisor loop iteration — a multi-node run advances one node per iteration via the state file.
- SD-13 precedence: one-shot override > CLI flag > (node runs_as > role model/effort) > agent.* > default. Node values occupy the ROLE_* slot.
- SD-33: `materialize_planner` untouched; the wrap must not alter pair behaviour.
- Prevention-log #1 (`*=*` guard on KEY=value parsing), #6 (re-validate config-sourced strings at point of use), #12 (total readers over journal/verdict data), #17 (total optional-key reads under `set -e` callers), #18 (safe default arm: unknown outcome = failure side).
- Merge activity is never configurable off safe_merge (template briefs must say "merge only via safe_merge" and P1 ships no auto-merge node).
- TDD: failing test first, see it fail, implement, see it pass. Commit per task.

## P1 semantic decisions (locked here, spec v5 §§5-6,9-10)

1. **Execution order = `nodes` array order.** `edges` MUST be `[]` in P1 (validator error otherwise: edges are the P2 dependency walk). Honest fail-safe: never accept-and-ignore a graph feature the runner can't honor.
2. **Containers P1 subset:** `loop` (contiguous children, required `exit_when` string [instructed] + `max_rounds` int 1..99 [ENFORCED]) and `stage` (contiguous children, `runs_as` defaults). `branch` / `for_each` are rejected with a "P2/P5 feature" message.
3. **`context` accepts only `"project"`** (default). `"own"` rejected with a clear P2+ message (an accepted-but-unconsumed toggle would be a dishonest knob).
4. **caps:** `caps.max_sessions_per_run` REQUIRED, int 1..500, enforced by the runner across loop rounds.
5. **Node brief source:** exactly one of `brief_ref` (sibling .md, basename only — no `/`, no `..`) or `legacy_prompt` (repo-relative path; produced by the auto-wrap, allowed in persisted docs but wrap is its only writer in practice).
6. **Loop exit verdict channel:** the compiled brief instructs the agent to write `var/autonomy-logs/.pipeline-verdict.json` (`{"exit": true|false}`). Engine deletes the file before each invoke, reads it after the LAST child of a loop round. Total read (prevention-log #12): anything unreadable/odd-shaped = no-exit → next round until `max_rounds` → run outcome `capped` (S28: clean stop + flag). Missing evidence never exits early (that would be declaring success without evidence).
7. **Run outcomes:** `success` | `failure` (a node errored; P1 on-a-problem = stop run) | `capped` (a cap hit). `usage_limit` is NOT a node outcome: state untouched, same node retries next iteration.
8. **Journal record carries the trust-ledger fields from day one** (v5 §10): assignment identity (`role` + `pipeline` name — trust is per ASSIGNMENT, a rebound role never inherits the old pipeline's record), pipeline version+wrapped, lane, per-node outcomes incl. the loop verdict seen, `pass` bool, sessions count, `merge_affecting` bool. Ledger = pure projection: `auto` at ≥20 completed runs AND pass-rate ≥0.95 over the most recent 20 (rolling window, so §10's decay demotion responds to recent decay), else `watch`. P1 reports the tier (lib+CLI); enforcement (parking merge-affecting terminals) is a later phase — the ledger CLI output is data, nothing consumes it yet.
9. **Resume semantics:** the state file embeds the resolved doc — a run finishes on the doc it started with even if the pack file changes mid-run (snapshot; version recorded in the journal).
10. **Corrupt state file → REFUSE loudly** (log names the path). Never silently delete a run's record. (Doctor surfacing is a later slice.)
11. **P1 inter-node payloads ride git/GitHub** (pushed branch, PR, labels), not an engine channel — briefs instruct re-discovery. Recorded in the template README.
12. **Wrapped roles degrade, bound pipelines are strict.** The auto-wrap drops invalid runs_as values exactly as `resolve_role_dispatch` blanks them (a config that ran yesterday keeps running); a bound pipeline document is a NEW surface — strict validation from birth. Multi-node pipelines on cron/event roles REFUSE in P1 (one node per loop iteration would strand the run between fires; P2 lifts this).
13. **Honesty extends to the type catalog and unknown keys:** activity types whose spec sheet promises engine machinery P1 lacks (`wait_watch`, `ask_human`, `handoff`, `run_command`) are REJECTED with a which-phase message, never run as weaker plain sessions; unknown node/container/document keys are REJECTED, never accepted-and-ignored (a spec-real `on_fail`/`config` must not be a silent no-op). `trigger_default` stays validated-but-informational (P4's assignment consumes it) — the template README says so.

## File Structure

- **Create `lib/pipeline.py`** — everything pipeline: constants, validator, wrap, resolve, compile, state machine (start/next/record), journal append, ledger projection, CLI. One module (mirrors roles.py's one-module convention).
- **Modify `lib/roles.py`** — validate `roles.<r>.pipeline` (non-empty str, `_ROLE_NAME_RE`); expose it in `role_settings` as `"pipeline"`.
- **Modify `bin/supervisor.sh`** — new helpers `pipeline_state_file` / `pipeline_inflight` / `any_pipeline_inflight` / `resolve_pipeline_node` / `record_pipeline_outcome`; `run_session` uses them; fingerprint gate + board-empty gate get in-flight guards.
- **Create `templates/autonomy-pack/pipelines/ticket-to-merge/`** — `pipeline.json`, 7 briefs, `README.md`.
- **Create `tests/test_pipeline.py`** (unittest; registered in run_all.sh) and `tests/test_pipeline_runner.sh` (sources supervisor.sh, stub adapter).
- **Modify `tests/run_all.sh`** — add `tests.test_pipeline` to the explicit python list.
- **Modify `CLAUDE.md`** — layout line for `lib/pipeline.py` + pipelines template dir.

---

### Task 1: `lib/pipeline.py` — schema + validator + `validate` CLI

**Files:**
- Create: `lib/pipeline.py`
- Test: `tests/test_pipeline.py`
- Modify: `tests/run_all.sh` (register the suite)

**Interfaces:**
- Produces: `PipelineError(Exception)`; `load_doc(path) -> dict` (raises `PipelineError`); `validate_doc(doc, pipeline_dir=None) -> list[str]` ([] = valid); constants `NODE_TYPES`, `CONTAINER_KINDS`, `_NAME_RE`; CLI `pipeline.py validate <repo> <name>` (rc 0 valid / 1 invalid, errors on stdout / 2 unreadable).

- [ ] **Step 1: Write the failing tests**

`tests/test_pipeline.py`:

```python
"""Pipeline document (P1) tests: schema validation, wrap, compile, state
machine, journal, ledger. Stdlib only; real module, no mocks."""
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
import pipeline  # noqa: E402


def minimal_doc():
    return {
        "name": "demo", "version": 1,
        "caps": {"max_sessions_per_run": 5},
        "nodes": [{"id": "act", "type": "agent_task", "brief_ref": "act.md"}],
        "edges": [], "containers": [],
    }


class ValidateDocTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        with open(os.path.join(self.dir, "act.md"), "w") as fh:
            fh.write("do the work\n")

    def test_minimal_doc_valid(self):
        self.assertEqual(pipeline.validate_doc(minimal_doc(), self.dir), [])

    def test_not_a_mapping(self):
        self.assertTrue(pipeline.validate_doc([], self.dir))

    def test_bad_name_charset(self):
        doc = minimal_doc(); doc["name"] = "no spaces!"
        self.assertTrue(any("name" in e for e in pipeline.validate_doc(doc, self.dir)))

    def test_missing_caps_rejected(self):
        doc = minimal_doc(); del doc["caps"]
        self.assertTrue(any("caps" in e for e in pipeline.validate_doc(doc, self.dir)))

    def test_cap_out_of_range(self):
        doc = minimal_doc(); doc["caps"]["max_sessions_per_run"] = 0
        self.assertTrue(pipeline.validate_doc(doc, self.dir))
        doc["caps"]["max_sessions_per_run"] = 501
        self.assertTrue(pipeline.validate_doc(doc, self.dir))

    def test_unknown_node_type(self):
        doc = minimal_doc(); doc["nodes"][0]["type"] = "teleport"
        self.assertTrue(any("type" in e for e in pipeline.validate_doc(doc, self.dir)))

    def test_deferred_types_rejected_with_phase_message(self):
        # Types whose spec sheet promises engine machinery P1 lacks must be
        # refused, never run as weaker plain sessions (honesty invariant).
        for t in ("wait_watch", "ask_human", "handoff", "run_command"):
            doc = minimal_doc(); doc["nodes"][0]["type"] = t
            errs = pipeline.validate_doc(doc, self.dir)
            self.assertTrue(any("machinery" in e for e in errs), t)

    def test_unknown_keys_rejected_never_ignored(self):
        doc = minimal_doc(); doc["nodes"][0]["on_fail"] = "retry"
        self.assertTrue(pipeline.validate_doc(doc, self.dir))
        doc = minimal_doc(); doc["config"] = {}
        self.assertTrue(pipeline.validate_doc(doc, self.dir))
        doc = minimal_doc()
        doc["containers"] = [{"id": "c1", "kind": "stage", "children": ["act"],
                              "on_fail": "stop"}]
        self.assertTrue(pipeline.validate_doc(doc, self.dir))

    def test_duplicate_node_id(self):
        doc = minimal_doc()
        doc["nodes"].append(dict(doc["nodes"][0]))
        self.assertTrue(any("duplicate" in e for e in pipeline.validate_doc(doc, self.dir)))

    def test_brief_ref_missing_file(self):
        doc = minimal_doc(); doc["nodes"][0]["brief_ref"] = "ghost.md"
        self.assertTrue(any("ghost.md" in e for e in pipeline.validate_doc(doc, self.dir)))

    def test_brief_ref_traversal_rejected(self):
        for bad in ("../x.md", "a/b.md", "..", ""):
            doc = minimal_doc(); doc["nodes"][0]["brief_ref"] = bad
            self.assertTrue(pipeline.validate_doc(doc, self.dir), bad)

    def test_brief_ref_xor_legacy_prompt(self):
        doc = minimal_doc()
        doc["nodes"][0]["legacy_prompt"] = ".autonomy/loop_prompt.md"
        self.assertTrue(pipeline.validate_doc(doc, self.dir))   # both set
        del doc["nodes"][0]["brief_ref"]
        del doc["nodes"][0]["legacy_prompt"]
        self.assertTrue(pipeline.validate_doc(doc, self.dir))   # neither

    def test_nonempty_edges_rejected_p1(self):
        doc = minimal_doc()
        doc["nodes"].append({"id": "b", "type": "check", "brief_ref": "act.md"})
        doc["edges"] = [{"from": "act", "to": "b", "on": "success"}]
        self.assertTrue(any("P2" in e for e in pipeline.validate_doc(doc, self.dir)))

    def test_context_own_rejected_p1(self):
        doc = minimal_doc(); doc["nodes"][0]["context"] = "own"
        self.assertTrue(pipeline.validate_doc(doc, self.dir))

    def test_loop_container_requires_cap_and_exit(self):
        doc = minimal_doc()
        doc["nodes"].append({"id": "b", "type": "check", "brief_ref": "act.md"})
        doc["containers"] = [{"id": "c1", "kind": "loop", "children": ["act", "b"]}]
        errs = pipeline.validate_doc(doc, self.dir)
        self.assertTrue(any("max_rounds" in e for e in errs))
        self.assertTrue(any("exit_when" in e for e in errs))

    def test_loop_max_rounds_range(self):
        doc = minimal_doc()
        doc["containers"] = [{"id": "c1", "kind": "loop", "children": ["act"],
                              "exit_when": "done", "max_rounds": 100}]
        self.assertTrue(pipeline.validate_doc(doc, self.dir))

    def test_branch_container_rejected_p1(self):
        doc = minimal_doc()
        doc["containers"] = [{"id": "c1", "kind": "branch", "children": ["act"]}]
        self.assertTrue(any("P2" in e or "kind" in e for e in pipeline.validate_doc(doc, self.dir)))

    def test_container_children_must_be_contiguous(self):
        doc = minimal_doc()
        doc["nodes"] = [
            {"id": "a", "type": "pick", "brief_ref": "act.md"},
            {"id": "b", "type": "agent_task", "brief_ref": "act.md"},
            {"id": "c", "type": "check", "brief_ref": "act.md"},
        ]
        doc["containers"] = [{"id": "c1", "kind": "loop", "children": ["a", "c"],
                              "exit_when": "done", "max_rounds": 3}]
        self.assertTrue(any("contiguous" in e for e in pipeline.validate_doc(doc, self.dir)))

    def test_node_in_two_containers_rejected(self):
        doc = minimal_doc()
        doc["containers"] = [
            {"id": "c1", "kind": "loop", "children": ["act"], "exit_when": "d", "max_rounds": 2},
            {"id": "c2", "kind": "stage", "children": ["act"]},
        ]
        self.assertTrue(pipeline.validate_doc(doc, self.dir))

    def test_runs_as_effort_enum(self):
        doc = minimal_doc(); doc["nodes"][0]["runs_as"] = {"effort": "warp9"}
        self.assertTrue(pipeline.validate_doc(doc, self.dir))

    def test_runs_as_agent_charset(self):
        doc = minimal_doc(); doc["nodes"][0]["runs_as"] = {"agent": "../evil"}
        self.assertTrue(pipeline.validate_doc(doc, self.dir))


class LoadDocTest(unittest.TestCase):
    def test_load_missing_raises(self):
        with self.assertRaises(pipeline.PipelineError):
            pipeline.load_doc("/nonexistent/pipeline.json")

    def test_load_bad_json_raises(self):
        d = tempfile.mkdtemp(); self.addCleanup(shutil.rmtree, d, True)
        p = os.path.join(d, "pipeline.json")
        with open(p, "w") as fh:
            fh.write("{nope")
        with self.assertRaises(pipeline.PipelineError):
            pipeline.load_doc(p)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `python3 -m unittest tests.test_pipeline -v 2>&1 | tail -5`
Expected: `ModuleNotFoundError: No module named 'pipeline'` (or ImportError).

- [ ] **Step 3: Implement `lib/pipeline.py` (validator slice)**

```python
#!/usr/bin/env python3
"""Pipeline documents -- P1 of the agentic sequencer (#345).

A pipeline document is JSON (settled decision 2: stdlib only):
  {name, version, trigger_default?, caps{max_sessions_per_run},
   nodes[{id, type, brief_ref | legacy_prompt, runs_as?, context?}],
   edges[], containers[{id, kind: loop|stage, children[], ...}]}

P1 executes nodes in ARRAY ORDER (edges must be []; the typed dependency
walk is P2). The validator REFUSES anything the P1 runner cannot honor --
fail-safe, never accept-and-ignore (prevention-log #3): non-empty edges,
branch/for_each containers, context: own.

CLI (roles.py conventions; rc 0 ok / 1 invalid / 2 unreadable):
  pipeline.py validate <repo> <name>
  pipeline.py wrap <repo> <role>                       (task 2)
  pipeline.py start <repo> <role> <state-file>         (task 4)
  pipeline.py next <state-file> --brief-out <path>     (task 4)
  pipeline.py record <state-file> <node> <outcome> \
      --session-log <p> --verdict <p> --journal <p>    (tasks 4-5)
  pipeline.py ledger <journal-file> <role>             (task 5)
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
    refuse only after a run state exists -- Codex CP1 finding)."""
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
        nid = node.get("id")
        if not (_is_str(nid) and _NAME_RE.match(nid)):
            errors.append("%s: id required, charset [A-Za-z0-9._-]{1,64}" % where)
        elif nid in ids:
            errors.append("%s: duplicate id %r" % (where, nid))
        else:
            ids.append(nid)
        for key in node:
            if key not in _NODE_KEYS:
                # Unknown keys are refused, not ignored: an accepted-and-
                # unconsumed field (a spec-real `on_fail`, `config`) would be
                # a silent no-op the operator believes is live.
                errors.append("%s: key %r is not consumed in P1 -- remove it "
                              "(or it lands with the phase that wires it)"
                              % (where, key))
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
    print("unknown subcommand %r" % cmd, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
```

- [ ] **Step 4: Run tests, verify pass**

Run: `python3 -m unittest tests.test_pipeline -v 2>&1 | tail -3`
Expected: `OK`.

- [ ] **Step 5: Register the suite in run_all.sh**

In `tests/run_all.sh`, add to the explicit python list (alphabetical placement beside its peers):

```bash
python3 -m unittest tests.test_pipeline || fail=1
```

Run: `bash tests/run_all.sh 2>&1 | tail -3` — expected `ALL SUITES PASS`.

- [ ] **Step 6: Commit**

```bash
git add lib/pipeline.py tests/test_pipeline.py tests/run_all.sh
git commit -m "feat(#345): pipeline document schema + P1 validator (rejects what the P1 runner cannot honor)"
```

---

### Task 2: `roles.<r>.pipeline` binding + `wrap_role` + `resolve_pipeline`

**Files:**
- Modify: `lib/roles.py` (validate_roles ~:454-460 area; role_settings ~:809-829)
- Modify: `lib/pipeline.py`
- Test: `tests/test_pipeline.py`, `tests/test_roles.py` (two cases)

**Interfaces:**
- Consumes: `roles._load_config(repo)` (existing, used by roles CLI), `roles.role_settings(config, name) -> dict` (existing; raises KeyError when not dispatchable).
- Produces: `roles.role_settings` gains `"pipeline"` key (str, `''` unset). `pipeline.wrap_role(settings, role) -> dict` (validated one-node doc). `pipeline.resolve_pipeline(repo, role) -> (doc, meta)` where `meta = {"pipeline_dir": str|None, "wrapped": bool, "from": str, "from_version": int}`; raises `PipelineError` on bound-but-invalid (REFUSE — no fallback). CLI `pipeline.py wrap <repo> <role>` prints the resolved doc JSON.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_pipeline.py`:

```python
class WrapResolveTest(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.repo, True)
        os.makedirs(os.path.join(self.repo, ".autonomy", "pipelines", "p1"))
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("engine:\n  label: t\n")
        # resolve_pipeline refuses early when a legacy_prompt is missing
        with open(os.path.join(self.repo, ".autonomy", "loop_prompt.md"), "w") as fh:
            fh.write("legacy prompt\n")

    def _write_pipeline(self, doc, briefs=("act.md",)):
        pdir = os.path.join(self.repo, ".autonomy", "pipelines", "p1")
        for b in briefs:
            with open(os.path.join(pdir, b), "w") as fh:
                fh.write("brief %s\n" % b)
        with open(os.path.join(pdir, "pipeline.json"), "w") as fh:
            json.dump(doc, fh)

    def test_wrap_role_is_valid_one_node_doc(self):
        settings = {"account": "", "agent": "", "model": "opus", "effort": "high",
                    "prompt": "", "scope": "", "pipeline": ""}
        doc = pipeline.wrap_role(settings, "coder")
        self.assertEqual(pipeline.validate_doc(doc, None), [])
        self.assertEqual(len(doc["nodes"]), 1)
        node = doc["nodes"][0]
        self.assertEqual(node["legacy_prompt"], ".autonomy/loop_prompt.md")
        self.assertEqual(node["runs_as"]["model"], "opus")
        self.assertEqual(doc["caps"]["max_sessions_per_run"], 1)
        self.assertTrue(doc.get("wrapped_from_role"), "coder")

    def test_wrap_role_keeps_role_prompt(self):
        settings = {"account": "", "agent": "", "model": "", "effort": "",
                    "prompt": ".autonomy/roles/pm.md", "scope": "", "pipeline": ""}
        doc = pipeline.wrap_role(settings, "pm")
        self.assertEqual(doc["nodes"][0]["legacy_prompt"], ".autonomy/roles/pm.md")

    def test_resolve_unbound_role_wraps(self):
        doc, meta = pipeline.resolve_pipeline(self.repo, "coder")
        self.assertTrue(meta["wrapped"])
        self.assertIsNone(meta["pipeline_dir"])
        self.assertEqual(doc["nodes"][0]["legacy_prompt"], ".autonomy/loop_prompt.md")

    def test_resolve_bound_role_loads_doc(self):
        d = minimal_doc(); d["name"] = "p1"
        self._write_pipeline(d)
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("roles:\n  coder:\n    enabled: true\n    pipeline: p1\n")
        doc, meta = pipeline.resolve_pipeline(self.repo, "coder")
        self.assertFalse(meta["wrapped"])
        self.assertEqual(meta["from"], "p1")
        self.assertEqual(doc["name"], "p1")

    def test_resolve_bound_but_invalid_REFUSES(self):
        d = minimal_doc(); d["name"] = "p1"; del d["caps"]
        self._write_pipeline(d)
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("roles:\n  coder:\n    enabled: true\n    pipeline: p1\n")
        with self.assertRaises(pipeline.PipelineError):
            pipeline.resolve_pipeline(self.repo, "coder")   # NEVER falls back to wrap

    def test_resolve_bound_but_missing_REFUSES(self):
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("roles:\n  coder:\n    enabled: true\n    pipeline: ghost\n")
        with self.assertRaises(pipeline.PipelineError):
            pipeline.resolve_pipeline(self.repo, "coder")

    def test_wrap_degrades_invalid_effort_like_legacy(self):
        # resolve_role_dispatch blanks invalid values and RUNS; the wrap must
        # not turn that degrade into a hard refusal (a config that ran
        # yesterday keeps running after the upgrade).
        settings = {"account": "", "agent": "../evil", "model": "opus",
                    "effort": "warp9", "prompt": "", "scope": "", "pipeline": ""}
        doc = pipeline.wrap_role(settings, "coder")
        self.assertEqual(pipeline.validate_doc(doc, None), [])
        self.assertNotIn("effort", doc["nodes"][0].get("runs_as", {}))
        self.assertNotIn("agent", doc["nodes"][0].get("runs_as", {}))

    def test_resolve_refuses_multinode_on_cron_role(self):
        # P1: one node per LOOP iteration; a cron fire would strand a
        # multi-node run until the next fire -- refuse honestly (P2 lifts).
        d = minimal_doc(); d["name"] = "p1"
        d["nodes"].append({"id": "b", "type": "check", "brief_ref": "act.md"})
        self._write_pipeline(d)
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("roles:\n  pm:\n    enabled: true\n"
                     "    trigger:\n      type: cron\n"
                     "      schedule: '0 * * * *'\n"
                     "    pipeline: p1\n")
        with self.assertRaises(pipeline.PipelineError):
            pipeline.resolve_pipeline(self.repo, "pm")

    def test_resolve_missing_legacy_prompt_REFUSES_early(self):
        # A run state for an unrunnable doc would strand in-flight -- refuse
        # BEFORE any state exists (Codex CP1).
        os.unlink(os.path.join(self.repo, ".autonomy", "loop_prompt.md"))
        with self.assertRaises(pipeline.PipelineError):
            pipeline.resolve_pipeline(self.repo, "coder")

    def test_validator_rejects_escaping_legacy_prompt(self):
        for bad in ("/etc/passwd", "../outside.md", "a//b.md", ""):
            doc = minimal_doc()
            del doc["nodes"][0]["brief_ref"]
            doc["nodes"][0]["legacy_prompt"] = bad
            self.assertTrue(pipeline.validate_doc(doc, None), bad)
```

Add to `tests/test_roles.py` (inside the existing validate/settings test classes, matching local style):

```python
def test_pipeline_binding_validates_charset(self):
    cfg = {"roles": {"coder": {"enabled": True, "pipeline": "../evil"}}}
    self.assertTrue(any("pipeline" in e for e in roles.validate_roles(cfg)))

def test_role_settings_exposes_pipeline(self):
    cfg = {"roles": {"coder": {"enabled": True, "pipeline": "ticket-to-merge"}}}
    self.assertEqual(roles.role_settings(cfg, "coder")["pipeline"],
                     "ticket-to-merge")
```

- [ ] **Step 2: Run, verify failure** — `python3 -m unittest tests.test_pipeline tests.test_roles 2>&1 | tail -3` → FAIL/ERROR (no `wrap_role`, no `pipeline` key).

- [ ] **Step 3: Implement**

`lib/roles.py` — in `validate_roles` beside the `agent/model/effort` block:

```python
        if "pipeline" in cfg:
            pval = cfg.get("pipeline")
            if not _is_nonempty_str(pval) or not _ROLE_NAME_RE.match(
                    str(pval).strip()):
                errors.append("roles.%s: pipeline must be a pipeline name "
                              "(charset [A-Za-z0-9._-]{1,64})" % name)
```

`lib/roles.py` — in `role_settings`, add to the returned dict (same `str(cfg.get(...) or "")` idiom as the existing keys):

```python
        "pipeline": _setting(cfg, "pipeline"),
```

(match the exact existing extraction helper in `role_settings`; if it builds the dict inline, add the key inline.)

`lib/pipeline.py` — append after `validate_doc`:

```python
DEFAULT_PROMPT = ".autonomy/loop_prompt.md"


def wrap_role(settings, role):
    """A legacy role as a one-node pipeline (SD: single dispatch path).
    Byte-equivalence contract: the wrapped node's legacy_prompt is EXACTLY
    the prompt path run_session used before pipelines existed, and invalid
    runs_as values DEGRADE (dropped, like resolve_role_dispatch's blank-and-
    WARN) instead of refusing -- a config that ran yesterday must keep
    running after the upgrade. Bound (non-wrapped) pipelines are a NEW
    surface and stay strict from birth."""
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
    would strand in-flight (Codex CP1 finding)."""
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
    cfg, rc = roles._load_config(repo)      # (config, rc) tuple -- CP1 finding
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
    # P1 advances one node per LOOP iteration (SD-12); a cron/event role's
    # trigger fires run_session once per due-tick, so a multi-node pipeline
    # bound to one would stall mid-run until the next fire. Refuse honestly;
    # P2's dispatch work lifts this (integration-review finding).
    trig_names = set(n for n, _ in (roles.cron_roles(cfg) or []))
    trig_names.update(n for n, _ in (roles.event_roles(cfg) or []))
    # (multi-node check happens after the doc loads, below)
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
    if len(doc.get("nodes") or []) > 1 and role in trig_names:
        raise PipelineError("pipeline %r has %d nodes but role %r fires on a "
                            "cron/event trigger -- P1 advances one node per "
                            "loop iteration, so the run would stall between "
                            "fires; multi-node cron/event dispatch lands in "
                            "P2" % (binding, len(doc["nodes"]), role))
    return doc, {"pipeline_dir": pdir, "wrapped": False,
                 "from": binding, "from_version": doc.get("version", 0)}
```

CLI: add `wrap` arm to `main` (prints `json.dumps(doc, indent=2, sort_keys=True)`; `PipelineError` → message to stderr, rc 1).

NOTE at implementation time: confirm the exact name/signature of `roles._load_config` (referenced at lib/roles.py:919 area) and `role_settings`'s dict construction; adjust the two insertions to match local idiom.

- [ ] **Step 4: Run, verify pass** — `python3 -m unittest tests.test_pipeline tests.test_roles 2>&1 | tail -3` → `OK`.

- [ ] **Step 5: Commit**

```bash
git add lib/pipeline.py lib/roles.py tests/test_pipeline.py tests/test_roles.py
git commit -m "feat(#345): roles.<r>.pipeline binding + legacy auto-wrap + fail-safe resolve (bound-invalid REFUSES, never falls back)"
```

---

### Task 3: compiler — per-node brief composition

**Files:**
- Modify: `lib/pipeline.py`
- Test: `tests/test_pipeline.py`

**Interfaces:**
- Produces: `compile_brief(pipeline_dir, doc, node_id, loop_ctx=None) -> str` where `loop_ctx = {"container": str, "round": int, "max_rounds": int, "exit_when": str} | None`. Raises `PipelineError` on unreadable brief. Legacy nodes never reach it (the runner passes their path through).

- [ ] **Step 1: Failing tests**

```python
class CompileBriefTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        with open(os.path.join(self.dir, "act.md"), "w") as fh:
            fh.write("Do the thing.\n")

    def test_plain_node_brief(self):
        doc = minimal_doc()
        out = pipeline.compile_brief(self.dir, doc, "act")
        self.assertIn("<!-- pipeline:node act (agent_task) -->", out)
        self.assertIn("Do the thing.", out)
        self.assertNotIn("pipeline:loop", out)

    def test_loop_node_brief_carries_round_and_verdict_instructions(self):
        doc = minimal_doc()
        doc["containers"] = [{"id": "c1", "kind": "loop", "children": ["act"],
                              "exit_when": "all tests pass", "max_rounds": 5}]
        ctx = {"container": "c1", "round": 2, "max_rounds": 5,
               "exit_when": "all tests pass",
               "verdict_file": "var/autonomy-logs/.pipeline-run-coder.verdict.json"}
        out = pipeline.compile_brief(self.dir, doc, "act", ctx)
        self.assertIn("round 2 of at most 5", out)
        self.assertIn("all tests pass", out)
        self.assertIn(".pipeline-run-coder.verdict.json", out)
        self.assertIn("enforced by the engine", out)   # honesty tag

    def test_missing_brief_raises(self):
        doc = minimal_doc()
        doc["nodes"][0]["brief_ref"] = "ghost.md"
        with self.assertRaises(pipeline.PipelineError):
            pipeline.compile_brief(self.dir, doc, "act")
```

- [ ] **Step 2: Run, verify fail** — AttributeError: no `compile_brief`.

- [ ] **Step 3: Implement**

```python
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
```

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Commit**

```bash
git add lib/pipeline.py tests/test_pipeline.py
git commit -m "feat(#345): brief compiler -- fenced node sections + honest loop round/verdict footer"
```

---

### Task 4: the sequential state machine — `start` / `next` / `record`

**Files:**
- Modify: `lib/pipeline.py`
- Test: `tests/test_pipeline.py`

**Interfaces:**
- Produces:
  - `start_run(repo, role, state_path, lane="") -> dict` — resolves the pipeline, writes the state file (atomic tmp+`os.replace`), returns the state. `run_id = <role>[--<lane>]-<ts>-<pid>` (pid disambiguates same-second starts). Raises `PipelineError`.
  - `next_node(state_path, brief_out, journal_path="") -> dict` — `{"status": "node", "node": id, "kind": "legacy"|"compiled", "prompt": path, "runs_as": {...effective...}}` (compiled briefs written to `brief_out`; `prompt` == `brief_out` then) or `{"status": "done", "outcome": ...}` — its done paths are stale-state backstops (record finishes runs normally) and journal via `journal_path` so no completed run misses the journal. Raises `PipelineError` on corrupt state (caller REFUSES; never deletes).
  - `record_outcome(state_path, node_id, outcome, session_log="", verdict_path="", journal_path="") -> str` — `"CONTINUE"` or `"DONE <success|failure|capped>"`. The session cap is decided HERE (journal in hand). Deletes the state file when the run finishes. `outcome` ∈ `success`|`error` (usage_limit is never recorded — state untouched, node retries).
  - `_verdict_rel(state_path)` — repo-relative verdict path for the brief footer; the supervisor's `pipeline_verdict_file` derives the same absolute path (one naming rule both sides).
  - CLI arms `start … [--lane <lane>]` (prints `RUN=<id>`), `next <state> --brief-out <p> [--journal <p>]` (prints `NODE=`/`KIND=`/`PROMPT=`/`NODE_MODEL=`/`NODE_EFFORT=`/`NODE_ACCOUNT=`/`NODE_AGENT=` lines, or `DONE <outcome>`), `record` (prints the return string). All: `PipelineError` → stderr + rc 1.
- State file shape:

```json
{"run_id": "coder-20260708T120000", "role": "coder",
 "doc": {}, "meta": {},
 "started": 1751970000, "sessions": 0, "idx": 0,
 "rounds": {}, "nodes_done": [], "status": "in_progress"}
```

- [ ] **Step 1: Failing tests**

```python
class StateMachineTest(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.repo, True)
        self.pdir = os.path.join(self.repo, ".autonomy", "pipelines", "flow")
        os.makedirs(self.pdir)
        with open(os.path.join(self.repo, ".autonomy", "loop_prompt.md"), "w") as fh:
            fh.write("legacy prompt\n")
        for b in ("a.md", "b.md", "c.md"):
            with open(os.path.join(self.pdir, b), "w") as fh:
                fh.write("brief %s\n" % b)
        self.state = os.path.join(self.repo, "state.json")
        self.brief_out = os.path.join(self.repo, "brief.md")
        self.verdict = os.path.join(self.repo, "verdict.json")

    def _bind(self, doc):
        with open(os.path.join(self.pdir, "pipeline.json"), "w") as fh:
            json.dump(doc, fh)
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("roles:\n  coder:\n    enabled: true\n    pipeline: flow\n")

    def _three_node_doc(self):
        return {"name": "flow", "version": 2,
                "caps": {"max_sessions_per_run": 10},
                "nodes": [
                    {"id": "a", "type": "pick", "brief_ref": "a.md"},
                    {"id": "b", "type": "agent_task", "brief_ref": "b.md"},
                    {"id": "c", "type": "summarize", "brief_ref": "c.md"}],
                "edges": [], "containers": []}

    def test_linear_walk_and_completion(self):
        self._bind(self._three_node_doc())
        pipeline.start_run(self.repo, "coder", self.state)
        for expect in ("a", "b", "c"):
            step = pipeline.next_node(self.state, self.brief_out)
            self.assertEqual(step["status"], "node")
            self.assertEqual(step["node"], expect)
            self.assertEqual(step["kind"], "compiled")
            self.assertEqual(step["prompt"], self.brief_out)
            with open(self.brief_out) as fh:
                self.assertIn("brief %s.md" % expect, fh.read())
            res = pipeline.record_outcome(self.state, expect, "success")
            if expect == "c":
                self.assertEqual(res, "DONE success")
            else:
                self.assertEqual(res, "CONTINUE")
        self.assertFalse(os.path.exists(self.state))   # cleaned up on DONE

    def test_usage_limit_means_no_record_same_node_again(self):
        self._bind(self._three_node_doc())
        pipeline.start_run(self.repo, "coder", self.state)
        self.assertEqual(pipeline.next_node(self.state, self.brief_out)["node"], "a")
        # supervisor does NOT call record on usage_limit
        self.assertEqual(pipeline.next_node(self.state, self.brief_out)["node"], "a")

    def test_node_error_fails_the_run(self):
        self._bind(self._three_node_doc())
        pipeline.start_run(self.repo, "coder", self.state)
        pipeline.next_node(self.state, self.brief_out)
        self.assertEqual(pipeline.record_outcome(self.state, "a", "error"),
                         "DONE failure")
        self.assertFalse(os.path.exists(self.state))

    def test_mismatched_node_id_raises(self):
        self._bind(self._three_node_doc())
        pipeline.start_run(self.repo, "coder", self.state)
        pipeline.next_node(self.state, self.brief_out)
        with self.assertRaises(pipeline.PipelineError):
            pipeline.record_outcome(self.state, "c", "success")

    def _loop_doc(self, max_rounds=3):
        return {"name": "flow", "version": 1,
                "caps": {"max_sessions_per_run": 20},
                "nodes": [
                    {"id": "a", "type": "pick", "brief_ref": "a.md"},
                    {"id": "b", "type": "agent_task", "brief_ref": "b.md"},
                    {"id": "c", "type": "check", "brief_ref": "c.md"}],
                "edges": [],
                "containers": [{"id": "L", "kind": "loop",
                                "children": ["b", "c"],
                                "exit_when": "done", "max_rounds": max_rounds}]}

    def _run_round(self, nodes):
        for n in nodes:
            step = pipeline.next_node(self.state, self.brief_out)
            self.assertEqual(step["node"], n)
            res = pipeline.record_outcome(self.state, n, "success",
                                          verdict_path=self.verdict)
        return res

    def test_loop_repeats_until_verdict_exit(self):
        self._bind(self._loop_doc())
        pipeline.start_run(self.repo, "coder", self.state)
        self.assertEqual(self._run_round(["a"]), "CONTINUE")
        self.assertEqual(self._run_round(["b", "c"]), "CONTINUE")   # round 1, no verdict
        with open(self.verdict, "w") as fh:
            json.dump({"exit": True}, fh)
        # round 2: verdict read after last child -> exits loop, run continues past it
        self.assertEqual(self._run_round(["b", "c"]), "DONE success")

    def test_loop_verdict_garbage_is_no_exit(self):
        self._bind(self._loop_doc(max_rounds=2))
        pipeline.start_run(self.repo, "coder", self.state)
        self._run_round(["a"])
        with open(self.verdict, "w") as fh:
            fh.write("not json {{{")
        self._run_round(["b", "c"])                      # garbage -> round 2
        with open(self.verdict, "w") as fh:
            fh.write("not json {{{")
        self.assertEqual(self._run_round(["b", "c"]), "DONE capped")  # cap floor

    def test_loop_round_ctx_in_brief(self):
        self._bind(self._loop_doc())
        pipeline.start_run(self.repo, "coder", self.state)
        self._run_round(["a"])
        pipeline.next_node(self.state, self.brief_out)
        with open(self.brief_out) as fh:
            self.assertIn("round 1 of at most 3", fh.read())

    def test_session_cap_finishes_capped_at_record_time(self):
        # The cap decision happens in record_outcome (which holds the journal
        # path) -- deciding it in next_node would lose the run's journal line.
        doc = self._loop_doc(max_rounds=99)
        doc["caps"]["max_sessions_per_run"] = 3
        self._bind(doc)
        pipeline.start_run(self.repo, "coder", self.state)
        self.assertEqual(self._run_round(["a"]), "CONTINUE")
        self.assertEqual(self._run_round(["b", "c"]), "DONE capped")  # 3rd session
        self.assertFalse(os.path.exists(self.state))

    def test_wrapped_role_state_machine_passthrough(self):
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("engine:\n  label: t\n")
        pipeline.start_run(self.repo, "coder", self.state)
        step = pipeline.next_node(self.state, self.brief_out)
        self.assertEqual(step["kind"], "legacy")
        self.assertEqual(step["prompt"], ".autonomy/loop_prompt.md")
        self.assertFalse(os.path.exists(self.brief_out))   # no compile for legacy
        self.assertEqual(pipeline.record_outcome(self.state, "act", "success"),
                         "DONE success")

    def test_corrupt_state_raises_never_deletes(self):
        with open(self.state, "w") as fh:
            fh.write("garbage")
        with self.assertRaises(pipeline.PipelineError):
            pipeline.next_node(self.state, self.brief_out)
        self.assertTrue(os.path.exists(self.state))
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement** (append to `lib/pipeline.py`)

```python
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
    return state


def start_run(repo, role, state_path, lane=""):
    doc, meta = resolve_pipeline(repo, role)
    # run_id: role[-lane]-timestamp-pid -- pid disambiguates same-second
    # starts across lanes/tests (Codex CP1: second-granularity ids collide,
    # weakening the trust-ledger identity field).
    ident = "%s--%s" % (role, lane) if lane else role
    state = {"run_id": "%s-%s-%d" % (ident, time.strftime("%Y%m%dT%H%M%S"),
                                     os.getpid()),
             "role": role, "lane": lane, "doc": doc, "meta": meta,
             "started": int(time.time()), "sessions": 0, "idx": 0,
             "rounds": {}, "nodes_done": [], "status": "in_progress"}
    _atomic_write_json(state_path, state)
    return state


def _container_of(doc, node_id):
    for con in doc.get("containers", []):
        if node_id in (con.get("children") or []):
            return con
    return None


def _effective_runs_as(doc, node):
    con = _container_of(doc, node["id"])
    merged = {}
    if con is not None and con.get("kind") == "stage":
        merged.update(con.get("runs_as") or {})
    merged.update(node.get("runs_as") or {})
    return merged


def _verdict_rel(state_path):
    """The verdict file's repo-relative path for the compiled brief: LOGDIR
    is always <repo>/var/autonomy-logs, and the supervisor derives the SAME
    absolute path via pipeline_verdict_file (state path minus .json plus
    .verdict.json) -- one naming rule on both sides, lane-safe."""
    base = os.path.basename(state_path)
    if base.endswith(".json"):
        base = base[:-len(".json")]
    return "var/autonomy-logs/%s.verdict.json" % base


def _loop_ctx(state, node, state_path):
    con = _container_of(state["doc"], node["id"])
    if con is None or con.get("kind") != "loop":
        return None
    return {"container": con["id"],
            "round": int(state["rounds"].get(con["id"], 1)),
            "max_rounds": con["max_rounds"],
            "exit_when": con["exit_when"],
            "verdict_file": _verdict_rel(state_path)}


def next_node(state_path, brief_out, journal_path=""):
    state = _load_state(state_path)
    doc = state["doc"]
    nodes = doc["nodes"]
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
    # Backstop for a stale idx-past-end state (record_outcome normally
    # finishes runs) -- takes journal_path so no completed run ever slips
    # out of the journal (Codex CP1 finding).
    if state["idx"] >= len(nodes):
        return _finish(state, state_path, "success", journal_path)
    cap = doc["caps"]["max_sessions_per_run"]
    if state["sessions"] >= cap:
        return _finish(state, state_path, "capped", journal_path)
    node = nodes[state["idx"]]
    if node.get("legacy_prompt"):
        kind, prompt = "legacy", node["legacy_prompt"]
    else:
        pdir = (state.get("meta") or {}).get("pipeline_dir")
        text = compile_brief(pdir, doc, node["id"],
                             _loop_ctx(state, node, state_path))
        with open(brief_out, "w") as fh:
            fh.write(text)
        kind, prompt = "compiled", brief_out
    return {"status": "node", "node": node["id"], "kind": kind,
            "prompt": prompt, "runs_as": _effective_runs_as(doc, node)}


def _read_verdict(verdict_path):
    """Total (prevention-log #12): any unreadable/odd shape = no exit.
    Missing evidence never exits a loop early -- that would declare the exit
    condition met without evidence (fail-open). The max_rounds cap is the
    floor under a persistently absent verdict."""
    if not verdict_path:
        return False
    try:
        with open(verdict_path) as fh:
            verdict = json.load(fh)
    except (OSError, ValueError):
        return False
    return isinstance(verdict, dict) and verdict.get("exit") is True


def _finish(state, state_path, outcome, journal_path):
    state["status"] = "done"
    state["outcome"] = outcome
    if journal_path:
        _journal_append(journal_path, state)      # task 5 (no-op stub until then)
    try:
        os.unlink(state_path)
    except OSError:
        # Persist the DONE marker: a swallowed unlink failure would leave an
        # in_progress state on disk -> the last node re-runs and the journal
        # gets a duplicate line. With the marker, next_node refuses loudly.
        try:
            _atomic_write_json(state_path, state)
        except OSError:
            pass
    return {"status": "done", "outcome": outcome}


def record_outcome(state_path, node_id, outcome, session_log="",
                   verdict_path="", journal_path=""):
    if outcome not in ("success", "error"):
        raise PipelineError("unrecordable outcome %r (usage_limit retries the "
                            "node; only success/error are recorded)" % outcome)
    state = _load_state(state_path)
    doc = state["doc"]
    nodes = doc["nodes"]
    if state["idx"] >= len(nodes) or nodes[state["idx"]]["id"] != node_id:
        raise PipelineError("record for node %r but the run's current node is "
                            "%r -- refusing (corrupt driver?)"
                            % (node_id, nodes[state["idx"]]["id"]
                               if state["idx"] < len(nodes) else None))
    node = nodes[state["idx"]]
    con = _container_of(doc, node_id)
    entry = {"id": node_id, "type": node.get("type"), "outcome": outcome,
             "session_log": os.path.basename(session_log) if session_log else ""}
    if con is not None and con.get("kind") == "loop":
        entry["round"] = int(state["rounds"].get(con["id"], 1))
        if node_id == con["children"][-1]:
            # v5 §6: the structured verdict is part of the run journal, not
            # just a control signal -- record what the exit decision saw.
            entry["verdict_exit"] = _read_verdict(verdict_path)
    state["nodes_done"].append(entry)
    state["sessions"] += 1
    if outcome == "error":
        res = _finish(state, state_path, "failure", journal_path)
        return "DONE %s" % res["outcome"]
    # success: advance
    last_child_of_loop = (con is not None and con.get("kind") == "loop"
                          and node_id == con["children"][-1])
    if last_child_of_loop:
        if _read_verdict(verdict_path):
            state["idx"] += 1                              # exit the loop
        else:
            rnd = int(state["rounds"].get(con["id"], 1))
            if rnd >= con["max_rounds"]:
                res = _finish(state, state_path, "capped", journal_path)
                return "DONE %s" % res["outcome"]
            state["rounds"][con["id"]] = rnd + 1
            first = con["children"][0]
            state["idx"] = [n["id"] for n in nodes].index(first)
    else:
        state["idx"] += 1
    if state["idx"] >= len(nodes):
        res = _finish(state, state_path, "success", journal_path)
        return "DONE %s" % res["outcome"]
    if state["sessions"] >= doc["caps"]["max_sessions_per_run"]:
        # Cap decided HERE (record holds the journal path) -- deciding it in
        # next_node would lose the run's journal line. next_node's own cap
        # check remains as a journal-less backstop for stale states only.
        res = _finish(state, state_path, "capped", journal_path)
        return "DONE %s" % res["outcome"]
    _atomic_write_json(state_path, state)
    return "CONTINUE"
```

Until task 5, add the stub `def _journal_append(journal_path, state): pass` with a `# replaced in task 5` note. Add CLI arms:

```python
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
        print("NODE=%s" % step["node"])
        print("KIND=%s" % step["kind"])
        print("PROMPT=%s" % step["prompt"])
        runs_as = step.get("runs_as") or {}
        for key in ("model", "effort", "account", "agent"):
            if runs_as.get(key):
                print("NODE_%s=%s" % (key.upper(), runs_as[key]))
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
```

- [ ] **Step 4: Run, verify pass** — full `python3 -m unittest tests.test_pipeline -v`.

- [ ] **Step 5: Commit**

```bash
git add lib/pipeline.py tests/test_pipeline.py
git commit -m "feat(#345): sequential run state machine -- one node per call, enforced loop rounds + session cap, verdict-file loop exit (total reader)"
```

---

### Task 5: run journal + trust-ledger projection

**Files:**
- Modify: `lib/pipeline.py` (real `_journal_append`, `ledger`, CLI arm)
- Test: `tests/test_pipeline.py`

**Interfaces:**
- Produces: journal line (one JSON object per line, single `write()` of line+`\n` appended to `journal_path`):

```json
{"run_id": "...", "role": "coder", "pipeline": "flow", "pipeline_version": 2,
 "wrapped": false, "outcome": "success", "pass": true,
 "started": 1751970000, "finished": 1751970900, "sessions": 3,
 "nodes": [{"id": "a", "type": "pick", "outcome": "success",
            "session_log": "session-x.log"}],
 "merge_affecting": false}
```

- `ledger(journal_path, role) -> {"runs": int, "passes": int, "tier": "watch"|"auto"}` — total reader; `auto` iff runs ≥ 20 and passes/runs ≥ 0.95. CLI `ledger <journal> <role>` prints `runs=N passes=N tier=T`.

- [ ] **Step 1: Failing tests**

```python
class JournalLedgerTest(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.repo, True)
        os.makedirs(os.path.join(self.repo, ".autonomy"))
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("engine:\n  label: t\n")   # no roles block -> coder wraps
        with open(os.path.join(self.repo, ".autonomy", "loop_prompt.md"), "w") as fh:
            fh.write("legacy prompt\n")
        self.state = os.path.join(self.repo, "state.json")
        self.journal = os.path.join(self.repo, "journal.jsonl")

    def _finish_wrapped_run(self, outcome="success"):
        pipeline.start_run(self.repo, "coder", self.state)
        pipeline.next_node(self.state, os.path.join(self.repo, "brief.md"))
        pipeline.record_outcome(self.state, "act",
                                "success" if outcome == "success" else "error",
                                session_log="/x/session-1.log",
                                journal_path=self.journal)

    def test_done_run_appends_journal_line_with_trust_fields(self):
        self._finish_wrapped_run()
        with open(self.journal) as fh:
            lines = fh.read().splitlines()
        self.assertEqual(len(lines), 1)
        rec = json.loads(lines[0])
        self.assertEqual(rec["role"], "coder")
        self.assertEqual(rec["pipeline"], "legacy-coder")
        self.assertTrue(rec["wrapped"])
        self.assertEqual(rec["outcome"], "success")
        self.assertIs(rec["pass"], True)
        self.assertEqual(rec["sessions"], 1)
        self.assertEqual(rec["nodes"][0]["session_log"], "session-1.log")
        self.assertIn("merge_affecting", rec)
        self.assertIsInstance(rec["started"], int)
        self.assertIsInstance(rec["finished"], int)

    def test_failure_run_pass_false(self):
        self._finish_wrapped_run(outcome="error")
        rec = json.loads(open(self.journal).read().splitlines()[0])
        self.assertEqual(rec["outcome"], "failure")
        self.assertIs(rec["pass"], False)

    def _write_journal(self, role, n_pass, n_fail):
        with open(self.journal, "a") as fh:
            for i in range(n_pass):
                fh.write(json.dumps({"role": role, "outcome": "success",
                                     "pass": True}) + "\n")
            for i in range(n_fail):
                fh.write(json.dumps({"role": role, "outcome": "failure",
                                     "pass": False}) + "\n")

    def test_ledger_watch_below_20_runs(self):
        self._write_journal("coder", 19, 0)
        self.assertEqual(pipeline.ledger(self.journal, "coder")["tier"], "watch")

    def test_ledger_auto_at_20_runs_95pct(self):
        self._write_journal("coder", 19, 1)
        led = pipeline.ledger(self.journal, "coder")
        self.assertEqual((led["runs"], led["passes"], led["tier"]),
                         (20, 19, "auto"))

    def test_ledger_demotes_below_95(self):
        self._write_journal("coder", 18, 2)
        self.assertEqual(pipeline.ledger(self.journal, "coder")["tier"], "watch")

    def test_ledger_total_reader_skips_junk(self):
        with open(self.journal, "w") as fh:
            fh.write("garbage line\n")
            fh.write(json.dumps(["not", "a", "dict"]) + "\n")
            fh.write(json.dumps({"role": "coder", "outcome": "success",
                                 "pass": True}) + "\n")
        led = pipeline.ledger(self.journal, "coder")
        self.assertEqual((led["runs"], led["passes"]), (1, 1))

    def test_ledger_missing_journal_is_watch_zero(self):
        self.assertEqual(pipeline.ledger("/nope/journal.jsonl", "coder"),
                         {"runs": 0, "passes": 0, "tier": "watch"})

    def test_ledger_filters_by_role(self):
        self._write_journal("coder", 25, 0)
        self._write_journal("pm", 1, 5)
        self.assertEqual(pipeline.ledger(self.journal, "coder")["tier"], "auto")
        self.assertEqual(pipeline.ledger(self.journal, "pm")["tier"], "watch")

    def test_ledger_scopes_to_assignment_not_role(self):
        # v5 §10: trust is earned per ASSIGNMENT -- rebinding a role to a new
        # pipeline must not inherit the old pipeline's record.
        with open(self.journal, "a") as fh:
            for _ in range(25):
                fh.write(json.dumps({"role": "coder", "pipeline": "old-flow",
                                     "outcome": "success", "pass": True}) + "\n")
        led = pipeline.ledger(self.journal, "coder", pipeline_name="new-flow")
        self.assertEqual((led["runs"], led["tier"]), (0, "watch"))
        led = pipeline.ledger(self.journal, "coder", pipeline_name="old-flow")
        self.assertEqual(led["tier"], "auto")

    def test_ledger_windowed_demotion(self):
        # 30 passes then 2 recent failures: lifetime 30/32 ~= 0.94 would stay
        # auto under a lifetime rate at 0.9375 < 0.95 anyway -- use a starker
        # case: 40 passes then 2 failures = lifetime 40/42 ~= 0.952 (>=0.95)
        # but the last-20 window is 18/20 = 0.90 -> demoted. §10's decay
        # demotion must respond to RECENT decay.
        self._write_journal("coder", 40, 0)
        self._write_journal("coder", 0, 2)
        self.assertEqual(pipeline.ledger(self.journal, "coder")["tier"], "watch")
```

(Fix the setUp to plainly `os.makedirs(os.path.join(self.repo, ".autonomy"))` + write `config.yaml` — same as StateMachineTest's unbound variant.)

- [ ] **Step 2: Run, verify fail** (journal file never written; no `ledger`).

- [ ] **Step 3: Implement** — replace the `_journal_append` stub:

```python
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
```

CLI arm:

```python
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
```

- [ ] **Step 4: Run, verify pass** — full suite again.

- [ ] **Step 5: Commit**

```bash
git add lib/pipeline.py tests/test_pipeline.py
git commit -m "feat(#345): run journal (trust-ledger fields from day one) + watch/auto tier projection (>=20 runs, >=95% pass)"
```

---

### Task 6: supervisor wiring — single dispatch path through the pipeline runner

**Files:**
- Modify: `bin/supervisor.sh` (new helpers near `resolve_role_dispatch` ~:1019; `run_session` :1169-1285; fingerprint gate ~:1453-1464; board-empty gate ~:1421-1427)
- Test: `tests/test_pipeline_runner.sh` (new; sources supervisor.sh, stub adapter dir)

**Interfaces:**
- Consumes: `pipeline.py start/next/record` CLI (task 4-5), existing `resolve_role_dispatch`, `valid_prompt_path`, `valid_model_id`, `valid_effort`, `compose_session_rules`, `invoke_scoped_env`, adapter contract.
- Produces: bash functions `pipeline_state_file <role>`, `pipeline_inflight <role>` (rc 0 = state file exists), `any_pipeline_inflight` (rc 0 = any), `resolve_pipeline_node <role>` (sets `PIPE_NODE PIPE_KIND PIPE_PROMPT PIPE_DONE`, may override `ROLE_MODEL/ROLE_EFFORT/ROLE_ACCOUNT/ROLE_AGENT`; rc 1 = REFUSE), `record_pipeline_outcome <role> <node> <outcome> <session_log>`.

- [ ] **Step 1: Write the failing test**

`tests/test_pipeline_runner.sh` (pattern of `tests/test_headless_dispatch.sh`: `set -uo pipefail`, source supervisor, silence `log`, mktemp repo, `check()` helper):

```bash
#!/bin/bash
# Pipeline runner wiring (#345): run_session drives lib/pipeline.py --
# wrapped legacy roles byte-equivalent, bound pipelines walk one node per
# call, invalid bindings REFUSE, usage_limit retries, journal written.
set -uo pipefail
ENGINE_HOME="$(cd "$(dirname "$0")/.." && pwd)"
export ENGINE_HOME

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "ok   - $1"
  else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails+1)); fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# --- fake target repo pack -------------------------------------------------
repo="$tmp/repo"
mkdir -p "$repo/.autonomy/pipelines/flow" "$repo/var/autonomy-logs"
printf 'engine:\n  label: t\n' >"$repo/.autonomy/config.yaml"
printf 'LEGACY PROMPT BODY\n' >"$repo/.autonomy/loop_prompt.md"
printf 'hard rules\n' >"$repo/.autonomy/hard_rules.md"
( cd "$repo" && git init -q && git add -A && git commit -qm init )

# --- stub adapter: records its argv, emits configured outcome ---------------
agents="$tmp/agents"
mkdir -p "$agents"
cat >"$agents/stub.sh" <<'EOF'
agent_invoke() {
  printf '%s\n' "$1" >"${STUB_CALLS:?}/prompt_file"
  printf '%s\n' "$2" >"${STUB_CALLS}/rules_file"
  [ -n "${STUB_VERDICT:-}" ] && printf '%s' "$STUB_VERDICT" >"${STUB_VERDICT_PATH:?}"
  return 0
}
agent_classify_outcome() { printf '%s' "${STUB_OUTCOME:-success}"; }
EOF
export AUTONOMY_AGENTS_DIR="$agents"
export STUB_CALLS="$tmp/calls"; mkdir -p "$STUB_CALLS"

# --- source the real supervisor ---------------------------------------------
# shellcheck source=/dev/null
source "$ENGINE_HOME/bin/supervisor.sh"
AUTONOMY_TARGET_REPO="$repo"
VARDIR="$repo/var"; LOGDIR="$VARDIR/autonomy-logs"
SUPLOG=/dev/null
log() { :; }
heartbeat() { :; }
preflight() { return 0; }
materialize_planner() { :; }
resolve_session_settings() { MODEL=test-model; FALLBACK_MODEL=test-fb; EFFORT=""; }
resolve_role_credential() { printf ''; }
compute_limit_wait() { return 1; }   # no active limit window in these tests
RESET_STATE=/dev/null                # set -u safety: normally set in the main guard
AGENT_TYPE=stub

# 1. wrapped legacy role: same prompt file as the pre-pipeline engine --------
run_session coder; rc=$?
check "wrapped run_session rc" "0" "$rc"
check "wrapped prompt byte-path equivalence" "$repo/.autonomy/loop_prompt.md" \
  "$(cat "$STUB_CALLS/prompt_file")"
check "state cleaned after 1-node run" "1" \
  "$([ ! -f "$(pipeline_state_file coder)" ] && echo 1 || echo 0)"
jl="$(wc -l <"$LOGDIR/journal.jsonl" | tr -d ' ')"
check "journal has one line" "1" "$jl"
check "journal pass true" "1" \
  "$(grep -c '"pass": true' "$LOGDIR/journal.jsonl")"

# 2. bound two-node pipeline: one node per run_session call -------------------
cat >"$repo/.autonomy/pipelines/flow/pipeline.json" <<'EOF'
{"name": "flow", "version": 1, "caps": {"max_sessions_per_run": 5},
 "nodes": [{"id": "a", "type": "pick", "brief_ref": "a.md"},
           {"id": "b", "type": "summarize", "brief_ref": "b.md"}],
 "edges": [], "containers": []}
EOF
printf 'BRIEF A\n' >"$repo/.autonomy/pipelines/flow/a.md"
printf 'BRIEF B\n' >"$repo/.autonomy/pipelines/flow/b.md"
printf 'roles:\n  coder:\n    enabled: true\n    pipeline: flow\n' \
  >"$repo/.autonomy/config.yaml"

run_session coder; rc=$?
check "bound node-a rc" "0" "$rc"
check "node-a compiled brief used" "$LOGDIR/.pipeline-run-coder.brief.md" \
  "$(cat "$STUB_CALLS/prompt_file")"
check "brief carries node a body" "1" \
  "$(grep -c 'BRIEF A' "$LOGDIR/.pipeline-run-coder.brief.md")"
check "state persists mid-run" "1" \
  "$([ -f "$(pipeline_state_file coder)" ] && echo 1 || echo 0)"
check "pipeline_inflight sees it" "0" "$(pipeline_inflight coder; echo $?)"
check "any_pipeline_inflight sees it" "0" "$(any_pipeline_inflight; echo $?)"

run_session coder; rc=$?
check "bound node-b rc" "0" "$rc"
check "brief carries node b body" "1" \
  "$(grep -c 'BRIEF B' "$LOGDIR/.pipeline-run-coder.brief.md")"
check "state cleaned after final node" "1" \
  "$([ ! -f "$(pipeline_state_file coder)" ] && echo 1 || echo 0)"
check "journal now two lines" "2" "$(wc -l <"$LOGDIR/journal.jsonl" | tr -d ' ')"

# 3. usage_limit: state intact, no record, same node next time ----------------
run_session coder >/dev/null 2>&1   # starts a fresh run, executes node a
STUB_OUTCOME="usage_limit" run_session coder >/dev/null 2>&1; rc=$?
check "usage_limit rc 3" "3" "$rc"
check "usage_limit leaves state intact" "1" \
  "$([ -f "$(pipeline_state_file coder)" ] && echo 1 || echo 0)"
check "journal unchanged on usage_limit" "2" \
  "$(wc -l <"$LOGDIR/journal.jsonl" | tr -d ' ')"
rm -f "$(pipeline_state_file coder)"   # reset for the next scenario

# 4. adapter error: run fails, journal pass=false, state cleaned --------------
STUB_OUTCOME="error" run_session coder >/dev/null 2>&1
check "error run journals pass=false" "1" \
  "$(grep -c '"pass": false' "$LOGDIR/journal.jsonl")"
check "error run cleans state" "1" \
  "$([ ! -f "$(pipeline_state_file coder)" ] && echo 1 || echo 0)"

# 5. bound-but-invalid pipeline REFUSES (rc 2), nothing invoked ----------------
printf 'roles:\n  coder:\n    enabled: true\n    pipeline: ghost\n' \
  >"$repo/.autonomy/config.yaml"
rm -f "$STUB_CALLS/prompt_file"
run_session coder >/dev/null 2>&1; rc=$?
check "invalid binding rc 2 (REFUSE, no legacy fallback)" "2" "$rc"
check "invalid binding never invoked the agent" "1" \
  "$([ ! -f "$STUB_CALLS/prompt_file" ] && echo 1 || echo 0)"

# 6. no state -> helpers report not-inflight ----------------------------------
check "pipeline_inflight none" "1" "$(pipeline_inflight coder; echo $?)"
check "any_pipeline_inflight none" "1" "$(any_pipeline_inflight; echo $?)"

echo
[ "$fails" -eq 0 ] && { echo "ALL CHECKS PASS"; exit 0; }
echo "$fails CHECK(S) FAILED"; exit 1
```

Adjust scenario 3's ordering at implementation time if `run_session`'s local stubbing needs env passed differently (`STUB_OUTCOME=... run_session` works because the stub reads it at call time). Scenario 1 note: `resolve_session_settings` is stubbed, so SD-13 precedence itself is out of scope here (covered by existing tests); this file proves the PIPELINE path.

- [ ] **Step 2: Run, verify fail** — `bash tests/test_pipeline_runner.sh` → FAILs (`pipeline_state_file: command not found`, prompt mismatch).

- [ ] **Step 3: Implement in `bin/supervisor.sh`**

(a) Helpers after `compose_session_rules` (~:1092):

```bash
# --- pipeline runner (P1, #345) ---------------------------------------------
# One dispatch path: every role runs THROUGH lib/pipeline.py -- a role with a
# `pipeline:` binding walks its document one node-session per iteration
# (settled decision 12); a role without one auto-wraps as a one-node pipeline
# whose prompt path is byte-identical to the legacy engine's. A bound-but-
# missing/invalid pipeline REFUSES the session -- never a silent fallback to
# the legacy prompt (prevention-log #3: a fallback would silently change what
# the operator configured).
# Lane-scoped like fingerprint_state_file (Codex CP1: one supervisor per
# lane shares LOGDIR -- an unscoped state file would let two lanes advance
# or corrupt each other's runs). Same [--<lane>] suffix convention.
pipeline_state_file() {
  local role="$1" lane="${AUTONOMY_LANE:-}"
  if [ -n "$lane" ]; then
    printf '%s/.pipeline-run-%s--%s.json' "$LOGDIR" "$role" "$lane"
  else
    printf '%s/.pipeline-run-%s.json' "$LOGDIR" "$role"
  fi
}

# The verdict file derives from the state path -- one derivation, lane-safe
# for free. pipeline.py derives the SAME repo-relative name for the compiled
# brief's instruction (var/autonomy-logs/<state-basename> minus .json plus
# .verdict.json), so the agent writes exactly the file the engine reads.
pipeline_verdict_file() {
  local state; state="$(pipeline_state_file "$1")"
  printf '%s.verdict.json' "${state%.json}"
}

pipeline_inflight() { [ -f "$(pipeline_state_file "$1")" ]; }

any_pipeline_inflight() {
  local f
  for f in "$LOGDIR"/.pipeline-run-*.json; do
    [ -f "$f" ] && return 0
  done
  return 1
}

# Resolve the role's CURRENT pipeline node into PIPE_* globals; start a run
# when none is in flight. Node runs_as values override the ROLE_* slot
# (SD-13: they sit where the role's own model/effort sat; one-shot override
# and CLI flags still win later in resolve_session_settings). Every value is
# re-validated here before it can land in argv or a source path
# (prevention-log #6). rc 1 = REFUSE.
resolve_pipeline_node() {
  local role="$1" state brief out line key val
  PIPE_NODE=""; PIPE_KIND=""; PIPE_PROMPT=""; PIPE_DONE=0
  state="$(pipeline_state_file "$role")"
  if [ ! -f "$state" ]; then
    if [ -n "${AUTONOMY_LANE:-}" ]; then
      python3 "$ENGINE_HOME/lib/pipeline.py" start \
        "$AUTONOMY_TARGET_REPO" "$role" "$state" \
        --lane "$AUTONOMY_LANE" >>"$SUPLOG" 2>&1 || return 1
    else
      python3 "$ENGINE_HOME/lib/pipeline.py" start \
        "$AUTONOMY_TARGET_REPO" "$role" "$state" >>"$SUPLOG" 2>&1 || return 1
    fi
  fi
  brief="${state%.json}.brief.md"
  if ! out="$(python3 "$ENGINE_HOME/lib/pipeline.py" next "$state" \
      --brief-out "$brief" --journal "$LOGDIR/journal.jsonl" 2>>"$SUPLOG")"; then
    return 1
  fi
  case "$out" in
    DONE*) PIPE_DONE=1; return 0 ;;
  esac
  while IFS= read -r line; do
    case "$line" in *=*) ;; *) continue ;; esac
    key="${line%%=*}"; val="${line#*=}"
    case "$key" in
      NODE)   PIPE_NODE="$val" ;;
      KIND)   PIPE_KIND="$val" ;;
      PROMPT) PIPE_PROMPT="$val" ;;
      NODE_MODEL)
        if valid_model_id "$val"; then ROLE_MODEL="$val"
        else log "WARN pipeline node model invalid -- ignored"; fi ;;
      NODE_EFFORT)
        if valid_effort "$val"; then ROLE_EFFORT="$val"
        else log "WARN pipeline node effort invalid -- ignored"; fi ;;
      NODE_ACCOUNT)
        # prevention-log #6: account names land in accounts.py argv --
        # charset-gate at the point of use like agent/model/effort.
        case "$val" in
          *[!A-Za-z0-9._-]*) log "WARN pipeline node account invalid chars -- ignored" ;;
          "") ;;
          *) ROLE_ACCOUNT="$val" ;;
        esac ;;
      NODE_AGENT)
        case "$val" in
          *[!A-Za-z0-9_-]*) log "WARN pipeline node agent invalid chars -- ignored" ;;
          "") ;;
          *) ROLE_AGENT="$val" ;;
        esac ;;
    esac
  done <<EOF
$out
EOF
  [ -n "$PIPE_NODE" ] || return 1
  case "$PIPE_KIND" in
    legacy)
      if ! valid_prompt_path "$PIPE_PROMPT"; then
        log "pipeline: node prompt path '$PIPE_PROMPT' is absolute or escapes the pack -- REFUSING"
        return 1
      fi
      PIPE_PROMPT="$AUTONOMY_TARGET_REPO/$PIPE_PROMPT" ;;
    compiled)
      # The compiled brief must be exactly the file we asked pipeline.py to
      # write -- anything else in this slot is a forged path (fail-safe).
      [ "$PIPE_PROMPT" = "$brief" ] || {
        log "pipeline: compiled brief path mismatch -- REFUSING"; return 1; } ;;
    *)
      log "pipeline: unknown node kind '$PIPE_KIND' -- REFUSING"; return 1 ;;
  esac
  [ -f "$PIPE_PROMPT" ] || {
    log "pipeline: node prompt file missing ($PIPE_PROMPT) -- REFUSING"
    return 1; }
  return 0
}

# Record a node outcome; best-effort journal path is NOT best-effort state:
# a record failure is loud (the caller treats the session as errored) because
# losing run-state consistency silently would corrupt the walk.
record_pipeline_outcome() {
  local role="$1" node="$2" outcome="$3" session_log="$4"
  python3 "$ENGINE_HOME/lib/pipeline.py" record \
    "$(pipeline_state_file "$role")" "$node" "$outcome" \
    --session-log "$session_log" \
    --verdict "$(pipeline_verdict_file "$role")" \
    --journal "$LOGDIR/journal.jsonl" >>"$SUPLOG" 2>&1
}
```

(b) `run_session` changes (surgical; current lines cited from main):

- After the `resolve_role_dispatch` block (:1174-1177) insert:

```bash
  if ! resolve_pipeline_node "$role"; then
    log "dispatch: cannot resolve pipeline node for role '$role' -- REFUSING session (fail-safe; see supervisor.log)"
    return 2
  fi
  if [ "$PIPE_DONE" = "1" ]; then
    log "pipeline: role '$role' run already complete -- nothing to dispatch"
    return 0
  fi
```

(placement matters: BEFORE adapter sourcing at :1192, so a `NODE_AGENT` override selects the adapter; `resolve_session_settings` at :1205 then folds the possibly-overridden `ROLE_MODEL`/`ROLE_EFFORT` under the same precedence as today.)

- Replace the prompt-selection block (:1229-1240, `local prompt_file=…` through the missing-file refuse) with:

```bash
  # The node's prompt: the wrapped role's own pack prompt (byte-identical to
  # the pre-pipeline engine) or the compiled per-node brief. Validated in
  # resolve_pipeline_node.
  local prompt_file="$PIPE_PROMPT"
```

- Before `invoke_scoped_env` (:1266) add the verdict-file scrub (a stale
  verdict from a prior round must never decide this round's exit):

```bash
  rm -f "$(pipeline_verdict_file "$role")"
```

- Replace the outcome `case` (:1272-1284) with:

```bash
  local outcome; outcome="$(agent_classify_outcome "$log_file" "$rc")"
  case "$outcome" in
    success)
      if ! record_pipeline_outcome "$role" "$PIPE_NODE" success "$log_file"; then
        log "ERROR pipeline: could not record node success for '$role' -- treating session as errored (state preserved for inspection)"
        return 1
      fi
      return 0 ;;
    usage_limit*)
      # No record: the node was not completed -- state stays put and the SAME
      # node retries next iteration (after the reset wait).
      local epoch="${outcome#usage_limit }"
      if [ "$epoch" != "usage_limit" ] && [ -n "$epoch" ]; then
        persist_reset_epoch "$epoch"
      fi
      return 3 ;;
    *)
      if compute_limit_wait >/dev/null; then
        # Active usage-limit window: this error is presumed limit-flavoured
        # (the legacy path's exact semantics) -- NO record, the same node
        # retries after the wait. Recording would destroy a mid-flight run
        # for a rate-limit artifact.
        return 3
      fi
      record_pipeline_outcome "$role" "$PIPE_NODE" error "$log_file" || \
        log "WARN pipeline: could not record node error for '$role'"
      return "$rc" ;;
  esac
```

(c) Loop gates (verify exact current code at implementation time):

- Fingerprint gate (~:1453): an in-flight run means pending work regardless
  of an unchanged world — but `fingerprint_gate` must STILL RUN FIRST
  (it computes the `FP_CURRENT` global that `record_fingerprint` persists on
  outcome 0; short-circuiting it would record a stale fingerprint, possibly
  another role's — integration-review finding). Only the SKIP verdict is
  vetoed:

```bash
    if fingerprint_gate "$role" && ! pipeline_inflight "$role"; then
      ... existing skip path ...
```

- Board-empty gate (~:1421): a picked item must finish even after the board
  drains, but a FRESH run on an empty board would just burn a session
  discovering there is nothing to pick (Codex CP1). So: board empty + runs
  in flight → restrict dispatch to the in-flight roles; board empty + no
  runs in flight → idle as today. Sketch (adapt to the exact gate code):

```bash
    # inside the board-empty branch, before the idle path:
    if any_pipeline_inflight; then
      inflight_list=""
      for _r in $dispatch_list; do
        pipeline_inflight "$_r" && inflight_list="$inflight_list $_r"
      done
      if [ -n "${inflight_list# }" ]; then
        dispatch_list="${inflight_list# }"   # finish what is mid-run, start nothing new
      else
        log "NOTE pipeline: in-flight run state exists for a role no longer dispatchable -- stranded until re-enabled (see .pipeline-run-*.json in $LOGDIR)"
        ... existing idle path ...
      fi
    else
      ... existing idle path ...
    fi
```

- [ ] **Step 4: Run new + neighbouring suites**

```bash
bash tests/test_pipeline_runner.sh
bash tests/test_headless_dispatch.sh
bash tests/test_scheduler.sh
bash tests/test_event_bus.sh
bash tests/test_fingerprint_gate.sh
bash tests/run_all.sh 2>&1 | tail -3
```

Expected: all pass. `test_headless_dispatch.sh` may need its fake repo to satisfy `pipeline.py start` (an `.autonomy/config.yaml` already exists there); fix the TEST FIXTURE, never weaken the engine path.

- [ ] **Step 5: shellcheck**

Run: `shellcheck -S warning start bin/*.sh bin/agents/*.sh tests/*.sh templates/autonomy-pack/qa/*.sh`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add bin/supervisor.sh tests/test_pipeline_runner.sh
git commit -m "feat(#345): supervisor dispatches through the pipeline runner -- single path, wrapped-legacy byte-equivalent, in-flight guards on fingerprint + board-empty gates"
```

---

### Task 7: ticket-to-merge starter template + docs

**Files:**
- Create: `templates/autonomy-pack/pipelines/ticket-to-merge/pipeline.json`
- Create: `templates/autonomy-pack/pipelines/ticket-to-merge/{pick,plan,code,test-vs-plan,open-pr,qa-review,summarize}.md`
- Create: `templates/autonomy-pack/pipelines/ticket-to-merge/README.md`
- Test: `tests/test_pipeline.py` (template-validates case)
- Modify: `CLAUDE.md` (layout lines)

**Interfaces:** none new — the template must satisfy Task 1's validator.

- [ ] **Step 1: Failing test**

```python
class StarterTemplateTest(unittest.TestCase):
    def test_ticket_to_merge_template_validates(self):
        pdir = os.path.join(os.path.dirname(__file__), "..", "templates",
                            "autonomy-pack", "pipelines", "ticket-to-merge")
        doc = pipeline.load_doc(os.path.join(pdir, "pipeline.json"))
        self.assertEqual(pipeline.validate_doc(doc, pdir), [])
        self.assertEqual(doc["name"], "ticket-to-merge")
        kinds = [c["kind"] for c in doc["containers"]]
        self.assertIn("loop", kinds)
```

- [ ] **Step 2: Run, verify fail** (missing file).

- [ ] **Step 3: Write the template**

`pipeline.json`:

```json
{
  "name": "ticket-to-merge",
  "version": 1,
  "trigger_default": {"type": "loop"},
  "caps": {"max_sessions_per_run": 12},
  "nodes": [
    {"id": "pick", "type": "pick", "brief_ref": "pick.md"},
    {"id": "plan", "type": "plan", "brief_ref": "plan.md"},
    {"id": "code", "type": "agent_task", "brief_ref": "code.md"},
    {"id": "test-vs-plan", "type": "check", "brief_ref": "test-vs-plan.md"},
    {"id": "open-pr", "type": "git_ops", "brief_ref": "open-pr.md"},
    {"id": "qa-review", "type": "check", "brief_ref": "qa-review.md"},
    {"id": "summarize", "type": "summarize", "brief_ref": "summarize.md"}
  ],
  "edges": [],
  "containers": [
    {"id": "coding", "kind": "loop", "children": ["code", "test-vs-plan"],
     "exit_when": "every test criterion named in the plan passes",
     "max_rounds": 5}
  ]
}
```

Briefs — short, imperative, each stating what the node consumes/leaves behind (P1 payload channel = git/GitHub, so each brief names its re-discovery source). Full text for each file:

`pick.md`:
```markdown
Pick the next work item: the highest-priority open ticket labelled `ready`
(p1 before p2 before p3, oldest first) that no open PR already references.
Create the work branch for it (`feat/<n>-...` or `fix/<n>-...`) and push it
so later nodes can find it. Leave a one-line comment on the ticket saying
the pipeline picked it up.
```

`plan.md`:
```markdown
The work item is the ticket referenced by the branch you are on (the newest
pipeline-created branch of this repo; check the ticket comment trail).
Write an implementation plan INTO the ticket as a comment: files to touch,
test criteria (each independently verifiable), and risks. The plan's test
criteria are the coding loop's exit condition -- make them concrete.
```

`code.md`:
```markdown
Continue the ticket's branch (the one `pick` created; find it via the
ticket's comment trail). Implement the next unmet test criterion from the
plan comment, TDD: failing test first, then the code. Commit and push.
```

`test-vs-plan.md`:
```markdown
On the ticket's branch, run the full test suite and compare the results
against the plan comment's test criteria. The loop's exit condition is
"every test criterion named in the plan passes" -- judge it honestly.
```

`open-pr.md`:
```markdown
Open (or refresh) the PR for the ticket's branch. Self-contained
description: what changed, why, the security model, conscious tradeoffs.
NEVER merge here -- merging happens only through the repo's merge gate
(safe_merge), which is not this node's job.
```

`qa-review.md`:
```markdown
Review the open PR as a fresh pair of eyes: read the ticket + PR diff,
check for injection risks, duplication, and missed plan criteria. Leave
findings as PR comments. Do not merge.
```

`summarize.md`:
```markdown
Post a run digest comment on the PR: what was done node by node, test
results, anything a human should look at. Keep it under 15 lines.
```

`README.md`:
```markdown
# ticket-to-merge (starter pipeline, P1 subset)

The reference pipeline from the sequencer spec (v5), in the P1 linear
subset: nodes run in array order; the coding loop's exit condition is
instructed while its `max_rounds` is ENFORCED by the engine.

P1 notes:
- Branch/back-edge stages of the full reference design (plan-viability
  branch, QA verdict back-edge, finish-how branch) land with P2's typed
  dependency edges. This subset is honest about that: no silent
  approximations.
- Nodes share state via git/GitHub (the pushed branch, the ticket's
  comment trail, the PR) -- the engine does not carry payloads between
  node sessions in P1.
- Merging is NEVER a pipeline node's job: the repo merge gate
  (safe_merge + the configured strategy) owns it.
- `trigger_default` is informational in P1 (the binding role's own
  `trigger:` drives dispatch); P4's assignment slots consume it.

Use: copy this directory to `<repo>/.autonomy/pipelines/ticket-to-merge/`
and bind it: `roles.coder.pipeline: ticket-to-merge`.
```

- [ ] **Step 4: Run, verify pass** — `python3 -m unittest tests.test_pipeline -v 2>&1 | tail -3` → OK.

- [ ] **Step 5: CLAUDE.md layout touch**

In the `## Layout` block, extend the `lib/` line and templates line:

```text
lib/config_parser.py             # restricted YAML-subset parser (stdlib only)
lib/pipeline.py                   # P1 sequencer: pipeline docs, wrap, compile, walk, journal (#345)
templates/                        # supervisor.plist.tmpl + autonomy-pack/ (incl. pipelines/ starters)
```

- [ ] **Step 6: Full gates then commit**

```bash
bash tests/run_all.sh 2>&1 | tail -3
shellcheck -S warning start bin/*.sh bin/agents/*.sh tests/*.sh templates/autonomy-pack/qa/*.sh
git add templates/autonomy-pack/pipelines tests/test_pipeline.py CLAUDE.md
git commit -m "feat(#345): ticket-to-merge starter pipeline (P1 linear subset) + layout docs"
```

---

## Post-plan workflow (repo working order — not optional)

1. Codex checkpoint 1 against THIS plan before task 1 executes.
2. Pre-push: `.claude/skills/engineering/pre-push-checklist.md` (run_all + shellcheck + pre-flight-review; Codex checkpoint 2 on the first push).
3. PR per `pr-authoring.md` — security model section: pipeline names/node ids/brief_refs are config-sourced strings that land in filenames and argv → charset-gated at validation AND re-validated in bash (prevention-log #6); bound-but-invalid pipelines REFUSE (no fallback); compiled-brief path pinned to the expected file; verdict file scrubbed before every session; journal is append-only operational data in `var/` (never secrets).
4. Review comments → terminal states; Codex checkpoint 3 on any rebuttal-only round; merge via safe_merge with CI green + APPROVE on the latest commit.
5. Loops stay PAUSED fleet-wide — no live dispatch until the operator says otherwise.
