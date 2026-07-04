# UI-3b — Center zone becomes selected-lane detail (#258) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`)
> syntax for tracking. This is the "cohesive multi-panel build" the prevention history warns
> about (prevention-log #13/#14) — staged slices, each browser-verified incl. temporal pass +
> selection-survives-tick interaction driver. Do NOT ship fragments into the old panels.

**Goal:** Restructure the control-room center zone from the pre-redesign stack (per-repo NOW-card
grid + inline RECENT SESSIONS + shared multi-repo ACTIVITY panel) into the approved design: the
center shows a **single selected lane's** work. Cross-repo "what's happening everywhere" is
answered by the fleet rail + right-rail org activity; the center is single-lane by design. Spec:
`docs/superpowers/specs/2026-07-03-control-room-redesign-design.md` (IA table + object inventory).

**Architecture:** Selection is client UI state (`SELECTED` = a `repo\x1flane` key), but the
*default* selection ("most-recently-active lane") comes from **server truth** — new `lanes.active`
+ `lanes.active_at` fields on `build_repo_state` — to honour the dashboard rule "pages render
server truth; no client-side state invention." The fleet rail (`renderRepos`) makes the repo /
lane **header** the click-to-select target (NOT a role-row restructure — role rows stay
byte-identical, see Task 2); the selection highlight is baked into the rendered markup (so the
`#164/#238` skip-unchanged signature guard stays consistent and a click triggers a re-render the
same way `setView` does). Selection is exposed through a shared accessor now (`laneKey`,
`selectedLane`) so slices 2–4 re-point the center panels (`renderFocus`, `renderActivity`,
`renderHistory`) at the same selected lane and delete the multi-repo stack.

**Codex CP1 (2026-07-04) — findings folded in:** (1) `active` is a *declared* lane only —
`lane_of_role` returns an undeclared lane verbatim (dispatch refuses it by omission), so an
undeclared/invalid role-lane must degrade to `default`, never display as selectable (fail-safe,
not fail-open). (2/3) compute `active` from the **authoritative newest session** the repo already
parses (`latest_session`/`current_session`), NOT the capped `recent_sessions` history; expose
`active_at` (the newest session epoch) so the client picks the most-recent repo deterministically
instead of guessing a timestamp field. (4) a shared `selectedLane(repos)` accessor is defined in
Slice 1 so later renderers share one contract. (5) lane rows carry `data-lane-key`
(`encodeURIComponent`, attribute-safe — repo/lane names are repo-controlled strings) and use
**event delegation**, never an inline `onclick` with a control-separator key. (6) selected-lane
**fallback** (repo/lane vanished) is a Slice-1 invariant, not deferred — persistent selection
demands it now. (7) single-lane repos are NOT restructured (role rows stay byte-identical); only
the header becomes selectable. (8) verification asserts the guard neither skips a needed
re-highlight nor thrashes on an unchanged tick.

**Tech Stack:** Python 3 stdlib only (`lib/dashboard_state.py`); vanilla JS in
`lib/dashboard_page.html`. No build step, no framework.

## Global Constraints

- Python 3 stdlib only; macOS bash 3.2 floor is irrelevant here (no shell changes) but tests stay
  `shellcheck`-clean where any `.sh` is touched (none expected).
- State builders stay **pure + total**: `lanes.active` never raises; a repo with no sessions or a
  malformed `lanes:` block degrades to the default lane (or `main`), never an exception
  (prevention-log #12 — a pure projection over cached data must be total).
- **Selection survives SSE ticks** (prevention-log #14 class + #202 dirty-control survival): a tick
  re-render must not drop or reset the operator's selection. The highlight is part of the rendered
  markup and `SELECTED` is a module-global, so a re-render re-derives the same highlight.
- **Skip-unchanged guard integrity** (prevention-log #14): `renderRepos` already carries the
  `#164/#238` signature guard. Selection state must be *inside* the signature (baked into markup),
  never an out-of-band `classList` toggle that the guard can't see — or the guard would skip a
  needed re-highlight, or thrash node identity.
- **Temporal pass** (prevention-log #13): every slice runs the dashboard skill's idle 12s observer
  (steadyStateCLS < 0.01, panels `innerHTMLStable`, ≤1 element rebuild) — a static snapshot can't
  catch flicker.
- Repo-agnostic; degrade-to-truth; no target-repo-specific values.

## Slice breakdown

- **Slice 1 (this PR): lane-row selection foundation.** `lanes.active` server field + fleet-rail
  lane rows become explicit + click-to-select + highlighted + selection survives ticks. Center
  still renders the old stack (no deletion yet) — this is the safe, additive prerequisite.
- **Slice 2: center focus band → selected lane only.** `renderFocus` renders just the selected
  lane's card (retiring the NOW-card grid); controls that lived on every NOW card move to the
  fleet-rail lane-row icon cluster / role popover so they stay reachable for every repo.
- **Slice 3: center activity + history → selected lane.** `renderActivity` / `renderHistory`
  scope to the selected lane; RECENT SESSIONS moves behind the lane-history popover (#148 data);
  delete the shared multi-repo ACTIVITY panel. Leave the phase-track slot for UI-4 (#187).
- **Slice 4: cleanup + empty/degraded states** for "no lane selected" / "selected repo removed"
  (selection falls back to the new default), and remove now-dead CSS/markup.

Each slice is its own PR, browser-verified, merged, then `#258` reset to Ready for the next.

---

### Task 1 (Slice 1, Python): `lanes.active` — most-recently-active lane

**Files:**
- Modify: `lib/dashboard_state.py` (`build_repo_state`, the `lanes` dict ~line 1720)
- Test: `tests/test_dashboard_state.py` (new case near the existing lane-topology tests)

**Interface:**
- `lanes.active` — the lane of the **authoritative newest session** the repo already parses
  (`current_session`, from `latest_session(logdir)` — NOT the capped `recent_sessions`). It is
  `lane_of_role(config, session_role)` **only when that lane is a declared name**; otherwise
  (no session, no role, undeclared lane, or malformed block) it degrades to `lanes.default`. Never
  raises, never returns an undeclared lane (fail-safe — an undeclared lane must not read as
  selectable). Single-lane repos always report `active == "main"`.
- `lanes.active_at` — the newest session's epoch (`current_session.updated_at` or
  `started_epoch`), or `None`. The client uses it to pick the most-recently-active repo across the
  fleet for the *default* selection, deterministically (Codex CP1 finding 2 — no guessed field).

**TDD:**
- [ ] Failing test: newest session's role is in declared lane `B` (older session in lane `A`) →
      `lanes.active == "B"`, `lanes.active_at == <newest epoch>`.
- [ ] Failing test: no sessions → `lanes.active == lanes.default`, `lanes.active_at is None`.
- [ ] Failing test: newest session's role maps to an **undeclared** lane → `active == default`
      (fail-safe, not the verbatim undeclared lane).
- [ ] Failing test: malformed `lanes:` block → `active == "main"` (degrade-to-truth, no raise).
- [ ] Implement: derive `active`/`active_at` from `current_session` + `lane_of_role` guarded by
      the declared `names`; add both to the `lanes` dict. See it pass.

### Task 2 (Slice 1, JS): fleet-rail lane rows become click-to-select

**Files:**
- Modify: `lib/dashboard_page.html` (`renderRepos`, plus a small `selectLane` handler + CSS)

**Design (minimal, additive — role rows unchanged):**
- The **selectable target is the header**, not a role-row restructure (Codex CP1 finding 7):
  single-lane repos keep their flat role list byte-identical; the repo card's `.repo-h` header
  becomes the click target for the implicit `main` lane. Multi-lane repos already render `.lgrp-h`
  lane sub-headers — those become the selectable lane targets. No `upe`/`qreset`/`agox`/`data-g`
  ticker selector or role-row layout changes.
- Shared selection contract (Codex CP1 finding 4), all in Slice 1:
  - `laneKey(repoPath, lane)` → the stable `repoPath\x1flane` key.
  - `SELECTED` module-global holds the key; `selectedLane(repos)` accessor resolves it to
    `{repo, lane}` or, if the key is unset **or no longer present** (repo/lane vanished — Codex CP1
    finding 6, a Slice-1 invariant), to the fleet default: the repo with the greatest
    `lanes.active_at` (ties → first), lane = its `lanes.active`. `selectedLane` also re-writes
    `SELECTED` to the resolved key so it self-heals.
- Lane targets carry `data-lane-key="${encodeURIComponent(key)}"` (attribute-safe — repo/lane are
  repo-controlled strings) and selection uses **event delegation** (one listener on `#repos`),
  never an inline `onclick` with a control-separator key (Codex CP1 finding 5). The delegated
  handler sets `SELECTED` from the clicked target's `data-lane-key` and calls `renderRepos(LAST.repos)`
  (the `setView` re-render pattern).
- The selected header gets a `sel` class **in the rendered markup** so the `#164/#238` signature
  sees it: changing `SELECTED` changes the signature → the guard re-renders; an unchanged tick
  keeps the signature → the guard skips, and the highlight persists via node identity (Codex CP1
  finding 8).
- Selection highlight uses the design token `--acc` (left-edge accent / raised bg), no new color
  scheme.

**Verification (browser loop, multi-lane fixture):**
- [ ] Build a throwaway multi-lane `/tmp` repo (`.autonomy/config.yaml` with 2 lanes + var session
      logs) — repo-alpha is single-lane, so selection-across-lanes needs a multi-lane fixture (do
      NOT edit the committed fixture). Also verify repo-alpha still renders (single implicit lane).
- [ ] `new_page` → snapshot: lane rows render; the default-selected lane has the `sel` highlight.
- [ ] `click` a different lane header → snapshot: `sel` highlight moves; console ZERO errors.
- [ ] Role-row regression: repo-alpha role rows + tickers (`upe`/`qreset`/`agox`/`data-g`) render
      byte-identical to pre-change (Codex CP1 finding 7).
- [ ] Idle temporal pass (12s observer): `steadyStateCLS < 0.01`, `repos` panel `innerHTMLStable`,
      ≤1 rebuild — selection highlight is stable across ticks.
- [ ] Guard-skip assertion (Codex CP1 finding 8): select a non-default lane, `await` ~6s (2–3 SSE
      polls) on unchanged data, assert the `sel` highlight is STILL on the chosen lane AND the
      `#repos` node identity is preserved (guard skipped, no thrash) — prevention-log #14 / #202.
- [ ] Fallback: with a `SELECTED` key that no longer exists in `LAST.repos`, `selectedLane` resolves
      to the fleet default (no blank selection).

### Task 3: gates + PR

- [ ] `bash tests/run_all.sh` green; `shellcheck -S warning` clean (no `.sh` touched, but run the
      configured set anyway).
- [ ] Pre-flight-review (`.claude/skills/engineering/pre-flight-review.md`), incl. the dashboard
      browser-verify item J.
- [ ] Codex checkpoint 2 before the first push.
- [ ] PR (security-model section: pure additive read-side field + client UI state; no new
      endpoint, no control write, no auth surface change).
- [ ] Resolve every review comment; `safe_merge.sh` once APPROVE-on-latest + CI green.
- [ ] `#258` NOT closed by this PR (slices 2–4 remain) → board reset to **Ready**.

---

## Slice 2 breakdown (post-Slice-1)

Slice 2's goal ("center focus band → selected lane only") couples two moves the plan named
together: (a) relocate the per-repo controls that live on every NOW card into the fleet-rail
so they stay reachable for **every** repo, and (b) collapse the center focus band to the
**selected** lane's single card. (b) cannot land before (a) or the non-selected repos' controls
vanish ("controls must remain reachable for every repo"). So Slice 2 splits into two safe,
each-shippable sub-slices — **2a relocates controls (additive, nothing removed); 2b collapses the
center + removes the now-duplicated card controls.** 2a is the enabling prerequisite and this PR.

### Slice 2a — fleet-rail lifecycle icon cluster (this PR)

**What:** the mockup's per-repo/worktree header icon cluster (`git show
2f21d4d:docs/superpowers/specs/assets/2026-07-03-control-room-mockup.html`, the `.ibtn` buttons on
each repo header) — lifecycle controls (start / graceful-stop / resume / hard-stop) rendered as
compact icon buttons on the fleet-rail **repo header** (`.repo-h`), wired to the EXISTING
`control()` fn + `CTOKEN`. Purely **additive**: the center NOW cards keep their controls this
slice; 2b removes those once the center collapses. Lifecycle is a per-**supervisor** (per-repo)
operation, so the cluster lives on the repo header, not per-lane or per-role. Model/effort pencil
+ history clock icons are later sub-slices (2a is lifecycle only — the highest-value reachability).

**Codex CP1 findings (folded in 2026-07-04):**
1. `graceful-stop` is a **label**, not an action — the action is `pause` (existing `cbtn(repo,
   "pause","graceful-stop","warn")`). Icons call `control(repo,"pause","graceful-stop")` etc.;
   tests assert the ACTION strings `pause`/`resume`/`stop`/`start`.
2. `.ibtn` **already exists globally** (dashboard_page.html:67; used by the theme + config header
   buttons). REUSE it — do NOT redefine from the mockup (regression risk). Add only scoped
   `.ibtn.go/.warn/.danger:hover` colour variants (mirroring `.cbtn`'s `--fg` token ladder); base
   `.ibtn` stays muted so the header buttons (no colour class) are unaffected.
3. Slice 2b must NOT remove model/effort controls from the NOW cards — 2a moves only lifecycle.
   Model/effort relocation is its own later sub-slice; 2b removes only the lifecycle duplicate.
4. Header flex: `.repo-h .badge{margin-left:auto}` pushes the badge right — place the cluster
   **after** the badge span so it sits at the far-right action position (not beside the repo name).
5. Do NOT claim exact output parity with `controls()` for `needs-setup`/`missing` — those render a
   setup NOTE on the card; the rail cluster simply emits nothing for them (fine, but not "parity").
6. Selection-safety holds only for real `<button>` — browser check must click the nested `<svg>`/
   `<path>`, not just the button surface (a nested SVG target must still bubble to the button).

**Files:**
- Modify: `lib/dashboard_page.html` (`renderRepos`: emit the cluster in `.repo-h`; new
  `lifecycleCluster(r,st)` helper mirroring `controls()`'s status→button ladder as icons; `.ibtn`
  CSS from the mockup).
- Test: `tests/test_dashboard_page.py` (or the established HTML-render test seam) — assert the
  cluster markup renders per status.

**Design (minimal, additive):**
- New helper `lifecycleCluster(r,st)` returns the icon-button set for the repo's dispStatus, EXACTLY
  mirroring `controls()`'s existing status ladder so the same actions are offered (no new control
  semantics): `working`/`idle` → graceful-stop (⏸) + hard-stop (⏹); `paused`/`stopping` → resume
  (▶) + hard-stop (⏹); `stopped` → start (▶); `needs-setup`/`missing`/`error` → none. Each button is
  `<button class="ibtn ..." onclick="control('${encAttr(repo)}','${action}','${label}')" title="...">`
  with an inline `<svg>` glyph — reuses `control()` verbatim (same `CONFIRM` prompts for
  stop/start, same `CTOKEN`, same `toast`). No new endpoint, no new action string.
- **Selection-safe:** the delegated `#repos` click listener already early-returns on
  `e.target.closest("button,a,select,input,details,summary")` (dashboard_page.html ~L1180), so an
  icon-button click never triggers lane selection. Assert this stays true (the buttons ARE
  `<button>`).
- **Skip-guard integrity (prevention-log #14):** `renderRepos`'s `_reposKey` guard normalizes only
  `.qreset`/`.agox` volatile spans. The lifecycle glyphs are **static per status** (no time content),
  and `st` already participates in the markup (the `badge` token) — so a status change already
  rebuilds and the cluster follows; an idle tick keeps the signature and the cluster persists via
  node identity. No new volatile content enters the signature; the guard stays correct without
  change.
- **Repo-agnostic / no data invention:** renders only from `dispStatus(r)` + `r.path` (already in
  state); no new server field. `needs-setup`/`missing` render the existing "run setup_worktree.sh"
  note is NOT duplicated here (that stays on the center card) — the cluster simply emits nothing for
  non-manageable statuses, matching `controls()`.

**TDD:**
- [ ] Failing test: a repo with dispStatus `working` renders a graceful-stop + hard-stop icon button
      in `.repo-h`, each carrying an `onclick="control(...)"` with the correct action string.
- [ ] Failing test: `stopped` → a single start icon button; `paused` → resume + hard-stop.
- [ ] Failing test: `needs-setup` / `missing` → no lifecycle icon buttons in the header.
- [ ] Implement `lifecycleCluster` + `.ibtn` CSS + wire into `.repo-h`. See it pass.

**Verification (browser loop):**
- [ ] `new_page` repo-alpha (single-lane) + the multi-lane `/tmp` fixture → snapshot: lifecycle
      icons render on each repo header; ZERO console errors.
- [ ] Click a lifecycle icon on a non-selected repo → the `/api/control` POST fires (200) AND the
      lane selection does NOT change (delegated listener ignored the button click).
- [ ] Selecting a lane by clicking the header text still works (icon buttons don't swallow it).
- [ ] Role-row + tickers render byte-identical to pre-change (icons live only in the header).
- [ ] Idle temporal pass (12s observer): `steadyStateCLS < 0.01`, `repos` panel `innerHTMLStable`,
      ≤1 rebuild — icons are static, no flicker.

### Slice 2b — collapse center focus to selected lane (SHIPPED, PR #265)

`renderFocus` renders only `selectedLane(repos)`'s card; removed the now-duplicated **lifecycle**
controls from the card (the dead `controls()`/`cbtn()` renderer deleted — `.cbtn` CSS kept for
`modelCtl`); model/effort stay on the card (CP1 finding 3). The "Now" header names the shown lane
(truthful over a single card). Codex CP2 caught a P1: `selectLane` must re-render `renderFocus`
(not just the rail) so the center doesn't lag a click — fixed in the same PR. RECENT SESSIONS +
multi-repo ACTIVITY handled in Slice 3.

## Slice 3 breakdown (post-Slice-2b) — split 3a / 3b

Like Slice 2, Slice 3 bundles two moves of differing readiness: (3a) scope the ACTIVITY panel to
the selected lane — a clean render-scope collapse mirroring 2b; and (3b) move RECENT SESSIONS
behind the mockup's lane-history clock-icon **popover** (#148 data) — a NEW interaction affordance
that is design-coupled (popover shape from the mockup). 3a ships first (no new UI pattern); 3b is
deferred to a pass that can confirm the popover design.

### Slice 3a — activity panel scopes to the selected lane (SHIPPED, PR #266)

New shared accessor `selectedRepoOf(repos)` (resolves via `selectedLane`, self-healing
default/fallback) — `renderFocus` + `renderActivity` scope to the SAME repo through it.
`renderActivity` feeds only `[selectedRepo]` into `reposWithActivity` + `tickNarration` (live trace
when streaming, own heartbeat when idle, else empty), killing the jumbled multi-repo stack;
tree/timeline/tally tabs unchanged. `selectLane` re-renders `renderActivity` too (synchronous on
click). Codex CP2: no findings.

### Slice 3b — RECENT SESSIONS → lane-history popover (this PR)

**Design confirmed against the mockup** (`git show
2f21d4d:docs/superpowers/specs/assets/2026-07-03-control-room-mockup.html`). The mockup fully
specifies the pattern — it is the design SSOT that Slice 2a's icon cluster was already built from,
so this is a render+interaction build, not a design gate:

- **The popover** (`#pop`, `class="pop"`): a `position:fixed` panel, `display:none` until `.open`,
  with an `<h4>` header and `.hrow` rows (dot/outcome chip · role chip · `time · dur · tok` meta ·
  outcome). Closes on outside-click, Escape, **and on every SSE tick** (see truth notes). The
  mockup's header reads "main lane — last sessions", but the rows are the **repo's** unfiltered
  `sessions` (no lane field exists on a session — CP1 P1-a). Naming a lane over cross-lane rows
  would be a #234-class display lie, so the header names the **repo** ("`<repo>` — recent
  sessions"), which is truthful for both single- and multi-lane repos. Deviating from the mockup
  wording here is deliberate: truth over mockup.
- **The trigger** (`.ibtn hist`): a clock glyph icon button. The mockup places it on lane rows /
  the detail header; since #269 (UI-3c) owns the polished detail-header presentation and runs
  **after** this slice, 3b anchors the trigger on the **selected-lane focus card** (`renderFocus`'s
  `.fc-top`) — the card IS the selected lane, so its clock opens that lane's history. #269 then
  re-homes/re-styles it into the detail header. This keeps 3b's surface minimal and non-overlapping.

**Scope decision (consistency with 3a):** Slice 3a scoped ACTIVITY to the selected **repo**
(`selectedRepoOf`), NOT lane-role-filtered — `recent_sessions` carries `role` but no `lane`, and
adding a server-side lane field is out of this client-only slice. 3b mirrors 3a: the popover shows
the **selected repo's** `sessions` (the same `#148` data `renderHistory` already renders), so the
two center panels stay scoped identically. (A future slice can lane-filter both if a `lane` field
lands on sessions server-side; not now.)

**Client-only — no `dashboard_state.py` change.** Reuses the existing per-repo `r.sessions` +
`histRow`.

#### Task 3b.1 (JS/HTML): the lane-history popover + card trigger, delete inline RECENT SESSIONS

**Files:**
- Modify: `lib/dashboard_page.html` — new `#pop` popover element; `laneHist(repo)` renderer +
  `openLaneHist(anchor)` / close wiring; `.hist` clock button in `renderFocus`'s `.fc-top`;
  `.pop`/`.hrow` CSS from the mockup; **delete** the inline `Recent sessions` section header +
  `<div id="history">`, the `renderHistory` fn + its call site (`main` render pipeline line ~1250),
  and `HIST_OPEN` (the inline `<details>` expand-state, now dead).
- Test: `tests/test_dashboard_server.py` — new `TestLaneHistoryPopover` asserting the served HTML.

**Design (minimal):**
- `laneHist(repo)` returns the popover BODY: `<h4>` naming the **repo** (`dispName(repo.name)` —
  CP1 P1-a) + `histRow`-rendered `.hrow` rows for `repo.sessions` (reuse the existing `histRow`;
  keep `_OUTCLS`). Empty → a "no sessions yet" `.q-sub` line (mirrors `renderHistory`'s empty copy).
  Pure + **total** over `repo.sessions`; never raises (a repo with no `sessions`, or a `null` repo,
  yields the empty state, not an exception).
- The trigger is a `<button class="ibtn hist" onclick="openLaneHist(event,this)"
  title="Session history">` with the mockup's clock `<svg>`, placed in `.fc-top` **after** the model
  span so it sits at the row's action edge (mirrors 2a's badge-flex ordering). It passes the event
  (CP1 P1-c) so the handler can `event.stopPropagation()` — otherwise the document outside-click
  closer fires on the same click and the popover never opens.
- `openLaneHist(event, anchor)` is **total** (CP1 P2): `event.stopPropagation()`; if `#pop` is
  missing, or `LAST`/`LAST.repos` is falsy, or `selectedRepoOf(LAST.repos)` is null → no-op (never
  throw on a fresh load / no-repo / removed-repo state). Otherwise fills `#pop` via `laneHist(sel)`,
  positions it under the anchor (`getBoundingClientRect`, clamped to viewport like the mockup), adds
  `.open`.
- Close paths bound ONCE at load (not per render — CP1 P2-c, no listener leak): (a) a document
  `click` listener removes `.open` when the target is outside `#pop`; (b) a document `keydown`
  closes on `Escape`. Plus (c) **`render(s)` refreshes an OPEN `#pop` on every SSE tick** via
  `refreshLaneHist()` (CP1 P1-b): SSE ticks arrive every ~1–2s, so a blind close-on-tick would make
  the popover flash shut mid-read (verified in the browser loop). Instead, if `#pop` is open,
  re-resolve `selectedRepoOf(LAST.repos)` and re-fill from the fresh state; **close only if the repo
  vanished** (removed / no selection). This guarantees no stale DOM without shutting a readable
  popover — the anchor card doesn't move, so no reposition is needed on a content refresh.
- **Skip-guard interaction (CP1 P2-b, prevention-log #14):** the popover BODY is outside `_sig`
  (filled only on user open, never on a tick), so it has no signature cache to desync. The trigger
  IS inside `renderFocus`'s signature-guarded markup, so: the `.ibtn.hist` button is **static per
  status** (a fixed `<svg>` + fixed handler, NO volatile ticker cell like `qreset`/`agox`/`upe`), so
  it enters `_sig.focus` exactly once as part of the card markup and rides the existing write paths
  (idle `setHTML`, held-node `replaceWith`) — it introduces **no new out-of-band focus write path**
  and requires **no `_volRe` change**. A status change rebuilds the card (button follows); an idle
  tick keeps the signature (button persists via node identity).
- Deleting `renderHistory` removes a `setHTML("history",…)` write path — safe, the whole panel and
  its `_sig.history` key go away with it. No other panel references `#history` or `HIST_OPEN`.

**Build order (CP1 P3 — localize regressions within the one PR):** (1) add the inert `#pop` element
+ `.pop`/`.hrow` CSS + the three close paths (outside-click, Escape, tick-refresh) with `laneHist`
still unused; (2) add the `.ibtn.hist` trigger + `openLaneHist`; (3) delete the inline `Recent
sessions` section + `renderHistory` + call site + `HIST_OPEN`. Tests + browser verify after (3).

**Codex CP2 findings (folded in):** (1) `selectLane` must call `refreshLaneHist()` too — picking a
different lane while the popover is open otherwise shows the prior repo's history until the next
tick (stale DOM). (2) The clock `<button>` must `blur()` after opening — left focused inside the
single-card `#focus`, it becomes the held node in `renderFocus`'s preserve-focus partial path, which
with one card preserves the OLD card and resyncs `_sig.focus` to stale markup, freezing the focus
card's server truth while the popover is read. Extracted to prevention-log #16.

**TDD (string-assert seam, mirrors `TestReskinRenderMounts`):**
- [ ] Failing test: inline RECENT SESSIONS gone — `>Recent sessions<` and `id="history"` NOT in the
      served HTML; `function renderHistory(` NOT present; `HIST_OPEN` NOT present.
- [ ] Failing test: popover present — `id="pop"` + `class="pop"` element; `function laneHist(` and
      `function openLaneHist(` defined; `.pop`/`.hrow` CSS present.
- [ ] Failing test: card trigger present — an `ibtn hist` button wired to `openLaneHist(event,`
      inside the focus-card markup; the clock `<svg>` glyph present.
- [ ] Failing test: close wiring — an `Escape` keydown close + an outside-click close on `#pop`
      + the tick-close (`render` removes `#pop`'s `open` class — CP1 P1-b).
- [ ] Failing test: `openLaneHist` is total — guards `LAST`/`selectedRepoOf` before use (assert the
      source contains the null/no-op guard, not a bare `LAST.repos` deref) (CP1 P2).
- [ ] Implement; see all pass. `histRow` + `_OUTCLS` retained (now used only by the popover).

**Verification (browser loop — `.claude/skills/dashboard/SKILL.md`):**
- [ ] `new_page` repo-alpha (has session logs) → snapshot: NO inline "Recent sessions" section in
      the center; the focus card shows a clock icon; ZERO console errors; `/api/state` 200.
- [ ] `click` the clock → the popover opens with the repo's session rows (dot·role·meta·outcome);
      snapshot; ZERO console errors.
- [ ] `Escape` closes it; click the clock again → opens; click outside → closes.
- [ ] Tick-refresh (CP1 P1-b): open the popover, `await` an SSE tick → `#pop` stays OPEN with fresh
      rows (not flashed shut); a removed/vanished selected repo closes it fail-safe.
- [ ] Listener-once (CP1 P2-c): after several ticks, open+Escape still closes exactly once (no
      double-bound handler) — assert via a single close, no console error, `#pop` not re-toggled.
- [ ] Empty-history case: a `/tmp` fixture repo with NO session logs → the card clock opens a
      popover showing the "no sessions yet" empty line (not a blank/error).
- [ ] Idle temporal pass (12s observer, popover closed): `steadyStateCLS < 0.01`, `focus` panel
      `innerHTMLStable`, ≤1 rebuild — the clock icon is static, no flicker; `#pop` stays closed
      across ticks.

**Gates + PR:** `bash tests/run_all.sh` green; `shellcheck` clean (no `.sh` touched, run the set);
pre-flight-review incl. dashboard item J; **Codex CP2** before first push; PR (security model: pure
client-side render + a read-only popover over already-served `sessions` data; no new endpoint, no
control write, no auth surface). `#258` NOT closed (Slice 4 remains) → board reset to **Ready**.

### Slice 4 — cleanup + empty/degraded (post-3b)

With RECENT SESSIONS gone from the center inline flow, Slice 4 finishes the "center is fully
single-lane" cleanup: the "no lane selected" / "selected repo removed" empty-degraded states and
removal of any now-dead CSS/markup the earlier slices left. Its own PR.
