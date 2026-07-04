# Design-blockers resolution — 2026-07-04 evening session

> Status: **operator-approved** (2026-07-04, interactive session; 11 decisions taken via
> structured question rounds after four parallel research briefs over the full design-blocked
> backlog). This doc is the record; each affected ticket carries a pointer comment. Settled
> decisions 27–32 (docs/settled-decisions.md) bind the durable rules.

## 1. Guardrail authorization (#255, #192, #211-structural)

The unattended loop stays hard-barred from `bin/safe_merge.sh` + `.github/workflows/**`.
**Attended sessions are authorized** to build the three fully-specified fixes: #255
(done-everywhere checklist inside safe_merge, per settled decision 26), #192 (one doc-only
predicate for bot + merge gate), and the structural half of #211 (subsumed by decision 3 below).
Authorization is standing for attended work on these named tickets, not a general unbar.

## 2. Roles #14/#15 — closed as superseded

The live roles.py substrate ships both duties (pm cron 6h; researcher nightly on local-llm).
Managed-Agents variants remain build-when-wanted (API-credit spend), tracked by #83's umbrella,
not by open tickets.

## 3. Config persistence — split by nature (settles #211's fork, gates #87)

- **Structural truth** (`roles:` block, `merge_gate.*`): UI authoring produces a **real commit on
  a branch + PR through the normal gate**. The org's own change control applies to its own
  config; committed config.yaml remains the single source of structural truth. No overlay for
  structure, ever.
- **Operational knobs** (model/effort override, board display keys): stay in the untracked
  `var/` overlay exactly as shipped (#202/#218).
- #211's remaining `merge_gate.*` half is therefore NOT "wire the overlay into safe_merge" — it
  is part of #87's commit-PR authoring path.

## 4. Config writer strategy (#87 W3a)

**Full `roles:` block re-emit**: parse → mutate dict → re-serialize the whole block; validate via
`lib/roles.py` AND re-parse the emitted text and compare dicts before writing; refuse on any
mismatch. In-block comments do not survive (accepted cost, recorded here). No byte-splice writer.

## 5. Agent entities (#83 IA) — global registry

New index file `~/.config/autonomy/agents` (same conventions as accounts/credentials: stdlib
JSON, mode 600, atomic writes, names/kinds/labels only — never secrets): agent name → account,
model+effort defaults, rail reference, description. **Bindings stay in each repo's `roles:`
block** (repo-agnostic invariant untouched); a binding references the agent by name and carries
the per-binding rules (trigger, scope labels, lane, gate participation, budget). Dangling
references degrade to a doctor WARNING + the binding renders with an ⚠ unknown-agent badge —
never silently dropped, never fail-open. The config page presents the agent-centric view (agent
card → bindings list → per-binding rules); #191's reskin implements this IA.

## 6. Onboarding board offer (#90) — clarifies settled decision 24

SD-24's "Projects boards are never auto-created" forbids **automation**, not an explicit
operator-clicked offer. Onboarding/config UI may OFFER one-click board creation when config
names a missing board; creation happens only on the click. Scaffold `board.project_title` stays
EMPTY (SD-24 unchanged).

## 7. Phase track (#187) — Slice A approved; Slice B sourced

- **Slice A:** three segment treatments — SOLID (observed: branch created, PR opened, review
  verdict, merged — only milestones honestly timestamped from existing `git`/`focus_ticket`
  data), OUTLINE (configured gate chain from `merge_gate_chain`, shipped), DOTTED (prompt-phases
  only when detected from rail working-order markers), EMPTY (no evidence). CSS to be authored
  against these semantics (border=outline, dashed=dotted per the mockup's idiom); hover =
  milestone timestamps. Degrade-to-truth acceptance cases: no-CI-yet, custom pack, QA session,
  idle lane.
- **Slice B (sources settled now):** board-write milestones from **board.sh's own transition
  log**; tests-ran (red/green) from **parsing session-log gate runs**. Both engine-owned
  artifacts; no gh dependency. Loop may build B immediately after A with no further operator
  round.
- #190 (compare tiles) unblocks when Slice A ships.

## 8. Escalation-comment schema (#89 → #189) — pinned, not invented

The PM question contract (redesign spec §PM question contract) IS the schema. An escalating role
posts ONE issue comment containing a fenced `autonomy-question` JSON block with exactly:
`question` (string) · `recommendation` (string) · `reasoning_quote` (string) · `effort_sunk`
(string) · `default_if_ignored` (string) · `answers` (array ≤3 of chip strings). Anything else
in the comment is prose garnish. #189's triaged renderer parses exactly this block;
absence/garbage degrades to the shipped untriaged card (#235). This section is the prose #89's
spec required; W5 rail work proceeds against it.

## 9. Health architecture (#81)

- **Truth:** new `lib/health.py`, stdlib-only, pure/fixture-testable; the dashboard imports it,
  `./start status` consumes it via a `python3 -c` shim. One implementation, zero drift (same
  shape as the #117 lock-path unification).
- **Wedged rule:** a WORKING session whose newest session-log/heartbeat write is older than a
  threshold is wedged; default **15 minutes**, configurable (`health.wedged_after` or similar).
  Engine-owned artifacts only — no process introspection.
- **Dashboard runner:** `bin/console.py` is **blessed as the sanctioned dashboard manager**
  (relaunch-on-exit supervision, one-dashboard consolidation). Document in README + dashboard
  skill; health strip reports its supervision; no launchd dashboard service (a second manager
  recreates tonight's port-fight class).

## 10. Downstream tickets given direction (specs still to be written per-ticket)

- **#154 workflow templates:** portable data under `templates/workflows/<name>/` (roles.yaml +
  rails); `onboard --workflow <name>`; clone-from-repo; export-to-template. Builds on decisions
  3/4/5.
- **#88 chat-driven config:** NL → proposed roles.py-validated diff → shown → applied on confirm
  through the SAME commit-PR path as decision 3 (never a direct write, never repo actions).
- **#147 remainder:** per-lane lifecycle controls ride the UI-2 icon-cluster pattern already
  shipped; no new fork.

## Decision order honoured

Guardrail authorization + closures first (most tickets freed), then persistence/registry (the
config chain), then phase-track, then health. Fake forks (already answered by settled decisions
or shipped code) were closed as such rather than re-asked: #89 schema, #14/#15 substrate, #147
spec, #255/#192 semantics.
