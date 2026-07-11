# Phase D slice D2 — trigger create/edit: `trigger_save` + run-now params channel (spec)

> **Audience note (engineering record):** engineering build spec for the
> engine's own development loop. Process vocabulary (SD-N, prevention-log #N,
> CP1-3) decodes via `.claude/skills/engineering/pipelines.md`.

**Provenance:** issue #383 (stays OPEN until D3), operator decisions comment
2026-07-10 (decision 2: full authoring sequenced D1 read → D2 trigger
create/edit → D3 pipeline create/clone; decision 3: run-now param channel
BUILT). D1 spec `docs/superpowers/specs/2026-07-10-pipeline-model-phaseD1-
triggers-read.md` §2 scope lines = this slice's inherited backlog (items 1,
2, 5). SD-42 records the D1/D2 boundary. Underneath: SD-29 (double-validation
writer), SD-34 (var-live shadow), SD-37 (the discipline generalised to a dir
asset — D2 applies it to a FILE asset), SD-39/40/41 (triggers are the
dispatch unit; per-trigger trust; run windows).

## 1. What D2 ships

1. **`trigger_save`** — a new `POST /api/control` action (SD-9: never a new
   endpoint): whole-document save of ONE trigger into the SD-34 FILE shadow
   `<repo>/var/autonomy/triggers/<name>.json`. SD-29 mechanics for a single
   JSON file: validate BEFORE any write (`triggers.validate_trigger`,
   name==stem), gitignore guard, byte cap, canonical serialize + re-parse
   compare, atomic install (tmp + `os.replace`), every refusal leaves the
   shadow byte-identical. A **shim edit MATERIALISES a native file** (the
   shadow supersedes the shim in `enumerate_triggers` — that supersession is
   Phase B machinery, not new code).
2. **Enabled toggle rides `trigger_save`** — the ⚡ tab's read-only switch
   becomes live: the client re-emits the trigger doc with `enabled` flipped.
   Per-trigger pause = `enabled: false` in the FILE (SD-42 scope line 1).
3. **Create-trigger flow on the ⚡ tab** — bind a pipeline (picker from the
   gallery rows) → typed params form generated from the doc's DECLARED
   params → firing-mode picker (continuous/schedule/manual/event with
   cron-string / event+map config) → concurrency → run windows → save.
   Gallery cards' `＋ trigger` goes live (pre-bound). Edit (✎) reuses the
   same form seeded from the trigger row.
4. **Run-now PARAMS channel** (decision 3) — `trigger_fire` accepts an
   optional `params` object; the write side validates it with the SAME dry
   `resolve_params` verdict (extended `trigger_fire_ready`), then writes the
   fire marker with the JSON payload as its BODY (empty payload = empty
   marker, byte-parity with D1). The SUPERVISOR consumes it:
   `resolve_manual_fires` pre-checks a non-empty marker body
   (`triggers.py firecheck`), threads the marker path through
   `run_session`/`resolve_pipeline_ready` into `pipeline.py start
   --params-file`, and `start_run_trigger` merges the payload as the
   LAST-PRECEDENCE override (pipeline default < trigger saved params <
   run-now payload). Secrets are refused at every layer.

## 2. Scope lines (conscious, veto-able — recorded on #383 with the PR)

| Item | D2? | Why |
|---|---|---|
| trigger CREATE + EDIT via `trigger_save`; enabled toggle | **YES** | decision 2. |
| run-now params payload + supervisor consumer | **YES** | decision 3; D1 scope line 2. |
| run-now on non-manual modes | **D2+ (not now)** | `resolve_manual_fires` still WARN-removes non-manual fire markers; unchanged. |
| trigger DELETE / reset-shadow-to-committed | **NO** | a write surface with different semantics (restoring a committed native / resurrecting a shim); pairs with D3's gallery lifecycle + the pipeline reset-to-committed deferral (SD-38). Until then an operator disables the trigger (`enabled: false`) or removes the shadow file by hand. |
| editing the COMMITTED `.autonomy/triggers/` file | **NO** | SD-34: the dashboard writes the var shadow only; committed stays the shareable default. |
| wrapped-role shim (pipeline `""`) toggle/edit | **REFUSED honestly** | a native trigger REQUIRES a pipeline binding (`validate_trigger`); a wrapped role has none, so materialisation is impossible. The UI keeps the switch inert with the reason (role `enabled:` stays the config page / `ws_set` path). |
| shim materialisation is a ONE-WAY execution-semantics change | **CONFIRMED in the UI, documented** | a shim runs through `start_run(repo, role)` with role settings (prompt/scope/model/account); a native runs `start_run_trigger` with the doc's own `runs_as` and NO role context (`bin/supervisor.sh` run_session native arm). Materialising (toggle OR edit) therefore FLIPS the run path — decided behaviour (decision 2 + SD-42 scope line: "a shim's toggle needs native-file materialisation"), not an accident: the browser confirm names the flip explicitly ("this converts the role shim into a native trigger; role prompt/scope/model no longer apply — the pipeline's own runs_as/briefs drive the run; one-way until the shadow file is removed by hand") before the first save under a shim's name (CP1 pass-1 finding 1). |
| multi-event shim (events_csv with >1 event) edit | **REFUSED honestly** | one native trigger carries ONE `firing.event`; the form refuses with "split into per-event triggers". Single-event shims materialise cleanly. |
| pipeline-binding existence at save | **WARN, not refuse** | `validate_trigger`'s own contract ("existence is checked at run start"). Refusing would BLOCK disabling a trigger whose pipeline was deleted — fail-open in the pause direction. The save succeeds with a warning naming the missing pipeline. |
| saved-params dry-resolve at save | **WARN, not refuse** | mid-authoring saves (disabled trigger before its pipeline edit lands) are legitimate; an unresolvable-params trigger never dispatches a session (start refuses) and the ⚡ card already shows `fire_block_reason`. |
| `backoff/`+`queued/` stay supervisor-owned | unchanged | SD-42. |

## 3. `trigger_save` design (lib/dashboard_control.py)

`trigger_save(repo, name, trig)` → `{ok: True, path, message}` /
`{ok: False, error}`. Order of gates (nothing on disk changes before ALL
pass):

1. `pipeline.valid_pipeline_name(name)` — the ONE charset gate (what
   dispatch refuses can never be saved), before any path is built
   (prevention-log #6).
2. `trig` must be a dict; `triggers.validate_trigger(trig, name)` must
   return `[]` — this enforces name==stem, refuses unknown keys (so the
   shim-internal `kind`/`events_csv` can never be written to disk), refuses
   reserved sidecar suffixes, validates firing/concurrency/run_windows/lane.
3. Gitignore guard: `_var_live_protected(repo, "var/autonomy/triggers")`
   (SD-34 — an unignored shadow is preflight sweep-bait).
4. Serialize once: `json.dumps(trig, indent=2, sort_keys=True,
   allow_nan=False) + "\n"`; refuse over `_TRIGGER_DOC_CAP = 65536` bytes
   (triggers are small; params are scalars). `TypeError` (non-JSON-able)
   AND `ValueError` (NaN/Infinity — `allow_nan=False`; plain `dumps` emits
   `Infinity` which round-trips EQUAL, so the compare below would pass it;
   CP1 pass-1 finding 3) → refusal.
5. Re-parse compare: `json.loads(serialized) == trig` — the SD-29
   lossy-emit guard (non-str keys and any other lossy shape can't
   round-trip).
6. Shadow path hygiene: `var/autonomy/triggers/<name>.json` must not be a
   symlink and, when present, must be a regular file (the resolver ignores
   symlinked shadows — writing through one would escape var/; same refusal
   shape as `pipeline_save`).
7. Install: `os.makedirs(dirname)`; the tmp file is created NO-FOLLOW —
   remove any pre-existing `<path>.tmp` (stale junk in our own var dir;
   `os.unlink` never follows), then `os.open(tmp, O_WRONLY|O_CREAT|O_EXCL)`
   so a squatting symlink can never redirect the write out of var/ (CP1
   pass-1 finding 2) — then `os.replace(tmp, path)`: atomic; a concurrent
   reader (`effective_trigger_path` → `load_trigger`) sees old-complete or
   new-complete, never torn.

Non-blocking WARNINGS appended to the success message (never refusals —
scope lines above): pipeline binding does not currently resolve
(`effective_pipeline_dir`/pipeline.json missing), and/or the saved params
do not dry-resolve against the bound doc (reason included). Both states are
honest-and-visible on the ⚡ card afterwards.

Route (bin/dashboard.py): action `trigger_save`, body `{action, token,
repo, name, trigger}`. Managed-repo gate + token gauntlet unchanged. TWO
routing gates change (CP1 pass-1 finding 6 — naming both explicitly):
`trigger_save` joins the `_ws_actions` whitelist tuple (authoring-family
routing, its own `elif` arm calling `dcx.trigger_save`) AND the
oversize-read allowance tuple (`ws_prompt_set`, `pipeline_save`) — long
string params can push a doc past 8 KiB; the hard 256 KiB ceiling and the
writer's own 64 KiB semantic cap still bound it. `trigger` is
shape-checked at the boundary (dict or None) and the writer refuses
anything malformed.

## 4. Run-now params channel design

**Precedence (design spec §3):** pipeline saved default < trigger saved
params < run-now payload (the payload is the most-specific invoker
override — the same slot a calling pipeline uses, applied last).

**Write side** (`bin/dashboard.py execute_trigger_ctl` +
`lib/dashboard_state.trigger_fire_ready` + `lib/dashboard_control.trigger_ctl_plan`):

- `trigger_fire_ready(repo_path, trig, overrides=None)` — `overrides=None`
  is byte-identical D1 behaviour. With overrides: refuse a non-dict /
  non-scalar values; refuse any key whose DECLARED type is `secret` ("a
  run-now payload never carries a credential" — the `firing.map` rule
  applied to the operator channel); then the dry
  `resolve_params(declared, {**saved, **overrides})` — one verdict, read
  and write sides shared, as D1 established.
- `execute_trigger_ctl(repo, action, name, fire_params=None)` — for
  `trigger_fire` passes the posted params into `trigger_fire_ready`;
  refusal → 409 with the reason, NO marker. The HTTP boundary hands the
  RAW posted shape through (key-present sentinel): a non-dict `params`
  REFUSES rather than degrading to an empty-marker fire, and `params` on
  stop/resume refuses (CP1 pass-2 finding 2). An explicit `{}` equals
  omitted (the UI omits empty overrides).
- `trigger_ctl_plan(marker_repo, action, name, lane_suffix="",
  fire_params=None)` — non-empty `fire_params` returns `{"write": path,
  "content": json.dumps(fire_params, sort_keys=True, allow_nan=False)}`
  (`ValueError` → refusal — the same NaN/Infinity rule as `trigger_save`,
  CP1 pass-1 finding 3) instead of `{"touch": path}`; empty/None keeps
  `{"touch"}` (empty marker, byte-parity with D1 and with a hand-touched
  marker). The executor writes content atomically (tmp + replace, O_EXCL
  no-follow like the `trigger_save` install).

**Supervisor side** (`bin/supervisor.sh resolve_manual_fires`):

- Marker body EMPTY (`! -s`) → the D1 path byte-identical (existence-only).
- Marker body non-empty → pre-check `triggers.py firecheck
  "$AUTONOMY_TARGET_REPO" "$name" "$f"`:
  - rc 0 → payload usable; thread the marker path into the start.
  - rc 3 → payload DEFINITIVELY invalid (unparseable / non-object /
    undeclared key / secret target / type mismatch): WARN + remove the
    marker (fire lost LOUDLY — the queued-marker invalid-kind precedent;
    keeping it would retry a deterministic refusal forever).
  - any other rc → transient (trigger/doc unreadable this tick): NOTE +
    keep the marker (defer — under-fire is the safe side).
- Threading: `run_session "$tok" native "$f"` →
  `resolve_pipeline_ready role max slot kind params_file` → appends
  `--params-file "$params_file"` to `pipeline.py start` ONLY on the
  start-a-new-run arm. The new parameter is OPTIONAL-with-empty-default at
  both hops (`local params_file="${3:-}"` / `"${5:-}"`): every existing
  call site (queued drain `run_session "$tok" "$kind"`, event starts, the
  main dispatch loop) passes through unchanged and empty means "no
  overrides" (CP1 pass-1 finding 5 — the plan audits every `run_session`
  call site). A params_file with an already-in-flight state file logs a
  NOTE (params apply only at start) — unreachable from
  `resolve_manual_fires` (it only fires into a free slot), defensive
  elsewhere.
- Ordering inside `resolve_manual_fires`: lane/name gates → manual-list
  membership (disabled/window-closed defer arms unchanged, payload rides
  the kept marker) → capacity → **firecheck** → start. Success removes the
  marker as today.

**`triggers.py firecheck <repo> <name> <payload-file>`** (new verb + pure
helper `fire_params_check(repo, name, path)`):

- Classification contract (what the supervisor keys on): **rc 3** = the
  PAYLOAD is the problem (parse failure, non-object, non-scalar value,
  undeclared key, declared-secret target, or: merged resolve fails while
  saved-only resolve passes). **rc 1** = the trigger/pipeline side failed
  (load_trigger / resolve_pipeline_doc raised) — not the payload's fault.
  **rc 0** = payload OK. The two-dry-run comparison (merged vs saved-only)
  is the classifier for resolve failures: a failure the saved params
  already had is NOT the payload's fault (keep + defer, the pre-existing
  D1 bound); a failure only the merged set has IS (remove).
- Both dry runs use `pipeline._resolve_run_params(repo, doc, overrides)` —
  the EXACT function `start_run_trigger` calls, so the check inherits the
  start-time repo/account EXISTENCE checks too (CP1 pass-1 finding 4: a
  payload naming an unregistered repo/account param value would pass a
  bare `resolve_params` check, then deterministically refuse at start and
  retry the marker forever). Start-parity by construction, not by copy.
- Reads at most 65536 bytes of payload (a corrupt/hostile marker can't
  balloon the check).

**`pipeline.py start --params-file <path>`** (CLI) /
`start_run_trigger(..., fire_params=None)`:

- `--params-file` requires `--kind native` (rc 2 otherwise, like
  `--event-field`). The CLI reads the file (empty → `{}`; unreadable /
  corrupt / non-object → rc 1 refusal — start is strict; the pre-check
  already classified removal).
- `start_run_trigger`: `fire_params` on a non-manual-mode trigger REFUSES
  (the channel is the manual run-now marker; event/schedule fires have
  their own channels — mirror of the `event_fields` discipline).
  Per-key: a key whose declared type is `secret` REFUSES (message carries
  the param NAME, never the value — the SecretMessageAudit pin), and a
  dict/list VALUE refuses ("must be a scalar") — `_coerce` passes any
  value through for string-typed params, so the scalar rule is enforced
  at this layer and in `firecheck`, not only at the dashboard write side
  (CP1 pass-2 finding 1). Merge:
  `overrides = dict(trig["params"]); overrides.update(fire_params)`;
  then the existing `_resolve_run_params` does undeclared-key / type /
  required enforcement. Resolved values land in state `params` as usual —
  the run's canvas shows the effective params. CLI empty-file content →
  `fire_params=None` (empty means NO overrides — never a present-but-empty
  channel that would trip the manual-only refusal on other paths; CP1
  pass-2 finding 3).

## 5. Page design (lib/pipeline_page.html, ⚡ tab)

- **Enabled toggle:** the `.switch` becomes a button-like control
  (delegated `data-act="trigger_toggle"` listener) for natives and
  pipeline-bound shims; wrapped-role shims keep the inert switch + honest
  title (scope line). Click → build the trigger DOC from the row (below) →
  flip `enabled` → POST `trigger_save`.
- **Doc-from-form construction (ONE builder for create/edit/toggle):**
  `{name, pipeline, firing: {mode, schedule?, event?, map?}, concurrency:
  {policy, max}, enabled, lane?, params?, run_windows?}` — empty optionals
  OMITTED (`params` `{}` dropped, `lane` `""` dropped, `run_windows` `[]`
  dropped — an explicit `[]` is validator-refused by design, `map` `{}`
  dropped). Shim rows: `kind`/`events_csv` never emitted (server refuses
  them anyway — defense in depth is the client following the schema).
- **Create/edit form (`#trigform`):** opened by `＋ new trigger` (view
  head), gallery `＋ trigger` (pre-bound pipeline), or ✎ on a card
  (seeded from the row). Fields: name (create only — edit keeps identity),
  pipeline select (gallery rows, wrapped excluded), mode select
  (continuous/schedule/manual/event), schedule text input (5-field cron;
  server validates), event select (closed vocabulary) + map rows (param →
  item|sha|event; sha only for pr.synchronize — mirrored client-side, server
  refuses regardless), concurrency policy select + max number (parallel
  only), enabled checkbox, lane text (optional), run-windows rows (start/end
  `HH:MM` + day checkboxes, add/remove), typed params inputs generated from
  the SELECTED pipeline's declared params (`pipelines[].params`, new payload
  field): bool→checkbox, number→number input, enum→select of choices,
  secret→text with "credential LABEL" hint, everything else→text; optional
  params include an "unset" state (omit the key). Save → `trigger_save` →
  `TRIGSIG = ""` + `tickLists()`; refusals render the server reason in
  `#trigmsg` (esc()'d — render data hostile).
- **Run-now overlay:** a manual trigger whose bound doc DECLARES params
  (`fire_params` payload field non-empty) gets ▶ run-now enabled and
  opening a small per-card params panel (typed inputs, saved value /
  declared default shown as placeholder; blank = no override; bool params
  use a THREE-state unset/true/false select — a checkbox cannot express
  "omit", so an unchecked box would fabricate a `false` override; CP1
  pass-2 finding 4) → POST `trigger_fire` with the collected `params`
  (omitted when empty → D1 empty-marker fire). A paramless manual trigger
  keeps the D1 direct-fire button. `fire_ready === false` with NO params
  to offer keeps the disabled button + reason.
- **Form state vs the 5s tick:** the open form is a dirty-control surface —
  `renderTriggers`/`renderGallery` must not clobber it (the #202 bar). The
  form lives in a container OUTSIDE the re-rendered card list (sibling of
  the card container inside `#v-triggers`, rendered once); while it is open
  the card-list re-render still runs (payload changes stay visible) but the
  form subtree is untouched. Browser verify includes form-survives-ticks.

## 6. Payload additions (lib/dashboard_state.py, all additive)

- `pipelines[]` rows gain `params`: the doc's declared params projected to
  `[{name, type, required, default?, choices?}]` (`default` included when
  present — a secret's default is a LABEL, non-secret by SD-8); `[]` for
  invalid/unloadable docs and wrapped rows.
- `triggers[]` rows gain `fire_params`: the SAME projection from the bound
  doc for MANUAL-mode triggers (`[]` otherwise / when the doc is
  unreadable) — the run-now overlay's schema; and the client keys the
  edit-form's params section off the pipeline row's `params`.
- `trigger_fire_ready` keeps its D1 verdict semantics for the row's
  `fire_ready`/`fire_block_reason` (empty-marker fire). The overlay path
  is gated by `fire_params` being non-empty (the write side re-validates
  with the actual overrides — read and write share the ONE extended
  helper).

## 7. Security model

- No new endpoint; `trigger_save` + the `trigger_fire` params ride the
  existing `POST /api/control` gauntlet (Host/Origin/size/token +
  server-side re-validation, SD-9).
- `trigger_save` writes ONLY `<repo>/var/autonomy/triggers/<name>.json`
  under a MANAGED repo: name charset-gated before path build, symlink
  shadow refused, gitignore guard, validator-refused content never lands,
  atomic install. The written content is operator-authored JSON the
  VALIDATOR accepted — the same trust level as a hand-authored committed
  trigger file; it can name lanes/pipelines but cannot carry code, paths,
  or shim-internal keys.
- Fire-marker content: previously empty-only; now at most a validated,
  canonical-serialized JSON object of DECLARED-param scalars (secrets
  refused at write, at firecheck, and at start — three layers, one rule).
  The supervisor never trusts it: firecheck + start_run_trigger re-validate
  end-to-end (double validation across the trust boundary).
- Payload/params values echo into refusal messages ONLY for non-secret
  params; secret-key refusals name the KEY only (SecretMessageAudit).
- Render data stays hostile: every new form/overlay/message render is
  esc()'d, delegated `data-*` listeners, no inline handlers.

## 8. Tests + verification

- `tests/test_dashboard_control.py`: `trigger_save` matrix (create /
  overwrite / refusals: charset, non-dict, validator errors incl. unknown
  `events_csv`, name!=stem, gitignore, symlink shadow, byte cap,
  non-JSON-able; refusal leaves prior shadow byte-identical; success
  content canonical; binding + params WARNs on success);
  `trigger_ctl_plan` fire_params → `{"write", content}` / empty → touch.
- `tests/test_dashboard_state.py`: `pipelines[].params` +
  `triggers[].fire_params` projections (tmp-copy repos with declared
  params); `trigger_fire_ready` overrides matrix (secret target refused,
  undeclared refused, type mismatch refused, valid merged passes,
  None = D1 pins untouched).
- `tests/test_dashboard_server.py`: `trigger_save` end-to-end (POST →
  shadow file + content; 409 refusal leaves disk untouched; oversize
  allowance works ≤256 KiB; whitelist); `trigger_fire` with params →
  marker BODY is the canonical JSON; invalid params → 409 + no marker;
  paramless fire still writes the EMPTY marker (byte-parity pin).
- `tests/test_triggers.py`: `fire_params_check` classification matrix
  (ok / parse junk / non-object / undeclared / secret / type-mismatch /
  saved-only-also-fails → transient class / trigger-unreadable →
  transient class); `firecheck` CLI rc parity.
- `tests/test_pipeline.py`: `start_run_trigger(fire_params=)` precedence
  (default < saved < payload), secret refusal, non-manual refusal;
  CLI `--params-file` gates (native-only, unreadable/corrupt refusal,
  empty file = no overrides).
- `tests/test_trigger_dispatch.sh`: payload marker end-to-end against the
  SOURCED `resolve_manual_fires` — valid payload → start invoked with
  `--params-file` + marker removed; rc-3 payload → marker removed loudly,
  NO dispatch; rc-1 (transient) → marker kept + NOTE. Seam rules from the
  D1 lesson: EOF sections re-source (stubs die) — restore seams via eval'd
  `declare -f` dumps, re-stub the recorder, recreate fixtures; NO late
  literal fn redefinition (CI SC2218, prevention-log #19); drive stubs
  through the python3 seam.
- Browser verify + temporal pass per `.claude/skills/dashboard/SKILL.md`
  (throwaway repo with a declared-params pipeline for the form/overlay;
  repo-alpha untouched): create → shadow on disk + card appears; toggle
  disable → shim materialises; run-now with params → marker body on disk;
  form + overlay survive poll ticks; temporal CLS < 0.01, rebuilds ≤1.
- Docs in the same PR: `docs/pipelines.md` (product voice: authoring
  triggers from the dashboard, run-now with parameters, precedence),
  `.claude/skills/dashboard/SKILL.md` (actions), `.claude/skills/
  engineering/pipelines.md` (Phase D status line), settled-decisions
  candidate entry (D2 scope lines above).

## 9. Hard rails

`bin/safe_merge.sh` + `.github/workflows/**` untouched. Loops stay PAUSED.
No closing keyword for #383 anywhere in the PR (prevention-log #20; probe
`closingIssuesReferences` at PR-open AND pre-merge). Supervisor changes are
scoped to `resolve_manual_fires` + the params_file threading (run_session /
resolve_pipeline_ready) — the queued/cron/event resolvers are untouched.
