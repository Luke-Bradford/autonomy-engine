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
