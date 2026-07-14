# ADF-grade UI — design spec (epic)

**Status:** proposed — brainstormed + Codex-reviewed + self-reviewed 2026-07-14.
**Scope:** re-architect the `studio/` web app into an Azure Data Factory-grade
authoring/monitoring UI on Fluent UI v9, over the existing (working) MVP engine.
**Boundary (corrected after Codex review):** **no engine *execution-semantics*
changes.** Read-only API additions / read-models ARE allowed where the UI needs a
projection (see "Server read-models"). The original "no server changes at all" claim
was wrong — U10/U11/U12 need read models.

## Why

The MVP is engine-first: event-sourced runs, the `${}` expression language, typed
edges/containers/`call_pipeline`, immutable versions, and a live WS monitor all work
and are gated. The **UI is deliberately basic** — flat hash-router sidebar, plain
tables, minimal canvas. North star: "**ADF for AI work**" — the operator wants the
surface to match ADF's flow, feel, and navigation (hub rail, expanding panes, activity
toolbox, properties panel, expression builder, live run visualisation).

## Locked decisions (brainstorming 2026-07-14)

1. **Nav = full ADF hub model** — thin left icon rail (**Home / Author / Monitor /
   Manage**); each hub swaps the workspace + its own collapsible/resizable secondary pane.
2. **Design system = Fluent UI v9** (`@fluentui/react-components`, MIT). Light + dark day one.
3. **Build order = Shell → Author → Monitor → Manage.** First milestone = Shell (U1–U3).

## Concept mapping

| ADF | studio |
| --- | --- |
| Author (canvas, Factory Resources) | Pipelines + versions + canvas + activity catalog |
| Monitor (runs, gantt, drill-in) | Runs + live event stream + node-state overlay |
| Manage (linked services, triggers) | Connections + Triggers (+ Settings) |
| Home | overview / recent / shortcuts |

## Engine capabilities we build on (present today)

- Typed `params`/`outputs`; `${params.x}`/`${nodes.id.output}`/`${run.field}` with
  **save-time whole-doc ref-validation** (`validateRefs`/`validateDoc`, pure, shared).
  NOTE: it returns **plain-string** errors over the whole doc, not per-token structured
  diagnostics — see U8a/U8b.
- Typed edges `on: success|failure|completion`, join all/any, skip propagation,
  containers, back-edges w/ bounce caps, `call_pipeline`.
- Immutable `PipelineVersion` (save = new version); triggers bind a version.
- `run_events` append log + WS live tail (P6a/b).
- Catalog: `http_request` (has adapter), `llm_call`, `agent_task` (palette shows all;
  llm/agent adapters land with engine work).

## Server read-models (the ONLY backend work — read-only, no semantics change)

- **R1 `GET /api/runs/:id/detail` → `{ run, pipelineVersion, events }`** — powers U11
  (resolve the authored graph for a finished/live run in one call, ownership via the
  run's pipeline; avoids a version-by-id + waterfall). Runs today store only
  `pipelineVersionId`, and version APIs are pipeline-scoped only.
- **R2 `GET /api/runs` returns `RunSummary`** (or `?include=names`) — pipeline name,
  version #, trigger name, duration, status — so U10 needn't N+1.
- **R3 (deferred, gates U8b)** structured validation diagnostics: `validateRefs`/
  `validateDoc` return `{ nodeId, path, code, message }` instead of plain strings.
  Until then U8a uses whole-doc validation + a node-level issue list.

## The Shell (U1–U3, after the U0 spike)

```text
┌────┬───────────────────┬──────────────────────────────────────┐
│ 🏠 │ ‹secondary pane›   │  ‹command bar›  Validate   Save(→v)   │
│ ✏️ │ Factory Resources  ├──────────────────────────────────────┤
│ 📊 │ 🔎 filter      + ⋯ │           WORKSPACE                   │
│ 🧰 │ ▾ Pipelines        │      (canvas / monitor / forms)       │
│ ⚙  │ «collapse          │                                       │
└────┴───────────────────┴──────────────────────────────────────┘
```

- Hub rail (~48px) Home/Author/Monitor/Manage + theme + settings; active highlight.
- Secondary pane: resizable + collapsible; per-hub content.
- Command bar: breadcrumb + context actions. **NOTE:** no ADF "Publish" draft/live
  split — our model is **Save = new immutable version**. Command bar says **Save**, not
  Publish (label reconciled).
- Workspace: hub surface.
- **Router:** replace the primitive string-match router with **`react-router`
  `createHashRouter`** (keeps static-serve hash URLs) — nested per-hub routes, params,
  default children, breadcrumbs. **URL state** (in the hash): hub, entity id, run id,
  version id, selected node id, monitor filter tab. **Local UI state** (zustand
  `uiStore`): pane width/collapse, theme. Separate from `canvasStore` + run-overlay store.

## Author hub

- **U4** Factory Resources pane — pipelines tree, search, +New, rename/delete/clone.
- **U5** Activities toolbox — searchable, categorized palette of the full catalog; drag-drop.
- **U6 (SPLIT):**
  - **U6a** typed-edge styling/labels (green success / red failure / blue completion) + branch picker.
  - **U6b** multiple handles / typed ports + connection validation on connect.
  - **U6c** container group rendering from existing `containers`.
  - **U6d** container create/edit/drag-membership.
  - **U6e** back-edge rendering/editing + bounce config.
- **U7** Properties panel (bottom dock, tabbed) — per-activity forms + connection picker.
- **U8 (SPLIT):**
  - **U8a** insert references/functions flyout + run whole-doc shared validation on the
    canvas + node-level issue list (uses today's plain-string validation).
  - **U8b** structured per-token diagnostics + inline badges (**gated on R3**).
- **U9** Command bar — Validate all, Save = new version, zoom/fit/auto-layout.
- Data flow: canvas edits → `canvasStore` → serialize `PipelineDoc` → `POST /pipelines/:id/versions`.

## Monitor hub

- **U10** Monitor shell + runs list (Fluent DataGrid, **client-side small-data v1**):
  columns pipeline/status/start/duration/trigger via **R2**. Filter tabs are concrete,
  backed by current data: **All / Triggered / Manual / Child** (NOT an invented
  pipeline-vs-trigger-runs split).
- **U11** Run detail = authored graph with **live node-state overlay** (via **R1**);
  nodes light up running/success/failure; handles nodes that never dispatched
  (doc-driven "not-run" vs the event-driven activity). Plus the existing event feed.
- **U12 (SPLIT):**
  - **U12a** attempt timeline from existing events (`dispatched→terminal`), documented limits.
  - **U12b (deferred)** true run timeline (queued/waiting/skipped/container/child-run
    timing) — needs event/read-model additions; only if U12a proves insufficient.

## Manage hub (SPLIT by resource + form complexity)

- **U13a** Connections list + delete/enable.
- **U13b** Connection create/edit per-kind forms (http/anthropic/openai/ollama/agent) +
  encrypted secret entry (never shown again).
- **U14a** Triggers list + bind-to-version + enable/disable.
- **U14b** Schedule/recurrence builder (schedule mode) + webhook config.
- **U14c** Advanced policy: run-windows + concurrency.
- **U15** Home hub (overview/recent/shortcuts) + Settings (theme, master-key status).

## Ticket decomposition (~24, ordered; each ≈ one loop fire)

| # | Ticket | Phase |
|---|--------|-------|
| **U0** | **Fluent v9 × React Flow integration spike** (theming reaches canvas, z-index/portal policy, dark mode, focus, bundle output) | **Spike** |
| U1 | Fluent integration + light/dark theming + token→canvas CSS-var map | Shell |
| U2 | Hub rail + `react-router createHashRouter` + `uiStore` + URL-state design | Shell |
| U3 | Collapsible/resizable secondary pane + command bar | Shell |
| U3r | Route-compat: old `#/connections…` redirect to hub routes (+ tests) | Shell |
| U4 | Factory Resources pane (pipelines tree + CRUD) | Author |
| U5 | Activities toolbox (searchable, categorized) + drag-drop | Author |
| U6a | Typed-edge styling/labels + branch picker | Author |
| U6b | Typed ports / multi-handle + connection validation | Author |
| U6c | Container group rendering | Author |
| U6d | Container create/edit/drag-membership | Author |
| U6e | Back-edge rendering/editing + bounce config | Author |
| U7 | Node properties panel (tabbed, per-activity, conn picker) | Author |
| U8a | Expression insert flyout + whole-doc validation + node issue list | Author |
| U8b | Structured per-token diagnostics + badges (gated on R3) | Author |
| U9 | Command bar: validate-all, save-as-version, zoom/fit/layout | Author |
| R1 | `GET /api/runs/:id/detail` read-model | Server |
| R2 | `RunSummary` run-list (names + duration) | Server |
| U10 | Monitor shell + runs DataGrid (concrete filter tabs) | Monitor |
| U11 | Run detail: live node overlay on the graph (via R1) | Monitor |
| U12a | Attempt timeline from events (documented limits) | Monitor |
| U13a | Connections list | Manage |
| U13b | Connection create/edit per-kind + secret entry | Manage |
| U14a | Triggers list + bind + enable/disable | Manage |
| U14b | Schedule/recurrence builder + webhook | Manage |
| U14c | Run-windows + concurrency policy | Manage |
| U15 | Home hub + Settings | Manage |
| R3 + U8b | (deferred) structured diagnostics | later |
| U12b | (deferred) true timeline model | later |

## Cross-cutting (elevated by Codex review)

- **Verification is mandatory and browser-level.** The loop's gate (lint/typecheck/
  unit/review-bot) is BLIND to rendered UI — the morning's "shipped but looked hollow"
  trap. Every UI ticket adds **Playwright** coverage (shell nav, drag-drop, edge
  connect, node select, pane resize, **flyout positioning inside a zoomed/panned
  canvas**, run overlay). Studio CI runs it headless. **Protect the P5c canvas
  drag-reconciliation as a regression invariant** — U6* must not remount nodes / break
  measured-position stability (add regression checks before U6a).
- **Z-index / portal policy** (define before panels/flyouts): canvas-local overlays use
  React Flow `Panel`; global menus/flyouts portal to body with an explicit z-index token
  scale. Test inside a zoomed/panned canvas.
- **Theme coverage:** map Fluent tokens → React Flow node/edge/control/minimap/selection
  colors via CSS vars; dark-mode snapshots.
- **Accessibility acceptance criteria per shell/canvas ticket:** `aria-current`, named
  icon buttons, keyboard-operable splitter, focus restoration for panes/flyouts, visible
  focus rings, reduced motion, **non-color status labels**, DataGrid keyboard nav.
- **Bundle budget** after U1; **named Fluent icon imports** only.
- **Bound "ADF-grade" per milestone** with concrete visual acceptance criteria (shell
  dimensions, interaction behavior, dark mode, hub routes, canvas statuses, screenshots)
  — else fidelity is an unbounded requirement.
- **Non-breaking:** build the shell alongside; migrate pages into hubs; MVP never breaks
  between merges; `studio` CI stays green.

## Non-goals (YAGNI)

- No engine/reducer *semantics* changes (read-only read-models R1/R2 allowed).
- No auth/login UI (fixed local principal).
- No git-integration hub, integration-runtimes, debug-mode breakpoints, multi-user.
- No ADF "Publish/draft" split — save = immutable version.

## Loop integration

The autonomous loop follows its `prompt.md` **work-order**, not the issue list. To build
this epic the supervisor **appends the U0→U15 order to `prompt.md`** (position vs P7 =
operator's call) and adds a **Playwright/browser-verify gate** to the per-phase
discipline for UI tickets. Each ticket = one fire (branch→TDD→review→PR→gate→merge).

## Resolved by Codex review (were open questions)

- Routing: adopt `react-router` hash router (not hand-rolled nesting). ✔
- Fluent×RF: needs the U0 spike + explicit z-index/portal policy. ✔
- U11: needs R1 run-detail read-model (not a bare version-by-id). ✔
- Gantt: split U12a (approx) / U12b (true, deferred). ✔
- U6/U8 sizing: split into U6a–e, U8a/U8b. ✔
- Verification: Playwright mandatory; protect P5c canvas invariant. ✔
