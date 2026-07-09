# Sequencer P3c — pipeline canvas minimap + search/filter (the navigation layer)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The `/pipeline` canvas gains two **navigation-only** aids for large
graphs — a **minimap** (a scaled overview with a draggable viewport rectangle
that tracks the canvas scroll) and **search/filter** (type an id/type/agent →
matching activities highlight, the rest dim, Enter jumps to the first match).
Both are pure client-side overlays over the document the page already holds
(`curDoc()`/`curEdges()`), read/navigation only — **P3c adds no write surface,
no new payload field, no new server action.**

**Architecture:** The page already holds a working copy of the pipeline
document (`WORKING`, rendered via `curDoc()`/`curEdges()`) and re-renders only
when the fetched payload bytes change (the `VIEWSIG` payload-signature guard) or
on an operator edit. Minimap + search are **module state + overlay renders that
hang off the SAME render path**: `SEARCH` (query) and `MAP_ON` (map visibility)
join `SEL`/`OBSERVED`/`COLLAPSED` as page state that survives a re-render;
`render()` re-applies both after it rebuilds `#dag`; the minimap redraws in the
existing `drawEdges` animation frame. A scroll updates only the viewport rect's
attributes (no DOM rebuild). Because both are driven by operator events (typing,
scrolling, dragging) and are re-applied only inside `render()` — which an idle
tick with an unchanged payload never calls — **an idle canvas rebuilds nothing**
(prevention-log #13, the temporal bar).

**Tech Stack:** Vanilla JS + inline SVG in `lib/pipeline_page.html` (existing
page conventions, no framework, no build step); the chrome-devtools browser
verify loop is the test oracle (there is no server/state/control change, so no
Python unit surface — see "Testing discipline" below).

## Global Constraints

Carried verbatim from the P1/P2/P3a/P3b plans — every task's requirements
implicitly include these:

- **macOS `/bin/bash` 3.2.57 floor** (no bash-4isms). **Python 3 stdlib only**
  (no PyYAML/yq/third-party). **`shellcheck -S warning` clean** across `start
  bin/*.sh bin/agents/*.sh tests/*.sh templates/autonomy-pack/qa/*.sh` — P3c
  changes NO `.sh` and NO `.py`, but run it. **Every executable body guarded**
  by the `BASH_SOURCE`/`$0` idiom (no shell touched). **Tests are genuine** —
  see "Testing discipline"; the browser loop exercises the real page.
- **Fail-safe, never fail-open** (SD-4). Navigation aids degrade to *absent*
  (no minimap / no highlight), never to a broken render: an unmeasurable graph
  hides the minimap; an empty query clears the filter; an invalid doc still
  renders its errors exactly as P3a/P3b.
- **Repo-agnostic** (SD-3): nothing target-specific in the page; the fixture and
  `/tmp` throwaways carry the test data.
- **Dashboard skill contract**: pages render server truth; **no client-side
  state invention** — every fact on screen still traces to the payload (the
  minimap draws only the geometry of already-rendered cards; search matches only
  the doc the page already holds). Ids/strings from the payload are UNTRUSTED:
  full-coverage `esc()`, delegated `data-*` listeners, no inline
  `onclick="f('${id}')"` handler strings (PR #358 security round). **No new
  `POST /api/control` action and no new endpoint** — P3c is read/navigation
  only, so the write gauntlet is untouched.
- **The P3b editor + var-shadow save path stay fully functional.** Minimap +
  search are additive overlays; they read `WORKING` and never mutate it. The
  `#202` dirty-working-copy bar, `markDirty`, `Save`/`Revert`, palette
  drag-to-place, edge draw/cycle/delete, and pane editing all keep working with
  the new overlays live (Task 3 asserts this in the browser).

## Settled decisions binding this plan

- **SD-37** (canvas edits write to the var-live shadow via `pipeline_save`) —
  P3c **adds no write surface**; the editor and its `pipeline_save` path are
  untouched. Minimap/search navigate over the existing WORKING/VIEW.
- **SD-34** (var-live shadow: one resolver `effective_pipeline_dir` feeds both
  dispatch and the viewer) — untouched; `curDoc()` already reflects the shadow
  through `VIEW.doc`. No new resolution.
- **SD-29** (double-validation writer) / **SD-9** (loopback + per-process token +
  server-side re-validation on the ONE write endpoint) — P3c adds no action and
  no endpoint, so both are respected trivially (nothing new to gate).
- **SD-5** (`git_ops` merge always via safe_merge) — untouched.
- **New SD entry (SD-38, Task 3):** P3c navigation is client-only over the
  existing payload; the minimap tracks the scroll viewport (canvas **zoom is
  deferred** because a scale transform would break the editor's
  rectangle-based gesture geometry); minimap + search are available on
  **read-only viewers too** (navigation is not gated on `editable()`).

## Prevention-log entries binding this plan

- **#13** (temporal — instrument time, not frames): the minimap svg and the
  search class-toggles must not churn on an idle canvas. Add `minimap` to the
  temporal probe's panel-id list; assert `innerHTMLStable` + `≤1` element
  rebuild on an idle, unchanged-payload fixture. The viewport-rect scroll
  update mutates only attributes (no childList add/remove), and only on a real
  scroll — never on idle.
- **#14** (a signature-guarded render must own every write path): the page's
  guard is the coarse `VIEWSIG` early-return in `tick()`. Minimap/search writes
  happen **inside `render()`** (payload-change/edit only) or on operator events
  (input/scroll/drag) — never on an unchanged tick. The scroll handler writes
  only the rect attributes and is idempotent, so it cannot desync a signature
  cache (there is none on the minimap/search overlays).
- **#16** (a focusable control in a guarded panel freezes it): the search
  `<input>` lives in the **header** (`#search`), which `render()` never
  rebuilds — so the field survives every live tick with its value and caret
  intact, and there is no held-focus/freeze interaction with the `#dag`/`#pane`
  guard. Controls whose job **ends** on action (Enter-to-jump, the minimap
  drag, Escape-to-clear) `blur()`/release after acting; only the actively-typed
  search field is "held" (never auto-blurred mid-type).
- **#6** (charset/untrusted-doc content): matched ids/types render only through
  the EXISTING escaped card markup — search toggles CSS classes on already-
  `esc()`'d cards and never echoes a raw id into new DOM; the minimap draws
  bare `<rect>`s (geometry only, zero untrusted text). Any match-count or
  jumped-to label that IS echoed goes through `esc()`.

## Optional P3b follow-ons — all deferred (rationale recorded here so a later loop does not think it regressed)

The P3b scope marker surfaced three optional follow-ons. **None ship in P3c:**

1. **Full brief round-trip in the view payload** — *already shipped in P3b.*
   `build_pipeline_view` carries `view["briefs"]` and the pane textarea seeds
   from `briefText(ref)` (reads `VIEW.briefs`). Nothing to do.
2. **Reset-shadow-to-committed** — deferred: it is a **write surface** (deletes
   the shadow dir), which contradicts P3c's navigation-only framing and re-opens
   the SD-9/SD-29 write-security model. Belongs in its own small write-PR or P4.
3. **Provenance diff (shadow-vs-committed)** — deferred: read-only, but it needs
   a **new payload** (the committed doc to diff against, or a precomputed drift
   field), which contradicts P3c's "client-side over `curDoc()`/`curEdges()`,
   no new payload." Natural next read-slice, after P3c.

## Testing discipline (why there are no new `unittest` cases)

P3c changes **only `lib/pipeline_page.html`** — no `bin/`, no `lib/*.py`, no
server route, no state builder, no control writer. There is no Python surface to
unit-test and the repo ships no JS test runner (adding one is out of scope and
against the stdlib-only ethos). This mirrors P3b Tasks 5–7, which were also
browser-verified. To keep the tests **genuine** (project non-negotiable), the
browser verify loop does more than eyeball snapshots: each task drives the REAL
page and asserts on it two ways —

- **Functional assertions via `evaluate_script`** that call the page's own pure
  predicates with crafted inputs (`nodeMatches`, `matchedIds`, `firstMatchId`,
  the minimap scale/rect math) and assert the returned values — the page is the
  test harness (top-level `function` declarations in this classic, non-module
  script are global, so `evaluate_script` can call them).
- **Behavioural assertions**: fire real `input`/`scroll`/`mousedown` events and
  assert the DOM outcome (classes toggled, viewport rect moved, `#dag`
  scrollLeft changed), plus the mandatory temporal + dirty-survival passes.

Each task below is written TDD-style against that oracle: **add the assertion,
run the page WITHOUT the feature to see it fail (undefined function / absent
element), implement, re-run to see it pass.**

## File Structure

- Modify: `lib/pipeline_page.html` — the ONLY code file. Three regions:
  - **Header** (`:141`–`:155`): add a `#search` input + `#searchcount` badge and
    a `#mapbtn` toggle pill.
  - **Canvas** (`.canvaswrap` `:66` CSS + the `<main>` markup `:158`–`:172`): add
    the `#minimap` overlay; make `.canvaswrap` a positioning context.
  - **Script** (`:177`–`:846`): add `SEARCH`/`MAP_ON` state, the search predicate
    + `applySearch` + `jumpToSearch`, the `drawMinimap`/`updateMMView`/minimap-drag
    handlers, and wire both into `render()`'s frame + the `resize` handler.
- Modify: `docs/pipelines.md` (product layer — the "Seeing it" navigation
  sentence) and `.claude/skills/engineering/pipelines.md` (drop "minimap +
  search (P3c)" from the deferred list; record shipped).
- Modify: `docs/settled-decisions.md` (add SD-38).
- No test files change (see "Testing discipline"). No fixture change — the
  read-oracle `tests/fixtures/repo-alpha` `coder → fixture-flow` binding is
  enough of a graph to exercise search; the browser loop builds a **wide**
  throwaway graph to force minimap overflow.

## Interfaces (deltas — all client-side, all on `window` in this classic script)

- `nodeSearchText(u) -> string` — lowercased haystack of a node/container's
  `id` + `type`/`kind` + `runs_as` values. Pure.
- `nodeMatches(u, q) -> bool` — `q === ""` ⇒ true; else substring of
  `nodeSearchText(u)`. Pure.
- `matchedIds(q) -> Set<string>` — ids of nodes+containers in `curDoc()` that
  match `q`. Pure over `curDoc()`.
- `childMatched(id, hits) -> bool` — a container id whose any child id is in
  `hits`. Pure over `curDoc()`.
- `firstMatchId(q) -> string|null` — first match in left-to-right layout order.
- `applySearch()` — toggles `.searchhit`/`.searchoff` on `#dag [data-uid]`
  cards + updates `#searchcount`. No rebuild, no geometry.
- `jumpToSearch()` — select + scroll the first match into view + flash it;
  blurs `#search`.
- `drawMinimap()` — (re)draw `#mmsvg`: scaled `<rect>`s of every rendered card +
  the viewport rect; hides `#minimap` when `!MAP_ON` or the canvas does not
  overflow. Stashes `mm._scale/_ox/_oy` for the drag math.
- `updateMMView()` — cheap: set only the `#mmview` rect's `x`/`y` from the
  current scroll. Called on scroll (rAF-throttled) and after a drag.

---

### Task 1: search / filter — header input, match predicate, highlight-and-jump

**Files:**
- Modify: `lib/pipeline_page.html` (header markup `:152`; CSS after `:136`;
  script state `:188`; new functions after `effectiveEdges`/`topUnits`; wire into
  `render()` `:389`)

**Interfaces:**
- Consumes: existing `curDoc()`, `conById()`, `topUnits()`, `esc()`, `sel()`,
  `render()`.
- Produces: `nodeSearchText`, `nodeMatches`, `matchedIds`, `childMatched`,
  `firstMatchId`, `applySearch`, `jumpToSearch`, and `SEARCH` state — Task 2's
  `drawMinimap` reads `SEARCH`/`matchedIds`/`childMatched` for optional shading.

- [ ] **Step 1: Add the header control.** In the `.hdr` block, insert the search
  input + count badge right after the role picker (`lib/pipeline_page.html:145`,
  after the `<select id="rolepick" …>` line):

```html
    <input id="search" class="search" type="search" placeholder="find node…"
           aria-label="find an activity by id, type, or agent" autocomplete="off">
    <span id="searchcount" class="badge" style="display:none"></span>
```

- [ ] **Step 2: Add the CSS.** Append to the editor-affordances block (after
  `lib/pipeline_page.html:136`, before `</style>`):

```css
/* --- P3c (#367): navigation overlays — search highlight + minimap --- */
.search{background:var(--panel2);border:1px solid var(--hair2);color:var(--ink);
  font-family:var(--mono);font-size:11px;border-radius:5px;padding:4px 7px;width:132px}
.search::placeholder{color:var(--dim)}
.node.searchoff,.box.searchoff{opacity:.28}
.node.searchhit{border-color:var(--warn);box-shadow:0 0 0 2px var(--warn-glow)}
.box.searchhit{border-color:var(--warn)}
@keyframes flashpulse{0%{box-shadow:0 0 0 3px var(--warn-glow)}100%{box-shadow:0 0 0 0 transparent}}
.node.flash,.box.flash{animation:flashpulse .9s ease-out}
@media (prefers-reduced-motion: reduce){.node.flash,.box.flash{animation:none;outline:2px solid var(--warn)}}
```

  (Note: `.node.searchoff` and the observed-lighting `.observed .dimmed` have
  **equal CSS specificity** (0,2,0), so they do NOT multiply — the later rule in
  the stylesheet wins outright. The P3c block is appended after the `.dimmed`
  rule (`lib/pipeline_page.html:89`), so a node that is both unlit AND unmatched
  gets `opacity:.28` (searchoff wins). Intentional — a search miss reads slightly
  dimmer than an unlit node; not a conflict. State it this way in the code
  comment too, not "composes/multiplies" (Codex CP1 corrected the earlier note).)

- [ ] **Step 3: Add the state + predicates.** Add `let SEARCH = "";` beside the
  other page-state vars (after `lib/pipeline_page.html:188`, the `COLLAPSED`
  line). Then add the pure functions (place after `topUnits`/`rankUnits`,
  ~`:282`):

```js
/* ---- P3c search/filter: pure predicates over curDoc() ----
   SEARCH is page state like SEL/OBSERVED/COLLAPSED: it survives a re-render and
   render() re-applies it, so a live update never drops the filter. Matching is a
   case-insensitive substring over a node/container's id + type/kind + runs_as
   values. Nothing here renders raw doc text -- highlighting toggles CSS classes
   on the already-esc()'d cards; matched ids never reach the DOM un-escaped. */
function nodeSearchText(u){
  if(!u || typeof u !== "object") return "";
  const parts = [u.id, u.type, u.kind];
  const ra = u.runs_as;
  if(ra && typeof ra === "object") for(const v of Object.values(ra)) parts.push(v);
  return parts.filter(x => x != null).map(String).join(" ").toLowerCase();
}
function nodeMatches(u, q){ return q === "" ? true : nodeSearchText(u).indexOf(q) >= 0; }
function matchedIds(q){
  const d = curDoc(), ids = new Set();
  if(!d || !q) return ids;
  for(const n of (d.nodes||[])) if(n && n.id && nodeMatches(n, q)) ids.add(n.id);
  for(const c of (d.containers||[])) if(c && c.id && nodeMatches(c, q)) ids.add(c.id);
  return ids;
}
function childMatched(id, hits){
  const c = conById(id);
  return !!c && (c.children||[]).some(ch => hits.has(ch));
}
function firstMatchId(q){
  const hits = matchedIds(q);
  if(!hits.size) return null;
  const d = curDoc() || {};
  // Visual left-to-right, top-to-bottom order = the SAME ranked columns the
  // canvas lays out (rankUnits over topUnits + curEdges), NOT raw topUnits order
  // -- longest-path layering can move a unit to a later column than its
  // declaration index, so jumping by topUnits order could skip a leftward match
  // (Codex CP1). Mirror the render layout exactly.
  for(const col of rankUnits(topUnits(d), curEdges())){
    for(const u of col){
      if(hits.has(u)) return u;
      const c = conById(u);
      if(c) for(const ch of (c.children||[])) if(hits.has(ch)) return ch;
    }
  }
  for(const id of hits) return id;                 // any hit (defensive: unranked)
  return null;
}
```

- [ ] **Step 4: Add `applySearch` + `jumpToSearch` (class-toggle only, no
  rebuild).** Place after the predicates:

```js
/* Toggle highlight/dim classes on the rendered cards WITHOUT a rebuild (so the
   pane, selection, and caret are untouched). Callers that also want the minimap
   shading refreshed call drawMinimap() after (Task 2 defines it; guarded here so
   Task 1 stands alone). */
function applySearch(){
  const q = SEARCH, cnt = document.getElementById("searchcount");
  const cards = document.querySelectorAll("#dag [data-uid]");
  if(!q){
    cards.forEach(el => el.classList.remove("searchhit","searchoff"));
    if(cnt) cnt.style.display = "none";
    return;
  }
  const hits = matchedIds(q);
  cards.forEach(el => {
    const on = hits.has(el.dataset.uid) || childMatched(el.dataset.uid, hits);
    el.classList.toggle("searchhit", on);
    el.classList.toggle("searchoff", !on);
  });
  if(cnt){ cnt.style.display = ""; cnt.textContent = hits.size + (hits.size===1?" match":" matches"); }
}
function jumpToSearch(){
  const box = document.getElementById("search");
  if(box) box.blur();                              // #16: the jump ENDS -> release focus
  if(!SEARCH) return;
  const id = firstMatchId(SEARCH);
  if(!id) return;
  sel(id);                                         // select -> render() (header persists)
  requestAnimationFrame(() => {
    const el = document.querySelector(`#dag [data-uid="${CSS.escape(id)}"]`);
    if(!el) return;
    el.scrollIntoView({block:"nearest", inline:"center", behavior:"smooth"});
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 900);
  });
}
```

- [ ] **Step 5: Wire the events + the render integration.** Near the other
  header wiring (after the `obsbtn` listener, ~`:748`), add:

```js
const _search = document.getElementById("search");
_search.addEventListener("input", e => {
  SEARCH = e.target.value.trim().toLowerCase();
  applySearch();
  if(typeof drawMinimap === "function") drawMinimap();   // refresh minimap shading (Task 2)
});
_search.addEventListener("keydown", e => {
  if(e.key === "Enter"){ e.preventDefault(); jumpToSearch(); }
  else if(e.key === "Escape"){ e.target.value = ""; SEARCH = ""; applySearch();
    if(typeof drawMinimap === "function") drawMinimap(); e.target.blur(); }
});
```

  And re-apply search after every rebuild so a live update / edit keeps the
  filter. In `render()`, immediately after the `dag.innerHTML = cols.map(...)`
  assignment (`lib/pipeline_page.html:389-395`) and before the
  `if(!paneFocused()) renderPane();` line, add:

```js
  applySearch();                       // re-apply the active filter to the fresh cards
```

- [ ] **Step 6: Run the page WITHOUT trusting the change — see the assertion
  fail, then pass.** Launch the verify server (dashboard skill, throwaway port):

```bash
python3 /Users/lukebradford/Dev/autonomy-engine/bin/dashboard.py \
  --repo /Users/lukebradford/Dev/autonomy-engine/tests/fixtures/repo-alpha --port 8790
```

  Drive `/pipeline?repo=<repo-alpha-abs>&role=coder` with chrome-devtools MCP and
  run this functional assertion via `evaluate_script` (it FAILS before Steps 3–5
  land — `nodeMatches` is undefined — and PASSES after):

```js
() => {
  // predicate unit checks (the page is the harness)
  const a = nodeMatches({id:"pick", type:"pick"}, "pic");            // true
  const b = nodeMatches({id:"code", type:"agent_task",
                         runs_as:{model:"claude-sonnet-5"}}, "sonnet"); // agent match
  const c = nodeMatches({id:"pick", type:"pick"}, "zzz");            // false
  const d = nodeMatches({id:"x"}, "");                               // empty -> true
  // behavioural: type into the box, assert classes + count
  const box = document.getElementById("search");
  box.value = "check"; box.dispatchEvent(new Event("input", {bubbles:true}));
  const hits = document.querySelectorAll("#dag .node.searchhit").length;
  const off  = document.querySelectorAll("#dag .node.searchoff").length;
  const cnt  = document.getElementById("searchcount").textContent;
  box.value = ""; box.dispatchEvent(new Event("input", {bubbles:true}));
  const cleared = document.querySelectorAll("#dag .searchhit,.searchoff").length; // 0
  return {a, b, c, d, hits, off, cnt, cleared};
};
```

  Expected after implementation: `a===true, b===true, c===false, d===true`,
  `hits >= 1`, `off >= 1`, `cnt` matches `/\d+ match/`, `cleared===0`. Then
  `list_console_messages` → ZERO `error` entries.

- [ ] **Step 7: Commit**

```bash
git add lib/pipeline_page.html
git commit -m "feat(#367): pipeline canvas search/filter -- highlight-and-dim by id/type/agent, Enter jumps to first match"
```

---

### Task 2: minimap — scaled overview + draggable viewport rect (scroll-tracking)

**Files:**
- Modify: `lib/pipeline_page.html` (CSS after Task 1's block; `.canvaswrap` `:66`
  gains `position:relative`; `#minimap` markup inside `<main>` `:172`; `#mapbtn`
  in the header `:151`; script: `MAP_ON` + `drawMinimap`/`updateMMView` + scroll
  + drag; wire into `render()`'s frame `:397` and the `resize` handler `:749`)

**Interfaces:**
- Consumes: existing `dagwrap`/`dag` geometry (the `anchor()` formula:
  `rect - dagwrapRect + scroll`), `curDoc()`, `OBSERVED`/`lastRunMaps` (optional
  dim), Task 1's `SEARCH`/`matchedIds`/`childMatched` (optional shading).
- Produces: `drawMinimap`, `updateMMView`, `MAP_ON` — self-contained; nothing
  downstream depends on them.

**Design proposal (the mockup carries no minimap — this is the P3c visual call):**
a small floating overview pinned to the **bottom-right of the canvas**
(`position:absolute` inside `.canvaswrap`), **shown only when the graph overflows
its viewport** (a tiny graph that fully fits needs no map and its viewport rect
would cover everything). It draws one scaled `<rect>` per rendered card
(geometry measured exactly like the edges, so it always matches the layout) and
a `.mmview` rectangle marking the scrolled-into-view slice. Click or drag the map
to scroll the canvas to that point. **No zoom**: the canvas has no zoom today and
a scale transform would break the editor's `getBoundingClientRect` gesture math
(edge-draw, palette-drop, and this very measurement all assume unscaled
coordinates) — so the map tracks the **scroll** viewport, the canvas's only
navigation dimension. The map is `aria-hidden` (a redundant visual aid; the
canvas cards remain the keyboard-navigable source of truth).

- [ ] **Step 1: Make the canvas a positioning context + add the toggle pill.**
  In the `.canvaswrap` CSS rule (`lib/pipeline_page.html:66`) append
  `position:relative` to the declaration. Then in the header, add a map toggle
  pill right after the `⚡ last run` button (`lib/pipeline_page.html:151`):

```html
    <button class="pill on" id="mapbtn" title="toggle the overview map">🗺 map</button>
```

- [ ] **Step 2: Add the minimap markup.** Inside `<main class="canvaswrap">`,
  after the `.legend` div closes (`lib/pipeline_page.html:171`, before
  `</main>`):

```html
      <div class="minimap" id="minimap" hidden aria-hidden="true">
        <svg id="mmsvg" class="mmsvg"></svg>
      </div>
```

- [ ] **Step 3: Add the CSS.** Append to the P3c CSS block from Task 1:

```css
.minimap{position:absolute;right:16px;bottom:16px;width:176px;height:104px;
  background:var(--panel2);border:1px solid var(--hair2);border-radius:5px;
  box-shadow:var(--shadow);overflow:hidden;z-index:4}
.minimap[hidden]{display:none}
.mmsvg{display:block;width:176px;height:104px;cursor:pointer}
.mmnode{fill:var(--hair2);stroke:var(--dim);stroke-width:.5}
.mmnode.off{fill:var(--hair);opacity:.4;stroke:none}
.mmnode.hit{fill:var(--warn);stroke:none}
.mmview{fill:var(--accent-soft);stroke:var(--accent);stroke-width:1;cursor:grab}
@media(max-width:1120px){.minimap{display:none}}   /* single-column: canvas is full width */
```

- [ ] **Step 4: Add `MAP_ON` state + `drawMinimap` + `updateMMView`.** Add
  `let MAP_ON = true;` beside `SEARCH`. Then add the draw functions (place after
  `drawEdges`, ~`:449`):

```js
/* ---- P3c minimap: a scaled overview measured from the rendered cards ----
   Geometry mirrors anchor()/drawEdges exactly (rect - dagwrapRect + scroll), so
   the map can never disagree with the layout. Bare <rect>s only -- no untrusted
   text reaches the map (prevention-log #6 is satisfied by construction). Shown
   only when the canvas overflows AND MAP_ON; hidden otherwise (a fully-visible
   graph needs no map). Redrawn only from render()'s frame + resize + a filter
   change -- never on an idle tick, so the panel is temporally stable (#13). */
const MM_W = 176, MM_H = 104, MM_PAD = 6;
function drawMinimap(){
  const mm = document.getElementById("minimap"), svg = document.getElementById("mmsvg");
  const wrap = document.getElementById("dagwrap");
  // Guard MUST match render()'s early-return contract (`VIEW.error || !curDoc()`),
  // not just !curDoc(): an error payload can arrive with a still-parseable doc
  // present, and #dag then shows the error note (no cards) -- hide the map rather
  // than leave a stale overview (Codex CP1).
  if(!mm || !svg || !wrap || !VIEW || VIEW.error || !curDoc()){ if(mm) mm.hidden = true; return; }
  const sw = wrap.scrollWidth, sh = wrap.scrollHeight;
  const cw = wrap.clientWidth, ch = wrap.clientHeight;
  // Gate on HORIZONTAL overflow only -- the canvas's sole meaningful scroll axis.
  // dagwrap has no bounded height, so a tall graph grows the PAGE (window scroll),
  // it never scrolls inside dagwrap; and the negative-top glyphs + 26px top
  // padding leave a constant ~24px phantom vertical scrollHeight (browser-verified:
  // a 3-node graph reads sh=150/ch=126) that must NOT trip the gate, or it shows a
  // map for a graph that visually fits. The map is for wide DAGs; width is its axis.
  const overflow = sw > cw + 4;
  if(!MAP_ON || !overflow || sw <= 0 || sh <= 0){ mm.hidden = true; return; }
  mm.hidden = false;
  const scale = Math.min((MM_W - 2*MM_PAD) / sw, (MM_H - 2*MM_PAD) / sh);
  const ox = MM_PAD, oy = MM_PAD;
  const cr = wrap.getBoundingClientRect();
  const hits = SEARCH ? matchedIds(SEARCH) : null;
  let blocks = "";
  for(const el of wrap.querySelectorAll(".dag [data-uid]")){
    const r = el.getBoundingClientRect();
    const x = ox + (r.left - cr.left + wrap.scrollLeft) * scale;
    const y = oy + (r.top  - cr.top  + wrap.scrollTop ) * scale;
    const w = Math.max(2, r.width  * scale), h = Math.max(2, r.height * scale);
    let cls = "mmnode";
    if(hits){ const on = hits.has(el.dataset.uid) || childMatched(el.dataset.uid, hits);
      cls += on ? " hit" : " off"; }
    blocks += `<rect class="${cls}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" `
            + `width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="1"/>`;
  }
  const vx = ox + wrap.scrollLeft * scale, vy = oy + wrap.scrollTop * scale;
  const vw = Math.max(3, cw * scale), vh = Math.max(3, ch * scale);
  svg.setAttribute("viewBox", `0 0 ${MM_W} ${MM_H}`);
  svg.setAttribute("width", MM_W); svg.setAttribute("height", MM_H);
  svg.innerHTML = blocks + `<rect id="mmview" class="mmview" x="${vx.toFixed(1)}" `
    + `y="${vy.toFixed(1)}" width="${vw.toFixed(1)}" height="${vh.toFixed(1)}"/>`;
  mm._scale = scale; mm._ox = ox; mm._oy = oy;   // stash for drag + cheap updates
}
function updateMMView(){
  const mm = document.getElementById("minimap");
  if(!mm || mm.hidden || !mm._scale) return;
  const wrap = document.getElementById("dagwrap"), view = document.getElementById("mmview");
  if(!view) return;
  view.setAttribute("x", (mm._ox + wrap.scrollLeft * mm._scale).toFixed(1));
  view.setAttribute("y", (mm._oy + wrap.scrollTop  * mm._scale).toFixed(1));
}
```

- [ ] **Step 5: Add scroll tracking, drag-to-scroll, and the toggle.** Near the
  edge/resize wiring (~`:749`):

```js
/* scroll -> move ONLY the viewport rect (attribute write, no rebuild, rAF-
   throttled). User-driven, so it never fires on an idle canvas (#13/#14). */
let _mmRaf = 0;
document.getElementById("dagwrap").addEventListener("scroll", () => {
  if(_mmRaf) return;
  _mmRaf = requestAnimationFrame(() => { _mmRaf = 0; updateMMView(); });
});
/* click / drag the map -> scroll the canvas so the pointed-at spot centers.
   Reads the svg's own client rect so it is correct wherever the map sits. */
function mmScrollTo(clientX, clientY){
  const mm = document.getElementById("minimap"), svg = document.getElementById("mmsvg");
  const wrap = document.getElementById("dagwrap");
  if(!mm._scale) return;
  const r = svg.getBoundingClientRect();
  const cx = ((clientX - r.left) - mm._ox) / mm._scale;
  const cy = ((clientY - r.top ) - mm._oy) / mm._scale;
  wrap.scrollLeft = cx - wrap.clientWidth  / 2;
  wrap.scrollTop  = cy - wrap.clientHeight / 2;
  updateMMView();
}
let MMDRAG = false;
document.getElementById("mmsvg").addEventListener("mousedown", e => {
  MMDRAG = true; mmScrollTo(e.clientX, e.clientY); e.preventDefault();
});
window.addEventListener("mousemove", e => { if(MMDRAG) mmScrollTo(e.clientX, e.clientY); });
window.addEventListener("mouseup", () => { MMDRAG = false; });   // ends the drag (#16)
document.getElementById("mapbtn").addEventListener("click", () => {
  MAP_ON = !MAP_ON;
  document.getElementById("mapbtn").classList.toggle("on", MAP_ON);
  drawMinimap();
});
```

  (Coexistence note: edge-draw also uses a `window` `mouseup`, but it acts only
  when its own `DRAWING` flag is set from a `#dag [data-ehandle]` mousedown — a
  minimap mousedown sets `MMDRAG` and never touches `DRAWING`, and you cannot
  mousedown two elements at once, so the two drags never collide.)

- [ ] **Step 6: Draw the map in `render()`'s frame + on resize.** Change the
  `render()` tail (`lib/pipeline_page.html:397`) from:

```js
  requestAnimationFrame(drawEdges);
```

  to:

```js
  requestAnimationFrame(() => { drawEdges(); drawMinimap(); });
```

  and the resize handler (`lib/pipeline_page.html:749`) from:

```js
window.addEventListener("resize", () => requestAnimationFrame(drawEdges));
```

  to:

```js
window.addEventListener("resize", () => requestAnimationFrame(() => { drawEdges(); drawMinimap(); }));
```

  Also, in the early-return render branch for an unreadable/error doc
  (`lib/pipeline_page.html:383-384`, which sets `edgesvg.innerHTML = ""`), hide
  the map so a broken doc shows no stale overview — add `drawMinimap();` there
  (it self-hides via the `VIEW.error || !curDoc()` guard added in Step 4, which
  matches this exact branch condition).

- [ ] **Step 7: Verify in the browser (overflow forces the map).** The fixture
  graph is small and may not overflow, so build a **wide** throwaway repo to
  force the minimap on, then assert:

```bash
D=$(mktemp -d)/pipe-wide && mkdir -p "$D/.autonomy/pipelines/wide-flow" && cd "$D"
git init -q && printf 'var/\n' > .gitignore
printf 'roles:\n  coder:\n    pipeline: wide-flow\n' > .autonomy/config.yaml
python3 - "$D/.autonomy/pipelines/wide-flow" <<'PY'
import json, os, sys
d = sys.argv[1]
nodes = [{"id":"n%d"%i,"type":"pick","brief_ref":"n%d.md"%i} for i in range(14)]
edges = [{"from":"n%d"%i,"to":"n%d"%(i+1),"on":"success"} for i in range(13)]
json.dump({"name":"wide-flow","version":1,"caps":{"max_sessions_per_run":16},
           "nodes":nodes,"edges":edges}, open(os.path.join(d,"pipeline.json"),"w"))
for i in range(14): open(os.path.join(d,"n%d.md"%i),"w").write("brief %d\n"%i)
PY
git add -A && git -c user.email=t@t -c user.name=t commit -qm seed
python3 /Users/lukebradford/Dev/autonomy-engine/bin/dashboard.py --repo "$D" --port 8790
```

  Drive `/pipeline?repo=<wide-abs>&role=coder`. **First set a deterministic
  viewport** with the chrome-devtools `resize_page` tool (e.g. 1000×800) — the
  overflow gate is width-dependent, so pin the width rather than trusting the
  window (Codex CP1); 14 cards × ~172px reliably overflow 1000px. Then assert via
  `evaluate_script` (FAILS before Steps 4–6 — `drawMinimap` undefined / `#minimap`
  hidden — PASSES after):

```js
() => {
  const mm = document.getElementById("minimap"), wrap = document.getElementById("dagwrap");
  const shown = !mm.hidden;                                  // overflow -> visible
  const rects = document.querySelectorAll("#mmsvg rect.mmnode").length;  // one per card
  const before = wrap.scrollLeft;
  const svg = document.getElementById("mmsvg"), r = svg.getBoundingClientRect();
  svg.dispatchEvent(new MouseEvent("mousedown", {clientX:r.right-8, clientY:r.top+r.height/2, bubbles:true}));
  window.dispatchEvent(new MouseEvent("mouseup", {bubbles:true}));
  const movedRight = wrap.scrollLeft > before;               // dragging right scrolls right
  const vx0 = +document.getElementById("mmview").getAttribute("x");
  wrap.scrollLeft = 0; wrap.dispatchEvent(new Event("scroll"));
  return {shown, rects, movedRight, viewportTracks: vx0 >= 0};
};
```

  Expected: `shown===true`, `rects===14`, `movedRight===true`,
  `viewportTracks===true`. `list_console_messages` → ZERO errors. Toggle
  `#mapbtn` → the map hides/shows.

- [ ] **Step 8: Commit**

```bash
git add lib/pipeline_page.html
git commit -m "feat(#367): pipeline canvas minimap -- scaled overview + draggable viewport rect, scroll-tracking, overflow-gated"
```

---

### Task 3: temporal + editor-coexistence verify · docs · SD-38 · PR

**Files:**
- Modify: `docs/pipelines.md`, `.claude/skills/engineering/pipelines.md`,
  `docs/settled-decisions.md`. No code file changes beyond Tasks 1–2.

- [ ] **Step 1: Full browser verify loop** (dashboard skill; drive BOTH the
  read-oracle fixture and the wide throwaway from Task 2). Assert, in order:
  - **Read surface unchanged** on `/pipeline?repo=<repo-alpha-abs>&role=coder`:
    palette groups, ranked cards, pane rows, lighting toggle — all P3a/P3b
    behaviour intact. Search box present and empty. **Overflow gate, both ways**
    (Codex CP1 — the gate is viewport-dependent, never assume). TWO REALITIES
    found during verify, so use dedicated graphs, not repo-alpha alone: (a) the
    page has `.wrap{max-width:1500px}`, so the canvas column caps at ~892px and
    repo-alpha (1566px) can NEVER be made to fit by widening; (b) a viewport
    ≤1120px triggers the single-column media query that hides the minimap by
    design. So test at a **3-column width (>1120, e.g. 1300–1400)**: a small
    throwaway (≤3 nodes, ~780px) → no horizontal overflow → assert `#minimap`
    `hidden` even with `MAP_ON` true; the wide throwaway (14 nodes, ~3000px) →
    overflow → assert `#minimap` shown. Both against a forced `resize_page`
    viewport, not an assumption.
  - **Search**: type an id/type/agent → matched cards get `.searchhit`, others
    `.searchoff`, `#searchcount` shows N; Enter scrolls the first match into view
    and flashes it; Escape clears. `evaluate_script` reruns the Task 1 assertion.
  - **Minimap** (wide throwaway): visible on overflow; drag scrolls the canvas;
    scroll moves the viewport rect; `#mapbtn` toggles it. Rerun Task 2's
    assertion.
  - **Editor still fully functional WITH both overlays live** (the headline
    coexistence check — run on the wide throwaway, which is a BOUND, editable
    pipeline): select a node → edit its brief → `● unsaved` appears, `Save`
    enables → Save returns 200 → badge clears → `📝 local edits` chip shows on
    reload. Then, **with a search filter active**, place a palette node, draw an
    edge, cycle it, delete it — each still mutates `WORKING` and re-renders, and
    `applySearch()` re-applies to the fresh cards (a just-placed non-matching
    node dims — expected). Confirm the minimap redraws to include the placed
    node.
  - **Dirty-survival with overlays** (the #202 bar — RUN ON EVERY EDIT PATH):
    make an edit, `await` ~6 s (2–3 poll cycles), assert the edit is still
    present AND the search filter + minimap are still live and correct. A live
    tick that reverts an edit or drops the filter is a `ux` blocker.
  - **Search field survives a live tick** (#16): focus `#search`, type a query,
    `await` ~6 s, assert `document.activeElement === #search`, the value is
    intact, and the caret did not jump — the header input is never rebuilt by a
    tick.
  - **Temporal pass** (prevention-log #13; dashboard skill step 4) with the
    panel-id list **extended to include `minimap`**:
    `['dag','pane','palette','errbar','edgesvg','minimap']`. Idle the wide
    fixture with ZERO interaction; assert `steadyStateCLS < 0.01`, every panel
    `innerHTMLStable` true, `elementRebuildsPerPanel ≤ 1`. Confirm an unchanged
    fetch rebuilds neither the canvas nor the minimap (the `VIEWSIG` guard) and
    that no scroll fires on idle (the viewport rect is byte-stable).
  - Kill the server; record the verification (surfaces, actions, console-clean,
    temporal readings, dirty-survival, search-field survival) in the PR Testing
    section.

- [ ] **Step 2: Gates.** `bash tests/run_all.sh` green (unchanged — no Python
  touched, this is the regression harness) · `shellcheck -S warning …` clean (no
  `.sh` changes, but run it) · pre-flight-review over the full diff ·
  **Codex checkpoint 2** on the diff (`.claude/skills/engineering/
  codex-checkpoints.md`) — fold real findings before the first push.

- [ ] **Step 3: New settled-decision entry** (SD-38) in
  `docs/settled-decisions.md`, citing this PR:

  > **The pipeline canvas navigation layer (minimap + search) is client-only
  > over the existing payload** (P3c, #367). Search highlights/dims and
  > jumps by id/type/agent over `curDoc()`; the minimap is a scaled overview of
  > the rendered cards with a draggable viewport rect that tracks the canvas
  > **scroll** — **canvas zoom is deferred**, because a scale transform would
  > break the editor's `getBoundingClientRect` gesture geometry (edge-draw,
  > palette-drop, minimap measurement all assume unscaled coordinates). Both are
  > **read/navigation only**: no new payload field, no new `/api/control`
  > action, no write surface (SD-37's editor and its `pipeline_save` path are
  > untouched). Navigation is available on **read-only viewers too** (not gated
  > on `editable()`). Both re-apply only inside `render()` (payload-change/edit)
  > or on operator events, so an idle canvas rebuilds nothing (prevention-log
  > #13); the search input lives in the never-rebuilt header, so a live tick
  > cannot freeze it (#16). The P3b optional follow-ons — reset-shadow-to-
  > committed (a write surface) and provenance-diff (needs a new payload) —
  > stay deferred; full-brief-round-trip already shipped in P3b.

- [ ] **Step 4: Product-doc update** (house rule: a behaviour PR updates the
  product layer). In `docs/pipelines.md`, the "Seeing it: the pipeline canvas"
  section, add a navigation bullet to the canvas feature list (after the "live
  pulse" bullet, `docs/pipelines.md:137`):

  > - a **search box** to find an activity by id, type, or agent (matches
  >   highlight, the rest dim, Enter jumps to the first), and an **overview
  >   map** for wide graphs — a scaled thumbnail with a draggable viewport
  >   rectangle you drag to pan the canvas.

- [ ] **Step 5: Skill update.** In `.claude/skills/engineering/pipelines.md`,
  the "Still deferred" section, change the canvas line from
  `still deferred there: minimap + search (P3c), full brief round-trip / …` to
  drop the shipped items — e.g.:

  > Canvas EDITING SHIPPED (P3b, #365, SD-37); navigation (minimap + search)
  > SHIPPED (P3c, #367, SD-38). Still deferred there: reset-shadow-to-
  > committed and provenance-diff (both need a write surface or a new payload),
  > canvas zoom, and binding-a-new-pipeline from the canvas (P4 gallery).

- [ ] **Step 6: PR** per `.claude/skills/engineering/pr-authoring.md` —
  self-contained. The **security model is light** (P3c adds no write surface),
  but state it explicitly:
  - **No new attack surface**: no new `/api/control` action, no new endpoint, no
    new payload field, no fs write. The token gauntlet and `pipeline_save`
    writer are untouched; P3c reads only what the page already fetched.
  - **XSS on untrusted doc content still applies**: search highlights by
    toggling CSS classes on the already-`esc()`'d cards (no raw id echoed into
    new DOM); the minimap renders bare geometric `<rect>`s (zero untrusted
    text); any match-count/label that is echoed goes through `esc()`. Delegated
    `data-*` listeners and the no-inline-handler rule are preserved.
  - **No client-state invention** (dashboard contract): the minimap draws only
    the geometry of rendered cards; search matches only the held doc — every
    pixel still traces to server truth.
  - **Tradeoffs**: zoom deferred (would perturb editor gesture geometry);
    minimap placement (bottom-right, overflow-gated) is a P3c visual proposal
    since the mockup carries none; the map is `aria-hidden` (a redundant visual
    aid — the canvas cards stay the keyboard-navigable source of truth).
  - Before merge: `gh pr view <n> --json closingIssuesReferences` confirms the
    body closes ONLY the P3c issue (prevention-log #20). Drive every review
    comment to a terminal state; merge only via `safe_merge`; close the ticket.

---

## P4 scope marker (own plan doc when built — nothing here executes)

Deferred beyond P3c: **gallery / assignment + versioning + run windows** (spec
§5, §7 top bar, stories S31/S32/S36) — the bigger vision piece: template-vs-clone
provenance, save-a-tuned-clone-as-a-new-template, per-repo assignment, enabled
switch + trigger + run window in the top bar, and creating/binding a new pipeline
from the canvas. The two read/write follow-ons parked from P3b —
**reset-shadow-to-committed** (a write surface) and **provenance diff**
(shadow-vs-committed, needs a new payload, the config page's `live_config_drift`
analogue) — are natural small slices to fold in here or ship standalone. Canvas
**zoom** (with the gesture-geometry rework it implies) is a P4+ call.
