# Plan — #59 distinguish 'unreadable' from 'empty' in the account/credential registries

## Problem

`lib/accounts.py::_load()` (and the identical `lib/credentials.py::_load()`) swallow
`OSError`/`ValueError` — and now (post-#56) a non-dict top-level — into an **empty**
registry. Fail-safe direction is correct for *reads*, but it conflates two states:

- **empty/new** — the index file simply does not exist yet. Writing is fine.
- **corrupt/unreadable** — the file exists but is unparseable JSON, not a dict, or
  unreadable (permissions). Reading as empty is misleading, and the next `set()`/
  `delete()` calls `_save()`, which rewrites the file keeping only the new entry —
  **silently dropping the unparseable entries** (data loss).

Secondary symptom: `roles.py`'s doctor path derives known account names from
`Accounts().list()`, which returns `[]` on a corrupt index, so `check_accounts`
reports "account X not found -- create it first". Following that advice runs
`set`, which clobbers the corrupt file. The message should say the registry is
**unreadable**, not that the account is missing.

## Policy decision (fail-safe, not fail-open)

On a **corrupt** index: **refuse** `set()`/`delete()` (raise) rather than
overwrite. Do NOT auto-backup-then-overwrite — auto-mutating a file the operator
may want to inspect is the less-safe option, and the engine invariant is
fail-safe/never-fail-open. **Reads** (`list`/`get`/`resolve`/`assignments`)
keep degrading to empty — a read never destroys data, and the dashboard already
wraps them in `except Exception`. This closes the data-loss hole with the
minimum blast radius.

## Design (revised after Codex checkpoint 1 — closes 5 findings)

Both modules share the `_load()` idiom; change them in parity.

1. **`RegistryError(RuntimeError)`** — one per module, module-level. Semantically
   honest: a corrupt/unreadable index is a *state* fault, not bad input, so NOT
   a `ValueError`. Because no single existing exception type is caught by every
   write boundary, it is added **explicitly** to each write-path handler (below)
   — not silently relying on an existing `except` (Codex finding 3).

2. **`_read()` helper** (private) returns `(data, status)`:
   - `FileNotFoundError` → `({}, "empty")` (legitimately new)
   - other `OSError` / `ValueError` / non-dict top-level → `({}, "corrupt")`
   - **required sub-section present but non-dict → `({}, "corrupt")`** (Codex
     round-2 finding): accounts checks `data["accounts"]`; credentials checks
     `data["credentials"]` AND `data["assignments"]`. Otherwise a structurally
     invalid section (`{"assignments": []}`) passes `_load_for_write()`,
     `Credentials.delete()` removes the Keychain secret, then crashes on
     `data["assignments"].items()` — a destructive side effect before the index
     is proven structurally writable (fail-safe violation).
   - otherwise → `(data, "ok")`

3. **`_load()`** (reads, unchanged external behaviour): `data, _ = self._read()`,
   then `setdefault(...)`. Corrupt still degrades to empty.

4. **`_load_for_write()`**: `data, status = self._read()`; if `status ==
   "corrupt"` raise `RegistryError("<accounts|credentials> registry at <path> is
   unreadable/corrupt -- refusing to overwrite; fix or remove it")`; else
   `setdefault(...)` and return.

5. **Gate EVERY write path** (Codex finding 1) via `_load_for_write()`:
   - accounts: `set()`, `delete()`.
   - credentials: `set()`, `delete()`, `assign()`, `unassign()`.
   - **`Credentials.delete()` reorder** (Codex finding 2): it currently calls
     `self.store.delete(label)` (keystore) BEFORE loading the index. Move the
     `_load_for_write()` FIRST so a corrupt index refuses *before* the secret is
     removed — otherwise a corrupt index would still destroy the Keychain secret.
     `set()` already stores the secret after building `data`; move its
     `_load_for_write()` to the top so a corrupt index refuses before
     `store.set()`.

6. **`is_corrupt()`** (public, cheap): `return self._read()[1] == "corrupt"`.
   Lets the doctor path distinguish unreadable from empty without changing the
   read contract.

7. **Write-path handler updates** — add `RegistryError` to each `except`, mapped
   to a clean refusal (CLI: print + `return 1`; dashboard: `{"ok": False,
   "error": str(exc)}`):
   - `lib/accounts.py::_main` except tuple; `lib/credentials.py::_main` except tuple.
   - `bin/dashboard.py`: `execute_acct_set`, `execute_acct_delete`,
     `execute_cred_set`, `execute_cred_delete`, `execute_cred_assign`,
     `execute_cred_unassign`.
   Import path: dashboard already imports the modules; reference
   `accts.RegistryError` / `creds.RegistryError`.

8. **`roles.py` doctor CLI** (`import accounts` block, ~line 511): if
   `accounts_mod.Accounts().is_corrupt()`, emit ONE "accounts registry at
   <path> is unreadable -- fix or remove it before validating roles" error and
   SKIP the `check_accounts` not-found pass (noise on a registry we can't read).

## Tests (TDD, real modules sourced, real tmp files)

`tests/test_accounts.py`:
- corrupt (syntax-error) index → `set()`/`delete()` raise `RegistryError`; file
  bytes on disk UNCHANGED (proves no clobber).
- corrupt index → `list()`/`get()` still return empty; `is_corrupt()` True.
- missing file → `is_corrupt()` False, `set()` succeeds (empty ≠ corrupt).
- non-dict `[]` → write refuses (RegistryError), read empty.

`tests/test_credentials.py` (Codex finding 4 — cover assign/unassign + secret):
- corrupt index → `set()`/`delete()`/`assign()`/`unassign()` raise
  `RegistryError`; index bytes unchanged.
- **corrupt index → `delete()` raises AND the Keychain secret is NOT removed**
  (assert `store.get(label)` still returns the value → proves the reorder).
- corrupt index → `list()`/`assignments()` empty; `is_corrupt()` True.
- non-dict `[]` → write refuses, read empty.

`tests/test_dashboard_control.py` or the dashboard test (Codex finding 4):
- `execute_acct_delete`/`execute_cred_delete` against a corrupt index → returns
  `{"ok": False, ...}` (a clean refusal, NOT a traceback).

Doctor test (real python, `is_corrupt` seam): a role referencing an account with
a corrupt registry → doctor emits "registry unreadable", NOT "account not found".

NOTE: `accounts` has NO `assignments()` (Codex finding 5) — that method is
credentials-only; account read-contract tests use `list()`/`get()`.

## Invariants respected

- Fail-safe never fail-open — corrupt refuses the write, never silently widens.
- Reset-epoch split / bash floor — untouched. Python 3 stdlib only.
- Repo-agnostic — no target-repo values; messages use the path variable.
- Parity between accounts.py and credentials.py preserved.
