# Config Model Overlay Implementation Plan (#202 defect 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dashboard's "save as default" (and config-page saves) of `agent.model.primary` / `.fallback` / `agent.effort` **survive the supervisor's preflight stash-recovery** by writing them to an untracked overlay file that shadows the committed `config.yaml`, instead of rewriting the git-tracked `config.yaml` (which the preflight sweeps into a stash → the operator's setting silently reverts).

**Architecture:** A persistent overlay file `<repo>/var/autonomy-logs/config-overrides` (short `key=value` lines: `model=`/`fallback=`/`effort=`), living in the **already-gitignored** `var/autonomy-logs/` dir (same home as the one-shot `model-override`), so it is never seen by `git status` and never stashed. Only the three model/effort keys route to the overlay; every consumer of those keys (the supervisor's per-session resolution + the dashboard display) reads the overlay *shadowing* `config.yaml` at the existing `agent.*` precedence tier. board.owner/title/merge_gate keep writing `config.yaml` (their consumers — board.sh, safe_merge, doctor — have no overlay read seam; routing them to the overlay would make them silently not take effect, worse than reverting). Committed `config.yaml` stays the source of truth; the UI labels an overlay value "local override".

**Tech Stack:** Python 3 stdlib only; macOS bash 3.2.57.

## Global Constraints

- macOS `/bin/bash` 3.2.57 compatible (no mapfile/globstar/assoc-arrays/`${var,,}`).
- Python 3 stdlib only; config access through `lib/config_parser.py`.
- Every script's executable body guarded by `[ "${BASH_SOURCE[0]}" = "${0}" ] || return 0`.
- `shellcheck -S warning` clean across the standard fileset (incl. `tests/*.sh`).
- Tests source the real script / import the real module; mock only at established seams.
- **Precedence unchanged (settled-decision #13):** one-shot > CLI > role > agent.* > default. The overlay resolves *within* the agent.* tier (overlay-if-present else committed `config.yaml`); role/CLI/one-shot still win over it.
- **Fail-safe:** a missing/invalid overlay is ignored (falls back to committed `config.yaml`), never an error.

---

### Task 1: dashboard_control — route model/effort default-saves to the overlay

**Files:**
- Modify: `lib/dashboard_control.py` (`set_model_plan`, `config_set_plan`, add `overrides_path`, `OVERLAY_KEYS`)
- Test: `tests/test_dashboard_control.py`

**Interfaces:**
- Produces:
  - `overrides_path(repo) -> str` = `<repo>/var/autonomy-logs/config-overrides`
  - `OVERLAY_KEYS` = `{"agent.model.primary":"model","agent.model.fallback":"fallback","agent.effort":"effort"}`
  - `set_model_plan(repo, model, effort, scope="default")` returns `{"overlay": path, "overlay_set": {"model":..,"effort":..}, "message":..}` (short keys; only present ones).
  - `config_set_plan(repo, key, value)` for a key in `OVERLAY_KEYS` returns `{"overlay": path, "overlay_set": {short: value}, "message":..}`; other keys unchanged (`config_path`/`config_set`).
  - session scope of `set_model_plan` unchanged (`write`/`content`).

- [ ] **Step 1: Write the failing tests** in `tests/test_dashboard_control.py`

```python
def test_set_model_default_writes_overlay_not_config():
    p = dcx.set_model_plan("/r", "claude-opus-4-8", "high", "default")
    assert p["overlay"].endswith("var/autonomy-logs/config-overrides")
    assert p["overlay_set"] == {"model": "claude-opus-4-8", "effort": "high"}
    assert "config_path" not in p

def test_config_set_model_key_routes_to_overlay():
    p = dcx.config_set_plan("/r", "agent.model.primary", "claude-sonnet-5")
    assert p["overlay_set"] == {"model": "claude-sonnet-5"}
    assert "config_path" not in p

def test_config_set_board_key_still_writes_config():
    p = dcx.config_set_plan("/r", "board.owner", "octo")
    assert p["config_set"] == {"board.owner": "octo"}
    assert "overlay" not in p
```

- [ ] **Step 2: Run — expect FAIL** (`overlay` key absent).

Run: `python3 tests/test_dashboard_control.py`
Expected: FAIL (KeyError / assertion).

- [ ] **Step 3: Implement** in `lib/dashboard_control.py`

```python
def overrides_path(repo):
    return os.path.join(repo, "var", "autonomy-logs", "config-overrides")

# The model/effort keys whose page-writes go to the untracked overlay (survive
# preflight recovery) instead of the tracked config.yaml. Dotted config key ->
# the short overlay key the supervisor/dashboard already parse (mirrors the
# one-shot model-override format). board.*/merge_gate.* stay config.yaml-written
# because their consumers (board.sh, safe_merge, doctor) have no overlay seam.
OVERLAY_KEYS = {"agent.model.primary": "model",
                "agent.model.fallback": "fallback",
                "agent.effort": "effort"}

_OVERLAY_MSG = ("saved as a local override (survives the loop's preflight; "
                "config.yaml stays the committed default) — applies next session")
```

In `set_model_plan`, replace the `scope == "default"` block:

```python
    overlay_set = {}
    if model:
        overlay_set["model"] = model
    if effort:
        overlay_set["effort"] = effort
    return {"overlay": overrides_path(repo), "overlay_set": overlay_set,
            "message": _OVERLAY_MSG}
```

In `config_set_plan`, after validation, before the config.yaml return:

```python
    short = OVERLAY_KEYS.get(key)
    if short is not None:
        return {"overlay": overrides_path(repo), "overlay_set": {short: value},
                "message": "%s saved as a local override — applies next session" % key}
```

- [ ] **Step 4: Run — expect PASS.**

Run: `python3 tests/test_dashboard_control.py`
Expected: PASS.

- [ ] **Step 5: Commit** `fix: route model/effort default-saves to an untracked overlay plan (#202)`

---

### Task 2: dashboard.py — overlay executor (merge-preserving, atomic)

**Files:**
- Modify: `bin/dashboard.py` (`execute_set_model`, `execute_config_set`, add `_write_overlay`)
- Test: `tests/test_dashboard_server.py`

**Interfaces:**
- Consumes: Task 1's `{"overlay", "overlay_set"}` plan shape.
- Produces: `_write_overlay(path, overlay_set)` — reads existing `key=value` lines, updates with `overlay_set`, writes atomically (`.tmp` + `os.replace`), makedirs the parent. Keys not in `overlay_set` are preserved.

- [ ] **Step 1: Write the failing tests** in `tests/test_dashboard_server.py`

```python
def test_overlay_write_merges_and_preserves(tmp_path):
    ov = str(tmp_path / "var" / "autonomy-logs" / "config-overrides")
    dash._write_overlay(ov, {"model": "claude-opus-4-8"})
    dash._write_overlay(ov, {"effort": "high"})
    text = open(ov).read()
    assert "model=claude-opus-4-8" in text and "effort=high" in text
    dash._write_overlay(ov, {"model": "claude-sonnet-5"})
    text = open(ov).read()
    assert "model=claude-sonnet-5" in text and "effort=high" in text
    assert "claude-opus-4-8" not in text

def test_execute_set_model_default_writes_overlay_not_config(tmp_path):
    # config.yaml exists and must be left byte-untouched; the write lands in
    # the overlay (end-to-end through the POST executor, not just _write_overlay).
    (tmp_path / ".autonomy").mkdir()
    cfg = tmp_path / ".autonomy" / "config.yaml"
    cfg.write_text("agent:\n  model:\n    primary: claude-sonnet-5\n")
    before = cfg.read_text()
    r = dash.execute_set_model(str(tmp_path), "claude-opus-4-8", "high", "default")
    assert r["ok"] is True
    assert cfg.read_text() == before                       # committed config untouched
    ov = tmp_path / "var" / "autonomy-logs" / "config-overrides"
    assert "model=claude-opus-4-8" in ov.read_text()

def test_execute_config_set_model_key_writes_overlay(tmp_path):
    (tmp_path / ".autonomy").mkdir()
    (tmp_path / ".autonomy" / "config.yaml").write_text(
        "agent:\n  model:\n    primary: claude-sonnet-5\n")
    r = dash.execute_config_set(str(tmp_path), "agent.model.primary", "claude-opus-4-8")
    assert r["ok"] is True
    ov = tmp_path / "var" / "autonomy-logs" / "config-overrides"
    assert "model=claude-opus-4-8" in ov.read_text()
```

- [ ] **Step 2: Run — expect FAIL** (`_write_overlay` undefined).

Run: `python3 -m pytest tests/test_dashboard_server.py -k overlay -q` (or the file's runner)
Expected: FAIL.

- [ ] **Step 3: Implement** in `bin/dashboard.py`

```python
def _write_overlay(path, overlay_set):
    """Persist page-written model/effort keys to the untracked overlay,
    merge-preserving existing keys. Atomic; parent dir created."""
    existing = {}
    try:
        with open(path, errors="replace") as fh:
            for line in fh:
                k, sep, v = line.strip().partition("=")
                if sep and k:
                    existing[k] = v
    except OSError:
        pass
    existing.update(overlay_set)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        for k in sorted(existing):
            fh.write("%s=%s\n" % (k, existing[k]))
    os.replace(tmp, path)
```

In `execute_set_model` and `execute_config_set`, branch on the overlay plan before the config.yaml branch:

```python
        if "overlay" in plan:
            _write_overlay(plan["overlay"], plan["overlay_set"])
        elif "write" in plan:      # (execute_set_model only)
            ...
        else:
            _rewrite_config(plan["config_path"], plan["config_set"])
```

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Commit** `fix: dashboard writes the config overlay (merge-preserving, atomic) (#202)`

---

### Task 3: supervisor — read the overlay, shadow config.yaml at the agent.* tier

**Files:**
- Modify: `bin/supervisor.sh` (`resolve_session_settings`, add `read_config_overlay`)
- Test: `tests/test_model_override.sh`

**Interfaces:**
- Consumes: `$LOGDIR/config-overrides` (`model=`/`fallback=`/`effort=` lines).
- Produces: `read_config_overlay` sets `OVERLAY_MODEL`/`OVERLAY_FALLBACK`/`OVERLAY_EFFORT` (empty if absent/invalid). Precedence in `resolve_session_settings`: CLI > role > overlay > config.yaml > default (overlay wins within the agent.* tier; one-shot still applied last).

- [ ] **Step 1: Add failing assertions** to `tests/test_model_override.sh` (after the existing config-edit block)

```bash
# --- persistent overlay (config-overrides) shadows config.yaml ---
cat >"$CFG" <<'EOF'
agent:
  model:
    primary: claude-sonnet-5
    fallback: claude-sonnet-4-6
EOF
printf 'model=claude-opus-4-8\nfallback=claude-haiku-4-5\neffort=high\n' >"$LOGDIR/config-overrides"
resolve_session_settings
check "overlay shadows config: model" "claude-opus-4-8" "$MODEL"
check "overlay shadows config: fallback" "claude-haiku-4-5" "$FALLBACK_MODEL"
check "overlay shadows config: effort" "high" "$EFFORT"
check "overlay persists (not consumed)" "present" "$([ -f "$LOGDIR/config-overrides" ] && echo present || echo gone)"
# --- settled #13 precedence around the overlay (CLI > role > overlay > config) ---
ROLE_MODEL="claude-haiku-4-5"; resolve_session_settings; ROLE_MODEL=""
check "role model beats overlay" "claude-haiku-4-5" "$MODEL"
ROLE_EFFORT="low"; resolve_session_settings; ROLE_EFFORT=""
check "role effort beats overlay" "low" "$EFFORT"
MODEL_OVERRIDE="claude-sonnet-5"; resolve_session_settings; MODEL_OVERRIDE=""
check "CLI model beats overlay" "claude-sonnet-5" "$MODEL"
FALLBACK_MODEL_OVERRIDE="claude-sonnet-4-6"; resolve_session_settings; FALLBACK_MODEL_OVERRIDE=""
check "CLI fallback beats overlay" "claude-sonnet-4-6" "$FALLBACK_MODEL"
# one-shot override still wins last, even over the overlay
printf 'model=claude-sonnet-5\n' >"$LOGDIR/model-override"
resolve_session_settings
check "one-shot beats overlay" "claude-sonnet-5" "$MODEL"
[ -f "$LOGDIR/model-override" ] && echo "FAIL - one-shot not consumed" && fails=$((fails+1))
# invalid overlay ignored -> falls back to committed config (fail-safe)
printf 'model=bad;id\neffort=nope\n' >"$LOGDIR/config-overrides"
resolve_session_settings
check "invalid overlay model ignored" "claude-sonnet-5" "$MODEL"
check "invalid overlay effort ignored" "" "$EFFORT"
rm -f "$LOGDIR/config-overrides"
```

- [ ] **Step 2: Run — expect FAIL.**

Run: `bash tests/test_model_override.sh`
Expected: FAIL on the overlay checks.

- [ ] **Step 3: Implement** in `bin/supervisor.sh`

```bash
# Persistent operator overrides written by the dashboard's 'save default'
# (#202). Lives in the gitignored var/autonomy-logs so it survives the
# preflight stash-recovery that would sweep a tracked config.yaml edit. Values
# are re-validated here (defense in depth); an absent/invalid overlay leaves
# the OVERLAY_* vars empty so resolution falls back to committed config.yaml.
read_config_overlay() {
  OVERLAY_MODEL=""; OVERLAY_FALLBACK=""; OVERLAY_EFFORT=""
  local overlay_file="$LOGDIR/config-overrides" line key val
  [ -f "$overlay_file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    key="${line%%=*}"; val="${line#*=}"
    case "$key" in
      model)    valid_model_id "$val" && OVERLAY_MODEL="$val" ;;
      fallback) valid_model_id "$val" && OVERLAY_FALLBACK="$val" ;;
      effort)   valid_effort "$val" && OVERLAY_EFFORT="$val" ;;
    esac
  done <"$overlay_file"
  return 0
}
```

Update `resolve_session_settings` (overlay slots below role, above config):

```bash
resolve_session_settings() {
  read_config_overlay
  MODEL="$(resolve_config_value "$CFG" agent.model.primary "${MODEL_OVERRIDE:-${ROLE_MODEL:-$OVERLAY_MODEL}}" claude-sonnet-5)"
  FALLBACK_MODEL="$(resolve_config_value "$CFG" agent.model.fallback "${FALLBACK_MODEL_OVERRIDE:-$OVERLAY_FALLBACK}" claude-sonnet-4-6)"
  EFFORT="$(resolve_config_value "$CFG" agent.effort "${EFFORT_OVERRIDE:-${ROLE_EFFORT:-$OVERLAY_EFFORT}}" "")"
  consume_model_override "$LOGDIR/model-override"
}
```

Add `OVERLAY_MODEL`/`OVERLAY_FALLBACK`/`OVERLAY_EFFORT` to the forward-declared globals near the other `# shellcheck disable=SC2034` decls if SC2034 flags them (they are assigned in one function, read in another).

- [ ] **Step 4: Run — expect PASS.**

Run: `bash tests/test_model_override.sh`
Expected: PASS (existing + new checks).

- [ ] **Step 5: Commit** `fix: supervisor reads the config overlay, shadowing config.yaml per session (#202)`

---

### Task 4: dashboard_state — surface the effective (overlay-shadowed) value + a "local override" flag

**Files:**
- Modify: `lib/dashboard_state.py` (`_read_config`, add a **validated** `read_config_overlay`)
- Test: `tests/test_dashboard_state.py`

**Interfaces:**
- Consumes: `<repo>/var/autonomy-logs/config-overrides`.
- Produces: `read_config_overlay(path) -> {"model"/"fallback"/"effort": value}` — only keys whose value **passes the same validation the supervisor applies** (model id regex / effort set), single-sourced from `dashboard_control` so the UI and the supervisor can never disagree on which overlay values are honored (Codex-1 High: `read_model_override` does NO validation and must not be reused here). `_read_config(repo)` gains `"overrides"` = that dict and its `model`/`fallback`/`effort` reflect the **effective** value (overlay shadows committed).

- [ ] **Step 1: Write the failing tests** in `tests/test_dashboard_state.py`

```python
def test_read_config_overlay_shadows_and_flags(tmp_path):
    repo = tmp_path
    (repo / ".autonomy").mkdir()
    (repo / ".autonomy" / "config.yaml").write_text(
        "agent:\n  model:\n    primary: claude-sonnet-5\n  effort: low\n")
    logdir = repo / "var" / "autonomy-logs"; logdir.mkdir(parents=True)
    (logdir / "config-overrides").write_text("model=claude-opus-4-8\n")
    cfg = ds._read_config(str(repo))
    assert cfg["model"] == "claude-opus-4-8"       # overlay shadows committed
    assert cfg["effort"] == "low"                  # untouched key = committed
    assert cfg["overrides"] == {"model": "claude-opus-4-8"}

def test_read_config_overlay_ignores_invalid(tmp_path):
    # A corrupt overlay must NOT shadow config in the UI (parity with the
    # supervisor's re-validation) -- else the card would show a value the
    # supervisor silently ignores (Codex-1 High).
    repo = tmp_path
    (repo / ".autonomy").mkdir()
    (repo / ".autonomy" / "config.yaml").write_text(
        "agent:\n  model:\n    primary: claude-sonnet-5\n")
    logdir = repo / "var" / "autonomy-logs"; logdir.mkdir(parents=True)
    (logdir / "config-overrides").write_text("model=bad;id\neffort=nope\n")
    cfg = ds._read_config(str(repo))
    assert cfg["model"] == "claude-sonnet-5"       # committed, overlay rejected
    assert cfg["overrides"] == {}
```

- [ ] **Step 2: Run — expect FAIL** (`overrides` absent / model not shadowed / invalid not rejected).

Run: `python3 tests/test_dashboard_state.py`
Expected: FAIL.

- [ ] **Step 3: Implement** in `lib/dashboard_state.py`

Add a validated reader (single-sources the validators from `dashboard_control`):

```python
import dashboard_control as _dcx  # model-id regex + effort set, single-sourced

def read_config_overlay(path):
    """Persistent operator overrides (#202) the dashboard displays. Unlike the
    one-shot read_model_override, this RE-VALIDATES each value with the same
    rules the supervisor applies (dashboard_control._MODEL_RE / VALID_EFFORTS),
    so a corrupt overlay is rejected identically on both surfaces. {} on any
    error (fail-safe)."""
    out = {}
    try:
        with open(path, errors="replace") as fh:
            for line in fh:
                key, sep, val = line.strip().partition("=")
                if not sep or not val:
                    continue
                if key in ("model", "fallback") and _dcx._MODEL_RE.match(val):
                    out[key] = val
                elif key == "effort" and val in _dcx.VALID_EFFORTS:
                    out[key] = val
    except OSError:
        return {}
    return out
```

In `_read_config`, before the `return {...}`:

```python
    overlay = read_config_overlay(os.path.join(
        repo_path, "var", "autonomy-logs", "config-overrides"))
```

and in the returned dict, replace the three fields + add `overrides`:

```python
        "model": overlay.get("model") or (g("agent.model.primary") or ""),
        "fallback": overlay.get("fallback") or (g("agent.model.fallback") or ""),
        "effort": overlay.get("effort") or (g("agent.effort") or ""),
        "overrides": overlay,
```

(The `OSError` early-return branch also gains `"overrides": {}`.)

Note: confirm `lib/` is on `sys.path` for the `import dashboard_control` (dashboard_state is imported by `bin/dashboard.py` which adds `lib/`; the test harness must `sys.path.insert(0, "lib")` — mirror the existing test header).

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Commit** `fix: dashboard state surfaces the overlay-shadowed model + override flag (#202)`

---

### Task 5: dashboard page — "local override" badge + unsaved-change affordance; corrected copy

**Files:**
- Modify: `lib/dashboard_page.html` (`modelCtl`, `setModel` confirm copy)
- Modify: `lib/config_page.html` (`cfgSave` confirm copy for overlay keys)

**Interfaces:**
- Consumes: `r.config.overrides` (Task 4).

- [ ] **Step 1: Implement `modelCtl` badge + unsaved affordance** in `lib/dashboard_page.html`

Add, after the `pend` span computation:

```javascript
  const ovr=(cfg.overrides||{});
  const ovBadge=ovr.model?`<span class="pend" title="written from the dashboard; config.yaml stays the committed default">local override</span>`:"";
```

Include `${ovBadge}` in the returned markup (next to `${pend}`), and give **both** the model and effort `<select>`s a `data-cur` + `onchange` that toggles an "unsaved" class when the chosen value differs from the current one (Codex-1 Low: effort saves to the same overlay, so it needs the same affordance):

```javascript
    <select class="msel" name="model" title="model" data-cur="${esc(cfg.model||"")}"
      onchange="this.classList.toggle('dirty',this.value!==this.dataset.cur)">...</select>
    <select class="esel" name="effort" title="effort" data-cur="${esc(cfg.effort||"")}"
      onchange="this.classList.toggle('dirty',this.value!==this.dataset.cur)">...</select>
```

Add a `.dirty{outline:2px solid var(--warn,#c80)}` rule (or the page's existing warn token) covering both selects, so a chosen-but-unsaved value is visually distinct from the current one.

- [ ] **Step 2: Correct the save-default confirm copy** (`setModel`, was "Writes … into .autonomy/config.yaml"):

```javascript
  if(scope==="default" && !window.confirm(
    "Save as this repo's local default?\n\nStored as a local override under var/ "
    +"(survives the loop's preflight; committed config.yaml is unchanged), "
    +"applies from the next session.\n\nrepo: "+repo)) return;
```

- [ ] **Step 3: Correct `cfgSave` copy for overlay keys** in `lib/config_page.html`:

```javascript
  const isOverlay=/^agent\.(model\.(primary|fallback)|effort)$/.test(key);
  const dest=isOverlay?"a local override under var/ (config.yaml unchanged)"
                      :".autonomy/config.yaml";
  if(!window.confirm("Write "+key+' = "'+value+'" to '+dest+"?\n\nrepo: "+repo)) return;
```

- [ ] **Step 3b: Correct any config-page header/hint copy** in `lib/config_page.html` that claims model/effort edits are written to `.autonomy/config.yaml` (grep the file for `config.yaml` and the `cfgFieldList` model/fallback + effort field labels/hints). After this change that statement is false for `agent.model.*` / `agent.effort` — reword to note they persist as a local override under `var/` (Codex-1 Low).

- [ ] **Step 4: Browser-verify** per `.claude/skills/dashboard/SKILL.md` (Task 6).

- [ ] **Step 5: Commit** `fix: dashboard labels local overrides + honest save-default copy (#202)`

---

### Task 6: Browser verify + defect-1 empirical confirmation

- [ ] Launch `python3 bin/dashboard.py --repo tests/fixtures/repo-alpha --port 8790`.
- [ ] Drive `/` and `/config`: `new_page` → `take_snapshot` → `list_console_messages` (zero `error`) → `list_network_requests` (`/api/state` 200).
- [ ] Confirm defect-1: with `repo-alpha` model=`claude-opus-4-8` the card select shows opus (bound); temporarily set a fixture-like config with `claude-sonnet-5` and confirm the select shows sonnet (binding already correct on main — record evidence in the PR / issue).
- [ ] POST a save-default via the control endpoint; confirm 200, the overlay file is written under `var/autonomy-logs/config-overrides`, `config.yaml` is unchanged (`git status` clean in the fixture), and the reloaded card shows the "local override" badge with the new value.
- [ ] Kill the server.

---

## Self-Review

- **Spec coverage:** defect-2 write-revert (Tasks 1–4, the overlay survives preflight because `var/autonomy-logs/` is gitignored); UI "local override" label (Task 5); defect-1 select binding (already correct — Task 6 confirms + records; unsaved affordance added in Task 5). Deferred (noted in PR): doctor "dirty tracked config.yaml" warning + board.owner/title/merge_gate revert (their consumers need an overlay seam) → file as a follow-up issue.
- **Precedence:** overlay slots inside the agent.* tier; settled-decision #13 chain preserved.
- **Fail-safe:** absent/invalid overlay ignored everywhere (`read_config_overlay` re-validates; `read_model_override` returns `{}` on error).
- **Types:** overlay short keys `model`/`fallback`/`effort` consistent across `OVERLAY_KEYS`, `_write_overlay`, `read_config_overlay`, `read_model_override`.
