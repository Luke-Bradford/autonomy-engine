# Plan — #191 slice: config page adopts the UI-1 token system (same tokens)

## Problem

`lib/config_page.html` is on a **divergent skin** from the UI-1 control room
(`lib/dashboard_page.html`, reskinned by #184 + the whole UI wave):

- loads **Google webfonts** (`fonts.googleapis.com` — Schibsted Grotesk / IBM Plex
  Mono), which the redesign spec explicitly rejects ("no webfont gamble — Avenir
  Next / SF Mono are macOS-present");
- uses a different dark/light **palette** (`--bg:#0a0a0c` vs canonical `#15181d`,
  `--accent:#6ea3ff` vs `#4c9ee3`, etc.) and radius (`--r:8px` vs `6px`);
- paints a **grid-texture background** (`--grid:rgba(255,255,255,.018)`) and carries
  decorative glows — the spec's core principle is "a healthy org looks boring: no
  grid texture, no decorative color".

#191's title is literally "config page reskin — **same tokens**". The pickers it
mentions (#82 models, #170/#171 board) are already shipped (#146/#199/#200/#212).
So the remaining core of this slice is **token-system + font-strategy parity**.

## Canonical source

`lib/dashboard_page.html`'s three token blocks (`:root`, `[data-theme="dark"]`,
`[data-theme="light"]`) + its font strategy. **The shipped page is the source of
truth, not the spec's illustrative token names** (spec says `--acc`/`--line`/`--crit`;
the implementation uses `--accent`/`--hair`/`--bad`).

Verified: config_page and dashboard_page share the **identical token vocabulary**
(same `var(--x)` names). Every token config references is defined in dashboard's set
(checked: zero dangling references). So re-pointing the token *values* reskins every
component rule with the render markup unchanged — exactly the pattern the
dashboard_page header comment documents ("component CSS keeps its variable NAMES;
only the values are re-pointed").

## Scope (this slice)

IN:
1. Remove the Google Fonts `<link>` + `<link rel=preconnect>` lines from
   `config_page.html`'s `<head>` (kills the external network dependency).
2. Replace config's three token blocks (`:root`, `[data-theme="dark"]`,
   `[data-theme="light"]`) with `dashboard_page.html`'s exact values + font stacks
   (Avenir Next / SF Mono, `--r:6px`, `--grid:transparent`). This also removes the
   grid texture (grid becomes transparent) and re-points glows to the canonical set.

OUT (documented follow-up on #191, design-laden, not this slice):
- Full "UI-1 layout language" restructuring of config panels / "same popover &
  confirm behaviours as UI-2" parity — needs design judgment + a config-page mockup
  that does not exist. Token parity is the foundational, spec-literal first slice.

## Invariants / non-negotiables

- No bash/python behavior change — HTML/CSS only. `bin/`/`lib/` stay repo-agnostic
  (this is a template page, no target-repo values).
- Render markup unchanged → no dropped mount points, no JS breakage. The config
  page's save flows / confirm dialogs / overlay writes (#210/#218) are untouched.
- No guardrail files touched (`.autonomy/**`, `safe_merge.sh`, `.github/workflows/**`).

## TDD

Failing test first in `tests/test_dashboard_server.py` (new
`TestConfigPageUi1Parity` class, mirroring `TestControlRoomShell`):

1. `test_config_page_no_webfont_dependency` — served config page contains no
   `fonts.googleapis.com` / `fonts.gstatic.com` reference.
2. `test_config_page_uses_ui1_tokens` — served config page contains the canonical
   dark-theme tokens (`--bg:#15181d`, `--accent:#4c9ee3`) and the Avenir Next sans
   stack; and `--grid:transparent` (no grid texture).
3. `test_config_page_token_blocks_match_dashboard` — the three token blocks
   (`:root`/dark/light), extracted from both pages, are identical value-for-value
   (parity guard against future drift). Compare the token declaration lines, not
   surrounding comments.

Run them → see 1-3 fail against current `config_page.html` → implement → see pass.

## Codex CP1 findings — folded in

- **[High] `system` theme breaks config render.** `dashboard_page.html` supports a
  `dark`/`light`/`system` theme cycle and stores the raw choice in the shared
  `ae-theme` localStorage key, resolving `system`→`dark|light` via matchMedia when it
  sets `data-theme`. `config_page.html` applies the stored value raw, so a
  dashboard-set `"system"` yields `data-theme="system"` — matching neither token
  block, every token vanishes. **Fix (in scope):** port dashboard's resolver into
  config's `setTheme`/init — coerce unknown→`dark`, resolve `system` via matchMedia
  (with the live `change` listener), keep config's existing dark/light toggle. This
  is the correctness the parity claim requires; the full dark/light/system cycle
  *widget* stays a follow-up.
- **[Med] cascade / duplicate blocks.** Parity test asserts each selector
  (`:root`, `[data-theme="dark"]`, `[data-theme="light"]`) appears exactly once in
  config, so a later duplicate can't win the cascade past the compared block.
- **[Low] webfont scan.** Test scans served bytes for `fonts.googleapis`,
  `fonts.gstatic`, and `@import` — not just the removed `<link>` lines.
- **[Low] layout regression** (fonts/radius/shadow shift) is caught only by the
  browser verify loop, not the static tests — verify covers it explicitly.

## Verify

- `bash tests/run_all.sh` + shellcheck gate clean.
- Browser verify loop (dashboard SKILL): launch on port 8790 against
  `tests/fixtures/repo-alpha`, load `/config`, assert it renders with the UI-1 skin
  (charcoal `#15181d` ground, no grid, no webfont network request), zero console
  `error`, `/config` 200; confirm a save-confirm dialog still opens. Load `/` too to
  confirm both pages now share one skin. Kill server.
