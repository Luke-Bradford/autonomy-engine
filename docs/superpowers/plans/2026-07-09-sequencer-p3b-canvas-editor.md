# Sequencer P3b — pipeline canvas EDITOR + var-shadow save path

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The read-only `/pipeline` canvas (P3a) becomes an EDITOR: an operator
drags activities from the palette, draws/cycles/deletes typed edges, edits
schema-driven pane fields and briefs, and saves the whole document to a
var-live shadow — validated before it writes, refused if it would not run,
and never clobbered by a live tick.

**Architecture:** One resolver (`effective_pipeline_dir` in `lib/pipeline.py`)
makes dispatch and the viewer read the same effective document — the committed
`.autonomy/pipelines/<name>/` by default, its var-live shadow
`var/autonomy/pipelines/<name>/` once an edit exists (SD-34's model applied to
pipeline *documents* — the committed file is the shareable default that SEEDS
the shadow; a present-but-invalid shadow refuses, never a silent fallback).
Writes land through a single new `POST /api/control` action `pipeline_save` in
`lib/dashboard_control.py` that re-applies the exact `structural_write`
discipline (gitignore guard, seed-from-committed, validate-before, stage +
re-validate + deep-compare, atomic promote, refuse-leaves-untouched — SD-29).
The page holds a dirty working copy and an explicit Save; a 5-second poll never
overwrites unsaved edits (the #202 bar).

**Tech Stack:** Python 3 stdlib (add `shutil` for the dir copy/rollback);
vanilla JS + inline SVG (existing page conventions); unittest + the
chrome-devtools browser verify loop.

## Global Constraints

Identical to the P1/P2/P3a plans — copied verbatim, every task's requirements
include these:

- **macOS `/bin/bash` 3.2.57 floor** (no bash-4isms). **Python 3 stdlib only**
  (no PyYAML/yq/third-party). **`shellcheck -S warning` clean** across `start
  bin/*.sh bin/agents/*.sh tests/*.sh templates/autonomy-pack/qa/*.sh` — no
  `.sh` changes are planned, but run it. **Every executable body guarded** by
  the `BASH_SOURCE`/`$0` idiom. **Tests are genuine** — `source`/`import` the
  real module, mock only at the established seam.
- **Fail-safe, never fail-open** (SD-4). A gitignore-unknown result = NOT
  protected = refuse. An invalid shadow refuses dispatch and renders its errors
  — never a healthy fallback to committed (prevention-log #3/#15).
- **Repo-agnostic** (SD-3): nothing target-specific in `bin/`/`lib/`; the
  fixture and `/tmp` throwaways carry the test data.
- **Dashboard skill contract**: loopback-only; state builders PURE and total
  (missing/corrupt artifact → degraded field, never an exception); **every
  mutating button goes through `POST /api/control`** (`pipeline_save` is a new
  ACTION, never a new endpoint); server-side re-validation of every control
  value even though the page validates too (defense in depth); the page treats
  ids/strings from the payload as UNTRUSTED — full-coverage `esc()`, delegated
  `data-*` listeners, no inline `onclick="f('${id}')"` handler strings
  (PR #358 security round).
- **Settled decisions binding this plan**: **SD-34** (var-live shadow: UI pack
  edits land in `var/autonomy/…`, committed file SEEDS it, one resolver unifies
  readers, write refuses when `var/` is not gitignored, present-but-invalid
  shadow is a FAILURE not a fallback) — P3b extends it to pipeline documents;
  **SD-29** (full re-emit + double validation, refuse on mismatch, never a
  byte-splice); **SD-9** (loopback + per-process token + server-side
  re-validation on the one write endpoint; every write extension stays behind
  the token+validation); **SD-5** (`git_ops` merge always via safe_merge — a
  guarded, non-editable field on the pane); **SD-28** superseded by SD-34 for
  packs (the unattended loop stays barred from editing packs; this surface is
  operator-only). **A new settled-decision entry (an SD-34 extension) is
  recorded with this PR** (Task 8).
- **Prevention log**: #3/#15 (invalid shadow refuses, no widening fallback),
  #6 (charset-gate the pipeline name + brief basenames BEFORE any path build),
  #13 (temporal browser pass mandatory), #14/#16 + the #202 bar (a
  signature/working-copy guard must own every write path; a live tick must
  never revert an operator's unsaved edit; focusable pane inputs are the
  "actively editing" held controls), #20 (never write `close #N` for an issue
  that must stay open; probe `closingIssuesReferences` before merge), #21 (a
  review fix is a diff too — same-class scan the fix).

## Locked decisions carried from the P3a plan (pt 8) — NOT re-litigated here

1. Edits land in the var-live shadow `var/autonomy/pipelines/<name>/` seeded
   from the committed `.autonomy/pipelines/<name>/` (committed pack edits would
   be stash-swept by preflight; the shadow is the only surviving edit home).
2. One resolver `effective_pipeline_dir(repo, name)` in `lib/pipeline.py`,
   consulted by BOTH `resolve_pipeline` and the dashboard; a present-but-invalid
   shadow is a FAILURE (refuse dispatch, render errors) — never a silent
   fallback to the committed file.
3. Writer = whole-doc re-emit through a new `/api/control` action
   `pipeline_save`: `validate_doc` before, atomic write, re-load + re-validate +
   deep-compare after, refuse-leaves-files-untouched, gitignore guard reused
   (SD-29 mechanics). Briefs save as sibling files under the same
   basename/no-traversal validation the validator already enforces.
4. The editor holds a local working copy; a live tick never clobbers dirty
   edits (#202 defect-3 bar). Body-cap bump per the `ws_prompt_set` precedent.

## New decisions this plan settles (fold into the SD entry, Task 8)

- **P3b edits a BOUND pipeline only.** A wrapped role (no `pipeline:` binding)
  has no committed dir to seed from; its canvas stays READ-ONLY with a "bind a
  pipeline to edit" note. Creating/binding a new pipeline from the canvas is P4
  (gallery/assignment). This is principled, not a shortcut: the seed source is
  the committed pack dir, which a wrapped role lacks.
- **Minimap + search DEFER to P3c.** P3b already ships the write path + three
  gesture families + the dirty-working-copy bar; the diff runs long, so the
  P3a plan's "or split to P3c" clause fires. Stated in the scope marker below
  and in the SD entry so a later loop does not think it regressed.
- **The `/pipeline` page becomes a token-gated write surface.** P3a carried no
  control token (read-only); P3b injects `__CONTROL_TOKEN__` so Save can POST.
  The security model (Task 8) covers this explicitly.

## File Structure

- Modify: `lib/pipeline.py` — add `effective_pipeline_dir(repo, name)` (pure,
  mirrors `config_parser.effective_config_path`); route `resolve_pipeline`'s
  `pdir` through it (the ONE dispatch resolution now reads the shadow).
- Modify: `lib/dashboard_state.py` — `build_pipeline_view` routes its
  `pdir`/`source["dir"]` through `effective_pipeline_dir`; `source` gains
  `shadow: bool` provenance so the page can badge "local edits".
- Modify: `lib/dashboard_control.py` — generalize `_var_live_protected` to take
  a relative path (default keeps existing callers byte-identical); add
  `pipeline_save(repo, name, doc, briefs)` (the SD-29/SD-34 writer) and
  `_PIPELINE_DOC_CAP`.
- Modify: `bin/dashboard.py` — add `pipeline_save` to the oversize-body
  exemption and the action whitelist; route it to `dcx.pipeline_save`; inject
  `__CONTROL_TOKEN__` into `PIPELINE_PAGE`.
- Modify: `lib/pipeline_page.html` — dirty working copy (`WORKING`/`BRIEFS`/
  `DIRTY`), live-tick reconciliation, editable schema-driven pane, palette
  drag-to-place, edge draw/cycle/delete, node remove, Save/Revert + unsaved
  badge, `beforeunload` guard, read-only-for-wrapped gate.
- Modify: `tests/test_pipeline.py`, `tests/test_dashboard_state.py`,
  `tests/test_dashboard_control.py`, `tests/test_dashboard_server.py`.
- Modify: `docs/pipelines.md` (product layer — the editing paragraph),
  `docs/settled-decisions.md` (the new SD entry).
- The read-surface fixture `tests/fixtures/repo-alpha` is UNCHANGED (it stays
  the read-only oracle; it deliberately has no `.gitignore`, so it is not a
  save target). Writer/route tests and the browser save-path verify build
  throwaway `git init` repos with `var/` ignored.

## Interfaces (deltas)

- `pipeline.effective_pipeline_dir(repo: str, name: str) -> str` — pure fs
  check; returns `<repo>/var/autonomy/pipelines/<name>` when that dir holds a
  `pipeline.json`, else `<repo>/.autonomy/pipelines/<name>`. Never raises.
  Precondition: `name` is charset-valid (`valid_pipeline_name`); both callers
  gate first.
- `dashboard_control.pipeline_save(repo: str, name: str, doc: dict|None,
  briefs: dict) -> dict` — `{ok: True, path, message}` or `{ok: False, error}`.
  `doc` is the full pipeline document; `briefs` maps sibling basenames → string
  content for briefs edited on the canvas. Every refusal/exception leaves the
  shadow byte-identical.
- `dashboard_control._var_live_protected(repo: str, rel: str =
  "var/autonomy/config.yaml") -> bool` — generalized; existing callers pass no
  `rel` and stay byte-identical.
- `dashboard_state.build_pipeline_view(...)` gains `source["shadow"]: bool`.
- `POST /api/control {action: "pipeline_save", token, repo, name, doc, briefs}`
  → 200 `{ok:true,…}` / 409 `{ok:false,error}`; token + Host + Origin gauntlet
  inherited; oversize body allowed for this action (like `ws_prompt_set`).

---

### Task 1: `effective_pipeline_dir` resolver + dispatch reads the shadow

**Files:**
- Modify: `lib/pipeline.py` (add the resolver near `valid_pipeline_name`
  ~`lib/pipeline.py:270`; use it in `resolve_pipeline` at `lib/pipeline.py:675`)
- Test: `tests/test_pipeline.py`

**Interfaces:**
- Consumes: existing `valid_pipeline_name`, `load_doc`, `validate_doc`.
- Produces: `effective_pipeline_dir(repo, name)` — consumed by Task 2's viewer
  and Task 3's writer path assumptions.

- [ ] **Step 1: Write the failing tests** — append to `tests/test_pipeline.py`:

```python
class EffectivePipelineDirTest(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.repo, ignore_errors=True)
        self.committed = os.path.join(
            self.repo, ".autonomy", "pipelines", "flow")
        os.makedirs(self.committed)
        # A minimal VALID doc: validate_doc requires caps.max_sessions_per_run
        # AND an edges list (lib/pipeline.py:330,461) -- Codex CP1 finding #1.
        with open(os.path.join(self.committed, "pipeline.json"), "w") as fh:
            json.dump({"name": "flow", "version": 1,
                       "caps": {"max_sessions_per_run": 16},
                       "nodes": [{"id": "a", "type": "pick",
                                  "brief_ref": "a.md"}], "edges": []}, fh)

    def _shadow(self):
        d = os.path.join(self.repo, "var", "autonomy", "pipelines", "flow")
        os.makedirs(d)
        return d

    def test_no_shadow_returns_committed(self):
        self.assertEqual(pipeline.effective_pipeline_dir(self.repo, "flow"),
                         self.committed)

    def test_shadow_with_pipeline_json_wins(self):
        d = self._shadow()
        with open(os.path.join(d, "pipeline.json"), "w") as fh:
            fh.write("{}")
        self.assertEqual(pipeline.effective_pipeline_dir(self.repo, "flow"), d)

    def test_empty_shadow_dir_falls_to_committed(self):
        self._shadow()                       # dir exists, no pipeline.json
        self.assertEqual(pipeline.effective_pipeline_dir(self.repo, "flow"),
                         self.committed)

    def test_invalid_shadow_still_wins_no_fallback(self):
        # a shadow whose pipeline.json is present-but-garbage is NOT a fallback
        # case: the resolver returns the shadow, dispatch then RAISES on it
        # (fail-safe, prevention-log #3) -- never a silent widen to committed.
        d = self._shadow()
        with open(os.path.join(d, "pipeline.json"), "w") as fh:
            fh.write("{ not json")
        self.assertEqual(pipeline.effective_pipeline_dir(self.repo, "flow"), d)

    def test_resolve_pipeline_reads_the_shadow(self):
        # bind the role, give the shadow a DIFFERENT valid doc, assert
        # resolve_pipeline returns the shadow's doc, not committed's.
        cfg = os.path.join(self.repo, ".autonomy", "config.yaml")
        with open(cfg, "w") as fh:
            fh.write("roles:\n  coder:\n    pipeline: flow\n")
        with open(os.path.join(self.committed, "a.md"), "w") as fh:
            fh.write("committed brief\n")
        d = self._shadow()
        with open(os.path.join(d, "pipeline.json"), "w") as fh:
            json.dump({"name": "flow", "version": 9,
                       "caps": {"max_sessions_per_run": 16},
                       "nodes": [{"id": "a", "type": "pick",
                                  "brief_ref": "a.md"}], "edges": []}, fh)
        with open(os.path.join(d, "a.md"), "w") as fh:
            fh.write("shadow brief\n")
        doc, meta = pipeline.resolve_pipeline(self.repo, "coder")
        self.assertEqual(doc["version"], 9)               # shadow, not committed
        self.assertEqual(meta["pipeline_dir"], d)
```

(Confirm `import shutil, tempfile, json, os` are present at the top of
`tests/test_pipeline.py`; add any that are missing.)

- [ ] **Step 2: Run, see them fail**

Run: `python3 -m unittest tests.test_pipeline.EffectivePipelineDirTest -v`
Expected: FAIL — `AttributeError: module 'pipeline' has no attribute
'effective_pipeline_dir'`.

- [ ] **Step 3: Implement the resolver** — add near `lib/pipeline.py:275`
  (right after `valid_pipeline_name`):

```python
def effective_pipeline_dir(repo, name):
    """The SINGLE choke point for var-live pipeline resolution -- SD-34's model
    (config_parser.effective_config_path) applied to pipeline DOCUMENTS. Return
    the live shadow <repo>/var/autonomy/pipelines/<name> when it holds a
    pipeline.json, else the committed <repo>/.autonomy/pipelines/<name>. The
    dashboard's pipeline_save writer owns the shadow; the committed dir stays
    the shareable default that SEEDS it on first save. Consulted by BOTH
    resolve_pipeline (dispatch, raises on an invalid doc) and
    build_pipeline_view (display, degrades) so the two never disagree.

    Pure fs check -- never raises. PRECONDITION: `name` is charset-valid
    (valid_pipeline_name); both callers gate first, so no '/'/'..' reaches the
    join. A present-but-INVALID shadow is NOT a fallback case: the file exists,
    so this returns the shadow and the caller's load_doc/validate_doc refuses it
    (fail-safe, prevention-log #3) -- never a silent widen to committed."""
    committed = os.path.join(repo, ".autonomy", "pipelines", name)
    try:
        shadow = os.path.join(repo, "var", "autonomy", "pipelines", name)
        if os.path.isfile(os.path.join(shadow, "pipeline.json")):
            return shadow
    except (OSError, TypeError):
        pass
    return committed
```

  Then route dispatch through it — replace `lib/pipeline.py:675`:

```python
    pdir = os.path.join(repo, ".autonomy", "pipelines", binding)
```

  with (the `binding` charset gate at `lib/pipeline.py:672` already ran):

```python
    pdir = effective_pipeline_dir(repo, binding)
```

- [ ] **Step 4: Run, see them pass, then the full suite**

Run: `python3 -m unittest tests.test_pipeline -v`
Expected: PASS — the new class green AND every existing `StateMachineTest`/
`GraphWalkTest`/validator test still green (dispatch behaviour is unchanged when
no shadow exists — the regression harness).

- [ ] **Step 5: Commit**

```bash
git add lib/pipeline.py tests/test_pipeline.py
git commit -m "feat(#365): effective_pipeline_dir resolver -- dispatch reads the var-shadow (SD-34 for pipeline docs)"
```

---

### Task 2: the viewer reads the shadow + provenance

**Files:**
- Modify: `lib/dashboard_state.py` (`build_pipeline_view`, ~`:2523`-`:2609`)
- Test: `tests/test_dashboard_state.py`

**Interfaces:**
- Consumes: Task 1's `effective_pipeline_dir`.
- Produces: `build_pipeline_view(...)["source"]["shadow"]: bool`.

- [ ] **Step 1: Write the failing tests** — append to
  `tests/test_dashboard_state.py`'s pipeline-view test class (build a tmp copy
  of the fixture so committed stays clean):

```python
    def test_view_reads_the_shadow_when_present(self):
        repo = _copy_fixture(self)          # helper that copytrees repo-alpha
        shadow = os.path.join(repo, "var", "autonomy",
                              "pipelines", "fixture-flow")
        os.makedirs(shadow)
        # a MINIMAL valid one-node shadow doc, version 42, distinct from
        # committed (caps + edges required, Codex CP1 #1)
        with open(os.path.join(shadow, "pipeline.json"), "w") as fh:
            json.dump({"name": "fixture-flow", "version": 42,
                       "caps": {"max_sessions_per_run": 16},
                       "nodes": [{"id": "only", "type": "pick",
                                  "brief_ref": "only.md"}], "edges": []}, fh)
        with open(os.path.join(shadow, "only.md"), "w") as fh:
            fh.write("x\n")
        v = ds.build_pipeline_view(repo, "coder")
        self.assertEqual(v["source"]["kind"], "pipeline")
        self.assertTrue(v["source"]["shadow"])
        self.assertEqual(v["doc"]["version"], 42)      # shadow, not committed
        self.assertEqual(v["errors"], [])

    def test_committed_view_marks_shadow_false(self):
        v = ds.build_pipeline_view(FIXTURE, "coder")   # no shadow on the fixture
        self.assertFalse(v["source"]["shadow"])

    def test_invalid_shadow_renders_errors_not_fallback(self):
        repo = _copy_fixture(self)
        shadow = os.path.join(repo, "var", "autonomy",
                              "pipelines", "fixture-flow")
        os.makedirs(shadow)
        # valid EXCEPT the node type, so the unknown-type error is the sole
        # failure (caps + edges present)
        with open(os.path.join(shadow, "pipeline.json"), "w") as fh:
            json.dump({"name": "fixture-flow", "version": 1,
                       "caps": {"max_sessions_per_run": 16},
                       "nodes": [{"id": "a", "type": "no_such_type",
                                  "brief_ref": "a.md"}], "edges": []}, fh)
        with open(os.path.join(shadow, "a.md"), "w") as fh:
            fh.write("x\n")
        v = ds.build_pipeline_view(repo, "coder")
        self.assertTrue(v["source"]["shadow"])
        self.assertTrue(v["errors"])                   # shadow's errors, shown
        self.assertEqual(v["source"]["kind"], "pipeline")   # NOT a wrap fallback

    def test_view_carries_brief_texts(self):
        # the pane must seed its brief textarea from server truth, or an
        # edit-writes-only save blindly overwrites the brief (Codex CP1 #8).
        v = ds.build_pipeline_view(FIXTURE, "coder")
        self.assertIn("briefs", v)
        self.assertIn("pick.md", v["briefs"])          # a real fixture brief
        self.assertTrue(v["briefs"]["pick.md"])        # its text, non-empty

    def test_briefs_total_on_unreadable(self):
        # a brief_ref whose file is missing degrades to an absent key, never an
        # exception (builders are total).
        repo = _copy_fixture(self)
        os.remove(os.path.join(repo, ".autonomy", "pipelines",
                               "fixture-flow", "pick.md"))
        v = ds.build_pipeline_view(repo, "coder")
        self.assertNotIn("pick.md", v["briefs"])       # dropped, no crash
        self.assertIn("plan.md", v["briefs"])          # siblings still read
```

  (If a `_copy_fixture` helper does not already exist in the file, add one:
  `d = tempfile.mkdtemp(); self.addCleanup(shutil.rmtree, d,
  ignore_errors=True); shutil.copytree(FIXTURE, os.path.join(d, "repo"));
  return os.path.join(d, "repo")`.)

- [ ] **Step 2: Run, see fail**

Run: `python3 -m unittest tests.test_dashboard_state -v -k shadow`
Expected: FAIL — `KeyError: 'shadow'` / version mismatch (still reads committed).

- [ ] **Step 3: Implement** — in `build_pipeline_view`, replace the hard-coded
  committed join at `lib/dashboard_state.py:2577`:

```python
        pdir = os.path.join(repo_path, ".autonomy", "pipelines", binding)
```

  with the resolver (the `binding` charset gate at `:2562` already ran, so the
  precondition holds):

```python
        pdir = pipeline_mod.effective_pipeline_dir(repo_path, binding)
```

  and add the `shadow` provenance flag to that `source` dict
  (`lib/dashboard_state.py:2578-2580`) — true iff `pdir` resolved under `var/`.
  The version is still set to `0` here and updated from the doc at `:2597-2598`;
  leave that untouched and only add the `shadow` key:

```python
        pdir = pipeline_mod.effective_pipeline_dir(repo_path, binding)
        _shadow_root = os.path.join(repo_path, "var", "autonomy", "pipelines")
        view["source"] = {"kind": "pipeline", "name": binding,
                          "dir": os.path.relpath(pdir, repo_path),
                          "shadow": pdir.startswith(_shadow_root + os.sep),
                          "version": 0}
```

  Set `"shadow": False` in the two OTHER `source` assignments so the key is
  total — the invalid-name branch (`:2566-2567`, add `"shadow": False,`) and the
  wrapped branch (`:2608-2609`, add `"shadow": False,`). `pipeline_mod` is
  already imported lazily in this builder (P3a); reuse it.

  Then add the **brief-text map** so the pane can seed a true edit (Codex CP1
  #8). Add a total helper near `_journal_last_run` (`:2449`):

```python
def _pipeline_briefs(pdir, doc):
    """{brief_ref: text} for a bound pipeline's referenced briefs -- the pane
    seeds its editable textarea from THIS, so a save is a true edit rather than
    a blind overwrite. Total: an unreadable/oversize/missing brief drops its
    key (never an exception -- the builder is the route's totality boundary).
    Only sibling basenames are read (no traversal), matching the validator."""
    out = {}
    if not isinstance(doc, dict):
        return out
    for node in (doc.get("nodes") or []):
        if not isinstance(node, dict):
            continue
        ref = node.get("brief_ref")
        if not (isinstance(ref, str) and pipeline_mod._valid_brief_ref(ref)):
            continue
        try:
            with open(os.path.join(pdir, ref), encoding="utf-8",
                      errors="replace") as fh:
                text = fh.read(200001)          # bounded read (the doc cap)
            if len(text) <= 200000:
                out[ref] = text
        except OSError:
            continue                            # missing/unreadable -> absent
    return out
```

  and set `view["briefs"] = _pipeline_briefs(pdir, doc)` in the bound branch
  (after `view["doc"] = doc`); set `view["briefs"] = {}` in the wrapped and
  invalid-name branches so the key is always present (a wrapped role has no
  editable briefs — it is read-only anyway).

- [ ] **Step 4: Run, see pass, then the full builder suite**

Run: `python3 -m unittest tests.test_dashboard_state -v`
Expected: PASS (new + all existing P3a view tests green).

- [ ] **Step 5: Commit**

```bash
git add lib/dashboard_state.py tests/test_dashboard_state.py
git commit -m "feat(#365): viewer reads the pipeline shadow + source.shadow provenance"
```

---

### Task 3: `pipeline_save` writer (the SD-29/SD-34 discipline)

**Files:**
- Modify: `lib/dashboard_control.py` (generalize `_var_live_protected` at
  `:566`; add `_PIPELINE_DOC_CAP` + `pipeline_save` near the workstream writers,
  ~`:1009`)
- Test: `tests/test_dashboard_control.py`

**Interfaces:**
- Consumes: `pipeline.valid_pipeline_name`, `pipeline._valid_brief_ref`,
  `pipeline.load_doc`, `pipeline.validate_doc`, `pipeline.PipelineError`;
  `_var_live_protected`.
- Produces: `pipeline_save(repo, name, doc, briefs) -> {ok,…}` — consumed by
  Task 4's route.

The writer is `structural_write` (`lib/dashboard_control.py:579-646`)
re-expressed for a *directory* asset: stage the whole desired shadow, validate
it there, deep-compare, then promote atomically with a snapshot rollback — so
every refusal leaves the shadow byte-identical (the ws_prompt_set rollback
precedent, `:976-1006`).

- [ ] **Step 1: Write the failing tests** — a new class in
  `tests/test_dashboard_control.py`. Each test builds a throwaway git repo with
  `var/` ignored so `_var_live_protected` passes (mirror the existing
  `structural_write`/`ws_prompt_set` tests' repo setup):

```python
class PipelineSaveTest(unittest.TestCase):
    def _repo(self, gitignore="var/\n"):
        repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, repo, ignore_errors=True)
        subprocess.run(["git", "init", "-q", repo], check=True)
        if gitignore is not None:
            with open(os.path.join(repo, ".gitignore"), "w") as fh:
                fh.write(gitignore)
        committed = os.path.join(repo, ".autonomy", "pipelines", "flow")
        os.makedirs(committed)
        self.doc = {"name": "flow", "version": 1,
                    "caps": {"max_sessions_per_run": 16},
                    "nodes": [{"id": "a", "type": "pick", "brief_ref": "a.md"},
                              {"id": "b", "type": "check", "brief_ref": "b.md"}],
                    "edges": [{"from": "a", "to": "b", "on": "success"}]}
        with open(os.path.join(committed, "pipeline.json"), "w") as fh:
            json.dump(self.doc, fh)
        for n in ("a", "b"):
            with open(os.path.join(committed, n + ".md"), "w") as fh:
                fh.write("brief %s\n" % n)
        return repo

    def _shadow(self, repo):
        return os.path.join(repo, "var", "autonomy", "pipelines", "flow")

    def test_valid_save_writes_the_shadow(self):
        repo = self._repo()
        doc = dict(self.doc, version=2)
        res = dcx.pipeline_save(repo, "flow", doc, {})
        self.assertTrue(res["ok"], res)
        p = os.path.join(self._shadow(repo), "pipeline.json")
        self.assertTrue(os.path.isfile(p))
        with open(p) as fh:
            self.assertEqual(json.load(fh)["version"], 2)
        # untouched briefs were seeded from committed (brief-existence holds)
        self.assertTrue(os.path.isfile(os.path.join(self._shadow(repo), "a.md")))

    def test_edited_brief_written_seed_untouched_survives(self):
        repo = self._repo()
        res = dcx.pipeline_save(repo, "flow", self.doc, {"a.md": "NEW a\n"})
        self.assertTrue(res["ok"], res)
        with open(os.path.join(self._shadow(repo), "a.md")) as fh:
            self.assertEqual(fh.read(), "NEW a\n")
        self.assertTrue(os.path.isfile(os.path.join(self._shadow(repo), "b.md")))

    def test_invalid_doc_refused_shadow_untouched(self):
        repo = self._repo()
        bad = dict(self.doc)
        bad["nodes"] = [{"id": "a", "type": "no_such_type", "brief_ref": "a.md"}]
        res = dcx.pipeline_save(repo, "flow", bad, {})
        self.assertFalse(res["ok"])
        self.assertFalse(os.path.isdir(self._shadow(repo)))   # nothing written

    def test_brief_traversal_refused(self):
        repo = self._repo()
        res = dcx.pipeline_save(repo, "flow", self.doc, {"../evil.md": "x"})
        self.assertFalse(res["ok"])
        self.assertIn("sibling basename", res["error"])
        self.assertFalse(os.path.isdir(self._shadow(repo)))

    def test_bad_name_charset_refused(self):
        repo = self._repo()
        res = dcx.pipeline_save(repo, "../flow", self.doc, {})
        self.assertFalse(res["ok"])

    def test_gitignore_missing_refused(self):
        repo = self._repo(gitignore=None)     # var/ NOT ignored
        res = dcx.pipeline_save(repo, "flow", self.doc, {})
        self.assertFalse(res["ok"])
        self.assertIn("gitignore", res["error"])
        self.assertFalse(os.path.isdir(self._shadow(repo)))

    def test_name_mismatch_refused(self):
        # the doc's own name must match the save target (Codex CP1 #2) --
        # else the shadow dir 'flow' would hold a doc named 'other', splitting
        # binding / journal / ledger / provenance.
        repo = self._repo()
        res = dcx.pipeline_save(repo, "flow", dict(self.doc, name="other"), {})
        self.assertFalse(res["ok"])
        self.assertIn("must match", res["error"])
        self.assertFalse(os.path.isdir(self._shadow(repo)))

    def test_no_committed_dir_refused_even_with_orphan_shadow(self):
        # BOUND pipelines only: a name with no committed pack is not editable
        # even if an orphan shadow exists (Codex CP1 #5).
        repo = self._repo()
        orphan = os.path.join(repo, "var", "autonomy", "pipelines", "ghost")
        os.makedirs(orphan)
        with open(os.path.join(orphan, "pipeline.json"), "w") as fh:
            json.dump(dict(self.doc, name="ghost"), fh)
        res = dcx.pipeline_save(repo, "ghost", dict(self.doc, name="ghost"), {})
        self.assertFalse(res["ok"])
        self.assertIn("no committed pipeline", res["error"])

    def test_only_referenced_briefs_copied_no_symlinks(self):
        # staging is built from the doc's brief_refs -- never a blind copytree,
        # so stray files and symlinks in the pack are NOT laundered into the
        # shadow (Codex CP1 #7).
        repo = self._repo()
        committed = os.path.join(repo, ".autonomy", "pipelines", "flow")
        with open(os.path.join(committed, "extra.txt"), "w") as fh:
            fh.write("junk\n")
        os.symlink("/etc/passwd", os.path.join(committed, "evil.md"))
        self.assertTrue(dcx.pipeline_save(repo, "flow", self.doc, {})["ok"])
        shadow = self._shadow(repo)
        self.assertFalse(os.path.exists(os.path.join(shadow, "extra.txt")))
        self.assertFalse(os.path.lexists(os.path.join(shadow, "evil.md")))
        self.assertEqual(sorted(os.listdir(shadow)),
                         ["a.md", "b.md", "pipeline.json"])

    def test_invalid_shadow_not_used_as_seed(self):
        # a present-but-invalid shadow is NEVER trusted as a brief seed (no
        # laundering; Codex CP1 #6/#7): untouched briefs reset to committed.
        repo = self._repo()
        self.assertTrue(dcx.pipeline_save(repo, "flow", dict(self.doc, version=2),
                                          {"a.md": "shadow a\n"})["ok"])
        shadow = self._shadow(repo)
        with open(os.path.join(shadow, "pipeline.json"), "w") as fh:
            fh.write("{ not json")                    # shadow now INVALID
        self.assertTrue(dcx.pipeline_save(repo, "flow",
                                          dict(self.doc, version=3), {})["ok"])
        with open(os.path.join(shadow, "a.md")) as fh:
            self.assertEqual(fh.read(), "brief a\n")  # committed's, not laundered

    def test_install_failure_rolls_back_byte_identical(self):
        # fault injection on the atomic pipeline.json publish -> the prior
        # shadow is restored byte-identical (Codex CP1 #4).
        from unittest import mock
        repo = self._repo()
        self.assertTrue(dcx.pipeline_save(repo, "flow",
                                          dict(self.doc, version=5), {})["ok"])
        p = os.path.join(self._shadow(repo), "pipeline.json")
        with open(p, "rb") as fh:
            before = fh.read()
        real = os.replace
        def boom(src, dst):
            if str(dst).endswith("pipeline.json"):
                raise OSError("disk full")
            return real(src, dst)
        with mock.patch("dashboard_control.os.replace", boom):
            res = dcx.pipeline_save(repo, "flow", dict(self.doc, version=6), {})
        self.assertFalse(res["ok"])
        with open(p, "rb") as fh:
            self.assertEqual(fh.read(), before)       # rolled back byte-identical

    def test_oversize_doc_refused(self):
        # the serialized pipeline.json is capped too, not just briefs (Codex
        # CP1 #9); the cap is checked EARLY (before validate_doc).
        repo = self._repo()
        huge = dict(self.doc)
        huge["nodes"] = self.doc["nodes"] + [
            {"id": "n%d" % i, "type": "pick", "brief_ref": "a.md"}
            for i in range(20000)]                    # serialized > 200 KiB
        res = dcx.pipeline_save(repo, "flow", huge, {})
        self.assertFalse(res["ok"])
        self.assertIn("exceeds", res["error"])

    def test_refusal_over_existing_shadow_leaves_it_byte_identical(self):
        repo = self._repo()
        # first, a good save establishes a shadow
        self.assertTrue(dcx.pipeline_save(repo, "flow",
                                          dict(self.doc, version=5), {})["ok"])
        p = os.path.join(self._shadow(repo), "pipeline.json")
        with open(p, "rb") as fh:
            before = fh.read()
        # now a refused save (invalid doc) must not disturb the prior shadow
        bad = {"name": "flow", "version": 6, "nodes": "not a list"}
        res = dcx.pipeline_save(repo, "flow", bad, {})
        self.assertFalse(res["ok"])
        with open(p, "rb") as fh:
            self.assertEqual(fh.read(), before)           # byte-identical

    def test_second_save_over_shadow_seeds_from_shadow_not_committed(self):
        repo = self._repo()
        # save v2 with an edited brief a.md
        self.assertTrue(dcx.pipeline_save(repo, "flow", dict(self.doc, version=2),
                                          {"a.md": "shadow a\n"})["ok"])
        # a THIRD save that does not touch a.md must keep the shadow's a.md
        self.assertTrue(dcx.pipeline_save(repo, "flow", dict(self.doc, version=3),
                                          {})["ok"])
        with open(os.path.join(self._shadow(repo), "a.md")) as fh:
            self.assertEqual(fh.read(), "shadow a\n")     # from shadow, not committed
```

  (Ensure `import shutil, subprocess, tempfile, json, os` at the file top;
  `dcx` is the module alias already used in the file.)

- [ ] **Step 2: Run, see fail**

Run: `python3 -m unittest tests.test_dashboard_control.PipelineSaveTest -v`
Expected: FAIL — `AttributeError: … has no attribute 'pipeline_save'`.

- [ ] **Step 3a: Generalize the gitignore guard** — replace
  `lib/dashboard_control.py:566-576`:

```python
def _var_live_protected(repo):
    """The live file must be invisible to git, or preflight's `stash -u`
    sweeps it (silent config loss). Unknown/error = NOT protected (fail-safe:
    refuse the write rather than risk the sweep)."""
    try:
        rc = _subprocess.run(
            ["git", "-C", repo, "check-ignore", "-q", "var/autonomy/config.yaml"],
            stdout=_subprocess.DEVNULL, stderr=_subprocess.DEVNULL, timeout=10)
    except (OSError, _subprocess.SubprocessError):
        return False
    return rc.returncode == 0
```

  with the path-parameterized form (default keeps `structural_write`/
  `live_scalar_write` callers byte-identical — prevention-log #21: this IS a
  diff, and both existing call sites pass no `rel`):

```python
def _var_live_protected(repo, rel="var/autonomy/config.yaml"):
    """The live file/dir must be invisible to git, or preflight's `stash -u`
    sweeps it (silent loss). Unknown/error = NOT protected (fail-safe: refuse
    the write rather than risk the sweep). `rel` is a repo-relative path under
    var/ (default: the config shadow; pipeline_save passes the pipeline shadow)."""
    try:
        rc = _subprocess.run(
            ["git", "-C", repo, "check-ignore", "-q", rel],
            stdout=_subprocess.DEVNULL, stderr=_subprocess.DEVNULL, timeout=10)
    except (OSError, _subprocess.SubprocessError):
        return False
    return rc.returncode == 0
```

- [ ] **Step 3b: Add the seed helper + the writer** — near
  `lib/dashboard_control.py:1009` (after `ws_prompt_set`), with
  `import shutil as _shutil` added to the module imports. The staging dir holds
  EXACTLY `pipeline.json` + the doc's referenced briefs (never a blind
  `copytree`), and the install publishes `pipeline.json` LAST so a reader never
  sees the shadow without a complete document (Codex CP1 #3/#4/#5/#6/#7/#9
  folded):

```python
_PIPELINE_DOC_CAP = 200000   # per-file byte cap (the _PROMPT_CAP precedent)


def _pipeline_seed_dir(committed, shadow):
    """Where untouched briefs come from: the current shadow IF it is itself
    valid (so prior edits survive a later save), else the committed pack. A
    present-but-INVALID shadow is NEVER trusted as a seed -- no laundering of
    its arbitrary content (SD-34/prevention-log #3); the operator's posted doc
    is the fix and untouched briefs reset to the known-good committed base.
    Total -- any read error falls to committed."""
    import pipeline as _pl
    if os.path.isdir(shadow):
        try:
            cur = _pl.load_doc(os.path.join(shadow, "pipeline.json"))
            if not _pl.validate_doc(cur, shadow):
                return shadow
        except _pl.PipelineError:
            pass
    return committed


def pipeline_save(repo, name, doc, briefs):
    """Whole-doc re-emit of a pipeline into its var-live shadow
    <repo>/var/autonomy/pipelines/<name>/ (SD-34 applied to pipeline documents;
    SD-29 double-validation mechanics). `doc` is the full pipeline document;
    `briefs` maps sibling basenames -> content for briefs edited on the canvas.
    Untouched briefs are seeded per-ref from _pipeline_seed_dir so prior edits
    survive. Returns {ok: True, path, message} or {ok: False, error}; every
    refusal/exception leaves the shadow byte-identical. P3b edits a BOUND
    pipeline only -- a name with no committed pack is refused (creating/binding
    a new pipeline is P4)."""
    import pipeline as _pl
    # charset-gate the name BEFORE any path is built (prevention-log #6; the ONE
    # binding gate dispatch also uses -- what dispatch refuses can never be saved)
    if not _pl.valid_pipeline_name(name):
        return {"ok": False, "error": "pipeline name has invalid charset"}
    if not isinstance(doc, dict):
        return {"ok": False, "error": "pipeline document must be a JSON object"}
    if not isinstance(briefs, dict):
        return {"ok": False, "error": "briefs must be a mapping"}
    # the document's OWN name must match the save target, or the shadow dir
    # <name> would hold a doc named otherwise -- splitting binding / journal /
    # ledger / provenance (Codex CP1 #2).
    if doc.get("name") != name:
        return {"ok": False, "error":
                "document name %r must match the pipeline name %r"
                % (doc.get("name"), name)}
    for bname, bcontent in briefs.items():
        if not _pl._valid_brief_ref(bname):
            return {"ok": False, "error":
                    "brief %r is not a sibling basename (no paths, no dotfiles)"
                    % bname}
        if not isinstance(bcontent, str) or \
                len(bcontent.encode("utf-8")) > _PIPELINE_DOC_CAP:   # BYTES (#9)
            return {"ok": False, "error":
                    "brief %r must be a string under %d bytes"
                    % (bname, _PIPELINE_DOC_CAP)}
    # gitignore guard (SD-34): var/ must be ignored or preflight sweeps it.
    if not _var_live_protected(repo, os.path.join("var", "autonomy", "pipelines")):
        return {"ok": False, "error":
                "var/ is not covered by this repo's .gitignore -- the loop's "
                "preflight would sweep the pipeline shadow. Add a 'var/' line to "
                ".gitignore (and commit it) first."}
    # serialize once; cap the DOCUMENT too, not just briefs (#9), before validate
    serialized = json.dumps(doc, indent=2, sort_keys=True)
    if len(serialized.encode("utf-8")) > _PIPELINE_DOC_CAP:
        return {"ok": False, "error":
                "pipeline document exceeds %d bytes" % _PIPELINE_DOC_CAP}
    # structural pre-check (brief existence is re-checked post-stage)
    errs = _pl.validate_doc(doc, None)
    if errs:
        return {"ok": False, "error": "; ".join(errs)}
    committed = os.path.join(repo, ".autonomy", "pipelines", name)
    shadow = os.path.join(repo, "var", "autonomy", "pipelines", name)
    # BOUND pipelines only: a name with no committed pack is not editable even
    # if an orphan shadow exists (Codex CP1 #5).
    if not os.path.isdir(committed):
        return {"ok": False, "error":
                "no committed pipeline %r to edit (bind one first)" % name}
    seed = _pipeline_seed_dir(committed, shadow)
    staging = shadow + ".staging"
    try:
        os.makedirs(os.path.dirname(shadow), exist_ok=True)
        _shutil.rmtree(staging, ignore_errors=True)
        os.makedirs(staging)
        with open(os.path.join(staging, "pipeline.json"), "w",
                  encoding="utf-8") as fh:
            fh.write(serialized)
        # staging gets EXACTLY the doc's referenced briefs -- posted edits, else
        # copied (regular files only) from the seed. No blind copytree, so stray
        # files / symlinks in a legacy or hostile pack are never laundered in (#7).
        for node in (doc.get("nodes") or []):
            ref = node.get("brief_ref") if isinstance(node, dict) else None
            if not (isinstance(ref, str) and _pl._valid_brief_ref(ref)):
                continue                          # validate_doc will flag it
            dst = os.path.join(staging, ref)
            if os.path.exists(dst):
                continue
            if ref in briefs:
                with open(dst, "w", encoding="utf-8") as fh:
                    fh.write(briefs[ref])
            else:
                src = os.path.join(seed, ref)
                if os.path.isfile(src) and not os.path.islink(src):
                    _shutil.copyfile(src, dst)
        # re-load + re-validate against staging (brief-existence NOW checked)
        reloaded = _pl.load_doc(os.path.join(staging, "pipeline.json"))
        errs2 = _pl.validate_doc(reloaded, staging)
        if errs2:
            _shutil.rmtree(staging, ignore_errors=True)
            return {"ok": False, "error": "; ".join(errs2)}
        if reloaded != doc:                       # SD-29 lossy-emit guard
            _shutil.rmtree(staging, ignore_errors=True)
            return {"ok": False, "error":
                    "re-parse mismatch: the written document would not read back "
                    "identically -- write refused"}
    except (OSError, _pl.PipelineError) as exc:
        _shutil.rmtree(staging, ignore_errors=True)
        return {"ok": False, "error": "could not stage the pipeline: %s" % exc}
    # install staging over the LIVE shadow reader-safely: briefs first (atomic
    # per file), then pipeline.json LAST via an atomic replace -- a concurrent
    # reader (dispatch/poll) never sees the shadow without a complete
    # pipeline.json, so there is no transient fallback-to-committed window (#3).
    # A copytree snapshot backs a wholesale restore if an install write fails (#4).
    backup = shadow + ".bak"
    _shutil.rmtree(backup, ignore_errors=True)
    had_shadow = os.path.isdir(shadow)
    keep = set(os.listdir(staging))
    try:
        if had_shadow:
            _shutil.copytree(shadow, backup)      # rollback snapshot
        else:
            os.makedirs(shadow)
        for entry in sorted(keep):                # briefs first
            if entry == "pipeline.json":
                continue
            tmp = os.path.join(shadow, entry + ".tmp")
            _shutil.copyfile(os.path.join(staging, entry), tmp)
            os.replace(tmp, os.path.join(shadow, entry))
        tmp = os.path.join(shadow, "pipeline.json.tmp")
        _shutil.copyfile(os.path.join(staging, "pipeline.json"), tmp)
        os.replace(tmp, os.path.join(shadow, "pipeline.json"))   # PUBLISH (atomic)
    except OSError as exc:
        try:                                      # wholesale restore
            _shutil.rmtree(shadow, ignore_errors=True)
            if had_shadow:
                os.rename(backup, shadow)
        except OSError:
            pass
        _shutil.rmtree(staging, ignore_errors=True)
        return {"ok": False, "error": "could not install the pipeline: %s" % exc}
    # prune stale files best-effort -- the save already SUCCEEDED at the atomic
    # publish above; a leftover unreferenced file is inert and must not trigger
    # a rollback of a good save.
    try:
        for entry in os.listdir(shadow):
            if entry not in keep and not entry.endswith(".tmp"):
                p = os.path.join(shadow, entry)
                if os.path.isdir(p) and not os.path.islink(p):
                    _shutil.rmtree(p, ignore_errors=True)
                else:
                    os.remove(p)
    except OSError:
        pass
    _shutil.rmtree(staging, ignore_errors=True)
    _shutil.rmtree(backup, ignore_errors=True)
    return {"ok": True, "path": os.path.relpath(shadow, repo),
            "message": "saved to the live pipeline shadow -- applies next run "
                       "(the committed pack is untouched)"}
```

- [ ] **Step 4: Run, see pass, then the full control suite**

Run: `python3 -m unittest tests.test_dashboard_control -v`
Expected: PASS — the new class AND every existing `structural_write`/
`ws_prompt_set` test still green (the guard default kept them byte-identical).

- [ ] **Step 5: Commit**

```bash
git add lib/dashboard_control.py tests/test_dashboard_control.py
git commit -m "feat(#365): pipeline_save writer -- var-shadow re-emit, SD-29 double-validation, snapshot rollback"
```

---

### Task 4: server route — the `pipeline_save` action

**Files:**
- Modify: `bin/dashboard.py` (oversize exemption `:1536`; whitelist `:1552`;
  route in the `_ws_actions` block `:1601-1618`; `PIPELINE_PAGE` token
  injection)
- Test: `tests/test_dashboard_server.py`

**Interfaces:**
- Consumes: `dcx.pipeline_save`.
- Produces: `POST /api/control {action:"pipeline_save",…}` behaviour.

- [ ] **Step 1: Write the failing tests** — follow the existing `ws_prompt_set`
  server-test harness (spin the handler against a throwaway git repo with
  `var/` ignored, added to the managed set; POST with the process token):

```python
    def test_pipeline_save_writes_shadow_200(self):
        repo = self._managed_git_repo_with_pipeline()   # helper (see below)
        doc = {"name": "flow", "version": 3,
               "caps": {"max_sessions_per_run": 16},
               "nodes": [{"id": "a", "type": "pick", "brief_ref": "a.md"}],
               "edges": []}
        r = self._post("/api/control", {"action": "pipeline_save", "repo": repo,
                                        "name": "flow", "doc": doc, "briefs": {}})
        self.assertEqual(r.status, 200)
        self.assertTrue(json.loads(r.body)["ok"])
        self.assertTrue(os.path.isfile(os.path.join(
            repo, "var", "autonomy", "pipelines", "flow", "pipeline.json")))

    def test_pipeline_save_bad_token_403(self):
        repo = self._managed_git_repo_with_pipeline()
        r = self._post("/api/control", {"action": "pipeline_save", "repo": repo,
                                        "name": "flow", "doc": {}, "briefs": {}},
                       token="wrong")
        self.assertEqual(r.status, 403)

    def test_pipeline_save_unmanaged_repo_400(self):
        r = self._post("/api/control", {"action": "pipeline_save",
                                        "repo": "/nope", "name": "flow",
                                        "doc": {}, "briefs": {}})
        self.assertEqual(r.status, 400)

    def test_pipeline_save_invalid_doc_409(self):
        repo = self._managed_git_repo_with_pipeline()
        r = self._post("/api/control", {"action": "pipeline_save", "repo": repo,
                                        "name": "flow",
                                        "doc": {"name": "flow"},   # missing bits
                                        "briefs": {}})
        self.assertEqual(r.status, 409)
        self.assertFalse(json.loads(r.body)["ok"])

    def test_oversize_body_allowed_only_for_pipeline_save(self):
        # a >8192 body with action pipeline_save is NOT rejected at the cap;
        # the SAME oversize body with another action IS rejected (400).
        repo = self._managed_git_repo_with_pipeline()
        big = "x" * 9000
        ok = self._post("/api/control", {"action": "pipeline_save", "repo": repo,
                                         "name": "flow",
                                         "doc": {"name": "flow", "version": 1,
                                                 "caps": {"max_sessions_per_run": 16},
                                                 "nodes": [{"id": "a",
                                                            "type": "pick",
                                                            "brief_ref": "a.md"}],
                                                 "edges": []},
                                         "briefs": {"a.md": big}})
        self.assertNotEqual(ok.status, 400)             # oversize allowed
        bad = self._post("/api/control", {"action": "config_set", "repo": repo,
                                          "key": "k", "value": big})
        self.assertEqual(bad.status, 400)               # oversize rejected
```

  Add a `_managed_git_repo_with_pipeline` helper alongside the existing
  server-test fixtures: `git init` a tmp dir, write `.gitignore` (`var/`), a
  bound `.autonomy/config.yaml` + `.autonomy/pipelines/flow/{pipeline.json,a.md}`,
  register it in the handler's `self.repos`, and (if the harness doesn't already)
  return the abspath. `_post` is the existing helper; add a `token=` kwarg if it
  hard-codes the process token.

- [ ] **Step 2: Run, see fail**

Run: `python3 -m unittest tests.test_dashboard_server -v -k pipeline_save`
Expected: FAIL — `{"error":"invalid action"}` (400) before the writer is wired.

- [ ] **Step 3: Implement** — three edits in `bin/dashboard.py`:

  (a) oversize-body exemption, `:1536-1537`:

```python
        if (path != "/api/chat" and length > 8192
                and body.get("action") not in ("ws_prompt_set", "pipeline_save")):
```

  (b) whitelist — extend `_ws_actions`, `:1552`:

```python
        _ws_actions = ("ws_add", "ws_set", "ws_prompt_set", "repo_init",
                       "pipeline_save")
```

  (c) route inside the post-managed-repo `_ws_actions` block, adding an `elif`
  before the `else: # repo_init` at `:1614`:

```python
            elif action == "pipeline_save":
                doc = body.get("doc")
                briefs = body.get("briefs")
                result = dcx.pipeline_save(
                    repo, str(body.get("name") or ""),
                    doc if isinstance(doc, dict) else None,
                    briefs if isinstance(briefs, dict) else {})
```

  (d) token injection — ensure `PIPELINE_PAGE` is served through the same
  `_page_bytes` token substitution as `PAGE`/`CONFIG_PAGE` (it already routes
  through `_page_bytes` at `:1434`; `_page_bytes` replaces `__CONTROL_TOKEN__`
  when present — Task 5 adds the placeholder to the HTML, and this makes it a
  no-op-safe substitution today). No code change here beyond confirming the
  page constant flows through `_page_bytes`.

- [ ] **Step 4: Run, see pass, then the full server suite**

Run: `python3 -m unittest tests.test_dashboard_server -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bin/dashboard.py tests/test_dashboard_server.py
git commit -m "feat(#365): POST /api/control pipeline_save action -- managed-repo + token gauntlet + oversize exemption"
```

---

### Task 5: editor spine — dirty working copy + Save + unsaved badge

**Files:** `lib/pipeline_page.html` (JS + a header Save/Revert/badge cluster)

No unit harness reaches the JS — the browser verify loop (Task 8) is the oracle.
This task builds the #202 bar that every later gesture depends on; build it
first and verify it in isolation before Tasks 6-7 hang edits off it.

- [ ] **Working-copy model.** Introduce three module-level vars beside the
  existing `SEL`/`OBSERVED`/`COLLAPSED`:

```js
let WORKING = null;        // deep clone of the editable doc; render reads THIS
let BRIEFS = {};           // {basename: content} for briefs edited this session
let DIRTY = false;         // unsaved edits pending
```

  On the FIRST successful `/api/pipeline` fetch (and after a successful Save or
  an explicit Revert), set `WORKING = structuredClone(VIEW.doc)` (fallback
  `JSON.parse(JSON.stringify(...))`), `BRIEFS = {}`, `DIRTY = false`. The
  canvas + pane render from `WORKING`; observed lighting / ledger / in-flight
  overlays keep reading `VIEW` (server truth).

- [ ] **Live-tick reconciliation (the #202 bar).** The existing 5-second
  re-fetch must NOT clobber `WORKING` while `DIRTY`. In the fetch handler:
  - if `!DIRTY`: adopt the fresh doc — `WORKING = structuredClone(VIEW.doc)`
    (normal live update), full render.
  - if `DIRTY`: KEEP `WORKING` (the operator's graph) and re-render ONLY the
    read-only overlays from the fresh `VIEW` (last-run glyphs, in-flight pulse,
    ledger chip). Show a subtle header hint "live updates paused — unsaved
    edits". Never overwrite a node/edge the operator is editing.
  This is the headline P3b safety behaviour — Task 8 asserts an edit survives
  2-3 poll cycles.

- [ ] **Read-only-for-wrapped gate.** When `VIEW.source.kind === "wrapped"` (a
  role with no `pipeline:` binding), the page stays READ-ONLY exactly as P3a:
  no Save/Revert, no palette drag, pane fields stay text (Task 6 gates on this
  too). Render a header note: "auto-wrapped from role — bind a pipeline to
  edit". P3b edits BOUND pipelines only.

- [ ] **Save + Revert + unsaved badge** in the header strip (replace the
  mockup's P4 gallery pills — those are out of scope; keep only what P3b ships):

```
[ pipeline name · v<version> ] [ 🛡 trust chip ] [ ⛓ max_parallel chip ]
[ 📝 local edits ]   ← shown when source.shadow            [ ⚡ last run ]
[ ● unsaved ]  [ Revert ]  [ Save ]   ← shown/enabled when DIRTY
```

  - The page now carries the control token: add a hidden
    `<meta name="control-token" content="__CONTROL_TOKEN__">` (or a
    `const TOKEN="__CONTROL_TOKEN__"` in a `<script>` the server substitutes).
    Read it once; if it is the literal unsubstituted placeholder (page opened
    without a server, e.g. a raw file), disable Save.
  - **Save** (enabled only when `DIRTY`): `POST /api/control` with
    `{action:"pipeline_save", token:TOKEN, repo, name:VIEW.source.name,
    doc:WORKING, briefs:BRIEFS}` (repo + role from `location.search`, same as
    the read fetch; `repo` is the absolute path the read route already used).
    On `200 {ok:true}`: `DIRTY=false; BRIEFS={};` adopt `WORKING` as the new
    baseline, toast the server `message`, and re-fetch (the shadow is now the
    effective read → `source.shadow` flips true). On `409`/`{ok:false}`: render
    the server's `error` string (ESCAPED) in `#errbar`, keep `WORKING` dirty —
    nothing is lost.
  - **Revert**: restore `WORKING = structuredClone(VIEW.doc)`, `BRIEFS={}`,
    `DIRTY=false`, full render.
  - **Unsaved badge**: a `● unsaved` chip visible iff `DIRTY`.
  - **`beforeunload`**: when `DIRTY`, `event.preventDefault()` so a tab close
    warns.

- [ ] **`markDirty()` helper** — every edit path (Tasks 6-7) calls it: sets
  `DIRTY=true`, updates the badge + Save-enabled state, and does NOT re-fetch.
  All mutations go through `WORKING`/`BRIEFS`; NOTHING posts until Save.

- [ ] **Escaping stays total.** New inputs and any operator-authored id/label
  render through the existing `esc()`; error strings from the server render
  through `esc()`; no inline `onclick="f('${id}')"` — keep the P3a delegated
  `data-*` listener pattern for every new control.

- [ ] Commit `feat(#365): editor spine -- dirty working copy, Save/Revert,
  unsaved badge, live-tick never clobbers edits (#202)`.

---

### Task 6: editor — schema-driven pane editing (guarded fields locked)

**Files:** `lib/pipeline_page.html` (`renderPane`, `sheetRows`, `valRow`)

Turn the read-only pane (P3a) into an editor when the pipeline is editable
(bound + not wrapped + token present). Read fields from `WORKING`'s node; write
edits back into `WORKING` and call `markDirty()`.

- [ ] **Editable field rows.** In `sheetRows`/`valRow`, when editable, render
  each spec-sheet field as an input bound to the node's TOP-LEVEL key (validated
  docs carry no `config` sub-object — P3a/CP1):
  - `required` + `optional` scalar fields → `<input>`; enum-shaped hints (arrays
    in the spec sheet) → `<select>`. On `input`/`change`: write the value into
    `WORKING.nodes[i][key]`, `markDirty()`. Empty input → delete the key (unset).
  - `runs_as` → model `<select>` from `__MODEL_CHOICES__` (the config page's
    injection — add the same substitution to `PIPELINE_PAGE`), effort `<select>`
    from the four efforts, account/agent text inputs; write into
    `WORKING.nodes[i].runs_as` (drop the sub-object when all cleared).
  - `brief_ref` node → a brief `<textarea>` **seeded from `VIEW.briefs[ref]`**
    (server truth — Task 2 carries it, Codex CP1 #8). Seeding the real current
    text makes an edit a TRUE edit, never a blind overwrite of an empty box. On
    edit, `BRIEFS[node.brief_ref] = value; markDirty()`; an untouched textarea
    posts no brief (the writer seeds it per-ref from valid-shadow-else-committed).
    If `VIEW.briefs[ref]` is absent (unreadable brief), show a "— brief
    unreadable, saving will create it" note rather than a blank editable box.
- [ ] **Guarded rows are LOCKED.** `sheet.guarded` rows (git_ops "merge always
  via safe_merge", loop/for_each "caps", run_command "allowlist") render with
  the lock glyph and as READ-ONLY text — never inputs (SD-5; spec §4
  guarded-visible-not-removable). A `git_ops` node's operation field is
  editable EXCEPT it can never remove the merge-via-gate guarantee.
- [ ] **Deferred/dangerous stay honest.** `context: own` is validator-refused →
  render the toggle DISABLED with the P5 badge (never offer what the runner
  refuses — decision 3). Permission-mode-beyond-acceptEdits and run_command
  allowlist edits (spec §4 "dangerous-with-friction") are OUT of P3b scope —
  render read-only with a "P4/P5" note, do not build the confirm flow.
- [ ] **Container pane editable**: `exit_when` (textarea), `max_rounds` (input —
  editable value; the CAP stays engine-enforced), `runs_as` default for a
  `stage`. `branch`/`for_each` kinds stay deferred (disabled).
- [ ] **Focus preservation (#14/#16).** The pane input the operator is typing in
  is the "actively editing" held control: an observed-lighting/ledger tick must
  NOT re-render the pane out from under it. Route pane writes so a keystroke
  updates `WORKING` WITHOUT a full pane re-render (update the value in place);
  re-render the pane only on selection change or an explicit structural edit.
  Never `blur()` a text input mid-edit (contrast: a one-shot toggle blurs after
  acting, #16).
- [ ] **Node remove** (pane button): delete the node from `WORKING.nodes` AND
  every incident edge from `WORKING.edges`, clear `SEL`, `markDirty()`, render.
  Note the simplification vs the mockup ("edges reconnect"): P3b removes
  incident edges and the operator re-draws — do not silently rewire.
- [ ] Commit `feat(#365): schema-driven pane editing -- guarded fields locked,
  deferred honest, focus held mid-edit`.

---

### Task 7: editor — canvas gestures (palette place, edge draw/cycle/delete)

**Files:** `lib/pipeline_page.html` (palette, `card`, `drawEdges`, drag/drop +
edge handlers)

Every gesture mutates `WORKING`/`markDirty()` only — nothing posts until Save.
Operator-authored ids are generated from a safe charset, never free-text into a
path.

- [ ] **Palette drag-to-place.** Non-deferred `.pitem`s get `draggable="true"`;
  deferred ones do NOT (honesty — the runner refuses them). On drag over the
  canvas, show rank drop-zones (between columns + an append zone). On drop:
  create a node `{id:<generated>, type:<palette type>, brief_ref:"<id>.md"}` in
  `WORKING.nodes`, seed `BRIEFS["<id>.md"]="(new brief)\n"`, splice a
  success-edge from the previous rank's tail (or leave unconnected — the
  operator draws it), `markDirty()`, render. Generated id: a slugged type +
  numeric suffix, uniqueness-checked against existing ids, charset
  `[a-z0-9_]` only.
- [ ] **Edge draw.** Each node card gets a small edge handle (a dot on the right
  edge). Drag from a source handle to a target card → create
  `{from, to, on:"success"}` in `WORKING.edges`, `markDirty()`. Pre-check: a new
  NON-back edge that would introduce a cycle is REFUSED inline with a hint
  ("would create a cycle — draw a back-edge instead") rather than saved and
  bounced by the validator — reuse the rank/`topUnits` machinery to detect the
  cycle client-side. (Belt: the server `validate_doc` refuses it anyway.)
- [ ] **Edge click-to-cycle.** Click an edge cycles `on`
  success→failure→completion (the mockup's `cycle()`), writes the edge in
  `WORKING`, `markDirty()`, redraws. This is now a real edit (contrast P3a,
  where click was inspect-only, decision 1).
- [ ] **Edge delete.** A small ✕ on edge hover (or shift-click the edge) removes
  it from `WORKING.edges`, `markDirty()`, redraws.
- [ ] **Untrusted-on-render holds.** New ids/types render through `esc()`;
  `data-*` delegated listeners only (no inline handler strings); a node whose
  `type` is not in `spec` still gets the P3a invalid-sheet fallback (an operator
  can't type a type, but a hand-edited shadow could carry one).
- [ ] Commit `feat(#365): canvas gestures -- palette place, edge draw/cycle/
  delete, cycle-refused-inline`.

---

### Task 8: browser verify loop + gates + SD entry + docs + PR

- [ ] **Browser verify loop** (dashboard skill; two repos — read + write):

```bash
# throwaway WRITE repo (var/ ignored) seeded from the fixture pipeline
D=$(mktemp -d)/pipe-edit && mkdir -p "$D" && cd "$D" && git init -q
printf 'var/\n' > .gitignore
cp -R /Users/lukebradford/Dev/autonomy-engine/tests/fixtures/repo-alpha/.autonomy .
git add -A && git commit -qm seed
# serve BOTH: repo-alpha (read oracle) + the throwaway (write)
python3 /Users/lukebradford/Dev/autonomy-engine/bin/dashboard.py \
  --repo /Users/lukebradford/Dev/autonomy-engine/tests/fixtures/repo-alpha \
  --repo "$D" --port 8790
```

  Drive with chrome-devtools MCP:
  - **Read surface unchanged** (P3a still holds) on
    `/pipeline?repo=<repo-alpha-abs>&role=coder`: palette groups, ranked cards,
    container box, red failure edge, back-edge arc, lighting toggle → glyphs +
    dimming, select node → pane rows. `list_console_messages` → ZERO errors.
  - **Editor surface** on `/pipeline?repo=<throwaway-abs>&role=coder`:
    select a node → edit its brief textarea → `● unsaved` appears, Save enables
    → click Save → `/api/control` returns 200 → badge clears → assert on disk
    `var/autonomy/pipelines/fixture-flow/pipeline.json` exists → reload the page
    → the `📝 local edits` chip shows and the edit persists (shadow is now the
    effective read).
  - Palette drag places a node (card appears in a rank); edge draw creates an
    edge; edge click cycles its colour; edge ✕ deletes it; a cycle-forming edge
    is refused inline. A `git_ops` node's guarded merge row is LOCKED (not an
    input).
  - Wrapped role (a second, unbound role) renders read-only with the "bind a
    pipeline to edit" note — no Save.
  - **Temporal pass** (prevention-log #13; dashboard skill step 4): idle the
    editor fixture with ZERO interaction; assert `steadyStateCLS < 0.01`, panels
    `['dag','pane','palette','errbar','edgesvg']` `innerHTMLStable` true,
    `elementRebuildsPerPanel` ≤ 1. `/pipeline` uses the coarser
    payload-signature re-render — confirm an unchanged fetch does not rebuild
    the canvas.
  - **Dirty-control survival** (the #202 bar — RUN ON EVERY EDITOR SURFACE):
    make an edit (pane input, a placed node, a drawn edge), fire its
    `input`/`change`, `await` ~6 s (2-3 poll cycles), assert the edit is STILL
    present and `WORKING` was not reverted by the live tick. A tick that
    clobbers an edit is a `ux` blocker.
  - Kill the server; note the verification (surfaces, actions, console-clean,
    the temporal readings, dirty-survival) in the PR Testing section.

- [ ] **Gates**: `bash tests/run_all.sh` green · `shellcheck -S warning …`
  clean (no `.sh` changes, but run it) · pre-flight-review over the full diff ·
  **Codex checkpoint 2** on the diff (`.claude/skills/engineering/
  codex-checkpoints.md`) — fold real findings before the first push.

- [ ] **New settled-decision entry** in `docs/settled-decisions.md` (next
  number, an SD-34 EXTENSION — cite this PR):

  > **Canvas pipeline edits write to the var-live shadow
  > `var/autonomy/pipelines/<name>/` via `pipeline_save`** (SD-34 applied to
  > pipeline documents; SD-29 double-validation mechanics). One resolver
  > `pipeline.effective_pipeline_dir` is what BOTH dispatch (`resolve_pipeline`,
  > raises) and the dashboard viewer (degrades) consult; a present-but-invalid
  > shadow REFUSES (dispatch raises, the viewer renders its errors) — never a
  > silent fallback to the committed default. The writer re-uses the
  > `structural_write` discipline: gitignore guard, seed-from-committed,
  > validate-before, stage + re-validate + deep-compare, atomic promote,
  > refusal-leaves-the-shadow-untouched. **P3b edits BOUND pipelines only** — a
  > wrapped role has no committed dir to seed from, so its canvas stays
  > read-only; creating/binding a new pipeline is P4. The `/pipeline` page
  > becomes a token-gated write surface (`__CONTROL_TOKEN__` injected). Minimap
  > + search deferred to P3c. The unattended loop stays barred from editing
  > packs (SD-28-superseded-for-packs); this surface is operator-only via the
  > loopback dashboard.

- [ ] **Product-doc update** (house rule: a behaviour PR updates the product
  layer). In `docs/pipelines.md`, replace the "Seeing it" section's closing line
  ("Editing from the canvas is not yet available; today you edit the JSON…")
  with an editing paragraph:

  > **Editing from the canvas.** Drag activities from the palette, draw and
  > cycle typed edges, and edit each activity's fields and brief in the property
  > pane, then **Save**. Edits are written to a **local shadow**
  > (`var/autonomy/pipelines/<name>/`), leaving the committed pack — the
  > shareable default — untouched; the shadow is what the engine then runs. A
  > save is **validated before it lands**: an invalid graph is refused, not
  > stored, and the errors are shown in place. A live view never overwrites your
  > unsaved edits — a badge marks unsaved changes until you Save or Revert.
  > Guarded fields (merge always via the gate, enforced caps) are visible but
  > not editable. Only a role bound to a pipeline is editable; an auto-wrapped
  > role is read-only until you bind one.

- [ ] **PR** per `.claude/skills/engineering/pr-authoring.md` — self-contained,
  with a mandatory **security model** covering the new write surface:
  - **Token gauntlet**: `pipeline_save` is a `/api/control` action, so it
    inherits loopback-bind + Host allowlist (421) + loopback Origin (403) +
    `secrets.compare_digest` token (403) + server-side re-validation. The page
    now embeds `__CONTROL_TOKEN__` (regenerated per launch, never logged).
  - **Charset gates**: the pipeline `name` is `valid_pipeline_name`-gated BEFORE
    any path is built (prevention-log #6 — the same gate dispatch uses); brief
    keys are `_valid_brief_ref`-gated (sibling basename only — no `/`, no `..`,
    no dotfiles). **Path traversal is impossible**: every fs path derives from
    the charset-gated name + basename-only briefs, never from free-form query or
    body path input.
  - **XSS on untrusted doc content**: the page renders operator- and
    file-sourced ids/labels/errors; full-coverage `esc()` (`&<>"'`), delegated
    `data-*` listeners, no inline handler strings (P3a security round, extended
    to the new inputs and the server error banner).
  - **Write integrity**: gitignore guard refuses when `var/` is not ignored
    (else preflight sweeps the shadow); validate-before + re-validate-after +
    deep-compare + snapshot rollback mean an invalid or lossy write is refused
    and leaves the shadow byte-identical; the committed pack is never written
    (writes go to `var/` only, SD-34); an invalid shadow refuses dispatch rather
    than falling back (SD-4/#3).
  - **Reader-safety + no laundering**: the install publishes `pipeline.json`
    LAST via an atomic `os.replace` (briefs written first), so a concurrent
    reader never sees the shadow without a complete document — no transient
    fallback-to-committed on the success path (Codex CP1 #3); staging is built
    from the doc's own `brief_ref`s (regular files only), so stray files and
    symlinks in a pack are never carried into the shadow (#7); a
    present-but-invalid shadow is never trusted as a brief seed (#6).
  - **Tradeoffs**: bound-pipelines-only (wrapped read-only); minimap/search →
    P3c; only a rare install-time OS error (disk full mid-write) triggers a
    wholesale snapshot restore, which briefly removes+renames the shadow dir
    (acceptable — single operator, loops fleet-wide PAUSED); the document's
    `name` must equal its folder (a mismatch is refused).
  - Before merge: `gh pr view <n> --json closingIssuesReferences` to confirm the
    body closes ONLY the P3b issue (prevention-log #20). Drive every review
    comment to a terminal state; merge only via `safe_merge`; close the ticket.

---

## P3c scope marker (own plan doc when built — nothing here executes)

Deferred from P3b: **minimap** (canvas overview + viewport rect for large
graphs) and **search/filter** (jump-to-node, highlight by type/agent). Optional
follow-ons surfaced during P3b build: full brief round-trip in the view payload
(so the pane textarea seeds from server truth rather than edit-writes-only);
"reset shadow to committed" affordance (delete the shadow dir → dispatch/viewer
fall back to the pack); provenance diff (shadow-vs-committed, the config page's
`live_config_drift` analogue). New SD entry only if a decision changes.
