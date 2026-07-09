# Pipeline+Trigger model — Phase A: typed params/outputs + the `${…}` param language

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `lib/pipeline.py` gains three things, all as **pure, unit-tested
functions with NO dispatch/supervisor change**: (1) declared+validated typed
`params`/`outputs` sections on `pipeline.json`; (2) the `${…}` dynamic-param
**resolver** (named refs + a closed pure-function allowlist, stdlib, no `eval`);
(3) param **precedence** resolution and a **run-outputs file** helper. The
resolver is proven in isolation here and only wired into the live
`compile_brief`/dispatch path in **Phase B** (this plan touches neither).

**Architecture:** Everything lands in `lib/pipeline.py` beside the existing
validator/walk engine. Phase A is the *data + resolution* layer of the
pipeline+trigger model (design spec
`docs/superpowers/specs/2026-07-09-pipeline-trigger-model-design.md`, §3/§3.1).
Because triggers (the value source) are Phase B, Phase A exercises the resolver
with hand-built value maps in tests — no config, no supervisor, no dashboard.

**Tech Stack:** Python 3 stdlib only (`re`, `json`, `os`); `unittest`
(`tests/test_pipeline.py`). No new deps, no bash, no `.sh`, no dashboard.

## Global Constraints

Carried verbatim from every prior sequencer plan — every task includes these:

- **Python 3 stdlib only** (no PyYAML/yq/third-party; **no `eval`/`exec`** — the
  language is a hand-rolled tokenizer over a closed allowlist). **macOS
  `/bin/bash` 3.2.57 floor** and **`shellcheck -S warning` clean** across `start
  bin/*.sh bin/agents/*.sh tests/*.sh templates/autonomy-pack/qa/*.sh` — Phase A
  changes NO `.sh`, but run it. Test files `source`/`import` the REAL module.
- **Fail-safe, never fail-open** (SD-4): an unresolvable ref, an unknown
  function, a required param with no value, a type mismatch → **raise
  `PipelineError`** (refuse), never a silent empty string or a guessed value.
- **Repo-agnostic** (SD-3): nothing target-specific in `lib/`.
- **Honesty invariant** (prevention-log #3, the validator's whole reason for
  being): the validator REFUSES what the engine cannot honor. Phase A adds
  `params`/`outputs` as *consumed* keys — they must be validated, not
  accept-and-ignored. `call_pipeline`, triggers, and live substitution stay
  **out of scope** (Phases B/C); do not add a `call_pipeline` node type here.
- **Secrets discipline:** a `secret`-typed param resolves its VALUE from the
  credential store at resolution time — it must reach the point of use, so it
  does live in the resolved params map (that is not a leak by itself). Phase A
  has **no dispatch/logging surface**, so nothing here logs it; the
  **log-redaction boundary** — redacting secret-typed values before any compiled
  brief/doc is logged — is a **Phase B requirement** (listed in out-of-scope,
  Codex CP1). In Phase A the store is a passed-in callable seam (`secret_lookup`)
  so tests inject a fake; once resolved the raw secret NAME is not carried onward,
  and no secret ever reaches argv.

## Settled decisions binding this plan

- **Design spec §3/§3.1** (params, outputs, the `${…}` language, precedence) is
  the contract this implements. **SD-34** (var-shadow) and the existing
  validator disciplines are untouched. No settled decision is reversed; a new SD
  entry is **not** required for Phase A (it implements an approved spec) — the
  SD entries land with the phases that change behaviour (B dispatch, C compose).
- Prevention-log: **#3/#15** (refuse, never fail-open / never echo invalid as
  usable), **#6** (charset-gate before any path is built — a `repo`/`account`
  param value is validated before use), **#21** (a review fix is a diff too —
  same-class scan).

## File Structure

- Modify: `lib/pipeline.py` — add near the top-of-file constants
  (`_DOC_KEYS` at `:199`, the REs at `:30`): `PARAM_TYPES`, `_PARAM_KEYS`,
  `_OUTPUT_KEYS`, `_REF_RE`, `_ALLOWED_FUNCS`. Add validation blocks to
  `validate_doc` (`:344`) and `${…}`-awareness to `_validate_runs_as` (`:321`).
  Add the resolver + precedence + outputs-file functions in a new clearly-marked
  section (place after `effective_edges`, ~`:320`, before `_validate_runs_as`).
- Test: `tests/test_pipeline.py` — one new `unittest.TestCase` per task.
- **No other file changes.** The supervisor, `compile_brief`, the dashboard, and
  config parsing are all untouched in Phase A.

## Interfaces (Phase A deltas — all in `lib/pipeline.py`)

- `PARAM_TYPES = ("string","number","bool","enum","repo","agent","model","account","secret")`
- `validate_doc` additionally validates `doc["params"]` (list of param decls) and
  `doc["outputs"]` (list of output decls); `${…}`-referencing fields defer their
  concrete charset check.
- `resolve_params(declared, overrides, *, secret_lookup=None) -> dict` — merge
  pipeline defaults with invoker overrides (precedence §3), type-check/coerce,
  required-unset raises. Returns `{name: typed_value}`.
- `substitute(value, ctx) -> Any` — resolve `${…}` in one scalar; whole-value
  keeps the typed value, embedded interpolates as string; unknown ref/func
  raises. `ctx = {"params": {...}, "nodes": {id: {out: val}}, "run": {...}}`.
- `substitute_doc(doc, ctx) -> dict` — deep-copy the doc with every string field
  run through `substitute` (Phase B calls this at compile time; Phase A only
  unit-tests it).
- `write_output(path, name, value)`, `read_outputs(path) -> dict`,
  `project_outputs(declared, raw) -> dict` — the run-outputs file
  (`.run-<id>-outputs.json`).

---

### Task 1: declare + validate `params` and `outputs` (+ `${…}`-awareness)

**Files:** Modify `lib/pipeline.py` (`_DOC_KEYS` `:199`; new constants;
`validate_doc` `:344`; `_validate_runs_as` `:321`). Test: `tests/test_pipeline.py`.

**Interfaces:**
- Produces: validated `params`/`outputs` schema; `_is_ref` helper consumed by
  Task 2 and by `_validate_runs_as`.

- [ ] **Step 1: Write the failing tests** — append a class to
  `tests/test_pipeline.py` (`import pipeline` alias is already in the file):

```python
class ParamsOutputsValidationTest(unittest.TestCase):
    def _doc(self, **over):
        d = {"name": "flow", "version": 1,
             "caps": {"max_sessions_per_run": 16},
             "nodes": [{"id": "a", "type": "pick", "brief_ref": "a.md"}],
             "edges": []}
        d.update(over)
        return d

    def test_valid_params_and_outputs_accepted(self):
        d = self._doc(
            params=[{"name": "repo", "type": "repo", "required": True},
                    {"name": "model", "type": "model", "default": "claude-sonnet-5"},
                    {"name": "mode", "type": "enum", "choices": ["a", "b"], "default": "a"}],
            outputs=[{"name": "pr", "type": "number"}])
        self.assertEqual(pipeline.validate_doc(d, None), [])

    def test_unknown_param_type_refused(self):
        d = self._doc(params=[{"name": "x", "type": "wat"}])
        errs = pipeline.validate_doc(d, None)
        self.assertTrue(any("type" in e for e in errs))

    def test_param_bad_name_charset_refused(self):
        d = self._doc(params=[{"name": "../x", "type": "string"}])
        self.assertTrue(pipeline.validate_doc(d, None))

    def test_enum_requires_choices(self):
        d = self._doc(params=[{"name": "m", "type": "enum"}])
        self.assertTrue(any("choices" in e for e in pipeline.validate_doc(d, None)))

    def test_default_must_be_in_choices(self):
        d = self._doc(params=[{"name": "m", "type": "enum",
                               "choices": ["a"], "default": "z"}])
        self.assertTrue(any("default" in e for e in pipeline.validate_doc(d, None)))

    def test_non_enum_default_type_checked_at_declare(self):
        bad = self._doc(params=[{"name": "n", "type": "number", "default": "abc"}])
        self.assertTrue(any("default" in e for e in pipeline.validate_doc(bad, None)))
        badb = self._doc(params=[{"name": "b", "type": "bool", "default": "maybe"}])
        self.assertTrue(any("default" in e for e in pipeline.validate_doc(badb, None)))
        ok = self._doc(params=[{"name": "n", "type": "number", "default": 3}])
        self.assertEqual(pipeline.validate_doc(ok, None), [])

    def test_duplicate_param_names_refused(self):
        d = self._doc(params=[{"name": "x", "type": "string"},
                              {"name": "x", "type": "number"}])
        self.assertTrue(any("duplicate" in e for e in pipeline.validate_doc(d, None)))

    def test_output_needs_name_and_type(self):
        d = self._doc(outputs=[{"name": "pr"}])
        self.assertTrue(pipeline.validate_doc(d, None))

    def test_params_not_a_list_refused(self):
        self.assertTrue(pipeline.validate_doc(self._doc(params={}), None))

    def test_reference_in_field_still_refused_in_phase_a(self):
        # HONESTY (Codex CP1): Phase A cannot substitute ${...} (dispatch is
        # Phase B), so validate_doc must still REFUSE a ${...} in agent -- a
        # validating doc must be a runnable doc. Acceptance lands in Phase B.
        d = self._doc(nodes=[{"id": "a", "type": "agent_task", "brief_ref": "a.md",
                              "runs_as": {"agent": "${params.coder_agent}"}}])
        self.assertTrue(pipeline.validate_doc(d, None))          # refused for now
        d2 = self._doc(nodes=[{"id": "a", "type": "agent_task", "brief_ref": "a.md",
                               "runs_as": {"agent": "bad agent!"}}])
        self.assertTrue(pipeline.validate_doc(d2, None))

    def test_no_params_key_still_valid(self):    # back-compat: params optional
        self.assertEqual(pipeline.validate_doc(self._doc(), None), [])
```

- [ ] **Step 2: Run, see fail** — `python3 -m unittest
  tests.test_pipeline.ParamsOutputsValidationTest -v` → FAIL (`params`/`outputs`
  refused as unknown keys / agent-ref rejected).

- [ ] **Step 3: Implement.** Add constants near `lib/pipeline.py:203` (after the
  ceilings):

```python
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
```

  **Phase A does NOT teach the validator to accept `${…}` in activity fields.**
  Nothing substitutes references yet (dispatch is Phase B), so a doc that used
  `runs_as.agent="${params.x}"` would validate here and then dispatch a literal
  `${params.x}` — the exact fail-open the honesty invariant forbids (Codex CP1).
  So `_validate_runs_as` is UNCHANGED in Phase A: a `${…}` in `agent`/`account`
  is still refused by the charset check. Reference *acceptance* lands in Phase B,
  wired together with substitution, so a validating doc is always a runnable doc.
  Only the param/output **declarations** (a pipeline's honest interface) are
  accepted here.

  Add `"params"` and `"outputs"` to `_DOC_KEYS` (`:199`):

```python
_DOC_KEYS = frozenset(("name", "version", "trigger_default", "caps",
                       "nodes", "edges", "containers", "wrapped_from_role",
                       "params", "outputs"))
```

  Add a validation helper (place before `validate_doc`, ~`:343`):

```python
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
                    errors.append("%s: must be a mapping" % w); continue
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
                    errors.append("%s: must be a mapping" % w); continue
                for k in o:
                    if k not in _OUTPUT_KEYS:
                        errors.append("%s: unknown key %r" % (w, k))
                if not (_is_str(o.get("name")) and _NAME_RE.match(o.get("name") or "")):
                    errors.append("%s: name required, charset [A-Za-z0-9._-]" % w)
                if o.get("type") not in PARAM_TYPES:
                    errors.append("%s: type must be one of %s"
                                  % (w, ", ".join(PARAM_TYPES)))
```

  Call it inside `validate_doc` after the `caps` block (~`:372`, before
  `nodes = doc.get("nodes")`): `_validate_params_outputs(doc, errors)`.

  **`_validate_runs_as` is UNCHANGED in Phase A** (Codex CP1 honesty fix): a
  `${…}` in `agent`/`account` is still refused by the existing charset check,
  because nothing resolves it yet. Reference acceptance is Phase B (wired with
  substitution). Do not touch `_validate_runs_as` in this phase.

- [ ] **Step 4: Run, see pass, then the full suite** — `python3 -m unittest
  tests.test_pipeline -v` → new class green AND every existing validator/walk
  test still green (params/outputs are optional, so all P1–P3 docs stay valid).

- [ ] **Step 5: Commit**

```bash
git add lib/pipeline.py tests/test_pipeline.py
git commit -m "feat(#<ISSUE>): declare+validate typed params/outputs (pipeline+trigger model Phase A; validator refuses ${} until Phase B wires substitution)"
```

---

### Task 2: the `${…}` resolver — named references

**Files:** Modify `lib/pipeline.py` (new resolver section, ~`:320`).
Test: `tests/test_pipeline.py`.

**Interfaces:**
- Consumes: `_REF_RE` (Task 1).
- Produces: `substitute(value, ctx)` + `_resolve_expr` — consumed by Task 3
  (functions) and Task 5 (`substitute_doc`).

- [ ] **Step 1: Write the failing tests**

```python
class SubstituteRefsTest(unittest.TestCase):
    def setUp(self):
        self.ctx = {"params": {"repo": "/tmp/r", "n": 3, "flag": True},
                    "nodes": {"code": {"branch": "feat/x"}},
                    "run": {"id": "r1", "pipeline": "flow"}}

    def test_whole_value_keeps_type(self):
        self.assertEqual(pipeline.substitute("${params.n}", self.ctx), 3)   # int, not "3"
        self.assertIs(pipeline.substitute("${params.flag}", self.ctx), True)

    def test_whole_value_string(self):
        self.assertEqual(pipeline.substitute("${params.repo}", self.ctx), "/tmp/r")

    def test_node_output_ref(self):
        self.assertEqual(pipeline.substitute("${nodes.code.output.branch}", self.ctx),
                         "feat/x")

    def test_run_field_ref(self):
        self.assertEqual(pipeline.substitute("${run.id}", self.ctx), "r1")

    def test_interpolation_is_string(self):
        self.assertEqual(pipeline.substitute("release/${params.repo}/${run.id}", self.ctx),
                         "release//tmp/r/r1")
        self.assertEqual(pipeline.substitute("n=${params.n}", self.ctx), "n=3")

    def test_non_string_passthrough(self):
        self.assertEqual(pipeline.substitute(7, self.ctx), 7)
        self.assertEqual(pipeline.substitute(None, self.ctx), None)

    def test_unknown_param_refuses(self):
        with self.assertRaises(pipeline.PipelineError):
            pipeline.substitute("${params.missing}", self.ctx)

    def test_unknown_namespace_refuses(self):
        with self.assertRaises(pipeline.PipelineError):
            pipeline.substitute("${bogus.x}", self.ctx)

    def test_unknown_node_output_refuses(self):
        with self.assertRaises(pipeline.PipelineError):
            pipeline.substitute("${nodes.code.output.nope}", self.ctx)

    def test_escape_literal_dollar_brace(self):
        self.assertEqual(pipeline.substitute("cost $${params.n}", self.ctx),
                         "cost ${params.n}")
```

- [ ] **Step 2: Run, see fail** (`substitute` undefined).

- [ ] **Step 3: Implement** — add the resolver section after `effective_edges`
  (~`:320`):

```python
# --- The ${...} dynamic-param language (spec S3.1). Stdlib, NO eval/exec: a
#     hand-rolled resolver over named refs + a closed pure-function allowlist.
#     Fail-safe: any unresolvable ref / unknown function / type mismatch RAISES
#     PipelineError -- never a silent empty string. ---
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
            raise PipelineError("unknown node output ${nodes.%s.output.%s}"
                                % (parts[1], parts[3]))
        return outs[parts[3]]
    if parts[0] == "run" and len(parts) == 2:
        d = ctx.get("run", {})
        if parts[1] not in d:
            raise PipelineError("unknown run field ${run.%s}" % parts[1])
        return d[parts[1]]
    raise PipelineError("unresolvable reference ${%s}" % path)


def _resolve_expr(expr, ctx):
    """One ${...} body: a reference (Task 2) or a function call (Task 3)."""
    return _resolve_ref(expr.strip(), ctx)        # Task 3 wraps this for funcs


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
    m = _REF_RE.fullmatch(protected)
    if m:                                          # whole-value -> typed
        out = _resolve_expr(m.group(1), ctx)
        return out if not isinstance(out, str) else out.replace(_ESC, "${")
    def repl(mo):
        return _to_str(_resolve_expr(mo.group(1), ctx))
    return _REF_RE.sub(repl, protected).replace(_ESC, "${")
```

- [ ] **Step 4: Run, see pass, full suite green.**

- [ ] **Step 5: Commit** `feat(#<ISSUE>): ${...} resolver -- named refs
  (params/nodes.output/run), typed whole-value vs string interpolation`.

---

### Task 3: the closed pure-function allowlist (`default`/`concat`/`slug`)

**Files:** Modify `lib/pipeline.py` (extend `_resolve_expr`). Test:
`tests/test_pipeline.py`.

**Interfaces:**
- Consumes: `_resolve_ref` (Task 2).
- Produces: function support inside `${…}` — the closed allowlist.

- [ ] **Step 1: Write the failing tests**

```python
class SubstituteFuncsTest(unittest.TestCase):
    def setUp(self):
        self.ctx = {"params": {"model": "", "ticket": "AE-12", "a": "x"},
                    "nodes": {}, "run": {}}

    def test_default_uses_fallback_when_empty(self):
        self.assertEqual(pipeline.substitute(
            "${default(params.model, 'claude-sonnet-5')}", self.ctx), "claude-sonnet-5")

    def test_default_uses_value_when_set(self):
        self.ctx["params"]["model"] = "opus"
        self.assertEqual(pipeline.substitute(
            "${default(params.model, 'x')}", self.ctx), "opus")

    def test_concat(self):
        self.assertEqual(pipeline.substitute(
            "${concat('release/', params.ticket)}", self.ctx), "release/AE-12")

    def test_slug(self):
        self.assertEqual(pipeline.substitute(
            "${slug(concat(params.ticket, ' Fix Bug'))}", self.ctx), "ae-12-fix-bug")

    def test_nested_refs_and_literals(self):
        self.assertEqual(pipeline.substitute(
            "${concat(params.a, '-', params.ticket)}", self.ctx), "x-AE-12")

    def test_unknown_function_refuses(self):
        with self.assertRaises(pipeline.PipelineError):
            pipeline.substitute("${danger(params.a)}", self.ctx)

    def test_no_eval_arbitrary_expr_refuses(self):
        with self.assertRaises(pipeline.PipelineError):
            pipeline.substitute("${__import__('os').system('x')}", self.ctx)

    def test_wrong_arity_refuses(self):
        for expr in ("${slug()}", "${slug(params.a, 'x')}", "${default(params.a)}",
                     "${default(params.a, 'x', 'y')}"):
            with self.assertRaises(pipeline.PipelineError):
                pipeline.substitute(expr, self.ctx)

    def test_brace_in_literal_is_a_documented_limitation_refuses(self):
        # Low (Codex CP1): _REF_RE stops at the first '}', so a '}' inside a
        # quoted literal truncates the body -> it fails to parse and RAISES
        # (fail-safe, never a silent mis-resolve). Documented constraint:
        # string literals inside ${...} may not contain '}'.
        with self.assertRaises(pipeline.PipelineError):
            pipeline.substitute("${concat('a}b', params.a)}", self.ctx)
```

- [ ] **Step 2: Run, see fail** (functions unsupported → the whole `${default(…)}`
  is treated as a bad reference and raises, but with the wrong shape; the
  `default`/`concat`/`slug` tests fail on value).

- [ ] **Step 3: Implement** — a tiny recursive-descent argument parser (NO eval)
  and the allowlist. Add above `_resolve_expr` and rewrite `_resolve_expr`:

```python
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
            quote = ch; buf.append(ch)
        elif ch == "(":
            depth += 1; buf.append(ch)
        elif ch == ")":
            depth -= 1; buf.append(ch)
        elif ch == "," and depth == 0:
            args.append("".join(buf).strip()); buf = []
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
```

  (Delete the Task-2 stub body of `_resolve_expr` — this replaces it. Same-class
  note: `__import__('os').system('x')` matches `_CALL_RE` as fn=`__import__`? No
  — `_CALL_RE` requires `^[a-z_]+\(` and `__import__` is `[a-z_]+`, so it parses
  as fn `__import__` → not in the allowlist → raises. The nested `.system` never
  reaches a parser. Verified by `test_no_eval_arbitrary_expr_refuses`.)

- [ ] **Step 4: Run, see pass, full suite green.**

- [ ] **Step 5: Commit** `feat(#<ISSUE>): closed pure-function allowlist
  (default/concat/slug) inside ${...} -- hand-parsed, no eval`.

---

### Task 4: param precedence resolution (`resolve_params`)

**Files:** Modify `lib/pipeline.py`. Test: `tests/test_pipeline.py`.

**Interfaces:**
- Consumes: `PARAM_TYPES` (Task 1).
- Produces: `resolve_params(declared, overrides, *, secret_lookup=None)` — the
  value map Phase B feeds into `ctx["params"]`.

- [ ] **Step 1: Write the failing tests**

```python
class ResolveParamsTest(unittest.TestCase):
    def _decl(self):
        return [{"name": "repo", "type": "repo", "required": True},
                {"name": "model", "type": "model", "default": "claude-sonnet-5"},
                {"name": "retries", "type": "number", "default": 2},
                {"name": "mode", "type": "enum", "choices": ["fast", "safe"], "default": "safe"},
                {"name": "token", "type": "secret", "required": False}]

    def test_default_when_no_override(self):
        got = pipeline.resolve_params(self._decl(), {"repo": "/r"})
        self.assertEqual(got["model"], "claude-sonnet-5")
        self.assertEqual(got["retries"], 2)

    def test_override_wins(self):
        got = pipeline.resolve_params(self._decl(), {"repo": "/r", "model": "opus"})
        self.assertEqual(got["model"], "opus")

    def test_required_unset_refuses(self):
        with self.assertRaises(pipeline.PipelineError):
            pipeline.resolve_params(self._decl(), {})          # repo missing

    def test_unknown_override_refuses(self):
        with self.assertRaises(pipeline.PipelineError):
            pipeline.resolve_params(self._decl(), {"repo": "/r", "nope": 1})

    def test_enum_override_must_be_a_choice(self):
        with self.assertRaises(pipeline.PipelineError):
            pipeline.resolve_params(self._decl(), {"repo": "/r", "mode": "wild"})

    def test_number_type_coerced_and_checked(self):
        got = pipeline.resolve_params(self._decl(), {"repo": "/r", "retries": "5"})
        self.assertEqual(got["retries"], 5)                    # coerced to int
        with self.assertRaises(pipeline.PipelineError):
            pipeline.resolve_params(self._decl(), {"repo": "/r", "retries": "abc"})

    def test_secret_resolves_via_lookup_and_is_not_the_name(self):
        seen = {}
        def fake_lookup(name): seen["asked"] = name; return "s3cr3t"
        got = pipeline.resolve_params(
            [{"name": "token", "type": "secret", "required": True}],
            {"token": "PROD_KEY"}, secret_lookup=fake_lookup)
        self.assertEqual(got["token"], "s3cr3t")
        self.assertEqual(seen["asked"], "PROD_KEY")

    def test_secret_without_lookup_refuses(self):
        with self.assertRaises(pipeline.PipelineError):
            pipeline.resolve_params([{"name": "t", "type": "secret", "required": True}],
                                    {"t": "K"})                # no secret_lookup seam
```

- [ ] **Step 2: Run, see fail.**

- [ ] **Step 3: Implement** — add after `resolve_params`'s dependencies (place
  near the resolver section):

```python
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


def resolve_params(declared, overrides, *, secret_lookup=None):
    """Merge pipeline DEFAULTS with an invoker's OVERRIDES (a trigger OR a
    calling pipeline -- the same slot, spec S3), type-check, and return
    {name: typed_value}. A required param with neither default nor override
    RAISES (fail-safe). Unknown override keys RAISE. A `secret` param resolves
    its VALUE through secret_lookup(name) and never carries the raw name onward
    (secrets discipline); no secret_lookup seam for a secret param RAISES."""
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
            if secret_lookup is None:
                raise PipelineError("param %r is a secret but no secret store "
                                    "was provided" % name)
            value = secret_lookup(value)
        else:
            value = _coerce(name, typ, value, p.get("choices"))
        out[name] = value
    return out
```

- [ ] **Step 4: Run, see pass, full suite green.**

- [ ] **Step 5: Commit** `feat(#<ISSUE>): resolve_params -- default<override
  precedence, type coerce/check, required-unset refuses, secret seam`.

---

### Task 5: the run-outputs file + `substitute_doc`

**Files:** Modify `lib/pipeline.py`. Test: `tests/test_pipeline.py`.

**Interfaces:**
- Consumes: `substitute` (Task 2/3), the declared `outputs` (Task 1).
- Produces: `write_output`/`read_outputs`/`project_outputs`, `substitute_doc`.

- [ ] **Step 1: Write the failing tests**

```python
class OutputsFileTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(); self.addCleanup(shutil.rmtree, self.d, ignore_errors=True)
        self.p = os.path.join(self.d, ".run-r1-outputs.json")

    def test_write_then_read_roundtrip(self):
        pipeline.write_output(self.p, "branch", "feat/x")
        pipeline.write_output(self.p, "pr", 42)
        self.assertEqual(pipeline.read_outputs(self.p), {"branch": "feat/x", "pr": 42})

    def test_read_missing_is_empty_total(self):
        self.assertEqual(pipeline.read_outputs(self.p + "-nope"), {})

    def test_read_corrupt_is_empty_total(self):
        with open(self.p, "w") as fh: fh.write("{ not json")
        self.assertEqual(pipeline.read_outputs(self.p), {})

    def test_project_outputs_keeps_only_declared(self):
        raw = {"pr": 42, "branch": "feat/x", "secret_junk": "x"}
        decl = [{"name": "pr", "type": "number"}]
        self.assertEqual(pipeline.project_outputs(decl, raw), {"pr": 42})

    def test_project_outputs_type_mismatch_raises(self):
        with self.assertRaises(pipeline.PipelineError):
            pipeline.project_outputs([{"name": "pr", "type": "number"}], {"pr": "abc"})

    def test_project_outputs_missing_declared_is_absent(self):
        self.assertEqual(pipeline.project_outputs(
            [{"name": "pr", "type": "number"}, {"name": "x", "type": "string"}],
            {"pr": 7}), {"pr": 7})

    def test_write_is_atomic_and_bounded(self):
        pipeline.write_output(self.p, "a", "1")
        # a second writer never corrupts the file (tmp+replace); still valid JSON
        pipeline.write_output(self.p, "b", "2")
        self.assertEqual(sorted(pipeline.read_outputs(self.p)), ["a", "b"])


class SubstituteDocTest(unittest.TestCase):
    def test_deep_substitutes_strings_only(self):
        doc = {"name": "flow", "nodes": [
            {"id": "a", "runs_as": {"model": "${params.m}"}, "count": 3}]}
        ctx = {"params": {"m": "opus"}, "nodes": {}, "run": {}}
        out = pipeline.substitute_doc(doc, ctx)
        self.assertEqual(out["nodes"][0]["runs_as"]["model"], "opus")
        self.assertEqual(out["nodes"][0]["count"], 3)             # non-string untouched
        self.assertEqual(doc["nodes"][0]["runs_as"]["model"], "${params.m}")  # input intact
```

- [ ] **Step 2: Run, see fail.**

- [ ] **Step 3: Implement** — add near the resolver section:

```python
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
        if typ in PARAM_TYPES and typ != "enum" and not _typed_ok(typ, v):
            raise PipelineError("output %r: %r does not match declared type %r"
                                % (k, v, typ))
        out[k] = v
    return out


def substitute_doc(doc, ctx):
    """Deep copy of doc with every STRING scalar run through substitute(). Phase
    B calls this at compile time; Phase A only unit-tests it. Non-strings pass
    through untouched; the input doc is never mutated."""
    def walk(v):
        if isinstance(v, dict):
            return {k: walk(x) for k, x in v.items()}
        if isinstance(v, list):
            return [walk(x) for x in v]
        return substitute(v, ctx)
    return walk(doc)
```

  (Confirm `import json, os` at the top of `lib/pipeline.py` — both are already
  imported by the existing `load_doc`/state machine.)

- [ ] **Step 4: Run, see pass, then the FULL suite** (`python3 -m unittest
  tests.test_pipeline -v`) — all five new classes + every pre-existing test green.

- [ ] **Step 5: Commit** `feat(#<ISSUE>): run-outputs file (write/read/project,
  total+atomic) + substitute_doc deep resolver`.

---

### Task 6: gates, docs, PR

- [ ] **Gates:** `bash tests/run_all.sh` green · `shellcheck -S warning …` clean
  (no `.sh` changed, but run it) · **pre-flight-review** over the full diff
  (`.claude/skills/engineering/pre-flight-review.md`) · **Codex checkpoint 2**
  (`.claude/skills/engineering/codex-checkpoints.md`) — fold real findings before
  the first push. No dashboard verify loop (Phase A touches no page).
- [ ] **Product doc:** add a short "Parameters & outputs" subsection to
  `docs/pipelines.md` (product layer, house rule): a pipeline may declare typed
  `params` (with defaults) and `outputs`; values come from whatever invokes it;
  `${params.x}` / `${nodes.id.output.name}` reference them; the runnable
  invocation surface (triggers, calling one pipeline from another) is "coming
  with the trigger system" — do NOT claim triggers/dispatch exist yet (they are
  Phase B; overstating enforcement is the honesty violation the skill forbids).
- [ ] **Skill:** in `.claude/skills/engineering/pipelines.md`, add one line under
  "The document": params/outputs are declared+validated and the `${…}` resolver
  (`substitute`/`resolve_params`) exists in `lib/pipeline.py` but is **not yet
  wired into dispatch** (Phase B).
- [ ] **PR** per `.claude/skills/engineering/pr-authoring.md`. Security model
  (lighter — no new I/O surface, no dispatch): **no `eval`/`exec`** anywhere (the
  language is a hand-rolled tokenizer over a closed allowlist —
  `test_no_eval_arbitrary_expr_refuses` proves `${__import__(...)}` refuses);
  fail-safe (every unresolved ref / unknown func / wrong arity / type mismatch /
  required-unset RAISES, never a silent value); **secrets** resolve through an
  injected `secret_lookup` seam into the params map (they must reach the point of
  use) — Phase A has no dispatch/logging surface so nothing here logs them, and
  the log-redaction boundary is an explicit Phase B requirement (Codex CP1);
  the outputs-file writer is atomic (`tmp`+`os.replace`) and the reader total.
  Tradeoffs: the resolver is **not wired into the live compile/dispatch path**
  (Phase B) — Phase A proves it in isolation; `${…}` in an `effort` field is not
  yet supported (enum-checked now, revisited in B). Before merge:
  `gh pr view <n> --json closingIssuesReferences` confirms it closes ONLY the
  Phase A issue (prevention-log #20); every review comment to a terminal state;
  merge via `safe_merge`.

---

## Out of scope (later phases — do NOT build here)

- **Phase B:** triggers as first-class objects, the supervisor enumerating
  triggers, the auto-shim migration, wiring `substitute_doc`/`resolve_params`
  into `compile_brief`/dispatch, teaching the validator to ACCEPT `${…}` in
  activity fields (now that substitution exists), `${…}` in `effort`, real
  repo/account existence checks at run time, and the **secret log-redaction
  boundary** (redact secret-typed values before any compiled brief/doc is logged
  — Codex CP1, Phase A deferred it).
- **Phase C:** the `call_pipeline` node type + child runs + outputs mapping +
  event firing.
- **Phase D/E:** gallery/triggers UI, trust re-key, run windows.
