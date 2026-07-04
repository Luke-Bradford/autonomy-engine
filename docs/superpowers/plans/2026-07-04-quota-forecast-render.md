# Quota Forecast Render (#188b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the already-built burn-rate quota forecast (`quota_forecast`, #188b) on the quota card as a "projected exhaustion + can-finish-safely" line, threaded onto the displayed window so it can never pair the wrong forecast to the wrong window.

**Architecture:** The forecast math (`quota_forecast`) is built and tested but unrendered. It is keyed by window type from LOG-scan windows, while the quota card renders a SINGLE dynamically-selected window (the live account window when present, else the log-scan max across repos). Pairing two separately-keyed structures at render time is the source-correspondence trap. Instead, a new pure `attach_quota_forecast(windows, now)` threads each window's forecast onto the window dict itself at BOTH build sites (per-repo `build_repo_state`, and the server live-quota assembly in `bin/dashboard.py:_account_usage`), so the window the card selects always carries the matching forecast by construction. `qrow` then renders `win.forecast`.

**Tech Stack:** Python 3 stdlib only (`lib/dashboard_state.py`, `bin/dashboard.py`); vanilla JS in `lib/dashboard_page.html`.

## Global Constraints

- Python 3 stdlib only — no third-party imports.
- Best-effort / total: `attach_quota_forecast` never raises; a non-mapping passes through unchanged (prevention-log #12 — a pure projection over cached data must be total).
- Non-mutating: the live windows come from a shared usage cache (`bin/dashboard.py:_account_usage` → `cu.live_quota()` returns the shared `_cache["val"]`); `attach_quota_forecast` must NOT mutate its input.
- Degrade-to-truth / "never imply certainty it lacks" (the #187/#188 acceptance test): a window `quota_forecast` omits gains no `forecast` key and renders nothing; the forecast line is explicitly labelled a burn projection ("at this burn"), never an assertion.
- Repo-agnostic: no target-repo-specific values.

---

### Task 1: `attach_quota_forecast` pure helper

**Files:**
- Modify: `lib/dashboard_state.py` (add after `quota_forecast`, ~line 1494)
- Test: `tests/test_dashboard_state.py` (new `TestAttachQuotaForecast` after `TestQuotaForecast`)

**Interfaces:**
- Consumes: `quota_forecast(windows, now) -> {wtype: {projected_exhaust_epoch, exhausts_before_reset, resets_at}}` (existing).
- Produces: `attach_quota_forecast(windows, now) -> windows'` — a NEW dict; each window that has a forecast gains a `forecast` sub-dict (shallow-copied window); non-window keys (e.g. `source`) and forecast-omitted windows pass through untouched; non-mapping input returned unchanged.

- [ ] **Step 1: Write the failing tests**

```python
class TestAttachQuotaForecast(unittest.TestCase):
    """attach_quota_forecast (#188b render seam): threads each window's burn-rate
    forecast onto the window dict itself, so the quota card -- which renders ONE
    selected window (live account window or the log-scan max) -- carries the
    matching forecast by construction instead of pairing two separately-keyed
    structures at render time. Non-mutating (live windows are a shared cache) and
    total (best-effort, never raises)."""

    NOW = 1000000

    def _win(self, util, resets_at, wtype="five_hour"):
        return {wtype: {"utilization": util, "resets_at": resets_at, "overage": False}}

    def test_forecast_attached_onto_window(self):
        w = self._win(0.75, self.NOW + 9000)
        out = ds.attach_quota_forecast(w, self.NOW)
        self.assertEqual(out["five_hour"]["forecast"],
                         ds.quota_forecast(w, self.NOW)["five_hour"])

    def test_input_not_mutated(self):
        w = self._win(0.75, self.NOW + 9000)
        ds.attach_quota_forecast(w, self.NOW)
        self.assertNotIn("forecast", w["five_hour"])

    def test_omitted_window_gets_no_forecast_key(self):
        w = self._win(0.0, self.NOW + 9000)   # zero burn -> quota_forecast omits it
        out = ds.attach_quota_forecast(w, self.NOW)
        self.assertNotIn("forecast", out["five_hour"])

    def test_non_window_keys_passthrough(self):
        w = self._win(0.75, self.NOW + 9000)
        w["source"] = "live"                  # live_quota carries a 'source' string
        out = ds.attach_quota_forecast(w, self.NOW)
        self.assertEqual(out["source"], "live")

    def test_non_mapping_passthrough(self):
        self.assertIsNone(ds.attach_quota_forecast(None, self.NOW))
        self.assertEqual(ds.attach_quota_forecast([], self.NOW), [])

    def test_build_repo_state_quota_windows_carry_forecast(self):
        st = ds.build_repo_state(FIX, git_in_flight=lambda p: {}, now=self.NOW)
        for wt, f in st["quota_forecast"].items():
            self.assertEqual(st["quota"][wt].get("forecast"), f)
```

- [ ] **Step 2: Run to verify fail**

Run: `python3 -m pytest tests/test_dashboard_state.py -k AttachQuotaForecast -v` (or the repo's `python3 tests/test_dashboard_state.py`)
Expected: FAIL — `attach_quota_forecast` not defined.

- [ ] **Step 3: Implement**

```python
def attach_quota_forecast(windows, now):
    """Thread each window's burn-rate forecast (#188b) onto the window dict, so
    the quota card -- which renders a SINGLE selected window (the live account
    window or the log-scan max across repos) -- carries the matching forecast by
    construction, closing the source-correspondence trap (the top-level
    `quota_forecast` is keyed by window type, but the DISPLAYED window is chosen
    dynamically). Returns a NEW dict with a shallow copy of each forecasted
    window -- never mutates the input, because the live windows come from a shared
    usage cache (bin/dashboard.py:_account_usage). Total/best-effort: a
    non-mapping passes through unchanged, and windows quota_forecast omits (no
    honest forecast) gain no `forecast` key -- degrade-to-truth, never a
    fabricated projection."""
    if not isinstance(windows, dict):
        return windows
    fc = quota_forecast(windows, now)
    out = {}
    for key, win in windows.items():
        if key in fc and isinstance(win, dict):
            enriched = dict(win)
            enriched["forecast"] = fc[key]
            out[key] = enriched
        else:
            out[key] = win
    return out
```

- [ ] **Step 4: Wire into `build_repo_state`** — change `"quota": quota,` to `"quota": attach_quota_forecast(quota, now),` (keep the existing `"quota_forecast": quota_forecast(quota, now),` line for the back-compat consumer/test).

- [ ] **Step 5: Run tests to verify pass**

Run: `python3 tests/test_dashboard_state.py`
Expected: PASS (incl. existing `test_build_repo_state_includes_quota_forecast`).

- [ ] **Step 6: Commit**

---

### Task 2: Live-quota assembly attaches forecast

**Files:**
- Modify: `bin/dashboard.py:_account_usage` (~line 751)

**Interfaces:**
- Consumes: `ds.attach_quota_forecast` (Task 1); `cu.live_quota() -> {five_hour, seven_day, source} | None`.
- Produces: `usage["claude"]` windows carry `forecast` when live.

- [ ] **Step 1: Implement** — wrap the live-quota read:

```python
    try:
        usage["claude"] = ds.attach_quota_forecast(cu.live_quota(), now)
    except Exception:
        usage["claude"] = None
```

(`attach_quota_forecast(None, now)` returns `None` — the existing fallback path is preserved; the `source` string key passes through.)

- [ ] **Step 2: Run gates** — `python3 tests/test_dashboard.py` (if present) + full suite stays green. No unit test seam here (server assembly); covered by the browser verify loop in Task 4.

- [ ] **Step 3: Commit**

---

### Task 3: `qrow` renders the forecast line

**Files:**
- Modify: `lib/dashboard_page.html:qrow` (~line 774)

**Interfaces:**
- Consumes: `win.forecast = {projected_exhaust_epoch, exhausts_before_reset, resets_at}` (optional).

- [ ] **Step 1: Implement** — inside `qrow`, before the `return`, build the forecast sub-line:

```javascript
  const fc = win && win.forecast;
  let fline = "";
  if(fc && fc.projected_exhaust_epoch!=null){
    const eta = fc.projected_exhaust_epoch - now;
    if(eta<=0){
      fline = `<div class="q-sub"><span style="color:var(--warn)">at burn limit now</span></div>`;
    } else if(fc.exhausts_before_reset){
      fline = `<div class="q-sub"><span style="color:var(--warn)">at this burn: full in `
            + `<span class="qreset" data-e="${fc.projected_exhaust_epoch}">${dur(eta)}</span> — before reset</span></div>`;
    } else {
      fline = `<div class="q-sub"><span style="color:var(--ok)">at this burn: safe — window refills before limit</span></div>`;
    }
  }
```

Append `${fline}` just before the closing `</div>` of the `.q` block in the return.

- [ ] **Step 2: Commit**

---

### Task 4: Browser verify loop (dashboard FE-QA)

**Files:** none (verification only) — per `.claude/skills/dashboard/SKILL.md`.

- [ ] **Step 1:** Launch `python3 bin/dashboard.py --repo tests/fixtures/repo-alpha --port 8790`.
- [ ] **Step 2:** chrome-devtools: `new_page` → `take_snapshot` of `/` → assert the quota card renders; if fixture windows carry a forecast, assert the forecast line appears with the correct safe/warn colour and a ticking countdown (temporal pass, prevention-log #13). Craft a `/tmp` fixture with a fast-burn window if repo-alpha yields no forecast.
- [ ] **Step 3:** `list_console_messages` — ZERO `error` entries. `list_network_requests` — `/api/state` + `/api/stream` 200.
- [ ] **Step 4:** Kill the server. File a verified `bug`/`ux` issue for anything wrong.

---

## Self-Review

- **Spec coverage:** #188(b) = "burn-rate forecast: projected exhaustion time and a 'current session can finish safely' indicator." Task 3 renders projected exhaustion (countdown) + safe/before-reset indicator. Parts (a) token chart and (c) trigger health already shipped (#233/#231). ✅
- **Placeholder scan:** none — all code shown. ✅
- **Type consistency:** `attach_quota_forecast(windows, now)` used identically in Tasks 1/2; `win.forecast` keys (`projected_exhaust_epoch`, `exhausts_before_reset`) match `quota_forecast`'s output. ✅
