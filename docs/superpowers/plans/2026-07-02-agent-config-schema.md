# Agent-Config Schema (agent-org increment 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the `roles:` schema (`lib/roles.py`) so every agent carries `account` (validated
against the machine accounts registry), `scope`, `model`/`effort`/`models`, and the behaviour
knobs from the dynamic agent-org design spec — with doctor/onboard surfacing the validation.

**Architecture:** Pure shape/enum validation stays in `validate_roles` (no filesystem). Account
existence gets its own pure check `check_accounts(config, known_account_names)` — same
injected-dependency seam as `check_prompt_files`. The CLI entry (`roles.py <target-repo>`, which
doctor already calls) loads the real registry via `accounts.Accounts().list()` and folds all three
checks into one exit code. `config_parser.py` already parses every new shape — it gets coverage
tests only. The pack template's commented `roles:` example is rewritten to the new schema.

**Tech Stack:** Python 3 stdlib only; bash 3.2-compatible test scripts; unittest.

**Spec:** `docs/superpowers/specs/2026-07-02-dynamic-agent-org-design.md` (Layer 2 + knob table).

## Global Constraints

- Python 3 **stdlib only** — no PyYAML, no third-party imports.
- macOS `/bin/bash` 3.2.57 compatible test scripts — no `mapfile`, no `**`, no `declare -A`.
- `shellcheck -S warning` clean across `start bin/*.sh bin/agents/*.sh tests/*.sh templates/autonomy-pack/qa/*.sh`.
- Tests are genuine: `source`/import the real code, no assertions-on-mocks.
- Repo-agnostic: no target-repo-specific values in `bin/` or `lib/`.
- Fail-safe, never fail-open: a role referencing an unknown account is an **error** (the agent
  could never resolve auth), not a warning.
- Backward compatible: `substrate:` stays accepted; `scope: diff` (bare string) stays accepted as
  shorthand for `scope: { target: diff }`; absent `roles:` block still exits 3.
- Existing exit-code contract of `roles.py <target-repo>` unchanged:
  0 valid / 3 valid-no-block / 1 invalid / 2 unreadable.

---

### Task 0: Issue + branch

- [ ] **Step 1: Create the tracking issue**

```bash
gh issue create --title "agent-org increment 2: agent-config schema (account/scope/models/knobs)" \
  --body "Extend lib/roles.py so a role carries account (validated against the accounts registry), scope, model/effort/models, and the behaviour knobs from docs/superpowers/specs/2026-07-02-dynamic-agent-org-design.md. doctor/onboard validation included. Increment 2 of the dynamic agent-org build (increment 1 = PR #57)."
```

Note the issue number `<n>` from the output.

- [ ] **Step 2: Branch**

```bash
git checkout -b feat/<n>-agent-config-schema
```

---

### Task 1: Parser coverage for the new config shapes

The restricted parser already supports one-level flow mappings with scalar and inline-list values.
Lock that in with tests naming the increment-2 shapes, so a future parser change can't silently
break them. Expected: all PASS immediately (characterization tests). If any FAILS, stop and report
— the parser gap must be fixed before the schema work (that is not expected).

**Files:**
- Test: `tests/test_config_parser.py` (append a new test class)

**Interfaces:**
- Consumes: `config_parser.parse(text) -> dict` (existing).
- Produces: nothing new — guarantees later tasks' config texts parse as documented.

- [ ] **Step 1: Append the coverage tests**

Append to `tests/test_config_parser.py`:

```python
class TestAgentOrgShapes(unittest.TestCase):
    """Increment-2 schema shapes (agent-org design spec, Layer 2) -- the
    restricted parser must keep handling these exact forms."""

    def test_models_flow_mapping(self):
        cfg = config_parser.parse(
            "roles:\n  coder:\n"
            "    models: { plan: claude-opus-4-8, implement: claude-sonnet-5, test: claude-haiku-4-5 }\n")
        self.assertEqual(cfg["roles"]["coder"]["models"],
                         {"plan": "claude-opus-4-8",
                          "implement": "claude-sonnet-5",
                          "test": "claude-haiku-4-5"})

    def test_scope_flow_mapping_with_list(self):
        cfg = config_parser.parse(
            "roles:\n  coder:\n"
            "    scope: { labels: [ready, bug], milestone: current }\n")
        self.assertEqual(cfg["roles"]["coder"]["scope"],
                         {"labels": ["ready", "bug"], "milestone": "current"})

    def test_scope_block_form(self):
        cfg = config_parser.parse(
            "roles:\n  qa:\n    scope:\n      target: diff\n")
        self.assertEqual(cfg["roles"]["qa"]["scope"], {"target": "diff"})

    def test_regression_after_tickets(self):
        cfg = config_parser.parse(
            "roles:\n  qa:\n    regression: { after_tickets: 10 }\n")
        self.assertEqual(cfg["roles"]["qa"]["regression"], {"after_tickets": "10"})

    def test_regression_every_cron(self):
        cfg = config_parser.parse(
            'roles:\n  qa:\n    regression: { every: "0 3 * * 0" }\n')
        self.assertEqual(cfg["roles"]["qa"]["regression"], {"every": "0 3 * * 0"})

    def test_tools_and_duties_inline_lists(self):
        cfg = config_parser.parse(
            "roles:\n  qa:\n    tools: [read, mcp]\n  pm:\n"
            "    duties: [groom, prioritise, unblock, spec-check]\n")
        self.assertEqual(cfg["roles"]["qa"]["tools"], ["read", "mcp"])
        self.assertEqual(cfg["roles"]["pm"]["duties"],
                         ["groom", "prioritise", "unblock", "spec-check"])
```

Note: bare `10` parses as the STRING `"10"` (the parser has no int coercion) — the schema's
`_is_positive_int` already handles that, same as `instances:` today.

- [ ] **Step 2: Run the tests**

Run: `python3 -m unittest tests.test_config_parser -v`
Expected: ALL PASS (characterization — the parser already supports these shapes).

- [ ] **Step 3: Commit**

```bash
git add tests/test_config_parser.py
git commit -m "test: lock parser coverage for agent-org increment-2 config shapes"
```

---

### Task 2: validate_roles — identity/execution fields (account, model, effort, models, scope)

**Files:**
- Modify: `lib/roles.py` (constants near line 32; new `_is_nonempty_str` + `_validate_scope`
  helpers; new checks inside the `validate_roles` per-role loop, after the `instances` check)
- Test: `tests/test_roles.py` (append a test class)

**Interfaces:**
- Consumes: `roles.validate_roles(config) -> [error strings]` (existing).
- Produces (Task 3/4/5 rely on these exact names):
  - `VALID_PHASES = ("plan", "implement", "test")`
  - `VALID_SCOPE_TARGETS = ("diff", "affected", "full-regression")`
  - `_is_nonempty_str(v) -> bool`
  - `_validate_scope(name, scope) -> [error strings]`
- Error strings keep the existing `roles.<name>: ...` prefix format.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_roles.py`:

```python
class TestIncrement2Fields(unittest.TestCase):
    """account/model/effort/models/scope shape validation (agent-org spec)."""

    def test_full_spec_example_validates(self):
        cfg = parse(
            "roles:\n"
            "  coder:\n"
            "    enabled: true\n"
            "    account: claude-sub\n"
            "    trigger: { type: loop }\n"
            "    model: claude-sonnet-5\n"
            "    effort: high\n"
            "    scope: { labels: [ready], milestone: current }\n"
            "  qa:\n"
            "    enabled: true\n"
            "    account: anthropic-work\n"
            "    trigger: { type: event, on: [pr.opened, pr.synchronize] }\n"
            "    model: claude-opus-4-8\n"
            "    scope: { target: diff }\n"
            "  researcher:\n"
            "    enabled: false\n"
            "    account: codex-sub\n"
            '    trigger: { type: cron, schedule: "0 3 * * *" }\n'
            "    models: { plan: claude-opus-4-8, implement: claude-sonnet-5, test: claude-haiku-4-5 }\n")
        self.assertEqual(roles.validate_roles(cfg), [])

    def test_account_must_be_nonempty(self):
        cfg = parse("roles:\n  coder:\n    account: \"\"\n")
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("account" in e and "coder" in e for e in errs))

    def test_model_and_effort_must_be_nonempty_strings(self):
        for field in ("model", "effort"):
            cfg = parse("roles:\n  coder:\n    %s: \"\"\n" % field)
            errs = roles.validate_roles(cfg)
            self.assertTrue(any(field in e for e in errs),
                            "expected an error for empty %s" % field)

    def test_models_unknown_phase(self):
        cfg = parse("roles:\n  coder:\n    models: { deploy: claude-sonnet-5 }\n")
        errs = roles.validate_roles(cfg)
        self.assertEqual(len(errs), 1)
        self.assertIn("deploy", errs[0])
        self.assertIn("plan", errs[0])  # error names the valid phases

    def test_models_must_be_mapping(self):
        cfg = parse("roles:\n  coder:\n    models: claude-sonnet-5\n")
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("models" in e for e in errs))

    def test_scope_bare_target_shorthand(self):
        # legacy form from the old template: scope: diff
        cfg = parse("roles:\n  qa:\n    scope: diff\n")
        self.assertEqual(roles.validate_roles(cfg), [])

    def test_scope_bare_string_must_be_valid_target(self):
        cfg = parse("roles:\n  qa:\n    scope: everything\n")
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("scope" in e and "everything" in e for e in errs))

    def test_scope_unknown_key(self):
        cfg = parse("roles:\n  coder:\n    scope: { repos: [a, b] }\n")
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("repos" in e for e in errs))

    def test_scope_labels_must_be_nonempty_list(self):
        cfg = parse("roles:\n  coder:\n    scope: { labels: ready }\n")
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("labels" in e for e in errs))

    def test_scope_target_enum(self):
        cfg = parse("roles:\n  qa:\n    scope: { target: everything }\n")
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("target" in e and "everything" in e for e in errs))

    def test_scope_empty_mapping_is_whole_board(self):
        cfg = parse("roles:\n  coder:\n    scope: {}\n")
        self.assertEqual(roles.validate_roles(cfg), [])
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m unittest tests.test_roles.TestIncrement2Fields -v`
Expected: FAIL — `test_account_must_be_nonempty`, `test_models_unknown_phase`,
`test_scope_bare_string_must_be_valid_target` (etc.) fail because `validate_roles` ignores the
new fields today; the two "validates" tests pass. If anything ERRORs on parse, fix the test text,
not the parser.

- [ ] **Step 3: Implement**

In `lib/roles.py`, after `VALID_TRIGGERS` (line 33), add:

```python
VALID_PHASES = ("plan", "implement", "test")
VALID_SCOPE_TARGETS = ("diff", "affected", "full-regression")
_SCOPE_KEYS = ("labels", "paths", "milestone", "query", "target")
```

After `_is_positive_int` add:

```python
def _is_nonempty_str(v):
    return isinstance(v, str) and bool(v.strip())


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
```

Inside `validate_roles`'s per-role loop, directly after the `instances` check, add:

```python
        if "account" in cfg and not _is_nonempty_str(cfg.get("account")):
            errors.append("roles.%s: account must be a non-empty account name"
                          % name)
        for field in ("model", "effort"):
            if field in cfg and not _is_nonempty_str(cfg.get(field)):
                errors.append("roles.%s: %s must be a non-empty string"
                              % (name, field))
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m unittest tests.test_roles -v`
Expected: ALL PASS (including the pre-existing classes — the design-doc example with `scope: diff`
must still validate via the bare-target shorthand).

- [ ] **Step 5: Commit**

```bash
git add lib/roles.py tests/test_roles.py
git commit -m "feat: roles schema carries account/model/effort/models/scope (increment 2)"
```

---

### Task 3: validate_roles — behaviour knobs

The knob table from the spec (QA gate/tools/regression, Researcher output/web_search, PM duties,
Coder self_test/blockers). Knobs validate **by value wherever they appear** — a custom agent may
use any of them; the engine does not tie knobs to the standard roster names.

**Files:**
- Modify: `lib/roles.py` (knob constants; `_validate_knobs` helper; one call in `validate_roles`)
- Test: `tests/test_roles.py` (append a test class)

**Interfaces:**
- Consumes: `_is_nonempty_str`, `_is_positive_int`, `cron_next_fire` (all existing/Task 2).
- Produces (Task 5's template comments quote these values):
  - `VALID_GATES = ("wait-for-human", "auto-merge-on-pass")`
  - `VALID_TOOLS = ("read", "mcp")`
  - `VALID_OUTPUTS = ("raise-issues", "handoff-to-pm")`
  - `VALID_DUTIES = ("groom", "prioritise", "unblock", "spec-check")`
  - `VALID_BLOCKERS = ("raise-to-pm", "raise-to-human")`
  - `_validate_knobs(name, cfg) -> [error strings]`

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_roles.py`:

```python
class TestBehaviourKnobs(unittest.TestCase):
    """QA/PM/Researcher/Coder behaviour knobs -- validated by value wherever
    they appear (custom agents get the same knobs)."""

    def test_spec_knob_examples_validate(self):
        cfg = parse(
            "roles:\n"
            "  qa:\n"
            "    gate: wait-for-human\n"
            "    tools: [read, mcp]\n"
            '    regression: { every: "0 3 * * 0" }\n'
            "  researcher:\n"
            "    output: handoff-to-pm\n"
            "    web_search: true\n"
            "  pm:\n"
            "    duties: [groom, prioritise, unblock, spec-check]\n"
            "  coder:\n"
            "    self_test: true\n"
            "    blockers: raise-to-pm\n")
        self.assertEqual(roles.validate_roles(cfg), [])

    def test_gate_enum(self):
        cfg = parse("roles:\n  qa:\n    gate: yolo-merge\n")
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("gate" in e and "yolo-merge" in e for e in errs))

    def test_output_enum(self):
        cfg = parse("roles:\n  researcher:\n    output: tweet\n")
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("output" in e for e in errs))

    def test_blockers_enum(self):
        cfg = parse("roles:\n  coder:\n    blockers: give-up\n")
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("blockers" in e for e in errs))

    def test_bool_knobs_must_be_bool(self):
        for knob in ("web_search", "self_test"):
            cfg = parse("roles:\n  r:\n    %s: yes\n" % knob)  # bare 'yes' parses as string
            errs = roles.validate_roles(cfg)
            self.assertTrue(any(knob in e for e in errs),
                            "expected an error for non-bool %s" % knob)

    def test_tools_subset(self):
        cfg = parse("roles:\n  qa:\n    tools: [read, bash]\n")
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("tools" in e for e in errs))

    def test_tools_empty_list_invalid(self):
        cfg = parse("roles:\n  qa:\n    tools: []\n")
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("tools" in e for e in errs))

    def test_duties_subset(self):
        cfg = parse("roles:\n  pm:\n    duties: [groom, moan]\n")
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("duties" in e for e in errs))

    def test_regression_after_tickets(self):
        cfg = parse("roles:\n  qa:\n    regression: { after_tickets: 10 }\n")
        self.assertEqual(roles.validate_roles(cfg), [])

    def test_regression_after_tickets_positive(self):
        cfg = parse("roles:\n  qa:\n    regression: { after_tickets: 0 }\n")
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("after_tickets" in e for e in errs))

    def test_regression_bad_cron(self):
        cfg = parse('roles:\n  qa:\n    regression: { every: "not cron" }\n')
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("regression" in e for e in errs))

    def test_regression_needs_exactly_one_key(self):
        cfg = parse('roles:\n  qa:\n    regression: { every: "0 3 * * 0", after_tickets: 5 }\n')
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("regression" in e for e in errs))
        cfg = parse("roles:\n  qa:\n    regression: {}\n")
        errs = roles.validate_roles(cfg)
        self.assertTrue(any("regression" in e for e in errs))
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m unittest tests.test_roles.TestBehaviourKnobs -v`
Expected: FAIL on every enum/shape test (unknown fields are ignored today);
`test_spec_knob_examples_validate` and `test_regression_after_tickets` pass.

- [ ] **Step 3: Implement**

In `lib/roles.py`, after `_SCOPE_KEYS` add:

```python
VALID_GATES = ("wait-for-human", "auto-merge-on-pass")
VALID_TOOLS = ("read", "mcp")
VALID_OUTPUTS = ("raise-issues", "handoff-to-pm")
VALID_DUTIES = ("groom", "prioritise", "unblock", "spec-check")
VALID_BLOCKERS = ("raise-to-pm", "raise-to-human")
_ENUM_KNOBS = (("gate", VALID_GATES), ("output", VALID_OUTPUTS),
               ("blockers", VALID_BLOCKERS))
_BOOL_KNOBS = ("web_search", "self_test")
```

After `_validate_scope` add:

```python
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
```

(`cron_next_fire` is defined later in the module — resolved at call time, fine.)

In `validate_roles`'s per-role loop, directly after the `_validate_scope` call from Task 2, add:

```python
        errors.extend(_validate_knobs(name, cfg))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m unittest tests.test_roles -v`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/roles.py tests/test_roles.py
git commit -m "feat: validate role behaviour knobs (gate/tools/regression/output/duties/self_test/blockers)"
```

---

### Task 4: check_accounts + CLI wiring + docstring

A role's `account:` must name an entry in the machine accounts registry (`lib/accounts.py`,
increment 1). Pure check takes the known names; the CLI entry loads the real registry.
Missing registry file ⇒ `Accounts().list()` returns `[]` ⇒ every reference errors — fail-safe,
matching `resolve()`'s "never run with broken auth".

**Files:**
- Modify: `lib/roles.py` (new `check_accounts` after `check_prompt_files`; `main` wiring; module
  docstring update)
- Test: `tests/test_roles.py` (two test classes)

**Interfaces:**
- Consumes: `accounts.Accounts(index_path=...).list() -> [{name, kind, ...}]` (increment 1);
  `default_index_path()` honours `$HOME`.
- Produces: `check_accounts(config, known_account_names) -> [error strings]` — Task 5's doctor
  tests exercise it through the CLI.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_roles.py` (also add `import json` and `import subprocess` — only if this
step's code needs them; the in-process approach below needs `json` only):

```python
class TestCheckAccounts(unittest.TestCase):
    """account: must name an entry in the accounts registry. Pure -- known
    names injected, same seam as check_prompt_files."""

    def test_known_account_passes(self):
        cfg = parse("roles:\n  coder:\n    account: claude-sub\n")
        self.assertEqual(roles.check_accounts(cfg, ["claude-sub"]), [])

    def test_unknown_account_is_error(self):
        cfg = parse("roles:\n  coder:\n    account: nope\n")
        errs = roles.check_accounts(cfg, ["claude-sub"])
        self.assertEqual(len(errs), 1)
        self.assertIn("nope", errs[0])
        self.assertIn("coder", errs[0])

    def test_empty_registry_fails_any_reference(self):
        cfg = parse("roles:\n  coder:\n    account: claude-sub\n")
        self.assertEqual(len(roles.check_accounts(cfg, [])), 1)

    def test_no_account_field_is_fine(self):
        cfg = parse("roles:\n  coder:\n    enabled: true\n")
        self.assertEqual(roles.check_accounts(cfg, []), [])

    def test_malformed_account_left_to_validate_roles(self):
        # shape errors are validate_roles' verdict; no duplicate report here
        cfg = parse('roles:\n  coder:\n    account: ""\n')
        self.assertEqual(roles.check_accounts(cfg, []), [])


class TestMainAccountWiring(unittest.TestCase):
    """roles.py <target-repo> folds check_accounts in, loading the registry
    from $HOME/.config/autonomy/accounts (accounts.py's default path)."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.repo = os.path.join(self.tmp, "repo")
        os.makedirs(os.path.join(self.repo, ".autonomy"))
        self.home = os.path.join(self.tmp, "home")
        os.makedirs(os.path.join(self.home, ".config", "autonomy"))
        with open(os.path.join(self.home, ".config", "autonomy", "accounts"),
                  "w", encoding="utf-8") as fh:
            json.dump({"accounts": {"claude-sub":
                                    {"kind": "claude_subscription"}}}, fh)
        self._old_home = os.environ.get("HOME")
        os.environ["HOME"] = self.home
        self.addCleanup(self._restore_home)

    def _restore_home(self):
        if self._old_home is None:
            os.environ.pop("HOME", None)
        else:
            os.environ["HOME"] = self._old_home

    def _write_config(self, text):
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"),
                  "w", encoding="utf-8") as fh:
            fh.write(text)

    def test_known_account_exits_0(self):
        self._write_config("roles:\n  coder:\n    account: claude-sub\n"
                           "    trigger: { type: loop }\n")
        self.assertEqual(roles.main(["roles.py", self.repo]), 0)

    def test_unknown_account_exits_1(self):
        self._write_config("roles:\n  coder:\n    account: no-such\n"
                           "    trigger: { type: loop }\n")
        self.assertEqual(roles.main(["roles.py", self.repo]), 1)

    def test_no_roles_block_still_exits_3(self):
        self._write_config("engine:\n  requires_claude_md: false\n")
        self.assertEqual(roles.main(["roles.py", self.repo]), 3)
```

Add `import json` and `import shutil` to the test file's imports if not already present.

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m unittest tests.test_roles.TestCheckAccounts tests.test_roles.TestMainAccountWiring -v`
Expected: `TestCheckAccounts` ERRORs with `AttributeError: module 'roles' has no attribute
'check_accounts'`; `TestMainAccountWiring.test_unknown_account_exits_1` FAILs (main returns 0
today). `test_unknown_account_exits_1` printing nothing/errors to stdout is fine.

- [ ] **Step 3: Implement**

In `lib/roles.py`, after `check_prompt_files`, add:

```python
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
                          "python3 lib/accounts.py set %s <kind> [credential]"
                          % (name, account, account))
    return errors
```

In `main`, replace the errors line:

```python
    errors = validate_roles(config) + check_prompt_files(config, repo)
```

with:

```python
    import accounts as accounts_mod
    known = [e["name"] for e in accounts_mod.Accounts().list()]
    errors = (validate_roles(config) + check_prompt_files(config, repo)
              + check_accounts(config, known))
```

(`Accounts().list()` only reads the JSON index — the Keychain is never touched; a missing index
reads as an empty registry.)

Update the module docstring's schema block (lines 6–27) to:

```python
"""Role config schema for the multi-role org -- the single source of truth
for role enums, the standard roster's defaults, and `roles:` block
validation. Stdlib only.

The schema (docs/superpowers/specs/2026-07-02-dynamic-agent-org-design.md):

    roles:
      <name>:
        enabled: true|false
        account: <name in the accounts registry>   # lib/accounts.py
        trigger: { type: loop | cron | event, ... } # or block form
        model: <model id>          effort: <level>
        models: { plan: ..., implement: ..., test: ... }   # per-phase override
        scope: { labels: [...], paths: [...], milestone: ..., query: ...,
                 target: diff|affected|full-regression }   # or bare target
        instances: <positive int>          # optional (parallel loop count)
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m unittest tests.test_roles -v`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/roles.py tests/test_roles.py
git commit -m "feat: roles.py validates account references against the accounts registry"
```

---

### Task 5: Doctor surface tests + pack template rewrite + full verification

doctor.sh already runs `python3 lib/roles.py <repo>` and reports its exit code — the new checks
surface with **zero doctor.sh code changes**. Add bash tests proving the account check reaches
doctor's seam, rewrite the pack template's commented `roles:` example to the new schema, then run
everything.

**Files:**
- Test: `tests/test_doctor.sh` (append two checks inside the roles section)
- Modify: `templates/autonomy-pack/config.yaml` (the commented roles block, roughly lines 36–65)

**Interfaces:**
- Consumes: `roles.py <target-repo>` exit codes (Task 4); registry path
  `$HOME/.config/autonomy/accounts`.
- Produces: nothing downstream — final verification gate.

- [ ] **Step 1: Add the doctor-side tests**

In `tests/test_doctor.sh`, after the `missing prompt file` checks (after the
`mkdir -p "$tmp/.autonomy/roles"; touch "$tmp/.autonomy/roles/pm.md"` line and any checks tied to
it, before the next section), insert:

```bash
# --- roles.account -> accounts registry (agent-org increment 2) ---
fake_home="$tmp/fakehome"
mkdir -p "$fake_home/.config/autonomy"
printf '{"accounts": {"claude-sub": {"kind": "claude_subscription"}}}\n' \
  > "$fake_home/.config/autonomy/accounts"
cat > "$tmp/.autonomy/config.yaml" <<'YAML'
engine:
  requires_claude_md: false
roles:
  coder:
    account: claude-sub
    trigger: { type: loop }
YAML
check "role account present in registry -> roles.py passes" "0" \
  "$(HOME="$fake_home" python3 "$HERE/../lib/roles.py" "$tmp" >/dev/null 2>&1; echo $?)"

cat > "$tmp/.autonomy/config.yaml" <<'YAML'
engine:
  requires_claude_md: false
roles:
  coder:
    account: no-such-account
    trigger: { type: loop }
YAML
check "role account missing from registry -> roles.py fails" "1" \
  "$(HOME="$fake_home" python3 "$HERE/../lib/roles.py" "$tmp" >/dev/null 2>&1; echo $?)"
```

Careful: if checks after the insertion point reuse `$tmp/.autonomy/config.yaml` without rewriting
it first, restore a config equivalent to what they expect (read the surrounding test flow before
inserting; every existing section starts by rewriting config.yaml, so this should not arise).

- [ ] **Step 2: Run the doctor tests**

Run: `bash tests/test_doctor.sh`
Expected: all `ok` lines including the two new ones, exit 0.

- [ ] **Step 3: Rewrite the template's roles example**

In `templates/autonomy-pack/config.yaml`, replace the commented roles block (the comment header
starting "# enabled + substrate ..." through the `#     prompt: .autonomy/roles/researcher.md`
line) with:

```yaml
# Multi-role org (autonomy-engine docs/superpowers/specs/
# 2026-07-02-dynamic-agent-org-design.md). Every agent -- standard or custom
# -- is the same declarative shape: enabled + account (a name from the
# machine accounts registry: python3 lib/accounts.py list) + trigger
# ({ type: loop | cron | event, ... }) + model/effort (or per-phase models)
# + scope (what it works over; empty = whole open board) + behaviour knobs.
# `prompt:` must point at a real pack file under .autonomy/roles/, never a
# copy. Validate with doctor.sh.
# roles:
#   coder:
#     enabled: true
#     account: claude-sub              # accounts.py set claude-sub claude_subscription
#     trigger: { type: loop }
#     model: claude-sonnet-5
#     models: { plan: claude-opus-4-8, implement: claude-sonnet-5, test: claude-haiku-4-5 }
#     scope: { labels: [ready], milestone: current }
#     self_test: true                  # agents test their own work
#     blockers: raise-to-pm            # raise-to-pm | raise-to-human
#     instances: 1
#   qa:
#     enabled: false
#     account: claude-sub
#     trigger: { type: event, on: [pr.opened, pr.synchronize] }
#     scope: { target: diff }          # diff | affected | full-regression
#     gate: wait-for-human             # wait-for-human | auto-merge-on-pass (still gated by merge_gate.strategy)
#     tools: [read]                    # [read] | [read, mcp]
#     regression: { after_tickets: 10 }  # or { every: "0 3 * * 0" }; omit = off
#     prompt: .autonomy/roles/qa.md
#   pm:
#     enabled: false
#     account: claude-sub
#     trigger: { type: cron, schedule: "0 */6 * * *" }
#     duties: [groom, prioritise, unblock, spec-check]
#     prompt: .autonomy/roles/pm.md
#   researcher:
#     enabled: false
#     account: codex-sub               # accounts.py set codex-sub codex_subscription
#     trigger: { type: cron, schedule: "0 3 * * *" }
#     output: handoff-to-pm            # raise-issues | handoff-to-pm
#     web_search: false
#     prompt: .autonomy/roles/researcher.md
```

Then prove the example is honest — uncomment it mechanically and validate:

```bash
tmpd="$(mktemp -d)"; mkdir -p "$tmpd/.autonomy/roles"
touch "$tmpd/.autonomy/roles/qa.md" "$tmpd/.autonomy/roles/pm.md" "$tmpd/.autonomy/roles/researcher.md"
fake="$tmpd/home"; mkdir -p "$fake/.config/autonomy"
printf '{"accounts": {"claude-sub": {"kind": "claude_subscription"}, "codex-sub": {"kind": "codex_subscription"}}}\n' > "$fake/.config/autonomy/accounts"
sed -n 's/^# \{0,1\}//p' templates/autonomy-pack/config.yaml | sed -n '/^roles:/,$p' > "$tmpd/.autonomy/config.yaml"
HOME="$fake" python3 lib/roles.py "$tmpd"; echo "exit=$?"
rm -rf "$tmpd"
```

Expected: no error lines, `exit=0`. If it prints errors, fix the template (not the validator).

- [ ] **Step 4: Full suite + shellcheck**

```bash
bash tests/run_all.sh
shellcheck -S warning start bin/*.sh bin/agents/*.sh tests/*.sh templates/autonomy-pack/qa/*.sh
```

Expected: `ALL SUITES PASS`; shellcheck silent.

- [ ] **Step 5: Commit**

```bash
git add tests/test_doctor.sh templates/autonomy-pack/config.yaml
git commit -m "feat: doctor surfaces account-registry check; pack template shows increment-2 roles schema"
```

---

### Task 6: PR + review loop

- [ ] **Step 1: Push and open the PR**

```bash
git push -u origin feat/<n>-agent-config-schema
gh pr create --title "feat: agent-config schema — account/scope/models/knobs (agent-org increment 2) (#<n>)" --body "$(cat <<'EOF'
Closes #<n>. Increment 2 of the dynamic agent-org build
(docs/superpowers/specs/2026-07-02-dynamic-agent-org-design.md; increment 1 = PR #57).

## What
- `lib/roles.py` schema extension: roles carry `account`, `model`/`effort`, per-phase `models`,
  `scope` (labels/paths/milestone/query/target, bare-target shorthand kept), and the behaviour
  knobs (`gate`, `tools`, `regression`, `output`, `web_search`, `duties`, `self_test`,
  `blockers`). Knobs validate by value wherever they appear — custom agents share them.
- New `check_accounts(config, known_names)`: every `account:` must name an entry in the machine
  accounts registry (increment 1). Pure, injected names — same seam as `check_prompt_files`.
  CLI entry loads the real registry; doctor.sh surfaces it with zero doctor changes.
- Parser coverage tests locking the increment-2 config shapes (no parser changes needed).
- Pack template's commented `roles:` example rewritten to the new schema and mechanically
  validated in tests.

## Security model
- The accounts registry file holds names/kinds/credential labels only — no secrets; this PR only
  READS it (via `Accounts().list()`, which never touches the Keychain).
- Fail-safe, never fail-open: an `account:` referencing a missing registry entry (or a missing
  registry file) is a validation ERROR — an agent must never start with unresolvable auth.
- `gate: auto-merge-on-pass` is validated as an enum only; execution still routes through
  `merge_gate.strategy` (unchanged in this PR).

## Tradeoffs
- `substrate:` stays accepted (legacy) — dropping it would break existing packs; the spec allows
  it to return as an execution hint later.
- Bare `scope: diff` kept as shorthand for `scope: { target: diff }` (old template compat).
- `regression.every` cron validity reuses `cron_next_fire` rather than a second parser.

## Testing
- `bash tests/run_all.sh` — all suites pass.
- `shellcheck -S warning start bin/*.sh bin/agents/*.sh tests/*.sh templates/autonomy-pack/qa/*.sh` — clean.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: Review loop (per CLAUDE.md — non-negotiable)**

Poll until the review workflow posts on the latest commit AND CI is green:

```bash
gh pr checks <pr> --watch
gh pr view <pr> --comments
```

Address every comment on the branch (FIXED `<sha>` / DEFERRED `#n` / REBUTTED `<reason>`), re-run
`bash tests/run_all.sh` + shellcheck before each push, and wait for a fresh APPROVE on each new
commit. Merge only on APPROVE + green on the most recent commit, then delete the branch and close
the issue.
