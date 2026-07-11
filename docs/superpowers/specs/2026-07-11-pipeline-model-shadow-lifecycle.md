# Shadow-lifecycle slice — trigger delete + pipeline delete + reset-to-committed (spec)

> **Audience note (engineering record):** engineering build spec for the
> engine's own development loop. Process vocabulary (SD-N, prevention-log #N,
> CP1-3) decodes via `.claude/skills/engineering/pipelines.md`.

**Provenance:** issue #388. The one remaining authoring gap of the
pipeline+trigger model — deferred by SD-43 ("trigger delete /
reset-shadow-to-committed … pairs with D3's gallery lifecycle") AND SD-44
("pipeline/trigger delete + reset-shadow-to-committed (one future 'shadow
lifecycle' slice)"); first named as a deferred write surface in SD-38.
Underneath: SD-34 (var-live shadow model — the dashboard writes var/ ONLY),
SD-37 (pipeline shadow resolver + writer discipline), SD-42/43/44 (D1/D2/D3
boundaries this slice completes).

## 1. What ships

1. **Two new `POST /api/control` actions** (SD-9: never a new endpoint) —
   `trigger_delete` and `pipeline_delete`, body `{action, token, repo,
   name}`. Each removes ONE var-shadow asset:
   - `trigger_delete`: the SD-34 FILE shadow
     `<repo>/var/autonomy/triggers/<name>.json`;
   - `pipeline_delete`: the SD-34 DIR shadow
     `<repo>/var/autonomy/pipelines/<name>/` **plus** its
     `<name>.provenance.json` sidecar (`pipeline.provenance_path`) — a
     delete never SILENTLY orphans the sidecar (a removal failure is
     reported, and a leftover is invisible to the reader + reclaimed by
     re-create — the D3 orphan rules), and a RESET removes a stale one
     too (junk next to a committed pack is already ignored by the
     reader; removing it is hygiene, not semantics).
2. **ONE writer rule, a display fork.** "Delete" and "reset-to-committed"
   are the SAME operation — remove the var shadow — because SD-34's
   resolvers (`effective_trigger_path` / `effective_pipeline_dir`) already
   define what happens next:
   - a shadow that SHADOWS a committed asset → the committed default
     resurfaces (**reset**);
   - a native trigger file that MATERIALISED a role shim (D2) → the role
     shim resurfaces — the exec-semantics flip runs BACKWARD (role
     prompt/scope/model settings apply again); the page confirm names it,
     the mirror of D2's materialise confirm;
   - a shadow-ONLY asset (created/local) → full removal — the gallery card
     goes away; triggers still bound to a deleted pipeline keep their
     honest missing-pipeline state (D2's save-WARN + `fire_block_reason`
     already render it).
   Deriving the fork from committed-counterpart presence (not a second
   code path) means reset-vs-delete can never drift from the resolver's
   own fallback order. COMMITTED assets are never deletable from the
   dashboard (SD-34): a name with no shadow refuses, with the reason
   naming the committed pack when one exists.
3. **Fail-closed guards** (both actions; every gate runs BEFORE any
   mutation, so a refusal leaves the tree byte-identical):
   - **in-flight run guard**: refuse while the asset has an in-flight run
     token (a present `.pipeline-run-*.json` state file IS the in-flight
     authority — `pipeline._finish` unlinks it). Python-side scan; the
     supervisor is untouched.
   - **pending-marker guard**: refuse while a `var/trigger-ctl/fire/` or
     `queued/` marker targets the trigger (or, for a pipeline, ANY valid
     trigger bound to it) — a pending fire consumed after the delete would
     start against the resurfaced twin (or refuse and burn a backoff),
     neither of which the operator asked for.
   - `stop/` and `backoff/` markers do NOT block: they are per-NAME
     freeze/pacing state, stay meaningful for a resurfaced twin of the
     same name, and the card renders them honestly. Accepted bound,
     documented.
4. **Page controls**: gallery cards + ⚡ trigger cards grow 🗑 delete /
   ⟲ reset (`confirm()` flows naming the consequence — including
   enabled-trigger deletion and bound-trigger dangling; refusal reasons
   render via the existing `#galmsg`/`#trigmsg` statics; tick-proof — the
   controls live in the re-rendered card lists, the messages/forms in the
   D2 static siblings).
5. **Same PR**: the pending prevention-log entry — any prose that flows
   through `pipeline.substitute()` must `$${`-escape its `${` examples
   (Phase C `_OUTPUTS_FOOTER` + D3 starter brief = 2 hits).

## 2. Scope lines (conscious, veto-able — recorded on #388 with the PR)

| Item | In? | Why |
|---|---|---|
| `trigger_delete` + `pipeline_delete`, one action each | **YES** | the SD-43/SD-44 deferred pair; body is a name — no oversize allowance. |
| reset-to-committed as the SAME action | **YES** | one writer rule (remove the shadow); the fork is display truth derived from committed presence. A separate `*_reset` action would be a second whitelist arm with an identical body. |
| in-flight + fire/queued marker guards, fail-closed | **YES** | deleting under a live run is fail-open (mid-run brief reads come from the pipeline dir; a pending fire would land on the resurfaced twin). Over-refusal is acceptable and every refusal names the blocking token/marker. |
| `stop`/`backoff` markers block deletion | **NO** | per-name state that stays honest for a resurfaced twin; the card shows it. Removing supervisor-owned markers is out of scope (SD-42: `queued/`+`backoff/` are supervisor-owned). |
| committed assets deletable | **NO** | SD-34: the dashboard writes var/ only. Inert control + reason on committed cards. |
| shim "delete" | **NO** | a shim has no file; `enabled:false` (D2) is its lifecycle. No control renders. |
| canvas-page reset control | **NO** | the gallery card is the asset's lifecycle home (D3 pattern); the canvas keeps Save/Revert. One control per concern. |
| supervisor-side reader for the guards | **NO** | the state-file glob + marker dirs are plain files; python-side scans in `dashboard_control` (the D1 "neutral home / no cross-import" precedent holds — the scan cites `_parse_run_token` as the canonical grammar and deliberately OVER-matches, see §5). |
| scanning lane-service WORKTREES | **NO — and it would be wrong, not just out of scope** | a separate lane service runs `--repo <its own worktree>` and resolves triggers/pipelines/shadows from THAT checkout (`effective_*_path(repo=worktree)`); the managed repo's var-shadow delete cannot change what it resolves, so its runs/markers are not endangered. Own-service lanes DO run against the managed repo — their state files + markers live here with `--<lane>` suffixes, which the guard's over-match covers. (CP1 finding, adjudicated: the blind spot exists only for assets the delete cannot affect.) |
| cleanup of writer scratch (`.staging`/`.bak`) on delete | **NO** | reserved namespace, reclaimed at write time by the writers that own it (D3 accepted bound). |
| orphan sidecar with NO dir | not deletable | invisible to the reader (only `local` rows read provenance) and overwritten by re-create (D3); no control for an invisible artifact. |

## 3. `trigger_delete` design (lib/dashboard_control.py)

`trigger_delete(repo, name)` → `{ok: True, path, message}` /
`{ok: False, error}`. Gate order (nothing on disk changes before ALL pass):

1. Charset gate `pipeline.valid_pipeline_name(name)` BEFORE any path build
   (prevention-log #6; trigger names share the charset).
2. Shadow shape: `var/autonomy/triggers/<name>.json` must be a REGULAR
   non-symlink file. A symlink or non-file squatter refuses ("not a clean
   file" — the trigger_save shape; unsanctioned junk is removed by hand).
   ABSENT forks the refusal reason: committed trigger file exists →
   "committed trigger — not deletable from the dashboard (SD-34)"; else
   "no trigger shadow to remove". The shadow's CONTENT is never read —
   deleting an invalid/corrupt shadow is precisely the recovery path this
   slice exists to provide.
3. In-flight guard (§5): any state-file token owned by `name` refuses,
   naming the token.
4. Marker guard (§5): a `fire/` or `queued/` marker for `name` (any lane
   suffix) refuses, naming the marker path.
5. `os.unlink(shadow)`. `OSError` → refusal (tree untouched — unlink
   either removed it or didn't).

Success message forks on what resurfaces, best-effort (display only, total:
a probe failure degrades to generic wording): committed trigger file
exists → "the committed trigger resurfaces next tick"; else the name is a
config role (`triggers.shim_triggers` names, from the same `_load_config`)
→ "the role shim resurfaces — role prompt/scope/model settings apply
again"; else "trigger removed".

## 4. `pipeline_delete` design (lib/dashboard_control.py)

`pipeline_delete(repo, name)` → same shape. Gate order:

1. Charset gate (as above).
2. Shadow shape: `var/autonomy/pipelines/<name>` must be a NON-SYMLINK
   directory (symlink/file squatter refuses — `shutil.rmtree` must never
   follow a link out of var/, and a squatter is not a sanctioned shadow).
   ABSENT forks the refusal: committed dir exists → "committed template —
   not deletable from the dashboard (SD-34)"; else "no pipeline shadow to
   remove".
3. In-flight guard (§5): a state file whose EMBEDDED doc is named `name`
   refuses; a state file that cannot PROVE its pipeline ≠ `name` refuses
   too — unreadable JSON, a non-dict, a missing/non-dict `doc`, a
   non-string `doc.name` (CP1 fold: malformed evidence is unreadable
   evidence; absence of proof is not proof of absence, prevention-log
   #18) — naming the token either way.
4. Marker guard (§5): enumerate triggers (`dispatchable_only=False`);
   a `fire/`/`queued/` entry refuses when ANY of (CP1 folds, both
   passes):
   - it matches a valid trigger BOUND to `name`;
   - it matches a REFUSED trigger-file stem (the stems on disk minus the
     valid names — a refused trigger's binding is unknowable, so its
     marker cannot be proven not-`name`'s; this closes the
     prefix-attribution hole where junk `good--x` reads as valid trigger
     `good` while a refused trigger literally NAMED `good--x` bound to
     `name` also exists);
   - it matches NO valid trigger at all (pure junk — unattributable).
   Every such refusal names the marker so the operator can remove it or
   let the supervisor consume it. Entries whose every interpretation is
   a valid trigger bound to a DIFFERENT pipeline pass (a marker
   `good--x` with valid `good` bound elsewhere and NO `good--x` stem is
   consumable only as `good`, which does not touch `name`).
   Enumeration failure (config unreadable) REFUSES — the binders cannot
   be known (fail-closed, prevention-log #3/#18).
5. **Detach by RENAME, not a live rmtree** (CP1 fold — a direct rmtree
   can partially mutate before failing, breaking the byte-identical
   contract): reclaim any stale `<shadow>.trash` junk, then
   `os.rename(shadow, shadow + ".trash")` — ONE atomic step after
   which the resolver provably no longer sees the shadow. Rename failure
   → refusal, tree byte-identical (nothing else has been touched; the
   trash reclaim touched only the delete's own namespace). Then
   best-effort `shutil.rmtree(trash, ignore_errors=True)`.
   `.trash` is a NEW reserved suffix (joins `_RESERVED_PIPE_SUFFIXES`,
   so `pipeline_create` mint-refuses names ending in it) OWNED by
   `pipeline_delete` alone — CP1 pass 2: reusing the writers'
   `<name>.staging` races a concurrent `pipeline_create`/`pipeline_save`
   of the same name (the server is a `ThreadingHTTPServer`; a delete
   could reclaim an actively-validating staging dir or swap the claim
   dir under create's install rename). A distinct, single-owner scratch
   name removes the cross-action race class instead of documenting it.
   Accepted bound (the D3 claim-window class): a poll tick landing
   inside the rename→rmtree window can transiently list a
   `<name>.trash` gallery row; display-only, self-heals next tick.
6. Sidecar: `<name>.provenance.json` unlinked AFTER the successful
   detach (islink OR exists — unlink removes the link itself, no follow
   risk). Runs on the reset path too (a sidecar next to a committed pack
   is stale junk). `OSError` → the delete SUCCEEDED (the dir detach is
   the point of no return) and the message says so honestly: the
   leftover sidecar is INVISIBLE to the reader (only `local` rows — dir
   present — consult provenance) and re-create overwrites orphans (D3) —
   reported, never silent.

Success message forks: committed dir exists → "local edits discarded —
the committed template is live again (next runs read it)"; else
"pipeline removed — triggers still bound to it will refuse to start until
rebound or deleted" (the D2 missing-pipeline state).

## 5. The shared guards (fail-closed scans)

**In-flight scan.** `var/autonomy-logs/.pipeline-run-*.json` listing; a
present state file IS an in-flight run (`_finish` unlinks on completion).
Entries whose base's FINAL dot-component (`base.rsplit(".", 1)[-1]` — the
`_parse_run_token` rule, NOT a bare endswith, CP1 fold) is a RESERVED
sidecar suffix (`pipeline._RESERVED_SIDECAR_SUFFIXES`) are skipped —
sidecars share the glob namespace and can outlive their run (the Phase C
phantom-token lesson).

- *Trigger attribution is by FILENAME* (the token). The canonical grammar
  lives in `dashboard_state._parse_run_token` / the supervisor's
  `inflight_tokens`; the guard does NOT reuse it because exact parsing is
  fail-OPEN here: lane-stripping requires the state file's own `lane`
  field, so an unreadable state would make `<name>--<lane>` invisible to
  an exact parse keyed on `name`. The guard instead OVER-matches on the
  grammar's own separators, content-free: strip one trailing `@<digits>`;
  refuse when the remainder `== name`, starts with `name + "--"` (lane
  suffix), or matches `^<name>\.c\d+\.` (a child of this trigger's run).
  Over-match consequences are accepted and explainable: a trigger named
  `a` blocks on a run of a trigger honestly named `a--b` (the `--`
  ambiguity is inherent to the token grammar) — the refusal names the
  token, and the safe side of ambiguity is refusal.
- *Pipeline attribution is by CONTENT*: parse each state file; a dict
  whose `doc.name == name` refuses. State that cannot PROVE otherwise —
  unreadable, non-dict, missing/malformed `doc` — refuses too (§4.3).
  Child runs of a `call_pipeline` into `name` embed `name`'s doc —
  covered by the same rule.

**Marker scan.** `var/trigger-ctl/fire/` + `queued/` listings; an entry
matches a trigger when it `== name` or starts `name + "--"` (any lane).
The same deliberate over-match as above — `marker_basename`'s lane rule
is `<name>--<lane>`, and a delete guard must catch every lane's marker
without trusting lane config. `trigger_delete` refuses on an entry
matching ITS name; `pipeline_delete` refuses on an entry matching any
bound trigger OR matching no valid trigger at all (§4.4).

**Scan-root scope** (CP1 adjudication): both scans read the MANAGED
repo's `var/` only. A separate lane service runs `--repo <its own
worktree>` and resolves every trigger/pipeline/shadow from THAT checkout
— this repo's shadow delete cannot change what it resolves, so its runs
and markers are not endangered and scanning them would guard nothing.
Own-service lanes run against THIS repo (state files + markers here,
`--<lane>`-suffixed) — the over-match covers them.

**Listing failures are fail-closed** (CP1 fold): a MISSING directory
(`FileNotFoundError`) is provably-empty — markers/state can only exist
inside it — and passes; any OTHER `OSError` (permissions, I/O) means
absence cannot be proven and REFUSES (prevention-log #18).

## 6. Payload design (lib/dashboard_state.py)

`build_triggers_view` trigger rows gain three additive booleans the page
needs to pick the right control + confirm text:

- `has_shadow`: a regular non-symlink file at
  `var/autonomy/triggers/<name>.json` (parity with
  `effective_trigger_path`'s sanction rule).
- `has_committed`: a file at `.autonomy/triggers/<name>.json`.
- `shim_behind`: the name is in `triggers.shim_triggers(cfg)`'s name set
  (a role of the same name would re-shim if the native file vanished).
  Total-guarded to `False` — by the time a card renders,
  `enumerate_triggers` already proved the config readable, so the guard
  is unreachable belt-and-braces.

Shim rows read `has_shadow: False` by construction (a native file would
have suppressed the shim). Gallery rows need NOTHING new: `source`
(`committed`/`shadow`/`local`/`wrapped`) + `triggers` already carry the
fork; enabled-ness of bound triggers comes from `tv.triggers` at render
time.

## 7. Page design (lib/pipeline_page.html)

- **Gallery card acts** (delegated `data-act`, esc()'d names):
  - `source === "shadow"` → `⟲ reset` (`data-act="pipe_delete"`), confirm:
    "Discard the local edits of '<name>'? The committed template becomes
    live again (next runs read it)."
  - `source === "local"` → `🗑 delete`, confirm: "Delete pipeline
    '<name>'? …" + when `p.triggers` is non-empty, the bound trigger
    names with their enabled-ness ("triggers X (enabled), Y will show
    missing-pipeline until rebound or deleted").
  - `committed` → inert span, title "committed template — edit or remove
    it in the repo, not the dashboard"; `wrapped` → no control.
- **⚡ trigger card acts** (`kind === "native"` only; shims keep the D2
  enabled-toggle as their lifecycle):
  - `has_shadow && has_committed` → `⟲ reset`
    (`data-act="trigger_delete"`), confirm: committed trigger resurfaces.
  - `has_shadow && !has_committed && shim_behind` → `🗑 delete`, confirm
    mirrors D2's `SHIM_CONFIRM` in reverse: "the role shim '<name>'
    resurfaces — role prompt/scope/model settings apply to its runs
    again" (+ "this trigger is ENABLED — its current firing config stops
    applying" when enabled).
  - `has_shadow && !has_committed && !shim_behind` → `🗑 delete`, confirm:
    full removal (+ the enabled line when enabled).
  - `!has_shadow` (committed native) → inert span, title "committed
    trigger — remove it from the pack, not the dashboard".
- Both routes POST through the existing helpers (`trigCtl`-style fetch to
  `/api/control`); refusals land in `#trigmsg`/`#galmsg` via
  `textContent` (safe by construction), success → signature reset +
  `tickLists()`. The confirm() strings interpolate only names already in
  the payload the page renders elsewhere — and `confirm()` takes plain
  text, not HTML (no esc() needed there; esc() everywhere the name lands
  in markup).

## 8. Security model

- No new endpoint: both actions ride the `POST /api/control` gauntlet
  (Host/Origin/size/token + managed-repo check, SD-9); bodies are a name
  — the classic 8 KiB cap holds, NOT in the oversize allowance.
- Deletes touch ONLY `<repo>/var/autonomy/{triggers,pipelines}/` +
  `var/…/<name>.provenance.json` for a MANAGED repo, under a
  charset-gated name (prevention-log #6): no path a hostile name can
  bend, symlink squatters refuse (never followed), committed trees are
  structurally unreachable (SD-34).
- Fail-closed direction everywhere (prevention-log #18): in-flight or
  pending-marker evidence — including UNREADABLE evidence — refuses;
  refusal reasons name the blocking artifact; every refusal leaves the
  tree byte-identical (all gates precede the first mutation).
- Render data stays hostile: names/reasons echo through `esc()` in
  markup, `textContent` for messages, delegated listeners only.

## 9. Tests + verification

- `tests/test_dashboard_control.py` — `trigger_delete` matrix: charset ·
  absent-shadow (committed / nothing, both reasons) · symlink + dir
  squatter · in-flight exact / `@slot` / `--lane` / child-seg token
  refuse · NON-matches don't block (`T2`, `Tx`, `T.charlie`, reserved
  sidecar suffixes) · fire/queued marker refuse (bare + lane-suffixed) ·
  stop/backoff do NOT block · success unlinks + all three message forks ·
  refusals leave the tree byte-identical. `pipeline_delete` matrix:
  charset · absent-shadow forks · symlink/file squatter · in-flight
  doc-name refuse · unreadable/non-dict/missing-doc state refuses ·
  unrelated doc doesn't block · bound-trigger fire/queued refuse (native
  binder + shim binder) · UNATTRIBUTABLE marker refuses · REFUSED-stem
  marker refuses (incl. the `good--x` prefix-ambiguity case) · a marker
  of a valid trigger bound elsewhere passes · config-unreadable refuse ·
  success removes dir AND sidecar (create → delete round-trip) · reset
  removes a stale sidecar · rename failure (monkeypatched) refuses
  byte-identical · refusals byte-identical.
- `tests/test_dashboard_state.py` — `has_shadow`/`has_committed`/
  `shim_behind` matrix: committed-only native · shadow-over-committed ·
  materialised shim (shadow-only + role behind) · bare native · shim row.
- `tests/test_dashboard_server.py` — whitelist arms; POST end-to-end both
  actions; 409 refusal leaves disk untouched; delete → gallery row gone
  next build; reset → `source` flips back to `committed`.
- Browser verify + temporal pass per `.claude/skills/dashboard/SKILL.md`
  (throwaway repo): create → delete round-trip on the gallery; reset on
  an edited template; trigger delete w/ confirm (dialog handled); refusal
  renders in the static message; form/message survive ticks; temporal
  CLS < 0.01, rebuilds ≤ 1, console clean.
- Docs in the same PR: `docs/pipelines.md` (product voice: deleting /
  resetting), `.claude/skills/dashboard/SKILL.md` (action list),
  `.claude/skills/engineering/pipelines.md` (deferred list),
  settled-decisions candidate entry, prevention-log `$${`-escape entry.

## 10. Hard rails

`bin/safe_merge.sh` + `.github/workflows/**` untouched. `bin/supervisor.sh`
untouched (guards are python-side scans over plain files). Loops stay
PAUSED. The PR closes #388 ONLY — probe `closingIssuesReferences` at
PR-open AND pre-merge (prevention-log #20).
