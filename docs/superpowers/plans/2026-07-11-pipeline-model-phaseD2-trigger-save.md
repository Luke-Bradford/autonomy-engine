# Phase D2 — trigger create/edit: `trigger_save` + run-now params channel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans
> (inline, this session). Steps use checkbox syntax for tracking.
> **Audience note (engineering record):** engineering plan for the engine's
> own loop; vocabulary decodes via `.claude/skills/engineering/pipelines.md`.

**Goal:** the dashboard can CREATE and EDIT triggers (SD-29 writer over the
SD-34 FILE shadow `var/autonomy/triggers/<name>.json`), the enabled toggle
goes live, and run-now carries a validated params payload end-to-end
(dashboard marker body → supervisor firecheck → `pipeline.py start
--params-file` → `start_run_trigger` merge).

**Spec:** `docs/superpowers/specs/2026-07-11-pipeline-model-phaseD2-trigger-save.md`
(CP1 pass-1 findings 1–6 folded). Issue #383 (STAYS OPEN — no closing
keyword anywhere; probe `closingIssuesReferences`).

**Architecture:** engine bottom-up — pipeline.py start channel first, then
triggers.py firecheck, then the dashboard writer/plan, state projections,
server routing, supervisor consumption, page last. Every layer TDD; the
supervisor shell test minds the D1 EOF-seam lessons.

## Global Constraints

- bash 3.2.57 floor (no mapfile/globstar/`declare -A`); python stdlib only.
- Fail-safe never fail-open; supervisor stays sole writer of
  `queued/`+`backoff/`; dashboard writes ONLY `fire/`+`stop/` markers and
  the `var/autonomy/triggers/` shadow.
- Repo-agnostic `bin/`/`lib/`; no target-repo values.
- `bin/safe_merge.sh` + `.github/workflows/**` untouched. Loops PAUSED.
- Every refusal leaves disk byte-identical; secrets never echoed (the
  SecretMessageAudit pin: refusals name the KEY, never the value).
- Param precedence: pipeline default < trigger saved params < run-now
  payload.
- shellcheck -S warning clean incl. tests; no late literal fn
  redefinitions in shell tests (CI SC2218, prevention-log #19).

---

### Task 1: `pipeline.py` — `start_run_trigger(fire_params=)` + CLI `--params-file`

**Files:** Modify `lib/pipeline.py` (start_run_trigger ~1634, CLI start arm
~2820). Test `tests/test_pipeline.py` (new class `FireParamsTest`).

**Interfaces produced:**
- `start_run_trigger(repo, trigger_name, state_path, lane="", *,
  known_repos=None, known_accounts=None, event_fields=None,
  fire_params=None)` — `fire_params` dict merges OVER `trig["params"]`
  before `_resolve_run_params`; refuses on non-manual mode, non-dict,
  declared-secret target.
- CLI: `pipeline.py start <repo> <name> <state> [--lane l] --kind native
  --params-file <path>` — file read bounded 65536 bytes; empty → no
  overrides; unreadable/corrupt/non-object → rc 1; with `--kind shim` →
  rc 2.

- [ ] Failing tests (`FireParamsTest`, tmp-repo fixtures with a pipeline
  declaring `{name: q, type: string, required: true}` + a `topic` param
  with default + one `type: secret` param; a manual native trigger with
  saved `params: {q: "saved"}`):
  - precedence: `fire_params={"q": "payload"}` → state `params.q ==
    "payload"`; absent key keeps saved value; absent both → declared
    default.
  - non-manual trigger + fire_params → `PipelineError` ("run-now params
    on a non-manual trigger").
  - fire_params targeting the secret param → `PipelineError` naming the
    KEY, message NOT containing the value.
  - fire_params not a dict / undeclared key / type-coercion failure →
    `PipelineError` (undeclared/type via resolve_params).
  - CLI: `--params-file` with `--kind shim` → rc 2; missing file → rc 1;
    junk JSON → rc 1; JSON list → rc 1; empty file → rc 0 (starts, saved
    params only); valid file → rc 0 + state carries the override.
- [ ] Implement:

```python
# in start_run_trigger, after the event_fields block:
if fire_params is not None:
    if firing.get("mode") != "manual":
        raise PipelineError("trigger %r: run-now params apply to "
                            "manual-mode triggers only" % trigger_name)
    if not isinstance(fire_params, dict):
        raise PipelineError("run-now params must be a JSON object")
    decl_types = {p.get("name"): p.get("type")
                  for p in (doc.get("params") or []) if isinstance(p, dict)}
    for pname, pval in fire_params.items():
        if decl_types.get(pname) == "secret":
            raise PipelineError("run-now params target secret param %r -- "
                                "a fire payload is never a credential"
                                % pname)
        if isinstance(pval, (dict, list)):
            # _coerce passes ANY value through for string-typed params
            # (CP1 pass-2 finding 1) -- the scalar rule is enforced HERE,
            # not only at the dashboard write side.
            raise PipelineError("run-now param %r must be a scalar" % pname)
    overrides.update(fire_params)
```

  NOTE: `decl_types` needs `doc` — move the merge AFTER
  `resolve_pipeline_doc` (the existing event_fields secret check sits
  there already; put the fire_params block adjacent). CLI arm: add
  `"--params-file": ""` to opts; require `--kind native`; read with
  `fh.read(65537)`, refuse >65536; empty/whitespace content →
  `fire_params=None` (empty means NO overrides, never a present-but-empty
  channel — CP1 pass-2 finding 3); else `json.loads` → must be dict →
  `fire_params=payload`.
- [ ] `python3 -m pytest tests/test_pipeline.py -q` green (or the repo's
  unittest runner — match existing invocation in `tests/run_all.sh`).
- [ ] Commit `feat(#383 D2): pipeline start learns a run-now params channel`.

### Task 2: `triggers.py` — `fire_params_check` + `firecheck` verb

**Files:** Modify `lib/triggers.py`. Test `tests/test_triggers.py`.

**Interfaces produced:**
- `fire_params_check(repo, name, path)` → `(cls, reason)` where `cls` ∈
  `{"ok", "payload", "transient"}`; CLI `firecheck <repo> <name> <file>`
  → rc 0 / 3 / 1 respectively (reason on stderr).

- [ ] Failing tests: matrix over a tmp repo (same fixtures as Task 1):
  ok payload → ("ok", None) / rc 0; junk bytes, JSON list, non-scalar
  value, undeclared key, secret target, type mismatch → ("payload", …) /
  rc 3; required-param-missing in BOTH merged and saved-only →
  ("transient", …) / rc 1 (not the payload's fault — the D1 bound);
  unreadable trigger / missing pipeline dir → ("transient", …) / rc 1;
  oversize (>65536) payload → ("payload", …); empty file → ("ok", None).
- [ ] Implement (classification per spec §4 — both dry runs through
  `pipeline._resolve_run_params`, start-parity by construction):

```python
def fire_params_check(repo, name, path):
    try:
        with open(path, encoding="utf-8") as fh:
            raw = fh.read(65537)
    except OSError as exc:
        return "transient", "payload unreadable: %s" % exc
    if len(raw) > 65536:
        return "payload", "run-now payload exceeds 65536 bytes"
    if not raw.strip():
        return "ok", None
    try:
        payload = json.loads(raw)
    except ValueError as exc:
        return "payload", "run-now payload is not valid JSON: %s" % exc
    if not isinstance(payload, dict):
        return "payload", "run-now payload must be a JSON object"
    try:
        trig = load_trigger(repo, name)
        doc, _meta = pipeline.resolve_pipeline_doc(repo, trig["pipeline"])
    except PipelineError as exc:
        return "transient", str(exc)
    decl_types = {p.get("name"): p.get("type")
                  for p in (doc.get("params") or []) if isinstance(p, dict)}
    for k, v in payload.items():
        if decl_types.get(k) == "secret":
            return "payload", ("run-now payload targets secret param %r"
                               % k)
        if isinstance(v, (dict, list)):
            # scalar rule enforced at every layer (CP1 pass-2 finding 1)
            return "payload", "run-now param %r must be a scalar" % k
    saved = dict(trig.get("params") or {})
    merged = dict(saved)
    merged.update(payload)
    try:
        pipeline._resolve_run_params(repo, doc, merged)
        return "ok", None
    except PipelineError as merged_exc:
        try:
            pipeline._resolve_run_params(repo, doc, saved)
        except PipelineError:
            return "transient", str(merged_exc)   # saved-only fails too
        return "payload", str(merged_exc)
```

  CLI arm: `firecheck` takes exactly 3 positionals; prints the reason to
  stderr; maps ok→0, payload→3, transient→1. Wire into `main` + usage doc.
- [ ] Tests green. Commit `feat(#383 D2): firecheck classifies run-now payloads`.

### Task 3: `dashboard_control.py` — `trigger_save` writer + `trigger_ctl_plan(fire_params=)`

**Files:** Modify `lib/dashboard_control.py`. Test
`tests/test_dashboard_control.py`.

**Interfaces produced:**
- `trigger_save(repo, name, trig)` → `{ok, path, message}` /
  `{ok: False, error}` (spec §3 gate order).
- `trigger_ctl_plan(marker_repo, action, name, lane_suffix="",
  fire_params=None)` — fire + non-empty params →
  `{"write": path, "content": <canonical json>, "message"}`; else
  byte-identical to D1.
- `_TRIGGER_DOC_CAP = 65536`.

- [ ] Failing tests (tmp repos, `git init` + gitignored `var/` per
  existing fixtures' pattern):
  - create: valid native doc → `var/autonomy/triggers/<name>.json` exists,
    content == canonical serialize, ok message.
  - overwrite: prior shadow content differs after; refusal cases leave the
    PRIOR shadow byte-identical (read bytes before/after).
  - refusals: bad charset name; `trig` not a dict; validator errors
    (unknown key `events_csv`, name != stem, explicit `run_windows: []`,
    reserved sidecar suffix name); missing gitignore coverage; symlinked
    shadow file; symlinked `.tmp` squatter (create it, expect success with
    the squatter REPLACED and the real file landing under var/ — the
    O_EXCL path after unlink); doc over 65536 bytes; `float("inf")` param
    value (allow_nan refusal).
  - warnings: binding to a pipeline with no dir → ok + message contains
    "pipeline"+"not found"-class WARN; saved params that don't dry-resolve
    → ok + message contains the reason.
  - `trigger_ctl_plan`: fire + `{"q": "x"}` → `{"write", "content"}` with
    canonical JSON; fire + `{}`/None → `{"touch"}` (D1 pin untouched);
    stop/resume never take params (fire_params ignored or refused —
    pick REFUSED: `{"error": "params only apply to trigger_fire"}`);
    NaN value → `{"error": …}`.
- [ ] Implement `trigger_save` per spec §3 (gate order verbatim; reuse
  `_var_live_protected(repo, os.path.join("var", "autonomy", "triggers"))`,
  `_triggers.validate_trigger`, `_pipeline.valid_pipeline_name`). Warning
  probes are TOTAL (any exception in the warn probe = skip the warn, never
  block the save):

```python
def trigger_save(repo, name, trig):
    if not _pipeline.valid_pipeline_name(name):
        return {"ok": False, "error": "trigger name has invalid charset"}
    if not isinstance(trig, dict):
        return {"ok": False, "error": "trigger must be a JSON object"}
    errs = _triggers.validate_trigger(trig, name)
    if errs:
        return {"ok": False, "error": "; ".join(errs)}
    if not _var_live_protected(repo, os.path.join("var", "autonomy",
                                                  "triggers")):
        return {"ok": False, "error": "var/ is not covered by this repo's "
                ".gitignore -- the loop's preflight would sweep the "
                "trigger shadow. Add a 'var/' line to .gitignore (and "
                "commit it) first."}
    try:
        serialized = json.dumps(trig, indent=2, sort_keys=True,
                                allow_nan=False) + "\n"
    except (TypeError, ValueError) as exc:
        return {"ok": False, "error": "trigger is not representable as "
                "JSON: %s" % exc}
    if len(serialized.encode("utf-8")) > _TRIGGER_DOC_CAP:
        return {"ok": False,
                "error": "trigger exceeds %d bytes" % _TRIGGER_DOC_CAP}
    if json.loads(serialized) != trig:
        return {"ok": False, "error": "re-parse mismatch: the written "
                "trigger would not read back identically -- write refused"}
    shadow = os.path.join(repo, "var", "autonomy", "triggers",
                          "%s.json" % name)
    if os.path.islink(shadow) or (os.path.exists(shadow)
                                  and not os.path.isfile(shadow)):
        return {"ok": False, "error": "the trigger shadow path is not a "
                "clean file -- refusing"}
    tmp = shadow + ".tmp"
    try:
        os.makedirs(os.path.dirname(shadow), exist_ok=True)
        if os.path.islink(tmp) or os.path.exists(tmp):
            os.unlink(tmp)                    # stale junk; unlink no-follows
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(serialized)
        os.replace(tmp, shadow)
    except OSError as exc:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        return {"ok": False, "error": "could not write the trigger: %s" % exc}
    message = ("saved to the live trigger shadow -- applies next tick "
               "(the committed pack is untouched)")
    message += _trigger_save_warns(repo, trig)
    return {"ok": True, "path": os.path.relpath(shadow, repo),
            "message": message}
```

  `_trigger_save_warns(repo, trig)`: try `effective_pipeline_dir` +
  `pipeline.json` isfile → else `" -- WARNING: pipeline %r not found; the
  trigger will refuse to start until it exists"`; try `load_doc` +
  `resolve_params(declared, trig params)` → on PipelineError append
  `" -- WARNING: params do not currently resolve: %s"`. Whole helper in
  one `try/except Exception: return ""` per branch (total).
- [ ] Extend `trigger_ctl_plan` (spec §4): `fire_params` kwarg; refuse on
  non-fire actions; canonical dumps w/ `allow_nan=False` inside
  try/ValueError→error.
- [ ] Tests green. Commit
  `feat(#383 D2): trigger_save SD-29 writer over the SD-34 trigger shadow`.

### Task 4: `dashboard_state.py` — `trigger_fire_ready(overrides=)` + params projections

**Files:** Modify `lib/dashboard_state.py` (trigger_fire_ready ~2751,
`_gallery_rows` ~2810, build_triggers_view ~2870). Test
`tests/test_dashboard_state.py`.

**Interfaces produced:**
- `trigger_fire_ready(repo_path, trig, overrides=None)` → `(ok, reason)`;
  None = D1 byte-identical.
- `_declared_params(doc)` → `[{name, type, required, default?, choices?}]`
  (total; junk decl entries dropped).
- `pipelines[]` rows gain `params`; `triggers[]` rows gain `fire_params`
  (manual mode + loadable doc → the projection, else `[]`).

- [ ] Failing tests: overrides matrix (valid merged passes where saved-only
  fails on required-no-default; secret-key override refused, reason names
  key not value; non-dict overrides refused; undeclared key refused);
  D1 pins for `fire_ready`/`fire_block_reason` UNTOUCHED (no-overrides
  path byte-identical — run existing tests unmodified); tmp-repo with
  declared params → `pipelines[].params` projection shape + `[]` on
  invalid doc + wrapped rows; `triggers[].fire_params` present for the
  manual trigger, `[]` for continuous; secret param's `default` (a label)
  included, its type marked `secret` so the form can hint.
- [ ] Implement: extend `trigger_fire_ready` —

```python
def trigger_fire_ready(repo_path, trig, overrides=None):
    try:
        firing = trig.get("firing") if isinstance(trig, dict) else None
        if not isinstance(firing, dict) or firing.get("mode") != "manual":
            return False, ("run-now applies to manual-mode triggers "
                           "(other modes are a D2 extension)")
        binding = trig.get("pipeline") or ""
        if not pipeline_mod.valid_pipeline_name(binding):
            return False, "pipeline binding invalid"
        pdir = pipeline_mod.effective_pipeline_dir(repo_path, binding)
        doc = pipeline_mod.load_doc(os.path.join(pdir, "pipeline.json"))
        declared = doc.get("params")
        declared = declared if isinstance(declared, list) else []
        params = trig.get("params")
        params = dict(params) if isinstance(params, dict) else {}
        if overrides is not None:
            if not isinstance(overrides, dict):
                return False, "run-now params must be a JSON object"
            decl_types = {p.get("name"): p.get("type") for p in declared
                          if isinstance(p, dict)}
            for k, v in overrides.items():
                if decl_types.get(k) == "secret":
                    return False, ("run-now params target secret param "
                                   "%r -- refused" % k)
                if isinstance(v, (dict, list)):
                    return False, "param %r must be a scalar" % k
            params.update(overrides)
        pipeline_mod.resolve_params(declared, params)
        return True, None
    except Exception as exc:
        return False, "pipeline/params not fireable: %s" % exc
```

  `_declared_params(doc)`: project each dict entry with a str name;
  include `default`/`choices` only when present. `_gallery_rows`: after a
  doc validates/loads, `row["params"] = _declared_params(doc)` (errors arm
  keeps `params: []`). `build_triggers_view` trigger loop: `fire_params`
  for manual-mode triggers via its OWN guarded doc load (helper
  `_bound_doc(repo_path, binding)` — total, None on any failure →
  `fire_params: []`). `trigger_fire_ready` stays self-contained (its
  signature is the D1 read/write shared contract); the extra json read per
  manual trigger per poll matches D1's own cost shape.
- [ ] Tests green (incl. full existing file — the D1 pins are the audit).
  Commit `feat(#383 D2): payload learns declared params + override verdict`.

### Task 5: `bin/dashboard.py` — routing + marker write execution

**Files:** Modify `bin/dashboard.py` (do_POST ~1640-1752,
execute_trigger_ctl ~1335). Test `tests/test_dashboard_server.py`.

**Interfaces produced:**
- action `trigger_save` in `_ws_actions` + oversize allowance; body
  `{action, token, repo, name, trigger}`.
- `execute_trigger_ctl(repo, action, name, fire_params=None)`; `trigger_fire`
  body may carry `params` (dict); plan `{"write", "content"}` executed
  atomically (tmp + O_EXCL + replace — same no-follow discipline).

- [ ] Failing tests (existing server-test harness):
  - POST trigger_save valid → 200, shadow file content matches canonical;
    invalid doc → 409 + disk untouched; unmanaged repo → 400; oversize
    (>8 KiB but <256 KiB) trigger_save body → accepted; another action at
    that size still 400.
  - POST trigger_fire with `params: {"q": "x"}` (manual trigger w/ declared
    q) → 200 + marker BODY == canonical JSON; with invalid params → 409 +
    NO marker; without params → 200 + EMPTY marker (D1 byte-parity pin);
    params on trigger_stop → 409 (or ignored — pin whichever the plan
    picks: REFUSED, matching trigger_ctl_plan).
- [ ] Implement: whitelist `_ws_actions += ("trigger_save",)`; oversize
  tuple `("ws_prompt_set", "pipeline_save", "trigger_save")`; elif arm →

```python
elif action == "trigger_save":
    trig = body.get("trigger")
    result = dcx.trigger_save(repo, str(body.get("name") or ""),
                              trig if isinstance(trig, dict) else None)
```

  `execute_trigger_ctl`: accept `fire_params`; pass into
  `ds.trigger_fire_ready(repo, trig, overrides=fire_params)` for
  trigger_fire (None → D1 path); hand to `dcx.trigger_ctl_plan(...,
  fire_params=fire_params if action == "trigger_fire" else None)`;
  executor gains the `"write"` arm:

```python
if "write" in plan:
    os.makedirs(os.path.dirname(plan["write"]), exist_ok=True)
    tmp = plan["write"] + ".tmp"
    if os.path.islink(tmp) or os.path.exists(tmp):
        os.unlink(tmp)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(plan["content"])
    os.replace(tmp, plan["write"])
```

  do_POST trigger-ctl call site passes the RAW shape so junk is REFUSED,
  never silently dropped into an empty-marker fire (CP1 pass-2 finding 2):
  `execute_trigger_ctl(repo, action, name, fire_params=body["params"] if
  "params" in body else None)`. Inside `execute_trigger_ctl`:
  `fire_params` None → D1 path byte-identical; `{}` → treated as None
  (the UI omits empty overrides; an explicit empty object means the same);
  a non-dict → `{"ok": False, "error": "run-now params must be a JSON
  object"}`; any params on `trigger_stop`/`trigger_resume` →
  `{"ok": False, "error": "params only apply to trigger_fire"}` (matching
  `trigger_ctl_plan`'s refusal). Tests pin `params: []` → 409 no marker,
  and `params` on stop → 409.
- [ ] Tests green. Commit
  `feat(#383 D2): trigger_save route + run-now params marker body`.

### Task 6: `bin/supervisor.sh` — payload consumption in `resolve_manual_fires`

**Files:** Modify `bin/supervisor.sh` (resolve_manual_fires ~1171,
run_session ~2037, resolve_pipeline_ready ~1772). Test
`tests/test_trigger_dispatch.sh`.

**Interfaces produced:**
- `run_session <token> [kind] [params_file]` (both optional, default
  ""/shim); `resolve_pipeline_ready <role> <max> <slot> <kind>
  [params_file]`.

- [ ] AUDIT every `run_session` + `resolve_pipeline_ready` call site
  (`grep -n`) — all existing sites stay 2-arg/4-arg (empty default =
  no overrides); record the list in the commit message.
- [ ] Failing shell tests (mind the D1 EOF-seam lessons: restore stubbed
  seams via eval'd `declare -f` dumps, re-stub the recorder through the
  python3 seam, recreate swept fixtures; NO late literal fn
  redefinitions):
  - fire marker with VALID payload body → recorded `pipeline.py start`
    argv contains `--params-file <marker path>` AND marker removed after
    the stubbed run_session succeeds.
  - marker with rc-3 payload (junk JSON via a firecheck stub or a real
    junk file) → marker REMOVED, `WARN … invalid … removing` logged, NO
    run_session call.
  - marker with rc-1 (transient — stub firecheck rc 1) → marker KEPT,
    NOTE logged, no run_session call.
  - EMPTY marker → byte-identical D1 path (existing pins re-run green;
    no firecheck invocation — assert the recorder saw none).
- [ ] Implement:

```bash
# resolve_manual_fires, after the free-slot check:
    params_file=""
    if [ -s "$f" ]; then
      python3 "$ENGINE_HOME/lib/triggers.py" firecheck \
        "$AUTONOMY_TARGET_REPO" "$name" "$f" >>"$SUPLOG" 2>&1
      case $? in
        0) params_file="$f" ;;
        3)
          log "WARN trigger-ctl: run-now payload for '$name' is invalid -- removing (fire lost; re-fire from the dashboard)"
          rm -f "$f" 2>>"$SUPLOG" || true; continue ;;
        *)
          log "NOTE trigger '$name': payload check unavailable -- fire deferred (marker kept)"
          continue ;;
      esac
    fi
    if run_session "$tok" native "$params_file"; then
```

  `run_session`: `local token="${1:-…}" kind="${2:-shim}"
  params_file="${3:-}"` → `resolve_pipeline_ready "$role" 8 "$slot"
  "$kind" "$params_file"`. `resolve_pipeline_ready`: 5th param
  `params_file="${5:-}"`; on the start arm append `--params-file
  "$params_file"` when non-empty (both lane/no-lane branches); when
  non-empty AND the state file already exists, `log "NOTE pipeline:
  run-now params ignored -- run already in flight (params apply at
  start)"`.
- [ ] `bash tests/test_trigger_dispatch.sh` green;
  `shellcheck -S warning bin/supervisor.sh tests/test_trigger_dispatch.sh`
  clean. Commit
  `feat(#383 D2): supervisor consumes run-now params payloads`.

### Task 7: `/pipeline` page — toggle + create/edit form + run-now overlay

**Files:** Modify `lib/pipeline_page.html` (renderTriggers ~1146,
renderGallery ~1221, trigCtl ~1247, the `#v-triggers` delegated listener
~1280, CSS block).

Per spec §5. Key structure:

- `#v-triggers` gets a STATIC skeleton rendered once (`<div id="trigform"
  hidden></div><div id="trigcards"></div>`); `renderTriggers` rewrites
  ONLY `#trigcards` — the open form is never clobbered by a tick (#202
  bar). Same for the run-now overlay: it renders INSIDE `#trigform`
  (one authoring surface at a time — opening run-now params closes an
  open edit form and vice versa; simplest dirty-state story).
- Two doc builders share one omission helper: `trigDocFromForm()` (the
  authoring form) and `trigDocFromRow(t)` (the toggle path — no form
  open); both omit empty optionals (`params` `{}`, `lane` `""`,
  `run_windows` `[]`, `map` `{}`) and never emit `kind`/`events_csv`.
- Toggle: `data-act="trigger_toggle"` on the switch for natives +
  pipeline-bound shims; handler builds the doc from the ROW (`trigDocFromRow(t)`
  — same omission rules; shim single-event `events_csv` converts, multi-event
  or wrapped → inert switch + honest title) flips `enabled`, and for a SHIM
  first `confirm()`s with the materialisation warning (spec §2 scope line);
  then POST `trigger_save` via a small `trigSave(name, doc)` helper
  (mirrors `trigCtl`: token, repo, `TRIGSIG=""`, `tickLists()`, message
  into `#trigmsg`).
- Create/edit form fields per spec §5 (mode-dependent sections shown/
  hidden by a `change` listener on the mode select; params section
  regenerates when the pipeline select changes, sourcing
  `pipelines[].params`); Save → `trigSave`; Cancel hides. Everything
  esc()'d; listeners delegated off `#v-triggers` (`data-act` values:
  `trig_new`, `trig_edit`, `trig_cancel`, `trig_save_form`,
  `trigger_toggle`, `fire_open`, `fire_send`, plus the existing three
  marker actions).
- Run-now: rows with non-empty `fire_params` get ▶ enabled opening the
  params panel (typed inputs; blank = omit); `fire_send` collects
  non-blank values (number inputs → Number, bool → a THREE-state select
  unset/true/false — a checkbox cannot express "omit", so an unchecked box
  would fabricate a `false` override (CP1 pass-2 finding 4); `unset` is
  omitted, else string) → `trigCtl("trigger_fire", name, params)` (extend
  trigCtl with an optional params object in the body, omitted when empty).
  Paramless manual rows keep the D1 direct-fire path byte-identical. The
  authoring form's bool params use the same tri-state control (saved
  params are equally optional).
- Gallery: `＋ trigger` goes live (`data-act="trig_new"
  data-pipeline=<name>`) for non-wrapped rows; wrapped rows keep the
  inert D2 label swapped to an honest "wrapped role — roles are edited on
  the config page".
- The D1 head-note ("enable/disable + trigger editing land in D2")
  updates to describe the live controls.

- [ ] Implement; unit-level render checks ride
  `tests/test_dashboard_server.py`'s existing page-serving pins only if
  one asserts on the removed D2 note (grep first; update pins in the same
  commit). Browser verification is Task 9.
- [ ] Commit `feat(#383 D2): trigger create/edit + toggle + run-now params UI`.

### Task 8: docs + SD entry + #383 comment draft

**Files:** Modify `docs/pipelines.md` (dashboard triggers section: authoring,
toggle-materialisation, run-now params + precedence, product voice, no
SD-N/issue refs), `.claude/skills/dashboard/SKILL.md` (action list +
`trigger_save` + params body note), `.claude/skills/engineering/pipelines.md`
(Phase D status line: D2 shipped scope), `docs/settled-decisions.md` (new
entry 43: D2 scope lines from spec §2 — trigger_save mechanics, materialise-
on-edit + confirm, payload channel + precedence + firecheck classification,
delete/reset deferred, WARN-not-refuse save probes).

- [ ] Write all four; product layer stays jargon-free (the 2026-07-09
  operator directive).
- [ ] Draft the #383 scope-lines comment (posted at PR time; NO closing
  keywords).
- [ ] Commit `docs(#383 D2): product + skill + settled-decision records`.

### Task 9: browser verify + temporal pass

Per `.claude/skills/dashboard/SKILL.md` (throwaway port 8790+, kill stale
squatters first: `lsof -tnP -iTCP:8790`).

- [ ] Throwaway repo under the scratchpad (NOT /tmp per harness note; NOT
  repo-alpha): git init, gitignored `var/`, a pipeline with declared
  params `{q: string required}` + `{topic: string, default}` + a secret
  param, a manual native trigger with saved params, a continuous shim
  role, one schedule native.
- [ ] Drive: create a trigger from the form (shadow lands on disk,
  card appears next tick); toggle the schedule native off (file's
  `enabled: false`); toggle a pipeline-bound SHIM (confirm dialog seen →
  accept → native file materialises, card flips to `native`); wrapped-role
  switch inert; ▶ run-now on the manual trigger → params panel → send with
  an override → marker body on disk == canonical JSON; invalid value →
  409 reason rendered; empty overrides → empty marker.
- [ ] Dirty-control survival: open the edit form, wait 2-3 poll ticks
  (~12 s), form + typed values intact while cards re-render.
- [ ] Console: zero errors. Three states: populated / empty (repo with no
  triggers) / degraded (unreadable config → error bar).
- [ ] Temporal pass (the SKILL.md probe, `/pipeline` panel ids +
  `trigform`): steadyStateCLS < 0.01, innerHTMLStable, rebuilds ≤ 1.
- [ ] Record readings for the PR Testing section.

### Task 10: gates + PR

- [ ] `bash tests/run_all.sh` full-suite green.
- [ ] `shellcheck -S warning start bin/*.sh bin/agents/*.sh tests/*.sh
  templates/autonomy-pack/qa/*.sh` clean.
- [ ] pre-flight-review skill pass over the full diff (same-class scan:
  every new external call in builders guarded; every config/POST-sourced
  string re-validated at use).
- [ ] Codex CP2 (diff vs main), fold real findings.
- [ ] PR per pr-authoring (security model section; scope lines; NO closing
  keyword for #383 — body says "Part of #383's D2 slice" with NO
  keyword+number pairing; probe
  `gh pr view <n> --json closingIssuesReferences` == `[]` at open AND
  pre-merge). Post the #383 scope comment.
- [ ] Review loop per review-resolution; safe_merge after APPROVE + CI
  green on the latest commit.

## Execution notes

- Tests run via `bash tests/run_all.sh` for the gate; individual files via
  `python3 tests/test_<x>.py` / `bash tests/test_<x>.sh` while iterating
  (match run_all.sh's invocation).
- repo-alpha is UNTOUCHED this slice (no new committed fixtures — declared
  params live in tmp-copy tests + the throwaway verify repo), so no
  full-suite fixture audit task is needed; the run_all gate still proves it.
- The D1 spec's §2 items 3 (non-manual run-now), 6 (pipeline create/clone)
  stay deferred; D2 adds two deferrals (delete/reset-to-committed) —
  recorded in SD-43 + the #383 comment.
