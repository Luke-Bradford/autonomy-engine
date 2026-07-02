# Accounts Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a machine-level registry of named *accounts* (auth instances) — Claude/Codex subscriptions or Anthropic/OpenAI API keys — that agents will reference by name, so "which account each agent calls from" becomes declarative config.

**Architecture:** `lib/accounts.py` is a thin classifier layer over the existing `lib/credentials.py` (#51) store. An account is `{name, kind, credential?}`; a non-secret JSON index at `~/.config/autonomy/accounts` holds only names/kinds/credential-*labels* (mode 600, atomic). `resolve(name)` returns `{kind, env}` where subscription kinds export nothing (they use the CLI login already on the machine) and API kinds export the Keychain-backed key session-scoped. The dashboard `/config` page gains an Accounts section that mirrors the existing Credentials section.

**Tech Stack:** Python 3 stdlib only; the existing `credentials.py` module; the stdlib `http.server` dashboard; vanilla-JS `config_page.html`.

## Global Constraints

- macOS `/bin/bash` 3.2.57 compatible; NO mapfile/globstar/associative arrays.
- Python 3 **stdlib only** — no third-party imports anywhere.
- `shellcheck -S warning` clean across `start bin/*.sh bin/agents/*.sh tests/*.sh templates/autonomy-pack/qa/*.sh`.
- Secrets NEVER in a file, log, or API response — they live only in the macOS Keychain (via `credentials.py`). The accounts index holds names/kinds/credential-*labels* only.
- Account names validate against `^[A-Za-z0-9._-]{1,64}$` (same charset as credential labels).
- Index files: mode `0o600`, atomic write (tmp + `os.replace`).
- TDD: write the failing test, watch it fail, implement minimally, watch it pass, commit.
- Branch `feat/agent-org-accounts` off `main`; never commit to `main`.

---

### Task 1: Accounts backend — index + CRUD + validation

**Files:**
- Create: `lib/accounts.py`
- Create: `tests/test_accounts.py`

**Interfaces:**
- Consumes: `credentials.Credentials` (injected; only `.get_secret(label)` is used, in Task 2). For Task 1 the credentials object is unused but is constructor-injected now.
- Produces:
  - `accounts.default_index_path() -> str`
  - `accounts.VALID_KINDS = ("claude_subscription", "codex_subscription", "anthropic_api", "openai_api")`
  - `class Accounts(index_path=None, credentials=None)` with:
    - `set(name, kind, credential=None) -> None` (raises `ValueError` on bad name/kind, missing credential for an API kind, or a credential passed to a subscription kind)
    - `list() -> list[dict]` each `{name, kind, credential, has_credential}` (no secret)
    - `get(name) -> dict | None` (`{kind, credential}`)
    - `delete(name) -> None` (idempotent)

- [ ] **Step 1: Write the failing test**

```python
# tests/test_accounts.py
"""Unit tests for lib/accounts.py -- the named-account registry (#agent-org increment 1).
An account classifies an auth instance: a subscription (no secret) or an API kind
that points at a credentials.py Keychain label. The index holds names/kinds/labels
only -- never a secret. Tests inject a fake credentials object + a temp index."""
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))
import accounts as ac  # noqa: E402


class FakeCreds:
    """Stand-in for credentials.Credentials -- only get_secret is used."""
    def __init__(self, secrets=None):
        self._s = secrets or {}
    def get_secret(self, label):
        return self._s.get(label)


class TestAccountsCrud(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.index = os.path.join(self.tmp, "accounts")
        self.a = ac.Accounts(index_path=self.index, credentials=FakeCreds())

    def test_set_subscription_then_list(self):
        self.a.set("claude-sub", "claude_subscription")
        entries = self.a.list()
        self.assertEqual(len(entries), 1)
        e = entries[0]
        self.assertEqual(e["name"], "claude-sub")
        self.assertEqual(e["kind"], "claude_subscription")
        self.assertIsNone(e["credential"])
        self.assertFalse(e["has_credential"])

    def test_set_api_kind_requires_credential(self):
        with self.assertRaises(ValueError):
            self.a.set("work", "anthropic_api")            # no credential -> reject
        self.a.set("work", "anthropic_api", credential="work-key")
        self.assertEqual(self.a.get("work"), {"kind": "anthropic_api", "credential": "work-key"})

    def test_subscription_kind_forbids_credential(self):
        with self.assertRaises(ValueError):
            self.a.set("claude-sub", "claude_subscription", credential="oops")

    def test_bad_name_and_kind_rejected(self):
        with self.assertRaises(ValueError):
            self.a.set("has space", "claude_subscription")
        with self.assertRaises(ValueError):
            self.a.set("x", "not_a_kind")

    def test_set_upserts(self):
        self.a.set("work", "anthropic_api", credential="k1")
        self.a.set("work", "openai_api", credential="k2")   # re-point same name
        self.assertEqual(self.a.get("work"), {"kind": "openai_api", "credential": "k2"})
        self.assertEqual(len(self.a.list()), 1)

    def test_delete_is_idempotent(self):
        self.a.set("work", "claude_subscription")
        self.a.delete("work")
        self.assertEqual(self.a.list(), [])
        self.a.delete("work")   # no raise

    def test_index_is_600_and_has_no_secret(self):
        self.a.set("work", "anthropic_api", credential="work-key")
        mode = stat.S_IMODE(os.stat(self.index).st_mode)
        self.assertEqual(mode, 0o600)
        raw = Path(self.index).read_text()
        self.assertIn("work", raw)          # name + label are fine
        self.assertIn("anthropic_api", raw)
        self.assertNotIn("sk-", raw)        # no secret material ever

    def test_missing_index_is_empty(self):
        a = ac.Accounts(index_path=os.path.join(self.tmp, "absent"), credentials=FakeCreds())
        self.assertEqual(a.list(), [])
        self.assertIsNone(a.get("nope"))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m unittest tests.test_accounts -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'accounts'`.

- [ ] **Step 3: Write minimal implementation**

```python
# lib/accounts.py
#!/usr/bin/env python3
"""Named-account registry for the autonomy engine (agent-org increment 1).

An account classifies an auth instance an agent can call from:
  - claude_subscription / codex_subscription: the CLI login already on the
    machine -- no secret, nothing to export.
  - anthropic_api / openai_api: points at a credentials.py Keychain label
    (#51); the secret stays in the Keychain.

The index (~/.config/autonomy/accounts) holds only names, kinds, and
credential LABELS -- never a secret. The credentials object is injected so
tests never touch the real Keychain. stdlib only; macOS.
"""
import json
import os
import re
import sys

import credentials as _credentials

_NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
VALID_KINDS = ("claude_subscription", "codex_subscription",
               "anthropic_api", "openai_api")
_SUBSCRIPTION_KINDS = ("claude_subscription", "codex_subscription")
# API kind -> the env var its key is exported as (used in Task 2)
_API_ENV = {"anthropic_api": "ANTHROPIC_API_KEY", "openai_api": "OPENAI_API_KEY"}


def default_index_path():
    return os.path.expanduser("~/.config/autonomy/accounts")


class Accounts:
    def __init__(self, index_path=None, credentials=None):
        self.index_path = index_path or default_index_path()
        self.credentials = (credentials if credentials is not None
                            else _credentials.Credentials())

    def _load(self):
        try:
            with open(self.index_path, encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            data = {}
        data.setdefault("accounts", {})
        return data

    def _save(self, data):
        directory = os.path.dirname(os.path.abspath(self.index_path))
        os.makedirs(directory, exist_ok=True)
        tmp = self.index_path + ".tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2, sort_keys=True)
        os.replace(tmp, self.index_path)
        os.chmod(self.index_path, 0o600)

    def set(self, name, kind, credential=None):
        if not _NAME_RE.match(name or ""):
            raise ValueError("account name must be 1-64 chars of [A-Za-z0-9._-]")
        if kind not in VALID_KINDS:
            raise ValueError("kind must be one of %s" % (VALID_KINDS,))
        if kind in _SUBSCRIPTION_KINDS:
            if credential:
                raise ValueError("subscription accounts take no credential")
            credential = None
        else:
            if not (credential or "").strip():
                raise ValueError("API accounts require a credential label")
        data = self._load()
        entry = {"kind": kind}
        if credential:
            entry["credential"] = credential
        data["accounts"][name] = entry
        self._save(data)

    def list(self):
        data = self._load()
        out = []
        for name in sorted(data["accounts"]):
            e = data["accounts"][name]
            cred = e.get("credential")
            out.append({"name": name, "kind": e.get("kind", ""),
                        "credential": cred, "has_credential": bool(cred)})
        return out

    def get(self, name):
        e = self._load()["accounts"].get(name)
        if e is None:
            return None
        return {"kind": e.get("kind", ""), "credential": e.get("credential")}

    def delete(self, name):
        data = self._load()
        if data["accounts"].pop(name, None) is not None:
            self._save(data)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m unittest tests.test_accounts -v`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/accounts.py tests/test_accounts.py
git commit -m "feat: named-account registry backend — CRUD + validation (agent-org)"
```

---

### Task 2: `resolve()` — subscription vs API env

**Files:**
- Modify: `lib/accounts.py` (add `resolve` method)
- Modify: `tests/test_accounts.py` (add `TestResolve`)

**Interfaces:**
- Consumes: `credentials.get_secret(label)` (from the injected credentials object).
- Produces: `Accounts.resolve(name) -> dict` returning `{"kind": str, "env": dict}`. Subscription → `env={}`. API → `env={VAR: secret}`. Raises `KeyError` if the account doesn't exist; raises `LookupError` if an API account's credential resolves to no secret (fail-safe — caller must not run with broken auth).

- [ ] **Step 1: Write the failing test**

```python
# append to tests/test_accounts.py, before the __main__ guard
class TestResolve(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.index = os.path.join(self.tmp, "accounts")
        self.creds = FakeCreds({"work-key": "sk-ant-SECRET", "oai": "sk-openai-SECRET"})
        self.a = ac.Accounts(index_path=self.index, credentials=self.creds)

    def test_subscription_exports_nothing(self):
        self.a.set("claude-sub", "claude_subscription")
        r = self.a.resolve("claude-sub")
        self.assertEqual(r, {"kind": "claude_subscription", "env": {}})

    def test_anthropic_api_exports_key(self):
        self.a.set("work", "anthropic_api", credential="work-key")
        r = self.a.resolve("work")
        self.assertEqual(r["kind"], "anthropic_api")
        self.assertEqual(r["env"], {"ANTHROPIC_API_KEY": "sk-ant-SECRET"})

    def test_openai_api_exports_key(self):
        self.a.set("side", "openai_api", credential="oai")
        self.assertEqual(self.a.resolve("side")["env"], {"OPENAI_API_KEY": "sk-openai-SECRET"})

    def test_unknown_account_raises_keyerror(self):
        with self.assertRaises(KeyError):
            self.a.resolve("ghost")

    def test_api_with_missing_secret_raises_lookuperror(self):
        # credential label present in the index but the Keychain has no secret
        self.a.set("stale", "anthropic_api", credential="gone")
        with self.assertRaises(LookupError):
            self.a.resolve("stale")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m unittest tests.test_accounts.TestResolve -v`
Expected: FAIL — `AttributeError: 'Accounts' object has no attribute 'resolve'`.

- [ ] **Step 3: Write minimal implementation**

```python
# add to lib/accounts.py, inside class Accounts (after delete)
    def resolve(self, name):
        """Resolve an account to {kind, env}. Subscriptions export nothing
        (CLI login); API kinds export their Keychain-backed key. Raises
        KeyError (no such account) / LookupError (API key unresolvable) --
        the caller must never run with broken auth (fail-safe)."""
        entry = self.get(name)
        if entry is None:
            raise KeyError(name)
        kind = entry["kind"]
        if kind in _SUBSCRIPTION_KINDS:
            return {"kind": kind, "env": {}}
        var = _API_ENV.get(kind)
        secret = self.credentials.get_secret(entry.get("credential"))
        if not secret:
            raise LookupError(
                "account %r credential %r has no secret in the Keychain"
                % (name, entry.get("credential")))
        return {"kind": kind, "env": {var: secret}}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m unittest tests.test_accounts -v`
Expected: PASS (12 tests total).

- [ ] **Step 5: Commit**

```bash
git add lib/accounts.py tests/test_accounts.py
git commit -m "feat: accounts.resolve — subscription (no env) vs API (session-scoped key)"
```

---

### Task 3: CLI + suite registration

**Files:**
- Modify: `lib/accounts.py` (add `_main` + `__main__` guard)
- Modify: `tests/test_accounts.py` (add `TestCli`)
- Modify: `tests/run_all.sh:22-23` (register the python suite)

**Interfaces:**
- Consumes: the `Accounts` class (real `KeychainStore`-backed credentials in prod; tests exercise `_main` with a patched `Accounts.__init__`).
- Produces: CLI `accounts.py list | set <name> <kind> [credential] | get <name> | delete <name> | resolve <name>`. `resolve` prints `VAR=value` lines to stdout (empty for a subscription) so the supervisor (bash) can read them; exit 1 on an unresolvable account.

- [ ] **Step 1: Write the failing test**

```python
# append to tests/test_accounts.py, before the __main__ guard
class TestCli(unittest.TestCase):
    """_main returns clean exit codes and prints resolve env as VAR=value
    lines for bash consumers. Patch Accounts to a temp index + fake creds so
    the CLI never touches the real Keychain."""
    def _run(self, argv, secrets=None):
        import io
        tmp = tempfile.mkdtemp()
        orig = ac.Accounts.__init__
        def patched(self, index_path=None, credentials=None):
            orig(self, index_path=os.path.join(tmp, "accounts"),
                 credentials=FakeCreds(secrets or {}))
        ac.Accounts.__init__ = patched
        out, err = io.StringIO(), io.StringIO()
        so, se = sys.stdout, sys.stderr
        sys.stdout, sys.stderr = out, err
        try:
            rc = ac._main(argv)
        finally:
            ac.Accounts.__init__ = orig
            sys.stdout, sys.stderr = so, se
        return rc, out.getvalue(), err.getvalue(), tmp

    def test_set_then_resolve_subscription_prints_nothing(self):
        # reuse one temp dir across two _main calls by pinning the index path
        import io
        tmp = tempfile.mkdtemp()
        idx = os.path.join(tmp, "accounts")
        orig = ac.Accounts.__init__
        ac.Accounts.__init__ = lambda self, index_path=None, credentials=None: orig(
            self, index_path=idx, credentials=FakeCreds())
        try:
            self.assertEqual(ac._main(["set", "claude-sub", "claude_subscription"]), 0)
            out = io.StringIO(); so = sys.stdout; sys.stdout = out
            try:
                rc = ac._main(["resolve", "claude-sub"])
            finally:
                sys.stdout = so
        finally:
            ac.Accounts.__init__ = orig
        self.assertEqual(rc, 0)
        self.assertEqual(out.getvalue().strip(), "")   # subscription: no env lines

    def test_resolve_api_prints_var_line(self):
        import io
        tmp = tempfile.mkdtemp(); idx = os.path.join(tmp, "accounts")
        orig = ac.Accounts.__init__
        ac.Accounts.__init__ = lambda self, index_path=None, credentials=None: orig(
            self, index_path=idx, credentials=FakeCreds({"k": "sk-ant-X"}))
        try:
            ac._main(["set", "work", "anthropic_api", "k"])
            out = io.StringIO(); so = sys.stdout; sys.stdout = out
            try:
                rc = ac._main(["resolve", "work"])
            finally:
                sys.stdout = so
        finally:
            ac.Accounts.__init__ = orig
        self.assertEqual(rc, 0)
        self.assertEqual(out.getvalue().strip(), "ANTHROPIC_API_KEY=sk-ant-X")

    def test_resolve_unknown_exits_1(self):
        rc, _out, _err, _tmp = self._run(["resolve", "ghost"])
        self.assertEqual(rc, 1)

    def test_bad_kind_exits_1(self):
        rc, _out, err, _tmp = self._run(["set", "x", "bogus_kind"])
        self.assertEqual(rc, 1)
        self.assertIn("kind", err)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m unittest tests.test_accounts.TestCli -v`
Expected: FAIL — `AttributeError: module 'accounts' has no attribute '_main'`.

- [ ] **Step 3: Write minimal implementation**

```python
# add to lib/accounts.py, after the class
def _main(argv):
    a = Accounts()
    if not argv:
        print("usage: accounts.py list | set <name> <kind> [credential] | "
              "get <name> | delete <name> | resolve <name>", file=sys.stderr)
        return 2
    cmd, rest = argv[0], argv[1:]
    try:
        if cmd == "list":
            print(json.dumps(a.list()))
        elif cmd == "set":
            if len(rest) < 2:
                print("set needs <name> <kind> [credential]", file=sys.stderr)
                return 2
            a.set(rest[0], rest[1], credential=rest[2] if len(rest) > 2 else None)
        elif cmd == "get":
            e = a.get(rest[0]) if rest else None
            if e is None:
                return 1
            print(json.dumps(e))
        elif cmd == "delete":
            a.delete(rest[0])
        elif cmd == "resolve":
            r = a.resolve(rest[0])   # raises KeyError/LookupError -> caught below
            for var, val in sorted(r["env"].items()):
                sys.stdout.write("%s=%s\n" % (var, val))
        else:
            print("unknown command %r" % cmd, file=sys.stderr)
            return 2
    except (ValueError, KeyError, LookupError, IndexError) as e:
        print("accounts.py: %s" % e, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
```

- [ ] **Step 4: Run tests + register the suite**

Run: `python3 -m unittest tests.test_accounts -v`
Expected: PASS (16 tests total).

Then add the suite to `tests/run_all.sh` after the `test_credentials` block (around line 22-23):

```bash
echo "=== python: test_accounts ==="
python3 -m unittest tests.test_accounts -v || fail=1
```

Run: `bash tests/run_all.sh 2>&1 | grep -E "FAIL|ALL SUITES"`
Expected: `ALL SUITES PASS`.

- [ ] **Step 5: Commit**

```bash
git add lib/accounts.py tests/test_accounts.py tests/run_all.sh
git commit -m "feat: accounts.py CLI (list/set/get/delete/resolve) + suite registration"
```

---

### Task 4: Dashboard read model + account actions

**Files:**
- Modify: `bin/dashboard.py` — import `accounts`; add `_accounts()` singleton + `execute_acct_set`/`execute_acct_delete`; extend `config_read_model()` (line ~350) to include accounts; add `_acct_actions` routing in `do_POST` (line ~687).

**Interfaces:**
- Consumes: `accounts.Accounts()`; the existing `_creds()`/`config_read_model()`/`do_POST` patterns.
- Produces: `GET /api/config` gains `"accounts": [...]` (names/kinds/labels, no secret) + `"account_kinds": [...]`; `POST /api/control` accepts `acct_set` (`{name, kind, credential}`) and `acct_delete` (`{name}`), each returning `{ok, message|error}`.

- [ ] **Step 1: Write the failing test (live round-trip)**

This mirrors the manual verification used for the credentials wiring: subscription accounts need no Keychain, so they round-trip in a headless test. Create `tests/test_accounts_dashboard.sh`:

```bash
#!/usr/bin/env bash
# Live round-trip: acct_set (subscription) via the dashboard, then GET
# /api/config shows it -- proving the server wiring, no Keychain needed.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_HOME="$(cd "$HERE/.." && pwd)"
fails=0
check(){ if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (want '$2' got '$3')"; fails=$((fails+1)); fi; }

tmp="$(mktemp -d)"; tmp="$(cd "$tmp" && pwd -P)"; trap 'kill "${pid:-}" 2>/dev/null; rm -rf "$tmp"' EXIT
export HOME="$tmp/home"; mkdir -p "$HOME/.config/autonomy"
mkdir -p "$tmp/repoA/.autonomy"; printf 'board:\n  owner: x\n' > "$tmp/repoA/.autonomy/config.yaml"

python3 "$ENGINE_HOME/bin/dashboard.py" --repo "$tmp/repoA" --port 8931 >/dev/null 2>&1 & pid=$!
sleep 1.5
tok="$(curl -s http://127.0.0.1:8931/ | grep -o 'ae-control-token" content="[^"]*' | sed 's/.*content="//')"

curl -s -X POST http://127.0.0.1:8931/api/control -H 'Content-Type: application/json' \
  -d "{\"action\":\"acct_set\",\"name\":\"claude-sub\",\"kind\":\"claude_subscription\",\"token\":\"$tok\"}" >/dev/null
check "account appears in /api/config" "claude-sub" \
  "$(curl -s http://127.0.0.1:8931/api/config | python3 -c 'import json,sys;print((json.load(sys.stdin)["accounts"] or [{}])[0].get("name",""))')"
check "account_kinds offered" "0" \
  "$(curl -s http://127.0.0.1:8931/api/config | python3 -c 'import json,sys;print(0 if "anthropic_api" in json.load(sys.stdin)["account_kinds"] else 1)')"

curl -s -X POST http://127.0.0.1:8931/api/control -H 'Content-Type: application/json' \
  -d "{\"action\":\"acct_delete\",\"name\":\"claude-sub\",\"token\":\"$tok\"}" >/dev/null
check "account removed" "0" \
  "$(curl -s http://127.0.0.1:8931/api/config | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["accounts"]))')"

echo "---"; if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAIL"; exit 1; fi
```

- [ ] **Step 2: Run to verify it fails**

Run: `bash tests/test_accounts_dashboard.sh`
Expected: FAIL — `/api/config` has no `accounts` key (KeyError in the python one-liner).

- [ ] **Step 3: Write minimal implementation**

Add the import near the other lib imports in `bin/dashboard.py` (after `import credentials as creds`):

```python
import accounts as accts  # noqa: E402
```

Add the singleton + executors near `_creds()`:

```python
_accts_singleton = [None]


def _accts():
    if _accts_singleton[0] is None:
        _accts_singleton[0] = accts.Accounts()
    return _accts_singleton[0]


def execute_acct_set(name, kind, credential):
    try:
        _accts().set(name, kind, credential=credential or None)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    except OSError as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "message": "account '%s' saved" % name}


def execute_acct_delete(name):
    try:
        _accts().delete(name)
    except OSError as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "message": "account '%s' removed" % name}
```

Extend `config_read_model()`'s return (line ~350). Change:

```python
    return {"repos": repos, "credentials": cred_list,
            "assignments": assignments, "roles": list(_ASSIGNABLE_ROLES),
            "credentials_error": cred_error}
```

to:

```python
    acct_list, acct_error = [], None
    try:
        acct_list = _accts().list()
    except Exception as exc:
        acct_error = str(exc) or exc.__class__.__name__
    return {"repos": repos, "credentials": cred_list,
            "assignments": assignments, "roles": list(_ASSIGNABLE_ROLES),
            "credentials_error": cred_error,
            "accounts": acct_list, "account_kinds": list(accts.VALID_KINDS),
            "accounts_error": acct_error}
```

Add routing in `do_POST`. Change the `_cred_actions` guard line to also allow account actions, and add a handler block. Replace:

```python
        _cred_actions = ("cred_set", "cred_delete", "cred_assign", "cred_unassign")
        if (action not in ("set_model", "config_set", "repo_add", "repo_remove")
                and action not in _cred_actions
                and not dcx.is_valid_action(action)):
```

with:

```python
        _cred_actions = ("cred_set", "cred_delete", "cred_assign", "cred_unassign")
        _acct_actions = ("acct_set", "acct_delete")
        if (action not in ("set_model", "config_set", "repo_add", "repo_remove")
                and action not in _cred_actions
                and action not in _acct_actions
                and not dcx.is_valid_action(action)):
```

and immediately after the existing `if action in _cred_actions:` block (after its `return`), add:

```python
        if action in _acct_actions:
            if action == "acct_set":
                result = execute_acct_set(str(body.get("name") or ""),
                                          str(body.get("kind") or ""),
                                          str(body.get("credential") or ""))
            else:
                result = execute_acct_delete(str(body.get("name") or ""))
            self._send(200 if result.get("ok") else 409,
                       json.dumps(result).encode("utf-8"))
            return
```

- [ ] **Step 4: Run to verify it passes**

Run: `python3 -c "import ast;ast.parse(open('bin/dashboard.py').read())"` (syntax), then
`bash tests/test_accounts_dashboard.sh`
Expected: `ALL PASS`. Then `bash tests/run_all.sh 2>&1 | grep "ALL SUITES"` → `ALL SUITES PASS`.
Then `shellcheck -S warning tests/test_accounts_dashboard.sh` → clean.

- [ ] **Step 5: Commit**

```bash
git add bin/dashboard.py tests/test_accounts_dashboard.sh
git commit -m "feat: dashboard accounts read model + acct_set/acct_delete actions"
```

---

### Task 5: Config page — Accounts section

**Files:**
- Modify: `lib/config_page.html` — add an Accounts panel above Credentials; render/add/delete JS.

**Interfaces:**
- Consumes: `GET /api/config` (`accounts`, `account_kinds`, `credentials`), the existing `post(...)` + `load()` + `esc`/`encAttr` helpers already in `config_page.html`.
- Produces: an Accounts section where the operator creates an account (name + kind select; when an API kind is chosen, a credential select of existing labels appears), sees each account as `name · kind · [→ credential]`, and removes one.

- [ ] **Step 1: Add the panel markup**

In `lib/config_page.html`, add a section **above** the Credentials `<div class="sh">`:

```html
  <div class="sh"><h2>Accounts</h2><span class="ln"></span><span class="ct">named auth instances · subscription or API</span></div>
  <div class="panel" id="accts"></div>
  <div class="hint">An account is a named instance an agent calls from — your Claude or Codex subscription (no key needed), or an API key. API accounts link to a credential below.</div>
```

- [ ] **Step 2: Add the render + actions JS**

In `lib/config_page.html`, in `load()` add `renderAccts(m)` alongside `renderCreds(m)`:

```javascript
function load(){fetch("/api/config").then(r=>r.json()).then(m=>{MODEL=m;renderAccts(m);renderCreds(m);renderCfg(m.repos||[]);}).catch(()=>toast(false,"could not load config"));}
```

Then add these functions (near `renderCreds`):

```javascript
/* ---- ACCOUNTS ---- */
const SUB_KINDS=["claude_subscription","codex_subscription"];
function renderAccts(m){
  const accts=m.accounts||[], kinds=m.account_kinds||[], creds=m.credentials||[];
  const kindOpts=kinds.map(k=>`<option value="${esc(k)}">${esc(k)}</option>`).join("");
  const credOpts=`<option value="">— credential —</option>`+creds.map(c=>`<option value="${esc(c.label)}">${esc(c.label)}</option>`).join("");
  const add=`<div class="credadd">
    <input id="ac-name" class="cfgin" placeholder="account name (e.g. claude-sub)">
    <select id="ac-kind" class="cfgin" onchange="acctKindChange()">${kindOpts}</select>
    <select id="ac-cred" class="cfgin" style="display:none">${credOpts}</select>
    <button class="cbtn go" onclick="acctSave()">save</button></div>`;
  const err=m.accounts_error?`<div class="hint" style="color:var(--bad)">accounts error: ${esc(m.accounts_error)}</div>`:"";
  const rows=accts.map(a=>{
    const enc=encAttr(a.name);
    const link=a.credential?` <span class="credset">→ ${esc(a.credential)}</span>`:"";
    return `<div class="credrow">
      <span class="credlabel">${esc(a.name)}</span>
      <span class="credprov">${esc(a.kind)}</span>${link}
      <span class="credgap"></span>
      <button class="cbtn danger" onclick="acctDelete('${enc}')">remove</button>
    </div>`;
  }).join("");
  $("accts").innerHTML=add+err+(rows||`<div class="hint">no accounts yet — add one above.</div>`);
  acctKindChange();
}
function acctKindChange(){
  const kind=($("ac-kind")||{}).value||"";
  const cred=$("ac-cred"); if(!cred) return;
  cred.style.display=SUB_KINDS.indexOf(kind)>=0?"none":"";
}
function acctSave(){
  const name=($("ac-name").value||"").trim();
  const kind=$("ac-kind").value;
  const isSub=SUB_KINDS.indexOf(kind)>=0;
  const credential=isSub?"":($("ac-cred").value||"");
  if(!name){toast(false,"enter an account name");return;}
  if(!isSub&&!credential){toast(false,"pick a credential for an API account");return;}
  post({action:"acct_set",name,kind,credential},"account saved",()=>{$("ac-name").value="";load();});
}
function acctDelete(enc){
  const name=decodeURIComponent(enc);
  if(!window.confirm("Remove account '"+name+"'?\nAgents using it fall back to their default auth.")) return;
  post({action:"acct_delete",name},"removed",load);
}
```

- [ ] **Step 3: Verify live + screenshot**

Run the dashboard against a scratch HOME (as in Task 4), open `http://127.0.0.1:<port>/config`, confirm the Accounts panel renders above Credentials, the credential select hides for subscription kinds and shows for API kinds, and a subscription account round-trips (add → appears → remove). Capture a screenshot to `/Users/lukebradford/Dev/autonomy-engine/.screenshots/accounts-section.png` for operator sign-off.

- [ ] **Step 4: Full suite + shellcheck**

Run: `bash tests/run_all.sh 2>&1 | grep "ALL SUITES"` → `ALL SUITES PASS`;
`shellcheck -S warning start bin/*.sh bin/agents/*.sh tests/*.sh templates/autonomy-pack/qa/*.sh` → clean.

- [ ] **Step 5: Commit**

```bash
git add lib/config_page.html
git commit -m "feat: config page Accounts section — create/link/remove named accounts"
```

---

## Notes for the implementer

- This increment adds the *registry and its UI only*. Agents referencing an account by name, and the supervisor calling `accounts.py resolve` to export a session-scoped key, are **increment 3** (headless dispatch) — do not wire them here.
- Keep parity with `credentials.py`: same validation charset, same 600/atomic index discipline, same "secret never in a file/response" rule.
- The dashboard account actions sit behind the same control-token + anti-DNS-rebinding guards as every other `/api/control` action — no new transport surface.
