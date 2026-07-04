# Plan — #238 (p1 regression): seconds-granularity countdowns defeat the roster skip-unchanged render

## Root cause (confirmed in code)

`renderRepos` (lib/dashboard_page.html) runs on every SSE push (server pushes every
2.0s, `bin/dashboard.py:1488`). Its #164 skip-unchanged guard compares the full
`html` string (line 693). But the roster embeds **volatile time text** in that markup:

- `trig` (L625-627): `cron · next <span class="qreset num" data-e=…>${nf}</span>`
  where `nf = dur(s)` = seconds granularity (`32m16s`).
- `lastRun` (L639): `last <b class="agox" data-t=…>${ago(…)}</b>` = `4m`.

So `html` differs every second → `html!==_reposHtml` always true → the whole roster
innerHTML rebuilds every push → boxes re-lay-out (flicker) and variable-width time
text reshapes rows. The #174/#164 skip is defeated "via a different door."

Two extra reshape sources found:
- The global 1s ticker (L965) rewrites every `.agox` to `ago(…)+" ago"`. The roster
  `lastRun` embeds `4m` (no " ago") but the ticker turns it into `4m ago` on the
  first tick → the " ago" the ticket calls out appearing and widening the row.
- `dur`→`ago` width varies (`32m16s`→`9m3s`, `4m`→`59s`), no reserved width.

## Fix — three parts, all in lib/dashboard_page.html (no server/python change)

**Part 1 — minute granularity for embedded + ticked roster times.** Add `durm(s)` /
`agom(s)` helpers (minute-granularity siblings of `dur`/`ago`). Give the roster's
countdown + last-run spans `data-g="m"` and embed the minute value. Branch the 1s
ticker (L965-966) on `data-g==="m"` → use `durm`/`agom` and, for the roster agox,
DON'T append " ago" (a static " ago" lives in the markup outside the `<b>`, so it
can't toggle). Non-roster `.qreset`/`.agox` have no `data-g` → unchanged (NOW card,
quota, voice, git keep their seconds countdowns).

**Part 2 — normalize volatile text out of the compare.** In `renderRepos`, compare a
normalized key that blanks the `.qreset`/`.agox` span *contents* before comparing.
Regex is **attribute-order-independent and tag-type-matched** (Codex CP1) — the
`qreset`/`agox` marker may sit anywhere in the open tag, and a backreference forces
the close tag to match the open tag's name:
`norm(h)=h.replace(/(<(span|b)\b[^>]*\b(?:qreset|agox)\b[^>]*>)[^<]*(<\/\2>)/g,"$1$3")`.
Rebuild innerHTML only when the normalized markup changes (real state change) — a
pure time tick never triggers it. `renderRepos`' `html` contains only roster
markup, so normalization is inherently roster-scoped; `role.status`, `lr.outcome`,
`missed_fire`, classes, and `data-e`/`data-t` all stay in the key, so a same-tick
real change still rebuilds. Contents stay text-only (no nested markup in these
spans) so `[^<]*` always matches. Ticker fallback is preserved EXACTLY (`.agox` →
`ago()+" ago"`, `.qreset` → seconds `dur`); only a `data-g==="m"` branch is added.

**Part 3 — reserve width.** `.role .trig .qreset` and `.role .rlast .agox` get
`display:inline-block; text-align:right; font-variant-numeric:tabular-nums` +
`min-width`, so a ticking/format-length change can't reshape the row; " ago" is
static (part 1) so no element toggles in/out of flow.

## Invariants / scope

- Display-only, one file. No server route, control path, or state-builder change.
  `lib/` stays repo-agnostic. No guardrail files.
- Non-roster countdowns unchanged (opt-in via `data-g`), so no regression to the NOW
  card / quota / voice live tickers.

## TDD (static guards, following TestControlRoomShell) + browser behavioral verify

Static, on the served page (`tests/test_dashboard_server.py`, new class):
1. roster countdown + last-run spans carry `data-g="m"` (minute-granularity opt-in);
2. the page defines `durm(`/`agom(` and the ticker branches on `dataset.g`;
3. `renderRepos` normalizes qreset/agox out of the compare (the `norm(` /
   normalized-key pattern is present, not a raw `html!==_reposHtml`);
4. width-reserve CSS (`tabular-nums` + `min-width`) on `.role .trig .qreset` /
   `.role .rlast .agox`.

Behavioral (the real acceptance, browser verify loop — ties to #239): launch on
8790 against a fixture repo with a cron role (next_fire set), observe for ~30-60s
with NO state change, assert **zero roster `#repos` innerHTML replacements** (wrap
count via a MutationObserver in `evaluate_script`) and no row width change. Confirm
the countdown still updates (minute granularity) via the ticker.
