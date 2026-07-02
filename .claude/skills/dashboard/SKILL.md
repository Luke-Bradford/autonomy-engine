---
name: dashboard
description: Use when changing, debugging, or verifying the control-room dashboard — bin/dashboard.py, lib/dashboard_state.py, lib/dashboard_control.py, lib/dashboard_page.html, or lib/config_page.html — or when a change needs browser-level verification.
---

# dashboard — control-room architecture + browser verify loop

## Architecture map

No build step, no framework, stdlib only. Four layers:

| Layer | File | Responsibility |
|---|---|---|
| Server | `bin/dashboard.py` | `http.server`, **loopback only** (127.0.0.1 default; `localhost` accepted; anything else refused at startup); routes; SSE; control token; owns the git/gh calls + TTL cache |
| State | `lib/dashboard_state.py` | PURE builders: read engine artifacts (session logs, supervisor.log, config) → JSON-able dicts. git/gh state is INJECTED by the server (`build_repo_state(git_in_flight=…)`) — builders never call the network. Unit-tested against `tests/fixtures/repo-alpha` |
| Control | `lib/dashboard_control.py` | PURE decisions for lifecycle writes (`control_plan`) + input validation (`_MODEL_RE` parity with the supervisor's `valid_model_id`) |
| Pages | `lib/dashboard_page.html` (main, 650ish lines), `lib/config_page.html` (config) | Vanilla JS, single file each, `__CONTROL_TOKEN__` substituted at serve time |

Routes: `GET /` (main page) · `GET /config` (config page) · `GET /api/state` ·
`GET /api/config` · `GET /api/stream` (SSE tick) · `POST /api/control` (the
ONLY write endpoint).

## Security contract (do not weaken)

- Binds loopback only; single-operator local tool.
- `POST /api/control` requires: Host header in the loopback allowlist (421
  otherwise — anti-DNS-rebinding), loopback Origin if present (403), body ≤
  8192 bytes, and a per-process token compared with
  `secrets.compare_digest` (403). Token is regenerated each launch and
  embedded in the served page — never logged.
- Server-side re-validation of every control value even though the page also
  validates (defense in depth). Lifecycle actions: `pause`/`resume`/`stop`/
  `start`; plus `set_model`, `config_set`, `repo_add`/`repo_remove`,
  `cred_*`, `acct_*`.
- Control responses carry short, structured validation reasons
  (`{"error": "invalid action"}`) — fine. What must never happen: raw
  exception text / tracebacks in an HTTP body, or pages rendering an error
  payload verbatim into the DOM. Detail goes to the server log.

## Conventions

- **State builders stay pure and best-effort**: a missing/corrupt artifact
  renders as a degraded field (`—`, `unknown`, empty list), never an exception
  — a dashboard hiccup must never look like an engine failure. New builders
  take paths/parsed-config as params (testable against fixtures), never call
  the network directly; `gh` goes through the server's TTL cache.
- Pages render server truth; no client-side state invention. New page sections
  follow the existing `sh` heading + `panel` structure; status text uses the
  existing status-token classes in the page CSS rather than new color schemes.
- Every mutating button goes through `POST /api/control` with the embedded
  token — never a new endpoint per feature.

## Browser verify loop (chrome-devtools MCP)

Run this before claiming any dashboard change done (pre-flight-review item J).

1. **Launch against the fixture repo** (background):
   ```bash
   python3 bin/dashboard.py --repo tests/fixtures/repo-alpha --port 8790
   ```
   Use a non-default port so a running operator dashboard is untouched.
2. **Drive it** with the chrome-devtools MCP tools:
   - `new_page` → `http://127.0.0.1:8790/` (and `/config`)
   - `take_snapshot` — assert the sections you changed render with fixture
     data (repo card shows `repo-alpha`, header stats populated)
   - `list_console_messages` — ZERO `error` entries is the bar; a JS exception
     on load is a blocker even if the page "looks fine". `[issue]`/`[verbose]`
     entries are devtools audit hints (e.g. "form field should have an id"),
     not blockers — note them, don't chase them mid-task
   - Exercise your change: `click`/`fill` the control, then `take_snapshot`
     again and assert the DOM outcome
   - `list_network_requests` — confirm `/api/state` and `/api/stream` return
     200, and any control POST you triggered returned 200 (not 400/403)
3. **Check the three states** for any data-bearing section you touched:
   populated (fixture data) · empty (a repo with no sessions yet) · degraded
   (artifact missing — builders must render the fallback, not blank the page).
4. Kill the server; note the verification (page, actions, console-clean) in
   the PR's Testing section.

Unit tests still carry the logic coverage (`tests/test_dashboard_state.py`,
`tests/test_dashboard_control.py`); the browser loop is for what unit tests
can't see — JS wiring, token plumbing, layout collapse, console errors.
