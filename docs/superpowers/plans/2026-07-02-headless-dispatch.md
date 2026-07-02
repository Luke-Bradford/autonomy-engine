# Headless Multi-Agent Dispatch Implementation Plan (agent-org increment 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalise `bin/supervisor.sh` to run ANY enabled `roles:` agent whose trigger is
`loop`, exactly the way it runs Coder today: resolve the role's `account:` via
`python3 lib/accounts.py resolve` → export that env session-scoped in a subshell → invoke the
agent adapter with the role's model/effort/prompt/scope.

**Architecture:** `lib/roles.py` grows a `dispatch` CLI (pure functions + thin CLI, same split as
its validation trio): enumerate enabled loop-roles, and print one role's session settings as
`KEY=value` lines. `bin/supervisor.sh` round-robins those roles — one session per loop iteration,
re-enumerated every tick — and generalises the #51-C scoped-key subshell into a scoped-env
subshell fed by `accounts.py resolve` output. The adapter interface (`agent_invoke`,
`agent_classify_outcome`) is untouched; scope reaches the agent as a one-line directive appended
to the hard_rules content in a composed session file.

**Tech Stack:** bash 3.2.57, Python 3 stdlib only, existing test harnesses
(`tests/test_*.sh` source-the-real-script style; `unittest` for python).

**Spec:** `docs/superpowers/specs/2026-07-02-dynamic-agent-org-design.md` — Layer 3, mechanism 1.

## Decisions (the open questions, resolved)

1. **`account:` vs `credential:` precedence — account wins.** If a role sets `account:`, auth
   comes from `accounts.py resolve` and a resolution failure **REFUSES the session** (return 2,
   clear log line — fail-safe, never run on broken auth). Only when no `account:` is set does the
   legacy #51-C per-role `credential:` path run (best-effort, unchanged), else subscription.
2. **Interleave — single supervisor, round-robin, one session per iteration.** The role list is
   re-resolved every tick (config edits apply next session, same philosophy as
   `resolve_session_settings`). The outcome state machine (pace/backoff/limit) is untouched; a
   coder-only config behaves identically to today. No plist-per-agent — that lean is about cron
   (increment 4).
3. **`instances:` — deferred.** Already schema-validated (increment 2). Dispatch surfaces it;
   the supervisor logs a NOTE when `instances > 1` and runs a single instance (no silent cap).
4. **Cron/event roles are NOT dispatched** — increment 4 owns triggers. `dispatch` only emits
   roles whose effective trigger type is `loop`.
5. **Enabled/trigger merge semantics mirror `dashboard_state.build_roles`** (single source of
   truth moves into `roles.py`): standard roster defaults from `DEFAULT_ROLES` (coder
   enabled+loop; pm/qa/researcher disabled), custom roles default `enabled: false`,
   trigger `loop`. No `roles:` block → `["coder"]` (today's behaviour).
6. **Model/effort precedence:** the one-shot dashboard override file (applied last, wins for its
   one session) > CLI flag > role's `model:`/`effort:` > `agent.model.primary`/`agent.effort` >
   hardcoded default. Implemented by
   feeding the role value in as the "CLI" slot only when the real CLI flag is empty, then letting
   `consume_model_override` run last (unchanged).
7. **Fallback model stays global** (`agent.model.fallback`) — roles have no fallback field. YAGNI.
8. **Session log filename unchanged** (`session-<ts>.log` — the dashboard globs it); the role
   lands in the supervisor.log line instead.
9. **Enumeration failure → WARN + coder-only fallback** (conservative default; a broken pack is
   still gated by preflight's doctor check). **Empty enumeration (operator disabled everything) →
   idle**, like an empty board.
10. **Scope-compose failure REFUSES the session** — silently dropping a scope directive would
    *widen* the agent's remit (fail-open). Composing into `$LOGDIR` where we already write logs,
    so this is a can't-happen guard, not a hot path.

## Global Constraints (CI-enforced, from CLAUDE.md)

- macOS `/bin/bash` 3.2.57: NO `mapfile`/`readarray`, NO globstar, NO `declare -A`, NO
  `${var,,}`/`${var^^}`.
- Python 3 **stdlib only**; config parsing only via `lib/config_parser.py`.
- Executable scripts guarded by `[ "${BASH_SOURCE[0]}" = "${0}" ]`; supervisor.sh already is.
- `shellcheck -S warning` clean: `start bin/*.sh bin/agents/*.sh tests/*.sh templates/autonomy-pack/qa/*.sh`.
- Tests source the real script and call real functions; mock only the agent/`gh`/Keychain
  boundary (established seams: `AUTONOMY_CREDENTIALS_BIN`; this plan adds `AUTONOMY_ACCOUNTS_BIN`
  and `AUTONOMY_AGENTS_DIR` in the same pattern).
- Fail-safe never fail-open. Reset-epoch split (supervisor sole writer of `.last_usage_reset`) —
  untouched by this plan. Repo-agnostic `bin/`/`lib/`.
- Branch `feat/<issue>-headless-dispatch`; TDD (see the failing test fail first); frequent
  commits.

## File map

- Modify: `lib/roles.py` — `as_bool`, `dispatch_roles`, `render_scope`, `role_settings`,
  `_load_config` (extracted), `_dispatch_main`, `main` hook.
- Modify: `lib/dashboard_state.py:616-619` — `_as_bool` becomes an alias of `roles.as_bool` (DRY).
- Modify: `bin/supervisor.sh` — `select_role`, `resolve_dispatch_roles`, `resolve_role_dispatch`,
  `resolve_account_env`, `invoke_scoped_env` (+ `invoke_scoped_key` rewrapped),
  `compose_session_rules`, role-aware `resolve_session_settings`, generalised `run_session`,
  round-robin main loop, `AUTONOMY_AGENTS_DIR` seam.
- Test: `tests/test_roles.py` (extend), `tests/test_headless_dispatch.sh` (new — auto-discovered
  by `run_all.sh`'s glob).
- Docs: `templates/autonomy-pack/config.yaml` roles comment, `CLAUDE.md` layout line.

---

### Task 1: `lib/roles.py` dispatch pure functions

**Files:**
- Modify: `lib/roles.py` (after `check_accounts`, before `_cron_field`)
- Modify: `lib/dashboard_state.py:616-619`
- Test: `tests/test_roles.py`

**Interfaces:**
- Consumes: `DEFAULT_ROLES`, `_is_nonempty_str`, `_SCOPE_KEYS` (already in `lib/roles.py`).
- Produces (used by Task 2's CLI and referenced nowhere else):
  - `as_bool(v) -> bool`
  - `dispatch_roles(config: dict) -> list[str]`
  - `render_scope(scope) -> str` (one line, `""` when empty)
  - `role_settings(config: dict, name: str) -> dict` with keys
    `account, model, effort, prompt, scope` (all `str`, `""` when unset) and `instances` (int ≥ 1);
    raises `KeyError` when `name` is not in `dispatch_roles(config)`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_roles.py` (before the CLI test class if one exists at the end; placement
anywhere top-level is fine):

```python
class TestDispatchRoles(unittest.TestCase):
    def test_no_roles_block_defaults_to_coder(self):
        self.assertEqual(roles.dispatch_roles({}), ["coder"])
        self.assertEqual(roles.dispatch_roles({"agent": {"type": "claude"}}),
                         ["coder"])

    def test_standard_defaults_only_coder_runs(self):
        cfg = parse("roles:\n  pm:\n    trigger: { type: cron, schedule: \"0 0 * * *\" }\n")
        self.assertEqual(roles.dispatch_roles(cfg), ["coder"])

    def test_enabled_loop_roles_run_standard_order_first(self):
        cfg = parse(
            "roles:\n"
            "  qa:\n"
            "    enabled: true\n"
            "    trigger: { type: loop }\n"
            "  helper:\n"
            "    enabled: true\n"
            "  coder:\n"
            "    enabled: true\n")
        # standard roster order (coder, pm, qa, researcher), then custom
        self.assertEqual(roles.dispatch_roles(cfg), ["coder", "qa", "helper"])

    def test_disabled_coder_does_not_run(self):
        cfg = parse("roles:\n  coder:\n    enabled: false\n")
        self.assertEqual(roles.dispatch_roles(cfg), [])

    def test_cron_and_event_roles_are_not_dispatched(self):
        cfg = parse(
            "roles:\n"
            "  researcher:\n"
            "    enabled: true\n"
            "    trigger: { type: cron, schedule: \"0 3 * * *\" }\n"
            "  qa:\n"
            "    enabled: true\n"
            "    trigger: { type: event, on: [pr.opened] }\n")
        self.assertEqual(roles.dispatch_roles(cfg), ["coder"])

    def test_custom_role_needs_explicit_enabled(self):
        cfg = parse("roles:\n  helper:\n    account: claude-sub\n")
        self.assertEqual(roles.dispatch_roles(cfg), ["coder"])

    def test_standard_trigger_default_applies(self):
        # pm's roster default trigger is cron -> enabling it alone does not
        # make it a loop role
        cfg = parse("roles:\n  pm:\n    enabled: true\n")
        self.assertEqual(roles.dispatch_roles(cfg), ["coder"])

    def test_unsafe_role_names_filtered(self):
        # a name that could not survive shell word-splitting is never emitted
        self.assertEqual(
            roles.dispatch_roles({"roles": {"bad name": {"enabled": True}}}),
            ["coder"])

    def test_non_dict_roles_block_defaults(self):
        self.assertEqual(roles.dispatch_roles({"roles": "garbage"}), ["coder"])


class TestRenderScope(unittest.TestCase):
    def test_empty_scope_renders_nothing(self):
        self.assertEqual(roles.render_scope(None), "")
        self.assertEqual(roles.render_scope({}), "")

    def test_bare_target_shorthand(self):
        self.assertEqual(roles.render_scope("diff"),
                         "Scope: work ONLY within this scope: target: diff.")

    def test_mapping_renders_schema_order_one_line(self):
        line = roles.render_scope({"milestone": "current",
                                   "labels": ["ready", "bug"]})
        self.assertEqual(
            line,
            "Scope: work ONLY within this scope: "
            "labels: ready, bug; milestone: current.")
        self.assertNotIn("\n", line)

    def test_garbage_scope_renders_nothing(self):
        self.assertEqual(roles.render_scope(42), "")


class TestRoleSettings(unittest.TestCase):
    CFG = (
        "roles:\n"
        "  coder:\n"
        "    enabled: true\n"
        "    account: claude-sub\n"
        "    model: claude-opus-4-8\n"
        "    effort: high\n"
        "    scope: { labels: [ready] }\n"
        "    prompt: .autonomy/roles/coder.md\n"
        "    instances: 2\n"
        "  qa:\n"
        "    enabled: true\n"
        "    trigger: { type: loop }\n")

    def test_full_settings(self):
        s = roles.role_settings(parse(self.CFG), "coder")
        self.assertEqual(s["account"], "claude-sub")
        self.assertEqual(s["model"], "claude-opus-4-8")
        self.assertEqual(s["effort"], "high")
        self.assertEqual(s["prompt"], ".autonomy/roles/coder.md")
        self.assertEqual(s["scope"],
                         "Scope: work ONLY within this scope: labels: ready.")
        self.assertEqual(s["instances"], 2)

    def test_unset_fields_are_empty(self):
        s = roles.role_settings(parse(self.CFG), "qa")
        self.assertEqual(
            s, {"account": "", "model": "", "effort": "", "prompt": "",
                "scope": "", "instances": 1})

    def test_default_coder_with_no_roles_block(self):
        s = roles.role_settings({}, "coder")
        self.assertEqual(s["account"], "")
        self.assertEqual(s["instances"], 1)

    def test_undispatchable_role_raises(self):
        with self.assertRaises(KeyError):
            roles.role_settings(parse(self.CFG), "researcher")
        with self.assertRaises(KeyError):
            roles.role_settings({}, "qa")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m unittest tests.test_roles.TestDispatchRoles tests.test_roles.TestRenderScope tests.test_roles.TestRoleSettings -v`
Expected: FAIL/ERROR with `AttributeError: module 'roles' has no attribute 'dispatch_roles'`

- [ ] **Step 3: Implement in `lib/roles.py`**

Add `import re` to the imports block at the top (alphabetical: after `import os`). Add after
`check_accounts` (before `_cron_field`):

```python
# Role names land in supervisor shell word-splitting and log lines: same safe
# charset as account names (lib/accounts.py). dispatch never emits others.
_ROLE_NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


def as_bool(v):
    """Config booleans arrive as real bools from config_parser but may be
    strings from older/hand-edited packs -- one lenient reading, shared with
    the dashboard (dashboard_state aliases this)."""
    if isinstance(v, bool):
        return v
    return str(v).strip().lower() in ("true", "1", "yes", "on")


def _effective(cfg, key_default_pairs):
    """(enabled, trigger_type) for a role config dict, given its roster
    defaults. Defensive against non-dict shapes -- dispatch may see a config
    that validate_roles would reject; it must degrade, not crash."""
    cfg = cfg if isinstance(cfg, dict) else {}
    d_enabled, d_trig = key_default_pairs
    enabled = as_bool(cfg.get("enabled")) if "enabled" in cfg else d_enabled
    trigger = cfg.get("trigger")
    ttype = trigger.get("type") if isinstance(trigger, dict) else None
    return enabled, (ttype or d_trig)


def dispatch_roles(config):
    """Names of the roles the supervisor's loop dispatches, in a stable
    order: standard roster first (DEFAULT_ROLES order), then custom roles in
    config order. A role is dispatched iff effectively enabled AND its
    effective trigger type is 'loop' -- cron/event roles belong to increment
    4's scheduler/event bus. Merge semantics mirror the dashboard roster
    (dashboard_state.build_roles): standard roles default from DEFAULT_ROLES,
    custom roles default to enabled=false / trigger=loop. No roles: block ->
    ['coder'] (today's behaviour)."""
    roles_blk = (config.get("roles") or {}) if isinstance(config, dict) else {}
    if not isinstance(roles_blk, dict):
        roles_blk = {}
    out = []
    for name, d_enabled, _sub, d_trig in DEFAULT_ROLES:
        enabled, ttype = _effective(roles_blk.get(name), (d_enabled, d_trig))
        if enabled and ttype == "loop":
            out.append(name)
    standard = tuple(r[0] for r in DEFAULT_ROLES)
    for name, cfg in roles_blk.items():
        if name in standard or not _ROLE_NAME_RE.match(str(name)):
            continue
        enabled, ttype = _effective(cfg, (False, "loop"))
        if enabled and ttype == "loop":
            out.append(name)
    return out


def render_scope(scope):
    """One-line scope directive for the session's system prompt -- the
    supervisor appends it to the pack's hard_rules. '' when scope is absent
    or empty (whole open board, today's behaviour). The bare-string
    shorthand ('scope: diff') renders as its target. Never multi-line: the
    value crosses a KEY=value pipe to bash."""
    if not scope:
        return ""
    if isinstance(scope, str):
        parts = [("target", scope)]
    elif isinstance(scope, dict):
        parts = []
        for key in _SCOPE_KEYS:  # stable schema order
            if key not in scope:
                continue
            val = scope[key]
            if isinstance(val, list):
                val = ", ".join(str(v) for v in val)
            parts.append((key, str(val)))
        if not parts:
            return ""
    else:
        return ""
    rendered = "; ".join("%s: %s" % (k, v) for k, v in parts)
    return "Scope: work ONLY within this scope: %s." % rendered


def role_settings(config, name):
    """The session settings the supervisor needs to dispatch `name`:
    account/model/effort/prompt/scope as strings ('' = unset, supervisor
    falls back to its agent.* resolution) plus instances (int >= 1).
    KeyError when the role is not dispatchable (not in dispatch_roles) --
    the CLI turns that into exit 1 so the supervisor refuses cleanly."""
    if name not in dispatch_roles(config):
        raise KeyError(name)
    roles_blk = (config.get("roles") or {}) if isinstance(config, dict) else {}
    cfg = roles_blk.get(name) if isinstance(roles_blk, dict) else None
    if not isinstance(cfg, dict):
        cfg = {}

    def _s(key):
        v = cfg.get(key)
        return str(v).strip() if _is_nonempty_str(v) else ""

    instances = cfg.get("instances")
    instances = int(str(instances)) if _is_positive_int(instances) else 1
    return {"account": _s("account"), "model": _s("model"),
            "effort": _s("effort"), "prompt": _s("prompt"),
            "scope": render_scope(cfg.get("scope")), "instances": instances}
```

In `lib/dashboard_state.py`, replace the `_as_bool` definition (lines 616-619):

```python
_as_bool = roles_schema.as_bool
```

(keep the surrounding blank lines; `roles_schema` is already imported there).

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m unittest tests.test_roles tests.test_dashboard_state -v`
Expected: PASS (all, including the pre-existing classes)

- [ ] **Step 5: Commit**

```bash
git add lib/roles.py lib/dashboard_state.py tests/test_roles.py
git commit -m "feat: roles.py dispatch_roles/role_settings/render_scope — enabled loop-role enumeration (agent-org increment 3, task 1)"
```

---

### Task 2: `roles.py dispatch` CLI subcommand

**Files:**
- Modify: `lib/roles.py` (`main`, new `_load_config`, `_dispatch_main`)
- Test: `tests/test_roles.py`

**Interfaces:**
- Consumes: Task 1's `dispatch_roles`, `role_settings`.
- Produces (the supervisor's contract, Tasks 3-4):
  - `python3 lib/roles.py dispatch <target-repo>` → enabled loop-role names one per line
    (possibly none), exit 0; exit 2 config unreadable; exit 1 config unparseable.
  - `python3 lib/roles.py dispatch <target-repo> <role>` → exactly six lines
    `ACCOUNT=…`, `MODEL=…`, `EFFORT=…`, `PROMPT=…`, `SCOPE=…`, `INSTANCES=…` (values may be
    empty), exit 0; exit 1 when `<role>` is not an enabled loop role.
  - Existing `python3 lib/roles.py <target-repo>` validation CLI unchanged (doctor.sh consumes it).

- [ ] **Step 1: Write the failing tests**

Look at the existing CLI test class at the bottom of `tests/test_roles.py` (the one holding
`test_known_account_exits_0` etc.) and mirror its fixture approach for building a temp repo with
`.autonomy/config.yaml` (it already builds one — reuse its helper if there is one; otherwise this
class builds its own). Append:

```python
class TestDispatchCli(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        os.makedirs(os.path.join(self.tmp, ".autonomy"))

    def _write(self, text):
        with open(os.path.join(self.tmp, ".autonomy", "config.yaml"),
                  "w", encoding="utf-8") as fh:
            fh.write(text)

    def _run(self, *argv):
        import io
        from contextlib import redirect_stdout
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = roles.main(["roles.py"] + list(argv))
        return rc, buf.getvalue()

    def test_enumerate_default_roster(self):
        self._write("agent:\n  type: claude\n")
        rc, out = self._run("dispatch", self.tmp)
        self.assertEqual(rc, 0)
        self.assertEqual(out, "coder\n")

    def test_enumerate_enabled_loop_roles(self):
        self._write("roles:\n"
                    "  coder:\n    enabled: true\n"
                    "  qa:\n    enabled: true\n    trigger: { type: loop }\n")
        rc, out = self._run("dispatch", self.tmp)
        self.assertEqual(rc, 0)
        self.assertEqual(out.split(), ["coder", "qa"])

    def test_enumerate_all_disabled_prints_nothing(self):
        self._write("roles:\n  coder:\n    enabled: false\n")
        rc, out = self._run("dispatch", self.tmp)
        self.assertEqual(rc, 0)
        self.assertEqual(out, "")

    def test_role_settings_key_value_lines(self):
        self._write("roles:\n"
                    "  coder:\n"
                    "    enabled: true\n"
                    "    account: claude-sub\n"
                    "    model: claude-opus-4-8\n"
                    "    scope: { labels: [ready] }\n")
        rc, out = self._run("dispatch", self.tmp, "coder")
        self.assertEqual(rc, 0)
        lines = out.splitlines()
        self.assertIn("ACCOUNT=claude-sub", lines)
        self.assertIn("MODEL=claude-opus-4-8", lines)
        self.assertIn("EFFORT=", lines)
        self.assertIn("PROMPT=", lines)
        self.assertIn(
            "SCOPE=Scope: work ONLY within this scope: labels: ready.", lines)
        self.assertIn("INSTANCES=1", lines)
        self.assertEqual(len(lines), 6)

    def test_undispatchable_role_exits_1(self):
        self._write("agent:\n  type: claude\n")
        rc, _ = self._run("dispatch", self.tmp, "qa")
        self.assertEqual(rc, 1)

    def test_unreadable_config_exits_2(self):
        rc, _ = self._run("dispatch", os.path.join(self.tmp, "nope"))
        self.assertEqual(rc, 2)

    def test_validation_cli_still_works(self):
        self._write("agent:\n  type: claude\n")
        rc, _ = self._run(self.tmp)
        self.assertEqual(rc, 3)  # valid, no roles: block
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m unittest tests.test_roles.TestDispatchCli -v`
Expected: FAIL — the existing `main` prints usage / returns 2 for `dispatch` argv shapes
(`test_enumerate_default_roster` fails on rc or output).

- [ ] **Step 3: Implement in `lib/roles.py`**

Extract config loading (the existing `main` body duplicates it) and add the subcommand. Replace
the current `main` with:

```python
def _load_config(repo):
    """(config, rc) -- rc 0 on success, else the CLI exit code (2 unreadable,
    1 unparseable) with an explanation on stderr. Shared by the validation
    and dispatch entries."""
    cfg_path = os.path.join(repo, ".autonomy", "config.yaml")
    import config_parser
    try:
        with open(cfg_path, encoding="utf-8") as fh:
            return config_parser.parse(fh.read()), 0
    except OSError as exc:
        print("roles: cannot read %s: %s" % (cfg_path, exc), file=sys.stderr)
        return None, 2
    except ValueError as exc:
        print("roles: config.yaml does not parse: %s" % exc, file=sys.stderr)
        return None, 1


def _dispatch_main(argv):
    """`roles.py dispatch <target-repo> [role]` -- the supervisor's dispatch
    contract. Without a role: enabled loop-role names, one per line (may be
    none). With a role: the six KEY=value session-settings lines. Exit 1 on
    an undispatchable role (the supervisor REFUSES that session, fail-safe)."""
    if len(argv) not in (2, 3):
        print("usage: roles.py dispatch <target-repo> [role]", file=sys.stderr)
        return 2
    config, rc = _load_config(argv[1])
    if rc:
        return rc
    if len(argv) == 2:
        for name in dispatch_roles(config):
            print(name)
        return 0
    try:
        s = role_settings(config, argv[2])
    except KeyError:
        print("roles: %r is not an enabled loop role" % argv[2],
              file=sys.stderr)
        return 1
    for key in ("account", "model", "effort", "prompt", "scope"):
        print("%s=%s" % (key.upper(), s[key]))
    print("INSTANCES=%d" % s["instances"])
    return 0


def main(argv):
    if len(argv) >= 2 and argv[1] == "dispatch":
        return _dispatch_main(argv[1:])
    if len(argv) != 2:
        print("usage: roles.py <target-repo> | roles.py dispatch "
              "<target-repo> [role]", file=sys.stderr)
        return 2
    repo = argv[1]
    config, rc = _load_config(repo)
    if rc:
        return rc
    import accounts as accounts_mod
    known = [e["name"] for e in accounts_mod.Accounts().list()]
    errors = (validate_roles(config) + check_prompt_files(config, repo)
              + check_accounts(config, known))
    for e in errors:
        print(e)
    if errors:
        return 1
    return 0 if config.get("roles") else 3
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m unittest tests.test_roles -v`
Expected: PASS (all classes — including the pre-existing CLI class against the reworked `main`)

- [ ] **Step 5: Commit**

```bash
git add lib/roles.py tests/test_roles.py
git commit -m "feat: roles.py dispatch CLI — enumerate loop roles + per-role session settings (task 2)"
```

---

### Task 3: supervisor dispatch helpers

**Files:**
- Modify: `bin/supervisor.sh` (new helpers after the `# --- per-role API credential (#51-C)` block)
- Test: `tests/test_headless_dispatch.sh` (new)

**Interfaces:**
- Consumes: Task 2's `roles.py dispatch` CLI; `lib/accounts.py resolve` (increment 1, prints
  `VAR=value` lines, exit 1 on unresolvable); existing `agent_invoke` adapter contract.
- Produces (Task 4 wires these into `run_session` and the main loop):
  - `resolve_dispatch_roles` → stdout: role names one per line; rc from `roles.py dispatch`.
  - `resolve_role_dispatch <role>` → rc 0 and sets globals `ROLE_ACCOUNT ROLE_MODEL ROLE_EFFORT
    ROLE_PROMPT ROLE_SCOPE ROLE_INSTANCES`; rc 1 = refuse. Invalid model/effort values are
    warned and blanked (defense-in-depth parity with `consume_model_override`).
  - `resolve_account_env <account>` → stdout: `VAR=value` lines (empty for subscriptions);
    rc 1 = refuse. Test seam: `AUTONOMY_ACCOUNTS_BIN`.
  - `invoke_scoped_env <env-lines> <agent_invoke args…>` → runs `agent_invoke` with each
    `VAR=value` line exported in a subshell only.
  - `invoke_scoped_key <key> <args…>` → unchanged external behaviour (now wraps
    `invoke_scoped_env`); `tests/test_role_credential.sh` must stay green unmodified.
  - `compose_session_rules <rules-file> <scope-line> <out-file>` → prints the path to use;
    rc 1 on compose failure.
  - `select_role <idx> <name…>` → prints `name[idx % count]`; rc 1 when no names.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_headless_dispatch.sh`:

```bash
#!/usr/bin/env bash
# tests/test_headless_dispatch.sh -- headless multi-agent dispatch (agent-org
# increment 3). The supervisor runs ANY enabled loop role: enumeration via
# roles.py dispatch (real python, real parser), account env resolved via the
# AUTONOMY_ACCOUNTS_BIN seam and exported session-scoped only, fail-safe
# refusal on broken auth, scope composed into the session rules file.
# shellcheck disable=SC2034  # vars consumed inside the sourced supervisor.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_HOME="$(cd "$HERE/.." && pwd)"

# shellcheck source=/dev/null
source "$ENGINE_HOME/bin/supervisor.sh"
SUPLOG=/dev/null
log() { :; }

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails + 1)); fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# A minimal target repo: pack files + a roles: block with two loop roles.
AUTONOMY_TARGET_REPO="$tmp/repo"
mkdir -p "$AUTONOMY_TARGET_REPO/.autonomy/roles"
printf 'do the work\n' > "$AUTONOMY_TARGET_REPO/.autonomy/loop_prompt.md"
printf 'hard rules\n' > "$AUTONOMY_TARGET_REPO/.autonomy/hard_rules.md"
printf 'qa prompt\n' > "$AUTONOMY_TARGET_REPO/.autonomy/roles/qa.md"
cat > "$AUTONOMY_TARGET_REPO/.autonomy/config.yaml" <<'YAML'
roles:
  coder:
    enabled: true
    account: acct-good
  qa:
    enabled: true
    trigger: { type: loop }
    account: acct-broken
    model: claude-opus-4-8
    effort: high
    scope: { labels: [ready] }
    prompt: .autonomy/roles/qa.md
YAML

# --- select_role -------------------------------------------------------------
check "select_role picks index 0" "coder" "$(select_role 0 coder qa)"
check "select_role picks index 1" "qa" "$(select_role 1 coder qa)"
check "select_role wraps around" "coder" "$(select_role 2 coder qa)"
check "select_role single role always" "coder" "$(select_role 7 coder)"
select_role 0 >/dev/null 2>&1
check "select_role with no roles fails" "1" "$?"

# --- resolve_dispatch_roles (real roles.py against the real config) ----------
check "enumerates enabled loop roles" "coder qa" "$(resolve_dispatch_roles | tr '\n' ' ' | sed 's/ $//')"

# --- resolve_role_dispatch ---------------------------------------------------
resolve_role_dispatch qa
check "role account parsed" "acct-broken" "$ROLE_ACCOUNT"
check "role model parsed" "claude-opus-4-8" "$ROLE_MODEL"
check "role effort parsed" "high" "$ROLE_EFFORT"
check "role prompt parsed" ".autonomy/roles/qa.md" "$ROLE_PROMPT"
check "role scope parsed" "Scope: work ONLY within this scope: labels: ready." "$ROLE_SCOPE"
check "role instances default" "1" "$ROLE_INSTANCES"

resolve_role_dispatch coder
check "unset role fields come back empty" "" "$ROLE_MODEL"

resolve_role_dispatch researcher >/dev/null 2>&1
check "undispatchable role refuses" "1" "$?"

# an invalid model id from the config is blanked, never passed to argv
cat > "$AUTONOMY_TARGET_REPO/.autonomy/config.yaml" <<'YAML'
roles:
  coder:
    enabled: true
    model: "bad;model"
    effort: bogus
YAML
resolve_role_dispatch coder
check "invalid role model blanked" "" "$ROLE_MODEL"
check "invalid role effort blanked" "" "$ROLE_EFFORT"

# --- resolve_account_env (seam) ----------------------------------------------
cat > "$tmp/accounts-stub" <<'SH'
#!/bin/sh
# args: resolve <name>
if [ "$1" = "resolve" ] && [ "$2" = "acct-good" ]; then
  printf 'ANTHROPIC_API_KEY=sk-acct-77\n'
  exit 0
fi
if [ "$1" = "resolve" ] && [ "$2" = "acct-sub" ]; then
  exit 0
fi
echo "accounts.py: no secret" >&2
exit 1
SH
chmod +x "$tmp/accounts-stub"
export AUTONOMY_ACCOUNTS_BIN="$tmp/accounts-stub"

check "api account resolves env lines" "ANTHROPIC_API_KEY=sk-acct-77" "$(resolve_account_env acct-good)"
check "subscription account resolves empty" "" "$(resolve_account_env acct-sub)"
resolve_account_env acct-broken >/dev/null 2>&1
check "broken account refuses (rc 1)" "1" "$?"

# --- invoke_scoped_env --------------------------------------------------------
envfile="$tmp/seen_env"
agent_invoke() { echo "${ANTHROPIC_API_KEY:-NONE}|${OPENAI_API_KEY:-NONE}" > "$envfile"; return 0; }

unset ANTHROPIC_API_KEY OPENAI_API_KEY
invoke_scoped_env 'ANTHROPIC_API_KEY=sk-a
OPENAI_API_KEY=sk-o' a b c d e
check "multi-line env exported to the session" "sk-a|sk-o" "$(cat "$envfile")"
check "env does not leak into the supervisor" "" "${ANTHROPIC_API_KEY:-}${OPENAI_API_KEY:-}"

invoke_scoped_env "" a b c d e
check "empty env = ambient auth untouched" "NONE|NONE" "$(cat "$envfile")"

invoke_scoped_env 'not a var line
ANTHROPIC_API_KEY=sk-b' a b c d e
check "malformed env lines skipped, valid ones kept" "sk-b|NONE" "$(cat "$envfile")"

# invoke_scoped_key still works (test_role_credential.sh covers it fully;
# this is the wrap-not-regress smoke check)
invoke_scoped_key "sk-legacy" a b c d e
check "invoke_scoped_key wraps scoped env" "sk-legacy|NONE" "$(cat "$envfile")"

# --- compose_session_rules ----------------------------------------------------
rules="$AUTONOMY_TARGET_REPO/.autonomy/hard_rules.md"
out="$(compose_session_rules "$rules" "" "$tmp/composed")"
check "no scope: original rules path" "$rules" "$out"
check "no scope: nothing composed" "1" "$([ -f "$tmp/composed" ] && echo 0 || echo 1)"

out="$(compose_session_rules "$rules" "Scope: only ready." "$tmp/composed")"
check "scope: composed path returned" "$tmp/composed" "$out"
check "scope: rules kept" "hard rules" "$(head -1 "$tmp/composed")"
check "scope: directive appended" "Scope: only ready." "$(tail -1 "$tmp/composed")"

compose_session_rules "$rules" "Scope: x." "$tmp/no-such-dir/out" >/dev/null 2>&1
check "unwritable compose refuses (rc 1)" "1" "$?"

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails CHECK(S) FAILED"; exit 1; fi
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test_headless_dispatch.sh`
Expected: FAIL — `select_role: command not found` (and subsequent checks).

- [ ] **Step 3: Implement the helpers in `bin/supervisor.sh`**

Insert after the `invoke_scoped_key` function (i.e. after line 265), replacing `invoke_scoped_key`
too (shown here in full):

```bash
# Run agent_invoke with $1 -- zero or more VAR=value lines, exactly what
# `accounts.py resolve` prints -- exported in a SUBSHELL, so account keys are
# scoped to the one session and never land in the supervisor's own
# environment (a long-lived process). Empty $1 = whatever auth the ambient
# env already has (subscription). Generalises the #51-C single-key form.
invoke_scoped_env() {
  local env_lines="$1"; shift
  if [ -z "$env_lines" ]; then
    agent_invoke "$@"
    return $?
  fi
  (
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      case "${line%%=*}" in
        ''|*[!A-Za-z0-9_]*) continue ;;   # not a sane env var name -- skip
      esac
      export "${line%%=*}=${line#*=}"
    done <<EOF
$env_lines
EOF
    agent_invoke "$@"
  )
}

# Back-compat single-key form (#51-C): a resolved role credential ("" = none).
invoke_scoped_key() {
  local key="$1"; shift
  if [ -n "$key" ]; then
    invoke_scoped_env "ANTHROPIC_API_KEY=$key" "$@"
  else
    invoke_scoped_env "" "$@"
  fi
}

# --- headless multi-agent dispatch (agent-org increment 3) -------------------
# The supervisor dispatches EVERY enabled `roles:` agent whose trigger is
# `loop`, round-robin -- one session per loop iteration -- exactly the way it
# has always run Coder. Enumeration re-resolves every tick so config edits
# apply on the next session. Cron/event triggers belong to increment 4's
# scheduler/event bus and are never dispatched here.

# Enabled loop-role names, one per line (roles.py dispatch contract). The
# caller handles rc!=0 (fail back to coder-only) and empty output (idle).
resolve_dispatch_roles() {
  python3 "$ENGINE_HOME/lib/roles.py" dispatch "$AUTONOMY_TARGET_REPO" 2>>"$SUPLOG"
}

# Round-robin selector: print argument ((idx mod n)+1) of the names in $2..;
# rc 1 when the list is empty. Role names are [A-Za-z0-9._-] by the dispatch
# contract, so callers may word-split the enumeration safely.
select_role() {
  local idx="$1"; shift
  [ $# -gt 0 ] || return 1
  shift $(( idx % $# ))
  printf '%s' "$1"
}

# Parse `roles.py dispatch <repo> <role>` KEY=value output into ROLE_*
# globals. rc 1 = the role is not dispatchable / settings unreadable -- the
# caller REFUSES the session (fail-safe). Model/effort values came from a
# config a dashboard may write: validate before they can land in argv
# (defense-in-depth parity with consume_model_override).
resolve_role_dispatch() {
  local role="$1" out line key val
  ROLE_ACCOUNT=""; ROLE_MODEL=""; ROLE_EFFORT=""; ROLE_PROMPT=""
  ROLE_SCOPE=""; ROLE_INSTANCES=1
  out="$(python3 "$ENGINE_HOME/lib/roles.py" dispatch "$AUTONOMY_TARGET_REPO" "$role" 2>>"$SUPLOG")" || return 1
  while IFS= read -r line; do
    key="${line%%=*}"; val="${line#*=}"
    case "$key" in
      ACCOUNT)   ROLE_ACCOUNT="$val" ;;
      MODEL)     ROLE_MODEL="$val" ;;
      EFFORT)    ROLE_EFFORT="$val" ;;
      PROMPT)    ROLE_PROMPT="$val" ;;
      SCOPE)     ROLE_SCOPE="$val" ;;
      INSTANCES) ROLE_INSTANCES="$val" ;;
    esac
  done <<EOF
$out
EOF
  if [ -n "$ROLE_MODEL" ] && ! valid_model_id "$ROLE_MODEL"; then
    log "WARN roles.$role.model is not a valid model id -- ignored"
    ROLE_MODEL=""
  fi
  if [ -n "$ROLE_EFFORT" ] && ! valid_effort "$ROLE_EFFORT"; then
    log "WARN roles.$role.effort invalid (valid: low|medium|high|xhigh|max) -- ignored"
    ROLE_EFFORT=""
  fi
  return 0
}

# Resolve an account name to its session env (VAR=value lines) via
# lib/accounts.py (increment 1). Subscriptions print nothing (rc 0). rc 1 =
# unresolvable: the caller MUST refuse the session -- never run on broken
# auth (fail-safe, never fail-open). accounts.py's stderr reason lands in
# the supervisor log; the secret itself is never logged.
# $AUTONOMY_ACCOUNTS_BIN is the test seam (same pattern as
# AUTONOMY_CREDENTIALS_BIN).
resolve_account_env() {
  if [ -n "${AUTONOMY_ACCOUNTS_BIN:-}" ]; then
    "$AUTONOMY_ACCOUNTS_BIN" resolve "$1" 2>>"$SUPLOG"
  else
    python3 "$ENGINE_HOME/lib/accounts.py" resolve "$1" 2>>"$SUPLOG"
  fi
}

# Compose the session's system-prompt file: the pack's hard_rules plus the
# role's one-line scope directive. Prints the path to hand the adapter. No
# scope -> the original hard_rules path untouched. A compose FAILURE refuses
# (rc 1): silently dropping a scope would widen the agent's remit
# (fail-open), so the caller skips the session instead.
compose_session_rules() {
  local rules_file="$1" scope_line="$2" out_file="$3"
  if [ -z "$scope_line" ]; then
    printf '%s' "$rules_file"
    return 0
  fi
  { cat "$rules_file" && printf '\n%s\n' "$scope_line"; } >"$out_file" 2>>"$SUPLOG" || return 1
  printf '%s' "$out_file"
}
```

- [ ] **Step 4: Run the tests**

Run: `bash tests/test_headless_dispatch.sh && bash tests/test_role_credential.sh`
Expected: both `ALL PASS` (`test_role_credential.sh` unmodified — proves the wrap didn't regress
#51-C).

- [ ] **Step 5: Shellcheck**

Run: `shellcheck -S warning bin/supervisor.sh tests/test_headless_dispatch.sh`
Expected: no output. (If `export "${line%%=*}=${line#*=}"` trips SC2163, silence with a
`# shellcheck disable=SC2163` line comment — the var name is validated by the `case` above.)

- [ ] **Step 6: Commit**

```bash
git add bin/supervisor.sh tests/test_headless_dispatch.sh
git commit -m "feat: supervisor dispatch helpers — scoped env subshell, account resolve seam, role settings parse, scope compose (task 3)"
```

---

### Task 4: generalise `run_session` + round-robin main loop

**Files:**
- Modify: `bin/supervisor.sh` (`resolve_session_settings`, `run_session`, main loop, adapter
  source line)
- Test: `tests/test_headless_dispatch.sh` (extend), `tests/test_model_override.sh` (must stay
  green unmodified)

**Interfaces:**
- Consumes: Task 3's helpers (exact names above).
- Produces: `run_session [role]` (default `${ROLE:-coder}` — the pre-increment env contract
  preserved); main loop round-robins `resolve_dispatch_roles` output. The adapter source line
  becomes `source "${AUTONOMY_AGENTS_DIR:-$ENGINE_HOME/bin/agents}/${AGENT_TYPE}.sh"`
  (`AUTONOMY_AGENTS_DIR` = test seam, same pattern as the other two).

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_headless_dispatch.sh` (before the final `echo "---"` block):

```bash
# --- run_session end-to-end (stub adapter via the AUTONOMY_AGENTS_DIR seam) ---
mkdir -p "$tmp/agents"
cat > "$tmp/agents/stub.sh" <<'SH'
agent_invoke() {
  {
    echo "key=${ANTHROPIC_API_KEY:-NONE}"
    echo "prompt=$1"
    echo "rules=$2"
    echo "model=$3"
    echo "effort=${6:-}"
  } > "${STUB_CAPTURE:?}"
  return 0
}
agent_classify_outcome() { echo "success"; }
SH
export AUTONOMY_AGENTS_DIR="$tmp/agents"
AGENT_TYPE=stub
export STUB_CAPTURE="$tmp/capture"

# run_session needs: preflight (needs a real git repo -- stub it: dispatch
# behaviour, not git hygiene, is under test here), CFG, LOGDIR, overrides.
preflight() { return 0; }
CFG="$AUTONOMY_TARGET_REPO/.autonomy/config.yaml"
LOGDIR="$tmp/logs"; mkdir -p "$LOGDIR"
MODEL_OVERRIDE=""; FALLBACK_MODEL_OVERRIDE=""; EFFORT_OVERRIDE=""

# credentials stub: a legacy #51-C key exists for coder (accounts must win)
cat > "$tmp/creds-stub" <<'SH'
#!/bin/sh
if [ "$1" = "resolve-role" ] && [ "$2" = "coder" ]; then printf 'sk-legacy'; exit 0; fi
exit 1
SH
chmod +x "$tmp/creds-stub"
export AUTONOMY_CREDENTIALS_BIN="$tmp/creds-stub"

cat > "$AUTONOMY_TARGET_REPO/.autonomy/config.yaml" <<'YAML'
roles:
  coder:
    enabled: true
    account: acct-good
  qa:
    enabled: true
    trigger: { type: loop }
    model: claude-opus-4-8
    effort: high
    scope: { labels: [ready] }
    prompt: .autonomy/roles/qa.md
  broken:
    enabled: true
    account: acct-broken
YAML

grab() { grep "^$1=" "$STUB_CAPTURE" | head -1 | cut -d= -f2-; }

# 1) account-backed role: account env wins over the legacy credential
unset ANTHROPIC_API_KEY
run_session coder
check "account role: session rc 0" "0" "$?"
check "account role: account key exported (beats #51-C credential)" "sk-acct-77" "$(grab key)"
check "account role: default loop prompt" "$AUTONOMY_TARGET_REPO/.autonomy/loop_prompt.md" "$(grab prompt)"
check "account role: plain hard_rules (no scope)" "$AUTONOMY_TARGET_REPO/.autonomy/hard_rules.md" "$(grab rules)"
check "account role: key never leaks into supervisor" "" "${ANTHROPIC_API_KEY:-}"

# 2) role without account: legacy credential path (best-effort) still runs
: > "$STUB_CAPTURE"
run_session qa
check "credential-less role: session rc 0" "0" "$?"
check "no account: subscription/none (qa has no credential either)" "NONE" "$(grab key)"
check "role model reaches the adapter" "claude-opus-4-8" "$(grab model)"
check "role effort reaches the adapter" "high" "$(grab effort)"
check "role prompt reaches the adapter" "$AUTONOMY_TARGET_REPO/.autonomy/roles/qa.md" "$(grab prompt)"
rules_path="$(grab rules)"
check "scope: composed rules file used" "0" "$([ "$rules_path" != "$AUTONOMY_TARGET_REPO/.autonomy/hard_rules.md" ] && echo 0 || echo 1)"
check "scope: directive present in composed rules" "Scope: work ONLY within this scope: labels: ready." "$(tail -1 "$rules_path")"
check "scope: hard rules kept in composed file" "hard rules" "$(head -1 "$rules_path")"

# 3) fail-safe: an unresolvable account REFUSES the session, adapter never runs
: > "$STUB_CAPTURE"
run_session broken
check "broken account: session refused rc 2" "2" "$?"
check "broken account: adapter never invoked" "" "$(cat "$STUB_CAPTURE")"

# 4) CLI override still beats the role model
MODEL_OVERRIDE="claude-sonnet-5"
run_session qa
check "CLI --model beats roles.qa.model" "claude-sonnet-5" "$(grab model)"
MODEL_OVERRIDE=""

# 5) one-shot dashboard override beats the role model (applied last)
printf 'model=claude-haiku-4-5\n' > "$LOGDIR/model-override"
run_session qa
check "one-shot override beats roles.qa.model" "claude-haiku-4-5" "$(grab model)"
check "one-shot override consumed" "1" "$([ -f "$LOGDIR/model-override" ] && echo 0 || echo 1)"

# 6) missing role prompt file refuses (fail-safe)
rm "$AUTONOMY_TARGET_REPO/.autonomy/roles/qa.md"
run_session qa
check "missing prompt file: session refused rc 2" "2" "$?"
printf 'qa prompt\n' > "$AUTONOMY_TARGET_REPO/.autonomy/roles/qa.md"

# 7) back-compat: no-arg run_session honours the ROLE env contract
: > "$STUB_CAPTURE"
ROLE=qa run_session
check "no-arg run_session uses \$ROLE" "$AUTONOMY_TARGET_REPO/.autonomy/roles/qa.md" "$(grab prompt)"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test_headless_dispatch.sh`
Expected: the new checks FAIL (`run_session` takes no role arg yet; stub adapter dir not
honoured — the source of `bin/agents/stub.sh` errors).

- [ ] **Step 3: Implement**

**(a)** `resolve_session_settings` becomes role-aware — role values fill the override slot only
when the real CLI flag is empty (CLI > role > config > default), and the one-shot file still runs
last (it wins for its one session):

```bash
# Resolve model/fallback/effort PER SESSION (not once at startup), so a config
# edit -- including the dashboard's 'save as default' write-back -- takes
# effect on the next session without a supervisor restart. Role-level
# model/effort (ROLE_MODEL/ROLE_EFFORT, set by resolve_role_dispatch) sit
# between the CLI flag and config.yaml: CLI > role > agent.* > default. The
# one-shot dashboard override is applied last and wins for its one session.
resolve_session_settings() {
  MODEL="$(resolve_config_value "$CFG" agent.model.primary "${MODEL_OVERRIDE:-${ROLE_MODEL:-}}" claude-sonnet-5)"
  FALLBACK_MODEL="$(resolve_config_value "$CFG" agent.model.fallback "$FALLBACK_MODEL_OVERRIDE" claude-sonnet-4-6)"
  EFFORT="$(resolve_config_value "$CFG" agent.effort "${EFFORT_OVERRIDE:-${ROLE_EFFORT:-}}" "")"
  consume_model_override "$LOGDIR/model-override"
}
```

**(b)** `run_session` generalised (full replacement):

```bash
run_session() {
  local role="${1:-${ROLE:-coder}}"
  preflight || return $?

  # shellcheck source=/dev/null
  source "${AUTONOMY_AGENTS_DIR:-$ENGINE_HOME/bin/agents}/${AGENT_TYPE}.sh"

  if ! resolve_role_dispatch "$role"; then
    log "dispatch: cannot resolve settings for role '$role' -- REFUSING session (fail-safe; see supervisor.log)"
    return 2
  fi
  resolve_session_settings

  # Auth precedence: account (fail-safe -- an unresolvable account REFUSES
  # the session, never runs on broken auth) > per-role credential (#51-C,
  # best-effort) > subscription.
  local env_lines="" auth_note="subscription"
  if [ -n "$ROLE_ACCOUNT" ]; then
    if ! env_lines="$(resolve_account_env "$ROLE_ACCOUNT")"; then
      log "dispatch: role '$role' account '$ROLE_ACCOUNT' did not resolve -- REFUSING session (fail-safe; see supervisor.log)"
      return 2
    fi
    auth_note="account($ROLE_ACCOUNT)"
  else
    local role_key; role_key="$(resolve_role_credential "$role")"
    if [ -n "$role_key" ]; then
      env_lines="ANTHROPIC_API_KEY=$role_key"
      auth_note="api-key($role)"
    fi
  fi

  # The role's own prompt when set (doctor verified it is a repo-relative
  # pack file), else the pack's loop_prompt. A missing file refuses.
  local prompt_file="$AUTONOMY_TARGET_REPO/.autonomy/loop_prompt.md"
  [ -n "$ROLE_PROMPT" ] && prompt_file="$AUTONOMY_TARGET_REPO/$ROLE_PROMPT"
  if [ ! -f "$prompt_file" ]; then
    log "dispatch: prompt file missing for role '$role' ($prompt_file) -- REFUSING session"
    return 2
  fi

  local rules_file
  if ! rules_file="$(compose_session_rules "$AUTONOMY_TARGET_REPO/.autonomy/hard_rules.md" "$ROLE_SCOPE" "$LOGDIR/.session-rules")"; then
    log "dispatch: cannot compose scope rules for role '$role' -- REFUSING session (a dropped scope would widen the agent's remit)"
    return 2
  fi

  if [ "$ROLE_INSTANCES" != "1" ]; then
    log "NOTE roles.$role.instances=$ROLE_INSTANCES not yet supported -- running a single instance (parallel instances are a later increment)"
  fi

  local log_file; log_file="$LOGDIR/session-$(date +%Y%m%dT%H%M%S).log"
  log "session start (role=$role model=$MODEL effort=${EFFORT:-default} auth=$auth_note) -> $log_file"

  invoke_scoped_env "$env_lines" \
    "$prompt_file" "$rules_file" \
    "$MODEL" "$FALLBACK_MODEL" "$log_file" "$EFFORT"
  local rc=$?

  local outcome; outcome="$(agent_classify_outcome "$log_file" "$rc")"
  case "$outcome" in
    success)
      return 0 ;;
    usage_limit*)
      local epoch="${outcome#usage_limit }"
      if [ "$epoch" != "usage_limit" ] && [ -n "$epoch" ]; then
        persist_reset_epoch "$epoch"
      fi
      return 3 ;;
    *)
      if compute_limit_wait >/dev/null; then return 3; fi
      return "$rc" ;;
  esac
}
```

**(c)** Main loop: initialise `role_rr=0` next to `paused_logged=0`; replace the
`run_session; outcome=$?` line with role selection (between the `open_count` idle check and the
outcome `case`):

```bash
    # Round-robin over the enabled loop roles (re-enumerated every tick so a
    # config edit applies on the next session). Enumeration failure falls
    # back to coder-only -- the conservative default; preflight's doctor
    # check still gates a truly broken pack. NO roles enabled = idle, same
    # as an empty board.
    if ! dispatch_list="$(resolve_dispatch_roles)"; then
      log "WARN role enumeration failed -- coder-only fallback (see supervisor.log)"
      dispatch_list="coder"
    fi
    if [ -z "$dispatch_list" ]; then
      log "no loop roles enabled -- idle ${EMPTY_IDLE}s"; sleep "$EMPTY_IDLE"; continue
    fi
    # shellcheck disable=SC2086  # intentional split: names are [A-Za-z0-9._-] tokens
    role="$(select_role "$role_rr" $dispatch_list)"
    role_rr=$(( (role_rr + 1) % 86400 ))

    run_session "$role"; outcome=$?
```

- [ ] **Step 4: Run the tests**

Run: `bash tests/test_headless_dispatch.sh && bash tests/test_role_credential.sh && bash tests/test_model_override.sh && bash tests/test_agent_dispatch.sh`
Expected: all `ALL PASS` — the three pre-existing suites unmodified.

- [ ] **Step 5: Full suite + shellcheck**

Run: `bash tests/run_all.sh` → `ALL SUITES PASS`
Run: `shellcheck -S warning start bin/*.sh bin/agents/*.sh tests/*.sh templates/autonomy-pack/qa/*.sh` → no output

- [ ] **Step 6: Commit**

```bash
git add bin/supervisor.sh tests/test_headless_dispatch.sh
git commit -m "feat: supervisor runs any enabled loop role — account-first auth, fail-safe refusal, round-robin dispatch (task 4)"
```

---

### Task 5: docs — pack template + CLAUDE.md

**Files:**
- Modify: `templates/autonomy-pack/config.yaml` (the roles comment block, around lines 38-42)
- Modify: `CLAUDE.md` (Layout section, `supervisor.sh` line)

**Interfaces:** none (comment-only; `tests/test_onboard.sh` and the roles example's mechanical
validation must stay green).

- [ ] **Step 1: Update the pack template comment**

In `templates/autonomy-pack/config.yaml`, the roles comment block currently reads (context):

```
# ({ type: loop | cron | event, ... }) + model/effort (or per-phase models)
# + scope (what it works over; empty = whole open board) + behaviour knobs.
# `prompt:` must point at a real pack file under .autonomy/roles/, never a
# copy. Validate with doctor.sh.
```

Insert after the `# copy. Validate with doctor.sh.` line:

```
# Enabled `trigger: { type: loop }` roles are dispatched by the supervisor
# round-robin (one session each, in turn); cron/event triggers are not
# dispatched yet (scheduler/event bus is a later increment). A role with an
# `account:` that cannot resolve REFUSES its sessions (fail-safe).
```

- [ ] **Step 2: Update CLAUDE.md layout line**

Change:

```
  supervisor.sh          # main loop: --repo <path>, agent-adapter dispatch, preflight, backoff
```

to:

```
  supervisor.sh          # main loop: --repo <path>, runs every enabled loop role round-robin (account-first auth), preflight, backoff
```

- [ ] **Step 3: Validate + full suite**

Run: `bash tests/test_onboard.sh && bash tests/run_all.sh`
Expected: `ALL PASS` / `ALL SUITES PASS`. Also re-validate the template example mechanically the
way increment 2 did: copy the template into a temp repo pack, uncomment the roles example, run
`python3 lib/roles.py <tmp-repo>` — exit 0 (block valid) — see
`docs/superpowers/plans/2026-07-02-agent-config-schema.md` for the exact recipe if needed.

- [ ] **Step 4: Commit**

```bash
git add templates/autonomy-pack/config.yaml CLAUDE.md
git commit -m "docs: loop-role dispatch semantics in pack template + CLAUDE.md layout (task 5)"
```

---

## Self-review notes

- Spec coverage: Layer 3 mechanism 1 fully covered (resolve account → session-scoped env →
  adapter with model/effort/prompt/scope). Cron/event explicitly excluded (increment 4).
  `instances:` deferred with a logged NOTE. Fail-safe refusal on unresolvable account, missing
  prompt, uncomposable scope. #51-C path preserved and covered by an unmodified pre-existing
  suite.
- Type consistency: `role_settings` keys (`account/model/effort/prompt/scope/instances`) ↔ CLI
  `ACCOUNT/MODEL/EFFORT/PROMPT/SCOPE/INSTANCES` ↔ supervisor `ROLE_*` globals — one naming chain,
  checked task-to-task.
- The `RANDOM`-style modulo on `role_rr` (`% 86400`) only bounds the counter; correctness needs
  only `idx % n` in `select_role`.
