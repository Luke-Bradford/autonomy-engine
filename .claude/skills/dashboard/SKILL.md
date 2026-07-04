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
4. **Temporal pass** (`evaluate_script` — flicker/jank/thrash are TEMPORAL; a
   snapshot literally cannot contain them, so a green static pass is not enough
   — the #174 flicker and its regression both shipped through green QA). Let the
   fixture tick with ZERO interaction and instrument *time*, not frames:
   ```js
   // paste as one evaluate_script; observes an idle window then reports
   async () => {
     // steady-state CLS: fresh observer AFTER load settles (NO buffered:true --
     // load-time settling shifts are expected; only post-load motion is a defect)
     let cls = 0; const ls = new PerformanceObserver(l => {
       for (const e of l.getEntries()) if (!e.hadRecentInput) cls += e.value; });
     ls.observe({type:'layout-shift'});
     // panel REBUILDS only: childList mutations adding/removing an ELEMENT node.
     // Text-node rewrites from the minute-granularity countdown ticker (#238) are
     // benign motion and MUST be excluded, or every panel reads as churning.
     const ids = ['repos','focus','activity','handoffs','quota','history','needsyou','voice'];
     const rebuild = {}, obs = [], hasEl = nl => [...nl].some(n => n.nodeType===1);
     // stability compare BLANKS the known ticking cells (roster minute spans
     // data-g, countdown .qreset) so a benign "5m"->"4m" rollover mid-window is
     // not read as a rebuild -- only structural markup change trips this bar.
     const norm = el => { const c = el.cloneNode(true);
       c.querySelectorAll('[data-g],.qreset').forEach(n => n.textContent=''); return c.innerHTML; };
     const snap = () => ids.reduce((o,id)=>{const e=document.getElementById(id); if(e) o[id]=norm(e); return o;}, {});
     for (const id of ids) { const el=document.getElementById(id); if(!el) continue; rebuild[id]=0;
       const mo=new MutationObserver(ms=>{for(const m of ms) if(m.type==='childList'&&(hasEl(m.addedNodes)||hasEl(m.removedNodes))) rebuild[id]++;});
       mo.observe(el,{childList:true,subtree:true}); obs.push(mo); }
     const h0 = snap();
     await new Promise(r => setTimeout(r, 12000));   // idle, no interaction
     ls.disconnect(); obs.forEach(o=>o.disconnect());
     const h1 = snap(), stable = {}; for (const id in h0) stable[id] = h0[id]===h1[id];
     return { steadyStateCLS:+cls.toFixed(4), elementRebuildsPerPanel:rebuild, innerHTMLStable:stable };
   }
   ```
   Bar: **`steadyStateCLS` < 0.01**, every panel **`innerHTMLStable` true**, and
   `elementRebuildsPerPanel` ≤ 1 on an unchanged fixture. A panel that rebuilds
   its subtree every tick while its markup is byte-identical is a jank/flicker
   risk (node-identity churn resets CSS transitions, `:hover`, text selection,
   in-panel scroll) — the #174/#238 class. Only `renderRepos` carries the
   skip-unchanged guard today; if you touch another panel's render, give it the
   same guard rather than an unconditional `el.innerHTML = …` each tick.
   **Dirty-control survival** (#202 defect 3 — an SSE re-render must not revert an
   operator's un-saved edit): on `/config`, set a `select`/input via JS, fire its
   `change`/`input` event, `await` ~6 s (2–3 poll cycles), assert the value is
   still what you set. A control the tick clobbers is a `ux` blocker.
5. Kill the server; note the verification (page, actions, console-clean, and the
   temporal readings) in the PR's Testing section.

Unit tests still carry the logic coverage (`tests/test_dashboard_state.py`,
`tests/test_dashboard_control.py`); the browser loop is for what unit tests
can't see — JS wiring, token plumbing, layout collapse, console errors.

## The operator's LIVE dashboard (do not manage it yourself)

The instance on 127.0.0.1:8787 is a SUPERVISED CHILD of `bin/console.py`
(VSCode task "Autonomy: console" / `Start Autonomy.command`): a watchdog
relaunches it within ~1s of any exit, and startup consolidates to one
dashboard. Blessed as THE manager (settled decision 32; launchd rejected —
a second manager fights the watchdog).

- To apply new server code: `kill <dashboard pid>` and do NOTHING else —
  the watchdog respawns it from the (pulled) checkout. NEVER start a
  replacement server on the port: the watchdog crash-loops on
  `Errno 48 Address already in use` against your orphan (2026-07-04
  incident, operator's terminal spammed with tracebacks).
- Page + lib modules hot-reload per request (#166) — page/state-only merges
  need NO restart, just a browser refresh; only `bin/dashboard.py` changes
  need the kill-and-respawn.
- The page is served from the MAIN checkout — after merging UI work, pull
  that checkout or the operator keeps seeing the old page (#270's chip now
  surfaces this; the pull is still the fix).
- Verify loops always use a THROWAWAY port (8790+) against fixtures; never
  drive controls against 8787 beyond read-only page loads.
