# Plan — UI-5 #188: Tokens timeline area chart (render slice)

## Context
`token_timeline` (#188a, PR #221) is on `main` and exposed as
`build_repo_state()["token_timeline"]` — a zero-filled 24h/15min series of
`{"bucket": <epoch>, "tokens": <int>}` (oldest-first), backfilled from
session-log totals (no gh, no live sampler). It is currently **rendered
nowhere**. Its docstring states it *replaces the instantaneous 0-tok/min
readout* — i.e. the existing "Throughput" telemetry panel.

The approved control-room mockup (`git show
2f21d4d:docs/superpowers/specs/assets/2026-07-03-control-room-mockup.html`,
lines 311-325) shows the right-column top card as **"Tokens · last Nh"**: an
SVG area chart (gridlines + area fill + line + end dot) with a right-aligned
total ("312k out") and a start/end time legend.

## Scope (this slice)
Render `token_timeline` as that area chart in the telemetry zone, superseding
the instantaneous throughput sparkline. Pure client-side render change to
`lib/dashboard_page.html` — no backend change (data + tests already on main).

### In
- Retitle the "Throughput" section heading → "Tokens"; render an area chart
  (area path + line path + end dot + 3 gridlines) from the summed-across-repos
  `token_timeline`.
- **1h / 6h / 24h window toggle** (#188's stated toggle) — client-side slice of
  the 24h series; default 6h (matches mockup). Header total = summed output
  tokens over the selected window; legend = first/last bucket clock times.
- Keep the live "tok/min now" figure (from the existing throughput sampler) as
  a small secondary lead stat — liveness (ties #177), honest second source.
- Empty/degraded: no series or all-zero → flat baseline + "warming up /
  no tokens in window", never a JS error or blank panel.

### Out (deferred, note on #188)
- **Merge markers** ("ticket merges marked ▲") — needs merge-event timestamps
  not carried by `token_timeline`; fabricating them would invent a shape.
- Quota-forecast card render (#188b) + can-finish indicator + trigger-health
  panel — separate render slices.

## Steps
1. Rewrite `renderThroughput` → `renderTokens(repos)`: sum `token_timeline`
   across repos per aligned bucket; hold selected-window state; build the SVG
   area chart; wire the 1h/6h/24h toggle (pure client toggle, no POST).
2. Update the telemetry-zone heading markup ("Tokens" + honest sub-caption).
3. Add minimal CSS for the area chart + toggle chips, reusing existing tokens
   (`--accent`, `--hair2`, mono/dim) — no new color scheme.
4. Browser-verify (chrome-devtools): populated (via /tmp repo copy with a
   touched session-log mtime inside the 24h window), empty (repo with old
   logs → flat), toggle switches window + total. Zero console errors;
   `/api/state` + `/api/stream` 200.

## CP1 resolutions (Codex 2026-07-04)
- **Exact window semantics.** 15-min buckets ⇒ fixed bucket counts:
  1h = 4, 6h = 24, 24h = 96. The toggle takes the last-N buckets of the
  aggregate series (`agg.slice(-N)`), N = `window_secs / 900`. Total + legend
  are computed over exactly those N buckets — deterministic, no "≥ max−6h"
  ambiguity.
- **Key by numeric bucket, not index.** Cross-repo aggregation builds a
  `Map<bucketEpoch, sumTokens>` (repos may be sampled across a 15-min boundary,
  so tails need not align), then emits a bucket-sorted array before slicing.
- **Finite-guard BOTH fields.** Each point: `bucket` and `tokens` coerced with
  `Number(...)`; skip the point unless `Number.isFinite` for both; clamp
  `tokens = Math.max(0, tokens)`. Guards every consumer — path math, total,
  legend clock (`new Date(bucket*1000)`), and SVG coordinate attrs.
- **Preserve the sampler.** `ratesFrom` + the current-rate derivation stay; the
  "tok/min now" lead keeps reading `r.throughput`. Only the sparkline SVG is
  replaced by the timeline area chart — the sampler consumer is not deleted.
- **Render edge cases to verify** (browser + reasoned): missing/`null`
  `token_timeline`; malformed points (NaN/Infinity/negative); all-zero series
  (flat baseline, no crash); mixed zero + non-zero repos (aggregate sums);
  single-bucket series (degenerate path); window larger than available buckets
  (`slice(-96)` on a shorter array returns all — fine).

## Invariants / guards
- No network from the page beyond existing `/api/state` + `/api/stream`.
- Numeric coercion on every `token_timeline` value before it reaches the DOM /
  SVG path (attr-injection guard convention, cf. handoffs `data-t`).
- Render server truth only; no client-side data invention (the toggle only
  *slices* server data). Degrade to truth, never guess (no merge markers).
- Repo-agnostic; stdlib-only backend unchanged.
