# Compare Tiles (#190 UI-7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin 2+ lanes in the fleet rail → the center zone renders a compare-tile grid (one tile per pinned lane: header, phase track, now-line, elapsed·tok·$, pace flag, last-activity age, blocking gate); tile click drills back to single view.

**Architecture:** Pure client-side feature in `lib/dashboard_page.html` — every datum a tile needs is already in the `/api/state` payload per repo (`focus_ticket.track`, `current_session`, `heartbeat`, `sessions`, `lanes`). A client-only `PINNED` Set of lane keys (same `laneKey()` contract as `SELECTED`, ephemeral — resets on reload, matching "state-not-streams") drives a branch at the top of `renderFocus`: ≥2 valid pins → tile grid via `setHTML("focus", …)` (same #248 signature guard; volatile spans reuse the `upe`/`agox`/`qreset` classes the guard already normalizes), <2 → today's single card byte-identical. Pin gesture = a 📌 toggle `<button>` inside the existing lane select targets (`repo-h` single-lane, `lgrp-h` multi-lane) per the redesign spec's object inventory ("icon cluster: pin/…", "pin=compare"); the delegated `#repos` listener already ignores buttons.

**Tech Stack:** Vanilla JS + CSS in `lib/dashboard_page.html`; structural build-time tests in `tests/test_dashboard_server.py` (unittest, stdlib); chrome-devtools browser verify loop.

## Global Constraints

- Python 3 **stdlib only**; bash 3.2.57 floor (no `.sh` changes planned, but the gates run regardless).
- **Never imply certainty the data lacks** (#187 acceptance test binds the tiles too): pace flag renders only with ≥3 completed same-role durations AND a live elapsed; blocking gate only from an actual `state:"current"` track segment; absent datum → omitted, never "undefined".
- **State-not-streams** (spec, issue body): tiles never render live feeds side by side — now-line is one line, no tool trace.
- Signature-guard discipline (prevention-log #13/#14/#16): all `#focus` writes go through `setHTML`; volatile time cells use the existing `upe`/`agox`/`qreset` classes ONLY (already normalized by `_sigKey`); pin buttons are click-and-done `<button>`s that must never become a held node (they live in `#repos`, which has no held-node path — and they get `this.blur()` belt-and-suspenders anyway).
- Repo-scoped session truth: a multi-lane repo's `current_session`/`focus_ticket` are repo-scoped (sessions carry no lane field). Tiles inherit the EXACT same presentation contract the shipped single-lane focus card uses for a selected sibling lane (repo session data under a lane-named header, lane status from `lanes.services` when present). No new truth claims.
- No fixed-byte-window assertions in tests (memory lesson: `html[i:j+900]` breaks on innocent growth) — marker-based assertions only.

## File Structure

- `lib/dashboard_page.html` — CSS block (tile grid + pin button) and JS (PINNED set, togglePin, validPins, tileCard, paceFlag, drillTo, renderFocus branch, pin buttons in renderRepos).
- `tests/test_dashboard_server.py` — new `TestCompareTiles` class, structural markers on `dashboard._page_bytes(dashboard.PAGE)`.

---

### Task 1: Failing structural tests

**Files:**
- Test: `tests/test_dashboard_server.py` (append a class next to `TestControlRoomShell`)

**Interfaces:**
- Produces (Task 2 must define, names exact): JS `PINNED` (Set), `togglePin(encKey, btn)`, `validPins(repos)`, `tileCard(r, lane, key)`, `paceFlag(r, role, startedEpoch)`, `drillTo(ev, encKey)`; CSS classes `.pinbtn`, `.pinbtn.on`, `.tilegrid`, `.tile`, `.tgate`, `.trole`, `.pacex`; pin buttons carry `data-pin-key`; `_volRe` alternation gains `pacex`.

- [ ] **Step 1: Write the failing tests**

```python
class TestCompareTiles(unittest.TestCase):
    """#190 UI-7: pin 2+ lanes -> the center renders a compare-tile grid.
    Structural build-time guards on the page source; runtime behaviour
    (pin toggle, grid swap, drill-back) is the browser verify loop."""

    def _page(self):
        return dashboard._page_bytes(dashboard.PAGE)

    def test_pin_primitive_present(self):
        # client-only pin state (ephemeral Set, laneKey contract) + toggle.
        html = self._page()
        self.assertIn(b"PINNED", html)
        self.assertIn(b"function togglePin(", html)
        self.assertIn(b'data-pin-key', html)
        self.assertIn(b"pinbtn", html)

    def test_tile_grid_render_path(self):
        # renderFocus branches to the tile grid; tiles reuse the shipped
        # phase-track markup (.ptrack/.pseg) rather than a new track renderer.
        html = self._page()
        self.assertIn(b"function tileCard(", html)
        self.assertIn(b"tilegrid", html)
        self.assertIn(b"function validPins(", html)
        self.assertIn(b"function drillTo(", html)

    def test_pace_flag_is_earned(self):
        # pace flag only from >=3 completed same-role durations (median) --
        # the "never imply certainty" acceptance test applied to pace.
        html = self._page()
        self.assertIn(b"function paceFlag(", html)
        self.assertIn(b"ds.length<3", html)

    def test_tile_css_defined(self):
        html = self._page()
        self.assertIn(b".tilegrid", html)
        self.assertIn(b".tile", html)
        self.assertIn(b".pinbtn", html)

    def test_pace_ratio_in_volatile_normalization(self):
        # the live pace ratio drifts every second; it must sit inside the
        # shared _volRe normalization or the grid rebuilds on every tick
        # (prevention-log #13/#14 class; CP1 finding).
        html = self._page()
        self.assertIn(b"qreset|agox|upe|pacex", html)
        self.assertIn(b'class="pacex"', html)

    def test_tile_degrades_malformed_track_and_ticket(self):
        # source-level guards: non-array track -> no track (never a map/find
        # throw); absent ticket number -> omitted, never "#undefined".
        html = self._page()
        self.assertIn(b"Array.isArray(ft.track)", html)
        self.assertIn(b"ft.number!=null", html)
```

- [ ] **Step 2: Run to verify they fail**

Run: `python3 -m pytest tests/test_dashboard_server.py -k CompareTiles -q` (or `python3 -m unittest tests.test_dashboard_server -k CompareTiles` if pytest absent — repo standard is unittest via run_all.sh)
Expected: 4 failures — `PINNED` etc. not found.

### Task 2: Implementation in lib/dashboard_page.html

**Files:**
- Modify: `lib/dashboard_page.html` — CSS block (near the `.ptrack` rules) + JS (near `selectLane`/`renderFocus`/`renderRepos`)

**Interfaces:**
- Consumes: `laneKey/_LSEP`, `selectLane`, `setHTML`, `dispStatus`, `dispName`, `token`, `esc`, `short`, `dur`, `ago`, `agom`, `compact`, `nowS`, focus-card data fields (`r.git.focus_ticket{.track}`, `r.current_session`, `r.heartbeat`, `r.sessions`, `r.lanes`).

- [ ] **Step 1: CSS** (append near the `.ptrack` styles)

```css
/* #190 UI-7 compare tiles */
.pinbtn{background:none;border:0;color:var(--dim);cursor:pointer;font-size:11px;padding:0 3px;line-height:1}
.pinbtn.on{color:var(--accent)}
.tilegrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px}
.tile{border:1px solid var(--hair);border-radius:var(--r);padding:9px 11px;cursor:pointer;min-width:0}
.tile:hover{border-color:var(--accent)}
.tile .th{display:flex;gap:7px;align-items:baseline;min-width:0}
.tile .th .nm{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tile .tmeta{display:flex;gap:10px;flex-wrap:wrap;color:var(--dim);font-size:11px;margin-top:4px}
.tile .tnow{color:var(--mut);font-size:11px;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tile .tgate{font-size:11px;color:var(--warn);margin-top:3px}
.tile .tpace{color:var(--warn)}
```

(Token names verified against the sheet: `--hair` (borders), `--dim`, `--mut`, `--warn`, `--accent`, `--r`. There is no `--line` token — CP1 finding.)

- [ ] **Step 2: JS — pin state + helpers** (place next to `selectLane`)

```js
// #190 UI-7: the compare set -- client-only, ephemeral (view state, resets on
// reload; "state-not-streams" -- nothing persisted server-side). Same laneKey
// contract as SELECTED. >=2 valid pins flips the center to the tile grid.
const PINNED=new Set();
// prune pins whose repo/lane vanished (same self-heal contract as selectedLane)
function validPins(repos){
  repos=repos||[];
  const ok=k=>{const i=k.indexOf(_LSEP); if(i<0) return false;
    const r=repos.find(x=>x.path===k.slice(0,i)); if(!r) return false;
    const names=(r.lanes&&Array.isArray(r.lanes.names))?r.lanes.names:["main"];
    return names.indexOf(k.slice(i+1))>=0;};
  [...PINNED].forEach(k=>{if(!ok(k))PINNED.delete(k);});
  return [...PINNED];
}
function togglePin(encKey,btn){
  const k=decodeURIComponent(encKey);
  if(PINNED.has(k))PINNED.delete(k);else PINNED.add(k);
  if(btn)btn.blur();               // click-and-done: never a held node
  if(LAST){renderRepos(LAST.repos);renderFocus(LAST.repos);}
}
function drillTo(ev,encKey){
  // guard interactive descendants now (CP1): a future button/link inside a
  // tile must not drill through
  if(ev&&ev.target&&ev.target.closest&&ev.target.closest("button,a,select,input"))return;
  PINNED.clear();selectLane(decodeURIComponent(encKey));
}
```

- [ ] **Step 3: JS — pace flag + tile builder** (place above `renderFocus`)

```js
// pace vs role median -- EARNED only: needs a live elapsed AND >=3 completed
// same-role session durations to call a median honest; anything less renders
// nothing (never imply certainty the data lacks).
function paceFlag(r,role,startedEpoch){
  if(!startedEpoch)return "";
  const ds=((r&&r.sessions)||[]).filter(s=>s.role===role&&s.duration>0&&s.outcome&&s.outcome!=="running").map(s=>s.duration).sort((a,b)=>a-b);
  if(ds.length<3)return "";                       // >=3 samples or silence
  const med=ds.length%2?ds[(ds.length-1)/2]:(ds[ds.length/2-1]+ds[ds.length/2])/2;
  if(!med)return "";
  const x=(nowS()-startedEpoch)/med;
  if(x<1.25)return "";                            // on pace -> no flag
  // the LIVE ratio lives in a .pacex span (added to _volRe's normalization,
  // CP1 finding: a drifting ratio outside the volatile classes would defeat
  // the #248 skip-guard and rebuild the grid every tick). The title carries
  // only STATIC facts (median, sample count) for the same reason.
  return `<span class="tpace" title="this session is running past this role's median duration (${dur(Math.round(med))}, ${ds.length} sessions)">pace <b class="pacex">×${x.toFixed(1)}</b></span>`;
}
function tileCard(r,lane,key){
  // Repo-scoped session truth under a lane-named header -- the same
  // presentation contract as the single-lane focus card for a selected
  // sibling lane (#258/#310). Lane status from service truth when the lane
  // has its own service; else the repo's display status.
  const laneNames=(r.lanes&&Array.isArray(r.lanes.names))?r.lanes.names:[];
  const svc=r.lanes&&r.lanes.services&&r.lanes.services[lane];
  // Lane status ladder (CP1): a sibling lane uses ITS service status when that
  // truth exists AND is a non-empty string (a malformed svc.status must not
  // leak `s-undefined` markup); otherwise the repo's display status -- the
  // SAME fallback the shipped single-lane focus card presents for a selected
  // sibling lane (#258/#310 precedent), not a new truth claim.
  const sibSt=(laneNames.length>1&&svc&&svc.installed&&!svc.own&&typeof svc.status==="string"&&svc.status)?svc.status:null;
  const st=sibSt||dispStatus(r);
  const cs=r.current_session||{}, ft=(r.git||{}).focus_ticket;
  const busy=st==="working"||st==="stopping"||st==="wedged";
  const nm=laneNames.length>1?`${dispName(r.name)} / ${lane}`:dispName(r.name);
  // absent datum omitted, never "#undefined" (CP1)
  const tno=(ft&&ft.number!=null)?`<span class="no">#${esc(String(ft.number))}</span>`:"";
  // phase track: reuse the shipped .ptrack/.pseg markup verbatim; a malformed
  // (non-array) track degrades to no track, never a render throw (CP1)
  const trk=(ft&&Array.isArray(ft.track))?ft.track:[];
  const track=trk.length?`<div class="ptrack">${trk.map(s=>{
      const lbl=s.step==="review"?(s.actor==="bot"?"🤖 review":"👤 review"):s.step;
      return `<span class="pseg ${esc(s.state)}">${esc(lbl)}</span>`;
    }).join(`<span class="psep">→</span>`)}</div>`:"";
  // which gate blocks = the track's single live frontier (state:"current")
  const cur=trk.find(s=>s.state==="current");
  const gate=cur?`<div class="tgate">awaiting ${esc(cur.step==="review"?(cur.actor==="bot"?"bot review":"human review"):cur.step)}</div>`:"";
  // now-line (one line, never a feed): busy step / paused / heartbeat reason
  let now="";
  if(busy&&cs.current_step)now=`→ ${esc(short(cs.current_step,52))}`;
  else if(st==="paused")now="paused";
  else if(st==="stopped")now="supervisor stopped";
  else if(r.heartbeat&&r.heartbeat.reason)now=esc(r.heartbeat.reason);
  else now="idle";
  const elapsed=busy&&cs.started_epoch?`<span>elapsed <b class="upe mono" data-e="${cs.started_epoch}">${dur(nowS()-cs.started_epoch)}</b></span>`:"";
  const toks=cs.output_tokens!=null?`<span><b class="mono">${compact(cs.output_tokens)}</b> tok</span>`:"";
  const cost=cs.cost_usd?`<span><b class="mono">$${cs.cost_usd.toFixed(2)}</b></span>`:"";
  const pace=paceFlag(r,cs.role||"coder",busy?cs.started_epoch:null);
  const lastAct=cs.updated_at?`<span>active <b class="agox mono" data-t="${cs.updated_at}">${ago(nowS()-cs.updated_at)} ago</b></span>`:"";
  return `<div class="tile" onclick="drillTo(event,'${encAttr(key)}')" title="click to focus this lane">
    <div class="th">${token(st,true)}<span class="nm">${esc(nm)}</span><span class="trole">${esc(cs.role||"coder")}</span>${tno}</div>
    ${track}${gate}<div class="tnow">${now}</div>
    <div class="tmeta">${elapsed}${toks}${cost}${pace}${lastAct}</div></div>`;
}
```

Also extend the shared volatile-span normalization (CP1 — the pace ratio drifts every second):

```js
const _volRe=/(<(span|b)\b[^>]*\b(?:qreset|agox|upe|pacex)\b[^>]*>)[^<]*(<\/\2>)/g;
```

(`pacex` carries NO `data-e`/`data-t`, so the 1s ticker — which selects `.upe`/`.agox`/`.qreset` only — never touches it; it refreshes on genuine state-change rebuilds.) And add a `.trole` style to the tile CSS (`.tile .trole{color:var(--dim);font-size:11px}`) — the focus card's `rolebadge` styling is scoped to its header context, so tiles carry their own class.

- [ ] **Step 4: JS — renderFocus branch** (insert right after the `!repos.length` empty-state return)

```js
  // #190 UI-7: >=2 valid pins -> the center is the compare-tile grid (never
  // multiple live feeds -- one now-line per tile). <2 falls through to the
  // single selected-lane card unchanged. Routed through setHTML so the #248
  // guard owns this write path too; tiles' volatile cells reuse upe/agox
  // (already in _sigKey's normalization), so a pure time tick never rebuilds.
  const pins=validPins(repos);
  if(pins.length>=2){
    $("c-now").textContent=`compare · ${pins.length} lanes`;
    const tiles=pins.map(k=>{const i=k.indexOf(_LSEP);
      const r=repos.find(x=>x.path===k.slice(0,i));
      return tileCard(r,k.slice(i+1),k);}).join("");
    setHTML("focus",`<div class="tilegrid">${tiles}</div>`);
    return;
  }
```

- [ ] **Step 5: JS — pin buttons in renderRepos**

In `renderRepos`, add a pin toggle inside both lane select targets, marked `data-pin-key` (the delegated select listener ignores buttons, so no select-vs-pin collision):

Multi-lane `lgrp-h` (after `${def}`, before `${lcl}`):
```js
const pinb=`<button class="pinbtn${PINNED.has(lk)?" on":""}" data-pin-key="${encodeURIComponent(lk)}" title="${PINNED.has(lk)?"unpin from compare":"pin to compare — 2+ pinned lanes tile the center"}" onclick="togglePin('${encAttr(lk)}',this)">📌</button>`;
```
inserted as `…${esc(ln)}${def}${pinb}${lcl}…`.

Single-lane `repo-h` variant (the non-multiLane branch): same `pinb` built from `skey`, inserted after the `<span class="nm">…</span>` (build it just above `repoHOpen`, empty string for the multiLane branch since that branch pins per-lgrp-h).

- [ ] **Step 6: Run the tests**

Run: `python3 -m unittest tests.test_dashboard_server 2>&1 | tail -3`
Expected: OK (all, including the 4 new).

- [ ] **Step 7: Full local gates**

Run: `bash tests/run_all.sh` and `shellcheck -S warning start bin/*.sh bin/agents/*.sh tests/*.sh templates/autonomy-pack/qa/*.sh`
Expected: ALL SUITES PASS; shellcheck silent.

- [ ] **Step 8: Commit**

```bash
git add lib/dashboard_page.html tests/test_dashboard_server.py
git commit -m "feat: UI-7 compare tiles — pin 2+ lanes into a center tile grid (#190)"
```

### Task 3: Browser verify (dashboard skill loop)

- [ ] **Step 1:** `python3 bin/dashboard.py --repo tests/fixtures/repo-alpha --port 8790` (kill any port-squatter first: `lsof -tnP -iTCP:8790 | xargs kill` — memory lesson: stale servers serve old code silently; confirm `/api/state` repo name matches the fixture).
- [ ] **Step 2:** chrome-devtools: `new_page` → `/`, `take_snapshot`, `list_console_messages` (ZERO errors), `list_network_requests` (`/api/state` + `/api/stream` 200).
- [ ] **Step 3:** Single-repo fixture can't pin 2 lanes natively — inject a synthetic 2-repo/multi-lane state via `evaluate_script` calling `render(<synthetic state JSON>)` (precedent: PR #281 injected synthetic track states), then `evaluate_script` `togglePin(...)` twice; assert: grid renders 2 tiles, `.ptrack` present per tile, pin buttons show `.on`, `c-now` reads `compare · 2 lanes`; click a tile (`drillTo`) → single card returns, pins cleared.
- [ ] **Step 4:** Degraded states (CP1 — exercise the fail-safe hazards, not just the happy grid): tile for a repo with no focus_ticket (no track, no gate line, "idle" now-line); pace flag absent with <3 sessions; a multi-lane sibling lane with `lanes.services` ABSENT (repo-status fallback, no `s-undefined` markup anywhere in the grid); a synthetic malformed `track: "junk"` (tile renders without a track, no console error); pin a lane then remove its repo from the injected state (validPins prunes; grid falls back to single card at <2).
- [ ] **Step 4b:** Temporal pass: two consecutive `render(sameState)` calls with 2s between → assert `#focus` innerHTML did NOT rebuild (signature guard holds with a live pace ratio present — evaluate_script comparing element identity or a mutation counter).
- [ ] **Step 5:** Kill the server.

### Task 4: PR + gate

- [ ] Codex checkpoint 2 (`codex exec … </dev/null`, foreground, ~4 min watchdog), pre-flight-review, push (FOREGROUND), `gh pr create` per pr-authoring (security-model section: display-only, no new endpoints; PINNED is client state; onclick attrs built with encAttr/esc). Poll bot + CI, resolve comments, `safe_merge.sh`, board Done, close #190.

## Self-Review Notes

- Spec coverage: header ✓ (th: status/name/role/#ticket) · phase track ✓ · now-line/wait reason ✓ · elapsed·tok·$ ✓ · pace flag vs role median ✓ (earned) · last-activity age ✓ · blocking gate ✓ · drill ✓ · state-not-streams ✓ (no feed in tiles) · pin gesture ✓ (spec line 49/71).
- `encAttr` exists (used by `ibtn`); verify its exact semantics before reuse.
- `rolebadge` class reused in tiles for the role chip — verify its CSS is context-free (it's styled under `.dh1` scope? check; if scoped, use a `.trole` class with tile CSS instead).
