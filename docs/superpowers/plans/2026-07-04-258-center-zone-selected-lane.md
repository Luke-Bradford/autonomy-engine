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
