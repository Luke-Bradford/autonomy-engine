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
| | **AS BUILT (2026-07-25):** port IDENTITY + connect-time validation + per-condition arrowheads. The multi-handle SET is **U19**'s (per-outcome source ports, which that row already owns) — doing it here would have built the same thing twice. | |
| U6c | Container group rendering | Author |
| | **AS BUILT (2026-07-29):** derived boxes + the container-BOUNDARY connect rule U6b deferred here. A derived node must STATE `measured`+`handles` or React Flow drops every edge touching it. The box HINTS at membership; RF `parentId` subflows (**U23**) are what would make enclosure authoritative. | |
| U6d | Container create/edit/drag-membership | Author |
| | **AS BUILT (2026-07-31):** CREATE + membership only, through one `<select>` on the NODE (a container cannot be RF-`selectable`). Config editing and drag-membership are U23's. This ticket WARNS rather than refuses — refusing a boundary-crossing edit would make containerising an already-wired `a → b` impossible, and a membership edit is reversible by the same control. | |
| U6e | Back-edge rendering/editing + bounce config | Author |
| | **AS BUILT (2026-07-31):** AUTHORING + bounce config; RENDERING deliberately deferred. The refusal panel now OFFERS "Make it a back-edge" where the back shape is legal, and `EdgePanel` edits `maxBounces`. A back-edge still PAINTS like a forward one: the two free channels were both spent or reserved — `skipped` owns the dash and a back-edge may legally BE `skipped`, and a sixth `edge-variant-*` would break `EDGE_VARIANTS`' `Edge['on']` typing, its marker defs and `palette.test.ts`'s exact-match guard. Back-ness is carried in the LABEL (`↺ success ×10`) + aria-label, plus a style-less `.edge-back` hook for U19 to paint through. Two further deferrals: `backEdgeDefect` is a second reader of `validateDoc`'s three rules rather than its SSOT (inverting that dependency rewrites the save gate's error strings — **#847**); container membership edits are still not back-edge aware (**#848**); and the offer's gate answers about the EDGE's topology only, so authoring the first back-edge can still invalidate an unrelated `${nodes.x.status}` ref via the `canReRunNodes` flip — warned by the validation badge, reversible by deleting the edge, per U6d's reversible-consequence rule. | |
| U7 | Node properties panel (tabbed, per-activity, conn picker) | Author |
| | **AS BUILT (2026-08-01):** the per-activity FORMS only (the connection picker pre-dated this row). The bottom-dock TABBED layout is deferred as polish — **#852**, and it should agree one dock with **#844** rather than build two. Fields are DERIVED from each activity's own Zod `configSchema` (`pages/pipeline/configForm.ts`), not from hand-written metadata on `ActivityCatalogEntry`: the schema is already the SSOT for the authored shape, so a parallel field list would be a third copy free to drift, and a new activity now gets a form for free. Constructs with no typed control (record, array-of-object, union, `unknown`) degrade to a per-key JSON control; a non-object-rooted schema degrades the whole node to the JSON editor. Three properties are load-bearing and each is mutation-proven: an apply MERGES over the stored config, so `config.outputs` and any key an imported doc carries survive (`z.object` STRIPS unknown keys, so a parse output must never be stored); a stored value its control cannot round-trip forces the JSON editor rather than corrupting on open — including a string array a one-per-line control would trim, split or drop; and an empty REQUIRED text field writes `''` rather than omitting the key, because `file_write.content` is a bare `z.string()` and omitting it would bar the exit on a node opened to edit the path. The local `configSchema.safeParse` is a UX pre-check only — several activities' schemas are palette metadata whose real gate is `validateDoc`. | |
| U8a | Expression insert flyout + whole-doc validation + node issue list | Author |
| U8b | Structured per-token diagnostics + badges (gated on R3) | Author |
| U9 | Command bar: validate-all, save-as-version, zoom/fit/layout | Author |
| R1 | `GET /api/runs/:id/detail` read-model | Server |
| | **AS BUILT (2026-07-31):** shipped as `{ run, pipelineVersion }` — the `events` member of the sketch was deliberately NOT built. The page already receives the complete log over the WebSocket (`useRunStream` replays from `seq` 0 before tailing), so a second full copy per page load would have had no reader. The consequence is paid where it bites: the overlay is WS-fed, so it withholds itself (with a reason on screen) rather than drawing an unprojected graph. Ownership is the RUN's and transitive by FK; a version missing for an extant run is a violated DB invariant (`onDelete: 'restrict'`), so it 500s rather than laundering into the ownership 404. | |
| R2 | `RunSummary` run-list (names + duration) | Server |
| | **AS BUILT (2026-08-01):** `GET /api/runs` returns `RunSummary` = the `Run` row + `pipelineName` + `pipelineVersion` (the NUMBER) + `triggerName`, via `runs ⋈ pipeline_versions ⋈ pipelines` with a LEFT join to `triggers`. The LEFT is load-bearing: a rerun sets `triggerId = null` deliberately and `trigger_id` is `onDelete: 'set null'`, so an INNER join would drop those runs from the operator's own list, indistinguishably from having none. **DURATION is deliberately not a field** — `startedAt`/`finishedAt` already determine it, and a server-stamped elapsed for a running run is stale on serialization; the client derives it (`formatRunDuration`), which also owns the rule that a `queued` run shows an em-dash rather than its enqueue-placeholder `started_at`. `pipelineId` was dropped from the contract for want of a consumer (U26's row→pipeline link can add it). Rows are newest-first, `started_at DESC, rowid DESC` — `rowid`, not `id`, because run ids are random nanoids and a lexical tie-break would make "newest-first" arbitrary exactly at the tie. MEASURED: on the production path the owner filter wins the index and the sort is a temp b-tree, so `runs_started_at_idx` is NOT what backs this order — acceptable at U10's small-data scale, and stated rather than assumed. The shape change is additive, so any reader still parsing with `RunSchema` survives. | |
| U10 | Monitor shell + runs DataGrid (concrete filter tabs) | Monitor |
| | **AS BUILT (2026-08-01):** the spec's columns (pipeline/status/start/duration/trigger) + the spec's origin tabs **All / Triggered / Manual / Child**, filtered CLIENT-side per "small-data v1". Three things beyond the bare row, each because this ticket already owned them: the tab lives in the URL (`?tab=`, the Shell section's "monitor filter tab (U10)" slot) so a filtered view is linkable and Back undoes it, with `all` expressed by the param's absence; the row action became a real `<Link>` (the Shell section names U10 as the owner of that conversion); and the strip is Fluent's own `TabList`, not hand-rolled buttons, which brings the roving tabindex + arrow keys the `tab` role advertises. The **Fluent DataGrid was NOT adopted** — the existing `<table>` carries the same columns, and swapping the grid component is presentation with no capability behind it. Two honesty notes carried on the tabs' `title`: **Child is empty today** (every production `createRun` passes `parentRunId: null`; the `call_pipeline` spawn seam is P3b — **#796**) and it is pre-wired rather than populated; and **Manual is not "runs I started"** — firing a trigger by hand still stamps `triggerId`, so Manual is the trigger-less set, which today means reruns. The **Finished column was dropped** (the spec's column set omits it, and Started + Duration determine it); its timestamp is demoted to the Duration cell's `title` rather than lost. Status filtering stays **U26**'s. | |
| U11 | Run detail: live node overlay on the graph (via R1) | Monitor |
| | **AS BUILT (2026-07-31):** the authored graph is drawn on the run page with the ENGINE's own node/container status over it, from a SEPARATE handler-free `RunCanvas` rather than a `readOnly` `FlowCanvas` (see the section below for why that alternative is wrong, not merely inelegant). Nodes that never dispatched are visible for the first time. The doc-free table + event feed are kept beneath it unchanged. Deferred: the per-node drill-in is U24's, the child-run drill U20's, and the page's three-folds-per-frame cost **#849**. | |
| U12a | Attempt timeline from events (documented limits) | Monitor |
| U13a | Connections list | Manage |
| U13b | Connection create/edit per-kind + secret entry | Manage |
| U14a | Triggers list + bind + enable/disable | Manage |
| U14b | Schedule/recurrence builder + webhook | Manage |
| U14c | Run-windows + concurrency policy | Manage |
| U15 | Home hub + Settings | Manage |
| **U16** | **Params/Variables/Outputs/Globals AUTHORING** (T14) — the bottom-pane tab to *define* what the `${}` flyout references; routed through `toVersionBody` (currently discards them) | Author | — PARAMS + OUTPUTS **AS BUILT** below (in the property panel, not a bottom pane); variables/globals have no doc schema and stay deferred |
| **U17** | **Undo/redo** (T14) — reversible-command store; land EARLY (before U6*) | Author |
| **U18** | **Save-vs-Publish reconciliation** (T14) — command-bar states: DB-only `Save→v` vs git-connected `Save/Commit→branch` + `Publish→active` + CAS-stale "pull first"; Manage **Git** section | Author/Manage |
| **U19** | **Outcome-by-source-handle** (T14) — colored/labeled handles per ActivityDefinition (operational success/failure/completion/skipped; control `true/false`/case), NOT the retro dropdown. **Its three inherited #1 F1 debts were DISCHARGED by U6a** (2026-07-25), which landed first: `skipped` is authorable, a persisted value the source does not offer renders as a disabled `<option>` instead of silently showing another, and a branch edge is labelled by its routing key rather than the literal `"branch"`. What remains for U19 is the shape change itself — retiring the dropdown for per-outcome SOURCE HANDLES — plus the one open question U6a deliberately left it: whether `declaredBranchesOf` moves from `engine/params.ts` onto `ActivityDefinition` (it cannot be a plain data field — a `switch`'s labels derive from `node.config.cases`). | Author |
| **U20** | **`call_pipeline` authoring** (T14) — target-pipeline picker + param-map + call-graph validation + Monitor child-run drill | Author/Monitor |
| **U21** | copy/paste + multi-select + marquee + group move/delete (T14) | Author |
| **U22** | version-history / picker (open/compare/restore; trigger bind-to-version) (T14) | Author/Manage |
| **U23** | container-config forms (loop `exitWhen`/`timeout`; foreach `items`/`batchCount`; bounce caps) + domain-container↔RF-parentId mapping + drag-into-container drop mechanics (T14) | Author |
| | **AS BUILT (2026-08-01, part 1 only):** the CONFIG FORM. Reached by a ⚙ on the box — the container's third opt-in to hit-testing beside the ✕ and the edge handles — because `selectable: false` must hold and so a container can never be reached through React Flow's selection. `Selection` gains a third kind that RF does not drive, which is why `onPaneClick` had to be added: nothing else can clear it. Controls are DERIVED twice — `deriveConfigFields(ContainerSchema)` for the list and types (U7's engine, so `assembleConfig`'s preserve-unowned-keys rule comes free), and a new `CONTAINER_CONFIG_FIELDS` for which of them this KIND may carry, exported from `engine/params.ts` beside the `is only meaningful on` refusals that are its only authority and pinned to them in both directions by a test. A field ILLEGAL for the kind is rendered anyway when the doc carries one, so clearing it is the repair; that is reachable through exactly one combination, `stage`+`maxRounds`, because the server's write gate refuses every other — the validator hole that makes it possible is **#859**. **Part 3 SHIPPED 2026-08-01 (#883):** the ordinal is DRAWN on the box, and with it the ✕/⚙ names, the delete confirmation, the group's accessible name and `connectRules`' boundary refusals — so "loop 2" now names one rectangle everywhere it is said. **The run graph followed on 2026-08-01 (#886)** — its box draws the same ordinal and announces it, closing the last holdout. Deferred: drag-into-container and the RF `parentId` mapping (part 2), editing `kind` after create, and #839's last sub-item — whether emptying a `loop` should OFFER "delete this loop?" inline (raised by #748). That last one is deliberately not decided here: `deleteContainer` already makes the state escapable, so it is a prompt-design question rather than a hole, and it belongs with part 2's drop mechanics where emptying a container becomes a common gesture rather than a rare one. | Author |
| **U24** | **Activity drill-in panel** (T13) — per-node input/output/error+kind/attempts/duration/prompt+completion(redacted)/tool-calls/cost. **Carries a KNOWN REGRESSION from #1 F0:** the executor used to string-format the kind into `error` (`"rate_limit: boom"`), so the Monitor incidentally showed it in the node table (`RunDetailPage`) and the event feed (`runs/format.ts::eventGloss`). F0 correctly made the kind a FIELD (`node.failed.kind`/`.code`) and the message raw, so BOTH surfaces now show only `"boom"`. The data is durable in the event log and needs no migration — U24 must surface `kind`/`code` (and `eventGloss` should `push('kind')`/`push('code')`; ~2 lines). Deferred out of F0 only because a rendered-output change needs the browser-verify gate. | Monitor |
| **U25** | Monitor status-enum + R2 reconciled with S6 (`queued`/`waiting`+reason/`skipped`); waiting/retrying overlay states (T13) | Monitor |
| **U26** | filter pane (status/pipeline/time-range server-side/annotation/trigger) + trigger-runs + tumbling-window views (T13) | Monitor |
| **U27** | cost column + per-run/rollup consumption surface + completeness flag (T13) | Monitor |
| **U28** | cancel-run/cancel-activity (T13) + **rerun-distinct render** (copied-vs-executed frontier, RS6) + rerun-history grouping | Monitor |
| **U29** | cross-run Gantt (group by pipeline/annotation) (T13) | Monitor |
| **R3** | (deferred) structured validation diagnostics → node-level issue mapping (U8b) | Server |
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

## Spike-hardened — U0 Fluent v9 × React Flow (validated in a real browser, 2026-07-14)

**Green light:** Fluent v9 (`@fluentui/react-components`) + `@xyflow/react` v12 coexist with ZERO
console errors; the headline risk — a Fluent `Popover`/`Menu` opened FROM a canvas node under
zoom+pan — **anchors correctly** (Floating UI reads the live transform, portals to `document.body`).
Bounded punch-list the epic MUST specify:
- **U0 must deliver an `--xy-*` → Fluent-token THEME BRIDGE stylesheet** — the single biggest miss.
  Theming the Fluent app does NOT theme React Flow's own chrome: in dark mode the **Controls, MiniMap,
  and edge-label backgrounds stay WHITE** (RF drives them off its own `--xy-controls-*`/`--xy-minimap-*`/
  `--xy-edge-label-*` vars, defaulting light). Map them from Fluent tokens under both themes.
- **U1: `FluentProvider` is the theme SSOT** — one `data-theme` toggle drives BOTH the Fluent theme AND
  the `--xy-*` vars. Shell layout needs explicit `grid-template-rows` (RF needs an explicitly-sized parent).
- **U1/U6: render menus/flyouts via Fluent's DEFAULT portal (to body); NEVER reparent a surface into
  the RF viewport** (`.react-flow__viewport`) — that double-applies the transform. Add `nodrag`/`nowheel`
  to interactive in-node controls so gestures aren't hijacked.
- **U6/perf: budget + code-split Fluent** — `+64 kB gzip` in ONE un-split chunk from the barrel import;
  use subpath imports + `manualChunks` for `@fluentui/*`+`@griffel/*`. Note: Griffel emits NO build-time
  CSS (runtime `<head>` injection) → any CSP/SSR work targets `createDOMRenderer`/`nonce`, not a CSS file.
- **Env note:** the workspace is **React 19** (not 18); Fluent v9's peer range satisfies it.

## U2 — URL-state design (AS BUILT, 2026-07-24)

The route tree lives in `packages/web/src/routes.tsx`; the rail's hub list is the SSOT in
`packages/web/src/shell/hubs.ts`. `react-router@8` `createHashRouter`, kept HASH-based so the
P7 single-container Fastify static route still needs no history-API fallback.

| Route | Renders |
|---|---|
| `#/` | Home hub (placeholder until U15) |
| `#/author` | index redirect (`replace`) → `#/author/pipelines` |
| `#/author/pipelines` | Pipelines list |
| `#/monitor` | index redirect (`replace`) → `#/monitor/runs` |
| `#/monitor/runs` | Runs list |
| `#/monitor/runs/:runId` | Run detail (live monitor) |
| `#/manage` | index redirect (`replace`) → `#/manage/connections` |
| `#/manage/connections` | Connections |
| `#/manage/triggers` | Triggers |
| `#/*` | catch-all → `#/` (an unknown path, once the U3r legacy paths below have had their turn) |

### U3r — legacy MVP-path compatibility (AS BUILT, 2026-07-24)

The MVP's flat route space still resolves. `LEGACY_REDIRECTS` in `routes.tsx` is the SSOT for the
static hops; `#/runs/:runId` needs a component because it carries state.

| Legacy path | Redirects to |
|---|---|
| `#/connections` | `#/manage/connections` |
| `#/pipelines` | `#/author/pipelines` |
| `#/triggers` | `#/manage/triggers` |
| `#/runs` | `#/monitor/runs` |
| `#/runs/:runId` | `#/monitor/runs/:runId` — **id preserved** |

- **`#/` is deliberately NOT redirected.** The MVP rendered Connections at `/`; `/` is now the Home
  hub. Honouring the old default would break Home for everyone to humour a stale bookmark.
- **All legacy redirects `replace`.** Same history-trap reasoning as the hub indexes — a pushed
  redirect leaves the dead URL in history, so Back returns to it and is bounced forward again.
- **The run id is RE-ENCODED on the way through.** `useParams` returns it decoded and react-router
  does not re-encode a string `to`, so interpolating the raw param would ship a half-decoded path
  that `RunDetailRoute` then decodes a SECOND time. Pinned by a test whose id (`run%20x`) is not
  idempotent under an extra decode; a plain id would let the bug through.
- **Ordering before the catch-all is readability only** — react-router RANKS matches, so `*` loses
  to a concrete path wherever it sits. The tests, not the ordering, are the guarantee.
- **Query strings are not preserved.** The pre-U2 router treated the whole hash as the path, so
  `#/runs?x=1` never matched `/runs` in the MVP either; nothing regresses.
- The compatibility layer is exactly three things — the `LEGACY_REDIRECTS` table, the routes built
  from it at the bottom of `ROUTES`, and the `LegacyRunRedirect` component — so **retiring** it once
  the window for old bookmarks has closed is a small, findable job.

Decisions worth not re-deriving:

- **Hub indexes redirect with `replace`, never push.** A pushed redirect makes Back land on the
  bare hub path and bounce straight forward again — a history trap. Pinned by a unit test and an
  e2e test; both fail if `replace` is dropped.
- **The rail's active state has ONE source: `NavLink`'s `isActive`.** It already sets
  `aria-current`, and its matching is exactly what the rail needs (`/` matches only itself, a
  deep child keeps its hub lit, matching is on a segment boundary so `/authoring` cannot light
  `/author`). A parallel path-matching helper was written, found inert by a mutation check, and
  deleted — it could only ever become a second opinion that disagrees.
- **Active state is signalled on three non-colour channels** (`aria-current`, the filled icon
  variant, a left accent bar), per the spec's non-colour-status criterion.
- **`useParams` decodes params; the route wrapper must NOT decode again.** `RunDetailRoute` also
  renders the page with `key={runId}` so a run→run navigation REMOUNTS — React Router reuses a
  component instance when only a param changes, and the page holds per-run stream state.
- **The workspace element keeps the `content` class.** `index.css` hangs the page padding, the
  900px reading cap, and `:has(.canvas-page)` (which removes that cap for the full-bleed canvas)
  off it. Renaming it silently re-caps the canvas, and jsdom cannot see it.
- **Fluent portals duplicate the provider class.** Any portalling surface (the rail's tooltips are
  the first) creates a `[data-portal-node]` mount under `<body>` carrying `app-fluent-root`. That
  is desirable — it is why portalled flyouts are themed and why the `--xy-*` bridge reaches them —
  but a bare `.app-fluent-root` selector now matches two elements. e2e specs use
  `FLUENT_ROOT` (`:not([data-portal-node])`) for the DOM and `BRIDGE_SELECTOR` for CSSOM rules.

- **Known, accepted:** re-clicking the hub you are already inside leaves a duplicate adjacent
  history entry, so Back appears to do nothing once. `Link` only auto-replaces when the target
  equals the current path — from `#/monitor/runs`, the rail targets `/monitor`, which PUSHES, and
  the index redirect then REPLACEs it back to `#/monitor/runs`. Fixing it means giving the rail a
  second path matcher to decide `replace`, which is exactly the duplicate source of truth deleted
  above; not worth it for one dead Back press. Revisit if U3's breadcrumb needs the matcher anyway.
- **Run ids are `encodeURIComponent`d into the path.** Today's ids are `run_` + a nanoid, whose
  alphabet is URL-safe, so this is a no-op — it exists so the encode/decode pair is symmetric if the
  alphabet ever widens. U3r made this a shared `runDetailPath()` helper: it added a third builder
  (`LegacyRunRedirect`) alongside `RunsPage` and `TriggersPage`, and three copies of an invariant
  that only bites on ids nobody mints yet is exactly the kind that drifts unnoticed.
  Note react-router uses `%2F` as an internal sentinel, so a literal `/` inside an id would still
  not round-trip; ids must stay path-safe.
- **Navigation idiom.** In-app links that a user might want to open in a new tab or copy use
  `<Link>`. `useNavigate()` on a `<button>` is only for navigating as the *result* of an action
  (the Runs grid's Watch button, "Watch live" after firing a trigger) — those were migrated 1:1
  from the deleted `router.ts` and are deliberately left alone here; **U10** owns turning the runs
  grid's row action into a real link.

URL-state slots named in the Shell section but NOT yet in the hash, with their owning ticket:
version id (**U22**), selected node id (**U7**), monitor filter tab (**U10**). The pipeline id
(`#/author/pipelines/:pipelineId`) landed in **U4** — see that section below.

Deliberately NOT in U2, from its own ticket row and the Shell description:

- **The rail's settings entry** (`#/settings`) — the Shell section lists the rail as
  "theme + settings", but the Settings surface is **U15**. U2 ships the theme control only.
- **`uiStore` is untouched.** The U2 row names it, but U1 already added the theme slice and the
  pane width/collapse state it would otherwise hold belongs to **U3**. No second consumer exists
  yet, so the store stays a singleton with prop injection rather than moving behind a context.
- **Legacy MVP-path redirects** — **U3r**, now BUILT (see the U3r section above), which is why it
  landed immediately after U2 and before U3: until it did, an old bookmark hit the catch-all and
  landed on Home, and `#/runs/:id` lost the run id rather than resolving to that run.

## U3 — secondary pane + command bar (AS BUILT, 2026-07-25)

The shell is now the spec diagram's four zones. `AppShell` is the ONLY consumer of
`useMatches()`; every other part takes what it needs as props, so each is unit-testable
without a data router.

```text
.app-shell  grid-template-columns: 48px  auto  auto   1fr
                                    rail  pane  split  workspace
                                          │            └ .workspace grid-template-rows: auto 1fr
                                          │              (command bar / .content, the scroller)
                                          └ .secondary-pane { width: var(--pane-width, 240px) }
```

Note where the width is: on the **pane element**, not in the track template. Every child
names its own `grid-column`.

| Piece | Where | Notes |
|---|---|---|
| Pane width + collapse | `uiStore` (`autonomy-studio.pane`) | one JSON record, clamped 180–480, default 240 |
| Which hub am I in | route `handle: { hub }` → `activeHubId()` | drives the pane's contents |
| Breadcrumb | route `handle: { crumb }` → `crumbsFrom()` | hub AND section crumb labels come from `HUBS` |
| Pane sections | `HUBS[].sections` | SSOT for the pane's links AND the section crumb labels |

Decisions worth not re-deriving:

- **Route `handle` + `useMatches()` is the SSOT, and it is NOT the matcher U2 deleted.**
  This closes the "revisit if U3's breadcrumb needs the matcher anyway" question the U2
  section parks. The deleted helper was a *re-derivation* of `NavLink`'s answer; asking
  the router for its own match list is the same single source, read directly. It is also
  the idiom react-router documents for breadcrumbs.
- **`:runId` moved from a SIBLING of `runs` to a CHILD of it**, so the trail reads
  Monitor › Runs › run_42 with a linkable middle crumb. URLs are byte-identical; pinned
  by a test asserting the matched route patterns, not just the rendered page.
- **Shell children are pinned to explicit `grid-column`s.** Load-bearing, and found by
  browser verification: a collapsed pane is `hidden` (`display: none`) and its splitter
  is unmounted, so grid AUTO-PLACEMENT slid the workspace two tracks left into a 0px
  column and crushed the whole app into a zero-width sliver. `grid-template-columns`
  read correctly the whole time — which is why the e2e measures element BOXES, and why
  no child is left to be placed by DOM order and sibling count.
- **The pane's width is on the ELEMENT; the track is `auto`.** So an absent pane (Home
  declares no sections) and a collapsed one — `hidden`, i.e. not a grid item — both
  reclaim their column for nothing, because an `auto` track with no item in it resolves
  to 0. `AppShell` therefore writes `--pane-width` unconditionally.
  The first cut put `var(--pane-width)` in the track template instead. That is a FIXED
  track, which does not self-collapse, so both states had to be mirrored back as an
  inline `0px` — and an undefined custom property would have made the whole
  `grid-template-columns` declaration invalid at computed-value time and dropped it to
  `none`. Sizing the element deletes both hazards; the CSS fallback (`240px`) now only
  has to yield a sane pane rather than rescue the entire shell.
- **The pane is mounted-but-`hidden` when collapsed**, not unmounted: the toggle's
  `aria-controls` must name an element in the document, and `hidden` also removes it from
  the accessibility tree. `display: none` taking it out of the grid is what frees the
  column.
- **ONE collapse toggle, in the command bar** — a deviation from the diagram's `«collapse`
  at the pane's foot. A control inside the pane vanishes with it, forcing a second expand
  control elsewhere: two controls and two code paths for one boolean. It is absent
  entirely on a hub with no pane, because a disclosure button controlling nothing is worse
  than no button.
- **No pane on Home.** Home declares no sections, so no pane renders. This is NOT a rule
  that a one-entry pane is not worth drawing — Author and Monitor ship exactly that today,
  because the container has to exist for U4's resources tree and U10's filters to land in,
  and Manage genuinely has two entries. Home is different in kind: it IS the overview, so
  its pane could only ever point at the page you are already on.
- **The drag deliberately bypasses React.** `pointermove` fires at refresh rate; routing
  each through the store would re-render the shell ~60×/s and persist to `localStorage`
  per frame. The splitter previews by writing `--pane-width` straight onto the shell
  element and commits once on `pointerup`.
  A re-render mid-drag does NOT snap the pane back — browser-verified: React writes an
  inline style key only when the PROP value changes, so a re-render with an unchanged
  `paneWidth` leaves an out-of-band write alone. The real hazard is the inverse, and it
  is worse: **a preview that is never followed by a commit is never reconciled by any
  later render**, so the pane would keep a width neither the store nor `localStorage`
  has, indefinitely. What rules it out is that `endDrag` always runs — pointer capture
  guarantees a `pointerup` or a `pointercancel`, and both commit (each pinned by a unit
  test). If that ever stops holding, the fix is to make the commit path idempotent by
  writing the property from a layout effect, not to chase re-renders.
  Keyboard steps take the opposite path — straight to the store, never the preview, or
  the next render would revert them.
- **Hand-rolled `<nav><ol>` breadcrumb, not Fluent's `Breadcrumb`** (which IS installed).
  The honest reasons are bundle (U0's +64 kB budget) and plumbing — Fluent slots take an
  intrinsic `as`, not a component, so react-router has to be wired in per crumb via
  `useHref` + `useLinkClickHandler`, which is more code than the `<ol>`. Capability was
  never the blocker.
- **`@fluentui/react-nav` was rejected for the pane** (also installed): selection is a
  `selectedValue`/`defaultSelectedValue` prop — controlled or uncontrolled, either way a
  VALUE-based second opinion about where the user is, sitting beside the router's.
  `NavLink`'s `isActive` stays the only source. Worth not relitigating in U4.
- **The crumb separator is `content: '›' / ''`.** Moving it into a `::before` is NOT
  enough — browser-verified, Chromium exposes generated content to the accessibility tree
  and the crumb announced as "› Pipelines". The empty alt text after the slash is what
  marks it decorative; re-reading the a11y tree then gave "Pipelines". Note the
  degradation is VISUAL, not aural: CSS drops a declaration it cannot parse, so a browser
  without alt-text support renders `content: normal` and generates no separator at all.
- **The shell is `height: 100vh` and `.content` is the scroller.** Previously the DOCUMENT
  scrolled, which would carry the command bar off the top of the screen. `.workspace` needs
  an explicit `min-height: 0`/`min-width: 0` pair — a grid item's automatic minimum is
  `auto`, so without them the track refuses to shrink and the container overflows instead
  of the child scrolling. `.content` and `.secondary-pane` do NOT: setting `overflow` is
  itself enough to zero that automatic minimum. Both claims mutation-checked — deleting
  `.workspace`'s fails the e2e, deleting the others changes nothing.
  Consequence worth knowing for **U7/U8a**: `.content` now CLIPS, so an
  absolutely-positioned in-page overlay (properties panel, expression flyout) must portal
  to body — which the U0 spike's portal policy already requires.
- **Section labels are duplicated** between `hubs.ts` and the route `handle`s, on purpose —
  a literal crumb beats a three-branch inference from a pathname. `routes.test.tsx` pins
  them equal, and separately pins `sections[0].path` against each hub's index redirect.
- **Fixed en route: `/manage/triggers` was unreachable by clicking.** Between U2 and U3
  the rail reached Manage, Manage redirected to Connections, and nothing linked on.
- **Fixed en route: U3r's trailing-slash test was vacuous.** It read
  `router.state.matches` AFTER `render()`, which flushes the `<Navigate>` redirect inside
  `act()`, so it described the DESTINATION route — also called `runs`. It would have
  passed if `/runs/` had matched `:runId`. Now read from the router's initial state.

- **Pane width and collapse are GLOBAL, not per-hub.** One `autonomy-studio.pane` record,
  so collapsing in Manage keeps the pane collapsed in Author. The Shell section's "its own
  secondary pane" reads as though it could be per-hub; global matches ADF and is what a
  user putting the pane away almost certainly means. Pinned by an e2e that changes hub.

NOT in U3, with owners: the command bar's **actions region** (Validate / Save→version /
zoom-fit-layout) is **U9** — an empty container now would be dead code plus a seam chosen
before its first consumer; real per-hub pane content is **U4** (Factory Resources tree) and
**U10**; `#/settings` is **U15**.

## U4 — Factory Resources pane (AS BUILT, 2026-07-25)

The Author hub's pane is now a resource tree, and the canvas has an address.

```text
.secondary-pane  (the <nav> U3 built — id/hidden/aria-label unchanged)
  h2  "Factory Resources"          ← PANE_CONTENT[hub].title, not the hub name
  .factory-resources
    ├ toolbar    🔎 filter    + (New pipeline)
    ├ group      ▾ [Pipelines]     ← disclosure + the HUB SECTION's own NavLink
    └ ul#factory-pipelines         ← one row per pipeline: NavLink + ⋯ menu
```

| Piece | Where | Notes |
|---|---|---|
| The pipelines list | `stores/pipelinesStore.ts` | one store, two mounted views |
| Which hub gets a custom pane | `PANE_CONTENT` in `SecondaryPane.tsx` | `{title, Content}` per `HubId` |
| Canvas route | `/author/pipelines/:pipelineId` | `PipelineCanvasRoute`, mirrors `:runId` |
| Path builder | `pages/author/pipelinePath.ts` | the `runDetailPath` twin |
| Rename / duplicate | `api/pipelines.ts` | PATCH; duplicate is COMPOSED client-side |

Decisions worth not re-deriving:

- **A hub surface replaces the pane's BODY, never its `<nav>`.** The wrapper's `id`, `hidden`
  and `aria-label` are what the command bar's `aria-controls`, its focus restoration and the
  shell's column arithmetic all hang off; a hub that brought its own container would have to
  re-earn all three, silently, one hub at a time. `PANE_CONTENT` is a `Partial<Record<HubId,…>>`
  rather than an `if (hub.id === 'author')` because **U10** puts the Monitor filters here next.
- **The group header IS the hub's section link**, not a new label beside it. `HUBS` therefore
  stays the single source of the pane's navigation — the section still reaches the list page and
  still supplies the breadcrumb — and the tree hangs beneath it rather than forking a second
  navigation that could disagree. This is also why Author keeps `sections` at all.
- **The pane heading says "Factory Resources", the nav landmark still says "Author sections".**
  They answer different questions: the heading names what the pane HOLDS (the Shell diagram's
  label), the landmark names which of the page's three navs this is, and that answer should not
  change every time a hub re-decorates its pane.
- **The list lives in a shared store, and the pipelines page was migrated onto it.** After U4
  there are TWO views of the same list mounted at once; two `useState` copies could only agree
  by luck. Every mutation ends in a `refresh()`, which is the whole point of the store.
  Its loads carry a monotonic sequence id and a superseded load DROPS its result — success *or*
  rejection — so two overlapping refreshes cannot apply in completion order and leave the tree
  showing a list the server no longer has, nor bury a fresh answer under a stale error.
  (One caveat the sequence id creates: a superseded `refresh()` resolves as soon as its OWN
  request settles, so `await refresh()` means "my request is done", not "the list is current".
  No caller needs the stronger reading; one that did would need the winning load's promise.)
- **`ensureFresh()` is the one mount-time entry point, and it is deliberately three-way.** It
  loads from `idle` AND from `ready` — re-entering the Author hub RE-READS, so a pipeline created
  by the CLI, an import or a second tab is not invisible until a browser reload. (An earlier cut
  only loaded from `idle`, which quietly turned a per-mount fetch into fetch-once-per-page-load.)
  It skips while `loading`, which is what makes the request count DETERMINISTIC when the hub
  mounts two consumers in one commit — whichever effect runs first wins and the other stands
  down, so it is exactly one request either way. And it skips on `error`, so a broken server
  cannot be hammered by remounts; recovery is the explicit Retry, which BOTH surfaces offer —
  the pane's alone would not do, because the pane can be collapsed and a collapsed pane is
  `hidden`, i.e. neither clickable nor focusable.
- **`error` is kept DISTINCT from "loaded, empty" in both views** — "there are none" and "we
  could not find out" are different facts, and the empty state is a lie about the second. The
  error is also cleared when a retry STARTS, not only when one succeeds, so the banner never
  describes a request that is no longer the current one.
- **The pipelines PAGE was NOT reduced to a landing screen** even though the pane can now do
  everything it does. The pane collapses — globally, and the preference persists — and Author
  would then have no way to reach or create a pipeline at all.
- **The canvas is fetched BY ID, not looked up in the store.** A bookmarked pipeline must not
  wait on the page-walked list, and a 404 is then a real answer ("no such pipeline, or not
  yours") rather than "not in the list yet". `key={pipelineId}` forces a remount, for the same
  reason `RunDetailRoute` does: the canvas holds an unsaved graph, and react-router reuses a
  route component instance when only a param changes.
- **The `:pipelineId` crumb is the ID, not the name.** Resolving the name would need the shell to
  subscribe to a page-domain store (or a route loader) *and* re-render when it arrived — a
  coupling the shell has deliberately avoided — for a label the canvas's own `<h2>` already
  shows. `:runId` sets the precedent. **U9** owns the command bar's per-pipeline region and can
  carry the name there.
- **Duplicate is COMPOSED from existing endpoints and ROLLS BACK.** No server route, because the
  epic's stated non-goal is that its only backend work is read-only read-models. There is no
  transaction across two HTTP requests, so a copy whose version write fails is deleted again
  (seconds old, and `pipeline_versions` cascades, so `DELETE` cannot 409) and the ORIGINAL error
  is what surfaces — an empty husk appearing in the tree at the moment the user is told it failed
  is worse than no copy. If the rollback itself fails the original error still wins; a rollback
  error names the wrong problem. The `createPipeline` call sits INSIDE the `try`: a 201 whose
  body fails `PipelineSchema` has still committed server-side, and a create outside the try would
  leave exactly the husk the rollback exists to prevent.
- **A duplicate copies the source's `catalogVersion` AND its `concurrency` cap.** Duplicating is
  a copy, not a re-authoring: re-stamping the graph with today's catalog would assert a
  compatibility nobody checked, and letting the write schema's `.default(null)` stand would
  silently UNCAP the copy — an absent fact manufactured as a benign default, the shape #473
  banned. Those two are the only fields a pipeline carries beyond its name.
- **An inline name ROW for create/rename/duplicate, not a Fluent `Dialog`.** All three are "give
  me a name". Renaming in place is what a resources tree does, a modal to type six characters
  into is a worse interaction, and `Dialog` would be the first import of a surface U0's bundle
  budget has not paid for — the same reasoning that hand-rolled U3's breadcrumb. A failed
  mutation keeps the row open with the typed name intact.
- **NOT an ARIA `tree`.** A real `role="tree"` owes roving tabindex, typeahead and arrow-key
  traversal over a structure that is one flat group today, and a half-implemented tree is less
  usable than the list it replaced. A disclosure over a list of `NavLink`s keeps `isActive` as
  the ONE source of "which one am I on" — the same reason `@fluentui/react-nav` was rejected for
  the pane in U3. Revisit when the tree gains real nesting — **U20** (`call_pipeline` authoring
  brings non-pipeline resources into the tree) or **U22** (a version picker under a pipeline).
  *(Corrected in U5: this said "when U5/U20", but U5 as built is a canvas-column toolbox that
  never touches the pane — see its AS-BUILT section for why — so it adds the tree no nesting.)*
- **No header `⋯`.** The Shell diagram draws `+ ⋯`, but every action it could hold is per-row and
  already in the row's own menu. An overflow menu with nothing in it is the empty-seam
  anti-pattern U9's actions region was deferred to avoid.
- **The row's `⋯` uses `opacity: 0`, NOT `visibility: hidden` (the first cut) or `display:
  none`.** Both of those EXCLUDE an element from the accessibility tree, which would make
  rename/duplicate/delete undiscoverable to a screen reader and unreachable by a BACKWARDS
  Shift+Tab — the button is not focusable until the row already has focus in it, so the reveal
  would depend on the very focus it gates. `opacity` keeps it in the layout (rows do not jump),
  in the a11y tree, and focusable; `:hover`/`:focus-within` then reveal it. Pinned by an e2e that
  tabs BACKWARDS into it, which is the direction the broken version fails — the forward-only
  test the first cut shipped passed against `visibility: hidden`.
- **Focus restoration runs in an EFFECT, off a `ref`, and covers DELETE too.** Closing the draft
  row — or deleting the row a menu was anchored to — unmounts the element focus is inside, which
  strands focus on `<body>` and restarts Tab from the top. (Fluent restores focus to its trigger
  on close, but after a delete that trigger is gone.) The handler cannot do it, because React has
  not removed the row yet; holding the target in state would mean a `setState` inside that effect
  purely to clear it, a cascading render for a value nothing renders. The effect depends on the
  pipelines list as well as the draft, since a delete closes no draft and the list changing is
  the only signal the row has gone.
- **A rename whose pipeline vanishes is handled by DERIVING the draft, not reconciling it.** If a
  refresh drops the row mid-rename, the editor would otherwise have no row to render in while
  `draft` stayed set — the editor silently disappears, and focus is never restored because the
  effect above needs a null draft. Computed at render instead: an effect would have to `setState`
  to fix state it just observed.
- **Deleting the pipeline you are EDITING navigates away**; deleting any other one does not. A
  canvas left mounted on a deleted pipeline shows a graph that no longer exists and 404s on the
  next load — but yanking the user out of what they are editing because they tidied up something
  else would be worse than the stale row.
- **`latestVersion` moved into `api/pipelines.ts`.** The canvas had it privately, and duplicate
  needed the same rule; two copies of "highest `version`, not the last element" is exactly the
  kind that drifts, and the server's ordering is its own business. `describeDeleteFailure` and
  `messageOf` were extracted for the same reason — the 409 sentence had already drifted
  typographically between the two delete surfaces before it was shared.
- **Deleting the pipeline you are editing navigates with `replace`.** A push would leave the dead
  pipeline's URL in history, so Back lands on "Pipeline not found" — the trap `routes.tsx` states
  the house rule for. The navigation happens AFTER the mutation returns, not inside it: a
  navigation that threw would otherwise be reported as "could not delete" for a delete that had
  already succeeded.
- **A hub with custom pane content renders `sections[0]` ONLY.** A second Author section would
  therefore vanish from the pane rather than render — the same silent unreachability that hid
  `/manage/triggers` between U2 and U3. Rather than build speculative UI for a hub that does not
  exist, `hubs.test.ts` pins Author at exactly one section, so ADDING one fails loudly and lands
  the decision on whoever adds it.
- **Bundle: the row `⋯` costs +31 kB gzip, and it is the reason there is no `Dialog`.** Fluent's
  `Menu` took the `fluent` vendor chunk from 40.12 to 71.03 kB gzip (125.79 → 234.03 kB raw),
  priced by building with and without it rather than inferred. It landed in `fluent`, NOT the
  entry — which is what U1's chunk split exists for and the property to keep holding — and the
  entry is flat (167.13 → 169.39 kB gzip, which is the pane, store, route and tree themselves).
  A `Dialog` for create/rename/duplicate would have been a second heavy surface on top, for an
  interaction a resources tree is better off doing in place.

Browser-verified (Chromium, 2026-07-25): Fluent tokens resolve on `.app-fluent-root`
(`--colorNeutralBackground1: #292929` dark / white light); ZERO `--xy-*` bridge overrides left
holding an unresolved `var()` in either theme; the shell grid stays `48px 240px 5px 987px` with
the tree mounted, and `48px 180px 5px 1047px` at the pane minimum with zero horizontal overflow
anywhere (the filter's `min-width: 0` is load-bearing — a text input's intrinsic minimum is its
`size` attribute, ~20 characters, which would push the toolbar wider than the pane); the `⋯`
menu portals OUTSIDE the pane onto an opaque `rgb(41,41,41)` surface at z-index 1000000, so the
pane's own overflow clip cannot slice it; focus returns to the `+` / the row's `⋯` whenever the
control that opened the draft row is still on screen. The only console error on any page is the
pre-existing favicon 404 (**#717**).

NOT in U4, with owners: drag-and-drop REORDERING of the pane tree (**#732** — U5 built canvas
drag-and-drop, not pane reordering; see its AS-BUILT section) and non-pipeline resource types
(**U20**); a version picker under a pipeline (**U22**); the command bar's per-pipeline actions and
name (**U9**); `Publish`/`Commit` command-bar states (**U18**, DB-only path first). Deferred with
tickets: the canvas deep-link request waterfall and the canvas heading not following a rename
(**#720**); one shared `.icon-button` class across the command bar and the pane (**#721**).

## U5 — Activities toolbox (AS BUILT, 2026-07-25)

The flat MVP palette (one ungrouped button per catalog entry, inline in `PipelineCanvas.tsx`)
is replaced by `ActivityToolbox.tsx` in the canvas grid's left column: a search box over
category groups, each entry addable by **click** or by **drag onto the canvas**.

| Piece | Lives in |
|---|---|
| Group headings (SSOT) | `shared` `catalog/types.ts` — `ACTIVITY_CATEGORY_LABELS` |
| Grouping + filtering (pure) | `pages/pipeline/activityGroups.ts` — `toolboxGroups(query)` |
| Drag payload protocol | `pages/pipeline/activityDnd.ts` |
| The component | `pages/pipeline/ActivityToolbox.tsx` |
| The drop target | `pages/pipeline/FlowCanvas.tsx` — `onDragOver` / `onDrop` |

Decisions worth not re-deriving:

- **Click-to-add is NOT a legacy leftover — it is the accessible path.** HTML5 drag has no
  keyboard equivalent at all, and WCAG 2.2 SC 2.5.7 (Dragging Movements) requires a
  single-pointer alternative to every drag action. Each entry is therefore a real `<button>`
  carrying `draggable`, not a `<div>` with a drag handler: focusable and activatable for free.
- **`ACTIVITY_CATEGORY_LABELS` lives in `shared`, beside `ACTIVITY_CATEGORIES`.** The catalog
  already owns activity display strings (`ActivityCatalogEntry.title`) and that union's own doc
  already owns the palette's group ORDER — splitting order and label across two packages leaves
  two half-owners. `Record<ActivityCategory, string>` makes it exhaustive: adding a category
  without a label is a compile error, not a raw `control` slug rendered as a heading.
- **Group order is `ACTIVITY_CATEGORIES`; entry order inside a group is alphabetical by title.**
  The catalog's Map order is registry DECLARATION order, which interleaves categories and tracks
  nothing a user can see — a "searchable, categorized" palette using it would make search the
  only way to find anything.
- **The filter matches title AND type.** The title is what the toolbox shows, but the type
  (`file_read`) is what the docs, an export envelope and every error message name.
- **A group with no matches is OMITTED, and zero matches renders a `role="status"`.** A heading
  over nothing is a false "this category has matches" signal; a silently empty column reads as
  "still loading" to someone who cannot see it.
- **The toolbox stays in the canvas grid, NOT the Author pane.** The pane is GLOBAL and
  collapsible with a persisted preference (U3), while the toolbox is meaningful only while a
  pipeline is open — an operator who collapsed the pane to widen the canvas would lose the
  ability to add activities to the canvas they just widened. (The same shape as U4's reason for
  keeping the pipelines PAGE alive alongside the pane tree. Note this is *not* an argument about
  `hubs.test.ts` pinning Author at one pane SECTION — that pins the nav list, and pane BODY
  content is a different thing; the collapse argument is the load-bearing one.)
- **`dragover` gates on `dataTransfer.types`, never `getData()`.** During `dragenter`/`dragover`
  the HTML drag-data store is in PROTECTED mode: `types` is readable, `getData()` returns `''`.
  A gate written against the payload passes any test whose `DataTransfer` fake hands the data
  back, and then rejects every real drag in a browser. `hasActivityDragType` exists for exactly
  this asymmetry; `readActivityDragType` re-validates at drop, where the payload is readable.
- **`preventDefault()` is called for our own drags — and "ours" is NOT "authorable".** It is what
  makes an element a drop target, so an unconditional call would make the canvas swallow every
  file/link/text drag released over it. But the two gates are asymmetric: `dragover` can only see
  a drag's SHAPE (its MIME types), while `drop` can read the payload. So `drop` cancels on the
  SAME predicate `dragover` accepted on, and only then decides whether to author. Bailing before
  `preventDefault` on an unauthorable payload would hand back a drop we had already invited with
  a copy cursor — and since `DataTransfer.types` is a LIST, a drag carrying our MIME alongside
  `text/uri-list` would then run the browser's default action and navigate the page away from an
  unsaved graph.
- **The `FlowCanvas` unit specs assert the default-prevented half, not the payload rules.**
  Asserting only "no node was added" tests nothing at that layer, because `canvasStore.addNode`
  refuses an unknown or structural-call type on its own — verified by mutation, which left every
  node-count assertion green. The payload rules are pinned where they are observable, in
  `activityDnd.test.ts`.
- **A SEARCH SUSPENDS every collapse — and replaces the disclosures with static headings.**
  Otherwise, collapsing a group and then filtering shows a lone collapsed heading and nothing
  else, and the empty state does not fire either (the group *did* match), so search silently
  appears to return nothing. Suspended, not cleared: the collapsed set is untouched, so clearing
  the query restores the operator's preference rather than discarding it.
  The disclosure BUTTON goes for the duration, which is the second half of the decision and was
  found by the PR review bot: a toggle whose collapse cannot take effect can only lie about its
  own state or rewrite the preference invisibly. With the button still rendered it read
  "Collapse" over an already-expanded list, and clicking it deleted the category from the
  collapsed set while changing nothing on screen — so the preference vanished the moment the
  search was cleared. Removing the control while it has nothing to control retires both failures
  instead of choosing which state to lie about; the list keeps its `aria-label`, so the grouping
  is still conveyed.
- **The `role="status"` empty state is ALWAYS mounted, with only its text changing.** A live
  region inserted into the DOM in the same commit as its content is announced unreliably —
  screen readers watch regions they already know about. Rendering it conditionally would satisfy
  the visual requirement and quietly fail the one it exists for. Neither the unit nor the e2e
  test can see this difference; it is a correctness decision, not a tested one.
- **`aria-controls` ids come from `useId`, not a module constant.** Two toolboxes on one page
  (a compare/side-by-side canvas is a plausible later ticket) would otherwise emit duplicate DOM
  ids and every disclosure would point at the FIRST toolbox's list.
- **`addNode` COPIES the caller's `position`.** Retaining the reference would let a caller mutate
  a node's position from outside the actions, which are the single mutation point this store's
  own doc claims.
- **`isOverCanvasSurface` fails CLOSED on a non-`Element` target** — unreachable in practice, but
  "we could not tell where this landed" must not resolve to "author a node there".
- **The canvas height is one `--canvas-height` custom property** on `.canvas-grid`, read by both
  `.canvas-wrap` and the toolbox's `max-height`. As two bare `620px` literals, editing one left
  the toolbox silently short of, or overflowing past, the canvas beside it.
- **A drop released over the canvas CHROME is refused.** React Flow spreads unknown props —
  including `onDrop` — onto its OUTER wrapper, and `MiniMap`, `Controls` and the attribution all
  render inside it through its `Panel` primitive (they share `react-flow__panel`). Without the
  guard, releasing over the minimap authors a node at whatever flow position sits under that
  screen corner. The same predicate gates `dragover`, so the operator sees the browser's own "no
  drop" cursor there rather than an invitation.
- **The payload is a custom MIME type and is validated against the live catalog.** `text/plain`
  is what a dragged text selection, a link and half the web carries. Even under the custom type
  the string comes from outside the document (another tab, an older build), so an uncatalogued
  or structural-call type is refused before it can mint a node — the #4 A9 / #425 exclusion
  applied to what the canvas ACCEPTS, not only to what the toolbox OFFERS.
- **The node's TOP-LEFT lands under the pointer, not its centre.** The drag image is a toolbox
  BUTTON, whose size bears no relation to a node's, so subtracting the grab offset inside it
  would be false precision. `screenToFlowPosition` accounts for the live zoom/pan.
- **A positioned add does not consume a stagger slot.** `addCount` exists so successive CLICKED
  adds do not stack at one point; a drop places explicitly and stacks nothing. Pinned by
  asserting the resulting POSITION of a later click, not the counter — a test on the counter
  would survive the counter's removal.
- **`FlowCanvas` now REQUIRES a `ReactFlowProvider` ancestor.** `useReactFlow` reads a context
  the `<ReactFlow>` component's own internal provider does not expose to its parent.
  `PipelineCanvas` already wrapped it; `coexistence.test.tsx` was updated to match the real
  composition rather than pin a looser one the app never uses.
- **The pure module is `activityGroups.ts`, NOT `activityToolbox.ts`.** This was a real bug for
  one commit: on a case-INSENSITIVE filesystem Vite resolves a bare `./activityToolbox` through
  `.ts` before `.tsx`, so the pure module captured the component's own import and
  `<ActivityToolbox/>` was `undefined`. Two modules in one directory differing only in the case
  of their first letter is the hazard.
- **`Palette.test.tsx` was renamed to `NodePanel.test.tsx`** (its remaining contents), because
  `src/palette.test.ts` — the CSS COLOUR-palette guard — already owned "palette" in this
  package's test names.
- **The `DataTransfer` fake lives once**, in `testing/fakeDataTransfer.ts`, used by both drag
  specs. Its protected-mode behaviour is precisely the subtlety that gets hardened in one copy
  and not the other — the failure `e2e/support/theme.ts` records this repo already paying for.
- **`title={entry.type}` on an item is a pointer-only affordance, accepted as such.** A native
  `title` never appears on keyboard focus, so the raw activity type is not reachable by the users
  this ticket's keyboard path is for. Fluent's `Tooltip relationship="label"` (U4's answer) is not
  used here because it would attach a portalling surface to every one of ~15 items for a hint the
  properties panel (**U7**) will show properly.
- **`.activity-toolbox__list[hidden] { display: none }` is load-bearing**, and was a real bug
  for one commit. `display: flex` outranks the UA stylesheet's `[hidden] { display: none }` —
  ANY author `display` does — so a collapsed group stayed fully visible and fully in the
  accessibility tree. jsdom exposed nothing, because Testing Library reads the `hidden`
  ATTRIBUTE: the unit test for collapse passed against a group the browser still painted. The
  e2e spec caught it and is the regression net. U4's `.factory-resources__list` is safe only
  because it sets no `display`.
- **`min-width: 0` on both the toolbox and its filter input.** A grid item's automatic minimum
  is its content's intrinsic minimum, and a text input's is its `size` attribute (~20
  characters) — the same trap U4 hit in the pane, here against a FIXED 180px track.
- **Bundle, measured with and without the diff rather than inferred:** the `fluent` vendor chunk
  is UNCHANGED at 71.03 kB gzip (the chevrons were already imported by `FactoryResources`), the
  entry moves 109.46 → 109.52 kB gzip, and the toolbox's own cost lands in the LAZY
  `PipelineCanvasRoute` chunk (60.01 → 60.78 kB gzip) — which is the property U1's chunk split
  exists to keep. CSS 2.87 → 3.03 kB gzip.

Browser-verified after the review round: `--canvas-height` resolves to `620px` and the toolbox's
`max-height` equals `.canvas-wrap`'s height; a group collapsed and THEN searched shows its match
(`hidden` absent, `display: flex`, item height > 0) and re-collapses when the query is cleared,
with sibling groups untouched; the `role="status"` region is mounted with empty text while
results are on screen; `aria-controls` is `useId`-scoped and resolves; zero console errors or
warnings.

Browser-verified (Chromium, 2026-07-25, both themes): Fluent tokens resolve on
`.app-fluent-root` (`--colorNeutralBackground1` `#292929` dark / `#ffffff` light); all 23 `--xy-*`
bridge overrides resolve with ZERO left holding an unresolved `var()` in either theme; the canvas
grid stays `180px <1fr> 320px` with the toolbox measuring exactly 180px and ZERO horizontal
overflow on the toolbox or the document; a collapsed group computes `display: none` at height 0
while its siblings stay `flex`; a real HTML5 drag of "HTTP Request" fired `dragstart` on that
button and landed its node **1px** from the drop point (top-left, as specced); filtering on
`file_` matches by TYPE only (no such title exists) and leaves only the General group; zero
console errors or warnings across the whole session.

NOT in U5, with owners: selecting the newly-added node and editing it (**U7** — `addNode` still
does not change selection, so click-add and drop behave identically); dropping ONTO a node or
INTO a container (**U23**, which owns drag-into-container drop mechanics); a node-shaped drag
PREVIEW instead of the default button drag image (**U9**/**U23** polish); undoing an add
(**U17**, which the epic says should land before U6*); zoom-to-fit after an add (**U9**); the
`execute_pipeline` entry staying hidden (**U20** / **#425**); pane-tree drag REORDERING
(**#732**, filed by this ticket); persisting the group-collapse preference across a canvas
remount (it is component state today, and `PipelineCanvasRoute` keys the canvas per pipeline, so
switching pipelines reopens every group — **U9**, which owns the command bar's per-pipeline
region, or `uiStore` alongside U3's pane preference).

**The P5c drag-reconciliation regression check the cross-cutting block asks for "before U6a" is
NOT delivered here, and U6a owns it.** It was attempted: the obvious unit test — "an unrelated
store change does not remount an existing node" — was written, and then found NOT to
discriminate, because React keys node elements by id so DOM identity survives even with the
carry-forward deleted outright (confirmed by mutation). The property only diverges while a drag
is IN FLIGHT, when the view position leads the domain position and `measured` is populated —
neither of which jsdom can produce, and neither of which survives a settled drag. A real check
must drive a pointer drag in a browser and observe mid-gesture. The attempted test was deleted
rather than shipped green, since a vacuous test under that name would have told U6a the invariant
was covered; the trap is recorded in `FlowCanvas.tsx`'s own doc comment so it is not re-attempted
blind.

Known and accepted: on an EMPTY canvas `<ReactFlow fitView>`
has not resolved yet, so the FIRST node added — by click or by drop — re-centres and re-zooms the
viewport as it is measured; every subsequent drop lands where the pointer released. That is
pre-existing click-add behaviour, not a U5 regression, and **U9** owns zoom/fit.

## U6a — typed edges + branch picker (AS BUILT, 2026-07-25)

Edges were one grey default painted with the literal `on` as their label. They now carry a hue
per condition, a label that is the actual routing key, and the property panel offers every
condition the edge's SOURCE can really emit.

| Piece | Lives in |
|---|---|
| Condition vocabulary (pure) | `pages/pipeline/edgeCondition.ts` |
| Declared branch labels (SSOT) | `shared` `engine/params.ts` — `declaredBranchesOf`, now exported |
| Edge identity (SSOT) | `shared` `engine/reduce.ts` — `stableEdgeKey`, now exported |
| Retype action | `pages/pipeline/canvasStore.ts` — `updateEdgeCondition` |
| The picker | `pages/pipeline/PipelineCanvas.tsx` — `EdgePanel` (exported) |
| Colours | `index.css` — `.edge-variant-*` → `--edge-color`; new `--branch` palette var |
| Browser coverage | `e2e/edge-typing.spec.ts`, `e2e/support/canvasGraph.ts` |

Decisions worth not re-deriving:

- **The variant class sets `--edge-color`, which feeds RF's `--xy-edge-stroke` AND
  `--xy-edge-stroke-selected`.** Three seams were rejected for concrete reasons: an inline
  `edge.style.stroke` outranks RF's own `.react-flow__edge.selected .react-flow__edge-path`
  rule and silently kills the selection highlight; a class rule written against
  `.react-flow__edge-path` TIES that rule on specificity (0,3,0), so the winner depends on
  stylesheet import order; and setting only the unselected slot leaves the selected one
  repainting every edge brand-blue. It does NOT colour arrowheads — `MarkerDefinitions` renders
  once as a sibling of the edge layer, not inside each edge `<g>`, so a variable set on the edge
  cannot reach it, and the canvas configures no `markerEnd` anyway. Whoever adds arrowheads
  (**U6b**/**U19**) needs one marker id per condition. **DONE in U6b** — one `<marker>` per
  condition, defined by the canvas and hued by CSS from the same palette var; see the U6b
  as-built section for why the object form was not used (its stated impossibility is false).
- **A SELECTED edge keeps its variant hue; WIDTH carries selection (1.5 → 3).** Found in the
  browser, not by review: the picker lives in the property panel, which only opens for a
  selected edge, so RF's default behaviour masked the colour for exactly as long as it could be
  edited — pick `failure`, watch nothing change, click away, discover it worked. The class list,
  the unit tests and a screenshot of a *deselected* edge all looked correct.
- **The `<option>` value is TAGGED (`op:success` vs `branch:success`).** A `switch` case label is
  an arbitrary string — `validateSwitchConfig` reserves only `default` — so `cases: ['success']`
  is a legal, savable doc. With raw values the select emits two `<option value="success">` and
  the change handler cannot tell them apart: picking the business branch would silently author
  the operational outcome. Only the FIRST delimiter splits, so a label containing `:` survives.
- **`skipped` is authorable now.** It was pinned out of `AUTHORABLE_EDGE_ON` when #1 F1 gave the
  engine skip routing — the engine routed it, `EdgeOnSchema` carried it and `validatePipelineDoc`
  never refused it; only the canvas could not author it. That pin named this ticket.
- **The branch list is `declaredBranchesOf`, the same function the write gate reads**, so every
  option offered is one a save accepts, BY CONSTRUCTION rather than by two lists staying in step.
  Its tri-state return is load-bearing: `undefined` ("cannot emit a branch") hides the group,
  which is not the same as an empty group ("branches, but declares nothing").
- **A persisted value the source does not offer renders as a DISABLED option**, not as a silent
  fallback to the first one. Reachable WITHOUT leaving the canvas — `declaredBranchesOf` reads a
  `switch`'s `config.cases` live, so editing that config un-declares a branch an existing edge
  still uses. Browser-verified: the select still reads `branch:reject`, the option says
  "reject — not offered by this source", the badge says *"edge 'e_1': source 'n_sw' does not
  declare branch 'reject' — it routes only 'approve'/'default'"*, and Save is disabled.
- **A condition another edge already holds is shown DISABLED, not refused on click.** The store
  refuses such a retype (below), and a refusal the operator cannot see is a control that silently
  does nothing: pick `failure`, React re-renders from the unchanged store, the select snaps back,
  no explanation. The option now reads "failure — already used by another edge" and cannot be
  picked. `takenConditions` re-expresses `stableEdgeKey`'s identity in terms of a condition (the
  key needs a whole retyped `Edge`, i.e. the store's `retypeEdge`), so the equivalence is asserted
  directly against `stableEdgeKey` in the tests rather than left to two definitions staying in
  step — the same anti-drift pattern #526 used for `lowerPipelineNodes`.
- **`updateEdgeCondition` REFUSES a retype that would duplicate another edge**, using
  `stableEdgeKey`. `connect`'s dedupe alone is walked around by retyping (connect A→B success,
  retype to skipped, connect again, retype again → two byte-identical edges), and nothing
  downstream catches it: `validatePipelineDoc` has no duplicate-EDGE rule, its id-uniqueness
  check covers nodes and containers only. Duplicates share one bounce counter as back-edges and
  stack as unclickable overlapping paths. The `branch` label must stay in the key — both arms of
  one `if` may legitimately target one node.
- **All arms of a branching node share ONE hue; the LABEL distinguishes them.** A per-arm colour
  needs an unbounded palette (a `switch`'s cases are arbitrary strings) and would collide with
  the operational hues it has to stay distinct from.
- **`ariaLabel` is set explicitly.** RF renders an edge as `role="img"` (or `group` when
  focusable); under either, the SVG `<text>` label is NOT exposed — so without it, colour is the
  only channel assistive technology gets, which the cross-cutting "non-color status labels"
  criterion rules out.
- **Colours are the MVP palette's existing outcome hues** — the same `--success`/`--error`/
  `--accent`/`--muted` the run monitor's status pills use — so there is ONE outcome palette, not a
  second one invented for the canvas, and `palette.test.ts` now pins which var each condition
  reads. `--branch` is the one new var, and the existing reflective guard covers its light/dark
  parity for free. Note the mapping is NOT injective ACROSS surfaces, and **U11**/**U25** inherit
  that: `--accent` is `completion` on the canvas and `running` in the Monitor, and `--muted` is
  `skipped` here but `pending`/`waiting` there (the Monitor has no `skipped` pill yet — **U25**
  owns adding one). Same palette, two vocabularies; a semantic layer
  (`--status-success: var(--success)`) is the fix if that starts to bite.
- **Contrast is measured against the CANVAS surface, not `--bg`.** The canvas is Fluent's
  `--colorNeutralBackground1` (`#292929` dark / `#ffffff` light); the palette's light values were
  darkened for `--bg`. A stroke is a non-text graphical object, so the bar is WCAG 1.4.11's 3:1.
  Measured in-browser, every condition, both themes: dark 5.24–7.91:1, light 5.87–7.38:1.
- **`@autonomy-studio/shared`'s public surface GREW by two functions**, and that is worth saying
  out loud because the package is published: `engine/index.ts` re-exports `params.ts` and
  `reduce.ts` with `export *`, so `declaredBranchesOf` and `stableEdgeKey` are now API. The
  authoring uniqueness rule deliberately does NOT live on `stableEdgeKey` itself —
  `edgeCondition.ts`'s `authoringEdgeKey` delegates to it and adds `back`, so a change to the
  AUTHORING rule can never become a change to a key that indexes `bounces[...]` across saves.
  (The engine can exclude `back` safely because it only ever keys BACK edges by it; two edges
  sharing `(from,to,on,branch)` where one is a back-edge are distinct and legal, and refusing to
  author them would refuse something that runs.)
- **`declaredBranchesOf` stays in `params.ts`, beside the rule that reads it.** The catalog cannot
  express it as a data field — a `switch`'s labels derive from `node.config.cases`, so the entry
  would have to hold a function over a `Node`, unlike every other field there. **U19** ("handles
  per ActivityDefinition") is where that move gets decided, once.
- **`connect()` defaulting to `success` off an `if` is NOT a bug.** A control node terminates
  `success`, and nothing refuses an operational edge off one — a drawn edge there is a legal,
  live `success` edge. Defaulting to a branch would author `on:'branch'` with a guessed label.

**The P5c drag-reconciliation regression check U5 handed to this ticket is DELIVERED**, as
`e2e/canvas-drag-reconciliation.spec.ts`. It drives a real pointer drag, forces a store change
mid-gesture, and asserts the dragged node did not snap back to its domain position. BOTH halves of
the carry-forward line were mutation-checked separately: deleting `existing?.position ??` fails the
spec, and deleting the `...existing` spread fails it plus three edge-typing specs. Two browser facts
made it flaky before they were handled, both now encoded in the spec: React Flow only attaches drag
handlers once the node is `draggable`, and a `boundingBox()` read while `fitView` is still animating
is a screen box that has moved by the time the pointer arrives — the drag then never starts and the
spec fails for a reason unrelated to the invariant.

**KNOWN LIMIT recorded for U17/U9/U22:** `position` is carried forward UNCONDITIONALLY, so once a
node is in the view array a DOMAIN position write never reaches the screen. Correct mid-drag, wrong
for undo-of-a-move (**U17**), auto-layout (**U9**) and restore-version (**U22**), which are all
domain position writes. Those need a "domain wins" escape hatch (a move epoch, or clearing the view
entry on a programmatic move) — not a relaxation of the line the spec now pins.

Bundle, measured with and without the diff: entry CSS 3.09 → 3.25 kB gzip, the LAZY
`PipelineCanvasRoute` chunk 60.83 → 61.47 kB gzip (where the cost belongs), entry JS 110.04 →
110.08 kB gzip, `fluent` vendor UNCHANGED at 71.03 kB gzip.

NOT in U6a, with owners: back-edge rendering — a `back: true` edge paints identically to a forward
one, and it is the one edge whose apparent direction is a lie (**U6e** built the AUTHORING and the
bounce config and left the PAINTING alone: back-ness is labelled `↺ success ×10`, not hued or
dashed, because both channels collide — see U6e's AS BUILT row; the hue is **U19**'s); typed ports / multi-handle / connect-time validation (**U6b**); the
`skipped`-edge scope cliff (a node behind an `on:'skipped'` edge inherits nothing from its
predecessor's guarantees — `computeGraph` INVERTS them across a skip — so an upstream
`${nodes.X.output}` ref behind one stops resolving. This is correct engine behaviour and it is
already surfaced: `validateRefs` rejects the ref, the canvas badges it, `canSave` is false and the
#444 write gate refuses the doc. Making `skipped` authorable therefore opens no save-clean-fail-at-
run hole; what **U8a** owns is presenting such an issue better than a flat list);
retiring the dropdown for per-outcome source handles (**U19**).

**Accessibility, honestly:** the picker itself is a native `<select>` in a `<label>`, so it is
keyboard-operable and correctly named, and the edge's own accessible name now carries the routing
key. But browser-verification found that an edge can be FOCUSED by keyboard and not SELECTED —
`Enter`/`Space` on a focused edge leave the property panel empty, because `FlowCanvas` sets
`selected` only from `onNodeClick`/`onEdgeClick`. So the picker is reachable only with a mouse.
That is PRE-EXISTING (it affects the node panel identically and has since P5c) and not a U6a
regression, but U6a is where it became visible. Filed as **#737**; the fix is to wire React Flow's
`onSelectionChange` — which sees the keyboard path too — into the store, and it needs its own
tests because `FlowCanvas` currently DRIVES RF's `selected` prop from the store, so store→view→store
has to be idempotent and RF multi-select (**U21**) has to degrade to the store's single `Selection`.

## U6b — typed ports + connect-time validation + arrowheads (AS BUILT, 2026-07-25)

Any two nodes could be wired in any direction. Three candidates the store already refused did
so SILENTLY (the gesture just ended with no edge), and the fourth — an edge closing a forward
cycle — was authored happily and only refused later by a validation badge. Now React Flow
refuses the gesture itself, mid-drag, and the canvas says why.

| Piece | Lives in |
|---|---|
| DAG rule, connect-time (SSOT) | `shared` `engine/params.ts` — `closesForwardCycle`, exported |
| The four rules + their wording | `pages/pipeline/connectRules.ts` |
| Port identity + what a drawn edge means | `pages/pipeline/ports.ts` |
| Arrowhead marker defs | `pages/pipeline/EdgeMarkers.tsx` + `index.css` `#edge-arrow-*` |
| Wiring (`isValidConnection`, `onConnectEnd`) | `pages/pipeline/FlowCanvas.tsx` |
| Browser coverage | `e2e/connect-validation.spec.ts`, `e2e/support/canvasGraph.ts` |

Decisions worth not re-deriving:

- **`closesForwardCycle` is a DELTA over `forwardCycleErrors`, the save gate's own rule** — not a
  reachability query. The plan review caught the alternative as a real defect: `forwardReach`
  (right there in the same file) additionally adds CONTAINMENT edges for the back-edge ancestry
  rule, while the DAG rule's graph is built purely from `doc.edges`. A predicate over it would
  refuse `b → C` where `C` contains `b` — legal, savable, and refused for a reason the canvas does
  not render. Being a DELTA is the second half: an already-cyclic doc must not make every
  subsequent edge guilty, or one legacy version refuses every connection until the operator finds
  a cycle they did not draw.
- **A back-edge is exempt by CONSTRUCTION**, not by a special case: it is not in the forward graph.
  The refusal text names the back-edge + `maxBounces` remedy in the engine's own words, so it does
  not read as "this tool cannot express a loop". **U6e (2026-07-31) took exactly that step**: the
  refusal panel now carries a "Make it a back-edge" action, shown only where the back shape passes
  the full back-edge rule set — cycle-closure implies ancestry but NOT progress, so gating on the
  refusal's reason alone would have authored a doc the save gate refuses.
- **Refusal messages name the ACTIVITY, never the node id.** Found in the browser: ids come from
  `newLocalId`, so the first draft read *"'n_7c44a16f-…' → 'n_9c4bb103-…' would close a
  forward cycle"* with every unit spec green — the fixtures used ids a human would pick (`'a'`),
  which makes `toContain("'a'")` pass either way. The specs now use id-SHAPED fixtures and assert
  the ids do NOT appear. Two same-typed nodes used to share a label, accepted on the grounds that
  the text is transient feedback about the two ports just dragged. **#878 ended that**:
  `activityLabels` mints an identifying name (kind + within-kind ordinal, `HTTP Request 2`) and the
  refusal names both ends by it — `Node` still has no per-node name FIELD, but it now has a name.
- **The `duplicate` rule is per-CONDITION, so it must not become "one edge per pair".** `a
  -success-> b` and `a -failure-> b` are both legal; the canvas cannot DRAW the second yet (a drawn
  edge is always `success`), and **U19** — one source port per outcome — is what makes it drawable.
  Refusing the pair outright would have handed U19 a false rule to unpick.
- **A connection gesture can START AT EITHER END, and the refusal must be judged on the oriented
  edge.** The one REAL defect the pre-PR review found, and the worst-shaped one available: React
  Flow normalises source/target internally before deciding validity (`isValidHandle`,
  `isTarget = fromType === 'target'`) but hands `onConnectEnd` the RAW gesture — pointer-down node
  and pointer-up node. Read raw, a duplicate drawn backwards was explained as a *cycle*, and a
  cycle-closer drawn backwards produced **no message at all** (the reversed candidate is legal, so
  the panel did not render) — a silent refusal inside the feature built to delete silent refusals.
  Every forward spec was green throughout, because the drag helper only ever dragged
  source→target. `orientDrawnEnds` + `connectNodesBackwards` close both halves.
- **The panel keeps the attempted ENDS, not the message string**, and re-derives. A frozen message
  goes stale the moment the graph moves: delete one of the two activities it names and an assertive
  live region sits there naming something that is gone. Re-deriving also makes it self-clearing —
  delete the conflicting edge and the duplicate refusal stops being true, so it disappears without a
  dismiss. (The lint rule against `setState` in an effect is what forced this; the effect-clearing
  version it rejected was strictly worse.)
- **The panel is `pointer-events: none`** (dismiss button opted back in). RF's `Panel` carries
  `react-flow__panel`, which U5's drop guard treats as chrome that must not accept a toolbox drop —
  so while a refusal was up, the strip across the canvas silently swallowed dropped activities.
  A second silent-gesture surface inside the same feature.
- **`isValidConnection` runs per pointer-move**, so the endpoint set, the edge-key set and the
  id→node map are `useMemo`'d per graph, and the cycle check only runs for a candidate the cheap
  rules already passed. Stated precisely, because the first draft of that comment oversold it: the
  cycle check is TWO linear Kahn sweeps per call and the base sweep is repeated even though its
  answer is invariant for a whole drag. Hoisting it into the precompute is available if a graph ever
  grows enough to notice; not done for an unmeasured cost.
- **The refusal is `role="alert"`, deliberately not a second `role="status"`.** `PipelineCanvas`
  already runs a polite live region for the persistent validation badges; two polite regions
  updating together double-announce. This one answers a gesture the operator just made. Plain
  markup rather than a Fluent `MessageBar`, to keep the lazy canvas chunk light.
- **Arrowheads work via a STRING marker id** referencing the canvas's own `<marker>` defs
  (`getMarkerId` returns a string verbatim; RF only generates defs for the OBJECT form). The
  tempting reason — "RF's object form can't take a custom property, `fill="var(--x)"` doesn't
  resolve" — was MEASURED AND IS FALSE: in Chromium the attribute form computes
  `rgb(88, 214, 141)` like the CSS form. The real reason is that the object form needs the
  condition→hue mapping as a literal string in the edge derivation, beside the `.edge-variant-*`
  rules that already express it in the stylesheet that owns the palette and its light overrides.
  `fill: context-stroke` would have removed the duplication entirely and was rejected on
  verifiability: `getComputedStyle(...).fill` returns the literal `context-stroke`, so the browser
  gate could never confirm the arrow paints the hue. `palette.test.ts` pins the two lists equal.
- **Handles are IDENTIFIED (`in`/`out`) and edges name them.** RF's "first handle of this type"
  fallback silently mis-attaches the moment a node has two source handles, so this is the seam U19
  widens. Ports stay a VIEW concept — the engine has no ports, and `stableEdgeKey` (which indexes
  bounce counters across saves) is keyed on the condition.
- **`connect(from, to, condition)` now takes a whole `EdgeCondition`**, not an `EdgeOn`. The looser
  signature could author `on: 'branch'` with no label — half an edge, which `EdgeSchema` rejects.

**Verified in a browser, and — after review — mostly by the SUITE rather than by one reading.**
`connect-validation.spec.ts` now asserts all five arrowhead hues in BOTH themes against the
resolved palette value (dark `rgb(88, 214, 141)` / light `rgb(21, 112, 63)` for success, equal to
the edge stroke), the mid-gesture port painting `--success` when valid and `--error` when not, the
rendered `marker-end` attribute (RF's `url('#…')` wrapping is RF's behaviour, not ours to
unit-test), and the backwards gesture. The first cut of this paragraph claimed the five-hue,
two-theme reading while the automated part covered one hue in one theme — the FIT lens caught that,
and the fix was to make the claim enforceable rather than to soften it. Manual-only, from the live
pass: the refusal panel re-themes, survives a selection change plus ~2.5s of ticks, and dismiss
clears it; zero console errors or warnings across the session.

NOT in U6b, with owners: one source port per OUTCOME + retiring the condition dropdown (**U19**);
back-edge authoring, which is the remedy the cycle refusal names (**U6e**, BUILT 2026-07-31); the container-BOUNDARY
connect rule — real, and refused by the save gate, but container membership is not rendered yet, so
a refusal's cause would be invisible (**U6c**/**U6d**); undo of a connection (**U17**).

**A trap for the next canvas spec**, now encoded in `connect-validation.spec.ts`: at the default
1280px viewport the canvas pane is 397px and `fitView` clamps at `maxZoom: 2`, so two 120px nodes
cannot both fit. Laying them out for an edge pushes the first node's TARGET port and the second's
SOURCE port outside the pane (they land under the toolbox, still in the DOM). A left-to-right
source→target drag works anyway — which is why U6a never noticed — but a REVERSE drag puts the
pointer down on the toolbox and starts nothing, failing as "no refusal was shown". The spec widens
the viewport.

## U6c — container group rendering (AS BUILT, 2026-07-29)

A doc with a `loop`/`stage`/`foreach` rendered as a flat pile of activities: containers were pure
pass-through on the canvas (carried forward on save, fed to the connect rules, never drawn). And
because React Flow renders NOTHING for an edge whose endpoint node it cannot resolve, every edge
touching a container was silently missing too. Now the box is drawn, and the container-BOUNDARY
connect rule U6b deferred here has something visible to refuse against.

| Piece | Lives in |
|---|---|
| The box's geometry (pure, framework-free) | `pages/pipeline/containerLayout.ts` |
| Boundary predicate (SSOT with the save gate) | `shared` `engine/params.ts` — `crossesContainerBoundary` |
| The boundary refusal | `pages/pipeline/connectRules.ts` |
| `container` node type + derived-node wiring | `pages/pipeline/FlowCanvas.tsx` |
| Box, label, minimap outline | `index.css` — `.flow-container*`, `.minimap-node-container` |
| Browser coverage + doc seeding | `e2e/container-rendering.spec.ts`, `e2e/support/seedDoc.ts` |

Decisions worth not re-deriving:

- **The box is DERIVED from its children's rects; a container is NOT in `useNodesState`.** A
  `Container` carries no geometry (`{id, kind, children}`), deliberately — the engine groups by
  MEMBERSHIP, and a stored box would be a second source of truth about what is inside a loop. A
  container placed in the view-state array is also a feedback loop (set → measured → recompute →
  set); deriving breaks it by construction, because container geometry depends only on ACTIVITY
  geometry, never on its own.
- **A derived container must STATE its own geometry — `measured` AND `handles` — or its edges
  vanish.** This is the defect that shipped in the first cut with every green signal agreeing, and
  it is the one thing here worth reading twice. `adoptUserNodes` reuses a node's internals only
  while the SAME object identity keeps arriving through the `nodes` prop; a derived node is rebuilt
  every render, so on each re-adopt `parseHandles` evaluates `!userNode.measured ? undefined :
  <previous bounds>` and discards whatever its ResizeObserver measured. The size cannot come back
  the normal way either — a container's dimension change is filtered at `onNodesChange` precisely
  because it is not the store's to hold. `getEdgePosition` then returns `null` for the endpoint and
  `Edge` renders null, silently, since RF's error channel is a no-op in a production build. Both
  facts are stated because each answers a question the other does not: `handles` is what
  `parseHandles` takes verbatim, and `measured` is what `nodesInitialized` reads — and with
  `fitView` on, dropping `measured` leaves the graph permanently uninitialised. Either alone keeps
  the edges; removing both reproduces the defect (mutation-tested).
- **Size as TOP-LEVEL `width`/`height`, not only `style`.** `onlyRenderVisibleElements` culls
  against `measured.width ?? width ?? initialWidth ?? 0`, so a derived node RF has not measured is
  culled against a 0×0 box — taking its edges with it.
- **The box HINTS at membership; `connectRules` ENFORCES it.** Because the box is the union of its
  children's rects, a non-member positioned between two spread-out members is drawn inside it, and
  two containers with interleaved children draw overlapping boxes. Only RF `parentId` subflows —
  which clip children to their parent, and are **U23**'s — make enclosure and membership the same
  fact. Stated at the seam rather than left for a reader to discover.
- **What the box ANNOUNCES is what it DRAWS.** `childCount` travels with the rect and counts the
  children actually enclosed, not `children.length`. The two disagree exactly when it matters — a
  phantom child (node deleted, id still listed: reachable today, see **#746**) or a child a
  FIRST-wins earlier container already claimed — and the raw count captions an empty fallback box
  with "2 activities".
- **Ownership is `containerMembership`, FIRST-declared-wins (#492)** — one resolution shared by the
  reducer, the save gate, the layout and the connect rule, so the picture and the refusal cannot
  drift. `crossesContainerBoundary` single-sources the boundary CONDITION with `validateDoc`, whose
  error array is byte-identical after the refactor.
- **A container is a legal EDGE ENDPOINT, so an empty one still gets a real box** — placed
  deterministically clear of the graph. An empty `stage` is a valid doc, and a min/max over no
  children is ±Infinity, which as an RF position renders garbage.
- **An edge whose endpoint resolves to nothing is refused at save AND dropped on load (#786).**
  The save gate now rejects an edge naming neither a node nor a container, which closes the hole
  that let the canvas cascades be the only thing between an operator and a corrupt immutable
  version. But that rule alone would have re-created #748's trap on docs minted BEFORE it: RF
  renders nothing for an unresolvable endpoint (see above), so the author would face a red badge
  and a dead Save over an edge they can neither see nor select. `loadVersion` therefore drops such
  edges from the working graph on load — no `dirty`, `loaded` kept verbatim — following the #526
  `config.outputs` lowering precedent. Repair silently where the operator has no move; report
  where they do.
- **One edit only — DELETE (#748) — and the aria route is RF's.** The box carries a confirmed
  delete button in its header band, which is what ends the one-way trap an emptied container used
  to be (an emptied `loop` blocked every save; an emptied `stage` saved itself into an immutable
  version forever). It is a button on the box rather than a selection plus a property panel because
  a container **cannot** be made `selectable`: RF writes `pointer-events: all` on a selectable
  node's wrapper, and a container's wrapper spans a REGION of the canvas, so the box would eat the
  pane clicks aimed between its children (mutation-proven against `selectable: false` in
  `e2e/container-rendering.spec.ts`). The button opts back into hit-testing on its own, as the edge
  handles do. Everything ELSE stays read-only — creating a container, editing its config, and
  dragging nodes in and out are **U6d**/**#425**/**U23**, and undo does not exist. Container changes
  other than that one click are still
  filtered at the change seam so the domain store never sees one — by container ids MINUS activity
  ids, because the two share one namespace and RF's Map-keyed lookup keeps the ACTIVITY on a
  collision (filtering by id alone made that node undraggable, unselectable and undeletable). The
  accessible name/role go on the NODE (`ariaRole`/`ariaLabel`), the same route the edges use, not on
  the inner `<div>` — which is `pointer-events: none` and sits inside a wrapper that, being
  non-focusable, has no role of its own.
- **The fill is `--muted`'s grey, NOT `--accent`.** `--accent` is the `completion` edge hue (and the
  selection colour), so an accent wash paints every container in the language of an edge outcome —
  the same reasoning that gave `branch` its own neutral hue. Caught by the FIT lens after shipping
  a comment claiming "a neutral grey wash" over an accent-blue literal.
- **Containers are in `nodeLookup`, so they are in the MINIMAP.** RF draws every node there with one
  fill, which made a `loop` a solid blob over its own children. Drawn as an outline instead.

**Verified by `pnpm -C studio test:e2e`** (`container-rendering.spec.ts`, 10 specs, every one
mutation-proven: drop `measured`+`handles` → 4 red; drop the container source `Handle` → 4 red;
`selectable: true` → the pointer spec red; flip the containers-first spread → the paint-order spec
red; delete the light-mode `--container-fill` → the theme spec red; disable the boundary rule → the
boundary spec red; drop the minimap class → the minimap spec red). Containers cannot be authored
from the canvas until U6d, so the specs seed docs through the REAL write gate (`support/seedDoc.ts`)
— a doc these specs can mint is a doc an operator can have.

Two things the specs deliberately do NOT assert, because they cannot fail: the computed
`pointer-events` value (it inherits from RF's own inline default, so the assertion stays green with
the rule deleted — a gesture covers it instead) and FIRST-wins resolution of a doubly-listed child
(`validateDoc` refuses that doc, so it cannot be seeded — it stays in the unit suites).

NOT in U6c, with owners: creating/editing a container and dragging membership (**U6d**); RF
`parentId` subflows, which would make a container draggable as a group and enclosure authoritative
(**U23**); back-edge authoring (**U6e**, BUILT 2026-07-31); pruning a deleted node from `containers[].children`
(**#746**, U6d's path).

## U6d — container CREATE + membership (AS BUILT, 2026-07-31)

A container could be drawn (U6c) and deleted (#748) but never MADE: the only way to put a
`loop`/`stage`/`foreach` on screen was to mint a version through the API, which is literally what
every container e2e spec had to do. Authoring a pipeline that contains a loop was a core path with
a hole in it. Closed here — for CREATE and MEMBERSHIP. Container CONFIG editing and DRAG membership
stay U23's; see the deferrals below.

| Piece | Lives in |
|---|---|
| Consequence rules + operator-readable issue text | `pages/pipeline/containerRules.ts` |
| `assignContainerChild` / `containersWithNew` / `buildContainer`, `createContainer` / `setNodeContainer` | `pages/pipeline/canvasStore.ts` |
| The `ContainerSection` control (membership `<select>` + New-container form) | `pages/pipeline/PipelineCanvas.tsx` |
| Form styling | `index.css` — `.container-section`, `.container-create` |
| Browser coverage | `e2e/container-authoring.spec.ts` |

Decisions worth not re-deriving:

- **The control is ONE `<select>` on the NODE, not a panel on the container.** Membership is stored
  on the container (`children: string[]`), but `validateDoc` requires children to be DISJOINT, so it
  is functionally a per-node fact — which makes "which container is this activity in" the whole
  control: pick one to join, pick `— none —` to leave, and "New container" is the same act against a
  container that does not exist yet. It also sidesteps the constraint U6c mutation-proved: a
  container **cannot** be RF-`selectable`, so it can never be the thing a property panel is opened
  for. Disjointness is kept by `assignContainerChild` in ONE pass over every container, so it is a
  property of the function rather than of its caller.
- **A container is created around the SELECTED node, never empty.** That is what carries a
  `loop`/`foreach` past its one-child rule from the moment it exists, and it is why no multi-select
  (U21) is needed to make the gesture useful.
- **This ticket WARNS where `connectRules` REFUSES, and the difference is deliberate.** Take `a → b`
  — the commonest doc there is — and ask for a container round `b`: the edge now has one endpoint
  inside and one outside, which `validateDoc` refuses. Refusing the membership edit for that reason
  would make containerising anything already wired IMPOSSIBLE (the only order left would be "delete
  every edge, create the container, redraw"), and nothing on screen would say so. Warning is safe
  here in the way it would not be for a connection, because a membership edit is **reversible by the
  same control**: `— none —` puts the node back, and `deleteContainer` (#748) removes the box while
  keeping its children. So the invalid state is one the operator can always walk out of — which is
  what separates it from #748's one-way trap and #786's un-repairable dangling edge. The badge
  (#444) and `canSave` still stop it reaching an immutable version.
- **The warning is a diff of `validatePipelineDoc`, not a hand-written rule set.** Same SSOT as the
  save badge and the server's write gate, so it cannot drift from what a save would be refused for,
  and it covers cross-boundary edges, an emptied loop, nested containers, id collisions and
  expression scope without restating any of them. Only issues the doc does not ALREADY have are
  reported — an operator repairing a broken doc must not be blocked by the breakage they are
  repairing.
- **The doc-validator half is NOT the whole save gate, and that gap is real.**
  `validatePipelineDoc` runs no zod parse, and the server parses the body FIRST — so a `maxRounds`
  of `0` (or `1.5`, or a cleared numeric input, which `Number('')` reads as `0`) clears every canvas
  check, enables Save, and returns a raw zod `400` with no badge naming the cause. `buildContainer`
  closes it with `ContainerSchema.safeParse`, the same shape as `NodePanel.apply` validating an
  edited config blob before it can reach the store.
- **The implicit-routing flip is the consequence no VALIDATOR reports.** On an edge-less doc
  `implicitRouting` synthesises one success chain in add order, but `containers.length > 0` makes it
  `partitioned` — so creating the FIRST container silently replaces the sequence the operator was
  relying on with parallel roots, and saving mints that. `validateDoc` accepts both docs and says
  nothing, because the edges it iterates are synthesised, not authored. #788's `canvas-advisory`
  panel is not silent — it is a STANDING description of an edge-less graph, and its text changes the
  moment the first container lands. The confirmation is the PRE-HOC half: what a click is about to
  do, while it can still be declined.
- **The recovery sentence is per-CALL-SITE, and getting it wrong was the sharpest finding of the
  pre-PR review.** "Set the activity back to — none —" undoes a membership change; following it after
  CREATING a loop round a wired activity swaps one unsavable doc for a worse one — the loop is left
  with no children (`makes no progress`) and its `exitWhen` names a node outside it. So the create
  path names the container's own ✕ instead. A confirmation that names a recovery which does not
  recover is worse than one that names none. The stage-only version of the e2e could not see this,
  because an emptied stage validates clean; there is a `loop` variant now for exactly that reason.
- **Validator ids are rewritten for a human before they are shown.** `newLocalId` mints
  `n_7c44a16f-…`, and surfacing one verbatim reproduces the exact defect `connectRules.endpointLabel`
  exists for. Only the IDENTIFIERS change — the sentence stays the validator's, so this cannot become
  a second, drifting set of messages. An edge has no name, so it is named by its ENDS. Containers
  carry a within-kind ordinal (`stage 2`) because a PICKER, unlike transient gesture feedback, cannot
  accept two indistinguishable options. Two passes, not one: `validateExitWhen`/`validateForeachItems`
  write their location as `container.<id>.exitWhen` with the id UNQUOTED, and those two fields are the
  only container config this form authors — so the first error a beginner meets was the one arriving
  as a bare uuid.
- **The membership control renders IN the `execute_pipeline` stub too, not only in the editor.**
  That early return is the only panel a structural-call node ever gets, and a container is exactly
  the construct an imported doc puts one in — membership is orthogonal to `node.config`, so the stub
  must not swallow it.

**Verified by `pnpm -C studio test:e2e`** — 118 specs green, including `container-authoring.spec.ts`
(7 specs). Every new test mutation-proven, 20/20 killed: drop each `createContainer` guard (id
collision, childless, phantom child, schema); drop `buildContainer`'s schema parse; drop the
no-op/dirty guard; return a fresh array from `assignContainerChild` unconditionally; stop filtering
pre-existing issues; never report a routing change; return the raw validator text; drop the unquoted
`container.<id>` pass; never confirm; ignore the caller's recovery sentence; revert the create path to
the `— none —` recovery; apply without confirming; drop the disabled gate on Create; satisfy the
required-field gate unconditionally; swallow the `buildContainer` error; make the membership
`<select>` inert; list issues with raw ids.

NOT in U6d, with owners — all four filed as **#839**: editing an existing container's
`exitWhen`/`items`/`timeout`/`join`/`batchCount`, and DRAGGING a node into a box, both **U23**, which
owns container-config forms and the domain-container↔RF-`parentId` drop mechanics (escape route
meanwhile: `deleteContainer` un-groups the children, then re-create); the within-kind ordinal on the
BOX itself, so "stage 2" in the picker identifies a rectangle as well as an option; and the inline
"delete this loop?" offer #748 raised. Elsewhere: grouping N nodes at once (**U21** multi-select) and
undo (**U17**).

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

## U16 — pipeline params + outputs AUTHORING (AS BUILT, 2026-07-31)

A pipeline's typed contract could be declared only through the API. `toVersionBody` carried
`params`/`outputs` forward from the version the canvas was opened on, for want of an editor — so a
pipeline authored on the canvas could never have a param at all: `${params.x}` had nothing to
resolve and a trigger had nothing typed to bind its values to. Closed here for PARAMS and OUTPUTS.

| Piece | Lives in |
|---|---|
| Name gate, default advisory, field parse/format, `withRequired` | `pages/pipeline/paramRules.ts` |
| `params`/`outputs` working state + add/update/remove actions | `pages/pipeline/canvasStore.ts` |
| `PipelinePanel` / `ParamRow` / `OutputRow` | `pages/pipeline/PipelineCanvas.tsx` |
| Card + checkbox + advisory styling | `index.css` — `.contract-section`, `.contract-row`, `.contract-check`, `.contract-advisory` |
| Browser coverage | `e2e/params-authoring.spec.ts` |

Decisions worth not re-deriving:

- **It lives in the property panel's NOTHING-SELECTED slot, not the bottom-pane tab the row above
  names.** That pane does not exist yet, and building one is shell work this ticket does not own.
  Clicking the canvas background to edit the pipeline itself is the ADF pattern and needs no new
  chrome. Move it when the bottom pane lands.
- **Variables/globals are deferred because there is nothing to author.** `PipelineVersionSchema` has
  no `variables` or `globals` field; adding one is a doc-model change, not a UI ticket.
- **`toVersionBody` no longer reads `loaded` at all.** Every field of the save body now comes from
  the store. This is the third field to make that move (`containers` was #746) and the failure is
  identical each time: a carry-forward that outlives its "no UI yet" premise silently DISCARDS the
  operator's edit at the moment they save it.
- **The save gate and the advisory are deliberately different things.** Duplicate/empty names GATE
  Save, and the rules come from parsing `NewPipelineVersionSchema.shape.params/outputs` — the
  server's own field — so the message IS the server's and the two cannot drift. A type-mismatched
  `default` only ADVISES: the write path accepts any `default` (`z.unknown().optional()`), so gating
  on it would leave an imported pipeline that already holds one permanently unsaveable — the exact
  one-way trap #748 closed, re-created by the check meant to help. Tell the truth; do not bar the exit.
- **A REQUIRED param's default IS read at run time.** `resolveRunParams` tests
  `hasOwnProperty(p, 'default')` BEFORE `p.required`, so the precedence is
  override > default > required-throw, and a required param carrying a default is never asked for a
  value. The panel therefore shows the default field whenever a default EXISTS, required or not.
  Hiding it (on the opposite belief) made an API-minted default invisible, un-editable and immune to
  the advisory, while the panel asserted the reverse of what the engine does. `paramRules.test.ts`
  now cross-checks every advisory verdict against `resolveRunParams` itself rather than against a
  comment.
- **`default` and `optional` are ABSENT-means-something fields.** Ticking Required DELETES the
  stored default (`withRequired`); blanking the field REMOVES the key rather than writing
  `undefined`, which `hasOwnProperty` would read as "the default is undefined". Same for an output's
  `optional`, where absent means required.
- **Rows are index-keyed, so the default draft resyncs on param IDENTITY, not on its formatted
  text.** A removal shifts later params up into a row that still holds the departed row's draft; with
  two defaults that format alike, a string compare misses it and the next blur writes onto a param
  the operator never edited. `map`/`filter` preserve element identity for untouched rows, so a new
  object arrives exactly when the row's param is replaced.

Deferred, with tickets rather than silence: a `json` param whose default is a string gets no
advisory (runtime accepts any value for `json`, so it is a UX heuristic, not a defect);
pipeline-level `outputs` get NO static validation at all, because `validatePipelineDoc`'s `Pick`
excludes them; and the write path has no type-vs-default consistency check.

## U11 — the run monitor's node-state overlay (AS BUILT, 2026-07-31)

The run page showed a table of node activity folded from the event log alone, with its own lossy
status vocabulary (`running|retrying|waiting|success|failure`). Being doc-free, it structurally
could not show a node that never dispatched — no event was ever appended for one — and `skipped`
was not in its vocabulary at all. The engine's `createEngine(doc).projectRunState(events)` is the
SSOT for what a node's status IS, and it needs the version DOC, which the page had no way to
reach: a `Run` carries only `pipelineVersionId`, and every version route is pipeline-scoped.
R1 closes that, and this draws the result on the graph.

| Piece | Lives in |
|---|---|
| R1 route + its ownership/invariant posture | `server/src/routes/runs.ts` — `GET /api/runs/:id/detail` |
| Wire contract (shared FE/BE) | `shared/src/schemas/run-detail.ts` |
| Engine fold + abandon-on-hole + status→tone maps | `web/src/pages/runs/runProjection.ts` |
| Doc + state → React Flow arrays (pure) | `web/src/pages/runs/runFlow.ts` |
| The read-only canvas + its two node components | `web/src/pages/runs/RunCanvas.tsx` |
| Shared geometry lifted out of the author canvas | `web/src/pages/pipeline/containerLayout.ts` — `containerHandles`, `containerAriaLabel`, `UNMEASURED_NODE_SIZE` |
| Tones (no new palette vars) | `index.css` — `.run-canvas`, `.run-node-*`, `.run-container-*` |
| Browser coverage (first spec to drive a REAL run) | `e2e/run-overlay.spec.ts`, helpers `seedVersion`/`fireAndSettle` in `e2e/support/seedDoc.ts` |
| Lazy boundary + the measured bundle cost | `pages/runs/RunGraph.lazy.ts`, numbers in `vite.config.ts` |

Decisions worth not re-deriving:

- **A separate renderer, not `readOnly` on `FlowCanvas`.** Three things make the shared-component
  route wrong rather than merely inelegant. (1) `loadVersion` is LOSSY BY DESIGN — it lowers nodes
  through the catalog and DROPS an edge whose endpoint resolves to neither a node nor a container,
  which is right for an author seeing the contract a save would mint and wrong for a monitor: the
  projection folds over the SERVER's doc, so an edge the store silently removed would leave a node
  marked `skipped` with no visible cause, i.e. the overlay disagreeing with the graph beneath it.
  (2) React Flow's interaction flags never reach a custom node's own DOM, so a `readOnly`
  `FlowCanvas` would still render the container's ✕ delete button — a live graph EDIT on a monitor.
  (3) Every future author affordance would have to remember the monitor. What must not diverge is
  shared as CODE instead: geometry, the edge vocabulary and its one marker def set, port ids, the
  label rule, and the CSS classes.
- **"Not projected" is a real state, distinct from "pending".** The engine's seed holds NO nodes
  until `run.started` folds, so projecting mid-replay would draw a finished run as a graph on which
  nothing ran. The overlay is withheld until the stream has replayed, and the reason is on screen.
  This is also where R1's missing `events` member is paid for: the overlay's only source is the
  socket, so a stream that never connects gets a stated reason rather than a blank graph.
- **An unparseable event ABANDONS the projection.** `runSummary.ts` skips one, which is safe for a
  table of independent rows and not for a state machine — drop `run.started` and every later
  `withNode` spreads an `undefined`, which `createEngine`'s own docblock names as a TypeError out of
  the pure reducer. A hole folded into a state machine is not a slightly-wrong picture, it is an
  arbitrary one.
- **Ten statuses, five hues, and no information lost.** The tones reuse the palette variables the
  run table's pills already use (`index.css` records the same commitment for the edge hues), so the
  canvas, the pills and the edges cannot come to disagree; and the exact status WORD is rendered as
  text on the node, so grouping the four parked statuses into one `holding` amber collapses nothing.
  `skipped` is grey and DASHED, matching the settled skipped-edge encoding. On a NODE the status is
  carried by `outline`, never `border-color`, so it cannot compete with `.flow-node.selected`; a
  CONTAINER does use `border-color`, which is safe only because a container can never be
  `selectable` (U6c) and so has no selection ring to compete with. The tone→rule correspondence is
  asserted in BOTH directions by `palette.test.ts` — a tone with no rule would paint nothing, and a
  rule with no tone is how `.run-container-holding` survived this ticket's first cut.
- **The U0 spike's palette non-injectivity is now REAL on one surface, and is being lived with for
  now.** The spike warned that the mapping is not injective across surfaces and that U11 would
  inherit it: `--accent` is `completion` on an edge and `running` on a node, so a blue completion
  edge can now run into a blue running node on the SAME canvas. Not taken here, deliberately —
  the two are different MARK TYPES (a 1.5px stroke vs a node outline) and the node states its status
  in words, so nothing is conveyed by that hue alone. The semantic layer the spike pre-authorised
  (`--status-running: var(--accent)` and friends) is the fix if it ever does read as ambiguous, and
  it is a rename, not a re-design. The `--muted` half of the same collision WAS resolved, by making
  a skipped node dashed exactly like a skipped edge.
- **Tones are `Record<NodeRunStatus, …>`, not a `satisfies` array** — the day the engine adds a
  status, this fails to compile instead of falling through to a default hue. (The engine's own
  `TERMINAL_NODE` comment records that a `satisfies` array was probed for this and does NOT catch a
  forgotten member.)
- **The overlay is loaded on demand, and the epic's bundle budget is a real gate.** Importing the
  run canvas statically from the eagerly-routed `RunDetailPage` put `@xyflow/react` back in the
  ENTRY chunk (111.09 → 182.14 kB gzip) and silently undid #698's route split — no test caught it,
  which is why the numbers are now recorded in `vite.config.ts` for this ticket as for every prior
  one. Final: entry 122.62 kB gzip. The residual +11.53 kB is the engine reducer, which lands in the
  entry because eager code already imports the engine barrel; the lever is a subpath export, judged
  not worth a package-boundary change today.
- **`replayComplete`, not `phase === 'closed'`.** `closed` is set by ANY orderly close, including one
  arriving mid-replay (a graceful shutdown, a proxy close frame, or the server's own send-failure
  path, which tears down and then still closes 1000). Gating on it would present a TRUNCATED log as
  authoritative — a finished run drawn with one node stuck `dispatched` and the rest `pending`,
  indistinguishable from the truth. `useRunStream` now tracks the server's `replay_complete` marker.
- **Node identity is preserved across folds, and that is correctness, not performance.** React Flow
  rebuilds a node's internals for any user node that is not reference-identical to the previous one,
  and `parseHandles` leaves `handleBounds` undefined for a node stating neither `measured` nor
  `handles`, so `getEdgePosition` returns `null` and every edge touching it renders as NOTHING until
  the next measurement. Since the projection returns a fresh `RunState` per event, the first cut
  blinked every edge on every event of a live run — invisible to the e2e, which opens an
  already-terminal run. `mergeRunNodes` keeps the object when nothing rendered changed and carries
  the measurement forward when it did.
- **No incremental fold, deliberately** (#849). The suffix fold was written and tested equivalent to
  a cold refold, then removed: a ref cannot be read or written during render, and a discarded React
  render would fold its events into the carry twice — silently, into a state machine. An effect
  trades that for a `setState` cascade. The honest fix belongs with the page's two pre-existing
  full-log folds, not here.
