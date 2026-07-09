# python-hygiene

## When to use

Editing or adding anything under `lib/` or `bin/*.py`.

## Stdlib only — no exceptions without an operator decision

No PyYAML, no yq, no requests, no third-party anything. Config parsing goes
through `lib/config_parser.py` (restricted YAML subset) — never a new parser,
never `import yaml`. If a dependency looks unavoidable, stop and surface it;
do not add it.

## Repo idioms (follow, don't fight)

- **`%`-formatting** for strings/log messages, matching the existing modules.
- **Injected seams for testability:** external resources are constructor/param
  injections so tests never touch the real thing —
  `Accounts(index_path=…, credentials=…)`, `check_accounts(config,
  known_account_names)`, `check_prompt_files(config, repo_root)`. New code that
  talks to the Keychain, filesystem registries, or `gh` gets the same shape:
  pure core + injected boundary.
- **Atomic secret-adjacent writes:** `os.open(tmp, O_WRONLY|O_CREAT|O_TRUNC,
  0o600)` → write → `os.replace(tmp, path)` → `chmod 0600` (see
  `Accounts._save`). Index files hold names/kinds/labels — never a secret.
- **CLI exit codes are the contract.** Callers in bash branch on them —
  document the code map in the module docstring (`roles.py`: 0 valid / 3
  valid-no-block / 1 invalid / 2 unreadable) and never repurpose a code.
- **In-function `import config_parser`** in CLI entrypoints is the existing
  style (keeps `lib/` importable without path setup); keep it there, put
  everything else at module top.

## Fail-safe raises

A resolution failure must RAISE (or return a failing code), never fall back to
a guess: `Accounts.resolve` raises `KeyError`/`LookupError` so a caller can
never run on broken auth. When you add a lookup that auth, merging, or scope
depends on, the missing/garbage case is an error — not `None`, not a default.

Corollary: `assert` is for tests. Production invariants use explicit checks +
a concrete exception.

**Two failure disciplines when the same data has two consumers** (P3a,
PR #358): the DISPATCH consumer raises (`resolve_pipeline` — a broken doc
must never run) while the DISPLAY consumer is a TOTALITY boundary
(`build_pipeline_view` — every call guarded, errors become degraded payload
fields, the raw artifact stays visible as truth). Don't unify them in
either direction: a raising display 500s the dashboard; a degrading
dispatcher runs broken config. If a builder claims totality, EVERY external
call inside it is guarded — the review bot checks call-by-call
(prevention-log #21).

## Defensive shape-handling on config input

Parsed config can be any shape (`roles: "garbage"`). Every function that walks
it guards with `isinstance` before `.get()` and DEGRADES (skip/empty/default)
rather than crashing — `dispatch_roles`, `_effective`, `validate_roles` are the
pattern. Validation owns the error message; consumers own not crashing.

## Boundary validation

Validate at system boundaries: dashboard control-channel input is re-validated
server-side even though the page also validates (`dashboard_control` +
`valid_model_id` parity in supervisor). Values that land in filenames get a
charset check with a safe fallback (`resolve_account_key`). Internal lib-to-lib
calls trust their callers.

## Repo-agnostic rule

Nothing in `lib/` or `bin/` may hardcode a target repo's values (GitHub owner,
board title, issue numbers). Repo-specifics come from the target's
`.autonomy/config.yaml`. `templates/` and `docs/` may use placeholders.
