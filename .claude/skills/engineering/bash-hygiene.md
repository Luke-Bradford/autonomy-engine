# bash-hygiene

## When to use

Editing or adding ANY shell under `start`, `bin/`, `bin/agents/`, `tests/`, or
`templates/autonomy-pack/qa/`.

## The floor: macOS /bin/bash 3.2.57

This engine runs on the operator's Mac under stock `/bin/bash`. Forbidden, with
the replacement this repo actually uses:

| Forbidden (bash 4+) | Use instead |
|---|---|
| `mapfile` / `readarray` | `while IFS= read -r line; do …; done` over a heredoc/`find … -print0` |
| `declare -A` (assoc arrays) | parallel positional args + `select_role`-style helpers, or a python heredoc |
| `**` globstar | `find … -print0` + `while IFS= read -r -d ''` |
| `${var,,}` / `${var^^}` | `tr '[:upper:]' '[:lower:]'`, or push the logic into python |
| `&>` redirect | `>file 2>&1` |

Empty-array expansion under `set -u`: `${arr[@]+"${arr[@]}"}`
(see `bin/agents/claude.sh` `effort_args`).

## The gate

```bash
shellcheck -S warning start bin/*.sh bin/agents/*.sh tests/*.sh templates/autonomy-pack/qa/*.sh
```

`tests/*.sh` is part of the gate — a common miss. CI (`lint-and-test`) runs the
same line; local and CI must agree.

## Structural rules

- **Source-guard every executable script:** body wrapped in
  `if [ "${BASH_SOURCE[0]}" = "${0}" ]; then … fi` (or the `|| return 0` form)
  so tests can `source` it to get functions only. Functions-only files
  (`bin/agents/*.sh`) need no guard.
- `set -uo pipefail` at the top. NOT `set -e` — the supervisor's control flow
  depends on inspecting return codes.
- **Best-effort scripts never hard-fail their caller:** `board.sh` and
  `unblock_dependents.sh` warn to stderr and `exit 0` on every failure path.
- Python belongs in `lib/*.py` or a `python3 - <<'PY'` heredoc — never awk/sed
  towers for structured parsing.

## Bug classes with repo precedent

- **`local x="$(cmd)"` masks `cmd`'s exit status** (SC2155). Declare, then
  assign: `local x; x="$(cmd)"` — and when the status gates control flow, use
  `if ! x="$(cmd)"; then …` (see `run_session`'s `env_lines`/`rules_file`;
  the final review of PR #62 called this out as done right).
- **`VAR=value` line parsing must require the `=`.** `${line%%=*}` and
  `${line#*=}` both return the WHOLE line when there is no `=`, so a bare
  `PATH` line becomes `export PATH=PATH`. Guard first:
  `case "$line" in *=*) ;; *) continue ;; esac` (PR #62 final-review fix,
  `invoke_scoped_env`).
- **Secrets stay out of argv and logs.** Pass secrets via subshell-scoped
  `export` (`invoke_scoped_env`), never as a command argument; log the account
  NAME, never the value.
- **Config-sourced values are validated before landing in argv** even though
  the config is operator-owned — `valid_model_id`/`valid_effort` parity with
  the dashboard's own validation (defense in depth, #24/#62).

## shellcheck directives: scoped, commented, precedented

A directive needs a trailing comment saying WHY. Existing legitimate uses:

- `SC2086` intentional word-splitting where tokens are charset-guaranteed
  (`select_role "$role_rr" $dispatch_list` — names are `[A-Za-z0-9._-]` by the
  dispatch contract).
- `SC2034` vars consumed inside a *sourced* script (test files), or
  forward-declared globals whose consumer lands in a LATER task of the same
  PR — remove the directive in the task that adds the consumer (PR #62 did).
- `SC2163` on `export "${var}=${val}"` when a `case` guard already validated
  the name.

Never file-level-disable in `bin/`.

## Pre-push

Run the gate line above + `bash tests/run_all.sh` before every push — see
`pre-push-checklist.md`.
