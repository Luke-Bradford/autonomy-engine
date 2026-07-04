# Plan — #269 UI-3c: selected-lane detail-header presentation

## Goal
Restructure the center focus card (`renderFocus` → `.fcard`) from the legacy
fcard presentation into the approved mockup's `.det header` (mockup:
`git show 2f21d4d:docs/superpowers/specs/assets/2026-07-03-control-room-mockup.html`,
center `.det header`). Client-only render change; no dashboard_state / endpoint
change. All data already in `/api/state`.

## Scope (one cohesive slice — a broken intermediate can't ship)
Rebuild the header markup inside the existing `.fcard` (keep `data-path` + the
`${st}` status class — the selection/guard keys depend on them):

1. **dh1 identity row**: status dot (`token(st,true)` stays as the token) · `.path`
   = `<b>repo</b>` + ` / <lane> lane` only when multi-lane (single-lane names the
   repo alone — a fabricated "main lane" on a 1-lane repo is a #234 display lie) ·
   `.rolebadge` = `role · model · effort` (drop the ` · effort` tail when
   config.effort is "") · worktree badge when `isWorktree` · right cluster =
   `lifecycleCluster(r,st)` (reuse #264) + the existing history clock button.
2. **ticketline row**: the existing focus-ticket chip ladder (verbatim truth
   ladder) as its own row, title budget widened to ~64 chars, + a gate chip
   (`config.merge_gate`).
3. **dh2 stat strip** (mono, tabular-nums): elapsed|last-active · out tok · cost ·
   this-ticket effort (#186 `ticket_effort`) · branch (`git.branch`) · pid
   (`lifecycle.pid`, shown ONLY when alive — running/paused; a stopped
   supervisor's pid is stale). Each stat omitted when its datum is absent.
4. **now-line**: the existing `stepLine` truth ladder verbatim, below dh2.
5. **override control**: KEEP `modelCtl(r,st)` visible below the now-line
   (deliberate deviation from the mockup's pencil-icon-only affordance — keeps the
   working #202 dirty/save override rather than re-plumbing it behind an icon;
   noted in PR).
6. Phase-track slot: OMITTED (deferred to #187; no empty placeholder — non-goal:
   no fake motion).

## CSS
Add `.dh1 / .dh1 .path / .rolebadge / .ticketline / .ticketline .ttl / .dh2`
adapted to our token vars (`--mut/--ink/--panel2/--hair2/--accent`). Reuse
`.fc-step` for the now-line and existing chip classes for the ticketline. Retire
`.fc-top/.fc-name/.fc-model` only if fully unreferenced after the rewrite.

## Guard contract (prevention-log #14/#16, #269 acceptance)
- Render through `setHTML` (skip-unchanged signature guard) on every write path —
  unchanged.
- Change the interaction hold to **SELECT-only** (drop `BUTTON` from the held
  condition at the `activeElement` check): a click-done lifecycle/history button
  must NEVER suppress a rewrite — a stuck-focused button would freeze the
  single-node header (prevention-log #16). The `modelCtl` SELECT still holds so an
  open dropdown survives a tick.

## Tests
- Server-HTML regression guard (`test_dashboard_server.py`): the served page's
  `renderFocus` source carries the new header markup (`class="dh1"`,
  `class="dh2"`, `class="ticketline"`) — catches an accidental revert.
- Browser-verify (dashboard SKILL) is the real behavioural test: drive `/` on the
  fixture, assert dh1/ticketline/dh2 render, model SELECT hold survives a tick,
  history clock opens the popover, console clean, and a temporal pass (idle
  byte-stable, ≤1 rebuild/panel, CLS<0.01). Check states: working, idle
  (heartbeat), paused, stopped, and empty (no repos).

## Codex CP1 resolutions (2026-07-04)
1. **rolebadge #234**: role/model prefer the live-or-most-recent session
   (`cs.role`, `cs.model||config.model`); effort is config-sourced (no live
   counterpart) — a `title` states "role/model of the live (or most recent)
   session · configured effort" so it never implies live-session effort. Effort
   tail dropped when `config.effort` is "".
2. **SELECT-only hold on save-click**: accepted. `setModel` reads the SELECT value
   at click time and POSTs it, so the save is not lost; the next tick rebuilds the
   card and the queued override surfaces via `modelCtl`'s pend/override badge —
   resetting the dirty select to committed is correct (the override is queued, not
   yet the committed default).
3. **openLaneHist blur**: KEEP the existing trigger `.blur()` as
   belt-and-suspenders (prevention-log #16) even though SELECT-only hold already
   stops a focused button from freezing the panel.
4. **gate chip**: read the FLATTENED `config.merge_gate` string ONLY — never
   nested `merge_gate.strategy` (prior guard for that exact mistake).
5. **pid**: gate on `lifecycle.state && lifecycle.state !== "stopped"` (idle is
   backed by a running lifecycle), NOT dispStatus text; omit when absent/stopped.
6. **modelCtl visible**: explicit, accepted deviation from the mockup's
   pencil-only affordance — keeps the working #202 dirty/save override and the
   existing server-test contract; #269 is not pixel-faithful here.

## Codex CP2 refinements (2026-07-04)
- **Hold is SELECT or a `.mctl` button** (not pure SELECT-only): the model/effort
  save buttons are part of the same edit as the select, so the card must stay held
  through the change→click window (a tick between them would reset the dirty pick
  before the click reads it). The dh1 lifecycle/history buttons still never hold.
- **pid** gated on the known-live allowlist (`running`/`paused`), not `!= stopped`
  (matches `engine_status`; `stopped` keeps a stale lock pid, `needs-setup` none).
- **Stale comment fixed**: the "lifecycle lives ONLY on the fleet rail" note
  (pre-#269) updated — #269 re-introduces the icon cluster in the detail header per
  the mockup; no settled-decision bars center controls.

## Non-goals / invariants
- No dashboard_state change; no new endpoint; no new trusted input.
- Single-lane repos never fabricate a lane name (#234). Stale pid never shown as
  live. All strings `esc()`-d. Fail-safe: a missing datum omits its stat, never
  renders "undefined".
