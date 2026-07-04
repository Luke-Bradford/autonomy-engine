# Plan — #206: live claude_subscription model roster via OAuth /v1/models (backend slice)

## Goal
PR #200 shipped `/api/models` but `claude_subscription` still returns the curated
3-model list. The live slice is a verified recipe: `GET
https://api.anthropic.com/v1/models` with the Claude Code OAuth token (Keychain
`Claude Code-credentials` → `claudeAiOauth.accessToken`) + headers
`anthropic-version: 2023-06-01` and `anthropic-beta: oauth-2025-04-20` → 200 with
~10 models (incl. `claude-fable-5`), each with `display_name`. Implement it in
`accounts.list_models`, live-first with a ~5-min cache and a curated fallback on
ANY failure. Acceptance: `/api/models?account=<claude-sub>` returns
`source: live` with ~10 models; the pickers show them.

Scope: BACKEND only (accounts.py + the dashboard handler + tests) — no network in
tests (every seam injected). This slice returns model IDS only; surfacing
`display_name` (fetch shape + `/api/models` response + frontend + browser-verify)
is a clean follow-up slice, noted on the issue.

## CP1 resolutions (baked into the design below)
- `/api/models` stays **all-accounts** (the frontend's actual call —
  `config_page.html` does `fetch("/api/models")` with no param). The acceptance's
  `?account=<claude-sub>` is a manual-curl illustration, satisfied by that
  account's row now carrying `source: live`. No query-param handling added.
- **Cache is stampede- AND stale-overwrite-safe:** `live_claude_models` holds the
  lock ACROSS the fetch (serializes cold callers — one fetches, the rest get the
  cached result). `claude_usage`'s release-during-fetch is safe only because a
  single sampler writes it; this is called from request threads, so serialize.
  `/api/models` is a per-config-load call (not hot), so a ≤5s cold block is fine;
  the 5-min TTL makes every later call a lock-free-ish cache hit.
- **IDS only** this slice (no `display_name` in the return — no unused data).
- `_fetch_live_claude_models` **closes the response** in a `finally` (mirrors
  `claude_usage.fetch_usage`).
- **Mixed-row payload:** collect every row with a non-empty str `id`, SKIP invalid
  rows; return the collected list. None ONLY when the payload is unparseable /
  `data` missing / ZERO valid rows (one bad row never poisons the good ones).
- **Dashboard contract:** `models_read_model` switches to `discover_models`; the
  `_FakeAccts` double gains `discover_models` and `TestModelsReadModel` is updated
  — incl. a test that a raising `discover_models` mid-loop discards the partial
  (accounts=[]+error), preserving the existing fail-safe.
- `list_models` going live-first means the CLI `list-models` + cold callers do one
  token+HTTP round-trip (≤ timeout) then cache — intended for live discovery.

## Design
`lib/accounts.py` (stdlib only; REUSE `claude_usage._read_oauth_token` — the
security-critical Keychain/OAuth read is single-sourced there, #160/#163):
- `_fetch_live_claude_models(token, opener=None, timeout=5)` → list of
  `{"id", "display_name"}`, or None. GETs `/v1/models` with the version+beta
  headers + `Authorization: Bearer <token>`. NEVER re-raises (so no header text
  can leak), never puts the token on argv. Parses `data[]`: each needs a non-empty
  str `id`; `display_name` optional (defaults to `id`). Empty token / non-200 /
  transport error / non-JSON / no valid rows → None.
- Module cache `_live_models_cache {ts,val,seen}` + `_LIVE_TTL=300` + a
  `threading.Lock` (mirrors `claude_usage`). `reset_live_models_cache()` test hook.
- `live_claude_models(now=None, token_reader=claude_usage._read_oauth_token,
  fetcher=_fetch_live_claude_models, ttl=_LIVE_TTL)` → the cached list or None.
  Self-throttled (a no-op within ttl); reads the token fresh each real cycle;
  fail-safe: ANY error writes None (never fail-open to stale-live).
- `list_models(name)`: for `claude_subscription`, live-first —
  `live_claude_models()` non-empty → its ids, else `subscription_models(kind)`
  (curated). `codex_subscription` (no models API) + everything else unchanged.
  Still returns a plain id list, so existing callers (concierge dashboard.py:1175,
  the CLI) are unaffected.
- `discover_models(name)` → `{"source": "live"|"curated"|"none", "models": [ids]}`
  — the SOURCE-TRUTHFUL method `/api/models` uses (source must reflect what
  actually produced the list, not a static per-kind guess). claude_subscription:
  live present → `live`, else `curated`; openai_compatible → `model_source` +
  `list_models`; else → `none`, []. Reuses `model_source` for the non-subscription
  cases so the static mapping stays single-sourced.

`bin/dashboard.py::models_read_model`: swap the static `source = model_source(kind);
models = list_models(name)` for `d = inst.discover_models(name)` → `source =
d["source"]`, `models = d["models"]`. Same fail-safe envelope (partial discarded,
never a 500).

## Invariants respected
- **Fail-safe never fail-open:** every live failure (offline / 401 / timeout /
  malformed) degrades to the curated roster (picker still works); a failure
  REPLACES a cached live value with None, never serves stale-live.
- **Secret hygiene (#160/#163):** the OAuth token is read via `claude_usage`
  (Keychain, in-memory), transits ONLY the in-process `Authorization` header,
  never on argv, never logged, never in a return value or surfaced error.
- **Single-source:** the token read reuses `claude_usage._read_oauth_token`; the
  per-kind source mapping reuses `model_source`; the curated fallback reuses
  `subscription_models`. No forks.
- **Python-3 stdlib only. Repo-agnostic** (the URL/headers are Anthropic's public
  API, not target-repo values). **Best-effort:** `list_models`/`discover_models`
  never raise (the config UI + dispatch must not break).

## Tests (`tests/test_accounts.py`, every seam injected — no network/Keychain)
- `_fetch_live_claude_models`: good payload → ids + display_name (default to id
  when absent); non-200 → None; non-JSON / missing `data` / row without `id` →
  None; the token rides the header, NEVER a return value or error.
- `live_claude_models`: cold → fetch + cache; within ttl → no refetch (throttle);
  fetch failure → None (fallback), and REPLACES a prior live value (never stale).
- `list_models`: claude_subscription live present → live ids; live None → curated.
- `discover_models`: claude_subscription live → `source:live`; live None →
  `source:curated`; openai_compatible → `source:live` + ids; api-kind → `none`.
