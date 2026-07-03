# `./start status` — read-only live-health report (issue #81, first slice)

**Goal:** Give the operator a positive "is it healthy?" signal without changing
how the dashboard is launched. `./start status` prints a read-only report and
exits — it never binds a port, never launches the dashboard, never runs
launchctl. This is the decision-free slice of #81; the managed-process lifecycle
(launchd service vs PID-file, `./start stop`/hard-kill) is the operator-direction
remainder, deferred.

**Scope (this PR):**
- `start` gains a `status` subcommand and two functions (sourced/testable):
  - `dashboard_pids()` — `pgrep -f bin/dashboard.py` (the operator-endorsed
    probe), `|| true` so `set -e` never trips and no match is not an error.
    A seam: tests override this function after sourcing (like the existing
    function-source pattern in `tests/test_start.sh`).
  - `start_status_report()` — prints doctor-style `OK`/`WARN` lines:
    - dashboard: running (with pid list) via `dashboard_pids`, else not running
      (+ the `pkill -f bin/dashboard.py` hard-kill hint the operator gave).
    - gh auth: `gh auth status` ok/not (same check `doctor.sh` uses; the test's
      gh shim already exercises both paths).
    - loops: registered-repo count from `start_repos_file` + a pointer to
      `bin/control.sh list` for per-loop detail (no launchctl call here — keeps
      the report read-only and the test uncoupled from control.sh internals).
  - Executable body: if `$1 == status`, run `start_status_report` and `exit 0`
    BEFORE the existing arg loop / mode logic, so status works in setup mode too.

**Contracts / invariants:**
- **A well-formed `./start status` always `exit 0`** regardless of system
  health — health lives in the text (OK/WARN lines), not the exit code, and a
  probe hiccup warns in text rather than aborting under `set -euo pipefail`.
  This is distinct from a **usage error**: `./start status <extra>` is a
  malformed invocation and exits `2`, matching `start`'s existing convention
  (unknown flag / unexpected argument → `2`). "Always exit 0" is the report
  contract, not a licence to accept garbage arguments.
- **Probe strings are regex-safe:** `dashboard_pids` feeds `pgrep -f`, which
  matches a REGEX, so the checkout path is escaped before use (a '.' in the
  path must not mean "any char") — prevention-log #6.
- **Never runs launchctl / never binds** (the `start` header contract): the
  status path returns before `DASH_ARGV`/`exec`, and calls no launchctl.
- **bash 3.2.57:** no bash-4isms; `pgrep`/`gh` are the only externals; empty
  `pids` handled with `[ -n ... ]`.
- **Repo-agnostic:** nothing target-specific; reads only `start_repos_file`.

**Tests (`tests/test_start.sh`, real functions sourced, stubs at seams):**
1. sourcing defines `start_status_report` + `dashboard_pids`.
2. `dashboard_pids` overridden to echo a pid → report says "dashboard running
   (pid 999)".
3. overridden to echo "" → "dashboard not running" + hard-kill hint.
4. gh shim rc1 → "gh auth not authenticated"; a `gh(){ return 0; }` shadow →
   "gh auth ok".
5. integration: `bash start status` exits 0, prints the health header, and the
   launchctl shim log gains NO new entries (never launches/binds).

**Deferred (annotate #81):** the managed lifecycle — dashboard under launchd
(`com.autonomy.dashboard.plist`) or PID-file + `./start stop|restart` with clean
SIGTERM/hard-kill. That carries the launchd-vs-PID-file design fork the operator
listed and is operationally sensitive to build unattended; it stays for an
operator-in-the-loop pass.
