# Control-room redesign — design spec

> Status: **operator-approved** (2026-07-03, interactive session). Approved via seven mockup
> iterations reviewed live by the operator, plus a Codex design review (12 findings, 10 accepted —
> §Requirements). The approved clickable mockup lives at the
> operator's artifact URL (claude.ai/code/artifact/5eadeeb6-4d4c-48ac-8b6e-2293e9f8827c) and will be
> committed to `docs/superpowers/specs/assets/` once #192 (doc-only gate divergence) lands — a
> non-md asset under docs/ currently deadlocks the merge gates. Static sample data, nothing wired.

## Operator requirements (verbatim intent, synthesised)

Kill: the grid background, per-card accent side stripes, the shared multi-repo activity panel
("jumbled, scrolls off the page"), the max-width cage, text buttons everywhere, suggested-but-
unconfigured roles rendered on every repo, the instantaneous `0 tok/min` throughput readout.

Want: business-like and professional; full width, ONE viewport (zones scroll internally, the page
never scrolls); repo → worktree(lane) → activity drill-in ("clicking the worktree brings up the
activity"); history behind an icon; roles wider/shallower with real detail and **interactable**
(trigger now, change schedule "in a popup or something"); tokens **over time** with scale; icons
over labels; surface everything useful the hooks emit — "progress, what's being worked on, how
much effort is being spent on a task, any problems"; needs-you as PM-triaged **questions a human
can answer in one glance**; don't lose the original layout's detail (supervisor voice stays);
multipane comparison without becoming a mess.

## Design tokens

| token | value | use |
| --- | --- | --- |
| `--bg` | `#15181d` | page ground (blue-biased charcoal — chosen, not defaulted) |
| `--panel` / `--panel2` | `#1c2027` / `#20252d` | cards / hover+raised |
| `--line` / `--line2` | `#2a2f38` / `#333a45` | hairlines / interactive borders |
| `--ink` / `--mut` / `--dim` | `#e8eaed` / `#98a0ab` / `#6b7380` | text hierarchy |
| `--acc` | `#4c9ee3` | THE accent (steel blue) — selection, links, live markers |
| `--ok` / `--warn` / `--crit` | `#3fb27f` / `#d9a13b` / `#d95757` | semantic only — never decorative |

Type: UI = `"Avenir Next","Helvetica Neue",sans-serif` (macOS-present; no webfont gamble); every
numeral column = `"SF Mono",Menlo` with `font-variant-numeric: tabular-nums`. Radius 6px. State
lives in dots and chips — **no accent stripes, no grid texture, no decorative color**. Light theme:
same structure, palette to be derived in the skin increment (toggle: dark/light/system).

**Core monitoring principle: a healthy org looks boring.** Color appears only when something is
abnormal (error, backoff, empty scope, quota pressure, needs-you) — and then it is the only
colored thing on screen.

## Information architecture — three altitudes, three zones, one viewport

| zone | altitude | contents |
| --- | --- | --- |
| left rail (400px; 330px ≤1200px) | **fleet** | repo cards → lane rows (status dot, ticket, ago, icon cluster: pin/pause/start/history) → role rows (trigger + model + next/last, click → role popover) → ghost `＋ role` |
| center (flex) | **work** | selected lane's session: ticket header, phase track, dense feed (subagent groups, collapsible phases) — OR compare tiles when 2+ lanes pinned |
| right rail (324px; ≥1760px two 324px sub-columns — telemetry \| org — each scrolling independently) | **telemetry + org** | tokens-over-time chart, per-account quota + forecast, needs-you questions, org activity feed, engine voice |

> **Geometry amendment (2026-07-04, operator direction, #256):** the mockup's 330px/324px rails
> were sized against static sample data; live data clips (role status tokens truncate, six right
> panels always overflow the fold). Fleet rail widens to 400px, and on wide viewports the right
> zone doubles into two independently-scrolling sub-columns so every panel is visible at once.
> One-viewport rule unchanged: zones scroll internally, the page never scrolls.

Top bar: brand · update-ready chip (#166) · counts · clock · icons: theme / upcoming-runs /
concierge chat / config. The concierge dock (shipped `/api/chat`) opens bottom-right.

Three narration layers, never mixed: the **lane feed** narrates the work; **org activity**
narrates the agents (handoffs: "qa ← woken by pr.opened #176"); **engine voice** narrates the
supervisor (pacing, backoff, recovery — verbatim log lines). All three visible at once.

## Object inventory (data sources verified against the running system)

| object | data source | interactions |
| --- | --- | --- |
| repo card header | registry + gh (`github ✓ · board ✓`) | collapse |
| lane row | lifecycle + latest session + pick_ticket | click=select · pin=compare · pause/start · clock=history popover |
| role row | roles.py build_roles + cron next_fire + last session per role (#148) | click → popover: full config, **run now** (single-role dispatch — engine supports it), enable/disable, edit schedule/model (W3 write path), rail ↗, focus session ⤢ |
| ticket header | issue title + board status + PR/CI/review state + gate + `this ticket: N sessions · tok · $` (sessions attributed to #N summed) | chips deep-link to GitHub |
| phase track | §Phase-track contract | hover = milestone timestamps |
| feed | session JSONL nodes (`is_subagent`, parent, tokens) | subagent groups with subtotals; collapsible finished phases; paths shown repo-relative (never absolute) |
| history popover | recent sessions (#148): role, started, duration, tokens, outcome | row → focus that session |
| tokens chart | persisted per-15min output samples (NEW: persist the sampler ring to `/var/`, backfill from session logs) + merge markers ▲ | time-window toggle 1h/6h/24h |
| quota card | live oauth endpoint (#160) + codex + local (`no quota · free`); API accounts show $ | forecast line — §Requirements 3 |
| needs-you | PM-escalated questions | §PM question contract |
| org activity | supervisor dispatch/wake/cron events (#177 heartbeat) + board.sh transitions | view all ↗ |
| engine voice | supervisor.log tail, keyword-highlighted | view all ↗ |
| compare tiles | pinned lanes: phase track + now-line + `elapsed · tok · $ · pace` | tile click → drill to single view |
| popover behaviour | — | re-click anchor closes · click-away closes · Esc closes all · never close-on-mouse-out (they contain buttons); pure-info tooltips do hover-dismiss |

Suggested-but-unconfigured roles NEVER render as rows — one ghost `＋ role` chip replaces them
(the operator's explicit call; the full roster appears only where actually configured).

## Phase-track contract (settled with the operator — NOT a template)

The track = **(events observed) + (gates configured)**, per ticket, per lane:

1. **Observed layer (past, solid segments):** milestones that actually happened, from universal
   GitHub-flow facts — board write, branch created, tests ran (red/green), PR opened, review
   verdict, merged. A ticket that skips a phase simply never shows that segment. Never asserted,
   only observed.
2. **Configured layer (future, outline segments):** the remaining gate chain from the repo's OWN
   config — `merge_gate.strategy` × role `gate` knobs (the #156 gating matrix). QA-auto-merge
   renders `… pr → qa → merge`; wait-for-human renders `… pr → qa → 👤 → merge`; manual renders
   `… pr → 👤`. Custom roles appear under their own names — the workflow is data, the track draws it.
3. **Unknown (dotted):** prompt-level phases (plan/tdd) render only when detectable (our rails'
   working-order markers). Fully custom packs degrade to the universal layer — coarser but never
   wrong. **Degrade to truth, never guess.**

QA sessions get their own vocabulary (`wake · diff · bugs · regr · ux · docs · done`), similarly
observed-from-rail-structure.

## PM question contract (needs-you)

Everything a role escalates to a human must arrive as a **question answerable in one glance**,
carrying: the question · issue/PR link · the escalating role's one-line recommendation with its
reasoning quoted · effort already sunk · **default-if-ignored** ("if you do nothing: PR waits") ·
answer chips (max 3 + discuss ↗). Confirmed answers post back as issue comments (auditable). This
contract binds the PM rail (#89/W5d) and any future escalating role.

## Requirements adopted from the Codex review (2026-07-03)

1. **Queue health**: per-lane eligible-issue count, oldest-waiting age, and the coder's one-line
   "why I picked this ticket" (triage rationale logged by the rail).
2. **Exact gate state**: never `PR – · CI –` — failing check names, review verdict, the specific
   merge-blocking reason.
3. **Quota forecast**: burn rate → projected exhaustion time, and a "current session can finish
   safely" indicator (throughput × remaining%).
4. **Feed summarization**: collapsible phase groups + a change-surface summary (files touched,
   tests passing/failing) pinned above the feed.
5. **Efficiency**: cost per merged ticket now; tokens-per-phase later.
6. **Incidents first-class**: supervisor recovery/backoff/stash events render as incident chips in
   org activity with recurrence counts.
7. **Observed vs configured vs unknown** phase segments visually distinct (solid/outline/dotted) —
   the track must never imply certainty it doesn't have.
8. Compare tiles carry last-activity age + which gate currently blocks.
9. Needs-you impact metadata (default-if-ignored, source quote) — folded into the PM contract.
10. **Trigger health**: upcoming-runs panel shows missed fires and misconfigured arms (the
    2026-07-03 swept-state incident as a permanent UI lesson; heartbeat #177 is the source).
11. Destructive controls (hard-stop, disable, merge-affecting answers) get confirm + disabled
    states + an audit line in org activity.
12. *(Deferred)* named view modes (incident/forensic/quota) — the foundation supports them; not in
    scope until the base ships.

## Non-goals / deferred

Mobile layout (desktop-first; zones must not break below ~1200px, that's all) · light theme ships
in the skin increment but after dark is verified · view modes (12 above) · fake motion of any kind
(every animated element must be backed by a real state transition or countdown).

## Increments (staged tickets; each browser-verified against the mockup per the dashboard skill)

- **UI-1 skin + shell** — tokens, full-bleed three-zone grid, top bar, icon buttons, kill
  grid/stripes/max-width. The page renders real data in the new shell with today's panels.
- **UI-2 fleet rail** — repo→lane tree (lanes from #147), role rows + popovers, run-now control
  action, ghost ＋role, history popover (#148 data).
- **UI-3 lane detail** — ticket header (gate chips, effort-per-ticket), dense feed (subagent
  groups, repo-relative paths, collapsible groups, change-surface summary).
- **UI-4 phase track** — milestone detection + configured-gate chain + solid/outline/dotted.
- **UI-5 telemetry** — persisted token samples + chart + window toggle, quota forecast +
  can-finish indicator, trigger-health in upcoming-runs.
- **UI-6 needs-you** — the question card per the PM contract (pairs with #89/W5d rail work).
- **UI-7 compare tiles** — pins, tile grid, pace flags.
- **UI-8 config page reskin** — same tokens, pickers land here (#82 models, #170 board, #171
  derived defaults).
