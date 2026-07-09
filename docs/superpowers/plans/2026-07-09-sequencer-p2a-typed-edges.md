# Sequencer P2a — typed edges, failure paths, back-edges (sequential walk) (#349)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The pipeline document's `edges` become real: typed dependency edges
(success/failure/completion) drive a graph walk with skip propagation, branch
verdicts steer labeled paths, and back-edges return work upstream under an
ENFORCED bounce cap — all on the sequential one-node-per-iteration walk
(SD-12 unchanged; operator split decision 2026-07-09, SD-35).

**Architecture:** All changes live in `lib/pipeline.py` + tests + the starter
template — `bin/supervisor.sh` is untouched (it already drives
`start`/`next`/`record` and is graph-agnostic). The P1 array-order walk is
subsumed: a doc with `edges: []` synthesizes its implicit success-chain at
load, so ONE walk engine serves P1 docs, wrapped roles, and P2a graphs
identically (BEHAVIOUR-compat proven by the non-lifted P1 test suite; state
files change format by design — fmt 2).

**Tech Stack:** Python 3 stdlib; existing unittest + bash harnesses.

## Global Constraints

Identical to the P1 plan (bash 3.2 floor, stdlib only, shellcheck-clean incl.
tests, fail-safe never fail-open, repo-agnostic, SD-12/13/33, prevention-log
#1/#2/#3/#6/#12/#17/#18, TDD, merge only via safe_merge). Additions:

- **SD-35 (this PR adds the entry):** P2 split — P2a ships typed edges +
  failure paths + back-edges on the SEQUENTIAL walk; real bounded parallel
  dispatch (and the SD-12 amendment enabling it) is P2b. Parallel-eligible
  nodes INTERLEAVE one per iteration in P2a; S33's overlap oracle is
  deliberately deferred and the docs say so.
- Every P1 test keeps passing UNMODIFIED except where a test asserted a
  P1-only refusal that P2a lifts (those tests flip to asserting the new
  acceptance + the remaining refusals).

## P2a semantic decisions (locked)

1. **Edges connect top-level units**: node ids not inside any container, and
   container ids. `to: <container>` enters at its first child; `from:
   <container>` fires on the container's completion (loop: exit/cap; stage:
   last child). Children INSIDE a container keep P1's contiguous array-order
   internal flow — intra-container edges are rejected (P2b+).
2. **Implicit chain synthesis**: `edges: []` (P1 docs, wrapped roles) →
   loader synthesizes `on: success` edges between consecutive top-level
   units. One walk engine; zero behaviour change for existing docs.
3. **Dependency-outcome vs session-outcome**: a node's dependency outcome is
   its session outcome (success/error→failure) unless the session wrote a
   valid verdict file with `{"outcome": "success"|"failure"}` — the branch
   mechanism (v4's two-way labeled paths: the reference "plan viable?" maps
   viable→success, too-vague→failure). `{"exit": bool}` keeps its P1 loop
   meaning; both keys may coexist. Total reader: junk → session outcome.
4. **Edge states**: each edge is `open` (from not terminal yet), `satisfied`
   (on-success ⇢ from=success; on-failure ⇢ from=failure; on-completion ⇢
   from terminal success|failure), or `dead` (from terminal/skipped and the
   condition can never hold; a SKIPPED `from` deadens ALL its outgoing
   edges — completion means "ran either way", skipped never ran).
5. **Join semantics — per unit (Codex CP1 correction)**: `"join": "all"`
   (default) | `"any"`. join=all: ready when EVERY incoming edge is
   satisfied; skipped the moment ANY incoming edge is dead (strict fan-in —
   S33's both-must-succeed). join=any: ready when NO incoming edge is open
   and ≥1 is satisfied (waits for full resolution — deterministic); skipped
   only when ALL incoming edges are dead (the OR-join — "journal after
   success OR park"). Roots (no incoming) are ready at start. Sequential
   pick: first ready unit in document order. Without join=any,
   mutually-exclusive branches could never reconverge — the AND-only model
   self-contradicted on its own reference template.
6. **Unhandled failure fails the run** (v5 §6): a failure-terminal node is
   HANDLED iff ≥1 of its outgoing on-failure/on-completion edges ends
   SATISFIED **and that edge's target reached a terminal ran-state**
   (success|failure; a skipped target does not count — edge presence is
   not traversal, Codex CP1). Any unhandled failure at walk end = run
   `failure`.
7. **Back-edges are declared and TRAVERSAL-ONLY** (adversarial-review
   blocking fix): `{"from", "to", "on", "back": true, "max_bounces": 1..9}`
   — target MUST be a loop or stage container id AND an ANCESTOR of the
   from-node via non-back edges (validator-enforced; a "forward" back:true
   edge would be invisible to the DAG check and stall the walk). Back-edges
   are IGNORED by `_edge_state`/`_ready`/`_propagate_skips` as incoming
   edges — they never gate readiness (else the target waits forever on its
   own downstream verdict: deadlock, then rule 8 completes a never-run
   graph as success = fail-open). They fire only at traversal time from the
   from-side. Excluded from the acyclicity check (everything else must be a
   DAG);
   traversal increments the edge's bounce counter, RESETS the target
   container's internal state (loop rounds start fresh — each entry earns
   max_rounds again; the global `max_sessions_per_run` remains the hard
   floor under the whole run), and re-pends the container + ALL units
   (transitively) downstream of it via non-back edges, clearing their UNIT
   statuses only — `nodes_done` is APPEND-ONLY session history (repeat
   visits append fresh entries carrying `"bounce": n`; one journal line per
   RUN, never per bounce — Codex CP1); bounce counters and `sessions`
   survive, and both survive a state-file reload between the bounce and the
   next dispatch (tested).
   Cap exceeded → run outcome `capped` (S29: parks for a human).
6b. **Container-level outcomes (adversarial-review blocking fix)** — P1's
   finish-the-RUN reflexes generalise to finish-the-CONTAINER so its edges
   can fire:
   - child session ERROR → the container is FAILURE-terminal at that point
     (remaining children never run; its on-failure/on-completion edges
     fire; rule 6 decides the run).
   - loop verdict-exit → SUCCESS-terminal.
   - loop max_rounds exhausted without exit → FAILURE-terminal **carrying a
     `capped` marker** (mapping a cap to success would declare the exit
     condition met without evidence — fail-open). If that failure ends the
     run UNHANDLED, the run outcome is `capped` (P1's exact string and
     S28's semantics survive for implicit-chain docs); a failure edge may
     CONSUME it (the back-edge/park path) and the walk continues.
   - stage: last child success → SUCCESS-terminal.
   - `max_sessions_per_run` stays a RUN-level cap: finishes the whole run
     `capped` regardless of edges (the global runaway floor, unchanged).
8. **Run completes** when nothing is ready and nothing pending can become
   ready: outcome = `failure` if any unhandled failure (rule 6), `capped`
   when the unhandled failure carries the cap marker, else `success`
   (skipped units are fine).
9. **Journal enrichment**: node entries gain `"via"` (the satisfied incoming
   edge kinds), `"bounce"` on repeat visits, and `"verdict_outcome"` when a
   verdict override fired; the run record gains
   `"bounces": {"<from>-><to>": n}`.
9b. **`join` joins the schema**: node/container key (`_NODE_KEYS`/
   `_CONTAINER_KEYS` grow `"join"`), enum all|any, validated; the mockup's
   pane gains it in a later doc pass (P3 concern, noted not built here).
10. **Still refused (honestly)**: branch/for_each container kinds,
    intra-container edges, `context: own`, wait_watch/ask_human/handoff/
    run_command types, multi-node pipelines on cron/event roles (P2b lifts
    with the dispatch work), edge `when:` labels beyond the two-way
    verdict mapping.

## File Structure

- Modify: `lib/pipeline.py` (validator lifts + graph walk; the linear
  cursor `idx` is REPLACED by a status map — state format version bumps to
  `"fmt": 2`; a fmt-less (P1) in-flight state file REFUSES with a clear
  message naming the file — never silently reinterpreted; loops are paused
  fleet-wide so no live state exists).
- Modify: `tests/test_pipeline.py` (new GraphWalkTest, BackEdgeTest,
  VerdictOutcomeTest classes; P1 classes updated only where refusals lift).
- Modify: `templates/autonomy-pack/pipelines/ticket-to-merge/` →
  `pipeline.json` version 2 with real edges (QA-check failure edges →
  notify+park; verdict back-edge → coding loop, max_bounces 3; completion
  edges → journal) + new briefs `notify-park.md`, `journal-run.md` +
  README update.
- Modify: `docs/settled-decisions.md` (SD-35).
- Modify: `CLAUDE.md` backlog line (P2a in flight) — optional, skip if noisy.

## Interfaces (deltas)

- `validate_doc(doc, pipeline_dir=None)` — accepts non-empty `edges` per the
  rules above; new error strings for: unknown endpoint, intra-container
  endpoint, bad `on`, non-DAG (excluding back-edges), back-edge without
  `max_bounces`/target-not-container, duplicate edge id pairs.
- `_synth_edges(doc) -> list` — the implicit chain (internal).
- `_load_state` — refuses `fmt != 2` with "in-flight run state predates the
  graph walk — remove <path> to recover".
- `start_run` — state gains `"fmt": 2`, `"units": {id: {"status":
  "pending", ...}}`, `"bounces": {}`; drops `"idx"`.
- `next_node(state_path, brief_out, journal_path="")` — returns the first
  READY unit's current node (for a container: its next internal child by P1
  rules) or finishes per rule 8. Same CLI shape.
- `record_outcome(...)` — after the P1-style node record: resolve the
  unit's dependency outcome (verdict override), mark terminal, fire edges,
  propagate skips, traverse back-edges (bounce/cap/reset), decide
  CONTINUE/DONE per rule 8. Same CLI shape.
- Verdict file: `{"exit": bool}` and/or `{"outcome": "success"|"failure"}`.

---

### Task 1: SD-35 + validator lifts (edges accepted, graph-checked)

**Files:** `docs/settled-decisions.md`, `lib/pipeline.py`, `tests/test_pipeline.py`

- [ ] **Step 1: failing tests** — replace `test_nonempty_edges_rejected_p1`
  with the acceptance matrix:

```python
class EdgeValidationTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        with open(os.path.join(self.dir, "act.md"), "w") as fh:
            fh.write("do\n")

    def _doc(self, edges, containers=None, extra_nodes=()):
        doc = minimal_doc()
        for nid in ("b", "c") + tuple(extra_nodes):
            doc["nodes"].append({"id": nid, "type": "check", "brief_ref": "act.md"})
        doc["edges"] = edges
        if containers is not None:
            doc["containers"] = containers
        return doc

    def test_typed_edges_accepted(self):
        edges = [{"from": "act", "to": "b", "on": "success"},
                 {"from": "act", "to": "c", "on": "failure"},
                 {"from": "b", "to": "c", "on": "completion"}]
        self.assertEqual(pipeline.validate_doc(self._doc(edges), self.dir), [])

    def test_unknown_endpoint_rejected(self):
        edges = [{"from": "act", "to": "ghost", "on": "success"}]
        self.assertTrue(pipeline.validate_doc(self._doc(edges), self.dir))

    def test_bad_on_rejected(self):
        edges = [{"from": "act", "to": "b", "on": "sometimes"}]
        self.assertTrue(pipeline.validate_doc(self._doc(edges), self.dir))

    def test_cycle_without_back_flag_rejected(self):
        edges = [{"from": "act", "to": "b", "on": "success"},
                 {"from": "b", "to": "act", "on": "success"}]
        errs = pipeline.validate_doc(self._doc(edges), self.dir)
        self.assertTrue(any("cycle" in e for e in errs))

    def test_back_edge_requires_container_target_and_cap(self):
        con = [{"id": "L", "kind": "loop", "children": ["b"],
                "exit_when": "done", "max_rounds": 3}]
        ok = [{"from": "act", "to": "L", "on": "success"},
              {"from": "c", "to": "L", "on": "failure", "back": True,
               "max_bounces": 3},
              {"from": "L", "to": "c", "on": "success"}]
        self.assertEqual(pipeline.validate_doc(self._doc(ok, con), self.dir), [])
        no_cap = [dict(ok[1])]; del no_cap[0]["max_bounces"]
        errs = pipeline.validate_doc(
            self._doc([ok[0], no_cap[0], ok[2]], con), self.dir)
        self.assertTrue(any("max_bounces" in e for e in errs))
        to_node = [{"from": "c", "to": "act", "on": "failure", "back": True,
                    "max_bounces": 2}]
        errs = pipeline.validate_doc(self._doc(ok[:1] + to_node + ok[2:], con), self.dir)
        self.assertTrue(any("loop or stage" in e for e in errs))

    def test_forward_back_edge_rejected(self):
        # a back:true edge whose target is NOT an ancestor of its from-node
        # is invisible to the DAG check and would stall the walk -- refuse.
        con = [{"id": "L", "kind": "loop", "children": ["c"],
                "exit_when": "done", "max_rounds": 3}]
        edges = [{"from": "act", "to": "b", "on": "success"},
                 {"from": "act", "to": "L", "on": "failure", "back": True,
                  "max_bounces": 2}]
        errs = pipeline.validate_doc(self._doc(edges, con), self.dir)
        self.assertTrue(any("ancestor" in e for e in errs))

    def test_intra_container_edge_rejected(self):
        con = [{"id": "L", "kind": "loop", "children": ["b", "c"],
                "exit_when": "done", "max_rounds": 3}]
        edges = [{"from": "b", "to": "c", "on": "success"}]
        errs = pipeline.validate_doc(self._doc(edges, con), self.dir)
        self.assertTrue(any("inside" in e for e in errs))

    def test_container_endpoints_accepted(self):
        con = [{"id": "L", "kind": "loop", "children": ["b"],
                "exit_when": "done", "max_rounds": 3}]
        edges = [{"from": "act", "to": "L", "on": "success"},
                 {"from": "L", "to": "c", "on": "success"}]
        self.assertEqual(pipeline.validate_doc(self._doc(edges, con), self.dir), [])
```

- [ ] **Step 2: run, see fail** (`test_nonempty_edges_rejected_p1` deleted in
  the same commit — its refusal is the thing P2a ships).
- [ ] **Step 3: implement** — in `validate_doc`: edge shape checks
  (`_EDGE_KEYS = {"from","to","on","back","max_bounces"}`, unknown-key
  refusal like nodes), endpoint resolution against top-level unit ids
  (nodes-not-in-containers ∪ container ids), `on` enum, intra-container
  endpoint refusal, `back: true` ⇒ `max_bounces` int 1..9 + `to` is a
  loop/stage id, Kahn topological check over non-back edges → "cycle
  detected involving <ids> — declare a back-edge (back: true + max_bounces)
  or break the cycle". Keep the P1 message for `edges` only when the shape
  is not a list.
- [ ] **Step 4: pass.** **Step 5:** add SD-35 to `docs/settled-decisions.md`
  (operator split decision, one paragraph, origin: #349 comment
  2026-07-09). **Step 6: commit.**

### Task 2: graph walk — units map, readiness, skip propagation

**Files:** `lib/pipeline.py`, `tests/test_pipeline.py`

- [ ] **Step 1: failing tests**:

```python
class GraphWalkTest(unittest.TestCase):
    # setUp like StateMachineTest (repo + pdir "flow" + briefs a-e.md + loop_prompt)
    def _graph_doc(self):
        return {"name": "flow", "version": 3,
                "caps": {"max_sessions_per_run": 10},
                "nodes": [
                    {"id": "a", "type": "pick", "brief_ref": "a.md"},
                    {"id": "b", "type": "check", "brief_ref": "b.md"},
                    {"id": "ok", "type": "summarize", "brief_ref": "c.md"},
                    {"id": "bad", "type": "notify", "brief_ref": "d.md"},
                    {"id": "always", "type": "journal", "brief_ref": "e.md",
                     "join": "any"}],
                "edges": [
                    {"from": "a", "to": "b", "on": "success"},
                    {"from": "b", "to": "ok", "on": "success"},
                    {"from": "b", "to": "bad", "on": "failure"},
                    {"from": "ok", "to": "always", "on": "completion"},
                    {"from": "bad", "to": "always", "on": "completion"}],
                "containers": []}

    def test_success_path_skips_failure_lane(self):
        # a ok, b ok -> ok runs, bad SKIPPED, always runs (completion from ok)
        ...walk: next/record success for a, b, ok, always; assert the picks
        are exactly a,b,ok,always in order; DONE success; journal nodes list
        marks bad as skipped...

    def test_failure_edge_consumes_failure(self):
        # b errors -> bad runs (failure edge), ok skipped, always runs,
        # run outcome SUCCESS (the failure was handled -- rule 6)
        ...

    def test_unhandled_failure_fails_run(self):
        # a errors (no failure edge from a) -> everything downstream skips,
        # DONE failure
        ...

    def test_completion_does_not_fire_from_skipped(self):
        # variant doc where always hangs ONLY off ok via completion; b errors
        # -> ok skipped -> always skipped -> run failure? no: b's failure is
        # consumed by bad... build the minimal shape asserting skipped units
        # never fire completion edges.
        ...

    def test_p1_linear_docs_walk_identically(self):
        # the P1 three-node doc (edges []) walks a->b->c exactly as before
        # (already covered by the untouched StateMachineTest -- this test
        # asserts the synthesized chain is what the state carries)
        ...
```

(Write the elided bodies in full at implementation time — each is
next/record drive loops asserting pick order, statuses in the state file,
and the DONE line; the pattern is StateMachineTest's `_run_round`.)

- [ ] **Step 2: fail.** **Step 3: implement**:
  - `_top_units(doc)` → ordered top-level unit ids; `_unit_of(doc, id)`.
  - `_synth_edges(doc)` at resolve time (stored into the state's embedded
    doc so resume is stable).
  - `start_run`: `"fmt": 2`, `"units": {uid: {"status": "pending"}}`,
    `"container_pos": {}` (per-container internal cursor), `"bounces": {}`.
  - `_edge_state(edge, units)` → `satisfied | dead | open`.
  - `_ready(doc, state)` → first unit in doc order, status pending, no
    incoming open/dead-blocking edges (all satisfied).
  - `_propagate_skips(doc, state)` → fixpoint: pending unit with any dead
    incoming edge and no satisfiable alternative → skipped (P2a rule: ALL
    incoming edges must be satisfied, so ONE dead edge = skipped).
  - `next_node`: refuse fmt≠2; find ready unit; container → internal child
    via `container_pos` (P1 loop machinery keyed per container); node →
    compile/legacy exactly as P1.
  - `record_outcome`: record node entry (P1 shape + `via`); if the unit is
    a container mid-flight → advance `container_pos`/rounds (P1 logic)
    and only mark the UNIT terminal when the container completes; else
    resolve dependency outcome (Task 3 hook, session outcome for now),
    mark terminal, `_propagate_skips`, check rule-8 completion.
- [ ] **Step 4: pass; every NON-LIFTED P1 test passes untouched** (the
  behaviour-compat gate: only tests asserting refusals P2a deliberately
  lifts may change, each named in the commit message; state-file BYTES
  differ by design — fmt 2). **Step 5: commit.**

### Task 3: verdict outcome channel (branch semantics)

- [ ] Tests: a node whose session succeeds but verdict file says
  `{"outcome": "failure"}` fires its failure edge (and vice versa); junk
  verdict → session outcome; `{"exit": true, "outcome": "success"}` in one
  file serves a loop's last child; journal entry carries
  `verdict_outcome`. Implement `_read_verdict_full(path) -> dict` (total),
  wire into `record_outcome`'s dependency-outcome resolution. Commit.

### Task 4: back-edges — bounce caps, container reset, container outcomes

- [ ] Tests (BackEdgeTest + ContainerOutcomeTest): the reference shape —
  loop L, then check `verdict`, back-edge `verdict → L (failure,
  max_bounces 2)`, success → `done` node:
  (0) **back-edge never gates readiness**: at run start L is READY despite
  the open back-edge (the blocking-fix regression test);
  (1) verdict failure → L re-pends with rounds reset, walk re-runs L then
  verdict (bounce 1 recorded in state + journal, repeat `nodes_done`
  entries carry `"bounce": 1`);
  (2) cap exceeded → run ends per rule 6/8 (verdict's failure unhandled
  once the back-edge is exhausted → `DONE failure`), journal `bounces` map;
  (3) downstream `done` re-pends on bounce (unit status cleared,
  `nodes_done` append-only);
  (4) sessions counter SURVIVES bounces + a state-file reload between
  bounce and next dispatch; `max_sessions_per_run` still caps the run;
  (5) **container outcomes** (decision 6b): child error inside L →
  L failure-terminal → its on-failure edge fires (run continues, not
  auto-failed); loop cap-exit → L failure-terminal w/ cap marker →
  no failure edge → `DONE capped` (P1 string preserved, existing
  test_loop_verdict_garbage_is_no_exit stays green); cap-exit WITH a
  consuming failure edge → walk continues.
  Implement `_traverse_back_edge` + container terminal mapping per
  decisions 6b/7. Commit.

### Task 5: template v2 + README + docs

- [ ] ticket-to-merge `pipeline.json` version 2. **The QA stage container is
  DISSOLVED** (Codex CP1: its children need failure edges, and
  intra-container edges are rejected by this plan's own rule — stage+edges
  composition is P2b); the three QA checks become top-level nodes each
  pinning `runs_as: {"agent-ish": qa}` equivalents via `runs_as` model
  fields, exactly the "pin it even outside the stage" affordance the
  mockup's pane shows. Shape: explicit success chain pick → plan → coding
  loop → open-pr → qa-gather → [verify, breakage, review as a fan
  (success edges from qa-gather)] → `qa-verdict` (join=all over the three
  checks' success edges; verdict brief emits `{"outcome"}`) · failure
  edges `verify/breakage/review → notify-park` (join=any, new node +
  brief) · back-edge `qa-verdict → coding (on failure, back: true,
  max_bounces 3)` · `qa-verdict → summarize (on success)` ·
  completion edges `summarize → journal-run` and `notify-park →
  journal-run` (join=any, new node + brief). Merge stays OUT (safe_merge
  owns it). Template validates; README updates the P1-subset notes
  (failure paths + back-edge now real; parallel ranks still INTERLEAVE
  one node-session per iteration until P2b — say so; stage+edges = P2b).
- [ ] StarterTemplateTest asserts version 2, an edge with `back: true`,
  and a `"join": "any"` node.
- [ ] Commit.

### Task 6: gates + PR

- [ ] run_all + shellcheck + pre-flight-review (settled decisions: SD-35
  rides this PR; prevention log #3/#12/#18 re-checked on the new walk) +
  Codex CP2 on the diff. PR body: security model (no new argv surface —
  edge fields are ids validated by the same charset regime; verdict file
  still agent-writable data steering only labeled paths, never scope);
  conscious tradeoffs (S33 overlap deferred to P2b per SD-35; back-edge
  re-pend clears downstream terminals — simple, safe, costs re-runs).
  Drive review to terminal states; safe_merge.
