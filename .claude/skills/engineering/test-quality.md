# test-quality

## When to use

Writing or reviewing anything under `tests/`.

## Tests are genuine — the non-negotiable

Tests `source` the REAL script / import the REAL module and call the REAL
functions. Stubs are allowed only at the established seams:

| Seam | What it replaces |
|---|---|
| `AUTONOMY_CREDENTIALS_BIN` | `lib/credentials.py` (Keychain) |
| `AUTONOMY_ACCOUNTS_BIN` | `lib/accounts.py resolve` (Keychain) |
| `AUTONOMY_AGENTS_DIR` | `bin/agents/` (the real agent CLI) |
| `gh` as a shell function | network calls to GitHub |
| `agent_invoke` / `preflight` / `log`+`SUPLOG=/dev/null` | the agent boundary / a real git repo / log noise |

A test that stubs the function under test is assertions-on-mocks — noise, not
coverage.

**What counts as a seam:** the boundary is the Keychain, the network, and the
agent CLI — NOT our own code. Python helpers in `lib/` (`roles.py`,
`config_parser.py`) run FOR REAL against fixture files in `$tmp`; that
integration is the point of the test. A new helper only earns a `_BIN`-style
env seam if it touches the Keychain/network — same shape as the existing ones:
an env-var override checked before the real binary (grep
`AUTONOMY_CREDENTIALS_BIN` in `bin/supervisor.sh` for the pattern).

## TDD: see the failure first

Write the failing test, RUN it, read the exact failure (e.g. `select_role:
command not found`), then implement. A test you never saw fail proves nothing
about your change.

## Bash suite shape

One `tests/test_<thing>.sh` per script; `tests/run_all.sh` auto-discovers via
glob — no registration. Skeleton conventions (copy from
`tests/test_headless_dispatch.sh`):

```bash
source "$ENGINE_HOME/bin/supervisor.sh"   # real script — guard makes this safe
SUPLOG=/dev/null; log() { :; }
check() {  # name expected actual — count fails, never exit early
  if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails + 1)); fi
}
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
```

Fixture repos are built in `$tmp` with a real `.autonomy/` pack so python
helpers (`roles.py`, `config_parser.py`) run for real. Test files are
shellcheck-gated like `bin/`.

## Python suite shape

`unittest`, one file per module, registered explicitly in `tests/run_all.sh`
(python suites are NOT glob-discovered — bash ones are). Conventions:
`sys.path.insert` to `lib/`, a `parse()` helper wrapping `config_parser.parse`,
`tempfile.mkdtemp` + `self.addCleanup(shutil.rmtree, …)`, injected fakes for
Keychain/registry (see `tests/test_accounts.py`).

## Mandatory boundary cases

For every new function:

- **Empty / first-run** — no config block, empty registry, empty board, absent
  file. The engine's defaults ARE behaviour (`dispatch_roles({}) == ["coder"]`).
- **Garbage shape** — `roles: "garbage"`, non-dict entries, corrupt JSON index.
  Must degrade per the fail-safe rules, and the test asserts WHICH degradation.
- **Failure path refuses** — for anything auth/merge/scope-related, assert the
  refusal (rc, no side effect) not just the happy path. The strongest form:
  prove the guarded action never ran (`broken account: adapter never invoked`
  asserts on an empty capture file).
- **Precedence** — when values layer (CLI > role > config > default), one test
  per adjacent pair minimum.

## Assert specific values

`assert result is not None` / "no crash" is noise. Assert the exact name list,
the exact rc, the exact composed file content, the exact exported env value.

## A negative test must fail for the RIGHT reason

Asserting "does not fire" only proves something if the branch you claim to
cover is what suppressed it — not an earlier guard short-circuiting. Build the
fixture so every earlier guard is inert. Mutation check when unsure: break the
production branch, confirm the test fails, revert.

## Env leakage

Any test exporting env vars (`ANTHROPIC_API_KEY`, seam overrides) must assert
the supervisor's OWN env stayed clean after the call, and `unset` before the
next section — subshell-scoping is a correctness property here, not a nicety.
The assertion shape (from `test_role_credential.sh`):

```bash
check "key does NOT leak into supervisor env" "" "${ANTHROPIC_API_KEY:-}"
```

## Poll for readiness, never a fixed sleep

A test that starts a server (e.g. `bin/dashboard.py`) and then does a fixed
`sleep N` before its first request is racing the bind. Under load — a concurrent
dashboard from another checkout, overlapping test runs — the server needs longer
than `N` to come up, the early request hits nothing listening, `curl -s` returns
an **empty body**, and the assertion fails with a confusing `JSONDecodeError`
rather than a clear "server not ready" (issue #100). Poll for readiness with a
bounded loop, then fail loudly if it never comes up:

```bash
python3 "$ENGINE_HOME/bin/dashboard.py" --repo "$tmp/repoA" --port 8931 & pid=$!
ready=0
for _ in $(seq 1 75); do          # ~15s ceiling
  if curl -sf http://127.0.0.1:8931/ >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.2
done
[ "$ready" -eq 1 ] || { echo "FAIL - dashboard did not become ready"; exit 1; }
```

Deterministic, still a genuine live round-trip, and bash 3.2 compatible. The
same rule applies to any readiness signal — a PID file appearing, a socket
opening, a log line — poll for the actual signal, don't guess a duration.
