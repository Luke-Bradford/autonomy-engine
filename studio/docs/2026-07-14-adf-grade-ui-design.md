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
| **U16** | **Params/Variables/Outputs/Globals AUTHORING** (T14) — the bottom-pane tab to *define* what the `${}` flyout references; routed through `toVersionBody` (currently discards them) | Author |
| **U17** | **Undo/redo** (T14) — reversible-command store; land EARLY (before U6*) | Author |
| **U18** | **Save-vs-Publish reconciliation** (T14) — command-bar states: DB-only `Save→v` vs git-connected `Save/Commit→branch` + `Publish→active` + CAS-stale "pull first"; Manage **Git** section | Author/Manage |
| **U19** | **Outcome-by-source-handle** (T14) — colored/labeled handles per ActivityDefinition (operational success/failure/completion/skipped; control `true/false`/case), NOT the retro dropdown. **Carries two debts from #1 F1** (which settled the engine schema but deliberately shipped no rendered change — no browser-verify available headless): (1) the canvas dropdown is pinned to `AUTHORABLE_EDGE_ON = ['success','failure','completion']` in `PipelineCanvas.tsx`, so the engine routes `skipped` but nothing can author it; (2) `<select value={edge.on}>` has no `<option>` for a `skipped`/`branch` edge (savable via API or git import), so it renders as something other than the persisted value — a silent lie about state; (3) `FlowCanvas.tsx`'s `label: e.on` renders a branch edge as the literal `"branch"`, dropping the `true`/`false`/case label that IS its routing key. Retiring the dropdown for handles fixes all three; if U6a lands first, it should render a disabled `<option>` for a non-authorable value and label branch edges by `branch`, not `on`. | Author |
| **U20** | **`call_pipeline` authoring** (T14) — target-pipeline picker + param-map + call-graph validation + Monitor child-run drill | Author/Monitor |
| **U21** | copy/paste + multi-select + marquee + group move/delete (T14) | Author |
| **U22** | version-history / picker (open/compare/restore; trigger bind-to-version) (T14) | Author/Manage |
| **U23** | container-config forms (loop `exitWhen`/`timeout`; foreach `items`/`batchCount`; bounce caps) + domain-container↔RF-parentId mapping + drag-into-container drop mechanics (T14) | Author |
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
pipeline id (`#/author/pipelines/:pipelineId` — **U4**; opening the canvas is still local state
inside `PipelinesPage`), version id (**U22**), selected node id (**U7**), monitor filter tab
(**U10**).

Deliberately NOT in U2, from its own ticket row and the Shell description:

- **The rail's settings entry** (`#/settings`) — the Shell section lists the rail as
  "theme + settings", but the Settings surface is **U15**. U2 ships the theme control only.
- **`uiStore` is untouched.** The U2 row names it, but U1 already added the theme slice and the
  pane width/collapse state it would otherwise hold belongs to **U3**. No second consumer exists
  yet, so the store stays a singleton with prop injection rather than moving behind a context.
- **Legacy MVP-path redirects** — **U3r**, now BUILT (see the U3r section above), which is why it
  landed immediately after U2 and before U3: until it did, an old bookmark hit the catch-all and
  landed on Home, and `#/runs/:id` lost the run id rather than resolving to that run.

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
