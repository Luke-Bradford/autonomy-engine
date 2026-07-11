# Phase D slice D3 — pipeline create/clone + provenance (plan)

> **Audience note (engineering record):** task breakdown for the D3 spec
> (`docs/superpowers/specs/2026-07-11-pipeline-model-phaseD3-pipeline-create.md`).
> Every task is TDD: failing test first, watch it fail, implement, watch it
> pass. Branch `feat/383-phase-d3-pipeline-create`.

## Task 1 — writer: `pipeline_create` + `pipeline_save` gate lift

`lib/dashboard_control.py`; tests in `tests/test_dashboard_control.py`.

- `pipeline.provenance_path(repo, name)` — the ONE sidecar path rule,
  next to `effective_pipeline_dir` (CP1: both dashboard modules already
  import pipeline; a duplicated security-sensitive path rule drifts).
  Same precondition: name already charset-gated by the caller.
- New module constant `_RESERVED_PIPE_SUFFIXES = (".staging", ".bak",
  ".provenance.json")`.
- `pipeline_create(repo, name, source=None)` per spec §3 gate order —
  lexists collision on BOTH roots, sidecar-path hygiene (absent or
  regular non-symlink file), mkdir-CLAIM install shape (claim → stage →
  provenance → rename-over-own-empty-claim), provenance failure =
  rollback + refusal (binary end-state, no WARN arm). Blank starter doc +
  `work.md` content live as module constants (`_BLANK_DOC(name)` builder
  + `_BLANK_BRIEF`).
- Fingerprint: `hashlib.sha256(serialized.encode("utf-8")).hexdigest()`,
  stored as `"sha256:<hex>"`.
- `pipeline_save`: replace the committed-only refusal with
  "neither committed nor (non-symlink) shadow dir" refusal; message
  "no pipeline %r to edit (create it first)". The seed for a shadow-only
  pipeline is `_pipeline_seed_dir`'s existing behaviour (valid shadow
  seeds; invalid shadow → nonexistent committed path → briefs must come
  from the POST — honest refusal via the staged re-validate; CP1
  regression test pins it).
- Test matrix per spec §7 bullet 1. Refusal assertions compare a full
  recursive dir listing + file bytes before/after.

## Task 2 — payload: gallery `local` + `provenance` + `diverged`

`lib/dashboard_state.py`; tests in `tests/test_dashboard_state.py`.

- `_read_provenance(repo_path, name)` total reader (size-bound 65536,
  EXACT schema per spec §4 — types, `valid_pipeline_name` on source,
  `^sha256:[0-9a-f]{64}$` fingerprint, no unknown keys; anything else →
  None) + projection into `_gallery_rows` per spec §4: `source` gains
  `local`; `provenance` attached only on `local` rows; `diverged`
  computed only for `created == "clone"`, guarded, key absent on any
  failure. VAR-dir enumeration skips symlinked entries.
- Canonical-serialize twin: the compare re-serializes the effective doc
  with `json.dumps(doc, indent=2, sort_keys=True, allow_nan=False)` — the
  writer's exact call; a parity test pins writer-fingerprint ==
  reader-recompute on a fresh clone (no drift).
- Test matrix per spec §7 bullet 2 (tmp-copy repos; repo-alpha pins
  untouched — audit with the full suite after).

## Task 3 — route: `pipeline_create` control action

`bin/dashboard.py`; tests in `tests/test_dashboard_server.py`.

- `_ws_actions` += `pipeline_create`; own `elif` arm: `name` must be str;
  `source` ABSENT/`null` → blank, non-str → 409, a present string
  (including `""`) passes VERBATIM to the writer (no `source or None`
  normalization — a malformed clone request must refuse, never degrade to
  blank; CP1). NOT in the oversize allowance tuple.
- End-to-end tests per spec §7 bullet 3 + the dispatchability pin
  (`resolve_pipeline` on the created name).

## Task 4 — page: gallery form + badges

`lib/pipeline_page.html`.

- `ensureGalSkeleton()` (#galmsg/#galform/#galcards), `renderGallery` →
  `#galcards` only; `openGalForm(source?)` / `closeGalForm` /
  `readGalForm`; delegated acts `pipe_new` / `pipe_clone` /
  `pipe_create_send` / `pipe_cancel` on the `#v-gallery` listener.
- Badge text per spec §1.3 (esc() everywhere); `⧉ clone` live only on
  valid non-wrapped rows (invalid → inert span + reason title).
- POST via the existing control-fetch shape (mirror `trigSave`'s fetch —
  message into `#galmsg`, `TRIGSIG = ""`, `tickLists()`).

## Task 5 — docs (same PR)

`docs/pipelines.md` (product: create/clone from the gallery; provenance
badge meanings; local pipelines are var-runtime state, committed packs
stay the shareable defaults), `.claude/skills/dashboard/SKILL.md` (action
list + oversize note unchanged), `.claude/skills/engineering/pipelines.md`
(Phase D status line → D3 shipped, deferred list update),
`docs/settled-decisions.md` candidate entry (SD-44: D3 scope lines).

## Task 6 — gates + verify

pre-push-checklist (run_all + shellcheck + pre-flight-review incl.
same-class scan), Codex CP2, browser verify + temporal pass per SKILL.md
(throwaway repo), PR per pr-authoring (security model section; scope-lines
comment on #383), probe `closingIssuesReferences` at open + pre-merge —
intent: CLOSES #383 (last D slice) IF all D scope lines shipped.
