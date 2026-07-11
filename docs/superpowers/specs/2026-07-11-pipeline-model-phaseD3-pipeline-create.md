# Phase D slice D3 — pipeline create-from-blank / clone + provenance (spec)

> **Audience note (engineering record):** engineering build spec for the
> engine's own development loop. Process vocabulary (SD-N, prevention-log #N,
> CP1-3) decodes via `.claude/skills/engineering/pipelines.md`.

**Provenance:** issue #383 (this is the LAST D slice — the PR closes it IF
every D scope line is delivered), operator decisions comment 2026-07-10
(decision 2: full authoring sequenced D1 read → D2 trigger create/edit →
**D3 pipeline create-from-blank / clone**). D1 spec §2 scope line: "pipeline
create-from-blank / clone; template/clone provenance = D3; no provenance data
exists yet". Underneath: SD-29 (double-validation writer), SD-34 (var-live
shadow), SD-37 (`pipeline_save`, the directory-asset writer this slice
generalizes — its "creating/binding is P4" bar is lifted HERE, per its own
docstring), SD-30/31 (metadata-as-index-file + operator-clicked-offer
precedents), SD-42/43 (D1/D2 boundaries).

## 1. What D3 ships

1. **`pipeline_create`** — ONE new `POST /api/control` action (SD-9: never a
   new endpoint) covering both entry points: body `{action, token, repo,
   name, source?}`. `source` absent → create from the BLANK starter;
   `source` present → CLONE an existing pipeline. Writes a NEW directory
   into the SD-34 var shadow `<repo>/var/autonomy/pipelines/<name>/` with
   `pipeline_save`'s SD-29/SD-37 discipline (charset gate before path build,
   gitignore guard, stage → re-validate → deep-compare → atomic install,
   refusal leaves the filesystem byte-identical), plus a **provenance
   record**.
2. **Provenance data model** (the "no provenance data exists yet" gap): a
   SIDECAR FILE `<repo>/var/autonomy/pipelines/<name>.provenance.json` —
   sibling of the pipeline dir, NOT inside it and NOT a doc field:
   - inside the dir it would be deleted by `pipeline_save`'s stale-file
     prune (staging holds exactly doc+briefs) and would squat the brief
     namespace;
   - as a doc field it would widen `validate_doc`'s unknown-key honesty
     gate and travel inertly through dispatch/state/journal — display
     metadata does not belong in the run document.
   SD-30's index-file conventions apply: stdlib JSON, atomic install, no
   secrets. Shape: blank → `{"created": "blank", "at": <epoch>}`; clone →
   `{"created": "clone", "at": <epoch>, "source": <name>,
   "source_version": <doc version at clone>, "fingerprint":
   "sha256:<hex of the installed doc bytes>"}`. The path rule
   (`<pipelines-shadow-root>/<name>.provenance.json`) lives as
   `pipeline.provenance_path(repo, name)` next to `effective_pipeline_dir`
   — ONE neutral home both dashboard modules already import (CP1: a
   security-sensitive path rule duplicated across writer and reader drifts).
   **Every dashboard-created pipeline HAS a sidecar** — a provenance
   install failure REFUSES and rolls the create back (binary end-state;
   CP1: a WARN-and-continue arm would make dashboard-created dirs
   indistinguishable from hand-made state).
3. **Gallery provenance display** — `_gallery_rows` learns a third source
   value **`local`** (shadow dir with NO committed counterpart; `shadow`
   keeps meaning committed-plus-local-edits) and a total `provenance` field
   read from the sidecar (junk/unreadable/stale → `None`, never a claim —
   a display lie's safe side is silence). Clone rows additionally compute
   `diverged` (current doc bytes vs the recorded fingerprint; any failure →
   key absent). Card badges: `template` (committed) · `template · local
   edits` (shadow) · `created blank` · `clone · from <src>@v<N>`
   (+ `⚠ diverged`) · bare `local` (shadow-only dir of unknown origin,
   e.g. hand-made).
4. **Gallery buttons go live** — `＋ new pipeline` (view head) and per-card
   `⧉ clone` open ONE small form (`#galform`, a static sibling outside the
   re-rendered card list — the D2 `#trigform` pattern, tick-proof): name
   input + source select (`— blank —` + every non-wrapped gallery row) +
   create/cancel. Success → signature reset + re-tick; the new card appears
   with `open canvas` (now editable — see 5) and `＋ trigger` (binding a
   trigger to the new pipeline flows through D2's `trigger_save`; **no new
   binding surface**).
5. **`pipeline_save` gate lift** — the "no committed pipeline to edit"
   refusal becomes "no pipeline dir at all": a name with a valid-or-invalid
   NON-SYMLINK shadow dir is editable even without a committed pack (the
   D3-created case — the canvas `editable()` already keys on
   `source.kind === "pipeline"`, so created pipelines become canvas-editable
   with zero page changes). A name with NEITHER dir still refuses —
   create-by-save would bypass `pipeline_create`'s collision + provenance
   discipline.

## 2. Scope lines (conscious, veto-able — recorded on #383 with the PR)

| Item | D3? | Why |
|---|---|---|
| `pipeline_create` blank + clone, ONE action | **YES** | decision 2; one action = one whitelist arm, the `source` param is the fork. |
| provenance sidecar + gallery display incl. `diverged` | **YES** | the D1 scope-line gap; `diverged` is one guarded hash compare over data recorded at clone time (mockup badge vocab). |
| collision refusals | **YES** | a name colliding with a committed OR shadow dir (any file/dir/symlink at either path) refuses — creating a shadow over a committed pack would silently supersede it (that is `pipeline_save`'s EDIT semantics, not create). |
| clone from an invalid source | **REFUSED** | no laundering (prevention-log #3): `load_doc` + `validate_doc` must be clean before a byte is staged. |
| reserved-suffix names | **REFUSED at mint** | `.staging` / `.bak` / `.provenance.json` suffixes would squat the writer's own sibling paths (the Phase C reserved-sidecar mint rule applied to this namespace). |
| pipeline DELETE / reset-shadow-to-committed / save-back-to-template / save-as-new-template | **NO** | the mockup's lifecycle extras; delete/reset are the SD-38/SD-43 deferred write-surfaces (they pair as one "shadow lifecycle" slice); save-back writes the COMMITTED pack (SD-34 forbids: dashboard writes var/ only). Recorded deferred, not lost. |
| provenance for `pipeline_save` edits of committed packs | **NO** | `source: "shadow"` already renders `template · local edits`; retrofitting provenance onto edits adds a writer touch with no new information. |
| wrapped-role rows as clone source | **excluded from the picker; server refuses** | a wrapped doc is synthesized from role config — there is no directory to clone; `effective_pipeline_dir` → no `pipeline.json` → total refusal. |
| a local pipeline named like an existing wrapped-role row | allowed | duplicate NAME in the gallery (one `local`, one `wrapped`) is cosmetic; dispatch cannot confuse them (wrap only happens for UNBOUND roles; binding names a dir). Accepted bound. |
| doctor/pack awareness of local-created pipelines | **NO** | doctor reports the committed pack; var/ is runtime state. INFO-only gap, honest. |

## 3. `pipeline_create` design (lib/dashboard_control.py)

`pipeline_create(repo, name, source=None)` → `{ok: True, path, message}` /
`{ok: False, error}`. Gate order (nothing on disk changes before ALL pass):

1. `pipeline.valid_pipeline_name(name)` — charset before any path build
   (prevention-log #6). Same gate on `source` when given; `source == name`
   refuses ("clone needs a different name").
2. Reserved-suffix refusal: `name` ending `.staging` / `.bak` /
   `.provenance.json` (mint-site rule).
3. Gitignore guard `_var_live_protected(repo, var/autonomy/pipelines)`
   (SD-34 — an unignored shadow is preflight sweep-bait).
4. Collision: `os.path.lexists(committed)` OR `os.path.lexists(shadow)` —
   ANYTHING at either path (file/dir/symlink/broken symlink) refuses (CP1:
   `isdir(committed)` would let a create supersede a committed-pack FILE
   squatter). The provenance sidecar path must be absent OR a regular
   non-symlink file (an ORPHAN sidecar from a hand-removed dir is
   overwritten — it must not brick the name forever; a dir or symlink
   squatting it refuses, the `trigger_save` shadow-hygiene rule).
5. Seed doc:
   - **blank**: `{"name": name, "version": 1, "caps":
     {"max_sessions_per_run": 4}, "nodes": [{"id": "work", "type":
     "agent_task", "brief_ref": "work.md"}]}` + a starter `work.md` brief
     (short authoring guidance). Must pass `validate_doc` like any other —
     the test pins that the starter validates, so a schema drift breaks the
     build not the operator.
   - **clone**: `pdir = effective_pipeline_dir(repo, source)`;
     `load_doc(pdir/pipeline.json)` + `validate_doc(doc, pdir)` must be
     CLEAN (an invalid source refuses — no laundering). New doc = the
     loaded doc with ONLY `name` rewritten (version stays — content
     lineage; the operator bumps on edit). Briefs staged per the doc's own
     `brief_ref`s from `pdir` (regular files only, never symlinks — the
     `pipeline_save` staging rule).
6. Serialize canonical: `json.dumps(newdoc, indent=2, sort_keys=True,
   allow_nan=False) + "\n"`-less (match `pipeline_save`'s serializer, PLUS
   `allow_nan=False`: a hostile/broken SOURCE file on disk can carry
   `Infinity`, which round-trips EQUAL and would pass the compare —
   the `trigger_save` rule). `TypeError`/`ValueError` → refusal. Byte cap
   `_PIPELINE_DOC_CAP`.
7. **Claim**: `os.mkdir(shadow)` immediately after the collision gates —
   the ATOMIC exclusive claim on the name (`FileExistsError` → the same
   collision refusal; CP1: a bare `rename(staging, shadow)` can silently
   REPLACE a dir another writer created in the check→rename window —
   POSIX rename replaces an empty destination dir). From here every
   failure path removes the claim (`rmdir`, best-effort) so a refusal
   leaves the filesystem byte-identical.
8. Stage `<shadow>.staging`: write doc + briefs, re-`load_doc` +
   `validate_doc(reloaded, staging)` + `reloaded == newdoc` deep-compare
   (SD-29). Any failure → staging + claim removed, refusal.
9. Provenance install BEFORE the content rename: canonical JSON, atomic
   no-follow install (unlink stale `.tmp`, `O_WRONLY|O_CREAT|O_EXCL`,
   `os.replace` — the `trigger_save` install shape). Fingerprint =
   `sha256` of the EXACT doc bytes staged in 6. Failure → sidecar/tmp +
   staging + claim removed, refusal (no WARN arm — binary end-state).
10. Content: `os.rename(staging, shadow)` — atomically replaces OUR OWN
    empty claim dir with the fully-staged content (rename over a non-empty
    dir fails, so a racer who stuffed the claim produces a refusal, never
    a half-install). Failure → sidecar + staging removed, claim rmdir'd,
    refusal. Accepted bound (documented): a poll tick landing inside the
    claim→rename millisecond window sees an EMPTY shadow dir → the gallery
    transiently renders that name as an invalid row (no committed pack
    exists to mask — the collision gate guarantees it) and self-heals next
    tick; display-only, fail-closed direction.

Route (bin/dashboard.py): `pipeline_create` joins `_ws_actions` (own `elif`
arm); body fields `name`/`source` shape-checked at the boundary, writer
re-validates. Contract PINNED (CP1: boundary normalization must not turn a
malformed clone request into a blank create): `source` ABSENT or JSON
`null` → blank; any other non-str shape → 409; a present STRING (including
`""`) flows to the writer VERBATIM, where `valid_pipeline_name("")` refuses
— a garbled clone request refuses, never silently degrades to blank. NOT in
the oversize allowance — the body is a name + a name; the 8 KiB default
bounds it.

## 4. Payload design (lib/dashboard_state.py)

`_gallery_rows` per-row additions (all additive):

- `source`: `committed` | `shadow` (committed exists, effective dir is the
  shadow) | **`local`** (NEW — no committed dir) | `wrapped`. Computed from
  `os.path.isdir(committed)` next to the existing effective-dir check.
- `provenance`: `None` | the sidecar dict projected as `{created, at,
  source, source_version, diverged?}` via a total reader
  `_read_provenance(repo_path, name)`: size-bounded read (64 KiB),
  `json.loads`, then EXACT schema (CP1: loose acceptance lets a
  stale/hand-made sidecar fabricate lineage) — a dict whose `created` is
  `"blank"` or `"clone"`, `at` an int; a clone additionally needs `source`
  passing `valid_pipeline_name`, `source_version` int-or-None, and
  `fingerprint` matching `^sha256:[0-9a-f]{64}$`; unknown keys or any
  type/charset violation → `None` (no claim). Only attached when the row's
  source is `local` (a sidecar next to a committed pack is stale junk —
  ignored). `diverged` only for clones: re-serialize the CURRENT effective
  doc with the same canonical dumps and compare `sha256` to `fingerprint`;
  any failure (unreadable doc, hash error) → key ABSENT (no claim), never
  a crash (totality boundary, prevention-log #21).
- Enumeration hygiene: the VAR-dir listing skips SYMLINKED entries (CP1 —
  `effective_pipeline_dir` already ignores a symlinked shadow as
  unsanctioned; listing one would render a row the resolver refuses to
  serve; committed-dir entries are the repo author's own tree and stay
  as-is).

## 5. Page design (lib/pipeline_page.html, 🗂 tab)

- `ensureGalSkeleton()`: `#v-gallery` becomes `#galmsg` + `#galform` +
  `#galcards` (the D2 `#trigcards` split) so the open form + result message
  survive the 5s tick; `renderGallery` writes `#galcards` only.
- Head: `＋ new pipeline` goes live (`data-act="pipe_new"`); per-card
  `⧉ clone` goes live (`data-act="pipe_clone" data-name=…`) on every
  non-wrapped VALID row (cloning an invalid doc refuses server-side; the
  button stays off with the reason on invalid cards — don't offer a dead
  control). Wrapped rows keep the inert span.
- `#galform`: name text input (charset hint), source `<select>` (`— blank
  starter —` default; options = VALID non-wrapped rows ONLY — the same
  rule as the clone button; CP1: offering an invalid row is offering a
  guaranteed server refusal; `pipe_clone` pre-selects + suggests
  `<src>-copy` as the name), create/cancel. Submit → POST
  `pipeline_create` → refusal renders in `#galmsg` (esc()'d, hostile);
  success → close form, `TRIGSIG = ""`, `tickLists()`.
- Badges per §1.3; `esc()` everywhere; delegated `data-act` listeners (no
  inline handlers).

## 6. Security model

- No new endpoint: `pipeline_create` rides the `POST /api/control` gauntlet
  (Host/Origin/size/token + server-side re-validation, SD-9).
- Writes ONLY under `<repo>/var/autonomy/pipelines/` for a MANAGED repo:
  `name`/`source` charset-gated before any path build; reserved suffixes
  refused at mint; squatting symlinks refuse (lexists collision + the
  staging/rename/O_EXCL installs never follow links); gitignore guard;
  validator-refused content never lands; every refusal leaves the
  filesystem byte-identical.
- The written content is either the server's own blank starter or a
  VALIDATED copy of a pipeline already on disk — the clone path cannot
  launder an invalid doc in (prevention-log #3) and copies only the doc's
  own declared briefs (regular files, no symlinks, no strays).
- Provenance sidecar: server-generated JSON only (no operator strings
  beyond the already-charset-gated names); read back TOTALLY with junk →
  `None` (a corrupt sidecar can neither crash the payload nor fabricate a
  lineage claim).
- Render data stays hostile: names/errors/provenance echo through `esc()`,
  delegated listeners only.

## 7. Tests + verification

- `tests/test_dashboard_control.py` — `pipeline_create` matrix: blank →
  dir + canonical doc + brief + provenance sidecar, doc validates, THE
  BLANK STARTER PIN; clone → briefs copied, name rewritten, version kept,
  provenance {source, source_version, fingerprint}; refusals (charset,
  reserved suffix, source==name, missing source, INVALID source
  no-laundering, symlinked source brief not copied, collision committed
  dir AND committed FILE squatter, collision shadow dir/file/symlink,
  gitignore, dir/symlink squatting the SIDECAR path, provenance-install
  failure rolls the whole create back) each leave the tree byte-identical;
  orphan regular-file sidecar overwritten on re-create; `pipeline_save` on
  a created (shadow-only) pipeline now SAVES + still refuses a name with
  neither dir + the CP1 regression: an INVALID shadow-only dir with briefs
  missing from the POST refuses at the staged re-validate (never seeds
  itself).
- `tests/test_dashboard_state.py` — gallery matrix: `local` source value,
  provenance projection (blank/clone), `diverged` flips after a doc edit,
  junk/loose-schema sidecar → `None` (wrong types, bad fingerprint shape,
  unknown keys, charset-invalid source), sidecar-next-to-committed
  ignored, symlinked var entry skipped, writer-fingerprint ==
  reader-recompute parity on a fresh clone, D1 pins (committed/shadow/
  wrapped rows) untouched.
- `tests/test_dashboard_server.py` — end-to-end POST (blank + clone),
  whitelist arm, 409 refusal leaves disk untouched, body shape gates
  (non-str name/source), created pipeline immediately present in
  `/api/triggers` gallery + editable via a follow-up `pipeline_save`.
- Dispatchability pin: `pipeline.resolve_pipeline(repo, <created name>)`
  loads the created doc (proves a trigger can bind it — the D2 flow).
- Browser verify + temporal pass per `.claude/skills/dashboard/SKILL.md`
  (throwaway repo; repo-alpha untouched): create-blank → card appears +
  canvas editable + save persists; clone → provenance badge; form survives
  ticks; refusal renders; temporal CLS < 0.01, rebuilds ≤ 1, console clean.
- Docs in the same PR: `docs/pipelines.md` (product voice: creating/cloning
  pipelines from the gallery, what provenance means),
  `.claude/skills/dashboard/SKILL.md` (action), `.claude/skills/
  engineering/pipelines.md` (Phase D status), settled-decisions candidate
  entry (these scope lines).

## 8. Hard rails

`bin/safe_merge.sh` + `.github/workflows/**` untouched. `bin/supervisor.sh`
untouched (D3 adds NO engine behaviour — dispatch already resolves shadow
dirs). Loops stay PAUSED. #383 closes WITH this PR only if every D scope
line is delivered — probe `closingIssuesReferences` at PR-open AND
pre-merge to confirm intent EITHER way (prevention-log #20).
