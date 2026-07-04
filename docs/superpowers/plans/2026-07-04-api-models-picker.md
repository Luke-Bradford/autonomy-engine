# Plan — #82 live per-account model discovery in the config picker

## Context / prior slices

- #82a: curated `_SUBSCRIPTION_MODELS` roster + `Accounts.list_models(name)` backend
  (lib/accounts.py). openai_compatible → live `GET <base_url>/v1/models` (timeout 5, `[]` on
  any error, never raises); claude/codex_subscription → curated roster; else `[]`.
- #146/#134: config page model fields (`agent.model.primary/.fallback`) backed by a shared
  `<datalist id="cfg-models">`, filled at build time from
  `accounts.subscription_models("claude_subscription")` (single-sourced, injected by
  `_page_bytes`). Datalist = free-text: pick a known id OR type any custom/local id.

## Operator direction (2026-07-03, resolves the design fork)

"Not many people know the model-id formatting — should be able to just pick." The picker's
SOURCE follows the account: `openai_compatible` → LIVE `list_models`; subscriptions → curated
roster; keep a custom escape hatch (datalist stays free-text). Pick is default, typing the
exception.

## This slice (one PR)

Wire the LIVE per-account discovery (`Accounts.list_models`) into the config page so a local
endpoint's real models (e.g. an Ollama account's `qwen3:14b`) autocomplete in the model fields —
without restructuring the per-repo config section (repo↔account binding belongs to the parked
UI-redesign wave / #87, not here). The datalist (pick-or-type) already satisfies
"pick default, type escape"; this slice just makes its suggestions live, not build-time-only.

### Task 0 — `model_source(kind)` public helper in `lib/accounts.py` (Codex F4)

The source decision lives beside `_SUBSCRIPTION_MODELS`/`list_models`, single-sourced — `bin/`
never reaches into the private `_SUBSCRIPTION_MODELS`:
```python
def model_source(kind):
    """Which config-picker discovery SOURCE an account `kind` uses (#82):
    "live" (openai_compatible -> list_models does GET /v1/models) / "curated"
    (a CLI-login subscription served from _SUBSCRIPTION_MODELS) / "none" (an api
    key / unknown kind: no roster to offer). Kept here so the decision cannot
    drift from list_models."""
    if kind == "openai_compatible":
        return "live"
    if kind in _SUBSCRIPTION_MODELS:
        return "curated"
    return "none"
```
Tests in `tests/test_accounts.py`: each kind → its source.

### Task 1 — backend `models_read_model()` + `GET /api/models` (TDD)

`bin/dashboard.py`, mirroring the existing `config_read_model()` seam:

```python
def models_read_model():
    """Per-account discovered models for the config picker (#82). Best-effort:
    Accounts.list_models never raises; any registry-level failure yields
    accounts=[] + error -- fail-safe: never a partial list, never a 500."""
    accounts, err = [], None
    try:
        inst = _accts()                       # bind once -- one snapshot (F3)
        for a in inst.list():
            name, kind = a.get("name"), a.get("kind")
            source = accts.model_source(kind)
            models = inst.list_models(name) if source != "none" else []
            accounts.append({"name": name, "kind": kind,
                             "source": source, "models": models})
    except Exception as exc:                  # discard any partial (F2/F5)
        accounts, err = [], (str(exc) or exc.__class__.__name__)
    return {"accounts": accounts, "error": err}
```

Route in `do_GET` after `/api/config`:
```python
elif path == "/api/models":
    self._send(200, json.dumps(models_read_model()).encode("utf-8"))
```

- Fail-safe (prevention #3, Codex F2): registry error → `{"accounts": [], "error": msg}`; the
  partial list is DISCARDED, never returned, never a 500. `list_models` already `[]`-on-error.
- One `_accts()` binding per read (Codex F3) — `list()` and `list_models()` share one snapshot.
- No query param → no user-controlled string reaches argv/lookup (prevention #6 avoided by design).

Tests (`tests/test_dashboard_server.py`), monkeypatching `dashboard._accts_singleton[0]` to a fake
with known `list()` + `list_models`:
- openai_compatible → `source=="live"`, models from `list_models`.
- claude_subscription → `source=="curated"`, curated roster.
- unknown/api kind → `source=="none"`, `models==[]`, `list_models` NOT consulted.
- registry `.list()` raises → `{"accounts": [], "error": <msg>}` (fail-safe, no raise).
- **partial-failure (F5): first account ok, `list_models` raises on the second → `accounts==[]`**
  (no leaked partial suggestions).

### Task 2 — config page merges live models into the datalist, with provenance (Codex F1/F6)

`lib/config_page.html`:
- `let LIVE_MODELS=[];` module-level — `[{id,label}]`, `label = "<account> · <source>"`.
- `modelOptions()` → deduped `MODEL_CHOICES` (build-time, label "curated") ∪ `LIVE_MODELS`,
  rendered as `<option value=id label=provenance>` so a cross-account suggestion shows WHERE it
  came from (addresses wrong-account pollution without the parked repo↔account restructure).
- `renderCfg` builds `#cfg-models` from `modelOptions()`; `updateModelDatalist()` refreshes in place.
- `load()` also calls `loadModels()`: `fetch("/api/models")` → **if `d.error` is set, ignore the
  discovered models entirely (F6)**; else set `LIVE_MODELS` and refresh. `.catch(()=>{})` — best
  effort, never toast, never block config render.

### Task 3 — browser-verify + docs

- Dashboard skill browser-verify loop on `/config` (fixture repo-alpha, port 8790): page renders,
  `#cfg-models` holds the 3 curated ids (label "curated") AND the fixture `local-llm`
  openai_compatible account's 2 LIVE ids (`qwen3:14b`, `deepseek-r1:14b`, label "local-llm · live")
  — the fixture DOES stand up a reachable endpoint, so the live-merge + dedup + provenance path is
  observed end-to-end, not just unit-tested. ZERO console errors; `GET /api/config` +
  `GET /api/models` both 200 with well-formed shape.
- Remaining-work note on #82: the full per-account `<select>` that swaps source by a *selected*
  account (vs. the labelled cross-account datalist union) is the bigger UI restructure tied to the
  parked redesign / #87. This slice delivers live discovery + provenance; scoped selection defers.

## Invariants honoured

- Repo-agnostic: no target model ids in `bin/`/`lib/`; local ids come live from the account.
- Python 3 stdlib only; bash untouched.
- Fail-safe never fail-open; single-sourced roster preserved (`subscription_models`).
