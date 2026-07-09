# Sequencer P3a — pipeline canvas viewer (read surface + ranked DAG + spec-sheet pane)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every role's pipeline renders as a live, auto-ranked DAG canvas at
`/pipeline` — typed edges, containers, observed lighting from the run
journal, and a schema-driven read-only property pane — with zero write
surface (editing is P3b).

**Architecture:** Three layers, matching the dashboard's existing split. (1)
`lib/pipeline.py` exports the activity-catalog SSOT (`SPEC_SHEETS`) and a
public `effective_edges(doc)` so the canvas and the walker can never
disagree. (2) A pure builder `build_pipeline_view(...)` in
`lib/dashboard_state.py` assembles doc + validation errors + last-run
lighting + in-flight state + ledger, total on every failure path. (3)
`bin/dashboard.py` serves `GET /pipeline` (new `lib/pipeline_page.html`) and
`GET /api/pipeline` — read-only, no new write endpoint. All layout ranking
happens client-side in vanilla JS from `edges_effective`.

**Tech Stack:** Python 3 stdlib; vanilla JS + inline SVG (existing page
conventions); unittest + chrome-devtools browser verify loop.

## Global Constraints

Identical to the P1/P2 plans (bash 3.2 floor, stdlib only, shellcheck-clean
incl. tests, fail-safe never fail-open, repo-agnostic, TDD, merge only via
safe_merge). Additions binding this plan:

- **Dashboard skill contract**: loopback-only server; state builders PURE
  and total (missing/corrupt artifact → degraded field, never an
  exception); every mutating button goes through `POST /api/control` — P3a
  adds NO mutations at all; new page reuses the CSS token system + the
  `setHTML` signature-guard discipline.
- **Prevention log**: #3 (no silent widening fallback — an invalid bound
  pipeline renders its ERRORS, never a healthy-looking wrap), #13 (temporal
  browser pass mandatory), #14 (any signature-guarded panel owns EVERY
  write path), #15 (an invalid doc's raw keys are surfaced as *invalid*,
  never echoed as usable config), #16 (focusable controls inside
  signature-guarded panels need the guard-interplay check).
- **Direction notes on record (#349 body, operator mockup review)**:
  property pane MUST be schema-driven from the §4 spec sheets; canvas at
  scale needs container collapse/expand; gallery/assignment bar stays
  SKELETAL and non-editable (P4).

## P3 phase decisions (locked here; P3b executes the write-side ones)

1. **P3 splits into P3a (viewer, this plan) and P3b (editor + save path,
   its own plan doc at build time)** — same sequencing style as SD-35's
   P2a/P2b split. P3a ships a complete, honest, read-only surface; nothing
   in it implies editability (no drag affordances, no enabled inputs).
2. **Spec-sheet SSOT lives in `lib/pipeline.py`** (`SPEC_SHEETS`): one dict
   covering the full v5 §4 catalog — the 13 runnable types, the 4 deferred
   types (`wait_watch`, `ask_human`, `handoff`, `run_command`), and the
   container kinds — each entry carrying `label`, `group`, `icon`,
   `required`, `optional`, `emits`, `deferred`, `guarded`. The validator's
   `NODE_TYPES` / `DEFERRED_NODE_TYPES` are DERIVED from it, so palette,
   pane, and validator cannot drift (the #349 direction note's exact
   failure mode). The pane renders required-first / optionals-collapsed /
   guarded-visible-not-editable straight from this dict as served.
3. **Honest palette**: deferred types render disabled with a "not yet
   executable (P5)" badge; container kinds `branch`/`for_each` likewise
   ("P2c+/P5"). The canvas never offers what the runner refuses.
4. **The viewer uses `load_doc` + `validate_doc` directly, NOT
   `resolve_pipeline`** — resolve raises on invalid docs (correct for
   dispatch, fail-safe), but the viewer's job is degraded TRUTH: an invalid
   bound pipeline renders its error list prominently with the raw doc
   grey-scaled, never a healthy fallback (prevention-log #3/#15). Roles
   with no `pipeline:` binding render their `wrap_role(...)` synthesized
   doc, labelled "auto-wrapped from role" — every role gets a canvas.
5. **Observed lighting sources**: last matching run line from
   `var/autonomy-logs/journal.jsonl` (per-node `outcome`/`via`/`bounce` →
   glyphs + traversed-edge highlighting; bounded tail read), and the
   in-flight `.pipeline-run-<role>[--<lane>].json` (unit statuses → a
   "running" pulse on the active unit). Both reads total: corrupt/missing
   → `null` field, viewer shows "no run yet".
6. **Auto-ranked layout, client-side**: longest-path layering over
   `edges_effective` with back-edges EXCLUDED from ranking (drawn as
   labelled arcs above the flow, mockup-style); containers box their
   contiguous children; same-rank units stack vertically. Deterministic:
   ties break by document node order. No free-form positions persisted —
   nothing to store, nothing to drift (ADF-style auto-layout per spec §7).
7. **Canvas rendering approach (from the mockup)**: DOM cards per unit +
   one absolutely-positioned SVG overlay for edges (anchors computed from
   card geometry). Full-canvas re-render only when the fetched view JSON
   changes (signature compare on the serialized payload); the SSE/poll
   tick must NOT rebuild an unchanged canvas (#174/#238 class). Selection
   state (`SEL`) survives re-render by id.
8. **Write path — LOCKED for P3b, none of it built in P3a**: UI pipeline
   edits land in a var-live shadow `var/autonomy/pipelines/<name>/` seeded
   from the committed `.autonomy/pipelines/<name>/` (SD-34's model applied
   to pipeline documents — committed pack file edits would be stash-swept
   by preflight, so a shadow is the only edit home that survives). One
   resolver in `lib/pipeline.py` (`effective_pipeline_dir(repo, name)`)
   consulted by BOTH `resolve_pipeline` and the dashboard; a
   present-but-invalid shadow is a FAILURE (refuse dispatch, render errors)
   — never a silent fallback to the committed file. Writer = whole-doc
   re-emit through a new `/api/control` action (`pipeline_save`):
   `validate_doc` before, atomic write, re-load + re-validate +
   deep-compare after, refuse-leaves-files-untouched, gitignore guard
   reused (SD-29 mechanics). Briefs save as sibling files under the same
   basename/no-traversal validation the validator already enforces.
   Editor holds a local working copy; a live tick never clobbers dirty
   edits (#202 defect-3 bar). Recorded as a new settled-decision entry
   with the P3b PR (an SD-34 extension, not a change).
9. **Gallery/assignment bar**: P3a renders a static header strip (pipeline
   name, version, `wrapped/template` provenance chip, ledger tier chip) —
   informational only. Enabled switches, triggers, run windows, Start/Stop
   all stay off this page until P4.

## File Structure

- Modify: `lib/pipeline.py` — add `SPEC_SHEETS`, derive
  `NODE_TYPES`/`DEFERRED_NODE_TYPES` from it, add public
  `effective_edges(doc)` (wraps the existing `_synth_edges` for edge-less
  docs, returns declared edges otherwise).
- Modify: `lib/dashboard_state.py` — add `build_pipeline_view(repo_path,
  role, cfg)` (+ small total helpers `_journal_last_run`,
  `_inflight_units`). Pure; no network; fixture-tested.
- Modify: `bin/dashboard.py` — `PIPELINE_PAGE` constant, `/pipeline` page
  route, `GET /api/pipeline` read route.
- Create: `lib/pipeline_page.html` — the canvas page (single file, vanilla
  JS, CSS tokens copied from the existing pages' `:root` scheme).
- Modify: `lib/dashboard_page.html` — role rows gain a small `⛓` anchor to
  `/pipeline?repo=<name>&role=<role>` (plain link, no behavior change).
- Modify: `tests/test_pipeline.py`, `tests/test_dashboard_state.py`,
  `tests/test_dashboard_server.py`.
- Modify: `tests/fixtures/repo-alpha/` — add
  `.autonomy/pipelines/fixture-flow/` (pipeline.json version 2 with a
  loop container, a failure edge, a back-edge + briefs) +
  `var/autonomy-logs/journal.jsonl` (one pass line, one fail line) so
  state tests and the browser loop light the same graph.

## Interfaces (deltas)

- `pipeline.SPEC_SHEETS: dict[str, dict]` — keys are the 17 activity types
  plus the `"loop"`/`"stage"`/`"branch"`/`"for_each"` container kinds. Entry
  shape: `{"label": str, "group": str, "icon": str, "required":
  [[field, hint], ...], "optional": [[field, hint], ...], "emits": str,
  "deferred": bool, "guarded": [str, ...]}`.
- `pipeline.effective_edges(doc) -> list[dict]` — declared edges, or the
  synthesized implicit success-chain when `doc["edges"]` is empty. Pure.
  NOTE (Codex CP1): there is NO existing `_synth_edges` helper — the
  implicit-chain synthesis lives INLINE in `start_run`
  (`lib/pipeline.py:569` region, over `_top_units`). Task 1 EXTRACTS that
  inline logic into `effective_edges` and makes `start_run` call it — a
  behaviour-preserving refactor with the untouched StateMachineTest/
  GraphWalkTest suites as the regression harness.
- `dashboard_state.build_pipeline_view(repo_path, role, cfg) -> dict`:

  ```json
  {
    "repo": "repo-alpha", "role": "engineer",
    "source": {"kind": "pipeline|wrapped", "name": "fixture-flow",
                "dir": ".autonomy/pipelines/fixture-flow", "version": 2},
    "doc": {…} ,            // or null when the dir/JSON is unreadable
    "errors": ["…"],        // validate_doc output; [] when valid
    "edges_effective": […],
    "last_run": {"run_id": "…", "outcome": "success", "pass": true,
                  "finished": "…", "nodes": [{"id": "…", "outcome": "…",
                  "via": […], "bounce": 0}], "bounces": {}},   // or null
    "in_flight": {"units": {"<id>": "pending|dispatched|success|failure|skipped"},
                   "sessions": 3},                              // or null
                   // RAW fmt-2 status vocabulary (pipeline.py uses
                   // "dispatched", not "running" -- Codex CP1); the page
                   // pulses "dispatched". Never invent display states
                   // server-side.
    "ledger": {"runs": 12, "passes": 12, "tier": "watch"}       // or null
  }
  ```

- `GET /api/pipeline?repo=<abs-path>&role=<role>` → the view dict + a
  `"spec": SPEC_SHEETS` key. `repo` is the managed repo's ABSOLUTE PATH,
  normalized `os.path.abspath(os.path.expanduser(...))` and
  identity-checked `repo not in self.repos` → 400
  `{"ok": false, "error": "repo is not managed"}` — the EXACT
  `/api/ws-prompt` contract (`bin/dashboard.py:1449-1457`); a repo NAME
  would be ambiguous across same-basename managed repos (Codex CP1).
  Unknown ROLE is a distinct, builder-level failure: 200 with
  `{"error": "unknown role: <role>"}` (the builder is total; the page
  renders the message).
- `GET /pipeline` → `lib/pipeline_page.html` via `_page_bytes` (token
  injection is no-op-safe; the page carries no `__CONTROL_TOKEN__` since
  it never POSTs).

---

### Task 1: `SPEC_SHEETS` SSOT + `effective_edges` (lib/pipeline.py)

**Files:** `lib/pipeline.py`, `tests/test_pipeline.py`

**Interfaces produced:** `pipeline.SPEC_SHEETS`,
`pipeline.effective_edges(doc)`; `NODE_TYPES` becomes a frozenset
derivation over `SPEC_SHEETS`. `DEFERRED_NODE_TYPES` is TODAY a
`dict[type -> refusal reason]` indexed by the validator at
`lib/pipeline.py:209` (Codex CP1) — it STAYS a mapping, derived as
`{k: v["deferred_reason"] for k, v in SPEC_SHEETS.items() if
v["deferred"]}`; each deferred sheet therefore carries a non-empty
`deferred_reason` (the current dict's exact strings move into the
sheets, so :209's message is byte-identical).

- [ ] **Step 1: failing tests**

```python
class SpecSheetTest(unittest.TestCase):
    def test_catalog_covers_validator_vocabulary(self):
        # the validator's accepted + deferred sets must both be DERIVED
        # from SPEC_SHEETS -- drift between palette and validator is the
        # exact failure the #349 direction note names.
        sheet_nodes = {k for k, v in pipeline.SPEC_SHEETS.items()
                       if v["group"] != "structure"}
        self.assertEqual(
            sheet_nodes,
            set(pipeline.NODE_TYPES) | set(pipeline.DEFERRED_NODE_TYPES))

    def test_deferred_flag_matches_validator(self):
        for k in pipeline.DEFERRED_NODE_TYPES:
            self.assertTrue(pipeline.SPEC_SHEETS[k]["deferred"], k)
        for k in pipeline.NODE_TYPES:
            self.assertFalse(pipeline.SPEC_SHEETS[k]["deferred"], k)

    def test_entry_shape_total(self):
        for k, v in pipeline.SPEC_SHEETS.items():
            for key in ("label", "group", "icon", "required", "optional",
                        "emits", "deferred", "guarded"):
                self.assertIn(key, v, "%s missing %s" % (k, key))

    def test_containers_present(self):
        for k in ("loop", "stage", "branch", "for_each"):
            self.assertEqual(pipeline.SPEC_SHEETS[k]["group"], "structure")

class EffectiveEdgesTest(unittest.TestCase):
    def test_declared_edges_returned_verbatim(self):
        doc = minimal_doc()
        doc["nodes"].append({"id": "b", "type": "check", "brief_ref": "act.md"})
        doc["edges"] = [{"from": "act", "to": "b", "on": "failure"}]
        self.assertEqual(pipeline.effective_edges(doc), doc["edges"])

    def test_empty_edges_synthesize_success_chain(self):
        doc = minimal_doc()
        doc["nodes"].append({"id": "b", "type": "check", "brief_ref": "act.md"})
        edges = pipeline.effective_edges(doc)
        self.assertEqual(edges, [{"from": "act", "to": "b", "on": "success"}])
```

- [ ] **Step 2: run, see fail** (`python3 -m pytest` is not in the house —
  run `python3 tests/test_pipeline.py SpecSheetTest EffectiveEdgesTest` /
  the suite's own runner; expect NameError/AttributeError).
- [ ] **Step 3: implement** — `SPEC_SHEETS` as a module-level literal:
  content transcribed from spec §4's table (required/optional columns) +
  the mockup's `SPEC`/`ICONS`/`PALETTE` dicts (labels, icons, groups:
  `source` (pick) · `work` (agent_task, plan, gather, transform) ·
  `verify` (check, subagent_review, triage) · `communicate` (summarize,
  notify, ask_human, handoff) · `ops` (git_ops, run_command, wait_watch,
  journal, housekeep) · `structure` (loop, stage, branch, for_each)).
  `guarded` lists per §4: e.g. `git_ops` → `["merge always via
  safe_merge"]`, loop/for_each → `["caps"]`, `run_command` →
  `["allowlist"]`. Then `NODE_TYPES = frozenset(k for k,v in
  SPEC_SHEETS.items() if v["group"] != "structure" and not
  v["deferred"])`, `DEFERRED_NODE_TYPES` likewise with `deferred`.
  `effective_edges(doc)`: `return doc.get("edges") or _synth_edges(doc)`.
- [ ] **Step 4: full test_pipeline suite passes** (derivation must not
  change either set's membership — the existing validator tests are the
  regression harness). **Step 5: commit.**

### Task 2: fixture pipeline + journal (repo-alpha)

**Files:** `tests/fixtures/repo-alpha/.autonomy/pipelines/fixture-flow/*`,
`tests/fixtures/repo-alpha/var/autonomy-logs/journal.jsonl`,
`tests/fixtures/repo-alpha/.autonomy/config.yaml` (bind one role)

- [ ] `pipeline.json`: version 2, nodes `pick → plan → [loop: code,test] →
  review → summarize` + `notify_park`, edges: success chain, `review →
  notify_park (on failure)`, back-edge `review → loop (failure, back,
  max_bounces 2)`, completion edges from both tails to a `journal` node;
  `caps: {max_sessions_per_run: 20, max_parallel: 2}`. Briefs: one `.md`
  per node (single line each). MUST pass `validate_doc` — assert that in
  Task 3's tests, not by hand.
- [ ] `journal.jsonl`: two lines for the bound role — an older failing run
  (review failure, `notify_park` via failure edge) and a newer passing one
  (bounce 1 recorded) so lighting shows glyphs, a red edge, and a bounce
  badge from REAL walker-shaped records (copy field shape from
  `_journal_append`, `lib/pipeline.py:829-856`).
- [ ] Bind in fixture config: `roles.engineer.pipeline: fixture-flow`.
  Leave a second role unbound (wrapped-role viewer case).
- [ ] Commit (fixture-only; green suite = nothing else reads these yet).

### Task 3: `build_pipeline_view` (pure builder)

**Files:** `lib/dashboard_state.py`, `tests/test_dashboard_state.py`

**Interfaces consumed:** Task 1's `effective_edges`, existing `load_doc`,
`validate_doc`, `wrap_role`, `ledger`. **Produces:** the view dict of the
Interfaces section, consumed verbatim by Task 4's route and Task 5's JS.

- [ ] **Step 1: failing tests**

```python
class PipelineViewTest(unittest.TestCase):
    # FIXTURE = tests/fixtures/repo-alpha, cfg parsed once in setUp
    def test_bound_role_view(self):
        v = ds.build_pipeline_view(FIXTURE, "engineer", self.cfg)
        self.assertEqual(v["source"]["kind"], "pipeline")
        self.assertEqual(v["errors"], [])
        self.assertTrue(v["edges_effective"])
        self.assertEqual(v["last_run"]["pass"], True)   # newest line wins
        self.assertIn("tier", v["ledger"])

    def test_wrapped_role_view(self):
        v = ds.build_pipeline_view(FIXTURE, "qa", self.cfg)
        self.assertEqual(v["source"]["kind"], "wrapped")
        self.assertEqual(v["errors"], [])
        # implicit chain synthesized for the canvas
        self.assertTrue(all(e["on"] == "success" for e in v["edges_effective"]))

    def test_invalid_doc_renders_errors_not_fallback(self):
        # copy fixture to tmp, corrupt pipeline.json (unknown node type),
        # assert errors non-empty AND doc still present (degraded truth,
        # prevention-log #3/#15) -- NOT a wrapped-role fallback.
        v = ds.build_pipeline_view(self.tmp_repo, "engineer", self.tmp_cfg)
        self.assertTrue(v["errors"])
        self.assertEqual(v["source"]["kind"], "pipeline")

    def test_unreadable_json_degrades(self):
        # pipeline.json replaced with junk bytes: doc None, errors states
        # unreadable, never an exception (builders are total).
        v = ds.build_pipeline_view(self.tmp_repo2, "engineer", self.tmp_cfg2)
        self.assertIsNone(v["doc"])
        self.assertTrue(v["errors"])

    def test_missing_journal_means_no_lighting(self):
        # tmp copy without journal.jsonl: last_run None, ledger None.
        v = ds.build_pipeline_view(self.tmp_repo3, "engineer", self.tmp_cfg3)
        self.assertIsNone(v["last_run"])

    def test_inflight_state_projected(self):
        # write a fmt-2 .pipeline-run-engineer.json with one running unit;
        # assert in_flight units map + sessions surface; corrupt file → None.
        ...

    def test_unknown_role_errors(self):
        v = ds.build_pipeline_view(FIXTURE, "ghost", self.cfg)
        self.assertIn("error", v)
```

  (Write the elided in-flight body in full at implementation time — shape
  it exactly like the corrupt-artifact tests around
  `test_dashboard_state.py`'s existing degraded cases.)

- [ ] **Step 2: fail.** **Step 3: implement** — builder assembles per the
  Interfaces dict: role settings via `roles.role_settings(cfg, role)`
  (`lib/roles.py:829` — NOT raw `cfg["roles"]`, which would lose
  default/degradation semantics and wrongly fail roles the supervisor
  happily dispatches; Codex CP1); bound → `load_doc` + `validate_doc`
  (both inside try/except → degraded fields); unbound → `wrap_role` (kind
  `wrapped`); `_journal_last_run(journal_path, role, name)` = bounded
  tail read (last 64 KiB), iterate parsed lines REVERSED — newest FIRST —
  and return the first match (Codex CP1: forward iteration returns the
  OLDEST), total; `_inflight_units(logdir, role)` = total JSON read of
  `.pipeline-run-<role>*.json` projecting the RAW fmt-2 unit statuses
  (`dispatched`, never a synthesized `running`); `ledger(...)` call
  wrapped total. Import pipeline lazily the way dashboard_state imports
  its other lib siblings (hot-reload friendly, #166).
- [ ] **Step 4: pass. Step 5: commit.**

### Task 4: server routes (`/pipeline` page + `GET /api/pipeline`)

**Files:** `bin/dashboard.py`, `tests/test_dashboard_server.py`,
`lib/pipeline_page.html` (placeholder shell this task; full page Task 5)

- [ ] Tests (the fail-safe edges are the point — Codex CP1):
  `GET /api/pipeline?repo=<fixture-abs-path>&role=engineer` → 200 JSON
  with `doc`+`spec` keys; unmanaged repo path → 400
  `{"ok": false, "error": "repo is not managed"}`; unknown role → 200
  `{"error": "unknown role: ghost"}`; corrupt `pipeline.json` (tmp copy,
  junk bytes) → 200 with `doc: null` + non-empty `errors`; invalid bound
  doc (unknown node type) → 200 with `doc` present + non-empty `errors`;
  `GET /pipeline` → 200 `text/html`. Follow `test_dashboard_server.py`'s
  existing route-test harness (spin the handler against the fixture repo
  set, same as `/api/ws-prompt`'s tests).
- [ ] Implement: `PIPELINE_PAGE` constant beside `PAGE`/`CONFIG_PAGE`
  (`bin/dashboard.py:252-253`); `do_GET` branches at the `:1428` route
  block and the `:1436` API block — repo param normalized
  `os.path.abspath(os.path.expanduser(...))` and identity-checked
  `repo not in self.repos` → 400 (copy `/api/ws-prompt`'s block,
  `:1449-1457`, verbatim), then `ds.build_pipeline_view(repo, role, cfg)`
  merged with `"spec": pipeline.SPEC_SHEETS`. Placeholder page = header
  plus "canvas lands in the next commit" (keeps the route testable before
  the JS lands).
- [ ] Suite green, commit.

### Task 5: the canvas page (`lib/pipeline_page.html`)

**Files:** `lib/pipeline_page.html`, `lib/dashboard_page.html` (role-row
`⛓` link)

No unit harness reaches the JS — the browser verify loop is this task's
oracle (Task 6). Build in the mockup's shape
(`docs/superpowers/mockups/2026-07-08-dag-canvas-mockup.html`), replacing
its hand-coded segments with computed ranks:

- [ ] **Shell + tokens**: reuse the shared token scheme — start from
  `config_page.html`'s `:root`/`[data-theme]` block and assert PARITY with
  `dashboard_page.html`'s (the two are identical today; if drift is found,
  surface it, don't fork a third scheme — Codex CP1). Status colours use
  the existing status-token classes, no new colour vocabulary. Three-pane
  grid `palette | canvas | pane` +
  header strip (name, version, provenance chip `wrapped/pipeline`, ledger
  tier chip, `⚡ last run` toggle — decision 9's skeletal gallery).
- [ ] **Data flow**: on load, `fetch /api/pipeline` with `repo`/`role`
  from `location.search`; re-fetch every 5 s; re-render ONLY when
  `JSON.stringify(payload)` differs from the last render's signature
  (decision 7; #174/#238 class). A repo/role picker populated from one
  `/api/state` fetch.
- [ ] **Rank layout** (pure function, decision 6):

```js
function rankUnits(units, edges){            // units: ordered top-level ids
  const known = new Set(units);              // degraded-truth guard (Codex
  // CP1): an invalid doc can carry edges to unknown ids -- rank what is
  // rankable, list the rest in the error banner, never NaN/crash.
  const fwd = edges.filter(e => !e.back && known.has(e.from) && known.has(e.to));
  const rank = {}; units.forEach(u => rank[u] = 0);
  for (let pass = 0; pass < units.length; pass++){
    let moved = false;
    for (const e of fwd){
      if (rank[e.to] < rank[e.from] + 1){ rank[e.to] = rank[e.from] + 1; moved = true; }
    }
    if (!moved) break;                       // longest-path layering, O(V·E) cap
  }
  const cols = [];                           // rank -> ids, document order kept
  units.forEach(u => { (cols[rank[u]] = cols[rank[u]] || []).push(u); });
  return cols;
}
```

  Top-level units = nodes not inside any container + container ids
  (mirrors the walker's `_top_units`); containers render as boxes with
  their children laid out left-to-right INSIDE the box (P1 array order —
  the walker's own internal flow).
- [ ] **Edges**: single SVG overlay, anchors from card geometry
  (mockup's `anchor`/`drawEdges` approach); colour by `on`
  (green/red/grey-dashed); back-edges as labelled arcs (`↩ max 2`)
  excluded from ranking; click-to-inspect only (NO cycle-on-click — that
  is a P3b edit gesture, decision 1).
- [ ] **Observed lighting**: toggle overlays `last_run` — per-node ✓/✕
  glyph, non-traversed units/edges dimmed, `bounce` badge; `in_flight`
  (when present) pulses the running unit. No run → toggle disabled with
  "no runs recorded".
- [ ] **Property pane, schema-driven** (decision 2): on select, render
  from `spec[node.type]` — required rows first (marked ●, values read
  from the node's TOP-LEVEL keys: `brief_ref`/`legacy_prompt`, `runs_as`,
  `context`, `join` — validated docs have no `config` sub-object (Codex
  CP1) — or `— unset`), optionals in a collapsed `<details>`,
  `guarded` rows with a lock glyph, `emits` footer. Container pane shows
  kind/caps/exit_when. Everything read-only (`disabled` semantics —
  values are text, not inputs). Doc-level `errors` render as a red pane
  banner listing every validator string (decision 4). A node whose `type`
  is NOT in `spec` (invalid doc) gets a fallback INVALID sheet — raw
  key/value dump under a red "unknown type" header (prevention-log #15:
  surfaced as invalid, never echoed as usable; and never a
  `spec[undefined]` crash — Codex CP1).
- [ ] **Palette** (left rail): groups from `SPEC_SHEETS`, deferred/unbuilt
  entries greyed with their badge (decision 3); clicking previews the
  type's spec sheet in the pane (mockup's `previewType`) — no drag.
- [ ] **Container collapse/expand** (direction note): a box-header chevron
  collapses the box to a single chip card (client-side only, state kept in
  a `Set` by container id, survives re-render).
- [ ] **Dashboard link**: role rows in `dashboard_page.html` gain
  `<a class="mut" href="/pipeline?repo=…&role=…">⛓</a>` next to the
  existing per-role chips — `repo` is the repo's ABSOLUTE PATH (already
  in the state payload as `path`), both params through
  `encodeURIComponent` (Codex CP1: names are ambiguous, raw paths break
  on special chars).
- [ ] Commit.

### Task 6: browser verify loop + gates + PR

- [ ] Browser loop per the dashboard skill: fixture server on 8790;
  `/pipeline?repo=repo-alpha&role=engineer` — snapshot asserts palette
  groups, ranked cards, container box, red failure edge, back-edge arc;
  toggle lighting → glyphs + dimming; select node → pane required-first
  rows; wrapped role (`qa`) renders the auto-wrap chain; corrupt-doc tmp
  repo renders the error banner; console ZERO errors; temporal pass
  (steadyStateCLS < 0.01, canvas innerHTML stable across ticks on an
  unchanged fixture, rebuilds ≤ 1).
- [ ] run_all + shellcheck + pre-flight-review + Codex CP2 on the diff.
- [ ] PR body: security model (read-only surface — two GET routes; repo
  resolved by name against the server's registry, role charset-validated
  by the existing roles regime, NO new write path, no token exposure on
  the new page since it never POSTs; path traversal impossible — the
  builder derives paths from config, not query input beyond the
  name-match); tradeoffs (viewer-not-editor split, auto-layout only,
  lighting from last run only — history scrubbing deferred).
- [ ] Review comments to terminal states; safe_merge; close the P3a
  ticket.

---

## P3b scope marker (own plan doc when built — nothing here executes)

Editor + save path per locked decision 8: `effective_pipeline_dir`
resolver + var-shadow seed/write in `lib/pipeline.py`; `pipeline_save`
control action (validate → atomic → re-load-compare, gitignore guard,
256 KiB body cap per the `ws_prompt_set` precedent); pane fields become
inputs (schema-driven editability: required/optional free, guarded locked,
dangerous-with-friction per §4); palette drag-to-rank, edge draw +
click-to-cycle + delete; brief text editing (sibling-basename validation);
dirty working copy + explicit Save + unsaved badge (#202 bar). Minimap +
search land with P3b (or split to P3c if the diff runs long). New SD entry
recorded with that PR.
